# Conformance suite of `.kpin`

Files and test vectors that say what a reader of the [`.kpin` list format](../README.md) 1.x must do. A reader that answers all of them reads lists the way Koona Pin does. Koona Pin's own reader is tested against this folder on every change (`src-tauri/src/lists/format.rs`, `src-tauri/src/open_requests.rs`), and so is the schema (`src/services/kpinSchema.test.ts`).

Everything here is dedicated to the public domain under [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/), like the spec: copy it into the tests of any tool, open or closed.

## What is here

| File | What it tests | Spec |
| --- | --- | --- |
| [cases.json](cases.json) and [lists/](lists) | What a reader answers for a whole file, and what it reads out of it | [How a reader answers a file](../README.md#how-a-reader-answers-a-file), [Payload](../README.md#payload-of-pin--list) |
| [text.json](text.json) | How titles, descriptions and tags are cleaned and cut | [Text](../README.md#text) |
| [addresses.json](addresses.json) | Which addresses are kept, in which form, and why others are skipped | [Addresses](../README.md#addresses) |
| [same-page.json](same-page.json) | When two links of one file are the same page | [Repeats](../README.md#repeats) |
| [one-click.json](one-click.json) | Which `koonapin://import` links are accepted | [The one-click link](../README.md#the-one-click-link) |

Every file of `lists/` has a case. Text in the JSON files is written with `\u` escapes wherever a character would be invisible, so a diff shows it.

## `cases.json`

`cases` is an array. Each case names a file of `lists/` in `file`, or makes one with `generate` (and then has a `name`):

| Field | Meaning |
| --- | --- |
| `schema_valid` | Whether [schema-1.json](../schema-1.json) accepts the file. A file that is not JSON is not valid. |
| `reader` | The one answer a reader gives: `ready`, `not_a_list`, `needs_newer_app`, `other_app`, `too_big` or `empty`. |
| `app` | For `other_app`: the app the reader names. |
| `list` | For `ready`: what the reader reads out of the file. Every key given must match; a key left out is not tested. |
| `schema_cannot_see` | Present on a file the schema accepts that a reader still refuses for its content, and says why: what the schema cannot check. Without it, a file the schema accepts is refused only for its app, its kind or its size. |

`list` holds:

- `title`, `version` (`"MAJOR.MINOR"` as the file writes it), `newer` (the file's MINOR is newer than 1.0) and `sections` (how many sections have a name).
- `meta`: `description`, `author` (`{ "name", "url" }`, or `null` when neither is valid), `license`, `language`, `updated`, `homepage`, `id`, `generator`, each cleaned as the spec says, or `null`.
- `counts`: `links` and `feeds` read; `repeated` (links and feeds whose page came earlier in the file, in one count), `not_web`, `invalid`, `skipped_items` (unknown types, or not objects) and `skipped_details` (unknown fields, counted only in a newer MINOR).
- `links`, in the file's order (sections first, in order, then the top-level items): `url` as kept, `title`, `description`, `tags` (with the tags of its repeats) and `sections` (the names of the sections it is in, its first one first).
- `feeds`, in the file's order: `url` in its parsed form, `title`, `site` and `section`.

A reader that is a library rather than an app may keep these under other names; the suite needs only the values.

### Generated files

The cases at the limits (2 MB, 5,000 items, 200 sections, and one past each) have no file here: a file of 2 MB would weigh on every copy of the suite, and a file made from another says exactly what it adds. Such a case has `generate` instead of `file`, and says how to make its file from a file of `lists/`, with `from` and one of:

- `pad_to_bytes`: append spaces to the end of the file until it is that many bytes long. The JSON stays the same; only the size changes.
- `add_links`: parse the file and append that many links to its top-level `items` (made if missing), the `i`-th (from 0) being `{ "type": "link", "url": "https://example.com/added/<i>" }`, then write it out as JSON.
- `add_sections`: parse the file and append that many sections to its `sections` (made if missing), the `i`-th being `{ "name": "Added <i>", "items": [{ "type": "link", "url": "https://example.com/section/<i>" }] }`, then write it out as JSON.

## The vectors

Each of the other files holds a `vectors` array; `why`, where present, says what a vector is about.

- **text.json**: `rule` is `line` (a title, a section name, `author.name`, `license`, `generator`), `description` or `tag`; `max` is the field's limit in characters (Unicode scalar values); `out` is the cleaned text, or `null` for none.
- **addresses.json**: `rule` is `link` (a link's `url`), `feed` (a feed's `url`) or `web` (`homepage`, `author.url`, a feed's `site`). `out` is the address as kept; `skip` is why a link or feed is skipped and counted (`invalid`, `not_web`); for `web`, `out: null` means the field is dropped. Feeds are judged by the address alone here: what a name resolves to is checked when a feed is fetched.
- **same-page.json**: `same` says whether `b` is a repeat of `a`. How a reader writes its key is its own business; only equality is tested.
- **one-click.json**: `url` is the list's address a reader offers to download, or `null` when it ignores the link.

`pad` (in addresses.json and one-click.json) grows the input before it is read: append the text `with` until the input is at least `to_bytes` bytes long in UTF-8. Such a vector has `ok` (accepted or kept) or `skip` instead of the full `out`.

## Adding to the suite

A new rule of the spec comes with its vectors here, and a new file of `lists/` with its case. A change that makes Koona Pin answer a vector differently is a change of the spec and goes in its [changelog](../README.md#changelog).
