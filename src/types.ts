export const SCHEMA_VERSION = 1 as const;

export interface TrajectoryHeader {
  type: "trajectory/session";
  schemaVersion: typeof SCHEMA_VERSION;
  sessionId: string;
  createdAt: string;
  cwd: string;
  piSessionFile?: string;
  pluginVersion: string;
}

export type SurfaceOperation = "append";

export interface TrajectoryEvent {
  type: string;
  schemaVersion: typeof SCHEMA_VERSION;
  sessionId: string;
  seq: number;
  time: string;
  data: unknown;
  sourceEventSeqs?: number[];
  surfaceOp?: SurfaceOperation;
}

export type TrajectoryRecord = TrajectoryHeader | TrajectoryEvent;

export interface AppendOptions {
  sync?: boolean;
  sourceEventSeqs?: number[];
  surfaceOp?: SurfaceOperation;
}

export interface TrajectorySummary {
  sessionId: string;
  path?: string;
  eventCount: number;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  runs: number;
  steps: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolErrors: number;
  interrupted: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latestModel?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  header?: TrajectoryHeader;
  events: TrajectoryEvent[];
}
