# Contributing to Koona Pin

Thanks for wanting to help. Bug reports, ideas and questions go to [issues](https://github.com/andmetoo/koona-pin/issues/new/choose); security problems — privately, as [SECURITY.md](SECURITY.md) says.

## Before a pull request

- **Sign the [CLA](CLA.md).** The CLA check asks for it on your first pull request; a pull request without it is not merged. You keep your copyright; the CLA lets Koona Pin ship your work both under the AGPL and in its commercial edition ([LICENSING.md](LICENSING.md)).
- **Talk first about anything bigger than a fix.** Open an issue and describe the problem, so that work does not go to waste.
- **Your own work only.** Do not paste code, text or images you have no right to give under the CLA.
- **No brand in forks.** If you build your own version, read [TRADEMARKS.md](TRADEMARKS.md).

## How the project works

Development notes, the roadmap and decisions are in [`doc/`](doc) (in Russian). Interface strings are in `src/locales/<code>.json` with `en.json` as the source. Before sending a change, run `bun run check`; [doc/testing.md](doc/testing.md) lists the other checks.
