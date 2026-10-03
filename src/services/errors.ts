import type { CommandErrorData, ErrorCode } from "../types";
import { language } from "./libraryMessages";

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
  return new CommandError(
    "internal",
    error instanceof Error ? error.message : String(error),
  );
}

const explained: Partial<Record<ErrorCode, { ru: string; en: string }>> = {
  disk_full: {
    ru: "На диске закончилось место — изменения не сохранены.",
    en: "The disk is full — the changes were not saved.",
  },
  read_only: {
    ru: "Библиотека повреждена и открыта только для чтения — изменения не сохраняются.",
    en: "The library is damaged and open read-only — changes are not saved.",
  },
  database_busy: {
    ru: "Библиотека занята другой программой. Повторите через несколько секунд.",
    en: "Another program is using the library. Try again in a few seconds.",
  },
};

/** Text for people: storage failures get an explanation, the rest keep their message. */
export function describeError(error: unknown): string {
  const failure = toCommandError(error);
  return explained[failure.code]?.[language()] ?? failure.message;
}
