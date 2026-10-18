# The phone shell (NP-072b)

The phone's own interface, "Paper & Glass" (`doc/mobile-design.md` in the notes, the NP-070 frames). It runs when `src/main.tsx` sees a phone platform; the desktop never loads its components, and its CSS is scoped under `.phone`, so the desktop's look cannot change. The split rules are in `docs/building.md`, "Phone builds: how the code is split".

## Where things are

| Path | What | Owner |
| --- | --- | --- |
| `PhoneShell.tsx` | The root: app state, stack, sheets, nav pill or rail, snackbar, sheet layer, dialogs | foundation |
| `PhoneContext.ts` | `usePhone()`, `useBottomLift()`, `usePrimaryAction()` (the rail's primary) | foundation, wave 2 |
| `ScreenStack.tsx` | Which screen a tab or route shows; on the Fold, in which pane | foundation, wave 2 |
| `PhoneDialogs.tsx` | The shared dialogs a phone still shows | foundation |
| `navigation/stack.ts` | The pure stack model: tabs, routes, Back, the Fold's panes and selection (Vitest) | foundation, wave 2 |
| `navigation/usePhoneStack.ts` | The stack in React, tab → app section, system Back at place 0 | foundation |
| `sheets/useSheets.ts`, `SheetLayer.tsx`, `registry.ts`, `useAppSheets.ts` | The sheet system | foundation |
| `ui/` | The kit (below) | foundation |
| `supporter/` | Supporter, sign-in and the plan as sheets; nothing sold where `capabilities.purchase` is `none` (the Play build until NP-154) | wave 2 |
| `screens/*Screen.tsx` | One file per screen, stubs now | wave 1 |
| `sheets/EditSheet.tsx`, `CollectionPicker.tsx`, `NewLinkSheet.tsx`, `YouSheet.tsx`, `BookmarkMenu.tsx` | One file per sheet, stubs now | wave 1 |
| `Rail.tsx` | The Fold's rail and its long-press popover (FL3) | wave 2 |
| `fold/` | The Fold's detail sheet: `PaneBar` (its circles), `DetailEmpty`, `savedLine`, `fold.css` | wave 2 |
| `screens/BookmarkScreen.tsx` | FL1: a bookmark in the detail sheet (route `bookmark`, Fold only) | wave 2 |
| `src/styles/phone.css` | Tokens and the kit's CSS | foundation |
| `src/platform/haptics.ts`, `keyboard.ts` | Haptics, the on-screen keyboard | foundation |
| `src/platform/system.ts` | The system's signals: battery saver, low RAM, the text scale | native |

Replace a stub in place: keep its file name, its export and its props type (`hidden`, `route`, `{ props }`), and the shell picks it up. A screen's own CSS goes in a file next to it (`screens/LibraryScreen.css`, imported by the screen) with classes under `.phone` and a prefix of its own (`.phone .lib-…`). Strings go to `src/locales/en.json` under the screen's own group (`phone.library.*`, `phone.inbox.*`, …) and into every other locale, as for the desktop (`docs/translating.md`).

## The app's state

```tsx
const { app, stack, sheets, fold, keyboardUp, pillShown } = usePhone();
```

`app` is everything `useAppState` returns, as on the desktop: `library` (bookmarks of the current section, `collections`, `tags`, `loadMore`…), `filters`, `counts`, `sectionCount`, `navigate`, `changeFilters`, `actions` (`open`, `favorite`, `trash`…), `editing`/`setEditing`/`saveEdit`, `say`, `undoing`, `supporter`, `sync`, `setSurface`, `feeds`, `feedPlace`, `t`. Read it, call it; the shell does not wrap it.

On a window wider than 840 dp (`fold`), the rail replaces the nav pill and the screen area holds two panes (below, "The Fold"). `hand` (`"right"` by default) and `setHand` keep the Fold's handedness per device (the preference `foldHand`); the shell mirrors the layout with `data-hand` on its root.

A tab sets the app's section itself (`navigation/usePhoneStack.ts`, `enterTab`): Inbox `navigate({ onlyInbox: true })`, All bookmarks `navigate()`, Reading `navigate({ onlyReading: true })`, Feeds `openFeeds(feedPlace.feed)`. A screen narrows further with `changeFilters` (search, a collection chip).

## Navigation and Back

```tsx
stack.push({ name: "reader", bookmarkId: b.id });
stack.replaceTop({ name: "reader", bookmarkId: next.id });
stack.back();          // as system Back: false at a tab's root
stack.selectTab("inbox");
```

Routes are typed in `navigation/stack.ts` (`reader`, `bookmark` (the Fold's), `post`, `search`, `settings` with an optional `page`); a new one is added there, in `ScreenStack.tsx` and in `paneOf`. The nav pill hides on a pushed route, with the keyboard up and on the Fold. System Back (Android Back, the iOS edge swipe) goes through `src/platform/back.ts`: what opened last closes first — a shared dialog, then a sheet, then the top route; at a tab's root it says false and Android moves the app to the background. Something else of a screen's own that Back should close (a menu, a selection) registers with `useBack(close, open)` from `src/platform/useBack.ts`; it sits above the stack. Pushed screens show a back circle (`Header onBack={stack.back}`): iOS has no Back button.

## The Fold (wave 2)

On a window wider than 840 dp (`fold`, an unfolded Galaxy Z Fold; frames FL1–FL3) the screen has two panes and the rail:

- **The rail** (`Rail.tsx`): chrome glass 72 wide, 32 from the edge the person holds (clear of the 24 back-gesture strip), 16 above the gesture inset; the four places, a hairline, the screen's primary action, "+". A long press opens its popover (move the controls to the other side, Layout settings…). It hides while the keyboard is up.
- **The list pane** next to the rail: the tab's screen, or Search over it. Its screens get `--safe-left/right: 0` and a 16 side margin.
- **The detail sheet** on the far side (raised paper r 28, e2): the topmost detail route — `bookmark` (FL1, `screens/BookmarkScreen.tsx`), `reader`, `post` (FL2), `settings` — or a calm empty state (`fold/DetailEmpty.tsx`). Inside it `--safe-*` are 0 and the page's colour is paper, so a phone screen fits as it is; a screen with its own circles along the sheet's top uses `fold/PaneBar.tsx` (`outer` on the edge side, `near` next to the list; the left hand mirrors them).

A row's tap goes through `stack.openBookmark(id)` / `stack.openPost(feedUid, itemId)`: a phone pushes the reader or the post; the Fold selects the bookmark's detail or the post into the detail sheet (`select` in `navigation/stack.ts`: what showed there closes). `usePhone().selected` names the bookmark or post the sheet shows, for the row's `data-selected` / `aria-current`. Back closes the newest route, so the selection first; Search's Cancel is `stack.leave("search")`. The screen in the sheet offers the rail's primary circle with `usePrimaryAction({ icon, label, run, pressed }, fold && !hidden)` (Read on a bookmark, Save on a post).

Folding and unfolding keeps every screen mounted in the same pane containers (on a phone they take no box), the sheets and their drafts: a phone's pushed reader or post shows in the detail sheet; when the Fold closes, a `bookmark` route becomes its reader (`forPhone`).

## Sheets

```tsx
const sheets = useSheets(); // or usePhone().sheets
sheets.open({ kind: "collectionPicker", props: { bookmarkIds: [id] } });
sheets.close();             // the top one
```

Kinds and their props are in `sheets/registry.ts`; a sheet's props type is exported from its own file. A sheet component renders the kit's `Sheet`: `variant="detached"` (compact, over a scrim) or `variant="attached"` with `bar={<SheetBar left={Cancel} title="Edit link" right={Save} />}` (full height, the bar above the keyboard). Inside, `useCloseSheet()` closes it. Each open sheet answers Back; the scrim, a drag down on the grabber or the top, Escape and the close circle dismiss it. Long-press menus are sheets; `bookmarkMenu` and `feedMenu` open with a haptic tick.

Two of the app's own ways in are wired by the shell (`sheets/useAppSheets.ts`): `app.setEditing(bookmark)` opens the `edit` sheet and closing it closes the editor (the edit sheet reads `app.editing`; key its form by `app.editing.id`); `app.setSurface("add")` opens `newLink`.

## Snackbar

Say it through the app, as the desktop does: `app.say(text)`, `app.say(text, false, undoing(command))` for Undo, `app.say(text, true)` for an alert. The shell shows `app.notice` as the snackbar (toast glass, 5 s, paused while touched; an alert stays until closed) above the nav pill. A screen with its own floating bar at the bottom (triage's decision pill) raises it: `useBottomLift(72)`.

## Haptics

```ts
import { selection, impactLight, impactMedium, success } from "../../platform/haptics";
```

`selection()` on a section or tab change (the stack does it for tabs), when pull-to-refresh arms and when a long-press menu opens; `impactLight()` when a triage swipe passes its threshold; `impactMedium()` when a decision lands; `success()` when the inbox is sorted. Without the `haptics` capability (desktop, browser demo) they do nothing; they never throw. The koona-mobile plugin plays them as the system's own feedback (Android `performHapticFeedback` on the WebView, iOS UIKit's generators), so they are silent while the system's touch feedback is off.

## The kit (`ui/`)

| Component | Use |
| --- | --- |
| `Screen`, `Header` | Every screen: `<Screen label hidden route?><Header title meta? beside? actions? account? onBack?>…</Header>…</Screen>`. The account cluster appears in every header unless `account={false}` |
| `Glass`, `glass(level)` | Floating chrome only (`chrome`, `sheet`, `toast`) |
| `NavPill`, `AccountCluster` | Used by the shell; `accountState.ts` maps Supporter and sync |
| `CircleButton` | `kind` glass (over content), clear, flat, well, accent, ink |
| `Button` | `kind` primary (one per screen), clear, soft, ink, ghost; `compact` 44 |
| `Chip` | `active`, `dot` (`collectionColor(id)`), `suggested`, `large` (40, triage) |
| `Segmented`, `SearchField`, `Field`, `Toggle`, `Checkbox` | Controls |
| `Shelf`, `ShelfRow` | One paper surface per section; rows with inset hairlines |
| `Progress` | Pill track, "5 of 12" |
| `Snackbar` | Used by the shell |
| `Sheet`, `SheetBar`, `useCloseSheet` | Sheets |
| `useLongPress` | Long press with a slop and a swallowed click |
| `PhIcon`, `ICON` | Lucide at the spec's sizes; `ClipIcon`, `InboxTray`, `CloudCheck` |

`ui/KitGallery.tsx` shows the kit beside the Components board; nothing in the app imports it (`tests/phone/kit.spec.ts` mounts it).

## CSS and tokens

`src/styles/phone.css`: tokens `--ph-*` (light, and dark under `[data-theme="dark"]`), the type scale (`.ph-display`, `.ph-title1`, `.ph-title2`, `.ph-headline`, `.ph-row`, `.ph-body`, `.ph-callout`, `.ph-subhead`, `.ph-meta`, `.ph-caption`, `.ph-eyebrow`, `.ph-reading` in Literata), radii, spacing, elevation (`--ph-e1`, `--ph-e2`), the glass levels, the mesh background, the edge fades, collection colours (`--ph-coral` … or `collectionColor(id)`) and the season (`--ph-season`). Insets are `--safe-*` only. Glass (backdrop-filter) is for floating chrome, sheets and the snackbar, never for rows, cards or chips; cards are opaque paper with at most two glyphs; animate transform and opacity only; touch targets at least 48 (`.ph-hit`).

The glass falls back to opaque paper under Reduce Transparency, without `backdrop-filter`, and with `data-glass="flat"` on the shell's root, which the shell sets while Android's battery saver is on and on a low-RAM device (`useSystemSignals()` from `src/platform/system.ts`; the koona-mobile bridge reports both before the first render and battery saver again when it changes). iOS Low Power Mode is not reported yet.

The system's font size (Android's font scale, up to 2.0) reaches the page as the WebView's text zoom, which the koona-mobile plugin keeps equal to it while the app runs: every `font-size` and `line-height` grows, boxes with a fixed height do not. The root carries the scale as `--ph-text-scale` (what must keep its size divides by it, as the nav pill's badge does) and `data-text-large` from the first accessibility size (1.6, `largeText()`), where a shelf row's value goes under its name and floating chrome with labels puts them under its icons (the spec; triage's decision pill does not yet). A screen with fixed heights checks itself at 1.3 and 2.0 (`adb shell settings put system font_scale 2.0`); the list measures the scale with `library/useTextScale.ts`.

## Dialogs the phone still shows

From shared code, opened by `app.surface` and the app's state (`PhoneDialogs.tsx`): the 5-year upgrade (only where the build sells), sync; import (bookmarks, feeds), a `.kpin` list, restore, backups, feedback, a new collection; the confirmations of deleting a collection and deleting for good; the feeds' own dialogs (`app.feedMenu.dialogs`). Replaced on the phone: `add` (the `newLink` sheet), the editor drawer (the `edit` sheet), the reading sheet and reading mode (the `reader` route), Supporter, sign-in and the plan (the `supporter`, `signIn` and `plan` sheets in `supporter/`, opened from `app.surface` by `useSupporterSheets`). Left out: the desktop's update, background, assistants and browser-capture dialogs, and the share bundle.

## Tests

Vitest: `navigation/stack.test.ts`, `fold/savedLine.test.ts`, `ui/accountState.test.ts`, `src/platform/haptics.test.ts`, `src/platform/keyboard.test.ts`, `src/platform/system.test.ts`. Playwright: `tests/phone/` (project `phone` of `playwright.config.ts`) with `tests/phone/fixtures.ts` (`openPhone` with an optional `system` for the signals, `systemBack`, `systemChanged`, 393×852 and the Fold's 1088×821); the Fold's own in `tests/phone/fold.spec.ts`.
