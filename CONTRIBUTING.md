# Contributing to Koona Pin

Thanks for wanting to help. Bug reports, ideas and questions go to [issues](https://github.com/andmetoo/koona-pin/issues/new/choose); security problems — privately, as [SECURITY.md](SECURITY.md) says.

## Before a pull request

- **Confirm the contribution terms.** Submit your original code, documentation and translations under the [MIT License for Contributions](LICENSE-CONTRIBUTIONS.md) and complete the confirmation in the pull request template. You keep your copyright. This lets both Koona Pin and other recipients use your original contribution under MIT, including in commercial software. It does not put the whole project under MIT.
- **Talk first about anything bigger than a fix.** Open an issue and describe the problem, so that work does not go to waste.
- **Check your rights.** You must have the right to submit your original work under MIT, including any permission needed from your employer or another rights holder. Identify third-party material, its source and its license separately; do not claim that you can relicense someone else's work. Preserve existing license and copyright notices.
- **Read the brand policy.** [TRADEMARKS.md](TRADEMARKS.md) permits development forks for contributions and explains when a distributed product needs its own branding. Discuss new logos, mascot drawings and other brand artwork separately before submitting them; they are not accepted under the MIT contribution policy.

## Contribution terms

These terms cover original changes intentionally submitted for inclusion in Koona Pin, including patches in pull requests or issues. They cover only rights you hold in your own additions, not the pre-existing code or third-party material surrounding a change. Changes to commercial code also require compliance with the development permission in [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md).

Before merging a contribution, the maintainer checks the contributor's explicit confirmation and any third-party notices. For a patch submitted outside a pull request, include this statement with the patch:

> I submit my original contribution under the MIT License for Contributions in LICENSE-CONTRIBUTIONS.md, version 1.0 dated 10 October 2026. I have the rights and any necessary permissions to do so. I have identified third-party material and preserved its notices.

Keep this confirmation with the contribution record. There is no separate CLA signature requirement for new contributions. The previous [CLA](CLA.md) remains available as a historical record; this policy does not revoke previously granted rights.

Bug descriptions, ideas and questions do not require a license confirmation. If you include a patch or other original material for incorporation into the project, the contribution rules above apply. Mark material that you do not intend to contribute as **Not a Contribution**; it will not be incorporated without separate permission.

## How the project works

How the app is put together, how to build and test it and the decisions behind it are in [`docs/`](docs/README.md). Interface strings are in `src/locales/<code>.json` with `en.json` as the source ([docs/translating.md](docs/translating.md)). Before sending a change, run `bun run check`; [docs/testing.md](docs/testing.md) lists the other checks.
