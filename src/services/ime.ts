/**
 * Whether a key belongs to an IME (Chinese, Japanese, Korean input) building a
 * character: Enter there confirms the character, Esc cancels it, arrows pick a
 * candidate (NP-090). Our shortcuts leave such keys alone. WebView2 sends
 * keyCode 229 for some of them without `isComposing`.
 */
export function composing(e: KeyboardEvent | { nativeEvent: KeyboardEvent }): boolean {
  const event = "nativeEvent" in e ? e.nativeEvent : e;
  return event.isComposing || event.keyCode === 229;
}
