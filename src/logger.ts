import type { LogFields, Logger } from "./types.js";

type Level = "info" | "warn" | "error";

const bigintToString = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

/**
 * One JSON object per line: {ts, level, event, ...fields}. Bigints are written as strings.
 * `ts`, `level` and `event` are reserved field names.
 */
export function createJsonLogger(
  write: (line: string) => void,
  now: () => string = () => new Date().toISOString(),
): Logger {
  const emit = (level: Level, event: string, fields: LogFields = {}): void => {
    write(JSON.stringify({ ts: now(), level, event, ...fields }, bigintToString));
  };
  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}

const ignore = (): void => undefined;

export const noopLogger: Logger = { info: ignore, warn: ignore, error: ignore };

export interface LogRecord {
  readonly level: Level;
  readonly event: string;
  readonly fields: LogFields;
}

export function createRecordingLogger(): { logger: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const record =
    (level: Level) =>
    (event: string, fields: LogFields = {}): void => {
      records.push({ level, event, fields });
    };
  return {
    logger: { info: record("info"), warn: record("warn"), error: record("error") },
    records,
  };
}
