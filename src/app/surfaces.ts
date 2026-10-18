import { useEffect, useRef, useState } from "react";
import { syncPrompt } from "../components/commercial/syncText";
import { api } from "../services/api";
import { openRequests } from "../services/openRequests";
import type { ListSource } from "../services/shareList";
import { offer } from "../services/update";
import { emptyDraft, FeedbackDraft } from "../services/feedback";
import type { Plan, SupporterStatus, SyncStatus, UpdateStatus } from "../types";

/**
 * What opens over the window, one at a time: dialogs and sheets. `selectionCollection` — «Новая
 * коллекция из выбранного» in a narrow window, where the sidebar is a strip.
 */
export type Surface = "add" | "import" | "importFeeds" | "restore" | "backup" | "connect" | "assistant" | "collection" | "selectionCollection" | "feedback" | "background" | "update" | "supporter" | "signIn" | "plan" | "upgrade" | "sync" | "shareList" | null;

/** An OPML or bookmarks file dropped on the window: the import dialog opens with it (NP-139). */
export type DroppedFile = { name: string; content: string; surface: "import" | "importFeeds" };

/**
 * The surfaces (dialogs, sheets) and what opens them by itself: the list dialog for a `.kpin` that
 * waits (NP-138), the Sync dialog for a prompt on the main computer, and what closes them when what
 * they show is gone (a plan that ended, an update no longer on offer).
 */
export function useSurfaces({ supporter, sync, update }: { supporter: SupporterStatus | null; sync: SyncStatus | null; update: UpdateStatus | null }) {
  const [surface, setSurface] = useState<Surface>(null);
  /** «Share as list…» (NP-140): where the list dialog was opened from. */
  const [shareFrom, setShareFrom] = useState<ListSource[]>([]);
  const shareList = (sources: ListSource[]) => {
    setShareFrom(sources);
    setSurface("shareList");
  };
  /** The subscription «Switch to 5 years» was chosen for: the step says when it ends. */
  const [upgradeFrom, setUpgradeFrom] = useState<Plan | null>(null);
  // Kept while the app runs: closing the dialog or a failed send loses nothing (NP-088).
  const [feedbackDraft, setFeedbackDraft] = useState<FeedbackDraft>(emptyDraft);
  const [droppedFile, setDroppedFile] = useState<DroppedFile | null>(null);
  // A check that finds the plan gone (cancelled, refunded) closes its dialogs for good, so nothing
  // stays blocked behind a dialog that is no longer shown, nor offers to switch a plan that ended.
  const hasPlan = !!supporter?.plan;
  useEffect(() => {
    if (!hasPlan) setSurface((open) => (open === "plan" || open === "upgrade" ? null : open));
  }, [hasPlan]);
  /** The surface open now, for callbacks that outlive the render. */
  const surfaceNow = useRef<Surface>(null);
  surfaceNow.current = surface;

  // The list dialog (NP-138) takes the waiting request once nothing else is open over the window.
  // A dialog opened over an idle one lets the request go, as its own close would; one that
  // downloads or imports keeps its request and stays until it closes itself.
  const listNow = () => ({ request: openRequests.current(), id: openRequests.id(), busy: openRequests.busy() });
  const [list, setList] = useState(listNow);
  useEffect(() => openRequests.subscribe(() => setList(listNow())), []);
  const [listKept, setListKept] = useState<number | null>(null);
  const listOpen = !!list.request && (surface === null || list.busy || listKept === list.id);
  const listShown = useRef(false);
  useEffect(() => {
    if (surface !== null && listShown.current && listKept !== list.id) {
      if (list.busy) setListKept(list.id);
      else openRequests.done();
    }
    listShown.current = listOpen;
  }, [surface, list, listKept, listOpen]);
  // Rust brings the window forward for a list only when the interface has none (open_requests.rs).
  const listPending = !!list.request;
  useEffect(() => void api.setListOpen(listPending).catch(console.error), [listPending]);
  // A dropped file belongs to the import dialog it opened: any other surface lets it go, so
  // «Import…» opened later starts empty.
  useEffect(() => {
    if (droppedFile && droppedFile.surface !== surface) setDroppedFile(null);
  }, [surface, droppedFile]);

  // A computer to approve, or a request to hand the main computer over, opens the Sync dialog by
  // itself on the main computer, once per prompt, when no other dialog is in the way.
  const prompt = syncPrompt(sync);
  const promptShown = useRef<string | null>(null);
  useEffect(() => {
    if (!prompt || prompt === promptShown.current) return;
    // Another dialog open (a purchase among them, a list waiting or being imported) is finished first.
    if ((surface !== null && surface !== "sync") || list.request) return;
    promptShown.current = prompt;
    setSurface("sync");
  }, [prompt, surface, list.request]);
  // The dialog follows the update; when no version is in play any more (cancelled into a recheck,
  // or the preview «restarted»), it goes.
  useEffect(() => {
    if (surface === "update" && !offer(update)) setSurface(null);
  }, [surface, update]);

  return {
    surface,
    setSurface,
    surfaceNow,
    shareFrom,
    shareList,
    upgradeFrom,
    setUpgradeFrom,
    feedbackDraft,
    setFeedbackDraft,
    droppedFile,
    setDroppedFile,
    list,
    listOpen,
  };
}

export type Surfaces = ReturnType<typeof useSurfaces>;
