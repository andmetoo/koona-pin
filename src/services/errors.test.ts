import { describe, expect, it } from "vitest";
import { CommandError, describeError, toCommandError } from "./errors";

describe("command errors", () => {
  it("keeps the code and message sent by Rust", () => {
    const error = toCommandError({ code: "not_found", message: "Нет записи" });
    expect(error).toBeInstanceOf(CommandError);
    expect(error.code).toBe("not_found");
    expect(String(error)).toBe("Нет записи");
  });
  it("treats text from Tauri and plain errors as internal", () => {
    expect(toCommandError("state not managed").code).toBe("internal");
    const plain = toCommandError(new Error("Не удалось записать ссылку"));
    expect([plain.code, String(plain)]).toEqual([
      "internal",
      "Не удалось записать ссылку",
    ]);
  });
  it("explains storage failures instead of SQLite text", () => {
    const full = { code: "disk_full", message: "database or disk is full" };
    expect(describeError(full)).not.toContain("database or disk");
    expect(describeError({ code: "conflict", message: "Такая коллекция уже есть" })).toBe(
      "Такая коллекция уже есть",
    );
  });
});
