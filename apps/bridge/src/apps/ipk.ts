import { Readable } from 'node:stream';
import { createGunzip, gunzipSync } from 'node:zlib';

/**
 * Read the control fields of an IPK (an `ar` archive holding debian-binary, control.tar.gz and data.tar.gz),
 * so the bridge knows which app it is installing even when the installer doesn't say.
 * Returns null for anything that isn't a well-formed IPK; installing then proceeds without the id.
 */
export function readIpkControl(ipk: Buffer): Record<string, string> | null {
  try {
    const control = arMember(ipk, /^control\.tar\.gz\/?$/);
    if (!control) return null;
    const file = tarMember(gunzipSync(control, { maxOutputLength: 4 * 1024 * 1024 }), /^(\.\/)?control$/);
    if (!file) return null;
    const fields: Record<string, string> = {};
    for (const line of file.toString('utf8').split('\n')) {
      const m = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/.exec(line);
      if (m) fields[m[1]!] = m[2]!;
    }
    return fields.Package ? fields : null;
  } catch {
    return null;
  }
}

function arMember(buf: Buffer, name: RegExp): Buffer | null {
  if (buf.subarray(0, 8).toString('latin1') !== '!<arch>\n') return null;
  let off = 8;
  while (off + 60 <= buf.length) {
    const header = buf.subarray(off, off + 60).toString('latin1');
    if (header.slice(58, 60) !== '`\n') return null;
    const member = header.slice(0, 16).trim();
    const size = Number.parseInt(header.slice(48, 58).trim(), 10);
    if (!Number.isFinite(size) || size < 0) return null;
    const start = off + 60;
    if (start + size > buf.length) return null;
    if (name.test(member)) return buf.subarray(start, start + size);
    off = start + size + (size % 2);
  }
  return null;
}

function tarMember(buf: Buffer, name: RegExp): Buffer | null {
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) return null;
    const entry = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = Number.parseInt(header.subarray(124, 136).toString('latin1').replace(/\0.*$/s, '').trim() || '0', 8);
    // A negative or garbage size would never move `off` forward (a crafted IPK hung the whole bridge).
    if (!Number.isFinite(size) || size < 0) return null;
    const type = String.fromCharCode(header[156] ?? 48);
    const start = off + 512;
    if (start + size > buf.length) return null;
    if ((type === '0' || type === '\0') && name.test(entry)) return buf.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** Most data a strict IPK check will decompress (a gzip bomb would otherwise keep the bridge busy for minutes). */
const MAX_DATA_UNPACKED = 2 * 1024 * 1024 * 1024;
/** Most entries a strict IPK check reads from data.tar.gz. */
const MAX_DATA_ENTRIES = 200_000;
/** Biggest webOS metadata file (appinfo.json, packageinfo.json, services.json) read for its id. */
const MAX_INFO_BYTES = 256 * 1024;

/**
 * For an IPK from a source that isn't trusted (a custom repository): does it install only `id`? opkg and webOS read
 * an IPK differently from a quick look, so this is strict where they could disagree:
 * - exactly one control.tar.gz and one data.tar.gz member, no other member names twice;
 * - one `control` file with a single paragraph and a single `Package:` field, equal to `id`;
 * - in data.tar.gz, every app, service and package folder (usr/palm/applications|services|packages/<name>) and every
 *   id in their appinfo.json / packageinfo.json / services.json is `id` or `id.<something>` (webOS's own rule for a
 *   package's services), no path climbs out with `..`, and the package's own folder is there.
 * Returns why it fails, or null when it's fine.
 */
export async function untrustedIpkProblem(ipk: Buffer, id: string): Promise<string | null> {
  const members = arMembers(ipk);
  if (!members) return 'it isn’t an IPK this app can read';
  const names = members.map((m) => m.name);
  if (new Set(names).size !== names.length) return 'it has two parts with the same name';
  const control = members.filter((m) => /^control\.tar/.test(m.name));
  const data = members.filter((m) => /^data\.tar/.test(m.name));
  if (control.length !== 1 || control[0]!.name !== 'control.tar.gz') return 'its control part isn’t a single control.tar.gz';
  if (data.length !== 1 || data[0]!.name !== 'data.tar.gz') return 'its data part isn’t a single data.tar.gz';

  let controlTar: Buffer;
  try {
    controlTar = gunzipSync(control[0]!.data, { maxOutputLength: 4 * 1024 * 1024 });
  } catch {
    return 'its control part can’t be unpacked';
  }
  const files = tarEntries(controlTar)?.filter((e) => /^(\.\/)?control$/.test(e.name));
  if (!files || files.length !== 1) return 'it doesn’t have exactly one control file';
  const text = files[0]!.data.toString('utf8').replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '');
  if (/\n[ \t]*\n/.test(text)) return 'its control file has more than one paragraph';
  const pkgLines = text.split('\n').filter((l) => /^package\s*:/i.test(l));
  if (pkgLines.length !== 1) return 'its control file doesn’t name exactly one package';
  const packageId = pkgLines[0]!.replace(/^package\s*:/i, '').trim();
  if (packageId !== id) return `it is ${packageId || 'unnamed'}`;

  // The app and package folders must be the id itself; services may be the id or start with it (id.service), as
  // webOS requires of a package's services.
  const ours = (kind: string, name: string) => name === id || (kind === 'services' && name.startsWith(`${id}.`));
  let ownFolder = false;
  try {
    for await (const entry of streamTarEntries(data[0]!.data)) {
      // The path as extraction resolves it: `.` and empty segments dropped (usr/./palm/… is usr/palm/…).
      const parts = entry.name.split('/').filter((p) => p && p !== '.');
      if (parts.includes('..')) return 'it has a file path that climbs out of its folder';
      if (entry.link !== undefined) {
        // A link can make later files land elsewhere: only links that stay inside their own folder.
        const target = entry.link.split('/').filter((p) => p && p !== '.');
        if (entry.link.startsWith('/') || target.includes('..')) return `it has a link that points outside its folder (${entry.name})`;
        if (entry.type === '1') {
          const t = /^usr\/palm\/(applications|services|packages)\/([^/]+)/.exec(target.join('/'));
          if (t && !ours(t[1]!, t[2]!)) return `it links to ${t[2]}`;
        }
      }
      const m = /^usr\/palm\/(applications|services|packages)\/([^/]+)/.exec(parts.join('/'));
      if (!m) continue;
      if (!ours(m[1]!, m[2]!)) return `it also installs ${m[2]} (its ${m[1]!.replace(/s$/, '')} folder)`;
      if (m[2] === id && (m[1] === 'applications' || m[1] === 'packages')) ownFolder = true;
      if (entry.info) {
        let info: unknown;
        try {
          info = JSON.parse(entry.info.toString('utf8').replace(/^﻿/, ''));
        } catch {
          continue; // webOS rejects a broken file itself
        }
        const file = parts.at(-1)!;
        for (const [kind, other] of infoIds(info, file)) if (!ours(kind, other)) return `it also installs ${other} (named in ${file})`;
      }
    }
  } catch (e) {
    return `its data part can’t be read (${(e as Error).message})`;
  }
  if (!ownFolder) return `it has no app or package folder for ${id}`;
  return null;
}

/**
 * The ids a webOS metadata file declares: appinfo.json / packageinfo.json / services.json `id`, and the services a
 * package or services.json lists. (packageinfo.json's `app` only points at an app; some real IPKs put a display name
 * there, so it isn't checked — the folders it could install are.)
 */
function infoIds(info: unknown, file: string): [kind: string, id: string][] {
  if (!info || typeof info !== 'object') return [];
  const o = info as Record<string, unknown>;
  const out: [string, string][] = [];
  if (typeof o.id === 'string') out.push([file === 'services.json' ? 'services' : 'applications', o.id]);
  if (Array.isArray(o.services)) {
    for (const s of o.services) {
      if (typeof s === 'string') out.push(['services', s]);
      else if (s && typeof s === 'object') {
        const name = (s as Record<string, unknown>).name;
        if (typeof name === 'string') out.push(['services', name]);
      }
    }
  }
  return out;
}

function arMembers(buf: Buffer): { name: string; data: Buffer }[] | null {
  if (buf.subarray(0, 8).toString('latin1') !== '!<arch>\n') return null;
  const out: { name: string; data: Buffer }[] = [];
  let off = 8;
  while (off + 60 <= buf.length) {
    const header = buf.subarray(off, off + 60).toString('latin1');
    if (header.slice(58, 60) !== '`\n') return null;
    const size = Number.parseInt(header.slice(48, 58).trim(), 10);
    if (!Number.isFinite(size) || size < 0) return null;
    const start = off + 60;
    if (start + size > buf.length) return null;
    out.push({ name: header.slice(0, 16).trim().replace(/\/$/, ''), data: buf.subarray(start, start + size) });
    off = start + size + (size % 2);
    if (out.length > 16) return null;
  }
  // Trailing bytes that aren't a whole member: not something to guess about.
  return buf.subarray(off).every((b) => b === 0x0a) ? out : null;
}

function tarEntries(buf: Buffer): { name: string; data: Buffer }[] | null {
  const out: { name: string; data: Buffer }[] = [];
  let off = 0;
  let longName: string | null = null;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const h = parseTarHeader(header);
    if (!h) return null;
    const start = off + 512;
    if (start + h.size > buf.length) return null;
    const body = buf.subarray(start, start + h.size);
    off = start + Math.ceil(h.size / 512) * 512;
    if (h.type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
    else if (h.type === 'x') longName = paxValue(body, 'path') ?? longName;
    else {
      out.push({ name: longName ?? h.name, data: body });
      longName = null;
    }
  }
  return out;
}

function parseTarHeader(header: Buffer): { name: string; size: number; type: string; link: string } | null {
  const field = (a: number, b: number) => header.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
  const size = Number.parseInt(field(124, 136).trim() || '0', 8);
  if (!Number.isFinite(size) || size < 0) return null;
  const ustar = header.subarray(257, 262).toString('latin1') === 'ustar';
  const prefix = ustar ? field(345, 500) : '';
  const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
  return { name, size, type: String.fromCharCode(header[156] || 48), link: field(157, 257) };
}

/** A pax header's `key` (path, linkpath): the last record wins, as in GNU tar and libarchive. */
function paxValue(body: Buffer, key: string): string | null {
  let value: string | null = null;
  for (const rec of body.toString('utf8').split('\n')) {
    const m = /^\d+ ([^=]+)=(.*)$/.exec(rec);
    if (m && m[1] === key) value = m[2]!;
  }
  return value;
}

/**
 * Entries of a gzip'd tar, read as it unpacks (an IPK's data can be hundreds of MB): names only, plus the contents
 * of webOS metadata files. Stops with an error past MAX_DATA_UNPACKED bytes or MAX_DATA_ENTRIES entries.
 */
async function* streamTarEntries(gz: Buffer): AsyncGenerator<{ name: string; type: string; link?: string; info?: Buffer }> {
  const gunzip = createGunzip();
  const source = Readable.from([gz]).pipe(gunzip);
  let pending: Buffer = Buffer.alloc(0);
  let unpacked = 0;
  let entries = 0;
  // State: reading a header, skipping `skip` bytes of a body, or keeping `keep` bytes of one (long name / metadata).
  let skip = 0;
  let keep: { left: number; pad: number; parts: Buffer[]; kind: 'L' | 'K' | 'x' | 'info'; name: string } | null = null;
  // The next entry's name / link target from a GNU long-name (L, K) or pax (x) header before it.
  let longName: string | null = null;
  let longLink: string | null = null;
  try {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      unpacked += chunk.length;
      if (unpacked > MAX_DATA_UNPACKED) throw new Error('it unpacks to more than 2 GB');
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      for (;;) {
        if (skip) {
          const n = Math.min(skip, pending.length);
          skip -= n;
          pending = pending.subarray(n);
          if (skip) break;
        }
        if (keep) {
          const n = Math.min(keep.left, pending.length);
          keep.parts.push(pending.subarray(0, n));
          keep.left -= n;
          pending = pending.subarray(n);
          if (keep.left) break;
          const body = Buffer.concat(keep.parts);
          const k = keep;
          keep = null;
          skip = k.pad;
          if (k.kind === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
          else if (k.kind === 'K') longLink = body.toString('utf8').replace(/\0.*$/s, '');
          else if (k.kind === 'x') {
            longName = paxValue(body, 'path') ?? longName;
            longLink = paxValue(body, 'linkpath') ?? longLink;
          } else yield { name: k.name, type: '0', info: body };
          continue;
        }
        if (pending.length < 512) break;
        const header = pending.subarray(0, 512);
        pending = pending.subarray(512);
        // An empty block ends the archive; tar (and opkg) ignore whatever padding or leftovers follow it.
        if (header.every((b) => b === 0)) return;
        const h = parseTarHeader(header);
        if (!h) throw new Error('a damaged tar header');
        if (++entries > MAX_DATA_ENTRIES) throw new Error('too many files');
        const pad = Math.ceil(h.size / 512) * 512 - h.size;
        // Global pax headers would change how every later entry is read: not something an app needs.
        if (h.type === 'g') throw new Error('a global pax header');
        if (h.type === 'L' || h.type === 'K' || h.type === 'x') {
          if (h.size > 64 * 1024) throw new Error('a file name that is too long');
          keep = { left: h.size, pad, parts: [], kind: h.type, name: '' };
          continue;
        }
        const name = longName ?? h.name;
        const link = h.type === '1' || h.type === '2' ? (longLink ?? h.link) : undefined;
        longName = null;
        longLink = null;
        const isInfo = /(^|\/)(appinfo|packageinfo|services)\.json$/.test(name) && (h.type === '0' || h.type === '\0');
        if (isInfo && h.size > MAX_INFO_BYTES) throw new Error(`${name} is too big`);
        if (isInfo) {
          keep = { left: h.size, pad, parts: [], kind: 'info', name };
          continue;
        }
        yield { name, type: h.type, link };
        skip = h.size + pad;
      }
    }
  } finally {
    source.destroy();
  }
}
