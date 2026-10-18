import { invoke } from "@tauri-apps/api/core";
import { capabilities } from "./capabilities";

/**
 * Haptic feedback on a phone (NP-072b), through the haptics plugin of Tauri (registered on phone
 * builds only, src-tauri/src/mobile). Without the `haptics` capability — a desktop, the browser
 * demo, the tests — every call does nothing. A call never throws and never waits: feedback that
 * fails is lost, not reported.
 *
 * The commands are the plugin's own (`@tauri-apps/plugin-haptics` is a thin wrapper of the same
 * `invoke`). Android plays them as vibration patterns, without the system's touch-feedback setting.
 */
function play(command: string, args?: Record<string, unknown>): Promise<void> {
  if (!capabilities.haptics) return Promise.resolve();
  try {
    return invoke(`plugin:haptics|${command}`, args).then(
      () => {},
      () => {},
    );
  } catch {
    return Promise.resolve();
  }
}

/** A tick: a section or a tab changed, a long-press menu opened, pull-to-refresh armed. */
export const selection = () => play("selection_feedback");

/** A light knock: a triage swipe passed its threshold. */
export const impactLight = () => play("impact_feedback", { style: "light" });

/** A firmer knock: a decision landed (a card kept, trashed or put into Reading). */
export const impactMedium = () => play("impact_feedback", { style: "medium" });

/** Something finished well: the inbox is sorted. */
export const success = () => play("notification_feedback", { type: "success" });
