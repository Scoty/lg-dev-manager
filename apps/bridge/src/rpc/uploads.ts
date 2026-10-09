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
  /** Allocated at the first chunk and filled in place (no second copy when the upload is taken). */
  data?: Buffer;
  received: number;
  free: () => void;
  timer?: NodeJS.Timeout;
}

/** Unfinished uploads one connection may have open at once. */
export const MAX_PENDING_UPLOADS = 4;
/** An upload that gets no chunk for this long is dropped, and its share of the budget freed. */
export const UPLOAD_IDLE_MS = 2 * 60_000;

/**
 * Files sent from the browser, held in memory for one WebSocket connection only. Nothing is written to disk;
 * everything is dropped when used, discarded, or the connection closes. Memory grows as chunks arrive.
 */
export class UploadStore {
  private uploads = new Map<string, Upload>();

  constructor(
    private readonly budget: UploadBudget = bridgeUploadBudget,
    private readonly idleMs = UPLOAD_IDLE_MS,
  ) {}

  begin(name: string, size: number): string {
    if (this.uploads.size >= MAX_PENDING_UPLOADS) {
      throw new RpcError(AppsErrorCodes.UploadTooLarge, `At most ${MAX_PENDING_UPLOADS} uploads can be in progress at once.`);
    }
    const free = this.budget.reserve(size);
    const id = randomUUID();
    const u: Upload = { name, size, received: 0, free };
    this.uploads.set(id, u);
    this.touch(id, u);
    return id;
  }

  private touch(id: string, u: Upload) {
    clearTimeout(u.timer);
    u.timer = setTimeout(() => this.discard(id), this.idleMs);
    u.timer.unref();
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
    u.data ??= Buffer.allocUnsafe(u.size);
    bytes.copy(u.data, offset);
    u.received += bytes.length;
    this.touch(id, u);
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
    clearTimeout(u.timer);
    const data = u.data ?? Buffer.alloc(0);
    u.data = undefined;
    return { name: u.name, data, done: u.free };
  }

  discard(id: string) {
    const u = this.uploads.get(id);
    if (!u) return;
    this.uploads.delete(id);
    clearTimeout(u.timer);
    u.data = undefined;
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
