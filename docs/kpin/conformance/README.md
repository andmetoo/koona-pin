# Conformance suite of `.kpin`

Files and test vectors that say what a reader of the [`.kpin` list format](../README.md) 1.x must do, for the reader rules of revision **2026-11** (every file here names it in `revision`; see the spec's [Versions](../README.md#versions)). They cover the rules that are easiest to get wrong: a reader that passes them all can still differ from the spec where no case reaches, and the spec is what decides.

Everything here is dedicated to the public domain under [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/), like the spec ([LICENSE.md](../LICENSE.md)): copy it into the tests of any tool, open or closed. Links in this file are to the spec and the schema one folder up; keep that layout, or point them at your copy.

Koona Pin's reader, its one-click link and the schema are tested against this folder on every change of Koona Pin.

## What is here

| File | What it tests | Spec |
| --- | --- | --- |
| [cases.json](cases.json) and [lists/](lists) | What a reader answers for a whole file, and what it reads out of it | [How a reader answers a file](../README.md#how-a-reader-answers-a-file), [Payload](../README.md#payload-of-pin--list) |
| [text.json](text.json) | How titles, descriptions and tags are cleaned and cut | [Text](../README.md#text) |
| [addresses.json](addresses.json) | Which addresses are kept, in which form, and why others are skipped | [Addresses](../README.md#addresses) |
| [same-page.json](same-page.json) | When two links of one file are the same page | [Repeats](../README.md#repeats) |
| [one-click.json](one-click.json) | Which `koonapin://import` links are accepted | [The one-click link](../README.md#the-one-click-link) |

one-click.json is for an app that opens `koonapin:` links; a library that only reads files can leave it out.

Every file of `lists/` has a case. Text in the JSON files is written with `\u` escapes wherever a character would be invisible or would join the one before it (controls, format characters, combining marks, variation selectors, unusual spaces), so a diff shows it. A U+200D inside an emoji in the spec's prose is the one exception.

## `cases.json`

`spec` is the version of the format the cases are of (`1.0`), and `revision` the revision of the reader rules. `cases` is an array. Each case names a file of `lists/` in `file`, or makes one with `generate` (and then has a `name`):

| Field | Meaning |
| --- | --- |
| `schema_valid` | Whether [schema-1.json](../schema-1.json) accepts the file. A file that is not JSON is not valid. A byte order mark at the start is ignored, as the spec says. |
| `reader` | The one answer a reader gives: `ready`, `not_a_list`, `needs_newer_app`, `other_app`, `too_big` or `empty`. |
| `app` | For `other_app`: the app the reader names. |
| `list` | For `ready`: what the reader reads out of the file. Every key given must match; a key left out is not tested. |
| `schema_cannot_see` | Present on a file the schema accepts that a reader still refuses for its content, and says why: what the schema cannot check. Without it, a file the schema accepts is refused only for its app, its kind or its size. |

`list` holds:

- `title`, `version` (`"MAJOR.MINOR"` as the file writes it), `newer` (the file's MINOR is newer than 1.0) and `sections` (how many sections have a name).
- `meta`: `description`, `author` (`{ "name", "url" }`, or `null` when neither is valid), `license`, `language`, `updated`, `homepage`, `id`, `generator`, each cleaned as the spec says, or `null`.
- `counts`: `links` and `feeds` read; `repeated` (links and feeds whose page came earlier in the file, in one count), `not_web`, `invalid`, `skipped_items` (unknown types, or not objects) and `skipped_details` (unknown fields, counted only in a newer MINOR).
- `links`, in the file's order (each entry of `sections` in order, a section without a name included, then the top-level items): `url` as kept, `title`, `description`, `tags` (with the tags of its repeats) and `sections` (the names of the sections it is in, its first one first).
- `feeds`, in the file's order: `url` in its parsed form, `title`, `site` and `section`.

`newer`, `skipped_items` and `skipped_details` are those of a reader of MINOR 0, which knows the fields and item types of 1.0 and no others. A reader of a later MINOR knows more, and its counts differ for a file of that MINOR.

A reader that is a library rather than an app may keep these under other names; the suite needs only the values.

### Generated files

Some cases have no file of their own: those at the limits (2 MB, 5,000 items, 200 entries of `sections`, and one past each), where a file of 2 MB would weigh on every copy of the suite, and small variations of one file, where a file made from another says exactly what changed. Such a case has `generate` instead of `file`, and says how to make its file from a file of `lists/` named in `from`:

- `pad_to_bytes`: append spaces to the end of the file until it is that many bytes long. The JSON stays the same; only the size changes. Used alone.
- Otherwise the file is parsed, changed in this order, and written out as JSON:
  1. `remove`: the top-level keys listed are taken out.
  2. `set`: each top-level key given is set to the value given, `null` included.
  3. `add_links`: that many links are appended to its top-level `items` (made if missing), the `i`-th (from 0) being `{ "type": "link", "url": "https://example.com/added/<i>" }`.
  4. `add_sections`: that many sections are appended to its `sections` (made if missing), the `i`-th being `{ "name": "Added <i>", "items": [{ "type": "link", "url": "https://example.com/section/<i>" }] }`.

## The vectors

Each of the other files holds a `vectors` array; `why`, where present, says what a vector is about.

- **text.json**: `rule` is `line` (a title, a section name, `author.name`, `license`, `generator`), `description` or `tag`; `max` is the field's limit in characters (Unicode scalar values); `out` is the cleaned text, or `null` for none.
- **addresses.json**: `rule` is `link` (a link's `url`), `feed` (a feed's `url`) or `web` (`homepage`, `author.url`, a feed's `site`). `out` is the address as kept; `skip` is why a link or feed is skipped and counted (`invalid`, `not_web`); for `web`, `out: null` means the field is dropped. Feeds are judged by the address alone here: what a name resolves to is checked when a feed is fetched.
- **same-page.json**: `same` says whether `b` is a repeat of `a`. How a reader writes its key is its own business; only equality is tested.
- **one-click.json**: `url` is the list's address a reader offers to download, or `null` when it ignores the link.

`pad` (in addresses.json and one-click.json) grows the input before it is read: append the text `with` until the input is at least `to_bytes` bytes long in UTF-8. Such a vector gives `ok` instead of the full result: in addresses.json, `true` when the address is kept (or `skip` when it is skipped); in one-click.json, `true` when the link is accepted and `false` when it is ignored.

## Adding to the suite

A new rule of the spec comes with its vectors here, and a new file of `lists/` with its case. A change of what a reader must answer is a change of the spec or of its reader rules, and goes in its [changelog](../README.md#changelog) under its revision.
