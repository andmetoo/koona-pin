import { createLucideIcon, type LucideIcon, type LucideProps } from "lucide-react";

// The phone's icons (doc/mobile-design.md, Icons): Lucide geometry at four sizes, with the app's
// own paperclip (All bookmarks) and inbox tray (Inbox) from src/components/icons.tsx.
export { ClipIcon, InboxTray, Mascot } from "../../../components/icons";

/** Lucide's cloud-check (newer than the bundled lucide-react): synced. */
export const CloudCheck = createLucideIcon("CloudCheck", [
  ["path", { d: "m17 15-5.5 5.5L9 18", key: "check" }],
  ["path", { d: "M5 17.743A7 7 0 1 1 15.71 10h1.79a4.5 4.5 0 0 1 1.5 8.742", key: "cloud" }],
]);

/** Where an icon sits: its size and stroke. */
export const ICON = {
  /** The nav pill and the rail. */
  nav: { size: 24, strokeWidth: 2 },
  /** Buttons and circle buttons. */
  button: { size: 20, strokeWidth: 1.75 },
  /** Fields and the search field. */
  field: { size: 18, strokeWidth: 1.6 },
  /** Chips. */
  chip: { size: 16, strokeWidth: 1.5 },
} as const;
export type IconPlace = keyof typeof ICON;

/** A Lucide icon at its place's size, hidden from screen readers (its control has the name). */
export function PhIcon({ icon: Glyph, at = "button", ...rest }: { icon: LucideIcon; at?: IconPlace } & LucideProps) {
  return <Glyph {...ICON[at]} absoluteStrokeWidth aria-hidden="true" {...rest} />;
}
