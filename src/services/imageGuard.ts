import { useEffect, useState } from "react";
import type { Article } from "./reader";
import { api } from "./api";

const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp|avif)[;,]/i;
const checks = new Map<string, Promise<boolean>>();

/** Whether an image can be placed in the WebView without making an unchecked request. */
export function publicImage(raw: string | null | undefined): Promise<boolean> {
  if (!raw) return Promise.resolve(false);
  if (DATA_IMAGE.test(raw.trim())) return Promise.resolve(true);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return Promise.resolve(false);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return Promise.resolve(false);
  const known = checks.get(raw);
  if (known) return known;
  const check = api.checkPublicResource(raw).catch(() => false);
  checks.set(raw, check);
  return check;
}

/** Checks an image URL before a React `<img>` gets a `src`. */
export function usePublicImage(raw: string | null | undefined): string | null {
  const [safe, setSafe] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSafe(null);
    publicImage(raw).then((ok) => alive && ok && setSafe(raw!.trim()));
    return () => {
      alive = false;
    };
  }, [raw]);
  return safe;
}

/** Removes all unchecked image requests while a reader article is being validated. */
export async function guardArticleImages(article: Article): Promise<Article> {
  const doc = new DOMParser().parseFromString(article.html, "text/html");
  const images = Array.from(doc.querySelectorAll("img"));
  await Promise.all(
    images.map(async (image) => {
      const src = image.getAttribute("src");
      image.removeAttribute("srcset");
      if (!(await publicImage(src))) image.remove();
    }),
  );
  return { ...article, html: doc.body.innerHTML };
}
