# Commercial code

The files in this folder are Commercial Software under the [Koona Pin Commercial License](../../../LICENSE-COMMERCIAL.md), not the GPL. See [LICENSING.md](../../../LICENSING.md).

You may read them and prepare contributions under the development permission in that license. Running them in production needs an active Supporter subscription.

- `SyncDialog.tsx` — the interface of Supporter's sync between computers (NP-059, NP-063, sheet 46): the first turn-on, the overview, pairing, the change of the main computer, starting over, details.
- `SyncRows.tsx` — the sync row of the Supporter dialog and of Settings → Data.
- `syncText.ts` — what each state of sync says: the banners and the one-line summaries.
- `readerThemes.ts` — Supporter's reading themes (NP-124, Р-69): the Paper and Sepia palettes. It registers them with the community Aa panel (`src/services/readerLook.ts`), which works without it and shows them locked.
