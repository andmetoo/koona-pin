// The only place for both numbers. scripts/build-extension.mjs writes VERSION
// into every browser's manifest; PROTOCOL is what the extension expects from
// Netami Pin (`protocol` in /api/health).
export const VERSION = "0.4.0";
export const PROTOCOL = 1;
