import { z } from 'zod';

/**
 * M7 — debug tools (src/app/debug/** and remote-log.service.ts in the original).
 * Log lines travel raw; the UI parses them (apps/web/src/features/debug/parse.ts).
 */

/** What a log stream follows. Each maps to one fixed command on the bridge — never a command from the client. */
export const LogSource = z.enum(['syslog', 'dmesg', 'lsmonitor']);
export type LogSource = z.infer<typeof LogSource>;

/** A batch of complete lines from a log stream, pushed as the `logs.lines` event. */
export const LogLines = z.object({
  opId: z.string(),
  lines: z.array(z.string()),
  /** Lines skipped because they arrived faster than the bridge forwards them (the stream keeps going). */
  dropped: z.number().int().optional(),
});
export type LogLines = z.infer<typeof LogLines>;
export const LOG_LINES_EVENT = 'logs.lines';

/** PmLog levels (PrefLogLevel in the original), most verbose first after `none`. */
export const PmLogLevel = z.enum(['none', 'debug', 'info', 'notice', 'warning', 'err', 'crit', 'alert', 'emerg']);
export type PmLogLevel = z.infer<typeof PmLogLevel>;

/** A PmLog context name, or `*` for all. Letters, digits and . _ - < > * only. */
export const PmLogContext = z.string().min(1).max(128).regex(/^[\w.\-<>*]+$/, 'Not a log context name');

/** Where native crash reports are kept (listCrashReports): the first folder that exists wins. */
export const CRASH_DIRS = ['/tmp/faultmanager/crash/', '/tmp/var/log/reports/librdx/'] as const;

export const CrashReportFile = z.object({
  /** File name as on the TV (may contain control characters, which stand for `/` — see the UI's parser). */
  name: z.string(),
  path: z.string(),
  size: z.number(),
  mtime: z.number().optional(),
  /** This login may delete it. */
  writable: z.boolean(),
});
export type CrashReportFile = z.infer<typeof CrashReportFile>;

/** Largest crash report text returned (after unzipping); longer ones are cut and marked truncated. */
export const MAX_CRASH_TEXT = 2 * 1024 * 1024;
