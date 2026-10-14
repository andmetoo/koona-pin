// The app's SQL functions its library triggers call (migrations.rs, schema 10 of koona-sync), for
// tests and scripts that write to a library through node:sqlite instead of the app. Without them
// SQLite refuses the write ("no such function"). Here a write is indexed at once
// (`np_index_now`), records nothing for sync (`np_sync_capture`: the app's own writes do), and
// leaves the sort keys empty; the app fills them again when it opens the library.
export function registerLibraryFunctions(db) {
  // `varargs`: node:sqlite would take the arity from the JavaScript function, here none.
  const define = (name, value) => db.function(name, { varargs: true }, () => value);
  for (const name of ["np_sort_key", "np_site_key"]) define(name, null);
  define("np_index_now", 1);
  define("np_sync_capture", 0);
  for (const name of ["np_hlc", "np_hlc_last", "np_sync_origin", "np_sync_counter", "np_sync_counter_last"]) define(name, null);
}
