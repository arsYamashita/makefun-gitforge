// Packfile reading (including OFS_DELTA and REF_DELTA resolution) and writing.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, GitObjectType } from '../store.ts';
import { hashObject } from './objects.ts';

const TYPE_BY_CODE: Record<number, GitObjectType | undefined> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const CODE_BY_TYPE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export class PackError extends Error {}

/** The largest object a pack may carry or a delta may build; well above anything the suite pushes, well below the 1 GiB pod. */
export const MAX_OBJECT_BYTES = 128 * 1024 * 1024;

export interface PackedObject {
  readonly sha: string;
  readonly type: GitObjectType;
  readonly body: Buffer;
}

/** Apply a git delta (copy and insert instructions) to `base`. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const varint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new PackError('truncated delta header');
      const byte = delta[pos++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = varint();
  const targetSize = varint();
  if (sourceSize !== base.length) throw new PackError('delta base size mismatch');
  if (targetSize > MAX_OBJECT_BYTES) throw new PackError('delta target too large');
  // Every byte of the result is written below (the size check at the end proves it), but a zeroed
  // buffer keeps a malformed delta from ever exposing stale memory.
  const out = Buffer.alloc(targetSize);
  const param = (): number => {
    if (pos >= delta.length) throw new PackError('truncated delta copy instruction');
    return delta[pos++];
  };
  let at = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) offset += param() * 2 ** (8 * i);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) size += param() * 2 ** (8 * i);
      if (size === 0) size = 0x10000;
      if (offset + size > base.length || at + size > targetSize) throw new PackError('delta copy out of range');
      base.copy(out, at, offset, offset + size);
      at += size;
    } else if (op > 0) {
      if (pos + op > delta.length || at + op > targetSize) throw new PackError('delta insert out of range');
      delta.copy(out, at, pos, pos + op);
      pos += op;
      at += op;
    } else {
      throw new PackError('delta opcode 0');
    }
  }
  if (at !== targetSize) throw new PackError('delta result size mismatch');
  return out;
}

interface RawEntry {
  readonly offset: number;
  readonly code: number;
  readonly data: Buffer;
  readonly baseOffset?: number;
  readonly baseSha?: string;
}

/**
 * Read a whole pack. `lookup` resolves REF_DELTA bases that are not in the pack (thin packs).
 * Throws PackError for anything malformed, including a checksum mismatch.
 */
export function readPack(pack: Buffer, lookup: (sha: string) => GitObject | undefined): PackedObject[] {
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') throw new PackError('not a pack');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new PackError(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const end = pack.length - 20;
  const trailer = createHash('sha1').update(pack.subarray(0, end)).digest();
  if (!trailer.equals(pack.subarray(end))) throw new PackError('pack checksum mismatch');
  const raws: RawEntry[] = [];
  let pos = 12;
  for (let index = 0; index < count; index += 1) {
    const offset = pos;
    if (pos >= end) throw new PackError('pack is truncated');
    let byte = pack[pos++];
    const code = (byte >> 4) & 7;
    let size = byte & 15;
    let shift = 4;
    while (byte & 0x80) {
      if (pos >= end) throw new PackError('pack is truncated');
      byte = pack[pos++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseSha: string | undefined;
    if (code === 6) {
      let c = pack[pos++];
      let distance = c & 0x7f;
      while (c & 0x80) {
        c = pack[pos++];
        distance = (distance + 1) * 128 + (c & 0x7f);
      }
      baseOffset = offset - distance;
    } else if (code === 7) {
      baseSha = pack.toString('hex', pos, pos + 20);
      pos += 20;
    } else if (TYPE_BY_CODE[code] === undefined) {
      throw new PackError(`bad object type ${code}`);
    }
    if (size > MAX_OBJECT_BYTES) throw new PackError(`object at ${offset} is too large`);
    let inflated: { buffer: Buffer; engine: { bytesWritten: number } };
    try {
      inflated = inflateSync(pack.subarray(pos, end), { info: true, maxOutputLength: Math.max(size, 1) }) as unknown as typeof inflated;
    } catch (err) {
      throw new PackError(`object at ${offset} does not inflate: ${(err as Error).message}`);
    }
    if (inflated.buffer.length !== size) throw new PackError(`object at ${offset} has the wrong size`);
    pos += inflated.engine.bytesWritten;
    raws.push({ offset, code, data: inflated.buffer, baseOffset, baseSha });
  }
  if (pos !== end) throw new PackError('trailing bytes after the last pack entry');

  const byOffset = new Map<number, { type: GitObjectType; body: Buffer }>();
  const bySha = new Map<string, { type: GitObjectType; body: Buffer }>();
  const result = new Map<string, PackedObject>();
  // Deltas whose base is not known yet wait under the base's offset ("o:") or sha ("s:").
  const waiting = new Map<string, RawEntry[]>();
  const ready: Array<{ raw: RawEntry; base: { type: GitObjectType; body: Buffer } }> = [];
  const settle = (raw: RawEntry, type: GitObjectType, body: Buffer): void => {
    const sha = hashObject(type, body);
    const resolved = { type, body };
    byOffset.set(raw.offset, resolved);
    bySha.set(sha, resolved);
    if (!result.has(sha)) result.set(sha, { sha, type, body });
    for (const key of [`o:${raw.offset}`, `s:${sha}`]) {
      const woken = waiting.get(key);
      if (woken === undefined) continue;
      waiting.delete(key);
      for (const delta of woken) ready.push({ raw: delta, base: resolved });
    }
  };
  const deltas: RawEntry[] = [];
  for (const raw of raws) {
    const type = TYPE_BY_CODE[raw.code];
    if (type !== undefined) settle(raw, type, raw.data);
    else deltas.push(raw);
  }
  for (const raw of deltas) {
    const base = raw.code === 6 ? byOffset.get(raw.baseOffset!) : (bySha.get(raw.baseSha!) ?? lookup(raw.baseSha!));
    if (base !== undefined) {
      ready.push({ raw, base });
      continue;
    }
    const key = raw.code === 6 ? `o:${raw.baseOffset!}` : `s:${raw.baseSha!}`;
    const list = waiting.get(key);
    if (list === undefined) waiting.set(key, [raw]);
    else list.push(raw);
  }
  // Each delta is applied once, as soon as its base is known.
  for (let next = 0; next < ready.length; next += 1) {
    const { raw, base } = ready[next];
    settle(raw, base.type, applyDelta(base.body, raw.data));
  }
  if (waiting.size > 0) throw new PackError('a delta names a base that is not available');
  return [...result.values()];
}

const entryCache = new WeakMap<GitObject, Buffer>();

function entryOf(object: GitObject): Buffer {
  let entry = entryCache.get(object);
  if (entry === undefined) {
    const bytes: number[] = [];
    let remaining = Math.floor(object.body.length / 16);
    let first = (CODE_BY_TYPE[object.type] << 4) | (object.body.length & 15);
    while (remaining > 0) {
      bytes.push(first | 0x80);
      first = remaining & 0x7f;
      remaining = Math.floor(remaining / 128);
    }
    bytes.push(first);
    entry = Buffer.concat([Buffer.from(bytes), deflateSync(object.body, { level: 1 })]);
    entryCache.set(object, entry);
  }
  return entry;
}

/** A version 2 pack of whole (undeltified) objects. Each object's compressed form is cached. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) parts.push(entryOf(object));
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
