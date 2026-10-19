import type { Page } from "@playwright/test";

/**
 * Interface text on a phone that is cut or overlaps (NP-072b: large text, long languages): what
 * the person sees now — the top screen, the open sheets, the nav pill or the rail. A text is cut
 * when it reaches past an ancestor that hides its overflow or past the window's sides, or ends in
 * an ellipsis; it overlaps when its glyphs cross another text in the same header, sheet bar,
 * segmented switch, shelf row, decision pill or rail menu. Bookmarks and posts in lists and
 * their data (`[data-user-text]`) may be cut by design, as on the desktop (tests/ui/languages.spec.ts).
 * Returns one line per problem.
 */
export function labelProblems(page: Page) {
  return page.evaluate(() => {
    const problems: string[] = [];
    const DATA = "[data-user-text], [data-bookmark-id], [data-feed-item-id], [data-post-id], [data-triage-card]";
    /** Search fields' hints end in an ellipsis as any field's placeholder does. */
    const HINT = ".lib-search";
    const layers = [
      ...document.querySelectorAll<HTMLElement>("[data-screen]:not([hidden]), [data-sheet-kind]:not([data-leaving]), [data-navpill]:not([data-hidden]), [data-rail], [data-rail-menu]"),
    ];
    const name = (el: Element) => (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
    const visible = (el: HTMLElement) => {
      for (let n: HTMLElement | null = el; n; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
        // A text clamped to its lines (a bookmark's title over a sheet) is cut by design.
        if (s.webkitLineClamp !== "none") return false;
      }
      return true;
    };
    /** The glyph boxes of an element's own text, shrunk by 1.5 px: line boxes of tight type touch. */
    const rects = (el: Element) => {
      const out: DOMRect[] = [];
      for (const node of el.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE || !node.textContent!.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) out.push(new DOMRect(r.x + 1.5, r.y + 1.5, r.width - 3, r.height - 3));
      }
      return out;
    };
    const texts = new Set<HTMLElement>();
    for (const layer of layers)
      for (const el of layer.querySelectorAll<HTMLElement>("*")) {
        // Text for screen readers only (`sr-only`) is not seen.
        if (el.closest(DATA) || el.closest("[aria-hidden='true'], .sr-only") || !rects(el).length || !visible(el)) continue;
        texts.add(el);
      }

    for (const el of texts) {
      const style = getComputedStyle(el);
      if (style.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1 && !el.closest(HINT)) problems.push(`ends in an ellipsis: «${name(el)}»`);
      const own = rects(el);
      const boxes: { box: DOMRect; what: string }[] = [];
      // Past a box that scrolls (a row of chips sideways, a screen down) the text is a swipe away:
      // what clips beyond that box clips the box, not the text.
      let scrollsX = false;
      let scrollsY = false;
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        const s = getComputedStyle(n);
        const clips = (v: string) => v === "hidden" || v === "clip";
        const x = !scrollsX && clips(s.overflowX);
        const y = !scrollsY && clips(s.overflowY);
        if (x || y) {
          const b = n.getBoundingClientRect();
          // A side that does not clip reaches as far as it likes.
          boxes.push({
            box: new DOMRect(x ? b.x : -1e6, y ? b.y : -1e6, x ? b.width : 2e6, y ? b.height : 2e6),
            what: `.${String(n.className).split(" ").join(".")}`,
          });
        }
        if (s.overflowX === "auto" || s.overflowX === "scroll") scrollsX = true;
        if (s.overflowY === "auto" || s.overflowY === "scroll") scrollsY = true;
      }
      if (!scrollsX) boxes.push({ box: new DOMRect(0, -1e6, innerWidth, 2e6), what: "the window" });
      // A control's label stays inside the control (a pill's segment, a button, a chip).
      const control = el.closest("button, [role='radio'], [role='menuitem'], .ph-chip");
      if (control) boxes.push({ box: control.getBoundingClientRect(), what: "its control" });
      for (const r of own)
        for (const { box, what } of boxes)
          if (r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5) {
            problems.push(`cut by ${what}: «${name(el)}»`);
            break;
          }
    }

    const groups = document.querySelectorAll(
      ".ph-header-bar, .ph-header, .ph-sheet-bar, .ph-sheet-head, .ph-segmented, .ph-shelf-row, [data-decision-pill], [data-rail-menu], .ph-button, .ph-chip",
    );
    const seen = new Set<string>();
    for (const group of groups) {
      // The header's buttons and its title are two siblings: one group.
      const scope = [group];
      if (group.classList.contains("ph-header-bar") && group.nextElementSibling) scope.push(group.nextElementSibling);
      const inside = [...texts].filter((el) => scope.some((s) => s.contains(el)));
      for (let i = 0; i < inside.length; i++)
        for (let j = i + 1; j < inside.length; j++) {
          const [a, b] = [inside[i], inside[j]];
          if (a.contains(b) || b.contains(a)) continue;
          const hit = rects(a).some((p) => rects(b).some((q) => p.left < q.right && q.left < p.right && p.top < q.bottom && q.top < p.bottom));
          const key = `«${name(a)}» and «${name(b)}»`;
          if (hit && !seen.has(key)) {
            seen.add(key);
            problems.push(`overlap: ${key}`);
          }
        }
    }
    return problems;
  });
}
