import { randomUUID } from 'node:crypto';
import { AppsErrorCodes, MAX_UPLOAD_BYTES } from '@lgdm/protocol';
import { RpcError } from './errors.js';

interface Upload {
  name: string;
  data: Buffer;
  received: number;
}

/** Most bytes one connection may hold in pending uploads at once. */
const MAX_PENDING_BYTES = MAX_UPLOAD_BYTES;

/**
 * Files sent from the browser, held in memory for one WebSocket connection only. Nothing is written to disk;
 * everything is dropped when used, discarded, or the connection closes.
 */
export class UploadStore {
  private uploads = new Map<string, Upload>();

  private pendingBytes() {
    let n = 0;
    for (const u of this.uploads.values()) n += u.data.length;
    return n;
  }

  begin(name: string, size: number): string {
    if (this.pendingBytes() + size > MAX_PENDING_BYTES) {
      throw new RpcError(AppsErrorCodes.UploadTooLarge, 'Too much data is waiting on the bridge. Finish or cancel other uploads first.');
    }
    const id = randomUUID();
    this.uploads.set(id, { name, data: Buffer.alloc(size), received: 0 });
    return id;
  }

  /** Chunks must arrive in order. Returns bytes received so far. */
  chunk(id: string, offset: number, base64: string): number {
    const u = this.get(id);
    const bytes = Buffer.from(base64, 'base64');
    if (offset !== u.received) {
      throw new RpcError('bad_request', `Expected the chunk at offset ${u.received}, got ${offset}.`);
    }
    if (offset + bytes.length > u.data.length) {
      throw new RpcError(AppsErrorCodes.UploadTooLarge, 'The upload is larger than announced.');
    }
    bytes.copy(u.data, offset);
    u.received += bytes.length;
    return u.received;
  }

  /** Take a finished upload out of the store. */
  take(id: string): { name: string; data: Buffer } {
    const u = this.get(id);
    if (u.received !== u.data.length) {
      throw new RpcError(AppsErrorCodes.UploadIncomplete, `The upload is incomplete (${u.received} of ${u.data.length} bytes).`);
    }
    this.uploads.delete(id);
    return { name: u.name, data: u.data };
  }

  discard(id: string) {
    this.uploads.delete(id);
  }

  clear() {
    this.uploads.clear();
  }

  private get(id: string): Upload {
    const u = this.uploads.get(id);
    if (!u) throw new RpcError(AppsErrorCodes.UploadNotFound, 'That upload does not exist on the bridge (it may have expired).');
    return u;
  }
}
