// Files the pages link, built by Vite with a hash in their name under /pin/_astro/ (NP-115): a deploy
// that changes a file changes its address, so Caddy and Cloudflare may keep them long. The screenshots
// are also copied to /pin/shots/ under their own names by build-site.mjs: AppStream points there.
import favicon from "../../design/brand/pin-spirit-flat/pin-spirit-micro.svg?url";
import mascotLight from "../../design/brand/pin-spirit-flat/pin-spirit.svg?url";
import mascotDark from "../../design/brand/pin-spirit-flat/pin-spirit-mint.svg?url";
import favicon32 from "../../src-tauri/icons/32x32.png?url";
import touchIcon from "../../src-tauri/icons/128x128@2x.png?url";
import interLatin from "@inter/inter-latin-wght-normal.woff2?url";

export { favicon, favicon32, interLatin, mascotDark, mascotLight, touchIcon };

const files = import.meta.glob("./shots/*.{webp,jpg}", { query: "?url", import: "default", eager: true });
/** Built address of a screenshot by its file name: "app-en-light-grid.webp" → "/pin/_astro/app-en-light-grid.Ab12.webp". */
export const shots = Object.fromEntries(Object.entries(files).map(([file, url]) => [file.slice("./shots/".length), url]));

/** A screenshot in the page's language where it was shot (English and Russian), English otherwise. */
export const localized = (name, lang) => (name.replace("{lang}", lang) in shots ? name.replace("{lang}", lang) : name.replace("{lang}", "en"));
