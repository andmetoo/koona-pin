import type { TFunction } from "i18next";
import { CheckedLink, LinkCheckReport, Replaced } from "../types";

/**
 * The chip of a result (sheet 35): what the site answered, in words. Neutral
 * in colour: a site that went away is not an error of the app.
 */
export function resultLabel(t: TFunction, link: CheckedLink, group: "gone" | "moved" | "failed"): string {
  const status = link.status;
  if (group === "gone") return status === 410 ? t("links.chipGone", { status }) : t("links.chipNotFound", { status: status ?? 404 });
  if (group === "moved") return status ? t("links.chipMoved", { status }) : t("links.chipMovedPlain");
  switch (link.reason) {
    case "timeout":
      return t("links.chipTimeout");
    case "no_site":
      return t("links.chipNoSite");
    case "network":
      return t("links.chipNetwork");
    case "redirects":
      return t("links.chipRedirects");
    default:
      if (status === 429) return t("links.chipTooMany", { status });
      // 999 is LinkedIn's way to refuse automatic requests, not a server error.
      if (status === 401 || status === 403 || status === 999) return t("links.chipRefused", { status });
      if (status !== null && status >= 500 && status < 600) return t("links.chipServer", { status });
      return t("links.chipStatus", { status });
  }
}

/** «Проверено сегодня», «вчера», «4 окт.». */
export function checkedWhen(t: TFunction, iso: string, language: string, now = new Date()): string {
  const date = new Date(iso);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000);
  if (days === 0) return t("links.checkedToday");
  if (days === 1) return t("links.checkedYesterday");
  const sameYear = date.getFullYear() === now.getFullYear();
  return t("links.checkedOn", { date: date.toLocaleDateString(language, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) }) });
}

/** «ещё ≈ 3 мин»; under a minute — «меньше минуты». */
export function etaText(t: TFunction, seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds < 60) return t("links.etaSoon");
  return t("links.eta", { count: Math.round(seconds / 60) });
}

/** The strip after a check: when, how many open, how many were not requested. */
export function finishedLine(t: TFunction, report: LinkCheckReport, language: string, now = new Date()): string {
  const parts = [t("links.checked", { count: report.library - report.unchecked, when: when(t, report.finished_at, language, now) })];
  parts.push(t("links.open", { count: report.open }));
  if (report.local > 0) parts.push(t("links.local", { count: report.local }));
  return parts.join(" · ");
}

function when(t: TFunction, iso: string | null, language: string, now: Date) {
  if (!iso) return "";
  const date = new Date(iso);
  const time = date.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" });
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay ? t("links.todayAt", { time }) : t("links.onDate", { date: date.toLocaleDateString(language, { day: "numeric", month: "short" }) });
}

/** The notice after «Заменить адрес» / «Заменить все». */
export function replacedNotice(t: TFunction, replaced: Replaced): { text: string; alert: boolean } {
  if (replaced.replaced === 0) return { text: t("links.notReplaced"), alert: true };
  if (replaced.replaced === 1 && replaced.skipped === 0 && replaced.address) {
    let site = replaced.address;
    try {
      site = new URL(replaced.address).hostname.replace(/^www\./, "");
    } catch {
      /* The address as it is. */
    }
    return { text: t("links.replacedOne", { site }), alert: false };
  }
  if (replaced.skipped > 0) return { text: t("links.replacedSome", { count: replaced.replaced, skipped: replaced.skipped }), alert: false };
  return { text: t("links.replacedMany", { count: replaced.replaced }), alert: false };
}

/** Rows a group shows before «Показать ещё N». */
export const FIRST_ROWS = 3;
