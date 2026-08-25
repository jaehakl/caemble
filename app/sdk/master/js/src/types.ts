export type LauncherView = {
  id: string;
  user_id: string;
  launcher_name: string;
  status: string;
  slave_app_ids: string[];
  connected_at: string;
  last_heartbeat_at: string;
};

export type JobDescriptor = {
  id: string;
  user_id: string;
  handler_type: string;
  slave_app_id: string;
  offer: SignalPayload;
  answer?: SignalPayload | null;
  progress: unknown[];
  state: string;
  launcher_id?: string | null;
};

export type JobCreateResult = {
  job: JobDescriptor;
  answer_wait_url: string;
};

export type JobAnswerWaitResult = {
  job_id: string;
  state: string;
  answer?: SignalPayload | null;
  last_error?: string | null;
};

export type SignalPayload =
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | { type: 'ice'; candidate?: string; sdpMid?: string; sdpMLineIndex?: number }
  | { type: 'end-of-candidates' };

export type AttachmentMetadata = {
  id: string;
  name?: string;
  mimeType?: string;
  size: number;
};

export type RequestAttachment = {
  id: string;
  blob: Blob;
  name?: string;
  mimeType?: string;
};

export type AttachmentChunkHeader = {
  kind: 'attachment.chunk';
  callId: string;
  attachmentId: string;
  index: number;
  final: boolean;
};

export type ReceivedFile = AttachmentMetadata & {
  blob: Blob;
};

export type CallResult<T = unknown> = {
  payload: T;
  files: ReceivedFile[];
};

export type JobEvent = {
  id?: string;
  type?: string;
  payload?: unknown;
};

export type JobSessionCallOptions = {
  timeoutMs?: number;
  onEvent?: (event: JobEvent) => void;
  attachments?: RequestAttachment[];
};

export type JobSessionFinishOptions = {
  timeoutMs?: number;
};

export type JobSession = {
  readonly jobId: string;
  readonly closed: boolean;
  call<TInput = unknown, TResult = unknown>(
    handlerType: string,
    input?: TInput,
    options?: JobSessionCallOptions,
  ): Promise<CallResult<TResult>>;
  finish(options?: JobSessionFinishOptions): Promise<void>;
  close(): void;
};

export type RunJobSessionResult<T = unknown> = CallResult<T> & {
  session: JobSession;
};

export type CandidateSummary = {
  host: number;
  srflx: number;
  relay: number;
  prflx: number;
  unknown: number;
  total: number;
};

export type ConnectDiagnosticEvent = {
  stage: string;
  message: string;
  callId?: string;
  attachmentCount?: number;
  attachmentBytes?: number;
  bufferedAmount?: number;
  elapsedMs?: number;
  stageStartedAt?: number;
  prewarmHit?: boolean;
  offerGatheringMs?: number;
  answerWaitMs?: number;
  dataChannelOpenMs?: number;
  signalingState?: RTCSignalingState;
  iceGatheringState?: RTCIceGatheringState;
  iceConnectionState?: RTCIceConnectionState;
  connectionState?: RTCPeerConnectionState;
  dataChannelState?: RTCDataChannelState;
  localCandidateSummary?: CandidateSummary;
  remoteCandidateSummary?: CandidateSummary;
  localSdp?: string;
  remoteSdp?: string;
};

export type GpStationClientOptions = {
  apiBaseUrl: string;
  token?: string;
  authMode?: 'bearer' | 'cookie';
  jobApiPrefix?: string;
  rtcConfig?: RTCConfiguration;
};

export type ConnectOptions = {
  timeoutMs?: number;
  onStatus?: (status: string) => void;
  onDiagnostic?: (event: ConnectDiagnosticEvent) => void;
};

export type RunJobOptions = ConnectOptions & {
  slaveAppId?: string;
  rtcConfig?: RTCConfiguration;
  onJobCreated?: (job: JobDescriptor) => void;
  autoFinish?: boolean;
  onEvent?: (event: JobEvent) => void;
  attachments?: RequestAttachment[];
};

export type JobConnectionPrewarmOptions = {
  slaveAppId?: string;
  rtcConfig?: RTCConfiguration;
  onDiagnostic?: (event: ConnectDiagnosticEvent) => void;
};

export type IncomingFile = AttachmentMetadata & {
  chunks: Uint8Array[];
  receivedSize: number;
  nextIndex: number;
  complete: boolean;
};

export type PendingResponse = {
  id?: string;
  payload: unknown;
  attachments: AttachmentMetadata[];
  files: Map<string, IncomingFile>;
};

export type PreparedJobConnection = {
  peerConnection: RTCPeerConnection;
  dataChannel: RTCDataChannel;
  key: string;
  slaveAppId: string;
  rtcConfig: RTCConfiguration;
  diagnosticsRegistered: boolean;
};
