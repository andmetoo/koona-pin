import type { ReactNode } from "react";
import { ChevronLeft, ExternalLink, FileX, RotateCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, CircleButton } from "../ui/buttons";
import { PhIcon } from "../ui/icons";
import { failureText } from "../../../components/reader/ArticleView";
import type { ReadFailure } from "../../../services/reader";

/**
 * The reader's and the post view's top (R1): glass circles 44 over the top edge's fade, Back on
 * the left, the screen's own on the right. They stay while the text scrolls under them.
 */
export function ReaderBar({ onBack, actions }: { onBack: () => void; actions?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="rd-bar">
      <div className="rd-bar-group">
        <CircleButton icon={ChevronLeft} size={44} label={t("phone.nav.back")} onClick={onBack} />
      </div>
      <div className="rd-bar-group">{actions}</div>
    </div>
  );
}

/**
 * Where the article would be when the page cannot be read: the reader's own reason, the original
 * in the browser, and another try when the site did not answer.
 */
export function ArticleFailure({ failure, onOpen, onRetry }: { failure: ReadFailure | null; onOpen: () => void; onRetry?: () => void }) {
  const { t } = useTranslation();
  const again = !!onRetry && (failure === null || failure.reason === "network" || failure.reason === "timeout");
  return (
    <div className="rd-failure" role="alert" data-reader-failure>
      <span className="rd-failure-icon">
        <PhIcon icon={FileX} />
      </span>
      <h2 className="ph-title2">{t("reader.failure.title")}</h2>
      <p className="ph-subhead">{failureText(failure, t)}</p>
      <div className="rd-failure-actions">
        <Button kind="primary" icon={ExternalLink} onClick={onOpen}>
          {t("phone.reader.openOriginal")}
        </Button>
        {again && (
          <Button kind="clear" icon={RotateCw} onClick={onRetry}>
            {t("common.retry")}
          </Button>
        )}
      </div>
    </div>
  );
}
