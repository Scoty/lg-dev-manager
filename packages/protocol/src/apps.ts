import { z } from 'zod';

/** App ids as webOS uses them (reverse-DNS-ish). Also keeps ids safe to pass around in shell commands. */
export const AppId = z.string().min(1).max(255).regex(/^[\w.-]+$/, 'Not a valid app id');

/**
 * One entry of `applicationManager/(dev/)listApps`. Only the fields the UI uses are typed;
 * webOS returns many more, which pass through untouched.
 */
export const AppInfo = z
  .object({
    id: z.string(),
    title: z.string().optional(),
    version: z.string().optional(),
    type: z.string().optional(),
    vendor: z.string().optional(),
    folderPath: z.string().optional(),
    icon: z.string().optional(),
    systemApp: z.boolean().optional(),
    removable: z.boolean().optional(),
    visible: z.boolean().optional(),
  })
  .passthrough();
export type AppInfo = z.infer<typeof AppInfo>;

export const APP_ID_HBCHANNEL = 'org.webosbrew.hbchannel';
export const APP_ID_DEVMODE = 'com.palmdts.devmode';

/** Where IPKs wait on the TV while appinstalld reads them (dev-manager-desktop app-manager.service.ts). */
export const TEMP_IPK_DIR = '/media/developer/temp';

/** Largest IPK the bridge accepts from the browser. Uploads are held in the bridge's memory only. */
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
/** Largest single `upload.chunk` (before base64). */
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Progress of a long-running operation (install, remove…), pushed as the `op.progress` event.
 * The client picks `opId` and passes it in the call, so it can listen before the call starts.
 */
export const OpProgress = z.object({
  opId: z.string(),
  stage: z.enum(['upload', 'verify', 'install', 'remove', 'cleanup']),
  /** 0–100 when known. */
  percent: z.number().min(0).max(100).optional(),
  text: z.string().optional(),
});
export type OpProgress = z.infer<typeof OpProgress>;

export const OP_PROGRESS_EVENT = 'op.progress';

export const AppsErrorCodes = {
  InstallFailed: 'install_failed',
  RemoveFailed: 'remove_failed',
  InsufficientSpace: 'insufficient_space',
  ChecksumMismatch: 'checksum_mismatch',
  UploadNotFound: 'upload_not_found',
  UploadTooLarge: 'upload_too_large',
  UploadIncomplete: 'upload_incomplete',
  FileTooLarge: 'file_too_large',
  TransferFailed: 'transfer_failed',
} as const;
