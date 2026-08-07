import { asError, decodeBinaryFrame, encodeBinaryFrame, rawToUint8Array, toArrayBuffer } from './binary.js';
import { emitDiagnostic } from './diagnostics.js';
import type {
  AttachmentMetadata,
  CallResult,
  ConnectDiagnosticEvent,
  IncomingFile,
  JobEvent,
  PendingResponse,
  RequestAttachment,
} from './types.js';

const REQUEST_ATTACHMENT_CHUNK_SIZE = 16 * 1024;
const REQUEST_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const MAX_BUFFERED_AMOUNT = 512 * 1024;
const BUFFERED_AMOUNT_LOW_THRESHOLD = 128 * 1024;
const BUFFERED_AMOUNT_DRAIN_TIMEOUT_MS = 30_000;

type JobControlFrame = {
  kind: string;
  id?: string;
  type?: string;
  payload?: unknown;
  attachments?: AttachmentMetadata[];
  detail?: string;
};

type PendingCall = {
  id: string;
  resolve: (value: CallResult<unknown>) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onEvent?: (event: JobEvent) => void;
};

export class GpStationJobPeer {
  private pendingCall?: PendingCall;
  private response?: PendingResponse;
  private finishResolve?: () => void;
  private finishReject?: (reason: Error) => void;
  private finishTimer?: ReturnType<typeof setTimeout>;
  private finishSent = false;
  private isClosed = false;

  constructor(
    private readonly peerConnection: RTCPeerConnection,
    private readonly dataChannel: RTCDataChannel,
    private readonly diagnostic: (event: ConnectDiagnosticEvent) => void,
  ) {
    this.dataChannel.binaryType = 'arraybuffer';
    this.dataChannel.addEventListener('message', (event) => {
      void this.handleDataMessage(event.data);
    });
    this.dataChannel.addEventListener('close', () => this.rejectOpenWork(new Error('data channel closed')));
    this.dataChannel.addEventListener('error', () => this.rejectOpenWork(new Error('data channel error')));
  }

  get closed(): boolean {
    return this.isClosed || this.peerConnection.signalingState === 'closed' || this.dataChannel.readyState === 'closed';
  }

  waitUntilOpen(timeoutMs: number): Promise<void> {
    if (this.dataChannel.readyState === 'open') {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`data channel open timeout (${this.connectionStateSummary()})`)),
        timeoutMs,
      );
      this.dataChannel.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  sendReady(jobId: string): void {
    this.ensureOpen('send job ready');
    this.dataChannel.send(JSON.stringify({ kind: 'job.ready', id: jobId }));
    emitDiagnostic(this.peerConnection, this.dataChannel, this.diagnostic, {
      stage: 'job-ready',
      message: 'sent job ready',
    });
  }

  call<TResult>(
    callId: string,
    handlerType: string,
    payload: unknown,
    timeoutMs: number,
    onEvent?: (event: JobEvent) => void,
    attachments: RequestAttachment[] = [],
  ): Promise<CallResult<TResult>> {
    this.ensureOpen('send job call');
    if (this.pendingCall) {
      return Promise.reject(new Error(`job call already in progress: ${this.pendingCall.id}`));
    }
    try {
      this.validateRequestAttachments(attachments);
    } catch (error) {
      return Promise.reject(asError(error));
    }
    return new Promise<CallResult<unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectPendingCall(new Error(`job result timeout: ${callId}`));
      }, timeoutMs);
      this.pendingCall = {
        id: callId,
        resolve: resolve as (value: CallResult<unknown>) => void,
        reject,
        timer,
        onEvent,
      };
      this.response = undefined;
      void this.sendJobCall(callId, handlerType, payload, attachments).catch((error) => {
        this.rejectPendingCall(asError(error));
      });
    }) as Promise<CallResult<TResult>>;
  }

  private async sendJobCall(
    callId: string,
    handlerType: string,
    payload: unknown,
    attachments: RequestAttachment[],
  ): Promise<void> {
    const frame: JobControlFrame = {
      kind: 'job.call',
      id: callId,
      type: handlerType,
      payload,
    };
    if (attachments.length > 0) {
      frame.attachments = attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType || attachment.blob.type || undefined,
        size: attachment.blob.size,
      }));
    }
    this.dataChannel.send(JSON.stringify(frame));
    for (const attachment of attachments) {
      await this.sendRequestAttachment(callId, attachment);
    }
    emitDiagnostic(this.peerConnection, this.dataChannel, this.diagnostic, {
      stage: 'job-call',
      message: `sent job call: ${handlerType}`,
    });
  }

  private async sendRequestAttachment(callId: string, attachment: RequestAttachment): Promise<void> {
    if (attachment.blob.size === 0) {
      this.dataChannel.send(
        toArrayBuffer(
          encodeBinaryFrame(
            {
              kind: 'attachment.chunk',
              callId,
              attachmentId: attachment.id,
              index: 0,
              final: true,
            },
            new Uint8Array(),
          ),
        ),
      );
      return;
    }

    let index = 0;
    for (let offset = 0; offset < attachment.blob.size; offset += REQUEST_ATTACHMENT_CHUNK_SIZE) {
      const end = Math.min(offset + REQUEST_ATTACHMENT_CHUNK_SIZE, attachment.blob.size);
      const body = new Uint8Array(await attachment.blob.slice(offset, end).arrayBuffer());
      this.ensureOpen('send job attachment');
      this.dataChannel.send(
        toArrayBuffer(
          encodeBinaryFrame(
            {
              kind: 'attachment.chunk',
              callId,
              attachmentId: attachment.id,
              index,
              final: end === attachment.blob.size,
            },
            body,
          ),
        ),
      );
      if (this.dataChannel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
        await this.waitForSendBuffer();
      }
      index += 1;
    }
  }

  private validateRequestAttachments(attachments: RequestAttachment[]): void {
    const ids = new Set<string>();
    for (const attachment of attachments) {
      if (!attachment.id) {
        throw new Error('request attachment id is required');
      }
      if (ids.has(attachment.id)) {
        throw new Error(`duplicate request attachment id: ${attachment.id}`);
      }
      if (attachment.blob.size > REQUEST_ATTACHMENT_MAX_BYTES) {
        throw new Error(`request attachment exceeds ${REQUEST_ATTACHMENT_MAX_BYTES} bytes: ${attachment.id}`);
      }
      ids.add(attachment.id);
    }
  }

  private waitForSendBuffer(): Promise<void> {
    if (this.closed || this.dataChannel.readyState !== 'open') {
      return Promise.reject(new Error('data channel closed while sending attachment'));
    }
    this.dataChannel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;
    if (this.dataChannel.bufferedAmount <= BUFFERED_AMOUNT_LOW_THRESHOLD) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        this.dataChannel.removeEventListener('bufferedamountlow', onLow);
        this.dataChannel.removeEventListener('close', onClose);
        this.dataChannel.removeEventListener('error', onError);
      };
      const onLow = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error('data channel closed while sending attachment'));
      };
      const onError = () => {
        cleanup();
        reject(new Error('data channel error while sending attachment'));
      };
      this.dataChannel.addEventListener('bufferedamountlow', onLow);
      this.dataChannel.addEventListener('close', onClose);
      this.dataChannel.addEventListener('error', onError);
      timer = setTimeout(() => {
        cleanup();
        reject(new Error('data channel buffer did not drain while sending attachment'));
      }, BUFFERED_AMOUNT_DRAIN_TIMEOUT_MS);
    });
  }

  finish(jobId: string, timeoutMs: number): Promise<void> {
    this.ensureOpen('finish job');
    if (this.pendingCall) {
      return Promise.reject(new Error(`cannot finish while job call is in progress: ${this.pendingCall.id}`));
    }
    if (this.finishResolve) {
      return Promise.reject(new Error('job finish already in progress'));
    }
    return new Promise<void>((resolve, reject) => {
      this.finishTimer = setTimeout(() => {
        this.rejectFinish(new Error(`job finish timeout: ${jobId}`));
      }, timeoutMs);
      this.finishResolve = resolve;
      this.finishReject = reject;
      try {
        this.dataChannel.send(JSON.stringify({ kind: 'job.finish', id: jobId }));
        this.finishSent = true;
      } catch (error) {
        this.clearFinish();
        reject(asError(error));
        return;
      }
      emitDiagnostic(this.peerConnection, this.dataChannel, this.diagnostic, {
        stage: 'job-finish',
        message: 'sent job finish',
      });
    }).then(() => {
      this.close();
    });
  }

  close(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    this.rejectPendingCall(new Error('job session closed'));
    this.rejectFinish(new Error('job session closed'));
    this.peerConnection.close();
  }

  private async handleDataMessage(rawData: unknown): Promise<void> {
    try {
      if (typeof rawData === 'string') {
        await this.handleControlMessage(JSON.parse(rawData) as JobControlFrame);
        return;
      }
      await this.handleBinaryMessage(await rawToUint8Array(rawData));
    } catch (error) {
      this.rejectPendingCall(asError(error));
    }
  }

  private async handleControlMessage(message: JobControlFrame): Promise<void> {
    if (message.kind === 'job.error') {
      if (message.id && this.pendingCall?.id === message.id) {
        this.rejectPendingCall(new Error(message.detail || 'job error'));
        return;
      }
      this.rejectOpenWork(new Error(message.detail || 'job error'));
      return;
    }
    if (message.kind === 'job.event') {
      this.pendingCall?.onEvent?.({ id: message.id, type: message.type, payload: message.payload });
      return;
    }
    if (message.kind === 'job.finished') {
      this.resolveFinish();
      return;
    }
    if (message.kind !== 'job.result') {
      return;
    }
    if (!message.id || !this.pendingCall || this.pendingCall.id !== message.id) {
      throw new Error(`unexpected job result: ${message.id ?? 'missing id'}`);
    }
    emitDiagnostic(this.peerConnection, this.dataChannel, this.diagnostic, {
      stage: 'job-result',
      message: 'received job result',
    });
    const files = new Map<string, IncomingFile>();
    for (const attachment of message.attachments ?? []) {
      files.set(attachment.id, {
        ...attachment,
        chunks: [],
        receivedSize: 0,
        nextIndex: 0,
        complete: false,
      });
    }
    this.response = {
      id: message.id,
      payload: message.payload,
      attachments: message.attachments ?? [],
      files,
    };
    if (files.size === 0) {
      await this.resolvePendingCall();
    }
  }

  private async handleBinaryMessage(frame: Uint8Array): Promise<void> {
    const { header, body } = decodeBinaryFrame(frame);
    if (header.kind !== 'attachment.chunk' || !this.response) {
      return;
    }
    if (this.pendingCall?.id !== header.callId) {
      throw new Error(`unexpected attachment chunk call id: ${header.callId}`);
    }
    const file = this.response.files.get(header.attachmentId);
    if (!file) {
      throw new Error(`unknown attachment chunk: ${header.attachmentId}`);
    }
    if (header.index !== file.nextIndex) {
      throw new Error(`out-of-order attachment chunk: ${header.attachmentId}`);
    }
    file.chunks.push(body);
    file.receivedSize += body.byteLength;
    file.nextIndex += 1;
    file.complete = header.final;
    if (file.complete && file.receivedSize !== file.size) {
      throw new Error(`attachment size mismatch: ${header.attachmentId}`);
    }
    if ([...this.response.files.values()].every((item) => item.complete)) {
      await this.resolvePendingCall();
    }
  }

  private async resolvePendingCall(): Promise<void> {
    if (!this.response || !this.pendingCall) {
      return;
    }
    try {
      await this.acknowledgeResult(this.pendingCall.id);
    } catch (error) {
      this.rejectPendingCall(asError(error));
      return;
    }
    const pending = this.pendingCall;
    const response = this.response;
    this.clearPendingCall();
    const files = response.attachments.map((metadata) => {
      const file = response.files.get(metadata.id);
      const chunks = file?.chunks ?? [];
      return {
        ...metadata,
        blob: new Blob(chunks.map(toArrayBuffer), { type: metadata.mimeType }),
      };
    });
    pending.resolve({ payload: response.payload, files });
  }

  private rejectOpenWork(error: Error): void {
    this.rejectPendingCall(error);
    if (this.finishResolve && this.finishSent) {
      this.resolveFinish('job finish completed after data channel closed');
      return;
    }
    this.rejectFinish(error);
  }

  private rejectPendingCall(error: Error): void {
    if (!this.pendingCall) {
      return;
    }
    const pending = this.pendingCall;
    this.clearPendingCall();
    pending.reject(error);
  }

  private rejectFinish(error: Error): void {
    if (!this.finishReject) {
      return;
    }
    const reject = this.finishReject;
    this.clearFinish();
    reject(error);
  }

  private clearPendingCall(): void {
    if (this.pendingCall) {
      clearTimeout(this.pendingCall.timer);
    }
    this.pendingCall = undefined;
    this.response = undefined;
  }

  private clearFinish(): void {
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
    }
    this.finishResolve = undefined;
    this.finishReject = undefined;
    this.finishTimer = undefined;
    this.finishSent = false;
  }

  private resolveFinish(message = 'received job finished'): void {
    if (!this.finishResolve) {
      return;
    }
    const resolve = this.finishResolve;
    this.clearFinish();
    emitDiagnostic(this.peerConnection, this.dataChannel, this.diagnostic, {
      stage: 'job-finished',
      message,
    });
    resolve();
  }

  private async acknowledgeResult(callId: string): Promise<void> {
    this.ensureOpen('acknowledge job result');
    this.dataChannel.send(JSON.stringify({ kind: 'job.result.ack', id: callId }));
    await this.waitForAckBufferedAmountLow();
    emitDiagnostic(this.peerConnection, this.dataChannel, this.diagnostic, {
      stage: 'job-result-ack',
      message: 'sent job result ack',
    });
  }

  private waitForAckBufferedAmountLow(): Promise<void> {
    if (this.dataChannel.readyState !== 'open') {
      return Promise.reject(new Error('data channel closed before job result ack'));
    }
    if (this.dataChannel.bufferedAmount === 0) {
      return Promise.resolve();
    }
    this.dataChannel.bufferedAmountLowThreshold = 0;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        this.dataChannel.removeEventListener('bufferedamountlow', onLow);
        this.dataChannel.removeEventListener('close', onClose);
        this.dataChannel.removeEventListener('error', onError);
      };
      const onLow = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error('data channel closed before job result ack'));
      };
      const onError = () => {
        cleanup();
        reject(new Error('data channel error before job result ack'));
      };
      this.dataChannel.addEventListener('bufferedamountlow', onLow);
      this.dataChannel.addEventListener('close', onClose);
      this.dataChannel.addEventListener('error', onError);
      timer = setTimeout(() => {
        cleanup();
        reject(new Error('job result ack buffered amount timeout'));
      }, 1000);
    });
  }

  private ensureOpen(action: string): void {
    if (this.closed || this.dataChannel.readyState !== 'open') {
      throw new Error(`cannot ${action}; data channel is ${this.dataChannel.readyState}`);
    }
  }

  private connectionStateSummary(): string {
    return [
      `signaling=${this.peerConnection.signalingState}`,
      `iceGathering=${this.peerConnection.iceGatheringState}`,
      `iceConnection=${this.peerConnection.iceConnectionState}`,
      `connection=${this.peerConnection.connectionState}`,
      `dataChannel=${this.dataChannel.readyState}`,
    ].join(', ');
  }
}
