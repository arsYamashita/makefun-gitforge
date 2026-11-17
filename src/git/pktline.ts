// pkt-line framing for the smart-HTTP protocol.

import { HttpError } from '../http.ts';

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');
/** The most payload bytes one pkt-line may carry. */
export const PKT_MAX_PAYLOAD = 65516;

export function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/**
 * Read packets from `offset`. With `stopAtFlush` the read ends after the first flush (the byte offset
 * past it is returned in `next`, which is how receive-pack finds where its pack begins).
 */
export function readPackets(buf: Buffer, offset = 0, stopAtFlush = false): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let pos = offset;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new HttpError(400, 'truncated pkt-line');
    const hex = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new HttpError(400, 'malformed pkt-line length');
    const len = parseInt(hex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      pos += 4;
      if (stopAtFlush) break;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'end' });
      pos += 4;
      continue;
    }
    if (len < 4 || pos + len > buf.length) throw new HttpError(400, 'bad pkt-line length');
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return { packets, next: pos };
}

/** The text of a data packet without its trailing newline. */
export function lineOf(packet: Packet): string {
  return packet.kind === 'data' ? packet.payload.toString('utf8').replace(/\n$/, '') : '';
}

/** Wrap bytes into side-band-64k data packets on `band`. */
export function sideband(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let at = 0; at < data.length; at += PKT_MAX_PAYLOAD - 1) {
    const chunk = data.subarray(at, Math.min(data.length, at + PKT_MAX_PAYLOAD - 1));
    out.push(pkt(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return out;
}
