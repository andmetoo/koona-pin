import { useTranslation } from "react-i18next";
import { api } from "../../services/api";
import { HelpTopic, helpUrl } from "../../services/help";

/**
 * A quiet link to a section of the help on koona.app (NP-092), opened in the browser: «Learn more ↗»
 * or «Help ↗». The help is English; the link's words are the interface's.
 */
export function HelpLink({
  topic,
  label = "learnMore",
  onOpen,
  onError,
  inherit = false,
  size = "xs",
  className = "",
}: {
  topic: HelpTopic;
  label?: "learnMore" | "help";
  /** The screen's own way to open a link, where it has one. */
  onOpen?: (url: string) => void;
  /** Where to say that the browser could not be opened. */
  onError?: (err: unknown) => void;
  /** In a coloured banner: the banner's colour, underlined, instead of the accent. */
  inherit?: boolean;
  size?: "xs" | "sm";
  className?: string;
}) {
  const { t } = useTranslation();
  const url = helpUrl(topic);
  return (
    <button
      type="button"
      onClick={() => (onOpen ? onOpen(url) : void api.openUrl(url).catch((err) => onError?.(err)))}
      className={`font-medium ${inherit ? "underline hover:no-underline" : `${size === "sm" ? "text-sm" : "text-xs"} text-accent hover:underline`} ${className}`}
    >
      {t(`help.${label}`)}
    </button>
  );
}
