import { emitDiagnostic, registerConnectionDiagnostics, registerPreparedJobConnectionDiagnostics } from './diagnostics.js';
import { GpStationJobPeer } from './job-peer.js';
import {
  createPreparedJobConnection,
  jobConnectionKey,
  rtcConfigWithDefaults,
  summarizeSdpCandidates,
  waitForIceGatheringComplete,
} from './rtc.js';
import type {
  CallResult,
  ConnectDiagnosticEvent,
  GpStationClientOptions,
  JobAnswerWaitResult,
  JobConnectionPrewarmOptions,
  JobCreateResult,
  JobEvent,
  JobSession,
  JobSessionCallOptions,
  JobSessionFinishOptions,
  LauncherView,
  PreparedJobConnection,
  RunJobOptions,
  RunJobSessionResult,
} from './types.js';

class RunJobAttemptError extends Error {
  constructor(
    message: string,
    readonly jobId: string | undefined,
    readonly inputSent: boolean,
  ) {
    super(message);
    this.name = 'RunJobAttemptError';
  }
}

export class GpStationJobSession implements JobSession {
  private callIndex = 0;

  constructor(
    readonly jobId: string,
    private readonly peer: GpStationJobPeer,
    private readonly defaultTimeoutMs: number,
    private readonly defaultOnEvent?: (event: JobEvent) => void,
  ) {}

  get closed(): boolean {
    return this.peer.closed;
  }

  async call<TInput = unknown, TResult = unknown>(
    handlerType: string,
    input?: TInput,
    options: JobSessionCallOptions = {},
  ): Promise<CallResult<TResult>> {
    this.callIndex += 1;
    const callId = this.callIndex === 1 ? this.jobId : `${this.jobId}:${this.callIndex}`;
    return await this.peer.call<TResult>(
      callId,
      handlerType,
      input === undefined ? null : input,
      options.timeoutMs ?? this.defaultTimeoutMs,
      (event) => {
        this.defaultOnEvent?.(event);
        if (options.onEvent !== this.defaultOnEvent) {
          options.onEvent?.(event);
        }
      },
      options.attachments ?? [],
    );
  }

  async finish(options: JobSessionFinishOptions = {}): Promise<void> {
    if (this.closed) {
      return;
    }
    await this.peer.finish(this.jobId, options.timeoutMs ?? this.defaultTimeoutMs);
  }

  close(): void {
    this.peer.close();
  }
}

export class GpStationClient {
  private readonly apiBaseUrl: string;
  private readonly token?: string;
  private readonly authMode: 'bearer' | 'cookie';
  private readonly jobApiPrefix: string;
  private readonly rtcConfig?: RTCConfiguration;
  private readonly prewarmedJobConnections: PreparedJobConnection[] = [];
  private csrfToken?: string;
  private csrfPromise?: Promise<string>;
  private authRefreshPromise?: Promise<void>;

  constructor(options: GpStationClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.authMode = options.authMode ?? 'bearer';
    this.jobApiPrefix = normalizeApiPrefix(options.jobApiPrefix ?? '/v1/jobs');
    this.rtcConfig = options.rtcConfig;
  }

  async listLaunchers(): Promise<LauncherView[]> {
    return this.request<LauncherView[]>('/v1/launchers');
  }

  prewarmJobConnection(options: JobConnectionPrewarmOptions = {}): void {
    const slaveAppId = options.slaveAppId ?? 'ai';
    const rtcConfig = rtcConfigWithDefaults(options.rtcConfig ?? this.rtcConfig);
    const key = jobConnectionKey(slaveAppId, rtcConfig);
    this.dropClosedPrewarmedJobConnections();
    if (this.prewarmedJobConnections.some((item) => item.key === key)) {
      return;
    }
    const prepared = createPreparedJobConnection(slaveAppId, rtcConfig);
    const diagnostic = options.onDiagnostic ?? (() => undefined);
    emitDiagnostic(prepared.peerConnection, prepared.dataChannel, diagnostic, {
      stage: 'job-prewarm',
      message: 'job prewarm refreshed',
      elapsedMs: 0,
      stageStartedAt: Date.now(),
    });
    this.prewarmedJobConnections.push(prepared);
  }

  clearPrewarmedJobConnections(): void {
    for (const item of this.prewarmedJobConnections.splice(0)) {
      item.peerConnection.close();
    }
  }

  async runJob<TInput = unknown, TResult = unknown>(
    handlerType: string,
    input?: TInput,
    options?: RunJobOptions & { autoFinish?: true },
  ): Promise<CallResult<TResult>>;
  async runJob<TInput = unknown, TResult = unknown>(
    handlerType: string,
    input: TInput | undefined,
    options: RunJobOptions & { autoFinish: false },
  ): Promise<RunJobSessionResult<TResult>>;
  async runJob<TInput = unknown, TResult = unknown>(
    handlerType: string,
    input?: TInput,
    options: RunJobOptions = {},
  ): Promise<CallResult<TResult> | RunJobSessionResult<TResult>> {
    const status = options.onStatus ?? (() => undefined);
    const diagnostic = options.onDiagnostic ?? (() => undefined);
    const timeoutMs = options.timeoutMs ?? 60000;
    const slaveAppId = options.slaveAppId ?? 'ai';
    const rtcConfig = rtcConfigWithDefaults(options.rtcConfig ?? this.rtcConfig);
    const autoFinish = options.autoFinish ?? true;
    try {
      return await this.runJobAttempt<TInput, TResult>({
        handlerType,
        input,
        options,
        status,
        diagnostic,
        timeoutMs,
        slaveAppId,
        rtcConfig,
        attempt: 0,
      });
    } catch (error) {
      const attemptError =
        error instanceof RunJobAttemptError
          ? error
          : new RunJobAttemptError(error instanceof Error ? error.message : String(error), undefined, false);
      if (attemptError.inputSent) {
        diagnostic({
          stage: 'job-retry',
          message: 'retry skipped after job call sent',
        });
        throw attemptError;
      }
      diagnostic({
        stage: 'job-retry',
        message: 'retry attempt=1',
        elapsedMs: 0,
      });
      await this.killJobBestEffort(attemptError.jobId);
      return await this.runJobAttempt<TInput, TResult>({
        handlerType,
        input,
        options,
        status,
        diagnostic,
        timeoutMs,
        slaveAppId,
        rtcConfig,
        attempt: 1,
      });
    } finally {
      if (autoFinish) {
        this.prewarmJobConnection({ slaveAppId, rtcConfig, onDiagnostic: diagnostic });
      }
    }
  }

  private async runJobAttempt<TInput = unknown, TResult = unknown>(params: {
    handlerType: string;
    input?: TInput;
    options: RunJobOptions;
    status: (status: string) => void;
    diagnostic: (event: ConnectDiagnosticEvent) => void;
    timeoutMs: number;
    slaveAppId: string;
    rtcConfig: RTCConfiguration;
    attempt: number;
  }): Promise<CallResult<TResult> | RunJobSessionResult<TResult>> {
    const { handlerType, input, options, status, diagnostic, timeoutMs, slaveAppId, rtcConfig, attempt } = params;
    const autoFinish = options.autoFinish ?? true;
    const prepared = this.takePrewarmedJobConnection(slaveAppId, rtcConfig);
    const prewarmHit = prepared !== undefined;
    const peerConnection = prepared?.peerConnection ?? new RTCPeerConnection(rtcConfig);
    const dataChannel = prepared?.dataChannel ?? peerConnection.createDataChannel('gpstation.v1', { ordered: true });
    const jobPeer = new GpStationJobPeer(peerConnection, dataChannel, diagnostic);
    let session: GpStationJobSession | undefined;
    let jobId: string | undefined;
    let inputSent = false;
    let finishStarted = false;
    const runStartedAt = Date.now();
    if (prepared) {
      registerPreparedJobConnectionDiagnostics(prepared, diagnostic);
    } else {
      registerConnectionDiagnostics(peerConnection, dataChannel, diagnostic);
    }

    try {
      emitDiagnostic(peerConnection, dataChannel, diagnostic, {
        stage: 'job-prewarm',
        message: prewarmHit ? 'job prewarm hit' : 'job prewarm miss',
        prewarmHit,
        elapsedMs: Date.now() - runStartedAt,
        stageStartedAt: runStartedAt,
      });
      if (attempt > 0) {
        emitDiagnostic(peerConnection, dataChannel, diagnostic, {
          stage: 'job-retry',
          message: `retry attempt=${attempt}`,
          prewarmHit,
          elapsedMs: Date.now() - runStartedAt,
          stageStartedAt: runStartedAt,
        });
      }
      status('creating offer');
      const offerGatherStartedAt = Date.now();
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      await waitForIceGatheringComplete(peerConnection, timeoutMs);
      const offerGatheringMs = Date.now() - offerGatherStartedAt;
      if (!peerConnection.localDescription) {
        throw new Error('localDescription was not created');
      }
      emitDiagnostic(peerConnection, dataChannel, diagnostic, {
        stage: 'local-offer',
        message: 'created local job offer',
        elapsedMs: Date.now() - runStartedAt,
        stageStartedAt: offerGatherStartedAt,
        prewarmHit,
        offerGatheringMs,
        localCandidateSummary: summarizeSdpCandidates(peerConnection.localDescription.sdp),
        localSdp: peerConnection.localDescription.sdp,
      });

      status('creating job');
      const created = await this.request<JobCreateResult>(this.jobApiPrefix, {
        method: 'POST',
        body: JSON.stringify({
          handler_type: handlerType,
          slave_app_id: slaveAppId,
          offer: {
            type: 'offer',
            sdp: peerConnection.localDescription.sdp,
          },
        }),
      });
      jobId = created.job.id;
      options.onJobCreated?.(created.job);

      status('waiting for answer');
      const answerWaitStartedAt = Date.now();
      const answer = await this.waitJobAnswer(created.job.id, timeoutMs);
      const answerWaitMs = Date.now() - answerWaitStartedAt;
      if (!answer.answer || answer.answer.type !== 'answer' || !answer.answer.sdp) {
        throw new Error(answer.last_error || `job ${created.job.id} did not produce an answer (state=${answer.state})`);
      }
      await peerConnection.setRemoteDescription({ type: 'answer', sdp: answer.answer.sdp });
      emitDiagnostic(peerConnection, dataChannel, diagnostic, {
        stage: 'remote-answer',
        message: 'received remote job answer',
        elapsedMs: Date.now() - runStartedAt,
        stageStartedAt: answerWaitStartedAt,
        prewarmHit,
        answerWaitMs,
        remoteCandidateSummary: summarizeSdpCandidates(answer.answer.sdp),
        remoteSdp: answer.answer.sdp,
      });

      status('waiting for data channel');
      const dataChannelOpenStartedAt = Date.now();
      await jobPeer.waitUntilOpen(timeoutMs);
      const dataChannelOpenMs = Date.now() - dataChannelOpenStartedAt;
      emitDiagnostic(peerConnection, dataChannel, diagnostic, {
        stage: 'data-channel-open',
        message: 'job data channel opened',
        elapsedMs: Date.now() - runStartedAt,
        stageStartedAt: dataChannelOpenStartedAt,
        prewarmHit,
        dataChannelOpenMs,
      });
      session = new GpStationJobSession(created.job.id, jobPeer, timeoutMs, options.onEvent);
      jobPeer.sendReady(created.job.id);

      status('waiting for result');
      const firstResultPromise = session.call<TInput, TResult>(handlerType, input, {
        timeoutMs,
        onEvent: options.onEvent,
        attachments: options.attachments,
      });
      inputSent = true;
      const firstResult = await firstResultPromise;
      if (!autoFinish) {
        return { ...firstResult, session };
      }

      status('finishing job');
      finishStarted = true;
      await session.finish({ timeoutMs });
      return firstResult;
    } catch (error) {
      if (session && !session.closed) {
        if (inputSent && !finishStarted) {
          try {
            await session.finish({ timeoutMs });
          } catch {
            session.close();
          }
        } else {
          session.close();
        }
      } else {
        peerConnection.close();
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new RunJobAttemptError(jobId ? `job ${jobId} failed: ${detail}` : detail, jobId, inputSent);
    }
  }

  private async killJobBestEffort(jobId?: string): Promise<void> {
    if (!jobId) {
      return;
    }
    try {
      await this.request<{ ok: boolean }>(`${this.jobApiPrefix}/${encodeURIComponent(jobId)}/kill`, { method: 'POST' });
    } catch {
      // Best-effort cleanup only; the retry path should still surface its own result.
    }
  }

  private takePrewarmedJobConnection(slaveAppId: string, rtcConfig: RTCConfiguration): PreparedJobConnection | undefined {
    const key = jobConnectionKey(slaveAppId, rtcConfig);
    this.dropClosedPrewarmedJobConnections();
    const index = this.prewarmedJobConnections.findIndex((item) => item.key === key);
    if (index === -1) {
      return undefined;
    }
    return this.prewarmedJobConnections.splice(index, 1)[0];
  }

  private dropClosedPrewarmedJobConnections(): void {
    for (let index = this.prewarmedJobConnections.length - 1; index >= 0; index -= 1) {
      const item = this.prewarmedJobConnections[index];
      if (item.peerConnection.signalingState === 'closed' || item.dataChannel.readyState === 'closed') {
        this.prewarmedJobConnections.splice(index, 1);
      }
    }
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    retryCsrf = true,
    retryAuth = true,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    if (this.authMode === 'bearer') {
      headers.set('Authorization', `Bearer ${this.token ?? ''}`);
    }
    const csrfRequired = this.usesCsrf(path, init.method);
    if (csrfRequired) {
      headers.set('X-CSRF-Token', await this.ensureCsrfToken());
    }
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      ...init,
      credentials: this.authMode === 'cookie' ? 'include' : init.credentials,
      headers,
    });
    if (this.authMode === 'cookie' && retryAuth && path !== '/auth/refresh' && response.status === 401) {
      await this.refreshCookieAuth();
      return await this.request<T>(path, init, retryCsrf, false);
    }
    if (csrfRequired && retryCsrf && response.status === 403) {
      this.csrfToken = undefined;
      return await this.request<T>(path, init, false, retryAuth);
    }
    if (!response.ok) {
      throw new Error(`${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  private async refreshCookieAuth(): Promise<void> {
    if (!this.authRefreshPromise) {
      this.authRefreshPromise = (async () => {
        const response = await fetch(`${this.apiBaseUrl}/auth/refresh`, {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          throw new Error(`${response.status} ${await response.text()}`);
        }
        this.csrfToken = undefined;
      })().finally(() => {
        this.authRefreshPromise = undefined;
      });
    }
    await this.authRefreshPromise;
  }

  private usesCsrf(path: string, method = 'GET'): boolean {
    return (
      this.authMode === 'cookie' &&
      path.startsWith('/web/') &&
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())
    );
  }

  private async ensureCsrfToken(): Promise<string> {
    if (this.csrfToken) {
      return this.csrfToken;
    }
    if (!this.csrfPromise) {
      this.csrfPromise = this.fetchCsrfToken().finally(() => {
        this.csrfPromise = undefined;
      });
    }
    return await this.csrfPromise;
  }

  private async fetchCsrfToken(): Promise<string> {
    const response = await fetch(`${this.apiBaseUrl}/web/auth/csrf`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${await response.text()}`);
    }
    const payload = (await response.json()) as { csrf_token?: unknown };
    if (typeof payload.csrf_token !== 'string' || !payload.csrf_token) {
      throw new Error('CSRF token response is missing csrf_token');
    }
    this.csrfToken = payload.csrf_token;
    return payload.csrf_token;
  }

  private async waitJobAnswer(jobId: string, timeoutMs: number): Promise<JobAnswerWaitResult> {
    const startedAt = Date.now();
    while (true) {
      const elapsed = Date.now() - startedAt;
      if (elapsed > timeoutMs) {
        throw new Error(`job answer timeout: ${jobId}`);
      }
      const waitSeconds = Math.max(0, Math.min(30, Math.floor((timeoutMs - elapsed) / 1000)));
      const result = await this.request<JobAnswerWaitResult>(
        `${this.jobApiPrefix}/${encodeURIComponent(jobId)}/wait-answer?wait_seconds=${waitSeconds}`,
      );
      if (result.answer || ['failed', 'cancelled', 'killed', 'succeeded'].includes(result.state)) {
        return result;
      }
    }
  }
}

function normalizeApiPrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (!trimmed || trimmed === '/') {
    return '';
  }
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}
