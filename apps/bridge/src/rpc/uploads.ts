import { randomUUID } from 'node:crypto';
import { AppsErrorCodes, MAX_UPLOAD_BYTES } from '@lgdm/protocol';
import { RpcError } from './errors.js';

/**
 * Bytes the whole bridge may hold for uploads at once, across all connections, counted from `begin` until the
 * install using it has finished. Keeps a runaway tab from pushing the bridge out of memory.
 */
export class UploadBudget {
  private used = 0;
  constructor(readonly limit = MAX_UPLOAD_BYTES) {}

  reserve(bytes: number) {
    if (this.used + bytes > this.limit) {
      throw new RpcError(
        AppsErrorCodes.UploadTooLarge,
        'The bridge is already holding as much upload data as it allows. Wait for other installs to finish.',
      );
    }
    this.used += bytes;
    let freed = false;
    return () => {
      if (freed) return;
      freed = true;
      this.used -= bytes;
    };
  }

  get inUse() {
    return this.used;
  }
}

/** Shared by every connection to this bridge. */
export const bridgeUploadBudget = new UploadBudget();

interface Upload {
  name: string;
  size: number;
  chunks: Buffer[];
  received: number;
  free: () => void;
}

/**
 * Files sent from the browser, held in memory for one WebSocket connection only. Nothing is written to disk;
 * everything is dropped when used, discarded, or the connection closes. Memory grows as chunks arrive.
 */
export class UploadStore {
  private uploads = new Map<string, Upload>();

  constructor(private readonly budget: UploadBudget = bridgeUploadBudget) {}

  begin(name: string, size: number): string {
    const free = this.budget.reserve(size);
    const id = randomUUID();
    this.uploads.set(id, { name, size, chunks: [], received: 0, free });
    return id;
  }

  /** Chunks must arrive in order. Returns bytes received so far. */
  chunk(id: string, offset: number, base64: string): number {
    const u = this.get(id);
    if (offset !== u.received) {
      throw new RpcError('bad_request', `Expected the chunk at offset ${u.received}, got ${offset}.`);
    }
    const bytes = Buffer.from(base64, 'base64');
    if (offset + bytes.length > u.size) {
      throw new RpcError(AppsErrorCodes.UploadTooLarge, 'The upload is larger than announced.');
    }
    u.chunks.push(bytes);
    u.received += bytes.length;
    return u.received;
  }

  /**
   * Take a finished upload out of the store. Its share of the budget stays reserved until the caller
   * calls `done()` (after the install that uses it).
   */
  take(id: string): { name: string; data: Buffer; done: () => void } {
    const u = this.get(id);
    if (u.received !== u.size) {
      throw new RpcError(AppsErrorCodes.UploadIncomplete, `The upload is incomplete (${u.received} of ${u.size} bytes).`);
    }
    this.uploads.delete(id);
    const data = Buffer.concat(u.chunks, u.size);
    u.chunks = [];
    return { name: u.name, data, done: u.free };
  }

  discard(id: string) {
    const u = this.uploads.get(id);
    if (!u) return;
    this.uploads.delete(id);
    u.free();
  }

  clear() {
    for (const id of [...this.uploads.keys()]) this.discard(id);
  }

  private get(id: string): Upload {
    const u = this.uploads.get(id);
    if (!u) throw new RpcError(AppsErrorCodes.UploadNotFound, 'That upload does not exist on the bridge (it may have expired).');
    return u;
  }
}
