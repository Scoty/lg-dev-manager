import { generateKeyPairSync, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import ssh2 from 'ssh2';

// ssh2 is CommonJS: use the default export under native Node ESM.
const { Server: SshServer, utils } = ssh2;
import { runCommand } from './shell.js';

export { runCommand, unquote } from './shell.js';
export { MOCK_APPS, LUNA } from './luna.js';

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

/** Start a fake TV: an SSH server answering luna-send and a few shell commands, plus a key server. */
export async function startMockTv(opts: MockTvOptions = {}): Promise<MockTv> {
  const host = opts.host ?? '127.0.0.1';
  const username = opts.username ?? 'prisoner';
  const passphrase = opts.passphrase ?? 'A1B2C3';
  const hostKey = pem().privateKey;
  // Dev Mode keys are passphrase-protected traditional PEM ("Proc-Type: 4,ENCRYPTED").
  const { privateKey } = pem('aes-128-cbc', passphrase);
  const userKey = utils.parseKey(privateKey, passphrase);
  if (userKey instanceof Error) throw userKey;
  const allowedPub = (Array.isArray(userKey) ? userKey[0] : userKey).getPublicSSH();

  const ssh = new SshServer({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.username !== username) return ctx.reject();
      if (ctx.method === 'publickey' && same(ctx.key.data, allowedPub)) {
        if (!ctx.signature) return ctx.accept(); // key probe
        const k = utils.parseKey(privateKey, passphrase);
        const key = Array.isArray(k) ? k[0] : k;
        if (key && !(key instanceof Error) && key.verify(ctx.blob!, ctx.signature, ctx.hashAlgo)) return ctx.accept();
        return ctx.reject();
      }
      if (ctx.method === 'password' && opts.password !== undefined && ctx.password === opts.password) return ctx.accept();
      return ctx.reject(opts.password !== undefined ? ['publickey', 'password'] : ['publickey']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          const stdin: Buffer[] = [];
          stream.on('data', (c: Buffer) => stdin.push(c));
          stream.on('end', () => {
            const res = runCommand(info.command, { username, stdin: Buffer.concat(stdin).toString('utf8') });
            if (res.code === -1) return; // hang
            if (res.stdout) stream.write(res.stdout);
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

  return {
    host,
    sshPort,
    keyServerPort,
    username,
    password: opts.password,
    passphrase,
    privateKey,
    close: () =>
      Promise.all([
        new Promise<void>((r) => ssh.close(() => r())),
        new Promise<void>((r) => keySrv.close(() => r())),
      ]).then(() => undefined),
  };
}
