import { invoke } from "@tauri-apps/api/core";
import { capabilities } from "./capabilities";

/**
 * Haptic feedback on a phone (NP-072b), played by the koona-mobile plugin (registered on phone
 * builds only, src-tauri/src/mobile) as the system's own touch feedback: Android's
 * `performHapticFeedback` on the WebView and UIKit's feedback generators, both silent while the
 * system's touch-feedback (haptics) setting is off. Without the `haptics` capability — a desktop,
 * the browser demo, the tests — every call does nothing. A call never throws and never waits:
 * feedback that fails is lost, not reported.
 */
function play(kind: "selection" | "impactLight" | "impactMedium" | "success"): Promise<void> {
  if (!capabilities.haptics) return Promise.resolve();
  try {
    return invoke("plugin:koona-mobile|haptic", { kind }).then(
      () => {},
      () => {},
    );
  } catch {
    return Promise.resolve();
  }
}

/** A tick: a section or a tab changed, a long-press menu opened, pull-to-refresh armed. */
export const selection = () => play("selection");

/** A light knock: a triage swipe passed its threshold. */
export const impactLight = () => play("impactLight");

/** A firmer knock: a decision landed (a card kept, trashed or put into Reading). */
export const impactMedium = () => play("impactMedium");

/** Something finished well: the inbox is sorted. */
export const success = () => play("success");
