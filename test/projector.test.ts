import assert from "node:assert/strict";
import test from "node:test";
import { latestRequestContext, summarizeTrajectory } from "../src/projector.ts";
import type { TrajectoryEvent, TrajectoryHeader } from "../src/types.ts";

const header: TrajectoryHeader = {
  type: "trajectory/session", schemaVersion: 1, sessionId: "s1", createdAt: "2026-01-01T00:00:00.000Z", cwd: "/tmp", pluginVersion: "test",
};

function event(seq: number, type: string, data: unknown = {}): TrajectoryEvent {
  return { type, schemaVersion: 1, sessionId: "s1", seq, time: `2026-01-01T00:00:0${seq}.000Z`, data };
}

test("projects counts, usage, latest model, and latest request", () => {
  const events = [
    event(1, "run/start"),
    event(2, "step/start"),
    event(3, "request/context", { model: { provider: "openai", id: "gpt-test" }, messages: [] }),
    event(4, "user/message"),
    event(5, "assistant/message", { message: { usage: { input: 12, output: 4, cacheRead: 3 } } }),
    event(6, "tool/call"),
    event(7, "tool/result", { isError: true }),
    event(8, "session/end"),
  ];
  const summary = summarizeTrajectory(header, events);
  assert.equal(summary.runs, 1);
  assert.equal(summary.steps, 1);
  assert.equal(summary.toolErrors, 1);
  assert.equal(summary.inputTokens, 12);
  assert.equal(summary.outputTokens, 4);
  assert.equal(summary.latestModel, "openai/gpt-test");
  assert.equal(latestRequestContext(events)?.seq, 3);
});
