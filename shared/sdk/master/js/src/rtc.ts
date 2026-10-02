import { DEFAULT_RTC_ICE_CANDIDATE_POOL_SIZE, DEFAULT_RTC_ICE_SERVERS } from './constants.js';
import type { CandidateSummary, PreparedJobConnection } from './types.js';

export function parseRtcIceServersJson(value: string): RTCIceServer[] {
  return JSON.parse(value) as RTCIceServer[];
}

export function summarizeSdpCandidates(sdp: string): CandidateSummary {
  const summary: CandidateSummary = { host: 0, srflx: 0, relay: 0, prflx: 0, unknown: 0, total: 0 };
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith('a=candidate:')) {
      continue;
    }
    summary.total += 1;
    const match = /\btyp\s+(\S+)/.exec(line);
    const type = match?.[1];
    if (type === 'host' || type === 'srflx' || type === 'relay' || type === 'prflx') {
      summary[type] += 1;
    } else {
      summary.unknown += 1;
    }
  }
  return summary;
}

export function rtcConfigWithDefaults(config?: RTCConfiguration): RTCConfiguration {
  return {
    ...(config ?? {}),
    iceServers: config?.iceServers ?? DEFAULT_RTC_ICE_SERVERS,
    iceCandidatePoolSize: config?.iceCandidatePoolSize ?? DEFAULT_RTC_ICE_CANDIDATE_POOL_SIZE,
  };
}

export function jobConnectionKey(slaveAppId: string, rtcConfig: RTCConfiguration): string {
  return `${slaveAppId}:${JSON.stringify(rtcConfig)}`;
}

export function createPreparedJobConnection(slaveAppId: string, rtcConfig: RTCConfiguration): PreparedJobConnection {
  const peerConnection = new RTCPeerConnection(rtcConfig);
  const dataChannel = peerConnection.createDataChannel('gpstation.v1', { ordered: true });
  return {
    peerConnection,
    dataChannel,
    key: jobConnectionKey(slaveAppId, rtcConfig),
    slaveAppId,
    rtcConfig,
    diagnosticsRegistered: false,
  };
}

export function waitForIceGatheringComplete(
  peerConnection: RTCPeerConnection,
  timeoutMs: number,
): Promise<void> {
  if (peerConnection.iceGatheringState === 'complete') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    peerConnection.addEventListener('icegatheringstatechange', () => {
      if (peerConnection.iceGatheringState === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}
