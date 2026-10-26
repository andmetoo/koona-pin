# Preview video: the scenario

The Google Play preview video of Koona Pin for Android. A 30-second film, 1920 × 1080 at 60 frames per second, English captions, no voice (it autoplays muted on Play). Built in Remotion (`film/`, the motion rules in `MOTION.md`) from clips of the app's own interface: the built page in its browser preview as a phone, with the sample library and feeds (`scripts/play-film-clips.mjs`).

What Play asks of it ([answer/9866151](https://support.google.com/googleplay/android-developer/answer/9866151)), and the review rule that the listing shows what the build does (`../review.md`, gate C):

- real use of the app within the first 10 seconds, and at least 80 % of the film real app use: the app is on screen from 0:03 to the end, 27 of 30 seconds;
- every screen is the app's own code: the phone shell of the same commit, drawn by the browser instead of Android's WebView, with the preview's demo data in place of a library on a device. It shows only what the Android build does: no share sheet from other apps (iPhone only so far), no offline copies (desktop only). Sync is shown as the preview draws a Supporter's sync (three devices, synced), beside the desktop app's Sync dialog from the site's shots; the caption says it comes with Supporter;
- no prices, rankings, "new", store badges, third-party logos or real sites: the sample library of the site's shots (`scripts/shots/library.json`) and the sample feeds (`scripts/shots/feeds.json`, and the phone's own news, travel and blog feeds in `scripts/shots/play-feeds.json`), whose sites and authors are made up;
- nothing that names the preview: its «Koona Pin demo» line reads as the app's own, «Koona Pin <version>»;
- the first 30 seconds autoplay: the whole story fits in them;
- uploaded to YouTube as unlisted, ads off, not age-restricted, embedding on.

## The story

Attention, problem, the product, payoff. One focal point per scene.

| Time | Scene | On screen | Caption |
| --- | --- | --- | --- |
| 0:00–0:01.5 | **Attention** | Link cards (titles and pictures from the sample library) drift in from every edge and pile up, slightly too many | *So many links worth keeping.* |
| 0:01.5–0:03 | **Problem** | The pile scatters into small grey chips labelled "chat", "notes", "open tab", "screenshot", and blurs | *Scattered everywhere.* |
| 0:03–0:05.7 | **Save** | The phone comes in. New link: an address is typed, and a cut later it is saved («Saved to Inbox»): the wait for the page's preview is cut out | *Save any link in a tap.* |
| 0:05.7–0:09.6 | **Library** | One take: the library as a list, scrolled, then switched to cards | *Your library, as a list or as cards.* |
| 0:09.6–0:14.3 | **Read** | The same take goes on: Reading, «The case for a short reading list» opens in the reader, scrolled | *Read without the clutter.* |
| 0:14.3–0:20 | **Feeds** | Feeds, already loaded: World Brief (news), Slow Roads (travel), Quiet Pages (a blog) and the others; scrolled, one feed picked, then all again | *News, travel, blogs: follow them by RSS.* |
| 0:20–0:26.5 | **Sync** (Supporter) | The phone steps left showing You & sync («Synced just now · 3 devices», Sync now); a computer's window comes in beside it with the desktop app's Sync dialog; between them a dashed link with a padlock, changes travelling both ways | *Sync with your computers.* · *End-to-end encrypted, never stored on a server. With Supporter.* |
| 0:26.5–0:30 | **Payoff** | The phone settles small at the centre over the library; the logo and the name come in under it, then the line | *Koona Pin. Your library, on all your devices.* · *Free on Android, Windows, macOS and Linux.* |

Holds: each caption stays readable at least 1.5 s after its entrance; the logo and the last line at least 2.5 s. No count-ups: no number carries this story.

## Recording the clips

```sh
bun run build
bun run play:clips
```

`bun run play:clips` (`scripts/play-film-clips.mjs`) serves `dist/`, opens it in Chromium as an Android phone of 1080 × 2160 pixels (393 × 786 points, the platform and the insets injected as `tests/phone/fixtures.ts` does), puts the sample library, the feeds and a Supporter with sync in the preview's demo storage, and records each clip as the page's screencast, encoded at 60 fps into `film/public/clips/<name>.mp4`: `save`, `browse` (the library and the reader, one take), `feeds`, `sync`. `-- --only feeds,sync` records some; `-- --probe` writes one screenshot to look at. The status bar and the gesture handle are drawn by the film's phone frame, since the page has none.

Each scene's in-point (`clipFrom`), or its pieces for a cut (`segments`), and the clip's length (`clipLength`, from `bunx remotion ffprobe`) are in `film/src/scenes.ts`, so a clip is retaken without touching the timing. After a retake look at the clip every half second (`bunx remotion ffmpeg -ss <t> -i <clip> -frames:v 1 <png>`) and move the in-points if the actions moved.

Then `bun run play:package -- --render` renders the film into `release/publish/android/<version>/store/`.

## When to remake it

When a shown screen changes its look, when a shown feature changes, or when the listing's claims change. The film is checked against the build in gate C like the screenshots.
