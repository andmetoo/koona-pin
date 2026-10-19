import "./InboxScreen.css";
import { useEffect, useLayoutEffect, useRef } from "react";
import { Check, CircleAlert, Ellipsis, Trash2 } from "lucide-react";
import { capabilities } from "../../../platform/capabilities";
import { success } from "../../../platform/haptics";
import { collectionColor } from "../../../services/collections";
import { collectionKeys } from "../../../services/triage";
import { DecisionPill } from "../inbox/DecisionPill";
import { InboxEmpty, InboxSorted } from "../inbox/InboxStates";
import { current as currentOf, isDone, minutesSpent, progress, summary, upcoming } from "../inbox/triage";
import { TriageCard } from "../inbox/TriageCard";
import { type Leaving, useTriage } from "../inbox/useTriage";
import { useSwipe } from "../inbox/useSwipe";
import { useBottomLift, usePhone } from "../PhoneContext";
import { Button } from "../ui/buttons";
import { Chip } from "../ui/controls";
import { PhIcon } from "../ui/icons";
import { Progress } from "../ui/Progress";
import { Header, Screen } from "../ui/Screen";

/** Collections offered as chips under the card, the suggested one first; the rest behind "More". */
const CHIPS = 5;
/**
 * The snackbar over the decision pill (frame I1): its bottom 22 above the pill, which sits 20
 * above the nav pill — 60 + 20 + 22 above the snackbar's place over the nav pill, less its 12.
 */
const LIFT = 90;

/**
 * I1–I3 and E1, the Inbox (NP-072b): with links waiting, triage — "Sort inbox" with "5 of 12" and
 * Done, the progress, the card stack with swipes, "File into a collection" chips with the
 * suggested one, the decision pill; sorted, the summary (I3); nothing waiting, "All sorted" (E1).
 * The queue is read when the tab opens, as the desktop's triage reads it when it starts; Done
 * leaves for the library (the phone has no inbox list besides triage, and the links left keep
 * waiting here).
 */
export function InboxScreen({ hidden }: { hidden: boolean }) {
  const { app, stack, sheets } = usePhone();
  const { t } = app;
  const triage = useTriage(app);
  const { state } = triage;
  const card = currentOf(state);
  const done = isDone(state);
  const steps = state?.steps.length ?? 0;
  // Nothing was ever waiting, or all of it was sorted elsewhere: E1.
  const empty = done && steps === 0;
  // Until the queue is read, the inbox's count says which header to show.
  const sorting = state ? !empty : app.counts.inbox > 0;
  const toLibrary = () => stack.selectTab("all");

  // The decision pill raises the snackbar while it shows.
  useBottomLift(LIFT, !hidden && sorting && !done);

  // `success()` once, when the last card is decided.
  const wasDone = useRef(done);
  useEffect(() => {
    if (done && !wasDone.current && steps > 0) void success();
    wasDone.current = done;
  }, [done, steps]);

  const swipe = useSwipe((kind, from) => triage.decide(kind, { from }));

  const title = sorting ? t("triage.title") : t("phone.inbox.title");
  const { done: number, total } = progress(state);

  return (
    <Screen label={t("phone.inbox.title")} hidden={hidden} className="inb-screen">
      <div className="inb-column" data-dragging={swipe.dragging || undefined}>
        <Header
          title={title}
          beside={sorting && total > 0 ? <span className="inb-count">{t("phone.kit.progress", { done: number, total })}</span> : undefined}
          account={sorting ? false : undefined}
          actions={
            sorting ? (
              <Button kind="clear" compact className="inb-finish" onClick={toLibrary}>
                {t("phone.inbox.done")}
              </Button>
            ) : undefined
          }
        >
          {sorting && <Progress done={done ? total : number} total={total} label={false} className="inb-progress" />}
        </Header>

        {triage.loadError ? (
          <div role="alert" className="inb-failed">
            <PhIcon icon={CircleAlert} at="field" />
            <span>{triage.loadError}</span>
            <Button kind="clear" compact onClick={() => void triage.reload()}>
              {t("common.retry")}
            </Button>
          </div>
        ) : !state ? null : empty ? (
          <InboxEmpty shareIntake={capabilities.share_intake} onLibrary={toLibrary} onNew={() => sheets.open({ kind: "newLink", props: {} })} />
        ) : done ? (
          <InboxSorted sum={summary(state.steps)} minutes={minutesSpent(state)} onLibrary={toLibrary} onUndo={triage.undo} />
        ) : (
          card && (
            <>
              <div className="inb-stack" data-armed={swipe.armed || undefined}>
                {[...upcoming(state, 2)].reverse().map((b, i, list) => (
                  <TriageCard key={b.id} b={b} place={list.length - i} />
                ))}
                <TriageCard
                  key={card.id}
                  b={card}
                  place={0}
                  data-toward={swipe.toward ?? undefined}
                  overlay={<SwipeLabel toward={swipe.toward} />}
                  onFavorite={triage.favorite}
                  onMore={() => sheets.open({ kind: "bookmarkMenu", props: { bookmarkId: card.id } })}
                  onClick={(e) => {
                    if (!swipe.isTap(e) || (e.target as HTMLElement).closest("button")) return;
                    stack.openBookmark(card.id);
                  }}
                  {...swipe.bind}
                />
                {triage.leaving && <LeavingCard key={triage.leaving.n} leaving={triage.leaving} onEnd={triage.endLeaving} />}
              </div>

              <div className="inb-file">
                <h2 className="ph-section-label inb-file-label">{t("phone.inbox.fileInto")}</h2>
                <div className="ph-chips" data-collection-chips>
                  {collectionKeys(app.library.collections, triage.suggested, CHIPS).map((c) => (
                    <Chip
                      key={c.id}
                      large
                      dot={collectionColor(c.id)}
                      suggested={triage.suggested?.collection_id === c.id}
                      onClick={() => triage.decide("move", { collection: c })}
                    >
                      <span data-user-text>{c.name}</span>
                    </Chip>
                  ))}
                  <Chip
                    large
                    icon={Ellipsis}
                    onClick={() =>
                      sheets.open({
                        kind: "collectionPicker",
                        props: { bookmarkIds: [card.id], selected: card.collection_id, title: card.title || card.url, onPick: triage.fileInto },
                      })
                    }
                  >
                    {t("phone.inbox.more")}
                  </Chip>
                </div>
              </div>

              <div className="inb-decide-slot">
                <DecisionPill
                  toward={swipe.toward}
                  disabled={!card}
                  onTrash={() => triage.decide("trash")}
                  onReading={() => triage.decide("reading")}
                  onKeep={() => triage.decide("keep")}
                />
              </div>
            </>
          )
        )}
      </div>
    </Screen>
  );
}

/** "Move to trash" or "Keep" on the dragged card, stronger as it nears the threshold (I2). */
function SwipeLabel({ toward }: { toward: "trash" | "keep" | null }) {
  const { t } = usePhone().app;
  if (!toward) return null;
  return (
    <span className="inb-swipe-label" data-toward={toward} aria-hidden="true">
      <PhIcon icon={toward === "trash" ? Trash2 : Check} at="field" />
      {toward === "trash" ? t("phone.inbox.toTrash") : t("phone.inbox.keep")}
    </span>
  );
}

/**
 * The card just decided, flying off toward its side in ~220 ms from where the finger let it go:
 * Keep right, Trash left, Reading up, a collection down. Transform and opacity only.
 */
function LeavingCard({ leaving, onEnd }: { leaving: Leaving; onEnd: (n: number) => void }) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { kind, from } = leaving;
    const start = `translate3d(${from}px, 0, 0) rotate(${from / 22}deg)`;
    const width = el.offsetWidth || 360;
    const end =
      kind === "trash"
        ? `translate3d(${-1.3 * width}px, 24px, 0) rotate(-14deg)`
        : kind === "keep"
          ? `translate3d(${1.3 * width}px, 24px, 0) rotate(14deg)`
          : kind === "reading"
            ? "translate3d(0, -110%, 0) scale(0.9)"
            : "translate3d(0, 60%, 0) scale(0.85)";
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const frames = reduce ? [{ opacity: 1 }, { opacity: 0 }] : [{ transform: start, opacity: 1 }, { transform: end, opacity: 0 }];
    const animation = el.animate?.(frames, { duration: 220, easing: "cubic-bezier(0.32, 0.72, 0.24, 1)", fill: "forwards" });
    if (!animation) return onEnd(leaving.n);
    animation.onfinish = () => onEnd(leaving.n);
    return () => animation.cancel();
  }, []);
  return (
    <div className="inb-leaving" aria-hidden="true">
      <TriageCard b={leaving.b} place={-1} cardRef={ref} />
    </div>
  );
}
