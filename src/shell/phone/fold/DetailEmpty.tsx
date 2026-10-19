import "./fold.css";
import spiritMark from "../../../../design/brand/pin-spirit-flat/pin-spirit-micro.svg";
import type { Tab } from "../navigation/stack";
import { usePhone } from "../PhoneContext";

/**
 * The Fold's detail sheet with nothing selected: the Pin Spirit mark and one calm line (what a tap
 * on the list opens here). The sheet keeps its place, so the list does not jump when a row is
 * chosen.
 */
export function DetailEmpty({ tab }: { tab: Tab }) {
  const { app } = usePhone();
  const { t } = app;
  const mask = `url("${spiritMark}") center / contain no-repeat`;
  return (
    <div className="fl-empty" data-detail-empty>
      <span className="fl-empty-mark" style={{ mask, WebkitMask: mask }} aria-hidden="true" />
      <p className="ph-callout">{t(tab === "feeds" ? "phone.detail.emptyFeeds" : tab === "inbox" ? "phone.detail.emptyInbox" : "phone.detail.empty")}</p>
    </div>
  );
}
