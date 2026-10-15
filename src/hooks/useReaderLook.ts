import { useCallback, useEffect, useMemo, useState } from "react";
import type { SupporterStatus } from "../types";
import { ReaderChoice, resolveReaderLook, saveReaderChoice, storedReaderChoice, supporterUnlocked } from "../services/readerLook";

/** A locked theme or font picked in the Aa panel, waiting for the plan. */
export type ReaderWish = Partial<Pick<ReaderChoice, "theme" | "font">>;

/**
 * The Aa panel's choice (NP-124), kept per computer, and the look it gives now:
 * the app's theme for `auto`, the plan for Supporter's themes and fonts. A locked
 * item picked while there is no plan waits here, the current look unchanged, and
 * becomes the choice as soon as the plan arrives.
 */
export function useReaderLook(supporter: SupporterStatus | null, appDark: boolean) {
  const [choice, setChoiceState] = useState<ReaderChoice>(storedReaderChoice);
  const [wish, setWish] = useState<ReaderWish | null>(null);
  const unlocked = supporterUnlocked(supporter);
  const look = useMemo(() => resolveReaderLook(choice, { appDark, unlocked }), [choice, appDark, unlocked]);
  const setChoice = useCallback((next: ReaderChoice) => {
    setChoiceState(next);
    saveReaderChoice(next);
    setWish(null);
  }, []);
  useEffect(() => {
    if (!unlocked || !wish) return;
    setChoiceState((current) => {
      const next = { ...current, ...wish };
      saveReaderChoice(next);
      return next;
    });
    setWish(null);
  }, [unlocked, wish]);
  return { choice, setChoice, look, unlocked, wish: setWish };
}
