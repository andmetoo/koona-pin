// Moves frame fills, borders, shadows and corner radius into a "Background"
// rectangle inside the frame. Lunacy 2025.1 drops the radius of a frame when it
// opens a .sketch file and writes 0 on the next save; the Figma .sketch import
// turns such frames into groups without fill and radius. Rectangles survive both.
// Close the file in Lunacy first. Safe to run twice: fixed frames are skipped.
// Run: node scripts/fix-sketch-frames.mjs design/lunacy/iterone.sketch [more.sketch]
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const enabled = (list) => (list || []).filter((item) => item.isEnabled !== false);
const radiiOf = (layer) => layer.style?.corners?.radii || [0, 0, 0, 0];

function setRectRadius(rect, radii) {
  rect.style = rect.style || { _class: "style" };
  rect.style.corners = { _class: "MSImmutableStyleCorners", radii: radii.slice(), style: 0 };
  if (Array.isArray(rect.points) && rect.points.length === 4) {
    rect.points.forEach((point, i) => (point.cornerRadius = radii[i]));
  } else {
    rect.points = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y], i) => ({
      _class: "curvePoint", cornerRadius: radii[i], cornerStyle: 0,
      curveFrom: `{${x}, ${y}}`, curveMode: 1, curveTo: `{${x}, ${y}}`,
      hasCurveFrom: false, hasCurveTo: false, point: `{${x}, ${y}}`,
    }));
  }
  rect.fixedRadius = 0;
  rect.pointRadiusBehaviour = 1;
  rect.hasConvertedToNewRoundCorners = true;
  rect.needsConvertionToNewRoundCorners = false;
}

function makeBackground(frame) {
  const style = { _class: "style", endMarkerType: 0, miterLimit: 10, startMarkerType: 0, windingRule: 1 };
  for (const key of ["fills", "borders", "shadows", "innerShadows", "borderOptions"]) {
    if (frame.style[key]) style[key] = frame.style[key];
  }
  const rect = {
    _class: "rectangle", do_objectID: randomUUID().toUpperCase(), booleanOperation: -1,
    isFixedToViewport: false, isLocked: false, isVisible: true, isTemplate: false,
    hasExplicitConstraints: true, horizontalPins: 3, verticalPins: 3,
    layerListExpandedType: 0, name: "Background", nameIsFixed: true,
    resizingConstraint: 18, resizingType: 0, rotation: 0, shouldBreakMaskChain: false,
    // absolute position inside an auto-layout frame
    userInfo: { "com.icons8.lunacy": { layoutPositioning: "true", scrollBehavior: '{"scrollBehavior":0}' } },
    flexItem: { _class: "MSImmutableFlexItem", alignSelf: 5, ignoreLayout: true, preserveSpaceWhenHidden: false },
    flow: { _class: "MSImmutableFlowConnection", maintainScrollPosition: false },
    exportOptions: { _class: "exportOptions", includedLayerIds: [], layerOptions: 0, shouldTrim: false, exportFormats: [] },
    frame: { _class: "rect", constrainProportions: false, x: 0, y: 0, width: frame.frame.width, height: frame.frame.height },
    clippingMaskMode: 0, hasClippingMask: false, style, edited: false, isClosed: true,
  };
  setRectRadius(rect, radiiOf(frame));
  return rect;
}

function fixFrame(frame, stats) {
  for (const child of frame.layers || []) fixFrame(child, stats);
  if (frame._class !== "group" || frame.groupBehavior !== 1 || !frame.style) return;
  if ((frame.layers || []).some((c) => c._class === "rectangle" && c.name === "Background")) return;
  const style = frame.style;
  const radii = radiiOf(frame);
  if (enabled(style.fills).length || enabled(style.borders).length
    || enabled(style.shadows).length || enabled(style.innerShadows).length) {
    frame.layers = frame.layers || [];
    // Lunacy stores auto-layout children top-first and plain group children bottom-first
    if (frame.groupLayout?._class === "MSImmutableFlexGroupLayout") frame.layers.push(makeBackground(frame));
    else frame.layers.unshift(makeBackground(frame));
    for (const key of ["fills", "borders", "shadows", "innerShadows"]) if (style[key]) style[key] = [];
    stats.moved++;
  }
  if (radii.some((r) => r > 0)) {
    // the rounded clip of the frame is lost too, so full-size images get the radius
    const { width, height } = frame.frame;
    for (const child of frame.layers || []) {
      const f = child.frame;
      if (child._class === "rectangle" && child.name !== "Background"
        && Math.abs(f.x) < 0.5 && Math.abs(f.y) < 0.5
        && Math.abs(f.width - width) < 0.5 && Math.abs(f.height - height) < 0.5
        && !radiiOf(child).some((r) => r > 0)) {
        setRectRadius(child, radii);
        stats.images++;
      }
    }
    style.corners = { _class: "MSImmutableStyleCorners", radii: [0, 0, 0, 0], style: 0 };
  }
}

function zip(command) {
  const result = spawnSync("pwsh", ["-NoProfile", "-Command",
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; ${command}`], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`pwsh failed: ${command}`);
}

for (const file of process.argv.slice(2)) {
  const sketch = path.resolve(file);
  const dir = mkdtempSync(path.join(tmpdir(), "sketch-"));
  try {
    zip(`[IO.Compression.ZipFile]::ExtractToDirectory('${sketch}', '${dir}', $true)`);
    const stats = { moved: 0, images: 0 };
    const pages = path.join(dir, "pages");
    for (const name of readdirSync(pages)) {
      const page = JSON.parse(readFileSync(path.join(pages, name), "utf8"));
      for (const layer of page.layers) fixFrame(layer, stats);
      writeFileSync(path.join(pages, name), JSON.stringify(page));
    }
    if (stats.moved || stats.images) {
      rmSync(sketch);
      zip(`[IO.Compression.ZipFile]::CreateFromDirectory('${dir}', '${sketch}', 'Optimal', $false)`);
    }
    console.log(`${file}: ${stats.moved} backgrounds, ${stats.images} images rounded`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
