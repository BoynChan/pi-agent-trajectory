import { appendFile, mkdir, open, readFile, truncate } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { jsonLine } from "./json.ts";
import {
  SCHEMA_VERSION,
  type AppendOptions,
  type TrajectoryEvent,
  type TrajectoryHeader,
  type ValidationResult,
} from "./types.ts";

export interface OpenTrajectoryOptions {
  path: string;
  sessionId: string;
  cwd: string;
  piSessionFile?: string;
  pluginVersion: string;
}

export class TrajectoryWriter {
  readonly path: string;
  readonly header: TrajectoryHeader;
  private handle: FileHandle;
  private nextSeq: number;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(path: string, header: TrajectoryHeader, handle: FileHandle, nextSeq: number) {
    this.path = path;
    this.header = header;
    this.handle = handle;
    this.nextSeq = nextSeq;
  }

  static async open(options: OpenTrajectoryOptions): Promise<TrajectoryWriter> {
    await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });
    await repairTornTail(options.path);

    let validation: ValidationResult;
    try {
      validation = await readTrajectory(options.path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      validation = { valid: true, errors: [], events: [] };
    }

    if (!validation.valid) throw new Error(`Invalid trajectory ${options.path}: ${validation.errors.join("; ")}`);
    if (validation.header && validation.header.sessionId !== options.sessionId) {
      throw new Error(`Trajectory belongs to session ${validation.header.sessionId}, not ${options.sessionId}`);
    }

    const handle = await open(options.path, "a+", 0o600);
    await handle.chmod(0o600);
    let header = validation.header;
    if (!header) {
      header = {
        type: "trajectory/session",
        schemaVersion: SCHEMA_VERSION,
        sessionId: options.sessionId,
        createdAt: new Date().toISOString(),
        cwd: options.cwd,
        piSessionFile: options.piSessionFile,
        pluginVersion: options.pluginVersion,
      };
      await handle.write(jsonLine(header));
      await handle.sync();
    }
    const writer = new TrajectoryWriter(options.path, header, handle, validation.events.length + 1);
    await writer.recoverInterrupted(validation.events);
    return writer;
  }

  async append(type: string, data: unknown = {}, options: AppendOptions = {}): Promise<TrajectoryEvent> {
    if (this.closed) throw new Error("Trajectory writer is closed");
    const event: TrajectoryEvent = {
      type,
      schemaVersion: SCHEMA_VERSION,
      sessionId: this.header.sessionId,
      seq: this.nextSeq++,
      time: new Date().toISOString(),
      data,
      ...(options.sourceEventSeqs?.length ? { sourceEventSeqs: options.sourceEventSeqs } : {}),
      ...(options.surfaceOp ? { surfaceOp: options.surfaceOp } : {}),
    };
    this.queue = this.queue.then(async () => {
      await this.handle.write(jsonLine(event));
      if (options.sync) await this.handle.sync();
    });
    await this.queue;
    return event;
  }

  async flush(sync = false): Promise<void> {
    await this.queue;
    if (sync && !this.closed) await this.handle.sync();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush(true);
    this.closed = true;
    await this.handle.close();
  }

  private async recoverInterrupted(events: TrajectoryEvent[]): Promise<void> {
    let runOpen = false;
    let stepOpen = false;
    const tools = new Map<string, number>();
    for (const event of events) {
      if (event.type === "run/start") runOpen = true;
      if (event.type === "run/end" || event.type === "run/settled") runOpen = false;
      if (event.type === "step/start") stepOpen = true;
      if (event.type === "step/end") stepOpen = false;
      const id = getToolCallId(event.data);
      if (event.type === "tool/call" && id) tools.set(id, event.seq);
      if (event.type === "tool/result" && id) tools.delete(id);
    }
    if (!runOpen && !stepOpen && tools.size === 0) return;
    const recovery = await this.append("recovery/interrupted", {
      openRun: runOpen,
      openStep: stepOpen,
      openToolCallIds: [...tools.keys()],
    });
    for (const [toolCallId, sourceSeq] of tools) {
      await this.append("tool/result", { toolCallId, isError: true, recovered: true, error: "process interrupted" }, {
        sourceEventSeqs: [sourceSeq, recovery.seq],
        surfaceOp: "append",
      });
    }
    if (stepOpen) await this.append("step/end", { recovered: true, reason: "process interrupted" }, { sourceEventSeqs: [recovery.seq] });
    if (runOpen) await this.append("run/end", { recovered: true, reason: "process interrupted" }, { sourceEventSeqs: [recovery.seq], sync: true });
  }
}

function getToolCallId(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = (data as Record<string, unknown>).toolCallId;
  return typeof value === "string" ? value : undefined;
}

async function repairTornTail(path: string): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (bytes.length === 0 || bytes.at(-1) === 0x0a) return;
  const newline = bytes.lastIndexOf(0x0a);
  const tail = bytes.subarray(newline + 1).toString("utf8");
  try {
    JSON.parse(tail);
    await appendFile(path, "\n");
  } catch {
    await truncate(path, newline < 0 ? 0 : newline + 1);
  }
}

export async function readTrajectory(path: string): Promise<ValidationResult> {
  const text = await readFile(path, "utf8");
  if (!text.trim()) return { valid: true, errors: [], events: [] };
  const errors: string[] = [];
  const records: unknown[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      errors.push(`line ${index + 1}: invalid JSON (${(error as Error).message})`);
    }
  }
  const first = records[0] as Partial<TrajectoryHeader> | undefined;
  let header: TrajectoryHeader | undefined;
  if (!first || first.type !== "trajectory/session") {
    errors.push("line 1: missing trajectory/session header");
  } else if (first.schemaVersion !== SCHEMA_VERSION || typeof first.sessionId !== "string") {
    errors.push("line 1: invalid header schema or sessionId");
  } else {
    header = first as TrajectoryHeader;
  }
  const events: TrajectoryEvent[] = [];
  for (let index = 1; index < records.length; index++) {
    const event = records[index] as Partial<TrajectoryEvent>;
    if (typeof event.type !== "string" || typeof event.seq !== "number" || event.schemaVersion !== SCHEMA_VERSION) {
      errors.push(`record ${index + 1}: invalid event`);
      continue;
    }
    if (event.seq !== events.length + 1) errors.push(`record ${index + 1}: expected seq ${events.length + 1}, got ${event.seq}`);
    if (header && event.sessionId !== header.sessionId) errors.push(`record ${index + 1}: sessionId mismatch`);
    events.push(event as TrajectoryEvent);
  }
  return { valid: errors.length === 0, errors, header, events };
}
