export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
type Fields = Record<string, unknown>;

const PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
};

let threshold = PRIORITY.info;
let jsonFormat = false;

export function isLogLevel(value: string): value is LogLevel {
  return value in PRIORITY;
}

export function configureLogger(options: { level?: LogLevel; json?: boolean }): void {
  if (options.level) threshold = PRIORITY[options.level];
  if (options.json !== undefined) jsonFormat = options.json;
}

function write(level: Exclude<LogLevel, "silent">, event: string, fields?: Fields): void {
  if (PRIORITY[level] < threshold) return;
  const time = new Date().toISOString();
  const hasFields = fields !== undefined && Object.keys(fields).length > 0;
  const line = jsonFormat
    ? JSON.stringify({ time, level, event, ...fields })
    : `${time} ${level.toUpperCase().padEnd(5)} ${event}${hasFields ? ` ${JSON.stringify(fields)}` : ""}`;
  if (level === "warn" || level === "error") console.error(line);
  else console.log(line);
}

/**
 * Structured logger: every entry is an event name plus metadata (IDs, codes,
 * timings). Message content and secrets are deliberately never logged.
 */
export const logger = {
  debug: (event: string, fields?: Fields) => write("debug", event, fields),
  info: (event: string, fields?: Fields) => write("info", event, fields),
  warn: (event: string, fields?: Fields) => write("warn", event, fields),
  error: (event: string, fields?: Fields) => write("error", event, fields)
};

export function describeError(error: unknown): Fields {
  if (!(error instanceof Error)) return { errorName: "UnknownError" };
  const extra = error as Error & { code?: unknown; status?: unknown };
  return {
    errorName: error.name,
    errorMessage: error.message.slice(0, 300),
    ...(typeof extra.code === "string" || typeof extra.code === "number" ? { errorCode: extra.code } : {}),
    ...(typeof extra.status === "number" ? { status: extra.status } : {})
  };
}
