import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import { Bookmark, CheckedLink, LinkCheckReport } from "../types";
import { checkedWhen, etaText, finishedLine, replacedNotice, resultLabel } from "./linkcheck";
import { demoAnswer } from "./demo";

const ru = i18n.getFixedT("ru");
const en = i18n.getFixedT("en");

const link = (status: number | null, reason: CheckedLink["reason"] = null): CheckedLink => ({
  bookmark: { id: 1, url: "https://example.com/" } as Bookmark,
  status,
  reason,
  target: null,
  conflict: false,
  checked_at: "2026-10-05T12:00:00.000Z",
});

describe("link check words (sheet 35)", () => {
  it("name what the site answered", () => {
    expect(resultLabel(ru, link(404), "gone")).toBe("404 · Не найдена");
    expect(resultLabel(ru, link(410), "gone")).toBe("410 · Удалена");
    expect(resultLabel(ru, link(301), "moved")).toBe("301 · Переехала");
    expect(resultLabel(ru, link(null, "timeout"), "failed")).toBe("Нет ответа за 10 с");
    expect(resultLabel(ru, link(null, "no_site"), "failed")).toBe("Сайт не найден");
    expect(resultLabel(ru, link(999, "status"), "failed")).toBe("Отказ · 999");
    expect(resultLabel(ru, link(503, "status"), "failed")).toBe("Ошибка сервера · 503");
    expect(resultLabel(en, link(429, "status"), "failed")).toBe("Too many requests · 429");
    expect(resultLabel(en, link(400, "status"), "failed")).toBe("Answer 400");
  });

  it("say when and how long", () => {
    const now = new Date(2026, 9, 5, 15, 0);
    expect(checkedWhen(ru, new Date(2026, 9, 5, 9, 0).toISOString(), "ru", now)).toBe("Проверено сегодня");
    expect(checkedWhen(en, new Date(2026, 9, 4, 9, 0).toISOString(), "en", now)).toBe("Checked yesterday");
    expect(etaText(ru, 200)).toBe("ещё ≈ 3 мин");
    expect(etaText(ru, 20)).toBe("меньше минуты");
    expect(etaText(ru, null)).toBeNull();
    const report = { library: 1248, unchecked: 0, open: 1226, local: 3, finished_at: new Date(2026, 9, 5, 14, 2).toISOString() } as LinkCheckReport;
    expect(finishedLine(ru, report, "ru", now)).toBe(
      "Проверено 1248 ссылок сегодня в 14:02 · 1226 открываются · 3 на этом компьютере или в локальной сети не запрашивались",
    );
  });

  it("count replaced addresses, and say why some were not", () => {
    expect(replacedNotice(ru, { replaced: 1, skipped: 0, address: "https://www.onorca.dev/", command: 3 })).toEqual({
      text: "Адрес заменён: onorca.dev",
      alert: false,
    });
    expect(replacedNotice(ru, { replaced: 12, skipped: 0, address: null, command: 3 }).text).toBe("Заменено 12 адресов");
    expect(replacedNotice(ru, { replaced: 12, skipped: 1, address: null, command: 3 }).text).toBe(
      "Заменено 12 адресов · не заменено 1: новый адрес уже сохранён",
    );
    expect(replacedNotice(ru, { replaced: 0, skipped: 1, address: null, command: null })).toEqual({
      text: "Не заменено: новый адрес уже есть в библиотеке",
      alert: true,
    });
  });
});

describe("the demo's made-up answers", () => {
  it("never request anything and stay the same for an address", () => {
    expect(demoAnswer("http://localhost:8080/").outcome).toBe("local");
    expect(demoAnswer("http://192.168.1.1/admin").outcome).toBe("local");
    expect(demoAnswer("not a url").outcome).toBe("local");
    const url = "https://www.archdaily.com/";
    expect(demoAnswer(url)).toEqual(demoAnswer(url));
    const outcomes = new Set(Array.from({ length: 60 }, (_, i) => demoAnswer(`https://example.com/${i}`).outcome));
    expect([...outcomes].sort()).toEqual(["failed", "gone", "moved", "ok"]);
  });
});
