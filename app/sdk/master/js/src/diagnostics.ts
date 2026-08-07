import type { ConnectDiagnosticEvent, PreparedJobConnection } from './types.js';

export function registerPreparedJobConnectionDiagnostics(
  prepared: PreparedJobConnection,
  diagnostic: (event: ConnectDiagnosticEvent) => void,
): void {
  if (prepared.diagnosticsRegistered) {
    return;
  }
  registerConnectionDiagnostics(prepared.peerConnection, prepared.dataChannel, diagnostic);
  prepared.diagnosticsRegistered = true;
}

export function registerConnectionDiagnostics(
  peerConnection: RTCPeerConnection,
  dataChannel: RTCDataChannel,
  diagnostic: (event: ConnectDiagnosticEvent) => void,
): void {
  peerConnection.addEventListener('signalingstatechange', () => {
    emitDiagnostic(peerConnection, dataChannel, diagnostic, {
      stage: 'signaling-state',
      message: `signaling state: ${peerConnection.signalingState}`,
    });
  });
  peerConnection.addEventListener('icegatheringstatechange', () => {
    emitDiagnostic(peerConnection, dataChannel, diagnostic, {
      stage: 'ice-gathering-state',
      message: `ICE gathering state: ${peerConnection.iceGatheringState}`,
    });
  });
  peerConnection.addEventListener('iceconnectionstatechange', () => {
    emitDiagnostic(peerConnection, dataChannel, diagnostic, {
      stage: 'ice-connection-state',
      message: `ICE connection state: ${peerConnection.iceConnectionState}`,
    });
  });
  peerConnection.addEventListener('connectionstatechange', () => {
    emitDiagnostic(peerConnection, dataChannel, diagnostic, {
      stage: 'connection-state',
      message: `peer connection state: ${peerConnection.connectionState}`,
    });
  });
  dataChannel.addEventListener('open', () => {
    emitDiagnostic(peerConnection, dataChannel, diagnostic, {
      stage: 'data-channel-state',
      message: 'data channel state: open',
    });
  });
  dataChannel.addEventListener('close', () => {
    emitDiagnostic(peerConnection, dataChannel, diagnostic, {
      stage: 'data-channel-state',
      message: 'data channel state: closed',
    });
  });
  dataChannel.addEventListener('error', () => {
    emitDiagnostic(peerConnection, dataChannel, diagnostic, {
      stage: 'data-channel-state',
      message: 'data channel state: error',
    });
  });
}

export function emitDiagnostic(
  peerConnection: RTCPeerConnection,
  dataChannel: RTCDataChannel,
  diagnostic: (event: ConnectDiagnosticEvent) => void,
  event: ConnectDiagnosticEvent,
): void {
  diagnostic({
    signalingState: peerConnection.signalingState,
    iceGatheringState: peerConnection.iceGatheringState,
    iceConnectionState: peerConnection.iceConnectionState,
    connectionState: peerConnection.connectionState,
    dataChannelState: dataChannel.readyState,
    ...event,
  });
}
