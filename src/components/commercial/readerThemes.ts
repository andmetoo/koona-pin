// Koona Pin Commercial License (LICENSE-COMMERCIAL.md, see NOTICE.md in `commercial`).
//
// Supporter's reading themes (NP-124, Р-69 points 7 and 9, frame B8): the Paper and Sepia palettes.
// The Aa panel, its lock and the plan check are community code (src/services/readerLook.ts); this
// module only registers what it unlocks. No paid fonts (owner, 2026-10-15).
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
    // B8's swatch (#efe1c6). Its ink #5b4636 is 6.85:1 there; darkened just enough for 7:1 (owner).
    sepia: {
      read: "#efe1c6",
      queue: "#e8d8b9",
      current: "#f4e8d1",
      card: "#f5ead5",
      edge: "#dccaa6",
      track: "#e2d1b0",
      border: "#d6c39e",
      ink: "#594435",
      text: "#594435",
      muted: "#7d6a55",
      dim: "#a8957a",
      panel: "#f5ead5",
      well: "#e6d5b4",
      raised: "#fbf3e3",
    },
  },
};

registerSupporterLook(supporterLook);
