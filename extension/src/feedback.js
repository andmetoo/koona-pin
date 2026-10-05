// What the toolbar button and the page show after a click (NP-080, sheet 36, Р-39).
// The button draws its own frames and state marks through action.setIcon: the
// badge text font cannot draw a clock reliably, and all states should look alike.

/** The four answers to a click. */
export const STATES = ["saved", "existing", "queued", "failed"];

/** Saved, already there, waiting, can't save: the mark in the icon's corner. */
export const MARKS = {
  saved: "ok",
  existing: "soft",
  queued: "wait",
  failed: "err",
};

/** Badge colours on the icon: one set for light and dark toolbars. */
export const BADGES = {
  ok: { fill: "#2f6b4f", ink: "#ffffff", glyph: "check" },
  soft: { fill: "#dcebe1", ink: "#1f4a36", glyph: "check" },
  wait: { fill: "#c8641f", ink: "#ffffff", glyph: "clock" },
  err: { fill: "#af3838", ink: "#ffffff", glyph: "bang" },
};

/** Glyphs in a 10×10 box: [paint, line width, SVG path]. */
export const GLYPHS = {
  check: [["stroke", 1.4, "M2.6 5.2 4.3 6.9 7.5 3.4"]],
  clock: [
    ["stroke", 1.1, "M5 1.9a3.1 3.1 0 1 1 0 6.2a3.1 3.1 0 1 1 0-6.2"],
    ["stroke", 1.1, "M5 3.4V5l1.2.8"],
  ],
  bang: [
    ["stroke", 1.4, "M5 2.6v2.9"],
    ["fill", 0, "M5 6.45a.85.85 0 1 1 0 1.7a.85.85 0 1 1 0-1.7"],
  ],
};

/** The frame shown at the click, while the link is on its way. */
export const PRESS = { sy: 0.8 };

/**
 * Frames after the answer: [pose, milliseconds before the next one]. The last
 * frame stays on the tab until it navigates. Poses move the mark in its
 * 126-unit box around the bottom centre (sheet 36).
 */
const FRAMES = {
  saved: [
    [{ sx: 0.86, sy: 0.86, dy: -12 }, 120],
    [{ happy: true }, 120],
    [{ happy: true, badge: "ok" }, 320],
    [{ badge: "ok" }],
  ],
  existing: [
    [{}, 80],
    [{ sy: 0.9, badge: "soft" }, 160],
    [{ badge: "soft" }],
  ],
  queued: [
    [{ dx: 18, dy: -40 }, 120],
    [{ dx: 40, dy: -96, opacity: 0.9 }, 160],
    [{ opacity: 0.5, badge: "wait" }, 160],
    [{ badge: "wait" }],
  ],
  failed: [
    [{ dx: -9, sx: 0.92, sy: 0.92 }, 60],
    [{ dx: 9, sx: 0.92, sy: 0.92 }, 60],
    [{ dx: -6, sx: 0.92, sy: 0.92 }, 60],
    [{ badge: "err" }],
  ],
};

/** The frames to play; without animation only the resting one. */
export function frames(state, animate) {
  const all = FRAMES[state];
  if (!all) throw new Error(`Unknown state ${state}`);
  return animate ? all : all.slice(-1);
}

/** The resting pose of a state: what a tab keeps after the animation. */
export const rest = (state) => FRAMES[state].at(-1)[0];

/** The micro mark (pin-spirit-micro.svg): silhouette, eyes and the view box. */
export function parseMark(svg) {
  const viewBox = svg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
  const [silhouette, ...eyes] = svg.match(/ d="([^"]+)"/)[1].split(/(?=M)/);
  return { viewBox, silhouette, eyes: eyes.join("") };
}

/** The mascot (pin-spirit.svg) as plain data: the page builds it node by node. */
export function parseMascot(svg) {
  const viewBox = svg.match(/viewBox="([^"]+)"/)[1];
  const paths = [...svg.matchAll(/<path\b([^>]*)\/?>/g)].map(([, attrs]) => {
    const attr = (name) => attrs.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;
    return { d: attr("d"), fill: attr("fill"), transform: attr("transform") };
  });
  return { viewBox, paths: paths.filter((path) => path.d) };
}

// The system-icon colours of the mark (scripts/brand-icons.mjs): the toolbar may be light or dark.
const BODY = "#699a74";
const LINE = "#365e42";
const EYE = "#eeebdc";
const HAPPY = "M22 88 Q36 70 50 88 M80 88 Q94 70 108 88";

/**
 * One frame of the button at `size` px: the mark in `pose` and the state mark
 * in its corner. `canvas(size)` gives a 2D-capable canvas (OffscreenCanvas).
 */
export function drawIcon(canvas, mark, size, pose = {}) {
  const target = canvas(size);
  const ctx = target.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  // As brand-icons.mjs: the view box widened by half the outline (≈ 1.1 px).
  const stroke = (126 / size) * 1.1;
  const [vx, vy, vw] = mark.viewBox;
  const scale = size / (vw + stroke);
  ctx.save();
  ctx.scale(scale, scale);
  ctx.translate(-(vx - stroke / 2), -(vy - stroke / 2));
  ctx.globalAlpha = pose.opacity ?? 1;
  ctx.translate(63 + (pose.dx ?? 0), 126 + (pose.dy ?? 0));
  ctx.scale(pose.sx ?? 1, pose.sy ?? 1);
  ctx.translate(-63, -126);
  const body = new Path2D(mark.silhouette);
  ctx.fillStyle = BODY;
  ctx.fill(body);
  ctx.lineJoin = "round";
  ctx.lineWidth = stroke;
  ctx.strokeStyle = LINE;
  ctx.stroke(body);
  if (pose.happy) {
    ctx.lineCap = "round";
    ctx.lineWidth = 11;
    ctx.strokeStyle = EYE;
    ctx.stroke(new Path2D(HAPPY));
  } else {
    ctx.fillStyle = EYE;
    ctx.fill(new Path2D(mark.eyes));
  }
  ctx.restore();
  if (pose.badge) drawBadge(ctx, size, BADGES[pose.badge]);
  return ctx.getImageData(0, 0, size, size);
}

/** A 9 px circle in the bottom right corner (at 16 px), cut out of the mark by a 1 px gap. */
function drawBadge(ctx, size, { fill, ink, glyph }) {
  const unit = size / 16;
  const centre = 11.5 * unit;
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(centre, centre, 5.5 * unit, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  ctx.beginPath();
  ctx.arc(centre, centre, 4.5 * unit, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.translate(7 * unit, 7 * unit);
  ctx.scale(0.9 * unit, 0.9 * unit);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [paint, width, d] of GLYPHS[glyph]) {
    if (paint === "fill") {
      ctx.fillStyle = ink;
      ctx.fill(new Path2D(d));
    } else {
      ctx.lineWidth = width;
      ctx.strokeStyle = ink;
      ctx.stroke(new Path2D(d));
    }
  }
  ctx.restore();
}

/** Colours of the page message's status circle: [light, dark] × [fill, ink]. */
export const TONES = {
  saved: [["#2f6b4f", "#ffffff"], ["#8fd0ae", "#1c1c19"]],
  existing: [["#e2eee6", "#1f4a36"], ["#25352c", "#8fd0ae"]],
  queued: [["#c8641f", "#ffffff"], ["#e0894b", "#1c1c19"]],
  failed: [["#af3838", "#ffffff"], ["#e99797", "#1c1c19"]],
};

/**
 * The message on the page (variant C). Runs in the page through
 * scripting.executeScript, so it is self-contained: everything comes in
 * `options`. Nodes and inline styles only — no innerHTML and no <style> —
 * so the page's CSP and Trusted Types have nothing to block. Returns whether
 * the system asks for less motion (the service worker cannot tell).
 */
export function showMessage({ state, title, text, mascot, glyph, tones, label }) {
  const ID = "netamipin-feedback";
  const SVG = "http://www.w3.org/2000/svg";
  const media = (query) => globalThis.matchMedia?.(query).matches ?? false;
  const dark = media("(prefers-color-scheme: dark)");
  const reduce = media("(prefers-reduced-motion: reduce)");
  const c = dark
    ? { card: "#2b2b26", border: "#3d3d35", ink: "#e9e6dc", muted: "#a4a296", shadow: "rgba(0,0,0,.32)", body: "#8fd0ae" }
    : { card: "#fffefa", border: "#e4e2da", ink: "#2e302b", muted: "#74746a", shadow: "rgba(0,0,0,.12)", body: null };
  const [fill, ink] = tones[dark ? 1 : 0];
  const css = (node, styles) => {
    for (const [name, value] of Object.entries(styles)) node.style.setProperty(name, value, "important");
    return node;
  };
  const el = (tag, styles) => css(document.createElement(tag), styles);
  const svg = (viewBox, size) => {
    const node = document.createElementNS(SVG, "svg");
    node.setAttribute("viewBox", viewBox);
    node.setAttribute("width", size);
    node.setAttribute("height", size);
    node.setAttribute("aria-hidden", "true");
    return css(node, { display: "block", flex: "none" });
  };

  document.getElementById(ID)?.remove();
  const host = el("div", {
    all: "initial",
    position: "fixed",
    top: "16px",
    right: "16px",
    "z-index": "2147483647",
    display: "block",
  });
  host.id = ID;
  host.dataset.state = state;
  const root = host.attachShadow({ mode: "closed" });
  const card = el("div", {
    display: "flex",
    "align-items": "center",
    gap: "10px",
    width: "304px",
    "min-height": "56px",
    "box-sizing": "border-box",
    padding: "10px 16px 10px 12px",
    background: c.card,
    border: `1px solid ${c.border}`,
    "border-radius": "12px",
    "box-shadow": `0 8px 24px ${c.shadow}`,
    font: '13px/1.25 "Segoe UI", system-ui, -apple-system, sans-serif',
    color: c.ink,
    cursor: "default",
    opacity: "0",
    transform: reduce ? "none" : "translateY(-4px)",
    transition: reduce ? "none" : "opacity 150ms ease-out, transform 150ms ease-out",
  });
  card.setAttribute("role", "status");
  card.setAttribute("aria-live", "polite");

  const art = svg(mascot.viewBox, 36);
  for (const path of mascot.paths) {
    const node = document.createElementNS(SVG, "path");
    node.setAttribute("d", path.d);
    // The mascot's body is mint on dark (doc/guidelines.md).
    node.setAttribute("fill", c.body && path.fill?.toLowerCase() === "#699a74" ? c.body : path.fill);
    if (path.transform) node.setAttribute("transform", path.transform);
    art.append(node);
  }
  const words = el("div", { flex: "1", "min-width": "0" });
  const line = (value, styles) =>
    Object.assign(
      el("div", { overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", ...styles }),
      { textContent: value },
    );
  words.append(
    line(title, { "font-weight": "600", color: c.ink }),
    line(text, { "margin-top": "2px", "font-size": "12px", color: c.muted }),
  );
  const status = el("div", {
    flex: "none",
    width: "20px",
    height: "20px",
    "border-radius": "10px",
    background: fill,
    display: "grid",
    "place-items": "center",
  });
  status.setAttribute("aria-label", label);
  const mark = svg("0 0 10 10", 14);
  for (const [paint, width, d] of glyph) {
    const node = document.createElementNS(SVG, "path");
    node.setAttribute("d", d);
    node.setAttribute("fill", paint === "fill" ? ink : "none");
    if (paint === "stroke") {
      node.setAttribute("stroke", ink);
      node.setAttribute("stroke-width", String(width));
      node.setAttribute("stroke-linecap", "round");
      node.setAttribute("stroke-linejoin", "round");
    }
    mark.append(node);
  }
  status.append(mark);
  card.append(art, words, status);
  root.append(card);
  (document.body ?? document.documentElement).append(host);

  // In 150 ms, out after 3 s; the pointer over it keeps it, a click closes it.
  let timer;
  const leave = () => {
    css(card, { opacity: "0" });
    setTimeout(() => host.remove(), reduce ? 0 : 160);
  };
  const wait = () => {
    clearTimeout(timer);
    timer = setTimeout(leave, 3000);
  };
  card.addEventListener("mouseenter", () => clearTimeout(timer));
  card.addEventListener("mouseleave", wait);
  card.addEventListener("click", () => {
    clearTimeout(timer);
    host.remove();
  });
  // Two frames: the start styles must be painted before the transition.
  requestAnimationFrame(() => requestAnimationFrame(() => css(card, { opacity: "1", transform: "none" })));
  wait();
  return { reducedMotion: reduce };
}
