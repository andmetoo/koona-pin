// Sample feeds of the browser preview (NP-128). The posts are written here,
// not taken from the sites; their pictures are generated like the sample
// library's previews (`demoData.ts`), so the preview loads nothing from the web.

import type { FeedDestination } from "../types";
import { poster } from "./demoData";

export interface DemoFeed {
  uid: string;
  url: string;
  /** The feed's own title, as the cache would have it. */
  feedTitle: string;
  siteUrl: string;
  destination: FeedDestination;
}

export interface DemoPost {
  id: number;
  feed: string;
  /** Hours before the preview opened. */
  hoursAgo: number;
  title: string;
  author: string | null;
  excerpt: string;
  /** Two colours and a word for the generated picture; none: the post has no picture. */
  picture: [string, string, string] | null;
  /** The article itself, paragraph by paragraph. A short one is a summary-only post. */
  body: string[];
  read?: boolean;
}

export const DEMO_FEEDS: DemoFeed[] = [
  { uid: "demo-feed-verge", url: "https://www.theverge.com/rss/index.xml", feedTitle: "The Verge", siteUrl: "https://www.theverge.com/", destination: "feeds" },
  { uid: "demo-feed-eats", url: "https://www.seriouseats.com/feeds/all", feedTitle: "Serious Eats", siteUrl: "https://www.seriouseats.com/", destination: "notify" },
  { uid: "demo-feed-kottke", url: "https://feeds.kottke.org/main", feedTitle: "kottke.org", siteUrl: "https://kottke.org/", destination: "feeds" },
  { uid: "demo-feed-smashing", url: "https://www.smashingmagazine.com/feed/", feedTitle: "Smashing Magazine", siteUrl: "https://www.smashingmagazine.com/", destination: "inbox" },
  { uid: "demo-feed-ars", url: "https://feeds.arstechnica.com/arstechnica/index", feedTitle: "Ars Technica", siteUrl: "https://arstechnica.com/", destination: "feeds" },
];

/** Shared paragraphs that make a post long enough to read as the whole article. */
const MORE = [
  "None of this needs a new habit. It needs a small change to the one you already have, made on a quiet afternoon and then left alone for a few weeks so you can see whether it holds.",
  "The details matter less than the direction. Try it once as described, note what felt awkward, and adjust a single thing at a time. Most of the gain comes from the first attempt anyway.",
  "If it does not work for you, that is useful too: you have learned something about how you work, and you can put the old way back in a minute.",
];

export const DEMO_POSTS: DemoPost[] = [
  {
    id: 1, feed: "demo-feed-verge", hoursAgo: 0.4, author: "Mara Ellison",
    title: "The quiet return of the dedicated music player",
    excerpt: "Phones do everything, which is exactly why a growing number of people are buying a device that only plays music — and keeping it in a drawer by the door.",
    picture: ["#3b4a6b", "#11182b", "Play"],
    body: [
      "Phones do everything, which is exactly why a growing number of people are buying a device that only plays music.",
      "The appeal is not the sound, though the sound is often better. It is the absence of everything else: no messages arriving between songs, no feed waiting one swipe away.",
      ...MORE,
    ],
  },
  {
    id: 2, feed: "demo-feed-ars", hoursAgo: 1.2, author: "Owen Hartley",
    title: "Why your laptop battery report says 80 percent and what that really means",
    excerpt: "Battery health numbers are estimates built on a model of the cell. Here is how the model works, and when the number is worth worrying about.",
    picture: ["#2f3b33", "#121815", "80%"],
    body: [
      "Battery health numbers are estimates built on a model of the cell, not a measurement of it.",
      "The firmware tracks how much charge goes in and comes out, and compares it with what the cell held when new. Temperature, age and how often the battery sits at full all move the estimate.",
      "A reading of 80 percent after three years is normal. A sudden drop of ten points in a month is not, and is worth a closer look.",
      ...MORE,
    ],
  },
  {
    id: 3, feed: "demo-feed-eats", hoursAgo: 2.5, author: "Lena Ortiz",
    title: "Weeknight braised beans that taste like they took all day",
    excerpt: "A pot of beans, a few aromatics and one trick with the cooking liquid. Forty minutes, most of it hands-off.",
    picture: ["#b0703d", "#5c3417", "Beans"],
    body: [
      "A pot of beans, a few aromatics and one trick with the cooking liquid: reduce half of it hard in a separate pan, then stir it back in.",
      "The reduction concentrates everything that makes slow-cooked beans taste the way they do, in a fraction of the time.",
      ...MORE,
    ],
  },
  {
    id: 4, feed: "demo-feed-kottke", hoursAgo: 3.1, author: null,
    title: "A map of every lighthouse on the coast, drawn by hand",
    excerpt: "Someone spent four winters drawing every lighthouse on one coastline, and the result is lovely.",
    picture: null,
    body: ["Someone spent four winters drawing every lighthouse on one coastline, and the result is lovely. Worth a slow look."],
  },
  {
    id: 5, feed: "demo-feed-smashing", hoursAgo: 4.8, author: "Priya Raman",
    title: "Designing forms that forgive: error states people understand",
    excerpt: "Most form errors blame the person. A few patterns — inline hints, kept input, specific messages — turn them into help instead.",
    picture: ["#c75c4a", "#6e2a20", "Forms"],
    body: [
      "Most form errors blame the person filling in the form. They arrive late, after the button, in red, and say what went wrong without saying what to do.",
      "Three patterns change that: hints that appear while typing, input that survives a failed submit, and messages that name the fix rather than the fault.",
      ...MORE,
    ],
  },
  {
    id: 6, feed: "demo-feed-verge", hoursAgo: 6, author: "Dev Patel",
    title: "E-ink tablets are getting color, slowly",
    excerpt: "The new color panels are muted and a little slow, and for reading and sketching that turns out to be fine.",
    picture: ["#7d8c8f", "#3c4547", "E-ink"],
    body: ["The new color panels are muted and a little slow, and for reading and sketching that turns out to be fine."],
  },
  {
    id: 7, feed: "demo-feed-ars", hoursAgo: 9, author: "Nadia Brooks",
    title: "The long tail of a single typo in a config file",
    excerpt: "A misplaced character took a service down for six hours. The postmortem is a quiet masterclass in how small things travel.",
    picture: null,
    body: [
      "A misplaced character took a service down for six hours. The postmortem is a quiet masterclass in how small things travel through big systems.",
      "Nothing in the chain was unusual. Each step trusted the one before it, as it should, and the typo passed through all of them.",
      ...MORE,
    ],
  },
  {
    id: 8, feed: "demo-feed-eats", hoursAgo: 20, author: "Sam Whitaker",
    title: "The best way to store herbs so they last a week",
    excerpt: "Treat soft herbs like flowers and hard herbs like vegetables. We tested six methods over ten days.",
    picture: ["#5f7d4a", "#2a3a1f", "Herbs"],
    body: [
      "Treat soft herbs like flowers and hard herbs like vegetables. We tested six methods over ten days, and two came out clearly ahead.",
      "Parsley, cilantro and mint did best upright in a jar of water in the fridge, loosely covered. Rosemary and thyme lasted longest wrapped in a barely damp towel.",
      ...MORE,
    ],
  },
  {
    id: 9, feed: "demo-feed-kottke", hoursAgo: 26, author: null,
    title: "The slowest-moving video you will enjoy today",
    excerpt: "A glacier, a fixed camera and twelve years compressed into four minutes.",
    picture: ["#9bb3c4", "#3f5566", "Ice"],
    body: ["A glacier, a fixed camera and twelve years compressed into four minutes. Watch the left edge."],
    read: true,
  },
  {
    id: 10, feed: "demo-feed-smashing", hoursAgo: 30, author: "Tomás Herrera",
    title: "A practical guide to container queries in real layouts",
    excerpt: "Components that adapt to their own space, not the window's. What works today, and what to keep a fallback for.",
    picture: ["#4a5fc7", "#1f2a66", "@container"],
    body: [
      "Container queries let a component adapt to the space it is given, not to the size of the window.",
      "That sounds like a small change. In practice it removes a whole category of special cases: the card that looks right in the main column and wrong in the sidebar.",
      ...MORE,
    ],
    read: true,
  },
  {
    id: 11, feed: "demo-feed-verge", hoursAgo: 34, author: "Mara Ellison",
    title: "What a repairable phone actually costs to own",
    excerpt: "We kept one for two years, replaced the battery and the screen ourselves, and added up the bill.",
    picture: null,
    body: ["We kept one for two years, replaced the battery and the screen ourselves, and added up the bill."],
  },
  {
    id: 12, feed: "demo-feed-ars", hoursAgo: 48, author: "Owen Hartley",
    title: "How a tiny satellite keeps its antenna pointed home",
    excerpt: "Reaction wheels, magnetorquers and a lot of patience: the attitude control of a shoebox-sized spacecraft.",
    picture: ["#24324a", "#0b111c", "Orbit"],
    body: [
      "Reaction wheels, magnetorquers and a lot of patience keep a shoebox-sized spacecraft pointed where it needs to be.",
      "The wheels spin up to turn the satellite the other way. Over time they saturate, and small electromagnets push against the Earth's field to bleed the momentum off.",
      ...MORE,
    ],
    read: true,
  },
  {
    id: 13, feed: "demo-feed-eats", hoursAgo: 52, author: "Lena Ortiz",
    title: "Crisp roast potatoes, every time",
    excerpt: "Parboil, rough them up, then roast hot. The baking soda in the water is the part people skip.",
    picture: ["#d9a441", "#7a5313", "Crisp"],
    body: [
      "Parboil, rough them up, then roast hot. The pinch of baking soda in the water is the part people skip, and it is the part that matters.",
      "It breaks down the surface just enough to make a starchy paste, which fries into a crust in the oven.",
      ...MORE,
    ],
  },
  {
    id: 14, feed: "demo-feed-kottke", hoursAgo: 70, author: null,
    title: "On keeping a list of things that made you happy",
    excerpt: "A short note about a long habit: one line a day, for ten years.",
    picture: null,
    body: ["A short note about a long habit: one line a day, for ten years. The list is dull to read and wonderful to have."],
    read: true,
  },
  {
    id: 15, feed: "demo-feed-smashing", hoursAgo: 96, author: "Priya Raman",
    title: "Accessible color palettes without the guesswork",
    excerpt: "Start from contrast, not from hue. A method for building a palette that passes checks in light and dark themes.",
    picture: ["#7a3fa0", "#2f1440", "Contrast"],
    body: [
      "Start from contrast, not from hue. Pick the lightness steps first, check them against both backgrounds, and only then choose the colours.",
      ...MORE,
    ],
  },
  {
    id: 16, feed: "demo-feed-verge", hoursAgo: 120, author: "Dev Patel",
    title: "The case for a boring home router",
    excerpt: "Fewer features, fewer updates gone wrong. Why the plainest router on the shelf might be the right one.",
    picture: null,
    body: ["Fewer features, fewer updates gone wrong. Why the plainest router on the shelf might be the right one."],
    read: true,
  },
  {
    id: 17, feed: "demo-feed-ars", hoursAgo: 150, author: "Nadia Brooks",
    title: "Inside the archive that keeps old software running",
    excerpt: "Disk images, manuals and emulators: how a small team preserves programs nobody sells any more.",
    picture: ["#6b5a3e", "#2b2417", "Archive"],
    body: [
      "Disk images, manuals and emulators: a small team preserves programs nobody sells any more, so that the files made with them can still be opened.",
      ...MORE,
    ],
    read: true,
  },
  {
    id: 18, feed: "demo-feed-eats", hoursAgo: 200, author: "Sam Whitaker",
    title: "A simple pan sauce for any weeknight chop",
    excerpt: "Brown bits, a splash of wine, a knob of butter. Two minutes after the meat comes out of the pan.",
    picture: null,
    body: ["Brown bits, a splash of wine, a knob of butter. Two minutes after the meat comes out of the pan."],
    read: true,
  },
  {
    id: 19, feed: "demo-feed-kottke", hoursAgo: 260, author: null,
    title: "Photographs of the same street, a hundred years apart",
    excerpt: "Old and new pictures of one city street, lined up so you can slide between them.",
    picture: ["#8c7b6b", "#3a3129", "1926"],
    body: ["Old and new pictures of one city street, lined up so you can slide between them. The trees are the biggest change."],
    read: true,
  },
  {
    id: 20, feed: "demo-feed-smashing", hoursAgo: 330, author: "Tomás Herrera",
    title: "Motion that helps: when to animate an interface",
    excerpt: "Animation should explain a change, not decorate it. A short checklist for deciding when it earns its place.",
    picture: null,
    body: [
      "Animation should explain a change, not decorate it. If the person would lose track of where something went, show it moving; otherwise, let it appear.",
      ...MORE,
    ],
    read: true,
  },
];

/** A post's picture as the cache would hold its thumbnail address. */
export const pictureOf = (post: DemoPost) => (post.picture ? poster(post.picture) : null);

const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** The post's address on its site. */
export const postUrl = (feed: DemoFeed, post: DemoPost) => `${feed.siteUrl}demo/${slug(post.title)}`;

/** The article as the feed would send it: raw HTML, sanitised by the interface at render. */
export const postHtml = (post: DemoPost) => post.body.map((text) => `<p>${text}</p>`).join("");

/** Whole article or summary: at least 150 words, as the cache decides it. */
export const isFull = (post: DemoPost) => post.body.join(" ").split(/\s+/).length >= 150;
