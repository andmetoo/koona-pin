# App Store listing

What App Store Connect asks for, for the iPhone app `app.koona.pin` (English (U.S.), the primary and only language; free with in-app purchases). The owner fills App Store Connect; this folder keeps the texts to paste, the answers and the pictures. Counterpart of [Google Play's](../play/README.md). Written for the first iPhone release (app 2.22.0) and checked against the iPhone build on 10 November 2026. When the app changes what it does, change the texts here and in App Store Connect together.

The review information (the review account, its code, the contact and the notes for App Review) is kept privately, not here.

**Before the first submission**: the three in-app purchases exist in App Store Connect with the ids below (they can never be reused), with the App Store Server Notifications V2 URLs (production and sandbox) and the In-App Purchase key of the server; the subscriptions go to review together with the first app version, so they must be "Ready to Submit" and added to it.

The build is `bun run build:ios` ([docs/building.md](../../../docs/building.md)), uploaded with `--upload`.

## App information

Character limits are Apple's; the counts were checked.

| Field | Value |
| --- | --- |
| Name (30) | `Koona Pin: Bookmark Library` (27) |
| Subtitle (30) | `Save links, read them later` (27) |
| Primary category | Productivity |
| Secondary category | Reference |
| Content rights | Yes, the app shows third-party content: reading mode and feeds show pages and posts of sites the person chooses. Whether "I have the rights" can be ticked is the owner's decision |
| Age rating | Below |
| Price | Free (Supporter is an in-app purchase) |
| Availability | Every storefront except **France** (no French encryption declaration yet, see "Export compliance") and **China mainland** (an app there needs an ICP filing, which only a Chinese legal entity can hold). Release: **Manually release this version**, as Play's managed publishing |
| Copyright | `© 2026` and the developer's registered business name, as in [LICENSE-COMMERCIAL.md](../../../LICENSE-COMMERCIAL.md) |
| Version "What's New" | Below |
| Support URL | https://koona.app/pin/feedback (the site's feedback form; the help pages are at https://koona.app/pin/help/) |
| Marketing URL | https://koona.app/pin/ |
| Privacy Policy URL | https://koona.app/pin/privacy |
| Terms of Use (License Agreement) | Apple's standard EULA, with the terms linked in the description (the description below does that; the terms page also carries Apple's minimum terms: Apple is not a party, third-party beneficiary). The other way is the custom license: https://koona.app/pin/terms/ in the "License Agreement" field. Pick one and keep it |
| Account deletion URL (shown to App Review, not a store field) | https://koona.app/pin/delete-account/ (in the app: You & sync, the Supporter card, "Delete account…") |
| Sign in with Apple | Not needed (guideline 4.8): the only sign-in is the app's own email code, not a third-party or social login |
| Bundle ID, SKU | `app.koona.pin`; SKU any internal string |

## Promotional text (170) and keywords (100)

Promotional text (the line above the description, editable without a new version), 152 characters:

```text
Your links, sorted. Swipe through the Inbox, search everything as you type, and read articles without the clutter. Share from Safari to save in one tap.
```

Keywords, 94 characters. Words of the name and subtitle ("koona", "pin", "bookmark", "library", "save", "links", "read", "later") are indexed already and are not repeated; no other brands. "offline" is left out: offline copies are the desktop's.

```text
inbox,rss,feed,reader,article,archive,organize,tags,collections,search,sync,private,notes,list
```

## Description (4000)

2,657 characters, written against the iPhone build of 2.22.0 (no import on iPhone, no tag filter, tags added in the editor, the reading text size set in the app). Apple wants the subscription terms in the description when no custom license is used: the last paragraphs. The prices come from StoreKit in the app, so the text names none (they differ by storefront).

```text
Koona Pin keeps the links you want to come back to: articles, videos, recipes, tools, anything with an address. It is the iPhone app of Koona Pin for Windows, macOS and Linux.

Save from anywhere
Tap Share in Safari or any app and choose Koona Pin: the link lands in your Inbox, even when the app is closed. Or paste a link or type one, and Koona Pin fetches its title and picture. When the site has a feed, it offers to follow it.

Sort your Inbox
New links wait in the Inbox. Go through them one card at a time: swipe to keep, trash or send to Reading, and file each into a collection. Add tags and notes when you edit a link.

Find it again
Search looks through titles, addresses, notes and tags as you type, in any language. Browse by collection, favourites or the Reading list.

Read later
The Reading list remembers where you stopped. Reading mode shows an article as clean text, with the text size, font and theme you choose, without the page around it. Tap a picture to see it full size.

Follow sites
Follow RSS, Atom and JSON feeds. Posts come straight from the sites to your phone, in Unread and All; save the ones worth keeping.

Your library stays on your phone
The library is a file on your device. Koona Pin shows no ads, has no tracking and sends no analytics, telemetry or crash reports. It requests pages, pictures and feeds from the sites of the links you save and the feeds you follow. It talks to Koona for your Supporter plan and, with sync on, to a relay that passes your end-to-end encrypted library between your devices and keeps nothing. Feedback goes out only when you send it.

Supporter
Koona Pin is free. Supporter is optional and adds sync between your iPhone and your computers, the Paper and Sepia reading themes and the Supporter heart. With sync, the bookmarks you import on a computer and the collections you arrange there come to your iPhone. Choose Supporter monthly, Supporter yearly (both auto-renewing subscriptions) or Supporter one-time purchase (paid once, no renewal). The price of each is shown in the app before you confirm.

Payment is charged to your Apple Account at confirmation of purchase. A subscription renews automatically at the same price and length unless it is cancelled at least 24 hours before the end of the current period; your account is charged for renewal within 24 hours before the period ends. Manage or cancel a subscription in your Apple Account's subscription settings (Settings > your name > Subscriptions, or Manage in the app's Supporter screen). Restore purchases is in the Supporter screen.

Terms of Use: https://koona.app/pin/terms/
Privacy Policy: https://koona.app/pin/privacy
```

## What's New of the first version (4000)

The first release, so a summary of the app rather than of changes (270 characters):

```text
The first release of Koona Pin for iPhone: the library, the Inbox, search, collections and tags, the Reading list with reading mode, feeds, and Share from Safari. Supporter adds sync with your computers. Tell us what breaks: You & sync > Settings > Help > Send feedback.
```

Later versions summarise what changed since the previous one, from the changelogs of the versions in between.

## In-app purchases

Three products, made by hand in App Store Connect; their ids are the app's (`src-tauri/src/billing/appstore.rs`) and the server's, and can never be reused. Localisation English (U.S.); the names are the app's (`supporter.monthly`, `supporter.yearly`, `supporter.lifetime` in `src/locales/en.json`).

| Product id | Type | Reference name | Display name (30) | Description (45) | Price (USD) |
| --- | --- | --- | --- | --- | --- |
| `app.koona.pin.supporter.monthly` | Auto-renewable subscription, 1 month | Supporter monthly | `Supporter · monthly` (19) | `Sync, reading themes, Supporter heart` (37) | 1.49 |
| `app.koona.pin.supporter.annual` | Auto-renewable subscription, 1 year | Supporter yearly | `Supporter · yearly` (18) | `Sync, reading themes, Supporter heart` (37) | 9.99 |
| `app.koona.pin.supporter.lifetime` | Non-consumable | Supporter one-time | `Supporter · one-time purchase` (29) | `Sync, reading themes, Supporter heart` (37) | 29.99 |

- The two subscriptions are one subscription group, display name `Supporter` (what the App Store's manage page shows).
- The prices are the USD and EUR points of 2.14.0; App Store Connect picks the nearest price point in each storefront: check that it is the one meant.
- `src-tauri/gen/apple/Supporter.storekit` (the test products of a Debug Run from Xcode) names them "Supporter · Monthly", "Supporter · Yearly" and "Supporter · One-time"; the store's display names above are the ones App Store Connect shows to buyers.
- No introductory offer or free trial: the app and the terms promise none.
- Each product needs a **review screenshot**: the same one for all three, the app's Supporter sheet with the three plans and their prices, [`review/supporter.png`](review/supporter.png) (below), and review notes ("Sandbox purchase; see the app review notes").

## Age rating

Apple's questionnaire of 2025/2026. The answers, with the reason; the rating they give is checked in App Store Connect, and the only answer that can move it is web access.

| Question | Answer | Why |
| --- | --- | --- |
| Cartoon or fantasy violence; realistic violence; prolonged graphic or sadistic violence | None | The app makes no content |
| Sexual content or nudity; graphic sexual content | None | |
| Profanity or crude humour | None | |
| Horror or fear themes | None | |
| Mature or suggestive themes | None | |
| Alcohol, tobacco, drugs | None | |
| Simulated gambling; real gambling and contests | None / No | |
| Medical or treatment information; health or wellness topics | None / No | |
| Loot boxes | No | |
| Unrestricted web access | **Yes** | The same answer as on Play (below) |
| User-generated content; messaging and chat; advertising | No / No / No | Sync and sharing go between one person's own devices; no ads |
| Social media capabilities (asked since September 2026, for Time Allowances) | No | No profiles, feeds of other people or sharing to others |
| Shared Location (asked from 16 November 2026) | No | The app never reads the location |
| Dating and Relationships (asked from 16 November 2026) | No | |
| Parental controls; age assurance in the app | No | |
| Made for Kids | No (not a Kids category app) | |

**Web access.** Apple asks "Unrestricted web access" of apps that browse arbitrary sites. Koona Pin opens links in the system browser and shows saved pages in reading mode and posts of followed feeds in the app, from sites the person chose; it has no address bar, no search engine and no free browsing. The answer is **Yes**, as on Play, so both stores say the same; the rating follows from it (13+ or higher is possible).

**The November 2026 questions** ([Apple, 2 November 2026](https://developer.apple.com/news/?id=yxkh08us)): from 16 November 2026 App Store Connect asks Shared Location and Dating and Relationships with every submission, and every app must have answered them by 12 January 2027. Both are No.

## Export compliance

As for the TestFlight uploads (`docs/building.md`, the iOS build): the app has **no** `ITSAppUsesNonExemptEncryption` key (a `YES` without an approved compliance code fails validation), so App Store Connect asks per build:

- Does the app use encryption? **Yes** (HTTPS to sites and to Koona, WSS to the sync relay, end-to-end encryption of the synced library).
- Does it use only standard algorithms, instead of or in addition to what Apple's operating system provides? **Yes**, standard algorithms (TLS through rustls, AEAD and signatures through ring); nothing proprietary.
- Qualifies for an exemption, no CCATS: **yes**, standard algorithms.
- France: **No** French declaration, so France is left out of availability until one is filed.
- The US annual self-classification report: to be confirmed with someone who can say (this is not legal advice).

## App Privacy

The "nutrition label", from what the app sends, read from the code. Answer in App Store Connect's order. The questions are about the **developer's own collection and the third parties the app sends data to**: data that stays on the device is not "collected".

**Tracking.** Does the app or any third party in it track people across other companies' apps and sites? **No.** `NSPrivacyTracking` is `false`, no tracking domains. No ads, no advertising id, no SDKs.

**Data collected**, each optional or tied to a feature the person turns on:

| Data type (Apple's) | Collected | Linked to the person | Tracking | Purpose | What, and where in the code |
| --- | --- | --- | --- | --- | --- |
| Contact Info → Email Address | Yes | Yes | No | App Functionality | The email of the sign-in or of a purchase's claim, asked only when the person signs in or buys Supporter (`billing.rs`: the code request and its verification), and the account the server keeps; the optional reply address of feedback (`feedback.rs`) |
| Purchases → Purchase History | Yes | Yes | No | App Functionality | The App Store transaction the app sends for verification (`billing/appstore.rs`): transaction ids, product, state, paid period, bound to the account. No card, no Apple Account. App Store Server Notifications reach the server from Apple |
| Identifiers → User ID | Yes | Yes | No | App Functionality | The account id inside the sign-in token that the sync relay checks (`commercial/sync`) |
| Identifiers → Device ID | Yes | Yes | No | App Functionality | Only with sync on: the random id this install makes for sync, with its public key, its name and the app version, listed on the relay (`commercial/sync`, `identity.rs`). Not the advertising id and not a system id. See the device name note below |
| User Content → Customer Support | Yes | Yes (an email may be attached) | No | App Functionality | Feedback: its type, the message and the optional email, only when the person presses Send (`feedback.rs`) |
| Diagnostics → Other Diagnostic Data | Yes | Yes (sent together with the above) | No | App Functionality | With feedback: the app version, the system and the interface language, and the report only if "Attach report" is ticked (`feedback.rs`); no links, titles, tags or notes |

**Not collected, with the reason:**

- **The library** (links, titles, notes, tags, collections, feeds, reading progress): on the device. With sync it travels end-to-end encrypted with a key only the person's devices hold; the relay cannot read it and keeps nothing.
- **Pages, feeds and pictures of saved links**: requested from the sites the person chose, from the phone (`metadata.rs`, `feeds/fetch.rs`); they never pass through Koona. Site icons too come only from the site itself on phones.
- **The share extension**: no network, no Rust, no WebView; it writes the address, the page's title and the time into a queue file in the App Group container (`plugins/koona-share`). On the device only.
- **Search, usage, product interaction, crash data, performance data, location, contacts, photos, health, financial info, sensitive info, ids for advertising**: none sent. The app has no analytics, telemetry or crash reporting; the desktop's updater, its only periodic call to koona.app, is not in the iPhone build.
- **IP address**: every request reveals it. The server keeps no IP address next to an account; the feedback function keeps a salted hash of the connection's address for one day against spam (the privacy policy says so). Apple's label has no IP address type, and it is not declared separately.

**Summary for App Store Connect:** "Data Linked to You": Email Address, Purchase History, User ID, Device ID, Customer Support, Other Diagnostic Data. "Data Not Linked to You": none. "Data Used to Track You": none.

**Device name note.** The sync device name is what the person typed; on an iPhone an empty one becomes "iPhone" and one random Latin capital ("iPhone K"), never the system's host name, which may carry the person's name. It is shown in the person's own device list and stored on the relay; the label has no better type than "Device ID" for it.

**The privacy manifest** (`src-tauri/gen/apple/koonapin_iOS/PrivacyInfo.xcprivacy`) declares the same six types as the label, each linked and for App Functionality.

## Screenshots

Koona Pin is iPhone only (device family iPhone), so only iPhone screenshots are asked for.

- **6.9-inch display**, portrait **1320 × 2868** (iPhone 16/17 Pro Max class; 1290 × 2796 and 1260 × 2736 are also accepted for that slot). Every smaller iPhone size is scaled from this set. Check App Store Connect's list on the day: it changes with new phones.
- **iPhone Duo screenshots** are required for every submission from April 2027 ([Apple, 5 October 2026](https://developer.apple.com/news/?id=kkphp5qo)); not for the first release. The Duo layout exists, so a Duo set (the inner display with the side bar) is due before then.
- 3 to 10 screenshots: 7 here. PNG, RGB, no alpha. Light theme, English, the status bar in its demo state (9:41, full battery and signal), the sample library of `scripts/shots/library.json` and `feeds.json`, as Play's. No device frames, no captions in the picture (a caption for each is suggested below, if the owner wants them). No App Preview video. The icon (1024 × 1024, no alpha) is in the asset catalog (`gen/apple/Assets.xcassets`).

| # | File (`en-US/`) | Screen | Caption |
| --- | --- | --- | --- |
| 1 | `iphone-1-library.png` | The library, its list with the sample's previews | Everything you saved |
| 2 | `iphone-2-inbox.png` | The Inbox mid-triage: the first card dragged towards Keep, the next one under it, the three actions | Sort in one swipe |
| 3 | `iphone-3-reading.png` | Reading mode: a feed's post with its picture (a saved link's reading mode fetches the page, and the sample's sites are made up) | Read without the clutter |
| 4 | `iphone-4-search.png` | Search for "home": a title, a tag and an address in the library, a feed's post, the keyboard up | Find it as you type |
| 5 | `iphone-5-feeds.png` | Feeds, Unread, posts with their pictures | Follow the sites you like |
| 6 | `iphone-6-share.png` | The share extension's "Saved to Koona Pin" confirmation over a page of koona.app in Safari (greyed behind it): In Inbox, the page's title, Done. Not the share sheet itself, whose row of apps shows other apps' icons | Save from any app |
| 7 | `iphone-7-supporter.png` | The Supporter sheet, its three plans with prices | Sync with your computers |

The in-app purchases' review screenshot (not shown on the store), 1320 × 2868: `review/supporter.png`, the Supporter sheet as the app shows it, with Yearly, Monthly and One-time and their prices, Restore purchases and the terms; the same file for all three products. It is shot 7: Apple's own purchase sheet is left out, because in the StoreKit test environment it is titled "Xcode" and says "For testing purposes only".

How they are made: an iPhone 17 Pro Max Simulator (iOS 27.0, English (U.S.)) with the Simulator build of the app (`bun run build:ios:sim -- --appstore`), filled with the sample library, its pictures and the feeds and with the status bar set by `bun scripts/appstore-shots.mjs` (`--demo` only the status bar, `--shoot <file>` a screenshot without alpha); the screens are reached by hand. The sample feed whose made-up name carries another company's brand is left out of the iPhone set: no other company's name on the store's pictures. Shot 7 (and so the review screenshot) comes from a Debug Run from Xcode on the same Simulator, whose scheme gives the test products of `src-tauri/gen/apple/Supporter.storekit`: no purchase is made. Retake them when a shown screen changes.
