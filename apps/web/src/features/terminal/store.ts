import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SHELL_EXIT_EVENT, SHELL_OUTPUT_EVENT, ShellExit, ShellOutput, type DeviceTarget } from '@lgdm/protocol';
import type { BridgeClient } from '../../bridge/client';
import { describeError } from '../../components/ErrorAlert';

/**
 * Open terminals, kept outside React so tabs (and their scrollback) survive moving between pages — the
 * original keeps shells in its backend for the same reason (TerminalComponent / RemoteShellService). The bridge
 * still closes them when this tab disconnects or reloads.
 */

export type TabState = 'connecting' | 'open' | 'exited' | 'failed' | 'disconnected';

/** One command in a shell without a PTY (CommandLog in the original's DumbComponent). */
export interface DumbEntry {
  id: string;
  input: string;
  output: string;
  status?: number;
}

export interface Tab {
  key: string;
  deviceId: string;
  deviceName: string;
  device: DeviceTarget;
  title: string;
  state: TabState;
  /** Why it ended, for the banner. */
  note?: string;
  shellId?: string;
  pty: boolean;
  client: BridgeClient;
  /** xterm host element, moved into the page while it is shown. */
  host: HTMLDivElement;
  term?: Terminal;
  fit?: FitAddon;
  dumb: DumbEntry[];
}

const decoder = () => new TextDecoder('utf-8');

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** xterm colours from the theme's CSS variables (see _tokens.scss → --term-*). */
export function terminalTheme(): ITheme {
  const v = (n: string) => cssVar(`--term-${n}`) || undefined;
  return {
    background: cssVar('--bg-card'),
    foreground: cssVar('--t-base'),
    cursor: cssVar('--primary'),
    cursorAccent: cssVar('--bg-card'),
    selectionBackground: cssVar('--primary-ring'),
    black: v('black'),
    red: v('red'),
    green: v('green'),
    yellow: v('yellow'),
    blue: v('blue'),
    magenta: v('magenta'),
    cyan: v('cyan'),
    white: v('white'),
    brightBlack: v('bright-black'),
    brightRed: v('bright-red'),
    brightGreen: v('bright-green'),
    brightYellow: v('bright-yellow'),
    brightBlue: v('bright-blue'),
    brightMagenta: v('bright-magenta'),
    brightCyan: v('bright-cyan'),
    brightWhite: v('bright-white'),
  };
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

class TerminalStore {
  private tabs: Tab[] = [];
  private activeKey: string | null = null;
  private version = 0;
  private listeners = new Set<() => void>();
  /** Event subscriptions per bridge client. */
  private wired = new WeakMap<BridgeClient, () => void>();
  private decoders = new Map<string, TextDecoder>();
  private themeObserver?: MutationObserver;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.version;

  get list(): readonly Tab[] {
    return this.tabs;
  }
  get active(): Tab | null {
    return this.tabs.find((t) => t.key === this.activeKey) ?? this.tabs[0] ?? null;
  }

  private changed() {
    this.version++;
    this.listeners.forEach((fn) => fn());
  }

  activate(key: string) {
    this.activeKey = key;
    this.changed();
  }

  /** Watch the page theme so open terminals switch colours with it. */
  private watchTheme() {
    if (this.themeObserver) return;
    this.themeObserver = new MutationObserver(() => {
      const theme = terminalTheme();
      for (const t of this.tabs) if (t.term) t.term.options.theme = theme;
    });
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  private wire(client: BridgeClient) {
    if (this.wired.has(client)) return;
    const offOut = client.on(SHELL_OUTPUT_EVENT, (data) => {
      const p = ShellOutput.safeParse(data);
      if (!p.success) return;
      const tab = this.tabs.find((t) => t.shellId === p.data.shellId);
      if (!tab) return;
      const bytes = fromBase64(p.data.data);
      if (tab.term) {
        // Acknowledge once drawn, so the bridge keeps sending (flow control, see shell.ack).
        tab.term.write(bytes, () => this.ack(tab, bytes.length));
        return;
      }
      this.ack(tab, bytes.length);
      let dec = this.decoders.get(tab.key);
      if (!dec) this.decoders.set(tab.key, (dec = decoder()));
      this.dumbReceive(tab, dec.decode(bytes, { stream: true }));
    });
    const offExit = client.on(SHELL_EXIT_EVENT, (data) => {
      const p = ShellExit.safeParse(data);
      if (!p.success) return;
      const tab = this.tabs.find((t) => t.shellId === p.data.shellId);
      if (!tab) return;
      tab.state = p.data.error ? 'disconnected' : 'exited';
      tab.note = p.data.error ?? (typeof p.data.code === 'number' ? `The shell exited with code ${p.data.code}.` : 'The shell ended.');
      tab.term?.write(`\r\n\x1b[2m[${tab.note}]\x1b[0m\r\n`);
      this.changed();
    });
    this.wired.set(client, () => {
      offOut();
      offExit();
    });
  }

  private acks = new Map<string, { bytes: number; timer?: ReturnType<typeof setTimeout> }>();
  private ack(tab: Tab, bytes: number) {
    let a = this.acks.get(tab.key);
    if (!a) this.acks.set(tab.key, (a = { bytes: 0 }));
    a.bytes += bytes;
    const send = () => {
      clearTimeout(a.timer);
      a.timer = undefined;
      if (!a.bytes || !tab.shellId) return;
      const n = a.bytes;
      a.bytes = 0;
      tab.client.call('shell.ack', { shellId: tab.shellId, bytes: n }).catch(() => {});
    };
    if (a.bytes >= 128 * 1024) send();
    else a.timer ??= setTimeout(send, 50);
  }

  /** Output of a shell without a PTY: split at our end-of-command marker (DumbComponent.received). */
  private dumbReceive(tab: Tab, text: string) {
    const last = tab.dumb[tab.dumb.length - 1];
    if (!last || last.status !== undefined) return;
    const all = last.output + text;
    // Wait for the whole marker line: it may arrive split across chunks.
    const m = new RegExp(`command-${last.id}:(\\d+)\\r?\\n`).exec(all);
    if (m) {
      last.status = Number(m[1]);
      last.output = all.slice(0, m.index);
    } else {
      last.output = all.slice(-256 * 1024);
    }
    tab.dumb = [...tab.dumb];
    this.changed();
  }

  /** Open a new tab on `device`. `size` is the space the page has for it. */
  async open(client: BridgeClient, opts: { deviceId: string; deviceName: string; device: DeviceTarget; rows: number; cols: number; pty?: boolean }) {
    this.watchTheme();
    this.wire(client);
    const host = document.createElement('div');
    host.className = 'term-host';
    const tab: Tab = {
      key: crypto.randomUUID(),
      deviceId: opts.deviceId,
      deviceName: opts.deviceName,
      device: opts.device,
      title: opts.deviceName,
      state: 'connecting',
      pty: opts.pty !== false,
      client,
      host,
      dumb: [],
    };
    this.tabs = [...this.tabs, tab];
    this.activeKey = tab.key;
    this.changed();
    await this.start(tab, opts.rows, opts.cols);
    return tab;
  }

  private async start(tab: Tab, rows: number, cols: number) {
    tab.state = 'connecting';
    tab.note = undefined;
    this.changed();
    try {
      const r = await tab.client.call('shell.open', { device: tab.device, rows, cols, pty: tab.pty }, 40_000);
      if (!this.tabs.includes(tab)) {
        tab.client.call('shell.close', { shellId: r.shellId }).catch(() => {});
        return;
      }
      tab.shellId = r.shellId;
      tab.pty = r.pty;
      tab.title = r.title;
      tab.state = 'open';
      if (r.pty) this.attachTerm(tab, rows, cols);
      else tab.dumb = [];
    } catch (e) {
      tab.state = 'failed';
      tab.note = describeError(e).message;
    }
    this.changed();
  }

  private attachTerm(tab: Tab, rows: number, cols: number) {
    if (tab.term) {
      // Reconnected: keep the old scrollback above the new session.
      tab.term.resize(cols, rows);
      return;
    }
    const term = new Terminal({
      rows,
      cols,
      scrollback: 5000,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: false,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener,noreferrer')));
    term.open(tab.host);
    // Copy with Ctrl+Shift+C (Ctrl+C goes to the shell), like the original's PtyComponent.sendKey.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c') {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }
      return true;
    });
    term.onData((data) => this.write(tab, data));
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    term.onResize(({ rows: r, cols: c }) => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (tab.shellId && tab.state === 'open') tab.client.call('shell.resize', { shellId: tab.shellId, rows: r, cols: c }).catch(() => {});
      }, 120);
    });
    term.onTitleChange((title) => {
      if (title) {
        tab.title = title;
        this.changed();
      }
    });
    tab.term = term;
    tab.fit = fit;
  }

  write(tab: Tab, data: string) {
    if (tab.state !== 'open' || !tab.shellId) return;
    tab.client.call('shell.write', { shellId: tab.shellId, data }).catch(() => {});
  }

  /** Run one command in a shell without a PTY, with an end marker that carries the exit code. */
  sendDumb(tab: Tab, command: string) {
    const c = command.trim();
    if (!c || tab.state !== 'open') return;
    const id = crypto.randomUUID().slice(0, 8);
    tab.dumb = [...tab.dumb.slice(-199), { id, input: c, output: '' }];
    this.changed();
    // The marker on its own line, so `&` or a trailing `# comment` in the command can't swallow it.
    this.write(tab, `${c}\necho command-${id}:$?\n`);
  }

  /** Start a fresh shell in an ended tab, keeping what's on screen. */
  async restart(tab: Tab, client: BridgeClient) {
    tab.client = client;
    this.wire(client);
    tab.shellId = undefined;
    const rows = tab.term?.rows ?? 24;
    const cols = tab.term?.cols ?? 80;
    tab.term?.write('\r\n\x1b[2m[Reconnecting…]\x1b[0m\r\n');
    await this.start(tab, rows, cols);
  }

  /** Mark tabs that belong to an old bridge connection as disconnected. */
  markDisconnected(current: BridgeClient | null) {
    let any = false;
    for (const t of this.tabs) {
      if (t.client !== current && (t.state === 'open' || t.state === 'connecting')) {
        t.state = 'disconnected';
        t.note = 'The connection to the bridge was lost.';
        t.term?.write(`\r\n\x1b[2m[${t.note}]\x1b[0m\r\n`);
        any = true;
      }
    }
    if (any) this.changed();
  }

  close(key: string) {
    const i = this.tabs.findIndex((t) => t.key === key);
    if (i < 0) return;
    const tab = this.tabs[i]!;
    if (tab.shellId && (tab.state === 'open' || tab.state === 'connecting')) {
      tab.client.call('shell.close', { shellId: tab.shellId }).catch(() => {});
    }
    tab.term?.dispose();
    tab.host.remove();
    this.decoders.delete(tab.key);
    clearTimeout(this.acks.get(tab.key)?.timer);
    this.acks.delete(tab.key);
    this.tabs = this.tabs.filter((t) => t !== tab);
    if (this.activeKey === key) this.activeKey = this.tabs[Math.max(0, i - 1)]?.key ?? null;
    this.changed();
  }
}

export const terminals = new TerminalStore();
