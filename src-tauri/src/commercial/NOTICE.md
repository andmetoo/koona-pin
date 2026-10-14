# Commercial code

The files in this folder are Commercial Software under the [Koona Pin Commercial License](../../../LICENSE-COMMERCIAL.md), not the GPL. See [LICENSING.md](../../../LICENSING.md).

You may read them and prepare contributions under the development permission in that license. Running them in production needs an active Supporter subscription.

- `backup_folder.rs` — Supporter's automatic backups to a folder of one's choice.
- `sync/` — Supporter's sync between computers (NP-059, NP-060, NP-063, Р-68): this device's identity (`identity.rs`), the relay client over the library (`worker.rs`), what the interface shows (`status.rs`) and the commands (`mod.rs`). The engine itself is the `koona-sync` crate in `src-tauri/commercial/koona-sync`.
