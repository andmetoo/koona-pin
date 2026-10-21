import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import { CommandError, describeError, reasonOf, toCommandError } from "./errors";

describe("command errors", () => {
  it("keeps the code, message and detail sent by Rust", () => {
    const error = toCommandError({ code: "not_found", message: "No such row", detail: "not_in_trash" });
    expect(error).toBeInstanceOf(CommandError);
    expect([error.code, error.detail, String(error)]).toEqual(["not_found", "not_in_trash", "No such row"]);
  });
  it("treats text from Tauri and plain errors as internal", () => {
    expect(toCommandError("state not managed").code).toBe("internal");
    const plain = toCommandError(new Error("Could not write the link"));
    expect([plain.code, String(plain)]).toEqual(["internal", "Could not write the link"]);
  });
  it("speaks the interface's language, never the app's English text alone (NP-085)", async () => {
    const empty = { code: "invalid_request", message: "Enter a collection name", detail: "empty_collection_name" };
    const conflict = { code: "conflict", message: "UNIQUE constraint failed: collections.name" };
    const full = { code: "disk_full", message: "database or disk is full" };
    const broken = { code: "internal", message: "The system cannot find the file." };
    await i18n.changeLanguage("en");
    expect(describeError(empty)).toBe("Enter a collection name.");
    expect(describeError(conflict)).toBe("That name is taken.");
    expect(describeError(full)).not.toContain("database or disk");
    expect(describeError(broken)).toBe("Something went wrong: The system cannot find the file");
    expect(reasonOf(empty)).toBe("the name is empty");
    await i18n.changeLanguage("ru");
    expect(describeError(empty)).toBe("Введите название коллекции.");
    expect(describeError(conflict)).toBe("Такое название уже есть.");
    expect(reasonOf(empty, i18n.getFixedT("ru"))).toBe("пустое название");
    await i18n.changeLanguage("en");
  });
  // English is enough: locales.test.ts keeps every other language's keys in step with it.
  it("has words for every detail and code", () => {
    const details = ["empty_tag", "empty_collection_name", "empty_title", "bookmark_gone", "not_in_trash", "invalid_url", "unsupported_url", "nothing_exported", "copy_gone", "library_opening", "empty_message", "message_too_long", "invalid_email", "no_connection", "service_failed", "too_many_messages", "proxy_failed", "no_connection_or_proxy", "no_connection_or_system_proxy", "fresh_sign_in", "review_account", "no_paid_time", "payments_not_stopped"];
    for (const key of [
      ...details.flatMap((d) => [`errors.detail.${d}`, `errors.reason.${d}`]),
      ...["not_found", "conflict", "invalid_request", "internal"].map((c) => `errors.code.${c}`),
      "errors.reason.invalid_request",
      "errors.reason.internal",
    ])
      expect(i18n.exists(key, { lng: "en", fallbackLng: [] }), key).toBe(true);
  });
});
