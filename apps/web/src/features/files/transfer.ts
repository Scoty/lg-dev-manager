import { MAX_READ_CHUNK, READ_BLOCK, type DeviceTarget } from '@lgdm/protocol';
import type { BridgeClient } from '../../bridge/client';
import { BridgeError } from '../../bridge/client';

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Read a file from the TV through the bridge in 4 MiB chunks (files.read) — the original's file::get, but into
 * the browser's memory. Stops after `limit` bytes when given.
 */
export async function readRemoteFile(
  client: BridgeClient,
  device: DeviceTarget,
  path: string,
  opts: { size?: number; limit?: number; onProgress?: (got: number) => void; signal?: AbortSignal } = {},
): Promise<{ parts: Uint8Array<ArrayBuffer>[]; size: number; truncated: boolean }> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  const limit = opts.limit ?? Infinity;
  for (;;) {
    if (opts.signal?.aborted) throw new BridgeError('cancelled', 'Cancelled.');
    // Whole 64 KiB blocks (the dd fallback needs them), no more than the limit still wants.
    const remaining = limit - offset;
    const length = Number.isFinite(remaining) ? Math.min(MAX_READ_CHUNK, Math.max(READ_BLOCK, Math.ceil(remaining / READ_BLOCK) * READ_BLOCK)) : MAX_READ_CHUNK;
    const r = await client.call('files.read', { device, path, offset, length }, 120_000);
    const bytes = fromBase64(r.data);
    parts.push(bytes);
    offset += bytes.length;
    opts.onProgress?.(offset);
    if (r.eof || bytes.length === 0) return { parts, size: offset, truncated: false };
    if (offset >= limit) return { parts, size: offset, truncated: true };
  }
}

/** Hand a Blob to the browser as a download. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
