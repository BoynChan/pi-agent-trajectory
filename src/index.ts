import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { exportHtml } from "./export.ts";
import { jsonSafe } from "./json.ts";
import { summarizeTrajectory } from "./projector.ts";
import { readTrajectory, TrajectoryWriter } from "./store.ts";

const PLUGIN_VERSION = "0.1.0";

export default function trajectoryExtension(pi: ExtensionAPI): void {
  pi.registerFlag("trajectory-dir", {
    type: "string",
    description: "Directory for append-only trajectory JSONL files",
  });
  pi.registerFlag("trajectory-strict", {
    type: "boolean",
    default: false,
    description: "Fail a model/tool boundary if the trajectory cannot be durably persisted",
  });

  let writer: TrajectoryWriter | undefined;
  let opening: Promise<TrajectoryWriter> | undefined;
  let disabled = false;
  let warned = false;
  let currentStepChunkSeqs: number[] = [];
  const toolCallSeqs = new Map<string, number>();

  const strict = (): boolean => pi.getFlag("trajectory-strict") === true;
  const directory = (): string => resolveDirectory(String(pi.getFlag("trajectory-dir") || process.env.PI_TRAJECTORY_DIR || "~/.pi/agent/trajectories"));

  async function getWriter(ctx: ExtensionContext): Promise<TrajectoryWriter> {
    if (writer) return writer;
    if (disabled) throw new Error("trajectory recorder is disabled after a persistence failure");
    if (!opening) {
      const sessionId = ctx.sessionManager.getSessionId();
      opening = TrajectoryWriter.open({
        path: join(directory(), `${safeFilename(sessionId)}.jsonl`),
        sessionId,
        cwd: ctx.cwd,
        piSessionFile: ctx.sessionManager.getSessionFile(),
        pluginVersion: PLUGIN_VERSION,
      });
    }
    writer = await opening;
    return writer;
  }

  async function record(ctx: ExtensionContext, type: string, data: unknown = {}, options: { critical?: boolean; sync?: boolean; sourceEventSeqs?: number[]; surfaceOp?: "append" } = {}) {
    try {
      const active = await getWriter(ctx);
      return await active.append(type, jsonSafe(data), options);
    } catch (error) {
      disabled = true;
      if (!warned) {
        warned = true;
        ctx.ui.notify(`Trajectory recorder disabled: ${(error as Error).message}`, "error");
      }
      if (options.critical && strict()) throw error;
      return undefined;
    }
  }

  async function closeWriter(): Promise<void> {
    const active = writer ?? (opening ? await opening.catch(() => undefined) : undefined);
    writer = undefined;
    opening = undefined;
    if (active) await active.close();
  }

  pi.on("session_start", async (event, ctx) => {
    disabled = false;
    warned = false;
    await record(ctx, "session/start", {
      reason: event.reason,
      previousSessionFile: event.previousSessionFile,
      piSessionFile: ctx.sessionManager.getSessionFile(),
      cwd: ctx.cwd,
    }, { sync: true });
  });

  pi.on("session_info_changed", async (event, ctx) => { await record(ctx, "session/info", { name: event.name }); });
  pi.on("before_agent_start", async (event, ctx) => { await record(ctx, "request/header", event); });
  pi.on("agent_start", async (_event, ctx) => { await record(ctx, "run/start"); });
  pi.on("agent_end", async (event, ctx) => { await record(ctx, "run/end", { messages: event.messages }); });
  pi.on("agent_settled", async (_event, ctx) => { await record(ctx, "run/settled", {}, { sync: true }); });
  pi.on("turn_start", async (event, ctx) => {
    currentStepChunkSeqs = [];
    await record(ctx, "step/start", { turnIndex: event.turnIndex, timestamp: event.timestamp });
  });
  pi.on("turn_end", async (event, ctx) => { await record(ctx, "step/end", event); });

  pi.on("input", async (event, ctx) => { await record(ctx, "input/received", event); });
  pi.on("context", async (event, ctx) => {
    await record(ctx, "request/context", {
      messages: event.messages,
      systemPrompt: ctx.getSystemPrompt(),
      model: ctx.model,
      thinkingLevel: ctx.thinkingLevel,
      activeTools: pi.getActiveTools(),
    }, { critical: true, sync: true });
  });
  pi.on("before_provider_request", async (event, ctx) => {
    await record(ctx, "request/payload", { payload: event.payload }, { critical: true, sync: true });
  });
  pi.on("after_provider_response", async (event, ctx) => { await record(ctx, "provider/response", event); });

  pi.on("message_update", async (event, ctx) => {
    const chunk = await record(ctx, "assistant/chunk", normalizeAssistantEvent(event.assistantMessageEvent));
    if (chunk) currentStepChunkSeqs.push(chunk.seq);
  });
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role === "user") {
      await record(ctx, "user/message", { message: event.message }, { surfaceOp: "append" });
      return;
    }
    if (event.message.role === "assistant") {
      await record(ctx, "assistant/message", { message: event.message }, {
        surfaceOp: "append",
        sourceEventSeqs: currentStepChunkSeqs,
      });
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const call = await record(ctx, "tool/call", event, { critical: true, sync: true });
    if (call) toolCallSeqs.set(event.toolCallId, call.seq);
  });
  pi.on("tool_execution_start", async (event, ctx) => { await record(ctx, "tool/execution-start", event); });
  pi.on("tool_execution_update", async (event, ctx) => { await record(ctx, "tool/update", event); });
  pi.on("tool_execution_end", async (event, ctx) => { await record(ctx, "tool/execution-end", event); });
  pi.on("tool_result", async (event, ctx) => {
    const source = toolCallSeqs.get(event.toolCallId);
    await record(ctx, "tool/result", event, {
      surfaceOp: "append",
      sourceEventSeqs: source ? [source] : undefined,
      sync: true,
    });
    toolCallSeqs.delete(event.toolCallId);
  });

  pi.on("model_select", async (event, ctx) => { await record(ctx, "model/select", event); });
  pi.on("thinking_level_select", async (event, ctx) => { await record(ctx, "thinking/select", event); });
  pi.on("user_bash", async (event, ctx) => { await record(ctx, "user/bash", event); });
  pi.on("session_before_compact", async (event, ctx) => { await record(ctx, "compaction/start", event); });
  pi.on("session_compact", async (event, ctx) => { await record(ctx, "compaction/end", event, { sync: true }); });
  pi.on("session_before_tree", async (event, ctx) => { await record(ctx, "tree/start", event); });
  pi.on("session_tree", async (event, ctx) => { await record(ctx, "tree/end", event, { sync: true }); });
  pi.on("session_shutdown", async (event, ctx) => {
    await record(ctx, "session/end", event, { sync: true });
    await closeWriter();
  });

  pi.registerCommand("trajectory", {
    description: "Inspect, validate, tail, or export the current execution trajectory",
    handler: async (args, ctx) => {
      const active = await getWriter(ctx);
      await active.flush(true);
      const command = args.trim();
      if (!command || command === "status") {
        const result = await readTrajectory(active.path);
        if (!result.header) throw new Error("Trajectory header is missing");
        const summary = summarizeTrajectory(result.header, result.events, active.path);
        ctx.ui.notify(`${summary.eventCount} events · ${summary.runs} runs · ${summary.steps} steps · ${summary.toolCalls} tools\n${active.path}`, "info");
        return;
      }
      if (command === "path") {
        ctx.ui.notify(active.path, "info");
        return;
      }
      if (command === "validate") {
        const result = await readTrajectory(active.path);
        ctx.ui.notify(result.valid ? `Valid: ${result.events.length} contiguous events` : result.errors.join("\n"), result.valid ? "info" : "error");
        return;
      }
      if (command.startsWith("tail")) {
        const count = parseCount(command.split(/\s+/)[1], 10);
        const result = await readTrajectory(active.path);
        const text = result.events.slice(-count).map((event) => `#${event.seq} ${event.type}`).join("\n") || "No events";
        ctx.ui.notify(text, "info");
        return;
      }
      if (command.startsWith("export")) {
        const requested = command.slice("export".length).trim();
        const output = requested ? resolve(ctx.cwd, requested) : resolve(ctx.cwd, `trajectory-${safeFilename(active.header.sessionId)}.html`);
        const result = await readTrajectory(active.path);
        if (!result.header || !result.valid) throw new Error(result.errors.join("; ") || "Trajectory header is missing");
        await exportHtml(active.path, result.header, result.events, output);
        ctx.ui.notify(`Exported ${output}`, "info");
        return;
      }
      ctx.ui.notify("Usage: /trajectory [status|path|validate|tail [n]|export [file.html]]", "info");
    },
  });
}

function resolveDirectory(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return isAbsolute(value) ? value : resolve(value);
}

function safeFilename(value: string): string {
  const cleaned = basename(value).replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned || "session";
}

function parseCount(value: string | undefined, fallback: number): number {
  const count = Number.parseInt(value || "", 10);
  return Number.isFinite(count) && count > 0 ? Math.min(count, 100) : fallback;
}

function normalizeAssistantEvent(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const { partial: _partial, ...rest } = source;
  return rest;
}
