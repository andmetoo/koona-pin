import { api } from "./api";
import { describeError } from "./errors";

/** Opens a link in the system browser; a browser that does not open is handed to `say`, in words. */
export const opener =
  (say: (text: string, alert?: boolean) => void) =>
  (url: string): void =>
    void api.openUrl(url).catch((err) => say(describeError(err), true));
