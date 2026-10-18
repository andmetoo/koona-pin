import { useEffect, useState } from "react";
import { useReaderLook } from "../hooks/useReaderLook";
import { applyTheme, isDark, savePreference, storedTheme, Theme } from "../services/preferences";
import type { SupporterStatus } from "../types";
import { useMedia } from "./layout";

/** The app's theme, following the system's when asked, and how reading looks (NP-124). */
export function useLook(supporter: SupporterStatus | null) {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const systemDark = useMedia("(prefers-color-scheme: dark)");
  const dark = isDark(theme, systemDark);
  /** How reading looks (NP-124): the Aa panel's choice, the app's theme and the plan. */
  const readerLook = useReaderLook(supporter, dark);
  useEffect(() => {
    applyTheme(dark);
    savePreference("theme", theme);
  }, [theme, dark]);
  return { theme, setTheme, readerLook };
}
