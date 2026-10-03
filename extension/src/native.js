import { ext, t } from "./ext.js";
import { HOST, PROTOCOL, VERSION } from "./version.js";

/** Which browser runs the extension: Edge can install it from the Chrome Web Store. */
export function browserName(scope = globalThis) {
  if (scope.browser?.runtime?.getBrowserInfo) return "firefox";
  const brands = scope.navigator?.userAgentData?.brands ?? [];
  return brands.some((b) => b.brand === "Microsoft Edge") ? "edge" : "chrome";
}

/**
 * The browser's own errors when it cannot start the host. Chrome and Edge:
 * «Specified native messaging host not found.» (no key, manifest or exe) and
 * «Access to the specified native messaging host is forbidden.»; Firefox:
 * «No such native application …» (NP-014).
 */
const missing = /not found|forbidden|No such native application|not registered/i;

/** One message to Netami Pin through the native host; never throws. */
export async function talk(message, runtime = ext.runtime) {
  try {
    const reply = await runtime.sendNativeMessage(HOST, {
      ...message,
      protocol: PROTOCOL,
      version: VERSION,
      browser: browserName(),
    });
    return reply ?? { ok: false, code: "host_failed", message: "empty reply" };
  } catch (error) {
    const text = String(error?.message ?? error);
    return { ok: false, code: missing.test(text) ? "host_missing" : "host_failed", message: text };
  }
}

/** The app is older than the extension when it answers with a lower protocol. */
export const appIsOlder = (reply) => (reply?.protocol ?? PROTOCOL) < PROTOCOL;

/** What the queue shows for a failed delivery, and whether to stop retrying it. */
export function failure(reply) {
  switch (reply?.code) {
    case "host_missing":
      return { permanent: false, error: t("errorHostMissing") };
    case "incompatible_protocol":
      return { permanent: false, error: appIsOlder(reply) ? t("errorIncompatibleApp") : t("errorIncompatible") };
    case "invalid_request":
      return { permanent: true, error: t("errorInvalidRequest") };
    case "request_id_conflict":
      return { permanent: true, error: t("errorConflict") };
    case "database_error":
      return { permanent: false, error: t("errorDatabase") };
    default:
      // app_unavailable, host_failed and anything new: try again later.
      return { permanent: false, error: t("errorUnavailable") };
  }
}
