import type { TrajectoryEvent, TrajectoryHeader, TrajectorySummary } from "./types.ts";

export function summarizeTrajectory(header: TrajectoryHeader, events: TrajectoryEvent[], path?: string): TrajectorySummary {
  const summary: TrajectorySummary = {
    sessionId: header.sessionId,
    path,
    eventCount: events.length,
    startedAt: header.createdAt,
    runs: 0,
    steps: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolErrors: 0,
    interrupted: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  for (const event of events) {
    const data = asRecord(event.data);
    if (event.type === "run/start") summary.runs++;
    if (event.type === "step/start") summary.steps++;
    if (event.type === "user/message") summary.userMessages++;
    if (event.type === "assistant/message") {
      summary.assistantMessages++;
      addUsage(summary, asRecord(data.message ?? data).usage);
    }
    if (event.type === "tool/call") summary.toolCalls++;
    if (event.type === "tool/result" && data.isError === true) summary.toolErrors++;
    if (event.type === "recovery/interrupted") summary.interrupted++;
    if (event.type === "model/select") summary.latestModel = modelName(data.model);
    if (event.type === "session/end") summary.endedAt = event.time;
  }
  if (!summary.latestModel) {
    const request = [...events].reverse().find((event) => event.type === "request/context");
    if (request) summary.latestModel = modelName(asRecord(request.data).model);
  }
  const lastTime = summary.endedAt ?? events.at(-1)?.time;
  if (lastTime) summary.durationMs = Math.max(0, Date.parse(lastTime) - Date.parse(header.createdAt));
  return summary;
}

export function latestRequestContext(events: TrajectoryEvent[]): TrajectoryEvent | undefined {
  return [...events].reverse().find((event) => event.type === "request/context");
}

function addUsage(summary: TrajectorySummary, value: unknown): void {
  const usage = asRecord(value);
  summary.inputTokens += firstNumber(usage.input, usage.inputTokens);
  summary.outputTokens += firstNumber(usage.output, usage.outputTokens);
  summary.cacheReadTokens += firstNumber(usage.cacheRead, usage.cacheReadTokens);
  summary.cacheWriteTokens += firstNumber(usage.cacheWrite, usage.cacheWriteTokens);
}

function modelName(value: unknown): string | undefined {
  const model = asRecord(value);
  const id = typeof model.id === "string" ? model.id : undefined;
  const provider = typeof model.provider === "string" ? model.provider : undefined;
  return id ? (provider ? `${provider}/${id}` : id) : undefined;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function firstNumber(...values: unknown[]): number {
  const value = values.find((candidate) => typeof candidate === "number" && Number.isFinite(candidate));
  return number(value);
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}
