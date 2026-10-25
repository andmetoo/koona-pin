# Google Play listing

What Play Console asks for before a closed test, for the app `app.koona.pin` (English (US) by default, free). The owner fills the console; this folder keeps the texts and the pictures. Prepared on 20 October 2026 for app 2.8.0, before Share (the phone's share sheet), sync on phones and store purchases: update the texts when they land. Updated for 2.9.0, where the Play build sells Supporter through Google Play Billing.

**Before a build with Play Billing goes up** (`bun run build:android -- --play`), Play Console's Monetisation setup must exist: the organization's payments profile, the subscription `supporter` with the auto-renewing base plans `monthly` and `annual` (yearly; `yearly` and `yearly-pin` were saved as monthly by mistake and are inactive), and the one-time product `supporter_5_years` (the one-time purchase, $29.99; the five-year plan's product, renamed «One-time purchase» in Play on 2026-10-25 — it was never bought, and Play does not let an id be renamed). Those ids are the app's (`src-tauri/src/billing/play.rs`) and the server's secrets; a product Play does not know is simply not offered.

The App Bundle is `release/publish/android/<version>/koona-pin-<version>-<build>.aab` from `bun run build:android` with the upload key ([docs/building.md](../../../docs/building.md)).

| Field | Value |
| --- | --- |
| App name (30) | `Koona Pin: Bookmark Library` |
| Category | Productivity |
| Tags | Bookmarks, Productivity, News reader (pick from Play's list) |
| Website | https://koona.app/pin/ |
| Email | the owner's support address |
| Privacy policy | https://koona.app/pin/privacy |
| App icon 512×512 | `en-US/icon-512.png` (a full square: Play rounds the corners) |
| Feature graphic 1024×500 | `en-US/feature-1024x500.png` |
| Phone screenshots, in order | `en-US/phone-1-library.png`, `phone-2-inbox.png`, `phone-3-reading.png`, `phone-4-search.png`, `phone-5-library-dark.png` (1080×2160) |

`bun scripts/play-assets.mjs` redraws the icon and the feature graphic from `app-icon.svg`. The screenshots come from a debug x86_64 build on the emulator `Medium_Phone_API_37.0` at 1080×2160 (`adb shell wm size 1080x2160`: Play refuses a side more than twice the other, and the emulator's 1080×2400 is), with the sample library of the site's shots (`scripts/shots/library.json`) restored through the WebView's DevTools and its previews put in the picture cache, and the status bar in demo mode. Retake them when Share or sync on phones lands.

## Short description (80)

```text
Save links, sort your Inbox, search everything and read later. On your phone.
```

## Full description (4000)

```text
Koona Pin keeps the links you want to come back to: articles, videos, recipes, tools, anything with an address. It is the phone app of Koona Pin for Windows, macOS and Linux.

Save a link
Paste a link or type one, and Koona Pin fetches its title and picture. It notices when a site has a feed, so you can follow it in one tap.

Sort your Inbox
New links wait in the Inbox. Go through them one card at a time: swipe to keep, trash or read later, and file each into a collection with tags.

Find it again
Search looks through titles, addresses, notes and tags as you type, in any language. Filter by collection, tag, favourites or the Reading list.

Read later
The Reading list remembers where you stopped. Reading mode shows an article as clean text, without the page around it.

Follow sites
Follow RSS, Atom and JSON feeds. Posts come straight from the sites to your phone; save the ones worth keeping.

Your library stays on your phone
The library is a file on your device. Koona Pin shows no ads and sends no analytics, telemetry or crash reports. It requests pages, pictures and feeds from the sites of the links you save and the feeds you follow, and asks Google's icon service for site icons. It talks to Koona for your Supporter plan (with a purchase, Google Play's receipt of it and the email you give to claim it), with sync on to the sync relay, which passes your end-to-end encrypted library between your devices and keeps nothing, and for feedback, only when you send it.

Bring your bookmarks
Import bookmarks from a browser's HTML export, and feeds from OPML.

Supporter
Koona Pin is free. Supporter is an optional subscription, or a one-time purchase, bought in the app through Google Play: it adds sync between your phone and your computers, the Paper and Sepia reading themes and the Supporter heart.
```

## Release notes of the first closed test

```text
The first test build of Koona Pin for Android: the library, the Inbox, search, collections and tags, the Reading list with reading mode, and feeds. Tell us what breaks: Settings → Send feedback.
```

## App content (Policy → App content)

- **Privacy policy:** https://koona.app/pin/privacy. Before the closed test it needs a section for the phone apps (the plan's "The site"): the phone keeps the library in the app's own folder, Android backup and device transfer are off, and what a phone sends is what the desktop sends.
- **Ads:** No, the app contains no ads.
- **App access:** "All or some functionality is restricted". Instructions for the reviewer: "Everything in the app works without signing in: saving links, the Inbox, search, collections, the Reading list, reading mode and feeds. Supporter is sold in the app through Google Play Billing: a subscription (monthly or yearly) or a one-time purchase. To reach the purchase sheet: tap the gear at the top right of the library (You & sync), then the Supporter card. After paying, the app asks for an email and a one-time code sent to it; that email becomes the Supporter account. Signing in on its own (I'm already a Supporter) is only for sync and for someone who already has Supporter." If Play asks for a login anyway, the owner decides whether to make a review account (a fixed code needs a change on the server).
- **Content rating:** the IARC questionnaire, below.
- **Target audience:** 18 and over. Not designed for children; nothing appeals to them. Younger groups can be added later without the Families policy as long as under 13 stays out.
- **News app:** No (it reads feeds the person chooses; it publishes no news).
- **Data safety:** below.
- **Government apps, financial features, health:** No.

## Content rating (IARC)

Category: **Utility, Productivity, Communication, or Other** (or "All Other App Types", as the questionnaire names it).

| Question | Answer |
| --- | --- |
| Violence, fear, sexuality, nudity, language, controlled substances, crude humour | No |
| Gambling, simulated gambling | No |
| Users interact or exchange content with other users | No (sync goes between one person's own devices) |
| Shares the user's current location with other users | No |
| Allows purchases of digital goods | Yes: Supporter, as subscriptions (monthly, yearly) and a one-time purchase, through Google Play Billing |
| Web browser or search engine | No |
| Unrestricted internet access, if asked | Yes: reading mode and feeds show pages and posts of any site the person chooses |

## Data safety (proposal)

What a phone build sends, from the README's "Privacy and where your data lives" and the phone code at 2.8.0. The answers are the owner's; Play's definitions ("collected", "shared", the exemptions) should be read once more before submitting.

- **Does the app collect or share any of the required user data types?** Yes.
- **Is all user data encrypted in transit?** Yes (HTTPS, and WSS for sync).
- **Can people request deletion?** Yes, by email to the owner (the account is deleted with its plan). Since 2.9.0 the app creates an account when a Google Play purchase is claimed by an email, so Play's account-deletion requirement applies: a way to delete the account in the app and a web page for it. **Not built yet** (a separate task): it must exist before a build with Play Billing reaches production.

| Data type | Collected | Shared | Optional | Purpose | Why |
| --- | --- | --- | --- | --- | --- |
| Personal info → Email address | Yes | No | Yes | Account management; App functionality | The email that claims a Google Play purchase (an account is made for it) and the sign-in of a Supporter with an email code; the reply address a person may add to feedback |
| App activity → Other user-generated content | Yes | No | Yes | App functionality | The text of feedback, only when the person sends it |
| App info and performance → Diagnostics | Yes | No | Yes | App functionality | The report a person may attach to feedback: app and system versions; no links, titles, tags or notes |
| Financial info → Purchase history | Yes | No | Yes | App functionality; Account management | A Google Play purchase: the app sends its purchase token and product to Koona's server, which checks it with Google and keeps the token, the product, the order id, its state and paid period, and the account it belongs to. No card or payment details: Google keeps those |

Not declared, with the reason (check each against Play's help before submitting):

- **Device or other IDs:** a Google Play purchase carries a random id made on the phone for that purchase (the hash of a secret), not a device or advertising id; it only ties the purchase to its claim.
- **The library through sync:** end-to-end encrypted with a key only the person's devices have; the relay passes it between devices online at the same time and keeps nothing.
- **The pages, feeds and pictures of links:** requested from those sites at the person's action (saving a link, following a feed, opening reading mode); they never pass through Koona.
- **Site icons:** the app asks Google's favicon service (`google.com/s2/favicons`) for the icon of a saved link's domain. That sends the domain to Google without a separate action. **Owner's decision:** declare it (Web browsing → "Web browsing history", shared, for App functionality) or stop using the service on phones. The full description names the service: if phones stop using it, take that clause out of the description in the same change.
