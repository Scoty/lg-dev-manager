import { z } from 'zod';
import { DeviceTarget, HostName } from './device';
import { AppId, AppInfo, MAX_CHUNK_BYTES, MAX_UPLOAD_BYTES } from './apps';
import { ScanResult } from './console';
import { RepoPackage, WebUrl } from './repo';
import { FileItem, FileName, MAX_READ_CHUNK, RemotePath } from './files';
import { CrashReportFile, LogSource, PmLogContext, PmLogLevel } from './debug';
import { LitefinRelease, LitefinVariant } from './litefin';

/**
 * Bumped when the wire contract changes in a way an older peer can't handle (including new methods the
 * UI depends on), so a stale bridge gets a clear "update" message instead of unknown_method errors.
 *  v2 — M3: device.info/storage/generateKey, apps.*, upload.*
 *  v3 — device.scan, checkConnection.webos, cmd.stream/cmd.cancel, cmd.log events
 *  v4 — M4: repo.list, repo.image, repo.description, apps.installFromRepo, device.hbchannel
 *  v5 — M5: files.*, shell.*, device.storage path
 *  v6 — M6: devmode.status, devmode.renew, device.screenshot
 *  v7 — M7: logs.*, pmlog.*, crashes.*
 *  v8 — M8: litefin.list, litefin.install
 */
export const PROTOCOL_VERSION = 8;

const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Not base64');

/** Default port the bridge listens on (and serves the UI from). */
export const DEFAULT_BRIDGE_PORT = 5199;

/**
 * Method registry. Each entry pairs a params schema with a result schema.
 * Add new RPCs here first, then implement them in apps/bridge and call them from apps/web.
 * Naming: `<area>.<verb>` — see AGENTS.md.
 */
export const Methods = {
  /** First message on every connection. Authenticates with the pairing token. */
  'system.hello': {
    params: z.object({
      token: z.string().min(1),
      protocolVersion: z.number().int(),
      client: z.string().optional(),
    }),
    result: z.object({
      protocolVersion: z.number().int(),
      bridgeVersion: z.string(),
      platform: z.string(),
    }),
  },
  'system.ping': {
    params: z.object({}).optional(),
    result: z.object({ now: z.number() }),
  },

  /**
   * Which of the TV's SSH (22, 9922) and Dev Mode key server (9991) ports answer, and whether it looks like a
   * webOS TV at all (LG's second-screen port 3000/3001 — open even when SSH is off).
   */
  'device.checkConnection': {
    params: z.object({ host: HostName }),
    result: z.object({ ssh22: z.boolean(), ssh9922: z.boolean(), keyServer: z.boolean(), webos: z.boolean() }),
  },
  /**
   * Look for LG TVs on the local network: SSDP discovery plus a quick port sweep of this computer's /24
   * networks. Reads nothing from the TVs beyond their public SSDP description.
   */
  'device.scan': {
    params: z.object({ timeoutMs: z.number().int().min(500).max(15_000).optional() }).optional(),
    result: z.object({ tvs: z.array(ScanResult) }),
  },
  /**
   * Fetch the Dev Mode private key from the TV's key server (port 9991) and check the passphrase
   * shown in the Developer Mode app. Errors: passphrase_required, bad_passphrase, key_not_found, key_server_unreachable.
   */
  'device.fetchKey': {
    params: z.object({ host: HostName, passphrase: z.string().max(1024).optional() }),
    result: z.object({ privateKey: z.string(), fingerprint: z.string() }),
  },
  /** Check that a private key parses with the given passphrase. */
  'device.verifyKey': {
    params: z.object({ privateKey: z.string().min(1).max(64 * 1024), passphrase: z.string().max(1024).optional() }),
    result: z.object({ fingerprint: z.string(), type: z.string() }),
  },
  /** Log in once and report who we are — used by the add-device wizard. */
  'device.test': {
    params: z.object({ device: DeviceTarget }),
    result: z.object({ latencyMs: z.number(), root: z.boolean() }),
  },
  /**
   * Model, webOS and firmware version — shown by the add-device wizard, the device list and the TV switcher.
   * Port of DeviceManagerService.getDeviceInfo. Fields the TV doesn't report are omitted.
   */
  'device.info': {
    /** `quiet`: a background read — the console lists it only under "Background reads". */
    params: z.object({ device: DeviceTarget, quiet: z.boolean().optional() }),
    result: z.object({
      modelName: z.string().optional(),
      osVersion: z.string().optional(),
      firmwareVersion: z.string().optional(),
      otaId: z.string().optional(),
      socName: z.string().optional(),
    }),
  },
  /** `df` of a folder (KiB; default the developer partition). Null if the TV gave no usable answer. */
  'device.storage': {
    params: z.object({ device: DeviceTarget, path: RemotePath.optional() }),
    result: z.object({ total: z.number(), used: z.number(), available: z.number() }).nullable(),
  },
  /**
   * Make a new ed25519 key pair for a TV (the original's "App key"). The private key goes back to the
   * browser to be saved with the device; the bridge keeps nothing.
   */
  'device.generateKey': {
    params: z.object({ comment: z.string().max(64).optional() }),
    result: z.object({ privateKey: z.string(), publicKey: z.string(), fingerprint: z.string() }),
  },
  /** Forget pooled SSH connections (all, or for one device). */
  'device.disconnect': {
    params: z.object({ device: DeviceTarget.optional() }),
    result: z.object({ closed: z.number() }),
  },

  /** Run a shell command and wait for it to finish. stdin/stdout/stderr are UTF-8 text. */
  'cmd.exec': {
    params: z.object({
      device: DeviceTarget,
      command: z.string().min(1).max(64 * 1024),
      stdin: z.string().max(4 * 1024 * 1024).optional(),
      timeoutMs: z.number().int().min(100).max(600_000).optional(),
    }),
    result: z.object({ stdout: z.string(), stderr: z.string(), exitCode: z.number().nullable() }),
  },

  /**
   * Run a command typed by the user in the console, streaming its output as `cmd.output` events (same opId).
   * Resolves when it exits; `cmd.cancel` closes it early.
   */
  'cmd.stream': {
    params: z.object({ device: DeviceTarget, command: z.string().min(1).max(8192), opId: z.string().max(64) }),
    result: z.object({ exitCode: z.number().nullable(), cancelled: z.boolean() }),
  },
  'cmd.cancel': {
    params: z.object({ opId: z.string().max(64) }),
    result: z.object({ cancelled: z.boolean() }),
  },

  /**
   * One-shot luna-send call. `public` uses luna-send-pub (works in Dev Mode); otherwise luna-send (root).
   * A `returnValue: false` response is an error (luna_error) unless `falseAsError` is false.
   */
  'luna.call': {
    params: z.object({
      device: DeviceTarget,
      uri: z.string().regex(/^luna:\/\/[\w.\-/]+$/, 'Not a luna:// URI'),
      params: z.record(z.unknown()).optional(),
      public: z.boolean().optional(),
      falseAsError: z.boolean().optional(),
    }),
    result: z.record(z.unknown()),
  },

  /** Installed apps: `applicationManager/dev/listApps`, falling back to `listApps` (app-manager.service.ts). */
  'apps.list': {
    params: z.object({ device: DeviceTarget }),
    result: z.object({ apps: z.array(AppInfo) }),
  },
  'apps.launch': {
    params: z.object({ device: DeviceTarget, id: AppId, params: z.record(z.unknown()).optional() }),
    result: z.object({}),
  },
  /** An app's icon file, for the apps list. Image files only, up to 1 MiB. */
  'apps.icon': {
    params: z.object({ device: DeviceTarget, path: RemotePath }),
    result: z.object({ mime: z.string(), base64: z.string() }),
  },
  /** Uninstall via `appInstallService/dev/remove`. Streams `op.progress` (stage `remove`). */
  'apps.remove': {
    params: z.object({ device: DeviceTarget, id: AppId, opId: z.string().max(64) }),
    result: z.object({}),
  },
  /**
   * Install an IPK previously sent with `upload.*`. Uses Homebrew Channel's installer when the TV has it
   * (served to the TV over an SSH reverse tunnel), otherwise copies it to /media/developer/temp and runs
   * `appInstallService/dev/install`. Streams `op.progress`. The upload is discarded afterwards.
   */
  'apps.install': {
    params: z.object({ device: DeviceTarget, uploadId: z.string().max(64), opId: z.string().max(64) }),
    result: z.object({ appId: z.string().optional(), via: z.enum(['devmode', 'hbchannel']) }),
  },

  /**
   * Send a file from the browser to the bridge in chunks. It is kept in the bridge's memory (never on disk),
   * belongs to this connection, and is dropped when used, discarded, or the connection closes.
   */
  'upload.begin': {
    params: z.object({ name: z.string().min(1).max(255), size: z.number().int().min(1).max(MAX_UPLOAD_BYTES) }),
    result: z.object({ uploadId: z.string() }),
  },
  'upload.chunk': {
    params: z.object({
      uploadId: z.string().max(64),
      offset: z.number().int().min(0),
      data: base64.max(Math.ceil(MAX_CHUNK_BYTES / 3) * 4),
    }),
    result: z.object({ received: z.number() }),
  },
  'upload.discard': {
    params: z.object({ uploadId: z.string().max(64) }),
    result: z.object({}),
  },

  /**
   * Developer Mode session (dev-mode plugin, src-tauri/src/plugins/devmode.rs): the session token from
   * /var/luna/preferences/devmode_enabled and the time LG's server says is left. Dev Mode logins only.
   * `remaining` is "HH:MM:SS"; absent when LG didn't answer with a time.
   */
  'devmode.status': {
    params: z.object({ device: DeviceTarget }),
    result: z.object({
      token: z.string().optional(),
      remaining: z.string().optional(),
      /** Why there is no time, in words (LG's answer, or that it couldn't be reached). */
      problem: z.string().optional(),
    }),
  },
  /** Extend the session the way the original does: launch the Developer Mode app with `{ extend: true }`. */
  'devmode.renew': {
    params: z.object({ device: DeviceTarget }),
    result: z.object({}),
  },
  /**
   * A screenshot (takeScreenshot in device-manager.service.ts): `capture/executeOneShot` (or the older
   * `tv.capture` service) writes a PNG to /tmp, which is read back and deleted. Needs root.
   */
  'device.screenshot': {
    params: z.object({ device: DeviceTarget, method: z.enum(['DISPLAY', 'VIDEO', 'GRAPHIC']).default('DISPLAY') }),
    result: z.object({ mime: z.string(), base64: z.string() }),
  },
  /** The login's home folder (`echo -n $HOME`, FileSessionImpl.home); /media/developer if it has none. */
  'files.home': {
    params: z.object({ device: DeviceTarget }),
    result: z.object({ path: z.string() }),
  },
  /** A directory's entries over SFTP (file::ls in the original), with symlink targets and the user's access. */
  'files.list': {
    params: z.object({ device: DeviceTarget, path: RemotePath }),
    result: z.object({ path: z.string(), items: z.array(FileItem) }),
  },
  /** One file's details (follows symlinks). */
  'files.stat': {
    params: z.object({ device: DeviceTarget, path: RemotePath }),
    result: FileItem,
  },
  /**
   * Part of a file, for downloads and previews: SFTP, or `dd` on TVs without it. `offset` and `length` must be
   * multiples of 64 KiB (except a final short read); `eof` is true when the end was reached.
   */
  'files.read': {
    params: z.object({
      device: DeviceTarget,
      path: RemotePath,
      offset: z.number().int().min(0),
      length: z.number().int().min(1).max(MAX_READ_CHUNK),
    }),
    result: z.object({ data: z.string(), eof: z.boolean() }),
  },
  /**
   * Write a file sent with `upload.*` to the TV (file::put). Streams `op.progress` (stage `upload`). Refuses to
   * replace an existing file unless `overwrite`.
   */
  'files.write': {
    params: z.object({
      device: DeviceTarget,
      path: RemotePath,
      uploadId: z.string().max(64),
      opId: z.string().max(64),
      overwrite: z.boolean().optional(),
    }),
    result: z.object({ size: z.number() }),
  },
  'files.mkdir': {
    params: z.object({ device: DeviceTarget, parent: RemotePath, name: FileName }),
    result: z.object({ path: z.string() }),
  },
  'files.rename': {
    params: z.object({ device: DeviceTarget, parent: RemotePath, from: FileName, to: FileName }),
    result: z.object({ path: z.string() }),
  },
  /** Delete a file or a folder with everything in it (`rm -r`, FileSessionImpl.rm). */
  'files.remove': {
    params: z.object({ device: DeviceTarget, path: RemotePath }),
    result: z.object({}),
  },

  /**
   * An interactive shell on its own SSH connection (shell_manager in the original): a PTY ("xterm") when the TV
   * allows one, otherwise a plain shell without one (`pty: false` in the result). Output arrives as
   * `shell.output`, the end as `shell.exit`. Shells belong to this connection and close with it.
   */
  'shell.open': {
    params: z.object({
      device: DeviceTarget,
      rows: z.number().int().min(2).max(500),
      cols: z.number().int().min(10).max(1000),
      /** False: don't ask for a PTY (the original's "dumb" shell). */
      pty: z.boolean().optional(),
    }),
    result: z.object({ shellId: z.string(), pty: z.boolean(), title: z.string() }),
  },
  /** Keystrokes / pasted text for a shell. Never logged. */
  'shell.write': {
    params: z.object({ shellId: z.string().max(64), data: z.string().max(1024 * 1024) }),
    result: z.object({}),
  },
  'shell.resize': {
    params: z.object({ shellId: z.string().max(64), rows: z.number().int().min(2).max(500), cols: z.number().int().min(10).max(1000) }),
    result: z.object({}),
  },
  /** The client has shown `bytes` of a shell's output (flow control: unacknowledged output pauses the shell). */
  'shell.ack': {
    params: z.object({ shellId: z.string().max(64), bytes: z.number().int().min(0) }),
    result: z.object({}),
  },
  'shell.close': {
    params: z.object({ shellId: z.string().max(64) }),
    result: z.object({}),
  },

  /**
   * The Homebrew repository's apps (all pages of `apps.json`). The bridge fetches it — only from the
   * configured repository — and keeps it in memory for a few minutes; `refresh` fetches it again.
   */
  'repo.list': {
    params: z.object({ refresh: z.boolean().optional() }),
    result: z.object({ packages: z.array(RepoPackage), fetchedAt: z.number() }),
  },
  /**
   * An icon or screenshot from the repository, fetched by the bridge (so the page needs no third-party image
   * hosts). Only URLs the repository index lists are fetched. Images up to 4 MiB.
   */
  'repo.image': {
    params: z.object({ url: WebUrl }),
    result: z.object({ mime: z.string(), base64: z.string() }),
  },
  /**
   * An app's full description as HTML (from the repository; the UI sanitises it), and the URL relative links and
   * images resolve against. Images in it can be loaded with `repo.image`. Null if it has none.
   */
  'repo.description': {
    params: z.object({ id: AppId }),
    result: z.object({ html: z.string().nullable(), baseUrl: z.string().optional() }),
  },
  /**
   * Install or update an app from the repository (installByManifest in app-manager.service.ts). The bridge looks
   * the app up itself. With Homebrew Channel the TV downloads the IPK; otherwise the bridge downloads it, checks
   * its sha256 and runs the dev install. Refuses if an app with the same id is installed outside the developer
   * partition. Streams `op.progress`.
   */
  'apps.installFromRepo': {
    params: z.object({
      device: DeviceTarget,
      id: AppId,
      channel: z.enum(['stable', 'beta']).default('stable'),
      opId: z.string().max(64),
    }),
    result: z.object({ appId: z.string(), version: z.string(), via: z.enum(['devmode', 'hbchannel']) }),
  },
  /** Homebrew Channel's configuration (`hbchannel.service/getConfiguration`): is it installed, and is the TV rooted. */
  'device.hbchannel': {
    params: z.object({ device: DeviceTarget, quiet: z.boolean().optional() }),
    result: z.object({ installed: z.boolean(), root: z.boolean().optional() }),
  },

  /**
   * Follow a log on the TV (root): `syslog` — `tail -f /var/log/messages` after turning developer logging on;
   * `dmesg` — `dmesg -w -x`; `lsmonitor` — `ls-monitor -j` (luna bus traffic). Lines arrive as `logs.lines`
   * events with this opId; resolves when the command ends, or `logs.stop` stops it. `lines`: how much history.
   */
  'logs.stream': {
    params: z.object({
      device: DeviceTarget,
      source: LogSource,
      opId: z.string().min(1).max(64),
      lines: z.number().int().min(0).max(5000).optional(),
    }),
    result: z.object({ exitCode: z.number().nullable(), stopped: z.boolean() }),
  },
  'logs.stop': {
    params: z.object({ opId: z.string().max(64) }),
    result: z.object({ stopped: z.boolean() }),
  },
  /** Empty /var/log/messages (`syslog`) or the kernel ring buffer (`dmesg -c`). Root. */
  'logs.clear': {
    params: z.object({ device: DeviceTarget, source: z.enum(['syslog', 'dmesg']) }),
    result: z.object({}),
  },
  /** PmLog contexts and their levels (`PmLogCtl show`). Root. */
  'pmlog.show': {
    params: z.object({ device: DeviceTarget }),
    result: z.object({ contexts: z.array(z.object({ name: z.string(), level: z.string() })) }),
  },
  /** Set a context's level (`PmLogCtl set`); `*` sets all. Returns the contexts PmLogCtl says it changed. */
  'pmlog.set': {
    params: z.object({ device: DeviceTarget, context: PmLogContext, level: PmLogLevel }),
    result: z.object({ changed: z.array(z.string()) }),
  },
  /** Native crash reports (listCrashReports): the files in the first crash folder that exists. */
  'crashes.list': {
    params: z.object({ device: DeviceTarget }),
    result: z.object({ dir: z.string().nullable(), reports: z.array(CrashReportFile) }),
  },
  /** A crash report's text, unzipped if it is gzip. Only files in the crash folders. */
  'crashes.read': {
    params: z.object({ device: DeviceTarget, path: RemotePath }),
    result: z.object({ text: z.string(), truncated: z.boolean() }),
  },
  /**
   * The latest Litefin releases with every webOS build (M8). The bridge fetches GitHub's release list itself and keeps
   * it for a few minutes; `refresh` fetches it again.
   */
  'litefin.list': {
    params: z.object({ refresh: z.boolean().optional() }).optional(),
    result: z.object({
      releases: z.array(LitefinRelease),
      fetchedAt: z.number(),
      /** Set when GitHub couldn't be reached and this is the list fetched earlier: why. */
      stale: z.string().optional(),
    }),
  },
  /**
   * Install one build of a listed release: the bridge looks the file up in the list it fetched (the client never sends
   * a URL), then installs it like a Homebrew repo app (Homebrew Channel, or the Dev Mode installer). Progress on `opId`.
   */
  'litefin.install': {
    params: z.object({ device: DeviceTarget, tag: z.string().min(1).max(100), variant: LitefinVariant, opId: z.string().max(64) }),
    result: z.object({ appId: z.string(), version: z.string(), via: z.enum(['devmode', 'hbchannel']) }),
  },
  /** Delete a crash report. Only files in the crash folders. */
  'crashes.delete': {
    params: z.object({ device: DeviceTarget, path: RemotePath }),
    result: z.object({}),
  },
} as const;

export type MethodName = keyof typeof Methods;
export type ParamsOf<M extends MethodName> = z.input<(typeof Methods)[M]['params']>;
export type ResultOf<M extends MethodName> = z.output<(typeof Methods)[M]['result']>;

/** Methods that may be called before `system.hello` succeeds. */
export const UNAUTHENTICATED_METHODS: readonly MethodName[] = ['system.hello'];

/** Where the public web UI is hosted. */
export const PUBLIC_WEB_ORIGIN = 'https://lg.scoty.uk';

/** Origins the bridge always accepts: the public site (and its own address, when it serves the UI itself). */
export const DEFAULT_ALLOWED_ORIGINS = [PUBLIC_WEB_ORIGIN] as const;

/** The Vite dev server, accepted only by a bridge started with --dev (any program could listen on that port). */
export const DEV_ALLOWED_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'] as const;

export const REPO_URL = 'https://github.com/Scoty/lg-dev-manager';
