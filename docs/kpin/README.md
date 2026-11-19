# The Koona list format (`.kpin`)

Version 1.0 of app `pin`, kind `list`, with the reader rules of revision **2026-11**. Readers and writers: Koona Pin 2.4.0 and later; the reader rules of this revision: Koona Pin 2.27.0 and later, except that 2.27.0 also refuses a few numbers just below the largest double that are in range (see the [changelog](#changelog)).

A `.kpin` file is a shareable list of links and feeds: "Rust blogs worth following", "design systems", "indie web feeds". Someone makes it in Koona Pin (the bundle, opened from **Share as list…** in the ⋯ menu) or by hand, publishes it anywhere, and anyone who opens it sees what it holds and chooses what to import. This document says what such a file contains, how readers must treat it, and how Koona Pin imports it, so that other tools can write and read `.kpin` files too.

- [schema-1.json](schema-1.json): the JSON Schema (2020-12) of version 1.x.
- [examples/](examples): a minimal list, a list with sections and feeds, and a file from a newer 1.x.
- [conformance/](conformance): the conformance suite, files and test vectors that say what a reader must answer and read.
- [js/](https://github.com/koona-project/kpin/tree/main/js): `kpin`, a reference reader in JavaScript that passes the whole suite, and `kpin validate`, a command that checks files.

The words **must**, **must not**, **should** and **may** are used as in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). "Character" means a Unicode scalar value (a code point), as JSON Schema counts `maxLength`.

## Contents

- [What a list is](#what-a-list-is)
- [The file](#the-file)
- [The envelope](#the-envelope)
- [Versions](#versions)
- [How a reader answers a file](#how-a-reader-answers-a-file)
- [Payload of `pin` / `list`](#payload-of-pin--list)
- [Limits](#limits)
- [Text](#text)
- [Addresses](#addresses)
- [Repeats](#repeats)
- [Writing a list](#writing-a-list)
- [How Koona Pin imports a list](#how-koona-pin-imports-a-list)
- [The one-click link](#the-one-click-link)
- [Schema and readers](#schema-and-readers)
- [Conformance](#conformance)
- [Changelog](#changelog)
- [License](#license)

## What a list is

A list is content someone chose to publish, not a copy of a library. It holds titles, descriptions, tags and sections, and nothing about the person who made it: no ids of their bookmarks, no dates of their own activity, no Inbox, Trash or reading state. A full backup of a Koona Pin library is a different file (JSON export, `"format": "koona-pin"`).

The format is shared by Koona apps: one envelope, one set of versioning rules, and a payload per app and kind. Each app has its own file extension so the system knows which app opens it, the way `.docx` and `.xlsx` share one container. Koona Pin uses `.kpin`.

A minimal list:

```json
{
  "format": "koona",
  "app": "pin",
  "kind": "list",
  "version": "1.0",
  "title": "Three pages to read",
  "items": [
    { "type": "link", "url": "https://example.org/first" },
    { "type": "link", "url": "https://example.org/second", "title": "The second page" },
    { "type": "link", "url": "https://example.net/third", "tags": ["reading"] }
  ]
}
```

## The file

| | |
| --- | --- |
| Encoding | UTF-8 JSON ([RFC 8259](https://www.rfc-editor.org/rfc/rfc8259)), one object. Not zipped; images are not embedded. A byte order mark at the start is allowed and ignored. Writers must write UTF-8; see below for what readers do with other bytes. |
| Size | At most 2 MB (2,097,152 bytes). A bigger file is refused, not cut. |
| Extension | `.kpin`, in any case (`.KPIN` opens too). |
| Media type | `application/vnd.koona.list+json` (in the vendor tree, not registered with IANA). |
| macOS | Uniform type identifier `app.koona.pin.list`, conforming to `public.json`. |
| Linux | shared-mime-info type `application/vnd.koona.list+json`, a subclass of `application/json`, glob `*.kpin`. |
| Windows | The `.kpin` extension is associated with Koona Pin by its installer. |

A web server should serve `.kpin` files as `application/vnd.koona.list+json`. Readers must not rely on it: Koona Pin accepts any content type and reads the body as a list.

Writers must not repeat a key within one object; what a reader does with a repeated key is not defined, with one exception. The three refusals below, a surrogate without its pair, a number out of range and nesting too deep, apply to every value written in the file, including one that a repeated key would replace. A reader that keeps only the last value of a key still refuses the file for the first.

JSON lets a string escape a surrogate code point (`"\ud800"`). Writers must not write one without its pair: such a string is not Unicode text, and a reader refuses the whole file as not a list, as it refuses bytes that are not UTF-8. The schema cannot see this.

JSON sets no limit on how large a number is or how deep arrays and objects nest, and RFC 8259 lets a parser set both. This format sets them, so every reader gives a file the same answer. Wherever it stands, even in a field a reader doesn't know or under a key repeated later in its object, each of these makes the file not a list:

- **A number out of range**: one that is infinite once rounded to the nearest IEEE 754 double (binary64), such as `1e400` or `-1e400`. That is a magnitude of 2^1024 − 2^970 (about 1.797693134862315808 × 10^308) or more. A number that rounds to the largest double, 1.7976931348623157 × 10^308, is in range, and so is one too small to be anything but zero (`1e-400`).
- **Nesting deeper than 127 levels**: the file's own object is the first level, and each array or object inside another is one more. 127 levels are read; a 128th is refused.

Writers must stay within both. The schema cannot see either.

A reader should refuse bytes that are not UTF-8 as not a list. Koona Pin 2.4.0 does so for a downloaded list and for a file the system opens with it. A file dropped on the window or picked in **Import…** is decoded by the web view instead, which replaces each invalid byte sequence with U+FFFD and reads the rest as a list.

## The envelope

Every Koona list file has the same five fields, in any order (the order of keys in a JSON object means nothing, and readers must not depend on it):

| Field | Type | Meaning |
| --- | --- | --- |
| `format` | string | Always `"koona"`. A permanent identifier. Anything else is not a list. |
| `app` | string | The app the payload is for: `"pin"` for Koona Pin. Lowercase ASCII letters, digits and `-`, starting with a letter, at most 32 characters. |
| `kind` | string | What the file holds. App `pin` defines `"list"`. Same characters as `app`. |
| `version` | string | `"MAJOR.MINOR"` of this `app` and `kind`; see [Versions](#versions). |
| `generator` | string, optional | What wrote the file, such as `"Koona Pin 2.4.0"`, at most 80 characters. For diagnostics only: a reader must not change its behaviour because of it. |

`format`, `app`, `kind` and `version` are required. A file may also carry `$schema`, a string for editors, which readers ignore.

## Versions

Each `app` and `kind` has one version, `MAJOR.MINOR`.

- **MINOR** (`1.0` → `1.1`) only adds: optional fields and new item types. A file of a newer MINOR still means the same thing to an older reader once the additions are skipped.
- **MAJOR** (`1.x` → `2.0`) is a change that older readers would get wrong: a field renamed, removed or made required, a meaning changed. Writers bump it only when nothing else works.
- `version` is text: `"1.10"` is the tenth MINOR, newer than `"1.9"`, and not the same as `"1.1"`. MAJOR and MINOR are decimal numbers without a sign or leading zeros (`0` alone is fine); there is no third part. Version 1 has MINORs `0` to `9999`. There is no MAJOR 0.
- Every reader knows the highest MINOR of each MAJOR it reads. The [changelog](#changelog) says what each MINOR added.

What a reader of version 1.N must do:

| The file has | The reader |
| --- | --- |
| MAJOR 1, MINOR ≤ N | Reads it. Fields it does not know are ignored without a word; they cannot come from a version it knows, so they are noise. |
| MAJOR 1, MINOR > N | Reads it, skipping what it does not know: unknown fields are not kept anywhere, and the reader says so before importing ("Made in a newer Koona Pin (list 1.1): 3 details and 1 item this version doesn't know were skipped"). |
| A higher MAJOR | Refuses it: "Update Koona Pin to open this list". Nothing else in the file is read. |
| Another `app` | Refuses it and names the app: "This list is for another Koona app". Its `kind` and `version` are that app's business and are not looked at. |
| App `pin` with an unknown `kind` | Refuses it, as for a higher MAJOR: a newer Koona Pin may know the kind. |
| An item with an unknown `type` | Skips the item and counts it, whatever the MINOR. |
| An item that is not an object | Skips it and counts it as an unknown item. |

"Unknown fields" are counted in the envelope, in `author`, in each section, in each link and in each feed. The fields of an unknown item type are not counted: the item is counted once.

Koona Pin 2.4.0 knows MINOR 0 of version 1: it opens every 1.x file, skipping what later MINORs added, and writes 1.0.

**Reader rules.** A version says what a file may hold. How a reader cleans what it reads (which characters it drops from text, which addresses it refuses) may grow stricter within a version, when a way to hide text or mislead is found. Such a change is a **revision** of the reader rules, named by its month (`2026-11`): it never gives a file a new meaning, and it may make a reader drop a character, a field or an item it kept before, or, rarely, refuse a file it opened (the [changelog](#changelog) lists every such file). Each revision is listed in the changelog with what changed, and the [conformance suite](#conformance) is of one revision, which its files name.

## How a reader answers a file

The checks go in this order, so every file gets exactly one answer:

1. More than 2 MB: **too big**.
2. Not UTF-8 (see [The file](#the-file)), not JSON, or not a JSON object: **not a list**. A string anywhere in the file that holds an escaped surrogate without its pair (`"\ud800"`) is not Unicode text, as bytes that are not UTF-8 are not, and the file is not a list. So is a file with a number out of a double's range or with arrays and objects nested more than 127 levels deep (see [The file](#the-file)).
3. `format` is not `"koona"`: **not a list**.
4. `app` is missing or not a valid name: **not a list**. `app` is not `"pin"`: **for another app**.
5. `kind` is missing or not a valid name: **not a list**. `kind` is not `"list"`: **needs a newer app**.
6. `version` is missing, not a string or not `MAJOR.MINOR` as above: **not a list**. A MAJOR higher than the reader's: **needs a newer app**.
7. `title` is missing, not a string, or empty once cleaned (see [Text](#text)): **not a list**.
8. `sections` is present and is neither an array of objects nor `null`: **not a list**.
9. More than 200 entries in `sections`, with a name or without one: **too big**.
10. An `items`, at the top level or in a section, is present and is neither an array nor `null`: **not a list**.
11. More than 5,000 items in all (the top level and every section together, items of every type): **too big**.
12. No items at all: **empty**.

Only then are the items read. A bad item never refuses the file: it is skipped and counted (see [Addresses](#addresses)). A bad optional field is dropped, as if it were missing. (A string that is no Unicode text is caught at step 2, wherever it stands, since the file is not text.)

A MAJOR is a plain number of any length: `12345678901.0` needs a newer app, it is not "not a list".

A file that passes these checks but in which nothing can be imported (every item skipped, or everything already in the library) is not an error: Koona Pin shows the counts and a **Close** button.

## Payload of `pin` / `list`

```json
{
  "format": "koona",
  "app": "pin",
  "kind": "list",
  "version": "1.0",
  "generator": "Koona Pin 2.4.0",

  "id": "small-web-starter",
  "title": "Small web starter",
  "description": "Personal sites and their feeds.\nChecked by hand in October 2026.",
  "author": { "name": "A. Curator", "url": "https://curator.example/" },
  "license": "CC0-1.0",
  "language": "en",
  "updated": "2026-10-18",
  "homepage": "https://curator.example/lists/small-web-starter",

  "sections": [
    {
      "name": "Essays",
      "items": [
        { "type": "link", "url": "https://essays.example/on-gardens", "title": "On digital gardens", "tags": ["writing", "web"] },
        { "type": "feed", "url": "https://essays.example/feed.xml", "site": "https://essays.example/", "title": "Essays" }
      ]
    }
  ],
  "items": [
    { "type": "link", "url": "https://directory.example/", "title": "A directory of personal sites" }
  ]
}
```

The whole file is [examples/sections-and-feeds.kpin](examples/sections-and-feeds.kpin).

### Metadata

| Field | Type | Rule | When it is not valid, a reader |
| --- | --- | --- | --- |
| `title` | string, **required** | One line, at most 120 characters. | refuses the file when it is missing or empty; cuts a longer one. |
| `description` | string | Plain text, line breaks kept, at most 2,000 characters. | drops it if it is not a string; cuts a longer one. |
| `author` | object | `name`: one line, at most 120 characters. `url`: a [web address](#addresses). | drops what is not valid. |
| `license` | string | An [SPDX identifier](https://spdx.org/licenses/), at most 64 characters: `CC0-1.0`, `CC-BY-4.0`. It covers the list itself (its selection, titles and descriptions), not the pages it links to. | shows any text as given, cut to 64 characters; it does not check the identifier. |
| `language` | string | A [BCP 47](https://www.rfc-editor.org/info/bcp47) tag of the list's text: 2–3 letters, then any `-` parts of 2–8 letters or digits. A tag with a one-character part (`en-x-foo`, `de-u-co-phonebk`), valid BCP 47, is not in this form. | drops it. |
| `updated` | string | The date the list was last checked or changed, written exactly `YYYY-MM-DD` (four digits, two, two: `2026-1-5` is not), a real date. | drops it. |
| `homepage` | string | Where the list is published: a [web address](#addresses). | drops it. |
| `id` | string | A slug that marks the same list across its updates: lowercase ASCII letters, digits and `-`, starting with a letter or a digit, at most 64 characters, such as `rust-blogs`. | drops it. |

Koona Pin 2.4.0 shows the metadata in the import preview and uses `title` to name the collection and the source of imported links. It reads `id` but does not use it yet; it is there for list updates later.

### Sections

`sections` is an array of at most 200 objects:

| Field | Type | Rule |
| --- | --- | --- |
| `name` | string | One line, at most 120 characters. |
| `items` | array | The section's items. |

Sections are one level deep. The top-level `items` holds the items that are in no section; a list may have only sections, only top-level items, or both, and must hold at least one item.

A section whose `name` is missing, not a string or empty once cleaned is no section: its items are read where it stands in `sections`, in their order, but with no section, and it is not counted as a section. It still counts as an entry of `sections` for the limit of 200. A missing or `null` `items` is an empty section. Writers should give every section a unique name.

What a section means is up to the reader. Koona Pin can turn a link's sections into tags on import (the default) or ignore them; a feed's section is only shown in the preview.

### Items

Every item is an object with a `type`.

**`"link"`**: a page to save.

| Field | Type | Rule |
| --- | --- | --- |
| `type` | `"link"` | **Required.** |
| `url` | string | **Required.** A [link address](#addresses). |
| `title` | string | One line, at most 500 characters. |
| `description` | string | Plain text, line breaks kept, at most 2,000 characters. |
| `tags` | array of strings | At most 20, each one line of at most 64 characters, no repeats. |

A reader lowercases tags (Unicode lowercase), cleans and cuts them as [text](#text), drops entries that are not strings or are empty once cleaned, drops repeats and keeps at most the first 20. A `tags` that is not an array is ignored.

**`"feed"`**: an RSS, Atom or JSON feed to follow.

| Field | Type | Rule |
| --- | --- | --- |
| `type` | `"feed"` | **Required.** |
| `url` | string | **Required.** The address of the feed itself, a [feed address](#addresses). |
| `site` | string | The site's home page: a [web address](#addresses). |
| `title` | string | One line, at most 500 characters. |

Feeds have no tags or description. A link or a feed without a usable `url` is skipped and counted as invalid. A `title`, `description` or `site` that is not valid is dropped and the item is kept.

**Any other `type`**, or an item with no `type`, is an item from a newer 1.x: see [Versions](#versions).

## Limits

| What | Limit | Beyond it, a reader |
| --- | --- | --- |
| File | 2 MB (2,097,152 bytes) | refuses the file |
| Items, all sections and the top level together | 5,000 | refuses the file |
| Entries of `sections`, with a name or without | 200 | refuses the file |
| Tags per link | 20 | keeps the first 20 |
| `title` of the list, section `name`, `author.name` | 120 characters | cuts |
| Item `title` | 500 characters | cuts |
| `description` of the list or a link | 2,000 characters | cuts |
| Tag | 64 characters | cuts |
| `license`, `id` | 64 characters | cuts the license; drops the id |
| `generator` | 80 characters | cuts |
| Any address | 2,048 bytes | skips the item, or drops the field |

A list over a limit of the first three rows is refused rather than cut, because a cut list would be silently incomplete. Writers must stay within every limit. The [schema](#schema-and-readers) checks all of them except three: the size of the file, the total of items, and the length of addresses in bytes (its `maxLength` counts characters, so a non-ASCII address can pass it and still be too long). An address longer than 2,048 bytes is invalid whatever its scheme: an over-long `ftp:` address is invalid, not "not web".

## Text

Every text field is plain text: no HTML or Markdown is interpreted, and readers must show it as text.

Words used here: a **control character** is one of Unicode General_Category Cc (U+0000–U+001F, U+007F–U+009F); **white space** is Unicode White_Space (line breaks, tabs, U+0085, U+00A0, U+3000 and the rest; not U+001C–U+001F, which are controls only); **trimmed** means white space taken off an end. Script and Extended_Pictographic are the Unicode properties of version 16.0 or later.

A reader cleans text in this order:

1. **Flags.** The three subdivision flags (below) are found as written, each a run of characters with nothing between them, and kept whole.
2. **Invisible characters** (below) are dropped, except zero width joiners and non-joiners.
3. **Joiners.** Each zero width joiner and non-joiner is judged by the character before it and the one after it, once the characters of step 2 and the control characters that are not white space are gone, and stays or goes (below). A white space control, a tab or a line break, stays a neighbour: a joiner beside it joins nothing and goes. Two in a row are judged together, so both go.
4. **One-line fields** (titles, names, tags, `author.name`, `license`, `generator`): every white space character becomes a space, control characters go, runs of spaces become one, and the text is trimmed. **Descriptions** keep their line breaks: `\r\n` becomes `\n`, every other control character goes (`\r` and tab included), and the text is trimmed.
5. **The cut** to the field's limit, in characters. A cut that ends inside a flag, or right after a joiner or non-joiner, drops what it leaves without its end, and white space the cut leaves at the end is trimmed too.

Empty is none.

**Invisible characters** are dropped because they can make a title hide what it says, pass for another, or carry text a person never sees: U+00AD (soft hyphen), U+061C, U+180E, U+200B–U+200F, U+202A–U+202E, U+2060–U+2064, U+2066–U+206F, U+FEFF, U+FFF9–U+FFFB, U+E0001 and U+E0020–U+E007F (tag characters). This is a fixed list, the format characters (Unicode Cf) that show nothing where they are most often used to mislead; those that show a sign of their own, such as U+0600 ARABIC NUMBER SIGN, stay. Others that draw nothing are **not** dropped: variation selectors (U+FE00–U+FE0F, U+E0100–U+E01EF), U+034F COMBINING GRAPHEME JOINER, the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), and Cf characters outside the list, such as U+1D173–U+1D17A and U+1BCA0–U+1BCA3. A reader does no Unicode normalization either: a composed and a decomposed `café` are two texts that look the same. A later revision of the reader rules may add to the list.

One use of tag characters stays, because it is seen: the three **subdivision flags** Unicode recommends for general interchange, England, Scotland and Wales. Each is U+1F3F4 WAVING BLACK FLAG, then the tag characters of `gbeng`, `gbsct` or `gbwls`, then U+E007F CANCEL TAG, and a reader keeps it as it is. Any other tag character goes, and so do the tags of any other sequence, even one in the same form (such as `usca`), and of a flag with anything between its parts: the black flag itself stays. Accepting a form rather than these three would let one black flag after another carry hidden text a few characters at a time.

A **zero width joiner** (U+200D) or **non-joiner** (U+200C) stays where it changes what is drawn:

- inside a word of a script where it shapes the letters: the character before it and the one after it have the same Script (the Script property, not Script_Extensions), and that script is Arabic, Syriac, Nko, Mongolian, Mandaic, Manichaean, Adlam, Hanifi_Rohingya, Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam or Sinhala. A Persian word keeps its non-joiner and a Sinhala conjunct its joiner. A combining vowel mark is Script=Inherited and the tatweel U+0640 is Common, so a non-joiner after either goes, and so does a joiner at the end of a word.
- a joiner between two emoji, as in 👩‍💻 or 🏳️‍🌈: the character before it is Extended_Pictographic, U+FE0F or a skin tone (U+1F3FB–U+1F3FF), and the one after it is Extended_Pictographic. A non-joiner between two emoji goes.

Anywhere else it goes: in Latin, Cyrillic, Greek and the other scripts it draws nothing and only lets one word pass for another (`pay`, U+200C, `pal` reads as `paypal`).

Mongolian is one of the scripts, but two of its own characters do not survive: U+180E MONGOLIAN VOWEL SEPARATOR, a format character since Unicode 6.3, is dropped with the invisible ones, and U+202F NARROW NO-BREAK SPACE is white space and becomes a plain space. A word written with U+180E reads with its final vowel joined to the letter before it, and one with U+202F gets an ordinary space where the narrow one stood.

The schema names the invisible characters and the white space of the Basic Multilingual Plane, but not the tag characters, which lie outside it, where patterns differ between validators. A title made only of tag characters passes the schema, and a reader finds it empty; see [Schema and readers](#schema-and-readers).

A list's `title` that is empty after this makes the file not a list. An empty item title, description or tag is none.

## Addresses

All addresses are absolute URLs as the [WHATWG URL Standard](https://url.spec.whatwg.org/) parses them, with surrounding white space trimmed and at most 2,048 bytes long in UTF-8, as the file writes them. A WHATWG parser reads a host given as one number or in hexadecimal as an IPv4 address (`http://2130706433/` is `127.0.0.1`), and a reader judges it as such.

**A user name or password** (`https://user:secret@host/`) is removed from every address a reader takes from a list, and a writer must not write one. No credentials enter a library from a list.

**Link addresses** (`url` of a link):

- must be `http` or `https` with a host. Another scheme (`javascript:`, `file:`, `data:`, `ftp:`) skips the link as "not web"; an address that does not parse, has no host or is too long skips it as invalid.
- may point anywhere, this computer and the local network included (`http://localhost:3000/`, `http://192.168.1.10/`): a saved link is only opened when the person opens it.
- are kept exactly as written, so `HTTPS://Example.com/A` stays as it is. Only an address that had credentials removed, or that contains white space or control characters, is replaced by its parsed form (a space becomes `%20`), so a saved address never holds a line break.

**Feed addresses** (`url` of a feed):

- follow the link rule, and are kept in their parsed form (`https://example.com` becomes `https://example.com/`).
- must not point to this computer or the local network. Such a feed is skipped as invalid. Koona Pin also refuses, when it fetches the feed, a name that resolves only to such addresses. Refused are:
  - the names `localhost` and those ending in `.localhost` or `.local`, in any case, with or without a final dot;
  - IPv4 `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.168.0.0/16`, `198.18.0.0/15` and `224.0.0.0` and above (multicast, reserved, broadcast);
  - IPv6 `::` and `::1`, `fc00::/7`, `fe80::/10`, `fec0::/10`, `ff00::/8` and `::a.b.c.d`; and an IPv4 address carried in IPv6 (`::ffff:a.b.c.d`, or `64:ff9b::/96`) is judged as that IPv4 address.

  The documentation ranges (`192.0.2.0/24`, `2001:db8::/32`) are not refused.

**Web addresses** (`homepage`, `author.url`, a feed's `site`) follow the link rule; one that does not is dropped without a count.

## Repeats

The same page twice in one file is imported once:

- **Links** are the same when their address keys are equal. The key sets aside what does not change the page: `http` or `https`, one leading `www.` (not `www2.`, and only once), the case of the host, the default port of the address's own scheme (`:80` for `http`, `:443` for `https`; `http://h:443/` keeps its port), every trailing slash of the path, the `#fragment`, tracking parameters (`utm_` followed by anything, `fbclid`, `gclid`, `dclid`, `gbraid`, `wbraid`, `msclkid`, `yclid`, `mc_eid`, `mc_cid`, `igshid`, their names in any case) and the order of the other query parameters. The query is compared as `application/x-www-form-urlencoded` pairs, decoded and ordered by name, then value: `?a` and `?a=` are the same, so are `?q=a+b` and `?q=a%20b`, and an empty query is none. The path keeps its case.
- **Feeds** are the same when their parsed addresses are equal.

The first occurrence wins: its address, title and description are kept. A later link's tags are added to the first one's, up to 20, and its section is added to the first one's sections, so a link listed under two sections can get both as tags. Every repeat after the first is counted as repeated.

## Writing a list

A writer must produce a file that [schema-1.json](schema-1.json) accepts and that keeps the three limits the schema cannot check: at most 2 MB, at most 5,000 items in all, and addresses of at most 2,048 bytes in UTF-8. It also:

- must give the list's title, and every section name, item title and tag it writes, a visible character once cleaned as [Text](#text) says (a title made only of tag characters passes the schema, and a reader refuses the file);
- must not write a string with an escaped surrogate without its pair, a number out of a double's range, or arrays and objects nested more than 127 levels deep (see [The file](#the-file));
- must write `"version": "1.0"` unless it uses something a later MINOR added, and then the lowest MINOR that has it;
- must not write credentials in addresses, or anything private the person did not choose to publish;
- should write `generator` with its name and version;
- should not write the same address twice, or two sections with the same name;
- should leave out optional fields it has nothing for, rather than write empty strings or `null`.

What Koona Pin's bundle writes. The bundle collects what the person adds (bookmarks, collections, tags and feeds, by a drag or from the panel) for as long as the app is open; it is never stored. Saving it writes:

- `format`, `app`, `kind`, `"version": "1.0"`, `generator` (`"Koona Pin <version>"`), `title`, `id` (a slug of the title, also the file's name), `license` (always `CC0-1.0`), `language` (the interface's) and `updated` (the day it is saved); `description` and `author` (a name) when they are filled in. It does not write `homepage`.
- Always a top-level `items` array (it may be empty) and `sections` only when there are any.
- Bookmarks added one by one, by a selection or by a view such as All bookmarks or a search, as top-level `items`. A collection or a tag added as a whole becomes a section named after it, holding its links as they were when it was added; a collection renamed since keeps its new name. Feeds go to one section of their own, last, named "Feeds" in the interface's language.
- Each address once, in the first section it was added to (by its key); nothing deleted or in Trash, and no feed no longer followed. A link's title, description and tags as the library has them when the file is saved; its private note only when the person adds it for that link, in place of its description.
- Every address through the reader's rules, so the file reads back to the same addresses. It writes pretty-printed JSON with a final newline, and checks the text as a reader would before saving it.

## How Koona Pin imports a list

A list reaches Koona Pin in one of four ways, and every one opens the same dialog:

- **Import a file…** in the ⋯ menu, which opens an Import window: a file dropped on it or chosen with a click; **Import…** in the bookmarks and feeds import dialogs takes `.kpin` the same way;
- dropping a `.kpin` file on the list area of the window, or on the New window. A file from the Import window or a drop is told apart by what it holds, not by its name: a list, a full copy, OPML or a bookmarks file each open their own dialog;
- opening a `.kpin` file with the app (double-click, Open With, or a path or `file://` address given to the program). Only an existing regular file whose name ends in `.kpin` is taken; a symbolic link is followed only to a file whose name also ends in `.kpin`;
- a [one-click link](#the-one-click-link) from a web page.

**Nothing is written before the person confirms.** The dialog first shows a preview, computed without touching the library:

- the list's title, author, update date and where it came from (a file name or a host), and its description;
- the counts: links, feeds and sections, and how many links are new, already saved or in Trash;
- for a newer MINOR, how many details and items were skipped;
- every item, grouped by section with the tag each section becomes; a link already saved or in Trash says so, and a feed already followed says "Following";
- the choices: where the links go (a new collection named after the list, reused if a collection with that name exists, compared without case; an existing one; no collection; or no collection and no section tags), whether new links stay in Inbox, which new links to import and which new feeds to follow (one by one, or a section at a time with "Import all"; "Follow all" over feeds alone). A link left unchecked is not added, and a collection is made only if a link lands in it.

Only **Accept** writes, in one transaction: an error leaves the library as it was. Then:

- A link is already saved when the library has a bookmark with exactly the same address. It is left as it is: its tags and its collection are not changed by the import (the cleaning of tag names below may rename a tag it has). A link in Trash stays there and is only counted.
- Koona Pin names tags the way a list reads them: lowercase, and cleaned as [Text](#text) says, though a library's tag is not cut to 64 characters. This holds for new tags and for the ones the library already has, so a tag of the list and a library tag that differ only by what a reader drops (a tag saved before readers dropped the soft hyphen, say) are one tag. A stored tag like that gets the clean name, or merges into the tag that already has it; a tag whose name has nothing visible left, such as one made only of U+200B, is removed from the library, and a list's tag like that is dropped. The library is cleaned this way whenever it opens, after a sync batch and after a restore, and again at the start of an import whose list has tags.
- A variant of a saved address (another spelling with the same key) is saved as a new bookmark and shows up among duplicates, as after any import.
- New links are marked as coming from the list and named after its title.
- Feeds the person kept checked are followed; feeds already followed are not touched. Feeds are fetched later, on the usual schedule, never during import.
- The report says what was added, what was already there or in Trash, what repeated, what was skipped, and which feeds are followed.

While a list dialog is open, a new list that arrives is refused, not queued, and the app says so.

## The one-click link

A web page can offer a list with a link:

```
koonapin://import?url=https%3A%2F%2Fexample.org%2Flists%2Fsmall-web.kpin
```

The link is accepted only when:

- the scheme is `koonapin` and the host is `import`, in any case, with no user name, password or port; the path is empty or `/`; there is no `#fragment`;
- there is exactly one `url` parameter (others are ignored), and its value, decoded as `application/x-www-form-urlencoded` (a `+` is a space, a `%` escape is decoded), is an `https` address with a host and without a user name or password;
- the whole link, with white space around it trimmed, is at most 4,096 bytes in UTF-8.

Anything else is ignored. The list's address is offered in its parsed form (`https://Example.org` becomes `https://example.org/`).

Pages must percent-encode the `url` value whenever the list's address has a `?`, `&`, `#`, `+` or `%` in it, and should always do so: an unencoded `&` ends the value early, an unencoded `#` makes the rest a fragment of the `koonapin:` link, which is then refused, and an unencoded `+` or `%` escape is decoded into another address (`c++` becomes `c%20%20`). Sites that strip custom schemes, such as rendered Markdown on code hosts, should link to a web page that carries the button instead.

**Safety rules.** A page can fire such a link at any moment, so a link can only ask a question:

- The link opens the dialog with the full address and the question "Download a list from *host*?". **Nothing goes over the network before the person presses Download**, and nothing is saved before **Import**.
- Only one request waits at a time; while a list dialog is open, further links are refused.
- The download uses `https` on every hop, follows at most 5 redirects, and checks each hop before it is requested: an address that is not `https`, that has a user name or password, or that points to this computer or the local network (by name, or by what the name resolves to) is refused.
- No cookies, credentials, proxy or `Referer` are sent. Koona Pin asks for `Accept: application/vnd.koona.list+json, application/json;q=0.9, */*;q=0.5`.
- The body may be gzip-compressed; at most 2 MB is read, counted as it streams and after decompression. The whole download must finish within 15 seconds. The person can cancel it at any point, and nothing is kept.
- A non-2xx answer is an error. The content type is not trusted: the body is read as a list, and anything that is not one gets "not a list".

## Schema and readers

[schema-1.json](schema-1.json) describes what a writer must produce. Readers are more tolerant, so that a list with one bad entry still imports: a file the schema refuses may still be read, with its bad items skipped and counted and its bad optional fields dropped. A file the schema accepts is refused only for what it is (another app, an unknown kind), for its size (more than 2 MB, or more than 5,000 items in all), or for one of four things in it the schema cannot see: a list's title made only of [tag characters](#text), which is empty to a reader; a string with an escaped surrogate without its pair, which is no text; a number out of a double's range; and arrays and objects nested more than 127 levels deep (the last three, see [The file](#the-file)). Its items can still be skipped: one whose address is longer than 2,048 bytes is invalid to the reader, though the schema, which counts characters, accepts it.

The schema allows any field and any item `type` beyond those of 1.0, so that it accepts files of later 1.x versions; it pins `version` to MAJOR 1. Its `$id`, `https://koona.app/pin/schema/list-1.json`, names the schema; a validator must not need to fetch it there. The schema's source is the repository [koona-project/kpin](https://github.com/koona-project/kpin), which holds this specification too.

To check a list, use any JSON Schema 2020-12 validator. ajv-cli needs ajv-formats beside it, since the schema uses the `date` format, and picks the parser by the file's extension, so give it a copy named `.json`. From the folder of this specification:

```bash
cp examples/minimal.kpin /tmp/minimal.json
```

```bash
npx -p ajv-cli@5 -p ajv-formats@3 ajv validate --spec=draft2020 -c ajv-formats -s schema-1.json -d /tmp/minimal.json
```

## Conformance

[conformance/](conformance) holds the files and vectors a reader is tested with, for the reader rules of revision 2026-11: for every file, whether the schema accepts it, the one answer a reader gives and what it reads out of it (titles, addresses, tags, sections and counts); how text is cleaned; which addresses are kept and in which form; when two links are the same page; and which one-click links are accepted. Its [README](conformance/README.md) says how each file is read. It covers the rules that are easiest to get wrong, not every sentence of this document. Koona Pin's reader and the schema are checked against it on every change, and a change of this spec comes with its cases there.

## Changelog

### Reader rules, revision 2026-11 (Koona Pin 2.27.0)

The first revision of the reader rules (see [Versions](#versions)). The version stays 1.0, and a file means what it meant; what a reader drops from it is stricter. Readers now remove a wider set of [invisible characters](#text) from text (the soft hyphen, U+180E, the invisible operators U+2061–U+2064, the deprecated controls U+206A–U+206F, U+FFF9–U+FFFB and the tag characters, except those of the flags of England, Scotland and Wales, which a reader keeps). A zero width joiner between two emoji, and a joiner or non-joiner inside a word of a joining or Brahmic script, now stay, where readers used to drop every one. A MAJOR of any length needs a newer app, an `updated` date must be written exactly `YYYY-MM-DD`, and a one-click link with a user name, password or port is refused.

The schema became stricter with it, under the same `$id`: its text pattern names the same characters within the Basic Multilingual Plane, and the Unicode white space instead of relying on `\s`. A title, section name, item title or tag made only of those characters, valid before, is now refused by the schema.

So some files read differently than in Koona Pin 2.26.0 and earlier:

- A list whose title is made only of the newly removed characters (tag characters, soft hyphens, U+180E and the rest) was imported, under a title that looked empty; it is now not a list. One made only of tag characters is still valid to the schema, the one such file.
- A section named only with them was a section; it is now no section, and its items have none.
- Text that differed only by one of these characters is now the same text: a tag `co`, U+00AD, `op` and the tag `coop` are one tag, and two links whose titles differed that way show the same title.
- Emoji joined by U+200D (👩‍💻, 🏳️‍🌈) keep their joiner and show as one emoji, and Persian, Hindi or Sinhala words keep the joiners and non-joiners they are spelled with.
- An `updated` date such as `2026-1-5` was read as `2026-01-05`; it is now dropped.

Koona Pin also cleans the library's tag names the same way, the stored ones included ([How Koona Pin imports a list](#how-koona-pin-imports-a-list)). The spec now says what readers already did: U+0085 is white space, a cut trims the white space it leaves (in descriptions too), tracking parameters match in any case, the cleaning goes in a set order, how the repeat key reads a query, which addresses a feed may not have, that a section without a name still counts toward the 200, that a string with an escaped surrogate without its pair makes a file not a list, and so do a number out of a double's range and arrays and objects nested more than 127 levels deep, even under a key repeated later (Koona Pin's JSON parser has refused such files from the start). Koona Pin 2.27.0 also refuses a few numbers just below the limit that round to the largest double, such as `1.7976931348623158e308`, which are in range; a later release reads them as this revision says. The [conformance suite](#conformance) is published with the spec.

### 1.0 (October 2026, Koona Pin 2.4.0)

The first version: the envelope (`format`, `app`, `kind`, `version`, `generator`); for app `pin`, kind `list`, the metadata (`title`, `description`, `author`, `license`, `language`, `updated`, `homepage`, `id`), `sections` and top-level `items`, and the item types `link` and `feed`.

## License

This specification, [schema-1.json](schema-1.json), the [examples](examples) and the [conformance suite](conformance) are dedicated to the public domain under [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/): to the extent possible under law, their authors have waived all copyright and related rights in them. Copy, adapt and implement them in any tool, open or closed, without asking or crediting.

This covers every file of this folder (the repository [koona-project/kpin](https://github.com/koona-project/kpin), and its copy in Koona Pin's `docs/kpin/`) and nothing else; [LICENSE.md](LICENSE.md) says so for a copy that travels without this document. Koona Pin's code, including its reader and writer of this format and the tests that run the suite, stays under the [GNU GPL 3.0](https://github.com/andmetoo/koona-pin/blob/main/LICENSE); see [LICENSING.md](https://github.com/andmetoo/koona-pin/blob/main/LICENSING.md). "Koona" and "Koona Pin" are trademarks ([TRADEMARKS.md](https://github.com/andmetoo/koona-pin/blob/main/TRADEMARKS.md)): implementing the format, naming it and saying a tool passes its conformance suite need no permission, but a tool should not present itself as Koona.
