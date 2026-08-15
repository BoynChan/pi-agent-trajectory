#!/usr/bin/env node
import { resolve } from "node:path";
import { exportHtml } from "./export.ts";
import { summarizeTrajectory } from "./projector.ts";
import { readTrajectory } from "./store.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((arg) => !arg.startsWith("-"));
  if (!file || args.includes("--help") || args.includes("-h")) {
    console.log("Usage: pi-trajectory <file.jsonl> [--json] [--tail N] [--html output.html]");
    process.exitCode = file ? 0 : 1;
    return;
  }
  const path = resolve(file);
  const result = await readTrajectory(path);
  if (!result.valid || !result.header) {
    console.error(result.errors.join("\n") || "Missing trajectory header");
    process.exitCode = 2;
    return;
  }
  const htmlIndex = args.indexOf("--html");
  if (htmlIndex >= 0) {
    const output = args[htmlIndex + 1];
    if (!output) throw new Error("--html requires an output path");
    await exportHtml(path, result.header, result.events, resolve(output));
    console.log(resolve(output));
    return;
  }
  const tailIndex = args.indexOf("--tail");
  if (tailIndex >= 0) {
    const count = Math.max(1, Math.min(1000, Number.parseInt(args[tailIndex + 1] || "10", 10) || 10));
    for (const event of result.events.slice(-count)) console.log(`#${event.seq}\t${event.time}\t${event.type}`);
    return;
  }
  const summary = summarizeTrajectory(result.header, result.events, path);
  if (args.includes("--json")) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`Session: ${summary.sessionId}`);
    console.log(`Events: ${summary.eventCount} · Runs: ${summary.runs} · Steps: ${summary.steps}`);
    console.log(`Messages: ${summary.userMessages} user / ${summary.assistantMessages} assistant`);
    console.log(`Tools: ${summary.toolCalls} calls / ${summary.toolErrors} errors`);
    console.log(`Tokens: ${summary.inputTokens} input / ${summary.outputTokens} output`);
    console.log(`Valid: yes`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
