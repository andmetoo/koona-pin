# Koona Pin launch motion

The rules for building Koona Pin's films in Remotion (`film/`): the Google Play preview first, later the site and Product Hunt. Adapted from a general SaaS launch-motion brief to this app: a calm, local-first bookmark library, not a dashboard. Sections 1–8 follow the brief, each adapted; 6a, 7a and 9 are ours.

The standard output is a 30-second film, 1920 × 1080 at 60 frames per second. The approved scenario (`scenario.md`) and clips of the app's own interface (`bun run play:clips`) are the source of truth.

## 1. Story first

Follow the approved sequence: attention, problem, product, payoff. Give every scene one focal point. Remove anything that does not do that scene's job. Do not invent scenes, reorder the scenario, or replace a recorded app action with decorative UI. The app's screens are clips of the app's own code (its phone shell in the browser preview, with demo data), never redrawn mock-ups: Play's review compares the film with the app, and a screen the build does not have is a listing that lies.

## 2. Timing and readability

Keep each caption and each key UI state readable for at least 1.5 seconds after its entrance (90 frames). Do not cut a recording mid-action: the title arriving after Go, the card leaving after a swipe, the list narrowing after typing are the payoff of their scene. Keep the logo and the last line readable for at least 2.5 seconds (150 frames). Use a one-second count only when a number carries the story; this film has none.

## 3. Group related elements

Treat each scene's group (the phone screen, its caption, its accents) like an After Effects parent: move the parent for composition and camera framing, animate the children only for local emphasis. Work on a fixed 1920 × 1080 canvas and place everything from its centre, never from the browser's edges. The phone screen is a 1080 × 2160 recording shown at a fixed height (about 860 px, so 430 px wide) with the app's corner radius, inside a phone of no make: a dark body with a 14 px bezel, a punch-hole camera and two side keys, no brand, no real model's outline or camera layout. The body gives the light app a frame on a light background; Play discourages device imagery in screenshots and the feature graphic, not in the video. Captions sit to one side of it, never over the app.

## 4. Stagger and overlap

Offset related child entrances by 3–4 frames. Start the next group's movement before the previous one has fully settled. Overlap scenes by 8–12 frames so the motion flows. Keep a slow drift of the background or the camera (1–2 % scale over a hold) so a readable hold is never frozen.

## 5. Easing and interaction

Give our own elements (captions, cards, chips, the logo) a softly eased entrance of about half a second (30 frames) with restrained overshoot, at most 2 % (`spring({damping: 20, mass: 0.6})` or `Easing.bezier(0.2, 0, 0, 1)` with no overshoot), then a faster exit (12–18 frames). Camera moves and the phone's travel accelerate and decelerate gently (`Easing.inOut(Easing.cubic)`), 24–36 frames. There is no cursor: this is a phone app, and the touches are in the recordings. The system's touch dots stay off; where a tap would be missed, one small soft circle (40 px, the accent at 30 %) grows and fades in 12 frames at the tap point, and a tapped control is never squashed or bounced on top of the recording. Never speed up or slow down a clip (no time remapping), so scrolling and swipes look as they do on a phone.

## 6. Component behavior

In the opening, the cards arrive one at a time: each card lands before the next one starts (a card every 8–10 frames, 18 frames to land), so the pile grows instead of appearing. In the recorded scenes the state changes are the app's own and come in its order (the title, then the picture, then "has a feed"; a card leaves, then the next one rises): hold each state until the next action starts, and never cut so that two changes land on the same frame. Overlays of ours (a caption, a highlight) cascade down the screen with 3–4 frames between them.

## 6a. Look

The app's palette and nothing else: the light theme's paper `#faf9f6` and ink `#2e302b` (`src/styles/app.css`), the accent `#2f6b4f` of `app-icon.svg` for one accent per scene at most. The background runs from warm paper to the app's green, with the accent glowing softly behind the phone, so the film is not pale; never pure white or black. Each caption has a short accent bar above it. No stock icons, no emoji, no store badges, no third-party logos, no prices.

## 7. Fonts and vector UI

The app's font is Inter (`--np-font`): load Inter through `@remotion/google-fonts` with the weights used (400, 600, 700) and wait until it is ready before frame zero; if it cannot be loaded, the render stops with an error that names the font, never falls back to a system font. Captions are sentence case, semibold, 64–72 px, one line where possible, two at most. Everything we draw (captions, cards, chips, the logo from `app-icon.svg`) is HTML or SVG, so it stays sharp at any zoom. The one exception is on purpose: the app's screens are clips of the app's own interface, never redrawn as SVG mock-ups, because review compares the film with the app (§7a).

## 7a. Truth in the frame

Only what the Android build does, shown by the app's own code of the same commit. Sample data only (`scripts/shots/`): made-up sites, feeds and authors, no real person's name or brand. The phone frame draws Android's bars as on a clean phone (9:41, full Wi-Fi and battery, no notifications). The preview never names itself in a frame («Koona Pin demo» reads «Koona Pin <version>»). A wait the person would sit through (a page's preview loading) may be cut out, never an action replaced by one the app does not do. If the app cannot do a scene's action, the scene leaves the scenario; it is not faked.

## 8. Framing and output

The master is exactly 1,800 frames: 30 seconds at 60 fps, 1920 × 1080. Title-safe margins: 90 px left and right, 54 px top and bottom; no caption, card or logo crosses them. One composition per film, each scene a component in its own `<Sequence>`, its timing in one table (`src/scenes.ts`): start, length, clip, the clip's in-point, caption. Clips are muted `<OffthreadVideo>` from `public/clips/`. Render H.264 MP4, `crf 18`, for the YouTube upload.

Plan the reframes with the master, not after it:

- **9:16 (1080 × 1920)**, for Shorts and stories: the phone is the subject, so it fills the middle (about 1300 px high), the caption sits above it inside the safe area, the payoff stacks logo, name and line under a smaller phone. The opening's pile is recomposed into a column, not cropped.
- **1:1 (1080 × 1080)**: the phone at about 860 px high, slightly left of centre, the caption to its right in two lines; the payoff puts the phone's top half above the name.
- In every format the focal point (the phone's screen) stays inside a centred protected region of 60 % of the width; crowded scenes are laid out again for the format rather than centre-cropped.

## 9. Check before handing over

Scrub the film frame by frame at every scene boundary: no empty frame, no jump, no caption on screen for less than 90 frames, nothing outside the safe margins. Watch it once at full speed and muted, as Play shows it. Compare every recorded scene with the scenario and the build (`../review.md`, gate C).
