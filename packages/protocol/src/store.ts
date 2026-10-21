import { z } from 'zod';
import { DeviceAuth, HostName, UserName } from './device';
import { CustomRepoUrl } from './repo';

/**
 * Bridge-side storage (2.0, opt-in: `--store` / LGDM_STORE=1, on in the Docker image). The bridge keeps the TVs, the
 * custom repositories and the screenshots in its data folder, so every browser paired with it sees the same ones.
 *
 * The TVs' passwords and private keys go to the bridge once (when a TV is added or its login is changed) and never
 * come back: browsers get a summary of the login only, and name a stored TV in calls by its id ({ stored: id }),
 * which the bridge replaces with the full target before the call runs.
 */

/** What a TV last said about itself (device.info), kept with it to show its model. */
export const StoredTvInfo = z.object({
  modelName: z.string().max(64).optional(),
  osVersion: z.string().max(64).optional(),
  firmwareVersion: z.string().max(64).optional(),
  socName: z.string().max(64).optional(),
  from: z.string().max(300),
  at: z.number(),
  v: z.number().optional(),
});

export const DeviceId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Not a device id');

/** A login, described without its secret. */
export const LoginSummary = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('key'), hasPassphrase: z.boolean() }),
  z.object({ kind: z.literal('password') }),
]);
export type LoginSummary = z.infer<typeof LoginSummary>;

const deviceFields = {
  id: DeviceId,
  name: z.string().trim().min(1).max(64),
  mode: z.enum(['devmode', 'rooted']),
  host: HostName,
  port: z.number().int().min(1).max(65535),
  username: UserName,
  description: z.string().max(200).optional(),
  info: StoredTvInfo.optional(),
};

/** A stored TV as browsers see it: everything but the secret. */
export const StoredDevice = z.object({
  ...deviceFields,
  login: LoginSummary,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type StoredDevice = z.infer<typeof StoredDevice>;

/**
 * A TV to save. `auth` is required for a new TV; for an existing one, leaving it out keeps the stored login (what
 * editing a TV's name or address does).
 */
export const StoredDeviceInput = z.object({ ...deviceFields, auth: DeviceAuth.optional() });
export type StoredDeviceInput = z.infer<typeof StoredDeviceInput>;

/**
 * A stored TV named in a call (in place of a full DeviceTarget, under `device`). Only the id: the bridge uses the stored
 * address and login as they are, so a browser can never send a stored login to another address.
 */
export const StoredDeviceRef = z.object({ stored: DeviceId }).strict();
export type StoredDeviceRef = z.infer<typeof StoredDeviceRef>;

/** A custom repository (Setup → Custom repos), as the browser keeps it. */
export const StoredCustomRepo = z.object({
  id: z.string().regex(/^[a-z0-9]{6,24}$/),
  name: z.string().trim().min(1).max(60),
  url: CustomRepoUrl,
  addedAt: z.number(),
  apps: z.number().int().nonnegative().optional(),
});
export type StoredCustomRepo = z.infer<typeof StoredCustomRepo>;

export const ShotMethod = z.enum(['DISPLAY', 'VIDEO', 'GRAPHIC']);
export const ShotId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'Not a screenshot id');

export const StoredShot = z.object({
  id: ShotId,
  deviceId: DeviceId,
  at: z.number(),
  method: ShotMethod,
  mime: z.enum(['image/png', 'image/jpeg']),
  bytes: z.number().int().nonnegative(),
});
export type StoredShot = z.infer<typeof StoredShot>;

/** Limits of the bridge's storage. */
export const STORE_LIMITS = {
  devices: 200,
  customRepos: 20,
  /** Per TV. The oldest go first when a new one would pass it. */
  shotsPerDevice: 100,
  /** One screenshot (a 4K PNG is 3–8 MB). Its base64 has to fit in one 16 MiB message. */
  shotBytes: 11 * 1024 * 1024,
  /** All screenshots together. The oldest (of any TV) go first when a new one would pass it. */
  shotsTotalBytes: 1024 * 1024 * 1024,
} as const;

/** Sent to every paired browser when something stored changes, so they all show the same. */
export const STORE_CHANGED_EVENT = 'store.changed';
export const StoreChanged = z.object({
  what: z.enum(['devices', 'repos', 'shots']),
  deviceId: DeviceId.optional(),
});
export type StoreChanged = z.infer<typeof StoreChanged>;

export const StoreErrorCodes = {
  /** The bridge doesn't store anything (started without --store). */
  Off: 'store_off',
  NotFound: 'store_not_found',
  /** Changing a stored TV's address or user name with its kept password, before the bridge knows the TV's host key. */
  LoginRequired: 'store_login_required',
  Full: 'store_full',
  /** The data folder couldn't be written (permissions, disk full). */
  WriteFailed: 'store_write_failed',
} as const;
