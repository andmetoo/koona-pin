import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { removePicture } from "./reader";

// An SVG as an <img> runs no script and loads nothing: the generated posters and previews are SVG.
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp|avif|svg\+xml)[;,]/i;
/** Answers kept for the session, by host: the check judges the host's addresses, not the path. */
const MAX_ANSWERS = 1000;
const answers = new Map<string, boolean>();
const pending = new Map<string, Promise<boolean | null>>();

/** The host a picture's address names, or null for one the WebView must not request at all. */
function hostOf(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.hostname : null;
}

/** What is known without asking: `undefined` while the host has no answer yet. */
function verdict(raw: string | null | undefined): boolean | undefined {
  const text = raw?.trim();
  if (!text) return false;
  if (DATA_IMAGE.test(text)) return true;
  const host = hostOf(text);
  return host === null ? false : answers.get(host);
}

function remember(host: string, answer: boolean) {
  if (answers.size >= MAX_ANSWERS) answers.delete(answers.keys().next().value!);
  answers.set(host, answer);
}

/**
 * Whether a picture can be placed in the WebView without an unchecked request.
 * The native check answers per host; a host it could not look up (offline, a
 * timeout) is refused for now and asked again later, not remembered.
 */
export function publicImage(raw: string | null | undefined): Promise<boolean> {
  const known = verdict(raw);
  if (known !== undefined) return Promise.resolve(known);
  const text = raw!.trim();
  const host = hostOf(text)!;
  let check = pending.get(host);
  if (!check) {
    check = api
      .checkPublicResource(text)
      .catch(() => null)
      .then((answer) => {
        pending.delete(host);
        if (answer !== null) remember(host, answer);
        return answer;
      });
    pending.set(host, check);
  }
  return check.then((answer) => answer === true);
}

/**
 * A picture's address once it passed the check, for a React `<img>`'s `src`.
 * A host already answered renders at once: a card that mounts again while the
 * list scrolls shows its picture, not its fallback for a frame.
 */
export function usePublicImage(raw: string | null | undefined): string | null {
  const [answer, setAnswer] = useState<{ raw: string; ok: boolean } | null>(null);
  const ok = verdict(raw) ?? (answer !== null && answer.raw === raw && answer.ok);
  useEffect(() => {
    if (!raw || verdict(raw) !== undefined) return;
    let alive = true;
    void publicImage(raw).then((passed) => alive && setAnswer({ raw, ok: passed }));
    return () => {
      alive = false;
    };
  }, [raw]);
  return ok && raw ? raw.trim() : null;
}

/** The addresses of a `srcset`, with their width or density. */
const candidates = (set: string | null) =>
  (set ?? "")
    .split(/,\s+/)
    .map((candidate) => candidate.trim())
    .filter(Boolean);

/**
 * An article's pictures by `allowed`: `srcset` keeps the candidates that pass,
 * a refused `src` falls back to the largest of them, a picture with none goes
 * (with its figure when it was the figure's only one, as `preparePictures`).
 */
function keepPictures(html: string, allowed: (raw: string) => boolean): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const set = candidates(img.getAttribute("srcset")).filter((candidate) => allowed(candidate.split(/\s+/)[0]));
    const src = img.getAttribute("src")?.trim() ?? "";
    const chosen = src && allowed(src) ? src : set.length ? set[set.length - 1].split(/\s+/)[0] : null;
    if (!chosen) {
      removePicture(img);
      continue;
    }
    img.setAttribute("src", chosen);
    if (set.length) img.setAttribute("srcset", set.join(", "));
    else img.removeAttribute("srcset");
  }
  return doc.body.innerHTML;
}

/** Every address an article's pictures would request. */
function pictureAddresses(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return Array.from(doc.querySelectorAll("img")).flatMap((img) => [
    img.getAttribute("src") ?? "",
    ...candidates(img.getAttribute("srcset")).map((candidate) => candidate.split(/\s+/)[0]),
  ]).filter(Boolean);
}

/** An article's HTML with only checked pictures: the hosts answered already at once, then all of them. */
export async function guardArticleHtml(html: string): Promise<string> {
  const addresses = [...new Set(pictureAddresses(html))];
  const passed = new Set<string>();
  await Promise.all(addresses.map(async (raw) => (await publicImage(raw)) && passed.add(raw)));
  return keepPictures(html, (raw) => passed.has(raw));
}

/**
 * The article's HTML for the page: its text at once, with the pictures whose
 * hosts already passed; the rest join once checked. Kept with the HTML it was
 * made from, so a new article never shows the previous one's body.
 */
export function useGuardedHtml(html: string | null): string {
  const now = useMemo(() => (html === null ? "" : keepPictures(html, (raw) => verdict(raw) === true)), [html]);
  const [checked, setChecked] = useState<{ source: string; html: string } | null>(null);
  useEffect(() => {
    if (html === null) return;
    let alive = true;
    void guardArticleHtml(html).then((safe) => alive && setChecked({ source: html, html: safe }));
    return () => {
      alive = false;
    };
  }, [html]);
  return checked?.source === html ? checked.html : now;
}
