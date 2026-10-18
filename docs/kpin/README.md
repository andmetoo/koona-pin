# The Koona list format (`.kpin`)

Version 1.0 of app `pin`, kind `list`. Readers and writers: Koona Pin 2.4.0 and later.

A `.kpin` file is a shareable list of links and feeds: "Rust blogs worth following", "design systems", "indie web feeds". Someone makes it in Koona Pin (**Share as list…**) or by hand, publishes it anywhere, and anyone who opens it sees what it holds and chooses what to import. This document says what such a file contains, how readers must treat it, and how Koona Pin imports it, so that other tools can write and read `.kpin` files too.

- [schema-1.json](schema-1.json): the JSON Schema (2020-12) of version 1.x.
- [examples/](examples): a minimal list, a list with sections and feeds, and a file from a newer 1.x.

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

Writers must not repeat a key within one object; what a reader does with a repeated key is not defined.

A reader should refuse bytes that are not UTF-8 as not a list. Koona Pin 2.4.0 does so for a downloaded list and for a file the system opens with it. A file dropped on the window or picked in **Import…** is decoded by the web view instead, which replaces each invalid byte sequence with U+FFFD and reads the rest as a list.

## The envelope

Every Koona list file starts with the same five fields:

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

Koona Pin 2.4.0 reads version 1.0 and writes 1.0.

## How a reader answers a file

The checks go in this order, so every file gets exactly one answer:

1. More than 2 MB: **too big**.
2. Not UTF-8 (see [The file](#the-file)), not JSON, or not a JSON object: **not a list**.
3. `format` is not `"koona"`: **not a list**.
4. `app` is missing or not a valid name: **not a list**. `app` is not `"pin"`: **for another app**.
5. `kind` is missing or not a valid name: **not a list**. `kind` is not `"list"`: **needs a newer app**.
6. `version` is missing, not a string or not `MAJOR.MINOR` as above: **not a list**. A MAJOR higher than the reader's: **needs a newer app**.
7. `title` is missing, not a string, or empty once cleaned (see [Text](#text)): **not a list**.
8. `sections` is present and is neither an array of objects nor `null`: **not a list**.
9. More than 200 sections: **too big**.
10. An `items`, at the top level or in a section, is present and is neither an array nor `null`: **not a list**.
11. More than 5,000 items in all (the top level and every section together, items of every type): **too big**.
12. No items at all: **empty**.

Only then are the items read. A bad item never refuses the file: it is skipped and counted (see [Addresses](#addresses)). A bad optional field is dropped, as if it were missing.

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
| `language` | string | A [BCP 47](https://www.rfc-editor.org/info/bcp47) tag of the list's text: 2–3 letters, then any `-` parts of 2–8 letters or digits. | drops it. |
| `updated` | string | The date the list was last checked or changed, `YYYY-MM-DD`, a real date. | drops it. |
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

A section whose `name` is missing, not a string or empty once cleaned is no section: its items are read as top-level items and it is not counted as a section. A missing or `null` `items` is an empty section. Writers should give every section a unique name.

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
| Sections | 200 | refuses the file |
| Tags per link | 20 | keeps the first 20 |
| `title` of the list, section `name`, `author.name` | 120 characters | cuts |
| Item `title` | 500 characters | cuts |
| `description` of the list or a link | 2,000 characters | cuts |
| Tag | 64 characters | cuts |
| `license`, `id` | 64 characters | cuts the license; drops the id |
| `generator` | 80 characters | cuts |
| Any address | 2,048 bytes | skips the item, or drops the field |

A list over a limit of the first three rows is refused rather than cut, because a cut list would be silently incomplete. Writers must stay within every limit. The [schema](#schema-and-readers) checks all of them except three: the size of the file, the total of items, and the length of addresses in bytes (its `maxLength` counts characters, so a non-ASCII address can pass it and still be too long).

## Text

Every text field is plain text: no HTML or Markdown is interpreted, and readers must show it as text.

**One-line fields** (titles, names, tags, `author.name`, `license`, `generator`): a reader replaces every white space character, line breaks and tabs included, with a space, removes control characters and invisible characters (below), collapses runs of spaces into one, trims both ends and cuts the result to the field's limit. Empty is none.

**Descriptions** keep their line breaks: `\r\n` becomes `\n`; every other control character, `\r` and tab included, and every invisible character is removed; the text is trimmed at both ends and cut to 2,000 characters. Empty is none.

**Invisible characters** are removed because they can make a title hide what it says, or pass for another: U+061C, U+200B–U+200F, U+202A–U+202E, U+2060, U+2066–U+2069 and U+FEFF.

A list's `title` that is empty after this makes the file not a list. An empty item title, description or tag is none.

## Addresses

All addresses are absolute URLs as the [WHATWG URL Standard](https://url.spec.whatwg.org/) parses them, with surrounding white space trimmed and at most 2,048 bytes long in UTF-8, as the file writes them.

**A user name or password** (`https://user:secret@host/`) is removed from every address a reader takes from a list, and a writer must not write one. No credentials enter a library from a list.

**Link addresses** (`url` of a link):

- must be `http` or `https` with a host. Another scheme (`javascript:`, `file:`, `data:`, `ftp:`) skips the link as "not web"; an address that does not parse, has no host or is too long skips it as invalid.
- may point anywhere, this computer and the local network included (`http://localhost:3000/`, `http://192.168.1.10/`): a saved link is only opened when the person opens it.
- are kept exactly as written, so `HTTPS://Example.com/A` stays as it is. Only an address that had credentials removed, or that contains white space or control characters, is replaced by its parsed form (a space becomes `%20`), so a saved address never holds a line break.

**Feed addresses** (`url` of a feed):

- follow the link rule, and are kept in their parsed form (`https://example.com` becomes `https://example.com/`).
- must not point to this computer or the local network: `localhost`, names ending in `.localhost` or `.local`, and IP addresses that are not public (loopback, private, link-local, shared, multicast and the like). Such a feed is skipped as invalid. Koona Pin also refuses, when it fetches the feed, a name that resolves only to such addresses.

**Web addresses** (`homepage`, `author.url`, a feed's `site`) follow the link rule; one that does not is dropped without a count.

## Repeats

The same page twice in one file is imported once:

- **Links** are the same when their address keys are equal. The key sets aside what does not change the page: `http` or `https`, a leading `www.`, the case of the host, a default port, a trailing slash, the `#fragment`, tracking parameters (`utm_*`, `fbclid`, `gclid`, `dclid`, `gbraid`, `wbraid`, `msclkid`, `yclid`, `mc_eid`, `mc_cid`, `igshid`) and the order of the other query parameters. The path keeps its case.
- **Feeds** are the same when their parsed addresses are equal.

The first occurrence wins: its address, title and description are kept. A later link's tags are added to the first one's, up to 20, and its section is added to the first one's sections, so a link listed under two sections can get both as tags. Every repeat after the first is counted as repeated.

## Writing a list

A writer must produce a file that [schema-1.json](schema-1.json) accepts and that keeps the three limits the schema cannot check: at most 2 MB, at most 5,000 items in all, and addresses of at most 2,048 bytes in UTF-8. It also:

- must write `"version": "1.0"` unless it uses something a later MINOR added, and then the lowest MINOR that has it;
- must not write credentials in addresses, or anything private the person did not choose to publish;
- should write `generator` with its name and version;
- should not write the same address twice, or two sections with the same name;
- should leave out optional fields it has nothing for, rather than write empty strings or `null`.

What Koona Pin's builder (**Share as list…**) writes:

- `format`, `app`, `kind`, `"version": "1.0"`, `generator` (`"Koona Pin <version>"`), `title`, and `id`, `description`, `author`, `license` (`CC0-1.0`, `CC-BY-4.0`, or none), `language` and `updated` when they are filled in. It does not write `homepage`.
- Always a top-level `items` array (it may be empty) and `sections` only when there are any.
- Links from collections or a selection, without those in Trash, newest first, each address once (by its key); feeds the person follows. Titles, descriptions and tags only when chosen; a link's private note only when "my notes" is chosen, in place of its description.
- Sections, when chosen, by tag (a link goes under its first tag in alphabetical order) or by collection (in the sidebar's order). Links without one go to the top level. Feeds go to a section of their own, named "Feeds" in the interface's language.
- Every address through the reader's rules, so the file reads back to the same addresses. It writes pretty-printed JSON with a final newline, and checks the text as a reader would before saving it.

## How Koona Pin imports a list

A list reaches Koona Pin in one of four ways, and every one opens the same dialog:

- **Import…** in the import dialog, which takes `.kpin` next to bookmarks and OPML files;
- dropping a `.kpin` file on the window;
- opening a `.kpin` file with the app (double-click, Open With, or a path or `file://` address given to the program). Only an existing regular file whose name ends in `.kpin` is taken; a symbolic link is followed only to a file whose name also ends in `.kpin`;
- a [one-click link](#the-one-click-link) from a web page.

**Nothing is written before the person confirms.** The dialog first shows a preview, computed without touching the library:

- the list's title, author, license, update date and where it came from (a file name or a host);
- the counts: links, feeds and sections; links already saved, links in Trash, feeds already followed; repeated, not web, invalid and skipped items;
- for a newer MINOR, how many details and items were skipped;
- the choices: which collection the links go into (a new one named after the list, reused if a collection with that name exists, compared without case; an existing one; or none), whether new links stay in Inbox, whether sections become tags, whether links already saved get the list's tags, and which new feeds to follow.

Only **Import** writes, in one transaction: an error leaves the library as it was. Then:

- A link is already saved when the library has a bookmark with exactly the same address. It is left as it is, or given the list's tags if the person chose that; its collection never changes. A link in Trash stays there and is only counted.
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

- the scheme is `koonapin` and the host is `import`, in any case; the path is empty or `/`; there is no `#fragment`;
- there is exactly one `url` parameter (others are ignored), and its value, once decoded, is an `https` address with a host and without a user name or password;
- the whole link is at most 4,096 bytes in UTF-8.

Anything else is ignored. Pages should percent-encode the `url` value. Sites that strip custom schemes, such as rendered Markdown on code hosts, should link to a web page that carries the button instead.

**Safety rules.** A page can fire such a link at any moment, so a link can only ask a question:

- The link opens the dialog with the full address and the question "Download a list from *host*?". **Nothing goes over the network before the person presses Download**, and nothing is saved before **Import**.
- Only one request waits at a time; while a list dialog is open, further links are refused.
- The download uses `https` on every hop, follows at most 5 redirects, and checks each hop before it is requested: an address that is not `https`, that has a user name or password, or that points to this computer or the local network (by name, or by what the name resolves to) is refused.
- No cookies, credentials, proxy or `Referer` are sent. Koona Pin asks for `Accept: application/vnd.koona.list+json, application/json;q=0.9, */*;q=0.5`.
- The body may be gzip-compressed; at most 2 MB is read, counted as it streams and after decompression. The whole download must finish within 15 seconds. The person can cancel it at any point, and nothing is kept.
- A non-2xx answer is an error. The content type is not trusted: the body is read as a list, and anything that is not one gets "not a list".

## Schema and readers

[schema-1.json](schema-1.json) describes what a writer must produce. Readers are more tolerant, so that a list with one bad entry still imports: a file the schema refuses may still be read, with its bad items skipped and counted and its bad optional fields dropped. A file the schema accepts is never refused for its content, only for what it is (another app, an unknown kind) or for its size: more than 2 MB, or more than 5,000 items in all. Its items can still be skipped: one whose address is longer than 2,048 bytes is invalid to the reader, though the schema, which counts characters, accepts it.

The schema allows any field and any item `type` beyond those of 1.0, so that it accepts files of later 1.x versions; it pins `version` to MAJOR 1. Its `$id`, `https://koona.app/pin/schema/list-1.json`, names the schema; this repository holds its source.

To check a list, use any JSON Schema 2020-12 validator. ajv-cli needs ajv-formats beside it, since the schema uses the `date` format, and picks the parser by the file's extension, so give it a copy named `.json`:

```bash
cp docs/kpin/examples/minimal.kpin /tmp/minimal.json
```

```bash
npx -p ajv-cli@5 -p ajv-formats@3 ajv validate --spec=draft2020 -c ajv-formats -s docs/kpin/schema-1.json -d /tmp/minimal.json
```

## Changelog

### 1.0 (October 2026, Koona Pin 2.4.0)

The first version: the envelope (`format`, `app`, `kind`, `version`, `generator`); for app `pin`, kind `list`, the metadata (`title`, `description`, `author`, `license`, `language`, `updated`, `homepage`, `id`), `sections` and top-level `items`, and the item types `link` and `feed`.

## License

This specification, [schema-1.json](schema-1.json) and the [examples](examples) are dedicated to the public domain under [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/): to the extent possible under law, their authors have waived all copyright and related rights in them. Copy, adapt and implement them in any tool, open or closed, without asking or crediting.

This covers only the files in `docs/kpin/`. Koona Pin's code, including its reader and writer of this format, stays under the [GNU GPL 3.0](../../LICENSE); see [LICENSING.md](../../LICENSING.md). "Koona" and "Koona Pin" are trademarks ([TRADEMARKS.md](../../TRADEMARKS.md)); implementing the format does not need permission, but a tool should not present itself as Koona.
