# Commercial code

The files in this folder are Commercial Software under the [Koona Pin Commercial License](../../LICENSE-COMMERCIAL.md), not the GPL. See [LICENSING.md](../../LICENSING.md).

You may read them and prepare contributions under the development permission in that license. Running them in production needs an active Supporter subscription.

- `koona-sync/` — the sync engine: changes by field, hybrid logical clocks, version vectors, end-to-end encryption and the device protocol. `koona-sync/src/schema11.sql` makes the Reading fields (Р-69) synced changes; the columns themselves are the app's schema (GPL). `koona-sync/src/schema12.sql` does the same for the site's name (`site_name`).
