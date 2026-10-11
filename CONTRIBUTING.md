# Contributing to Koona Pin

Thanks for wanting to help. Bug reports, ideas and questions go to [issues](https://github.com/andmetoo/koona-pin/issues/new/choose); security problems — privately, as [SECURITY.md](SECURITY.md) says.

## Before a pull request

- **Sign the [CLA](CLA.md) once.** On your first pull request the CLA check posts a comment; reply with the sentence it quotes and the check turns green. A pull request without a signed CLA is not merged. You keep your copyright; the CLA lets Koona Pin ship your contribution under the GPL and, for commercial code, under the commercial license ([LICENSING.md](LICENSING.md)).
- **Talk first about anything bigger than a fix.** Open an issue and describe the problem, so that work does not go to waste.
- **Your own work only.** Submit only what you have the right to give under the CLA, including any permission needed from your employer. Name third-party material in the pull request with its source and license, and keep its notices.
- **Read the brand policy.** [TRADEMARKS.md](TRADEMARKS.md) permits development forks for contributions and explains when a distributed product needs its own branding. Discuss new logos, mascot drawings and other brand artwork before submitting them.

Changes to code in `commercial` folders also follow the development permission in [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md).

Bug descriptions, ideas and questions need no signature. Mark material you do not intend to contribute as **Not a Contribution**.

## How the project works

How the app is put together, how to build and test it and the decisions behind it are in [`docs/`](docs/README.md). Interface strings are in `src/locales/<code>.json` with `en.json` as the source ([docs/translating.md](docs/translating.md)). Before sending a change, run `bun run check`; [docs/testing.md](docs/testing.md) lists the other checks.
