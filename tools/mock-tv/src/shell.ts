import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { handleLuna, lunaMiss, SUBSCRIPTIONS } from './luna.js';
import { canWrite, ensureDir, type MockState } from './state.js';

export interface CommandResult {
  stdout: string | Buffer;
  stderr?: string;
  /** Exit code. -1 means "never finishes" (for timeout tests). */
  code: number;
}

export interface CommandContext {
  state: MockState;
  stdin: Buffer;
}

/** Undo POSIX single-quote escaping produced by `'a'\''b'`-style quoting. */
export function unquote(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      out += s.slice(i + 1, end === -1 ? undefined : end);
      i = end === -1 ? s.length : end + 1;
    } else if (c === '\\' && i + 1 < s.length) {
      out += s[i + 1];
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const LUNA_ONCE = /^(luna-send(?:-pub)?) -n 1 (luna:\/\/\S+)\s*(.*)$/s;
const LUNA_SUB = /^(luna-send(?:-pub)?) -i (luna:\/\/\S+)\s*(.*)$/s;
/** `<cmd> '<path>'` — the only shape the bridge uses for file commands. */
const pathArg = (cmd: string, command: string): string | null => {
  if (!command.startsWith(`${cmd} '`)) return null;
  const p = posix.normalize(unquote(command.slice(cmd.length + 1)));
  return p.startsWith('/') ? p : null;
};

function parseLuna(cmd: string, rest: string, state: MockState): { params: Record<string, unknown> } | CommandResult {
  if (cmd === 'luna-send' && state.username !== 'root') {
    return { stdout: '', stderr: 'luna-send: permission denied\n', code: 1 };
  }
  try {
    return { params: rest ? JSON.parse(unquote(rest)) : {} };
  } catch {
    return { stdout: '', stderr: 'invalid JSON\n', code: 1 };
  }
}

/** True if the command is a luna subscription, which must start before stdin closes. */
export function isSubscription(command: string): boolean {
  return LUNA_SUB.test(command);
}

/**
 * Run a `luna-send -i` subscription: each response is written as one JSON line. Ends when the handler is done
 * or `signal` aborts (the client closed the channel), like the real tool being killed.
 */
export async function runSubscription(
  command: string,
  state: MockState,
  write: (line: string) => void,
  signal: AbortSignal,
): Promise<CommandResult> {
  const [, cmd, uri, rest] = LUNA_SUB.exec(command)!;
  const parsed = parseLuna(cmd!, rest!, state);
  if (!('params' in parsed)) return parsed;
  const sub = SUBSCRIPTIONS[uri!];
  if (!sub) {
    write(`${JSON.stringify(lunaMiss(uri!))}\n`);
    return { stdout: '', code: 0 };
  }
  for await (const msg of sub(parsed.params, state, signal)) {
    if (signal.aborted) break;
    write(`${JSON.stringify(msg)}\n`);
  }
  // A real subscription stays open until killed; finished ones here just wait to be closed.
  await new Promise<void>((r) => (signal.aborted ? r() : signal.addEventListener('abort', () => r(), { once: true })));
  return { stdout: '', code: 0 };
}

/** A tiny fake of the commands the bridge runs on a TV. Unknown commands exit 127 like sh. */
export function runCommand(command: string, ctx: CommandContext): CommandResult {
  const { state } = ctx;
  const luna = LUNA_ONCE.exec(command);
  if (luna) {
    const [, cmd, uri, rest] = luna;
    const parsed = parseLuna(cmd!, rest!, state);
    if (!('params' in parsed)) return parsed;
    return { stdout: `${JSON.stringify(handleLuna(uri!, parsed.params, state))}\n`, code: 0 };
  }
  if (command === 'id -u') return { stdout: state.username === 'root' ? '0\n' : '1000\n', code: 0 };
  if (command.startsWith('echo ')) return { stdout: `${unquote(command.slice(5))}\n`, code: 0 };
  if (command === 'cat') return { stdout: ctx.stdin, code: 0 };
  if (command === 'false') return { stdout: '', code: 1 };
  if (command.startsWith('sleep ')) return { stdout: '', code: -1 };

  let p: string | null;
  if ((p = pathArg('cat >', command))) {
    if (!canWrite(state, p)) return { stdout: '', stderr: `sh: can't create ${p}: Permission denied\n`, code: 1 };
    if (!state.dirs.has(posix.dirname(p))) return { stdout: '', stderr: `sh: can't create ${p}: nonexistent directory\n`, code: 1 };
    state.files.set(p, Buffer.from(ctx.stdin));
    return { stdout: '', code: 0 };
  }
  if ((p = pathArg('cat', command))) {
    const f = state.files.get(p);
    return f ? { stdout: f, code: 0 } : { stdout: '', stderr: `cat: can't open '${p}': No such file or directory\n`, code: 1 };
  }
  if ((p = pathArg('mkdir -p', command))) {
    if (!canWrite(state, p)) return { stdout: '', stderr: `mkdir: can't create directory '${p}': Permission denied\n`, code: 1 };
    ensureDir(state, p);
    return { stdout: '', code: 0 };
  }
  if ((p = pathArg('chmod 777', command))) {
    return state.dirs.has(p) || state.files.has(p) ? { stdout: '', code: 0 } : { stdout: '', stderr: 'chmod: No such file\n', code: 1 };
  }
  if ((p = pathArg('rm -f', command))) {
    if (state.files.has(p) && !canWrite(state, p)) return { stdout: '', stderr: `rm: can't remove '${p}': Permission denied\n`, code: 1 };
    state.files.delete(p);
    return { stdout: '', code: 0 };
  }
  if ((p = pathArg('sha256sum', command))) {
    const f = state.files.get(p);
    if (!f) return { stdout: '', stderr: `sha256sum: ${p}: No such file or directory\n`, code: 1 };
    return { stdout: `${createHash('sha256').update(f).digest('hex')}  ${p}\n`, code: 0 };
  }
  if ((p = pathArg('df', command))) {
    const { total, available } = state.diskKb;
    return {
      stdout:
        'Filesystem           1K-blocks      Used Available Use% Mounted on\n' +
        `/dev/mapper/developer ${total} ${total - available} ${available} ${Math.round(((total - available) / total) * 100)}% /media/developer\n`,
      code: 0,
    };
  }
  const bin = command.split(/\s+/)[0];
  return { stdout: '', stderr: `sh: ${bin}: not found\n`, code: 127 };
}
