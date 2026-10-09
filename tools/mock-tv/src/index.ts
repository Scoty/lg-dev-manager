import { generateKeyPairSync, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer, type AddressInfo, type Server as NetServer } from 'node:net';
import ssh2 from 'ssh2';
import { WebSocketServer } from 'ws';
import { isSubscription, runCommand, runSubscription } from './shell.js';
import { serveSftp } from './sftp.js';
import { createState, type MockApp, type MockState } from './state.js';

// ssh2 is CommonJS: use the default export under native Node ESM.
const { Server: SshServer, utils } = ssh2;

export { runCommand, unquote } from './shell.js';
export { LUNA, SUBSCRIPTIONS } from './luna.js';
export { MOCK_APPS, devApp, fakeIpk, makeIconPng, type MockApp, type MockState } from './state.js';

export interface MockTvOptions {
  /** `prisoner` (Dev Mode) or `root` (rooted). */
  username?: string;
  /** Allow password login with this password (rooted TVs often have one). */
  password?: string;
  /** Passphrase protecting the Dev Mode key served on the key server. */
  passphrase?: string;
  host?: string;
  sshPort?: number;
  keyServerPort?: number;
  /** Serve the SFTP subsystem (default true). False makes the bridge fall back to `cat` over exec. */
  sftp?: boolean;
  /** Homebrew Channel installed: its luna service answers and installs IPKs from a URL. */
  hbchannel?: boolean;
  /** Allow SSH remote port forwarding (default true) — used to serve IPKs to Homebrew Channel. */
  forwarding?: boolean;
  /** Apps present at start (default MOCK_APPS). */
  apps?: MockApp[];
  /** Also listen on this port like webOS's second-screen service (3000), so network scans find the TV. */
  ssapPort?: number;
}

export interface MockTv {
  host: string;
  sshPort: number;
  keyServerPort: number;
  username: string;
  password?: string;
  passphrase: string;
  /** Encrypted PEM exactly as the key server serves it. */
  privateKey: string;
  /** Live state (apps, files, launches) for assertions. */
  state: MockState;
  /** Port of the second-screen stand-in, if started. */
  ssapPort?: number;
  /** Extra public keys (OpenSSH line) accepted for login, e.g. an app-generated key. */
  authorize(publicKeyLine: string): void;
  close(): Promise<void>;
}

const pem = (cipher?: string, passphrase?: string) =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: cipher
      ? { type: 'pkcs1', format: 'pem', cipher, passphrase: passphrase! }
      : { type: 'pkcs1', format: 'pem' },
  });

const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/** Start a fake TV: an SSH server answering luna-send and the shell commands the bridge uses, plus a key server. */
export async function startMockTv(opts: MockTvOptions = {}): Promise<MockTv> {
  const host = opts.host ?? '127.0.0.1';
  const username = opts.username ?? 'prisoner';
  const passphrase = opts.passphrase ?? 'A1B2C3';
  const state = createState({ username, hbchannel: opts.hbchannel, apps: opts.apps });
  const hostKey = pem().privateKey;
  // Dev Mode keys are passphrase-protected traditional PEM ("Proc-Type: 4,ENCRYPTED").
  const { privateKey } = pem('aes-128-cbc', passphrase);
  const parsedUserKey = utils.parseKey(privateKey, passphrase);
  if (parsedUserKey instanceof Error) throw parsedUserKey;
  const allowed = [Array.isArray(parsedUserKey) ? parsedUserKey[0]! : parsedUserKey];

  const forwards = new Set<NetServer>();

  // webOS's SSH servers (Dev Mode and Homebrew Channel) are dropbear; the network scan looks for that banner.
  const ssh = new SshServer({ hostKeys: [hostKey], ident: 'dropbear_2022.83' }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.username !== username) return ctx.reject();
      if (ctx.method === 'publickey') {
        const key = allowed.find((k) => same(ctx.key.data, k.getPublicSSH()));
        if (key) {
          if (!ctx.signature) return ctx.accept(); // key probe
          if (key.verify(ctx.blob!, ctx.signature, ctx.hashAlgo)) return ctx.accept();
        }
        return ctx.reject();
      }
      if (ctx.method === 'password' && opts.password !== undefined && ctx.password === opts.password) return ctx.accept();
      return ctx.reject(opts.password !== undefined ? ['publickey', 'password'] : ['publickey']);
    });

    client.on('ready', () => {
      // Remote port forwarding: listen on the "TV's" loopback and tunnel connections back to the client.
      client.on('request', (accept, reject, name, info) => {
        if (name !== 'tcpip-forward' || opts.forwarding === false) return reject?.();
        const { bindAddr, bindPort } = info as { bindAddr: string; bindPort: number };
        const srv = createNetServer((sock) => {
          client.forwardOut(bindAddr, (srv.address() as AddressInfo).port, sock.remoteAddress ?? '127.0.0.1', sock.remotePort ?? 0, (err, ch) => {
            if (err) return sock.destroy();
            sock.pipe(ch).pipe(sock);
            ch.on('close', () => sock.destroy());
            sock.on('error', () => ch.close());
          });
        });
        srv.listen(bindPort, '127.0.0.1', () => {
          forwards.add(srv);
          accept?.((srv.address() as AddressInfo).port);
        });
        client.once('close', () => {
          srv.close();
          forwards.delete(srv);
        });
      });

      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('sftp', (acceptSftp, rejectSftp) => {
          if (opts.sftp === false) return rejectSftp();
          serveSftp(acceptSftp(), state);
        });
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          if (isSubscription(info.command)) {
            const ac = new AbortController();
            stream.on('close', () => ac.abort());
            stream.on('data', () => {});
            runSubscription(info.command, state, (line) => stream.writable && stream.write(line), ac.signal).then((res) => {
              if (res.stderr && stream.writable) stream.stderr.write(res.stderr);
              if (stream.writable) {
                stream.exit(res.code);
                stream.end();
              }
            });
            return;
          }
          const stdin: Buffer[] = [];
          stream.on('data', (c: Buffer) => stdin.push(c));
          stream.on('end', () => {
            const res = runCommand(info.command, { state, stdin: Buffer.concat(stdin) });
            if (res.code === -1) return; // hang
            if (res.stdout.length) stream.write(res.stdout);
            if (res.stderr) stream.stderr.write(res.stderr);
            stream.exit(res.code);
            stream.end();
          });
        });
      });
    });
    client.on('error', () => {});
  });

  // Key server: redirect once, like some firmware does, then serve the key.
  const keySrv: HttpServer = createHttpServer((req, res) => {
    if (req.url === '/webos_rsa') {
      res.writeHead(302, { Location: '/keys/webos_rsa' }).end();
    } else if (req.url === '/keys/webos_rsa') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(privateKey);
    } else {
      res.writeHead(404).end();
    }
  });

  const listen = (srv: { listen: (port: number, host: string, cb: () => void) => unknown; address: () => unknown }, port: number) =>
    new Promise<number>((resolve) => srv.listen(port, host, () => resolve((srv.address() as AddressInfo).port)));

  const sshPort = await listen(ssh as never, opts.sshPort ?? 0);
  const keyServerPort = await listen(keySrv, opts.keyServerPort ?? 0);
  // Second-screen stand-in: a WebSocket that answers unpaired requests the way webOS's SSAP service does.
  const ssap = opts.ssapPort === undefined ? null : createHttpServer((_req, res) => res.writeHead(426).end());
  if (ssap) {
    const wss = new WebSocketServer({ server: ssap });
    wss.on('connection', (sock) => {
      sock.on('error', () => {}); // scanners hang up abruptly
      sock.on('message', (raw) => {
        let id: unknown;
        try {
          id = (JSON.parse(raw.toString()) as { id?: unknown }).id;
        } catch {
          /* not JSON */
        }
        sock.send(JSON.stringify({ type: 'error', id, error: '401 insufficient permissions (not registered)', payload: {} }));
      });
    });
  }
  const ssapPort = ssap ? await listen(ssap, opts.ssapPort!) : undefined;

  return {
    host,
    sshPort,
    keyServerPort,
    username,
    password: opts.password,
    passphrase,
    privateKey,
    state,
    ssapPort,
    authorize(line: string) {
      const k = utils.parseKey(line);
      if (k instanceof Error) throw k;
      allowed.push(Array.isArray(k) ? k[0]! : k);
    },
    close: () => {
      for (const f of forwards) f.close();
      ssap?.close();
      return Promise.all([
        new Promise<void>((r) => ssh.close(() => r())),
        new Promise<void>((r) => keySrv.close(() => r())),
      ]).then(() => undefined);
    },
  };
}
