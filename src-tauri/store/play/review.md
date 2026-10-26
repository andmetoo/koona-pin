# Submitting to Google Play review

A process to go through for every build sent to production review, so the result does not depend on memory. Copy the record at the end into the release's notes and fill it as you go. A gate either passes with proof or blocks the submission: nothing is "probably fine".

Rules checked on 26 October 2026. Before each submission open the two pages at the top of the list below and look for announcements newer than that date; when a rule changed, change this file in the same PR as the build.

## The rules this process follows

| Rule | Source | What it means here |
| --- | --- | --- |
| Policy announcements | [Play Console announcements](https://support.google.com/googleplay/android-developer/announcements/13412212?hl=en) (each one links its Policy deadlines table), [Developer Policy Center](https://play.google/developer-content-policy/) | read first, every time |
| Functionality and user experience: Minimum Functionality, Broken Functionality | [answer/9898783](https://support.google.com/googleplay/android-developer/answer/9898783) | the app must install, load, respond and not crash or freeze, and give real functionality. Review installs the build and uses it |
| Metadata (store listing) | [answer/9898842](https://support.google.com/googleplay/android-developer/answer/9898842) | the description must accurately describe what the app does; screenshots and the video must show the app's actual experience. Title ≤ 30 characters, no emoji, ALL CAPS, rankings, prices or "New" in the title, icon or developer name; no anonymous testimonials |
| Spam: webviews | [answer/9899034](https://support.google.com/googleplay/android-developer/answer/9899034) | an app that is only a website in a webview is refused. Koona Pin is a local app (its own library database, Rust core) drawn in a webview: show that in the screenshots and the video |
| Preview assets | [answer/9866151](https://support.google.com/googleplay/android-developer/answer/9866151) | sizes below |
| Target API level | [July 15, 2026 announcement](https://support.google.com/googleplay/android-developer/answer/17134731) | targetSdk 36 from 31 August 2026 (`src-tauri/gen/android/app/build.gradle.kts`) |
| Developer verification | same announcement | the app is registered in Play Console (Home page shows it); unregistered apps are removed |
| Account deletion | [answer/13327111](https://support.google.com/googleplay/android-developer/answer/13327111) | the app creates accounts (a Play purchase claimed by email), so deletion in the app and on the web: https://koona.app/pin/delete-account/ |
| Payments | [answer/9858738](https://support.google.com/googleplay/android-developer/answer/9858738) | digital goods only through Play Billing in the Play build (`--play`) |
| Content ratings | July 15, 2026 announcement | an unrated app is not allowed: the IARC questionnaire is filled (README) |

**The change that matters most (2026):** review treats "works and does what the listing says" as one requirement. The description, the screenshots and the video are checked against the installed build. Every sentence of the full description is therefore a claim to test (gate C), and a feature that is not in the build, or not on phones, is taken out of the text before submitting.

## Gate A: the build

1. A clean detached worktree of `origin/main` with `.env` copied from the main checkout (`.claude/worktrees/android-release`: `git fetch`, `git checkout --detach origin/main`, copy `.env`, `bun install --frozen-lockfile`).
2. `bun run build:android -- --play`. The script refuses unless the package, version, SDK levels, not-debuggable, the upload-key signer, bundletool's validation and the 16 KB page alignment all pass, and prints `Checked: …`. Keep that line.
3. The file: `release/publish/android/<version>/koona-pin-<version>-play-<versionCode>.aab`. The versionCode is higher than any uploaded one (else `--build <n>`).
4. Upload to **Internal testing** first (the owner, in Play Console). Wait for the **pre-launch report** and open it: no crashes, no ANRs; read its accessibility and security warnings; fix what is a real defect.

## Gate B: it works (Broken and Minimum Functionality)

Install the internal-testing build **from Play** (not a sideloaded APK) on a real phone, and on the emulator `Medium_Phone_API_37.0`, from an empty install. Then:

| # | Check | Pass when |
| --- | --- | --- |
| B1 | First start, online | the library opens within a few seconds, no blank screen |
| B2 | First start in airplane mode | the app opens and explains what needs the network; nothing hangs |
| B3 | Save a link (type or paste, Go) | the title and picture arrive; offline it saves with the address |
| B4 | Inbox | swipe keep, trash and read later; file into a collection with tags |
| B5 | Search | finds by title, address, note and tag while typing; Cyrillic and CJK |
| B6 | Collections | create, nest, move, rename, icon and colour; counts add up |
| B7 | Reading list and reading mode | an article opens as clean text, the place is remembered, pictures zoom |
| B8 | Feeds | follow a site with a feed, posts arrive, save a post |
| B9 | Import | a browser's HTML export and an OPML file through the system picker |
| B10 | Supporter | the purchase sheet opens from You & sync → Supporter; a license tester buys and claims |
| B11 | Account deletion | You & sync → delete account works; the web page works |
| B12 | System | Back closes sheets before leaving, rotation and the Fold layout, dark theme, large font size, kill and restart keeps the library |
| B13 | Stability | 10 minutes of the above with `adb logcat -b crash` empty |

A failure blocks the submission until fixed in a new build (gate A again).

## Gate C: the listing says what the build does (Metadata)

1. Take the full description from `README.md` in this folder. For every sentence that states a feature, write a row in the record's claim table: the claim, where it is in the app, and the result on **this** build. A claim that is false, desktop-only or not finished is rewritten or removed now (examples: sharing from other apps is iPhone-only so far; offline copies are desktop-only).
2. The short description and the title pass the same test.
3. Screenshots: taken from this build or a build with the same screens (README, "Phone screenshots"), real UI, clean status bar (demo mode), no device frames, captions under 20 % of the image. Retake any screen that changed.
4. The video (if any): at least 80 % real app use, real use within the first 10 seconds, nothing shown that the build does not do (`video/scenario.md`).
5. The "What's new" text names only what is in this build.

## Gate D: App content in Play Console

All answers in `README.md` here, checked against the code of this build:

- Privacy policy URL opens and covers phones.
- Data safety matches what the build sends (README table). Any new network call, SDK or permission since the last submission is either declared or removed. The open decision on Google's favicon service is settled before production.
- App access: the reviewer instructions are current (where Supporter is, that nothing needs signing in). If a sign-in is needed to reach a feature, give a review account.
- Ads: no. Content rating: done. Target audience: 18+. News app: no. Financial features, health, government: no.
- Developer verification: the app shows as registered on the Home page.
- Monetisation: the products in the README exist and are active; prices match the app and the site.

## Gate E: the assets

| Asset | Requirement | Ours |
| --- | --- | --- |
| Icon | 512 × 512, 32-bit PNG, ≤ 1 MB | `en-US/icon-512.png` |
| Feature graphic | 1024 × 500, JPEG or 24-bit PNG without alpha, focal point centred, not pure white or black | `en-US/feature-1024x500.png` |
| Phone screenshots | 2 to 8, sides 320–3840 px, long side ≤ 2 × short; 4 or more at 1080 × 1920 or more for recommendations | five at 1080 × 2160 |
| Tablet screenshots | 4 or more, 16:9 or 9:16, 1080–7680 px, if tablets are offered | the Fold layout, when we offer tablets |
| Preview video | a YouTube URL (public or unlisted), ads off, not age-restricted, embeddable; the first 30 s autoplay | `video/` |

`file` or an image viewer confirms the sizes and that PNGs have no alpha where it is not allowed.

## Gate F: submit

1. Promote the build that passed gates B and C (the same versionCode) from Internal testing to **Production**, with a staged rollout (20 %).
2. Release notes: the version's changelog, summarised.
3. Send for review. Review takes from hours to several days; new apps and apps with Billing take longer.
4. On a rejection: copy the email into the notes, find the gate that should have caught it, fix the build or the listing, and add the missing check to this file in the same PR.

## The record

```text
Version / versionCode:        Date:        Commit:
Rules re-read (date of newest announcement):
A  Checked line:                                  Pre-launch report:
B  Device:              Emulator:                 Failures:
C  Claims: all pass / rewritten:                  Screenshots from build:     Video:
D  Data safety unchanged / changed:               Review instructions current:
E  Sizes checked:
F  Rollout:        Sent:        Result:
```

| Claim (from the full description) | Where in the app | Result |
| --- | --- | --- |
| | | |
