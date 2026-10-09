import { handleLuna } from './luna.js';

export interface CommandResult {
  stdout: string;
  stderr?: string;
  code: number;
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

/** A tiny fake of the commands dev-manager runs on a TV. Unknown commands exit 127 like sh. */
export function runCommand(command: string, ctx: { username: string; stdin: string }): CommandResult {
  const luna = /^(luna-send(?:-pub)?) -n 1 (luna:\/\/\S+)\s*(.*)$/s.exec(command);
  if (luna) {
    const [, cmd, uri, rest] = luna;
    if (cmd === 'luna-send' && ctx.username !== 'root') {
      return { stdout: '', stderr: 'luna-send: permission denied\n', code: 1 };
    }
    let params: Record<string, unknown> = {};
    try {
      params = rest ? JSON.parse(unquote(rest)) : {};
    } catch {
      return { stdout: '', stderr: 'invalid JSON\n', code: 1 };
    }
    return { stdout: `${JSON.stringify(handleLuna(uri!, params))}\n`, code: 0 };
  }
  if (command === 'id -u') return { stdout: ctx.username === 'root' ? '0\n' : '1000\n', code: 0 };
  if (command.startsWith('echo ')) return { stdout: `${unquote(command.slice(5))}\n`, code: 0 };
  if (command === 'cat') return { stdout: ctx.stdin, code: 0 };
  if (command === 'false') return { stdout: '', code: 1 };
  if (command.startsWith('sleep ')) return { stdout: '', code: -1 }; // never finishes (for timeout tests)
  const bin = command.split(/\s+/)[0];
  return { stdout: '', stderr: `sh: ${bin}: not found\n`, code: 127 };
}
