# Licensing

Koona Pin is open core. Copyright © 2026 Radik Ilin. This file says which license covers which part of this repository.

## Community code: GNU GPL 3.0 only

Unless an applicable notice says otherwise, the source code here — the app (`src`, `src-tauri`), the browser extension (`extension`), the website (`site`), the scripts, tests and documentation — is licensed under the [GNU General Public License, version 3 only](LICENSE) (`GPL-3.0-only`). Later versions of the GPL are not automatically included.

You may use, study, modify, share and sell the community code. When you distribute a work covered by the GPL, you must comply with its requirements, including licensing the covered work under the GPL, preserving notices and providing the corresponding source as the GPL requires. Independent works merely distributed alongside it do not automatically become GPL-licensed. Running a modified program privately, or letting people use it over a network without conveying a copy, does not by itself require you to publish its source. The license text controls; this is a summary.

The copyright holders may also grant separate commercial permissions for code they own or have sufficient rights to license. A commercial folder name alone does not create those permissions for third-party code or dependencies.

This licensing change applies to revisions carrying these notices. It does not withdraw AGPL rights already granted for earlier revisions or copies. Third-party licenses and rights already granted in individual contributions remain in force.

## Commercial code

The [Koona Pin Commercial License](LICENSE-COMMERCIAL.md) covers code expressly designated as commercial by a file notice or a `LICENSE-COMMERCIAL.md` notice in its directory. Commercial features are kept in directories named `commercial`; each such directory must carry a notice linking to that license. Code is not moved out of the GPL merely because it becomes a paid feature.

Commercial source may be public. You may read it and prepare contributions under the development permission in the commercial license. Production use requires an active Supporter subscription or another express permission; you may not redistribute the commercial product or reuse its code in your own product under that license. Separately granted open-source rights are not restricted by it.

Server-side services behind paid features, such as a sync relay, are not part of this repository.

Supporter is a subscription sold through Paddle. The plan, billing period, price, currency, taxes and renewal terms are shown at checkout and in the purchase confirmation. The commercial license does not fix a worldwide price. Hosted services, if offered, require their own stated service terms; this repository does not grant access to them.

## Name, mascot and brand assets: all rights reserved

The GPL grants rights to the covered code, not permission to present a fork as an official Koona product. The names "Koona" and "Koona Pin", the mascot Pin Spirit, the logo and wordmark are used as trademarks of Radik Ilin; see [TRADEMARKS.md](TRADEMARKS.md). The following project-owned artwork is excluded from the GPL and remains all rights reserved, except for the express permissions in that policy:

- `design/` — brand sources, mascot and design files;
- `src-tauri/icons/`, `extension/src/icons/`, `scripts/platform-probe/mobile-app/src-tauri/icons/`, `app-icon.svg`;
- `site/src/brand/`, `site/src/shots/`, `extension/store/` (images);
- any drawing of the mascot, including one written as code.

A publicly distributed modified product must use its own name and artwork. Local development, contribution forks, truthful references and redistribution of unmodified official community releases have the permissions described in [TRADEMARKS.md](TRADEMARKS.md). Keep legal notices and required attribution even when rebranding.

## Third-party material

Some files are someone else's work under their own terms and are not relicensed here:

- `site/shots/previews/` — photos from Unsplash under the [Unsplash License](https://unsplash.com/license), authors in `CREDITS.md` there;
- dependencies installed by Bun (packages from npm) and Cargo — under their own licenses and accompanying notices. The website's [licenses page](https://koona.app/pin/licenses) credits selected components and assets; it is not a complete dependency inventory. Distributors must preserve the notices and meet the source and other requirements of the components they ship.

## Contributions

Contributions are accepted under the [Contributor License Agreement](CLA.md), signed once with a comment when the CLA check asks for it on the first pull request ([CONTRIBUTING.md](CONTRIBUTING.md)). Authors keep their copyright and grant the owner the right to ship their contributions under the GPL and under the commercial license, with a patent license. Brand artwork is discussed separately before it is submitted.
