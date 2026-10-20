import { useTranslation } from "react-i18next";
import { HelpTopic, helpUrl } from "../../services/help";

/**
 * A quiet link to a section of the help on koona.app (NP-092), opened in the browser: «Learn more ↗»
 * or «Help ↗». The help is English; the link's words are the interface's.
 */
export function HelpLink({
  topic,
  label = "learnMore",
  onOpen,
  look = "xs",
  className = "",
}: {
  topic: HelpTopic;
  label?: "learnMore" | "help";
  /** The screen's way to open a link, which also says when the browser could not be opened. */
  onOpen: (url: string) => void;
  /** Accent text, small or as the text around; `inherit`: a coloured banner's colour, underlined. */
  look?: "xs" | "sm" | "inherit";
  className?: string;
}) {
  const { t } = useTranslation();
  const style = look === "inherit" ? "underline hover:no-underline" : `${look === "sm" ? "text-sm" : "text-xs"} text-accent hover:underline`;
  return (
    <button type="button" onClick={() => onOpen(helpUrl(topic))} className={`font-medium ${style} ${className}`}>
      {t(`help.${label}`)}
    </button>
  );
}
