import { useCallback } from 'react';
import {
  OP_PROGRESS_EVENT,
  OpProgress,
  type MethodName,
  type ParamsOf,
  type ResultOf,
} from '@lgdm/protocol';
import { useBridge } from './BridgeProvider';
import { BridgeError, type BridgeClient } from './client';

/** Typed bridge calls for components. `ready` is false until the bridge is paired and connected. */
export function useRpc() {
  const { client, status } = useBridge();
  const ready = status.state === 'connected' && !!client;
  const call = useCallback(
    <M extends MethodName>(method: M, params: ParamsOf<M>, timeoutMs?: number): Promise<ResultOf<M>> => {
      if (!client) return Promise.reject(new BridgeError('disconnected', 'The bridge is not connected.'));
      return client.call(method, params, timeoutMs);
    },
    [client],
  );
  return { ready, call, client };
}

/** Listen to `op.progress` for one operation id. Returns the unsubscribe function. */
export function onOpProgress(client: BridgeClient, opId: string, fn: (p: OpProgress) => void): () => void {
  return client.on(OP_PROGRESS_EVENT, (data) => {
    const p = OpProgress.safeParse(data);
    if (p.success && p.data.opId === opId) fn(p.data);
  });
}

export const newOpId = () => crypto.randomUUID();

/** 1 MiB per chunk: ~1.4 MB per frame after base64, well under the bridge's 16 MB frame limit. */
const CHUNK = 1024 * 1024;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    r.onerror = () => reject(r.error ?? new Error('Could not read the file.'));
    r.readAsDataURL(blob);
  });
}

/**
 * Send a local file to the bridge's memory in chunks (upload.*). Returns the upload id to pass to
 * e.g. apps.install. The file never goes anywhere but the paired bridge.
 */
export async function uploadToBridge(
  client: BridgeClient,
  file: File,
  onProgress?: (sent: number, total: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const { uploadId } = await client.call('upload.begin', { name: file.name, size: file.size });
  try {
    for (let offset = 0; offset < file.size; offset += CHUNK) {
      if (signal?.aborted) throw new BridgeError('cancelled', 'Cancelled.');
      const data = await blobToBase64(file.slice(offset, offset + CHUNK));
      await client.call('upload.chunk', { uploadId, offset, data }, 60_000);
      onProgress?.(Math.min(file.size, offset + CHUNK), file.size);
    }
    return uploadId;
  } catch (e) {
    client.call('upload.discard', { uploadId }).catch(() => {});
    throw e;
  }
}
