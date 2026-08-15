const MAX_DEPTH = 80;

export function jsonSafe(value: unknown): unknown {
  const seen = new WeakSet<object>();

  function visit(current: unknown, depth: number): unknown {
    if (depth > MAX_DEPTH) return "[MaxDepth]";
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number") return Number.isFinite(current) ? current : String(current);
    if (typeof current === "bigint") return current.toString();
    if (typeof current === "undefined") return undefined;
    if (typeof current === "function") return `[Function ${current.name || "anonymous"}]`;
    if (typeof current === "symbol") return current.toString();
    if (current instanceof Date) return current.toISOString();
    if (current instanceof Error) {
      return { name: current.name, message: current.message, stack: current.stack };
    }
    if (Buffer.isBuffer(current)) return { type: "Buffer", data: current.toString("base64") };
    if (ArrayBuffer.isView(current)) return Array.from(new Uint8Array(current.buffer, current.byteOffset, current.byteLength));
    if (current instanceof ArrayBuffer) return Array.from(new Uint8Array(current));
    if (typeof current !== "object") return String(current);
    if (seen.has(current)) return "[Circular]";
    seen.add(current);
    try {
      if (Array.isArray(current)) return current.map((item) => visit(item, depth + 1));
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(current)) result[key] = visit(item, depth + 1);
      return result;
    } finally {
      seen.delete(current);
    }
  }

  return visit(value, 0);
}

export function jsonLine(value: unknown): string {
  return `${JSON.stringify(jsonSafe(value))}\n`;
}
