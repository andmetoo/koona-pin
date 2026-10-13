import { ext, t } from "./ext.js";
import { HOST, PROTOCOL, VERSION } from "./version.js";

/**
 * Which browser runs the extension: Edge can install it from the Chrome Web
 * Store. Safari has `browser` without getBrowserInfo and no userAgentData; its
 * extension pages are served as safari-web-extension: (NP-119).
 */
export function browserName(scope = globalThis) {
  if (scope.browser?.runtime?.getBrowserInfo) return "firefox";
  if (scope.location?.protocol === "safari-web-extension:") return "safari";
  const brands = scope.navigator?.userAgentData?.brands ?? [];
  return brands.some((b) => b.brand === "Microsoft Edge") ? "edge" : "chrome";
}

/**
 * The browser's own errors when it cannot start the host. Chrome and Edge:
 * «Specified native messaging host not found.» (no key, manifest or exe);
 * Firefox: «No such native application …» (NP-014), also for an add-on the
 * manifest does not list. Safari has no host: the message goes to the app
 * extension in Koona Pin.app, and WebKit says «Invalid call to
 * runtime.sendNativeMessage(). Native messaging is not supported.» when it
 * cannot find or load it (WebExtensionContextAPIRuntimeCocoa.mm, NP-119).
 * Its other errors (the handler canceled, crashed or failed, too many
 * requests, «Couldn't communicate with a helper application.») are host_failed.
 */
const missing = /not found|No such native application|not registered|native messaging is not supported/i;
/**
 * Chrome and Edge: «Access to the specified native messaging host is
 * forbidden.» — the app is there, but its manifest does not list this
 * extension's id, as an installed app with a development build (NP-113).
 */
const forbidden = /forbidden/i;

function hostCode(text) {
  if (forbidden.test(text)) return "host_forbidden";
  return missing.test(text) ? "host_missing" : "host_failed";
}

/** One message to Koona Pin through the native host; never throws. */
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
    return { ok: false, code: hostCode(text), message: text };
  }
}

/** The app is older than the extension when it answers with a lower protocol. */
export const appIsOlder = (reply) => (reply?.protocol ?? PROTOCOL) < PROTOCOL;

/** What the queue shows for a failed delivery, and whether to stop retrying it. */
export function failure(reply) {
  switch (reply?.code) {
    case "host_missing":
      return { permanent: false, error: t("errorHostMissing") };
    case "host_forbidden":
      return { permanent: false, error: t("errorHostForbidden") };
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
