import { z } from 'zod';

/** Absolute POSIX path without `..` segments or NUL bytes. */
export const RemotePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => p.startsWith('/') && !p.split('/').includes('..') && !p.includes('\0'), 'Not an absolute path');

/** One name inside a directory: no slashes, not `.`/`..`. */
export const FileName = z
  .string()
  .min(1)
  .max(255)
  .refine((n) => !n.includes('/') && !n.includes('\0') && n !== '.' && n !== '..', 'Not a valid file name');

/**
 * One directory entry, like FileItem in dev-manager-desktop (src-tauri/src/remote_files). `type` is the `ls -l`
 * letter: d directory, - file, l symlink, c/b devices, p pipe, s socket, ? unknown.
 */
export const FileItem = z.object({
  name: z.string(),
  type: z.enum(['d', '-', 'l', 'c', 'b', 'p', 's', '?']),
  /** `rwxr-xr-x` */
  mode: z.string(),
  size: z.number(),
  /** Seconds since the epoch. */
  mtime: z.number(),
  user: z.string().optional(),
  group: z.string().optional(),
  /** For symlinks: where it points, and what is there (`d` lets the UI open linked folders). */
  link: z
    .object({
      target: z.string().optional(),
      broken: z.boolean().optional(),
      type: z.enum(['d', '-', 'l', 'c', 'b', 'p', 's', '?']).optional(),
    })
    .optional(),
  /** What the logged-in user may do with it (PermInfo in the original). */
  access: z.object({ read: z.boolean(), write: z.boolean(), execute: z.boolean() }).optional(),
});
export type FileItem = z.infer<typeof FileItem>;

/** Largest `files.read` chunk. Multiple of 64 KiB, so the `dd` fallback can address it in whole blocks. */
export const MAX_READ_CHUNK = 4 * 1024 * 1024;
export const READ_BLOCK = 64 * 1024;

export const FilesErrorCodes = {
  NotFound: 'file_not_found',
  Denied: 'file_denied',
  Exists: 'file_exists',
  NoSftp: 'no_sftp',
  NotADirectory: 'not_a_directory',
  Failed: 'file_failed',
} as const;

/** Output of an interactive shell, pushed as the `shell.output` event. */
export const ShellOutput = z.object({
  shellId: z.string(),
  /** Raw bytes, base64 (a chunk may end mid UTF-8 sequence; the terminal decodes it). */
  data: z.string(),
  /** stderr is only separate in shells without a PTY. */
  stream: z.enum(['stdout', 'stderr']).optional(),
});
export type ShellOutput = z.infer<typeof ShellOutput>;
export const SHELL_OUTPUT_EVENT = 'shell.output';

/** A shell ended: the remote side exited, the connection dropped, or it failed to start. */
export const ShellExit = z.object({
  shellId: z.string(),
  code: z.number().nullable().optional(),
  signal: z.string().optional(),
  error: z.string().optional(),
});
export type ShellExit = z.infer<typeof ShellExit>;
export const SHELL_EXIT_EVENT = 'shell.exit';

export const ShellErrorCodes = {
  NotFound: 'shell_not_found',
  TooMany: 'shell_too_many',
  Failed: 'shell_failed',
} as const;
