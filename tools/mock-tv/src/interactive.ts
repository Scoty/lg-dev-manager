import { posix } from 'node:path';
import type { ServerChannel } from 'ssh2';
import { runCommand } from './shell.js';
import { statPath } from './fs.js';
import type { MockState } from './state.js';

/**
 * A tiny interactive shell for SSH `shell` sessions, behaving like busybox ash on webOS:
 *  - with a PTY: echoes keystrokes, handles backspace, Ctrl-C, Ctrl-D, shows a prompt, CRLF line endings;
 *  - without one (the "dumb" shell): no echo or prompt, reads newline-terminated commands, stderr separate.
 * Commands run through runCommand, plus `cd`, `pwd`, `exit`, `stty size` and `;`-separated lists with `$?`.
 */
export interface PtyInfo {
  rows: number;
  cols: number;
  term: string;
}

export function runInteractive(stream: ServerChannel, state: MockState, pty: PtyInfo | null) {
  let cwd = state.username === 'root' ? '/home/root' : '/media/developer';
  let line = '';
  let last = 0;
  let closed = false;
  const nl = pty ? '\r\n' : '\n';
  const out = (s: string | Buffer) => {
    if (closed || !stream.writable) return;
    if (!pty) return void stream.write(s);
    stream.write(typeof s === 'string' ? s.replace(/\r?\n/g, '\r\n') : Buffer.from(s.toString('utf8').replace(/\r?\n/g, '\r\n')));
  };
  const err = (s: string) => {
    if (closed || !stream.writable) return;
    if (pty) out(s);
    else stream.stderr.write(s);
  };
  const prompt = () => pty && out(`${state.username}@LGwebOSTV:${cwd}${state.username === 'root' ? '#' : '$'} `);
  const exit = (code: number) => {
    if (closed) return;
    closed = true;
    stream.exit(code);
    stream.end();
  };

  const runOne = (cmd: string): number | 'exit' => {
    const c = cmd.trim().replace(/\$\?/g, String(last));
    if (!c) return last;
    const [bin, ...args] = c.split(/\s+/);
    if (bin === 'exit') return 'exit';
    if (bin === 'pwd') return out(`${cwd}\n`), 0;
    if (bin === 'cd') {
      const target = posix.resolve(cwd, args[0] ?? (state.username === 'root' ? '/home/root' : '/media/developer'));
      if (statPath(state, target, true)?.type !== 'd') return err(`sh: cd: can't cd to ${args[0]}: No such file or directory\n`), 2;
      cwd = target;
      return 0;
    }
    const seq = /^seq (\d+) (\d+)$/.exec(c);
    if (seq) {
      const lines: string[] = [];
      for (let i = Number(seq[1]); i <= Number(seq[2]); i++) lines.push(String(i));
      return out(`${lines.join('\n')}\n`), 0;
    }
    if (c === 'stty size') return pty ? (out(`${pty.rows} ${pty.cols}\n`), 0) : (err('stty: standard input: Not a tty\n'), 1);
    const res = runCommand(c, { state, stdin: Buffer.alloc(0) });
    if (res.code === -1) return 0;
    if (res.stdout.length) out(res.stdout);
    if (res.stderr) err(res.stderr);
    return res.code;
  };

  const run = (input: string) => {
    for (const part of input.split(';')) {
      const r = runOne(part);
      if (r === 'exit') return exit(last);
      last = r;
    }
    prompt();
  };

  stream.on('data', (chunk: Buffer) => {
    for (const ch of chunk.toString('utf8')) {
      if (closed) return;
      if (!pty) {
        if (ch === '\n') {
          const l = line;
          line = '';
          run(l);
        } else line += ch;
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        out(nl);
        const l = line;
        line = '';
        run(l);
      } else if (ch === '\x7f' || ch === '\b') {
        if (line) {
          line = line.slice(0, -1);
          out('\b \b');
        }
      } else if (ch === '\x03') {
        line = '';
        out(`^C${nl}`);
        last = 130;
        prompt();
      } else if (ch === '\x04') {
        if (!line) {
          out(`logout${nl}`);
          exit(0);
        }
      } else if (ch >= ' ' || ch === '\t') {
        line += ch;
        out(ch);
      }
    }
  });
  stream.on('end', () => exit(last));
  if (pty) {
    out(`\nBusyBox v1.36.1 (mock) built-in shell (ash)\n\n`);
    prompt();
  }
  return {
    resize(rows: number, cols: number) {
      if (pty) Object.assign(pty, { rows, cols });
    },
  };
}
