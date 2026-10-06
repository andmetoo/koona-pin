# Licensing

Koona Pin is open core. Copyright © 2026 Radik Ilin. This file says which license covers which part of this repository.

## Code: GNU AGPL 3.0 only

Unless a file or a folder says otherwise, the source code here — the app (`src`, `src-tauri`), the browser extension (`extension`), the website (`site`), the scripts, tests and documentation — is licensed under the [GNU Affero General Public License, version 3](LICENSE) (`AGPL-3.0-only`).

In short: you may use, study, change and share it, also commercially, as long as everything you build from it and distribute — or let people use over a network — is released under the same license with its complete source code. You may not turn it into a closed product.

## Commercial code

Paid features of Koona Pin are not covered by the AGPL. When their source is published in this repository, it lives in folders named `commercial` and is licensed under the Koona Pin Commercial License in `LICENSE-COMMERCIAL.md` next to it: you may read it and suggest changes, but not use it in your own projects, run it without a paid license, or redistribute it. Paid services (such as sync) are not part of this repository.

## Name, mascot and brand assets: all rights reserved

The AGPL covers code, not the brand. The names "Koona" and "Koona Pin", the mascot Pin Spirit, the logo and wordmark are trademarks of Radik Ilin; see [TRADEMARKS.md](TRADEMARKS.md). The following are not licensed under the AGPL and remain all rights reserved:

- `design/` — brand sources, mascot and design files;
- `doc/concepts/`;
- `src-tauri/icons/`, `extension/src/icons/`, `scripts/platform-probe/mobile-app/src-tauri/icons/`, `app-icon.svg`;
- `site/src/brand/`, `site/src/shots/`, `extension/store/` (images);
- any drawing of the mascot, including one written as code.

A fork must replace them with its own name and artwork.

## Third-party material

Some files are someone else's work under their own terms and are not relicensed here:

- `site/shots/previews/` — photos from Unsplash under the [Unsplash License](https://unsplash.com/license), authors in `CREDITS.md` there;
- `design/lunacy/` — mockups may contain stock photos from Icons8 under the Icons8 license;
- dependencies installed by npm and Cargo — under their own licenses, listed in the app and on <https://koona.app/pin/licenses>.

## Contributions

Contributions are accepted under the [Contributor License Agreement](CLA.md), which keeps Koona Pin able to offer the code under the AGPL and under commercial terms. See [CONTRIBUTING.md](CONTRIBUTING.md).
