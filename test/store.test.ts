import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readTrajectory, TrajectoryWriter } from "../src/store.ts";

async function tempPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "pi-trajectory-")), "session.jsonl");
}

test("writes a header and contiguous events, then resumes the sequence", async () => {
  const path = await tempPath();
  let writer = await TrajectoryWriter.open({ path, sessionId: "s1", cwd: "/tmp", pluginVersion: "test" });
  await writer.append("run/start");
  await writer.append("run/end", {}, { sync: true });
  await writer.close();
  writer = await TrajectoryWriter.open({ path, sessionId: "s1", cwd: "/tmp", pluginVersion: "test" });
  await writer.append("session/end");
  await writer.close();
  const result = await readTrajectory(path);
  assert.equal(result.valid, true);
  assert.deepEqual(result.events.map((event) => event.seq), [1, 2, 3]);
});

test("repairs a torn final JSON line", async () => {
  const path = await tempPath();
  let writer = await TrajectoryWriter.open({ path, sessionId: "s2", cwd: "/tmp", pluginVersion: "test" });
  await writer.append("session/end");
  await writer.close();
  await appendFile(path, '{"type":"broken"');
  writer = await TrajectoryWriter.open({ path, sessionId: "s2", cwd: "/tmp", pluginVersion: "test" });
  await writer.append("session/start");
  await writer.close();
  const result = await readTrajectory(path);
  assert.equal(result.valid, true);
  assert.deepEqual(result.events.map((event) => event.type), ["session/end", "session/start"]);
  assert.ok((await readFile(path, "utf8")).endsWith("\n"));
});

test("preserves a complete final record that only lacks a newline", async () => {
  const path = await tempPath();
  let writer = await TrajectoryWriter.open({ path, sessionId: "s2b", cwd: "/tmp", pluginVersion: "test" });
  await writer.append("session/end");
  await writer.close();
  const contents = await readFile(path, "utf8");
  await writeFile(path, contents.trimEnd());
  writer = await TrajectoryWriter.open({ path, sessionId: "s2b", cwd: "/tmp", pluginVersion: "test" });
  await writer.append("session/start");
  await writer.close();
  const result = await readTrajectory(path);
  assert.equal(result.valid, true);
  assert.deepEqual(result.events.map((event) => event.type), ["session/end", "session/start"]);
});

test("balances interrupted run, step, and tool calls on reopen", async () => {
  const path = await tempPath();
  let writer = await TrajectoryWriter.open({ path, sessionId: "s3", cwd: "/tmp", pluginVersion: "test" });
  await writer.append("run/start");
  await writer.append("step/start");
  await writer.append("tool/call", { toolCallId: "tool-1" });
  await writer.close();
  writer = await TrajectoryWriter.open({ path, sessionId: "s3", cwd: "/tmp", pluginVersion: "test" });
  await writer.close();
  const result = await readTrajectory(path);
  assert.equal(result.valid, true);
  assert.deepEqual(result.events.slice(-4).map((event) => event.type), [
    "recovery/interrupted", "tool/result", "step/end", "run/end",
  ]);
});
