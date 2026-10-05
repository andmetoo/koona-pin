import { expect, it, vi } from "vitest";

// A machine in another language (the CI runner is English) must not change a
// Russian sentence: the reason inside it follows the sentence's `t`.
it("speaks the reason in the language of the sentence, not of the system", async () => {
  vi.stubGlobal("navigator", { language: "en-US", languages: ["en-US"] });
  const { default: i18n } = await import("../i18n");
  const { bulkFailure } = await import("./bulk");
  expect(i18n.language).toBe("en");
  const busy = { code: "database_busy", message: "database is locked" };
  expect(bulkFailure(i18n.getFixedT("ru"), { action: "move", collection_id: 1 }, 4, busy, "Работа")).toBe(
    "Не удалось переместить 4 закладки в «Работа»: библиотека занята. Ничего не изменено.",
  );
  vi.unstubAllGlobals();
});
