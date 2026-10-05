import type { TFunction } from "i18next";
import i18n from "../i18n";
import type { CommandErrorData, ErrorCode, ErrorDetail } from "../types";

/**
 * A failed command: the machine `code` decides what the interface does,
 * `detail` says more when there is more to say. The `message` is English, for
 * the log; people read `describeError` (NP-085). `String(error)` gives the
 * message, without the "Error:" prefix.
 */
export class CommandError extends Error {
  readonly code: ErrorCode;
  readonly detail?: ErrorDetail;
  constructor(code: ErrorCode, message: string, detail?: ErrorDetail) {
    super(message);
    this.name = "CommandError";
    this.code = code;
    this.detail = detail;
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
  if (isData(error)) return new CommandError(error.code, error.message, error.detail);
  return new CommandError("internal", error instanceof Error ? error.message : String(error));
}

/** Storage failures that get an explanation instead of SQLite text. */
const explained: ErrorCode[] = ["disk_full", "read_only", "database_busy"];

/**
 * The reason in the middle of a sentence: «Couldn't … : the library is busy.
 * Nothing changed.» (frame 27). A failure without words of its own keeps the
 * app's English text as a technical detail. `t` is the sentence's own: the
 * reason speaks its language.
 */
export function reasonOf(error: unknown, t: TFunction = i18n.t): string {
  const failure = toCommandError(error);
  if (failure.detail) return t(`errors.reason.${failure.detail}`);
  const known = ["disk_full", "read_only", "database_busy", "not_found", "conflict", "invalid_request"] as const;
  const code = known.find((c) => c === failure.code);
  return code ? t(`errors.reason.${code}`) : t("errors.reason.internal", { message: failure.message.replace(/\.$/, "") });
}

/**
 * Text for people, in the interface's language: what exactly went wrong when
 * the command says (`detail`), else what its code means. A failure without
 * words of its own keeps the English text of the app as a technical detail.
 */
export function describeError(error: unknown): string {
  const failure = toCommandError(error);
  if (failure.detail) return i18n.t(`errors.detail.${failure.detail}`);
  if (explained.includes(failure.code))
    return i18n.t(`errors.${failure.code as "disk_full" | "read_only" | "database_busy"}`);
  if (failure.code === "not_found" || failure.code === "conflict" || failure.code === "invalid_request")
    return i18n.t(`errors.code.${failure.code}`);
  return i18n.t("errors.code.internal", { message: failure.message.replace(/\.$/, "") });
}
