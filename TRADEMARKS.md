# Trademarks

"Koona", "Koona Pin", the mascot Pin Spirit, the Koona Pin logo, icon and wordmark (the "Marks") are used as trademarks of Radik Ilin. The community code is licensed under the [GPL](LICENSE); designated commercial code has a [commercial license](LICENSE-COMMERCIAL.md). Neither license gives permission to present another product as an official Koona product.

The project-owned artwork listed in [LICENSING.md](LICENSING.md), including the mascot, logos, icons and screenshots, is also protected separately by copyright. It is not GPL-licensed. The permissions below cover use of that artwork as well as use of the Marks; third-party content keeps its own terms. They do not grant a general license to reuse the artwork in another product.

## You may

- Say truthfully that your project is based on, compatible with or a fork of Koona Pin ("based on Koona Pin", "a fork of Koona Pin").
- Use the name and screenshots of the app in truthful articles, reviews, tutorials and talks about Koona Pin. Do not imply endorsement; respect any separately applicable rights in third-party content shown in a screenshot.
- Build and run the community code locally, including modified development builds, with the bundled artwork.
- Copy and redistribute unmodified official community releases, source archives and builds from unmodified community source with their bundled artwork and legal notices intact. Identify their origin accurately. This is not permission to redistribute the Commercial Software under the commercial license.
- Keep the Marks and bundled artwork in clearly identified development forks and patches made solely to propose contributions to the official project. Follow [CONTRIBUTING.md](CONTRIBUTING.md) and, for commercial code, its separate development permission. This exception does not cover releasing a modified product to end users.
- Link to <https://koona.app/pin/>.

## You may not, without written permission

- Brand a separate product, fork, extension, package, store listing or domain as "Koona", "Koona Pin" or a confusingly similar name. The permitted development forks and truthful descriptions of unmodified official releases above are exceptions.
- Use the mascot, logo, icon or wordmark in another product, store listing, website or advertisement beyond the permissions above.
- Distribute a modified product to end users with the Marks. Replace the product name, branded artwork and product identifiers (`app.koona.pin`, `pin@koona.app`) to avoid confusion with official builds. Keep copyright notices, license texts, third-party attribution and truthful statements of origin; rebranding is not permission to remove legal notices.
- Suggest that your product is official, endorsed by or affiliated with Koona.

These rules do not restrict rights independently granted by an applicable open-source license or uses that applicable law permits without permission, including protected descriptive references. Trademark protection is subject to the rights available under the applicable law; this policy does not claim registration or an exclusive right to every use of a word worldwide.

## The `.kpin` list format

The format is open: its specification, schema and conformance suite are CC0 ([koona-project/kpin](https://github.com/koona-project/kpin)), and anyone may implement it without asking. To that end, and notwithstanding the lists above:

- The format's identifiers are free to use in any tool: the `.kpin` file extension, the `"format": "koona"` value and the other fields of the envelope, and the media type `application/vnd.koona.list+json`. A tool that opens `.kpin` files on macOS may declare the type `app.koona.pin.list` as an imported type (`UTImportedTypeDeclarations`); Koona Pin exports it.
- A page, a list or a tool may write `koonapin://import?url=…` links that offer a list to Koona Pin.
- You may call your tool's files ".kpin lists" or "Koona lists", say it "reads and writes .kpin", and name a package or a project `kpin-…` (`kpin-rs`, `kpin-cli`).
- You may say your tool is **kpin-compatible**, or compatible with a revision of the format (such as 1.0, reader rules 2026-11), when it passes that revision's conformance suite; say which revision.

What stays reserved: "Koona" or "Koona Pin" in a product's own name; anything that suggests your tool is made or endorsed by Koona; and registering another app as the handler of the `koonapin:` scheme, which would catch the links a page means for Koona Pin. A reader that wants one-click links of its own uses a scheme of its own.

## Questions

For permission or to report misuse, open an issue at <https://github.com/andmetoo/koona-pin/issues> or write through <https://koona.app/pin/feedback>.
