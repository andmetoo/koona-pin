// The film's timing in one table (../scenario.md, ../MOTION.md §8). 60 fps: 60 frames are one second.
// A recorded scene names its clip in public/clips/ and the second of the clip it starts from, so a
// retaken clip changes only `clipFrom`.

export const FPS = 60;
export const WIDTH = 1920;
export const HEIGHT = 1080;
/** Scenes overlap by this many frames so the motion flows (MOTION.md §4). */
export const OVERLAP = 10;

export type Scene = {
  id: string;
  /** First frame of the scene on the film's timeline. */
  from: number;
  /** Length in frames, the overlap included. */
  length: number;
  caption: string;
  /** The second line of the payoff only. */
  subcaption?: string;
  /** A recording of the Play build, `public/clips/<clip>.mp4`; none for the opening and the payoff. */
  clip?: string;
  /** The second of the clip the scene starts from. */
  clipFrom?: number;
  /** The clip's length in seconds (`bunx remotion ffprobe`): a scene longer than what is left of its clip holds the last frame. */
  clipLength?: number;
  /** Pieces of the clip played one after the other, in seconds: a jump cut inside the scene. */
  segments?: [number, number][];
  /** The previous scene's take goes on: no fade between them, and that scene ends where this one starts. */
  joined?: boolean;
  /** The phone steps aside for a computer beside it, and the caption goes under both (the sync scene). */
  beside?: boolean;
  /** The frame the phone shows, still, under the payoff: this scene's first. */
  poster?: boolean;
};

const s = (seconds: number) => Math.round(seconds * FPS);

export const scenes: Scene[] = [
  { id: "attention", from: 0, length: s(1.5) + OVERLAP, caption: "So many links worth keeping." },
  { id: "problem", from: s(1.5), length: s(1.5) + OVERLAP, caption: "Scattered everywhere." },
  // Typed, then saved: the wait for the page's preview is cut out.
  { id: "save", from: s(3), length: s(2.7) + OVERLAP, caption: "Save any link in a tap.", clip: "save", segments: [[1.3, 3.4], [5.0, 5.6]], clipLength: 7.08 },
  // One take: the library as a list, then as cards, then Reading and an article.
  { id: "library", from: s(5.7), length: s(3.9), caption: "Your library, as a list or as cards.", clip: "browse", clipFrom: 0.3, clipLength: 10.72, poster: true },
  { id: "read", from: s(9.6), length: s(4.7) + OVERLAP, caption: "Read without the clutter.", clip: "browse", clipFrom: 4.2, clipLength: 10.72, joined: true },
  { id: "feeds", from: s(14.3), length: s(5.7) + OVERLAP, caption: "News, travel, blogs: follow them by RSS.", clip: "feeds", clipFrom: 1.0, clipLength: 6.92 },
  {
    id: "sync",
    from: s(20),
    length: s(6.5) + OVERLAP,
    caption: "Sync with your computers.",
    subcaption: "End-to-end encrypted, never stored on a server. With Supporter.",
    clip: "sync",
    beside: true,
    clipFrom: 0.9,
    clipLength: 4.97,
  },
  {
    id: "payoff",
    from: s(26.5),
    length: s(3.5),
    caption: "Koona Pin. Your library, on all your devices.",
    subcaption: "Free on Android, Windows, macOS and Linux.",
  },
];

export const DURATION = s(30);

/** The light theme of the app (src/styles/app.css). */
export const colours = {
  paper: "#faf9f6",
  ink: "#2e302b",
  muted: "#6b6d66",
  accent: "#2f6b4f",
  accentSoft: "#e2eee6",
};

/** Cards of the opening, from the sample library of the shots (scripts/shots/library.json): made-up sites. */
export const sampleCards = [
  { title: "Ten principles for good design", site: "tenrules.studio" },
  { title: "The making of a microchip", site: "siliconnotes.net" },
  { title: "Writing code you can read in a year", site: "readablecode.blog" },
  { title: "Gradients that don't look muddy", site: "softhue.co" },
  { title: "Set up a home network that just works", site: "quietlan.org" },
  { title: "How small teams make decisions", site: "smallteamnotes.co" },
  { title: "Buildings made of simple shapes", site: "plainshapes.studio" },
  { title: "How a computer boots, step by step", site: "coldboot.blog" },
  { title: "The case for a short reading list", site: "quietpages.blog" },
];
