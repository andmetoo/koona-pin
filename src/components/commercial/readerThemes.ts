// Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//
// Supporter's looks of reading (NP-124, Р-69 points 7 and 9, frame B8): the Paper and Sepia
// palettes and the extra fonts. The Aa panel, its lock and the plan check are community code
// (src/services/readerLook.ts); this module only registers what it unlocks. The font files keep
// their own license (SIL OFL 1.1) and are not relicensed by this notice.
import "@fontsource-variable/source-serif-4";
import "@fontsource-variable/atkinson-hyperlegible-next";
import { registerSupporterLook, type SupporterLook } from "../../services/readerLook";

export const supporterLook: SupporterLook = {
  themes: {
    // The warm palette the B-frames are drawn in.
    paper: {
      read: "#f4eee2",
      queue: "#eee7d9",
      current: "#f8f3ea",
      card: "#fbf7ef",
      edge: "#e2d9c7",
      track: "#e8e0d0",
      border: "#ddd4c2",
      ink: "#22231f",
      text: "#2b2a26",
      muted: "#8a887e",
      dim: "#a8a396",
      panel: "#fbf7ef",
      well: "#eee7d9",
      raised: "#fffefa",
    },
    // B8's swatch (#efe1c6); its ink is a shade darker than the swatch's #5b4636, which is 6.9:1.
    sepia: {
      read: "#efe1c6",
      queue: "#e8d8b9",
      current: "#f4e8d1",
      card: "#f5ead5",
      edge: "#dccaa6",
      track: "#e2d1b0",
      border: "#d6c39e",
      ink: "#43301f",
      text: "#4a3828",
      muted: "#7d6a55",
      dim: "#a8957a",
      panel: "#f5ead5",
      well: "#e6d5b4",
      raised: "#fbf3e3",
    },
  },
  fonts: {
    book: '"Source Serif 4 Variable", "Source Serif 4", Georgia, serif',
    legible: '"Atkinson Hyperlegible Next Variable", "Atkinson Hyperlegible Next", var(--np-font)',
  },
};

registerSupporterLook(supporterLook);
