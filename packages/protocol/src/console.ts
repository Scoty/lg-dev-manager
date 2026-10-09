import { z } from 'zod';

/**
 * One SSH command (or file transfer / tunnel) the bridge ran on a TV for this client, pushed as `cmd.log`
 * events: `start` when it begins, `end` when it finishes. Powers the console panel in the UI.
 * Never contains credentials: commands are built by the bridge and output is truncated.
 */
export const CmdLog = z.object({
  id: z.string(),
  phase: z.enum(['start', 'end']),
  /** `user@host:port` */
  target: z.string(),
  /** The shell command, or a description like `sftp put /media/developer/temp/x.ipk (1.2 MB)`. */
  command: z.string(),
  kind: z.enum(['exec', 'stream', 'sftp', 'tunnel', 'http']),
  /** Routine background reads (e.g. app icons) the UI may hide by default. */
  quiet: z.boolean().optional(),
  at: z.number(),
  exitCode: z.number().nullable().optional(),
  durationMs: z.number().optional(),
  /** Up to ~8 KB of output; binary output is summarised. */
  output: z.string().optional(),
  error: z.string().optional(),
});
export type CmdLog = z.infer<typeof CmdLog>;
export const CMD_LOG_EVENT = 'cmd.log';

/** Live output of a `cmd.stream` command. */
export const CmdOutput = z.object({
  opId: z.string(),
  stream: z.enum(['stdout', 'stderr']),
  data: z.string(),
});
export type CmdOutput = z.infer<typeof CmdOutput>;
export const CMD_OUTPUT_EVENT = 'cmd.output';

/** A TV found on the local network by `device.scan`. */
export const ScanResult = z.object({
  host: z.string(),
  /** Friendly name from SSDP (e.g. "[LG] webOS TV OLED55C2"), when the TV answered SSDP. */
  name: z.string().optional(),
  modelName: z.string().optional(),
  ports: z.object({
    ssh22: z.boolean(),
    ssh9922: z.boolean(),
    keyServer: z.boolean(),
    /** LG's second-screen WebSocket (3000/3001): open on any webOS TV that is on, SSH or not. */
    webos: z.boolean(),
  }),
  via: z.array(z.enum(['ssdp', 'sweep'])),
});
export type ScanResult = z.infer<typeof ScanResult>;

/** Ports the scan and the port check look at. */
export const WEBOS_SSAP_PORTS = [3000, 3001] as const;
