import type { CmdLog } from '@lgdm/protocol';

/** One line in the console: a command the bridge ran for this tab, or one the user typed. */
export interface ConsoleEntry {
  id: string;
  source: 'bridge' | 'manual';
  target: string;
  command: string;
  kind: CmdLog['kind'];
  quiet: boolean;
  startedAt: number;
  durationMs?: number;
  exitCode?: number | null;
  output: string;
  error?: string;
  running: boolean;
  cancelled?: boolean;
}

/** Keeps the console bounded; old entries fall off the top. */
const MAX_ENTRIES = 400;
const MAX_MANUAL_OUTPUT = 256 * 1024;

/**
 * In-memory console history for this tab (never saved: commands and output can be sensitive). A tiny external
 * store so the dock and the listener can share it without re-rendering the whole app.
 */
class ConsoleStore {
  private entries: ConsoleEntry[] = [];
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.entries;

  private set(next: ConsoleEntry[]) {
    this.entries = next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
    this.listeners.forEach((fn) => fn());
  }

  private update(id: string, patch: (e: ConsoleEntry) => Partial<ConsoleEntry>) {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i < 0) return;
    const next = this.entries.slice();
    next[i] = { ...next[i]!, ...patch(next[i]!) };
    this.set(next);
  }

  /** A `cmd.log` event from the bridge. */
  log(e: CmdLog) {
    if (e.phase === 'start') {
      this.set([
        ...this.entries,
        { id: e.id, source: 'bridge', target: e.target, command: e.command, kind: e.kind, quiet: !!e.quiet, startedAt: e.at, output: '', running: true },
      ]);
    } else {
      this.update(e.id, () => ({ running: false, durationMs: e.durationMs, exitCode: e.exitCode, output: e.output ?? '', error: e.error }));
    }
  }

  startManual(id: string, target: string, command: string) {
    this.set([...this.entries, { id, source: 'manual', target, command, kind: 'stream', quiet: false, startedAt: Date.now(), output: '', running: true }]);
  }

  appendManual(id: string, data: string) {
    this.update(id, (e) => ({ output: (e.output + data).slice(-MAX_MANUAL_OUTPUT) }));
  }

  finishManual(id: string, r: { exitCode?: number | null; cancelled?: boolean; error?: string }) {
    this.update(id, (e) => ({ running: false, durationMs: Date.now() - e.startedAt, ...r }));
  }

  clear() {
    this.set(this.entries.filter((e) => e.running));
  }
}

export const consoleStore = new ConsoleStore();
