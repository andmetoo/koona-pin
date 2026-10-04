import i18n from "../i18n";
import type { CommandErrorData, ErrorCode } from "../types";

/**
 * A failed command: the machine `code` decides what the interface does, the
 * `message` is for people. `String(error)` gives the message, without the
 * "Error:" prefix.
 */
export class CommandError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
  override toString() {
    return this.message;
  }
}

const isData = (value: unknown): value is CommandErrorData =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as CommandErrorData).code === "string" &&
  typeof (value as CommandErrorData).message === "string";

/** Commands reject with `{ code, message }`; Tauri itself rejects with text. */
export function toCommandError(error: unknown): CommandError {
  if (error instanceof CommandError) return error;
  if (isData(error)) return new CommandError(error.code, error.message);
  return new CommandError("internal", error instanceof Error ? error.message : String(error));
}

/** Storage failures that get an explanation instead of SQLite text. */
const explained: ErrorCode[] = ["disk_full", "read_only", "database_busy"];

/**
 * The reason in the middle of a sentence: «Не удалось … : библиотека занята.
 * Ничего не изменено.» (frame 27). Codes without words keep the message.
 */
export function reasonOf(error: unknown): string {
  const failure = toCommandError(error);
  const known = ["disk_full", "read_only", "database_busy", "not_found", "conflict"] as const;
  const code = known.find((c) => c === failure.code);
  return code ? i18n.t(`errors.reason.${code}`) : failure.message.replace(/\.$/, "");
}

/** Text for people: storage failures are explained, the rest keep their message. */
export function describeError(error: unknown): string {
  const failure = toCommandError(error);
  return explained.includes(failure.code)
    ? i18n.t(`errors.${failure.code as "disk_full" | "read_only" | "database_busy"}`)
    : failure.message;
}
