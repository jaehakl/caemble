import type { AttachmentChunkHeader } from './types.js';

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export function encodeBinaryFrame(header: AttachmentChunkHeader, body: Uint8Array): Uint8Array {
  const headerBytes = textEncoder.encode(JSON.stringify(header));
  const frame = new Uint8Array(4 + headerBytes.byteLength + body.byteLength);
  new DataView(frame.buffer).setUint32(0, headerBytes.byteLength, false);
  frame.set(headerBytes, 4);
  frame.set(body, 4 + headerBytes.byteLength);
  return frame;
}

export function decodeBinaryFrame(frame: Uint8Array): { header: AttachmentChunkHeader; body: Uint8Array } {
  if (frame.byteLength < 4) {
    throw new Error('binary frame is too short');
  }
  const headerLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false);
  if (headerLength <= 0 || frame.byteLength < 4 + headerLength) {
    throw new Error('invalid binary frame header length');
  }
  const header = JSON.parse(textDecoder.decode(frame.slice(4, 4 + headerLength))) as AttachmentChunkHeader;
  return { header, body: frame.slice(4 + headerLength) };
}

export async function rawToUint8Array(rawData: unknown): Promise<Uint8Array> {
  if (rawData instanceof ArrayBuffer) {
    return new Uint8Array(rawData);
  }
  if (ArrayBuffer.isView(rawData)) {
    const view = rawData as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (typeof Blob !== 'undefined' && rawData instanceof Blob) {
    return new Uint8Array(await rawData.arrayBuffer());
  }
  throw new Error('unsupported binary message type');
}

export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return buffer;
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
