// The only place for these numbers. scripts/build-extension.mjs writes VERSION
// into every browser's manifest; PROTOCOL is the native messaging protocol the
// app must speak (Р-17); HOST is the native messaging host the app registers.
export const VERSION = "0.6.0";
export const PROTOCOL = 2;
export const HOST = "app.netami.pin";
