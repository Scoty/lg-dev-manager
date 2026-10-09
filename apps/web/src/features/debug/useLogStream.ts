import { useCallback, useEffect, useRef, useState } from 'react';
import { LOG_LINES_EVENT, LogLines, type LogSource } from '@lgdm/protocol';
import { newOpId, useRpc } from '../../bridge/useRpc';
import { toTarget, type SavedDevice } from '../../devices/store';

export type StreamPhase = 'idle' | 'running' | 'stopped' | 'ended' | 'error';

export interface StreamState {
  phase: StreamPhase;
  error?: unknown;
  /** Lines the bridge skipped because they came too fast. */
  dropped: number;
}

/** A followed log has no natural end; the call only times out after a day. */
const DAY = 24 * 3600 * 1000;

/**
 * Follow a log on the TV (`logs.stream`). Batches of raw lines go to `onLines`; the stream stops when the component
 * unmounts, the device changes or `stop()` is called.
 */
export function useLogStream(device: SavedDevice | null, source: LogSource, onLines: (lines: string[]) => void, opts: { lines?: number } = {}) {
  const { client, ready } = useRpc();
  const [state, setState] = useState<StreamState>({ phase: 'idle', dropped: 0 });
  const current = useRef<string | null>(null);
  const onLinesRef = useRef(onLines);
  onLinesRef.current = onLines;
  const lines = opts.lines;
  // The saved TV object changes when its details refresh in the background; only a different TV restarts the stream.
  const deviceRef = useRef(device);
  deviceRef.current = device;
  const deviceId = device?.id;

  /** Unsubscribes the running stream's `logs.lines` listener. */
  const offRef = useRef<(() => void) | null>(null);

  const stop = useCallback(() => {
    const opId = current.current;
    current.current = null;
    // Stop listening now: lines the bridge still flushes for this stream must not land in the next one.
    offRef.current?.();
    offRef.current = null;
    if (opId) {
      setState((s) => (s.phase === 'running' ? { ...s, phase: 'stopped' } : s));
      if (client) client.call('logs.stop', { opId }).catch(() => {});
    }
  }, [client]);

  const start = useCallback(() => {
    const device = deviceRef.current;
    if (!client || !device || device.id !== deviceId) return;
    stop();
    const opId = newOpId();
    current.current = opId;
    setState({ phase: 'running', dropped: 0 });
    const off = client.on(LOG_LINES_EVENT, (data) => {
      const p = LogLines.safeParse(data);
      if (!p.success || p.data.opId !== opId || current.current !== opId) return;
      if (p.data.lines.length) onLinesRef.current(p.data.lines);
      if (p.data.dropped) setState((s) => ({ ...s, dropped: s.dropped + p.data.dropped! }));
    });
    offRef.current = off;
    client
      .call('logs.stream', { device: toTarget(device), source, opId, ...(lines !== undefined ? { lines } : {}) }, DAY)
      .then((r) => {
        // Only the stream on screen updates the state (a stopped one already shows "stopped").
        if (current.current === opId) setState((s) => ({ ...s, phase: r.stopped ? 'stopped' : 'ended' }));
      })
      .catch((error: unknown) => {
        if (current.current === opId) setState((s) => ({ ...s, phase: 'error', error }));
      })
      .finally(() => {
        off();
        if (offRef.current === off) offRef.current = null;
        if (current.current === opId) current.current = null;
      });
  }, [client, deviceId, source, lines, stop]);

  // Stop when leaving the page or switching TV.
  useEffect(() => () => stop(), [stop, deviceId]);

  return { state, start, stop, ready };
}
