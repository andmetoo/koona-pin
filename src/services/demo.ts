import { version as packageVersion } from "../../package.json";
import type { ReaderPage } from "../bindings/ReaderPage";
import type { ListCheck } from "../bindings/ListCheck";
import type { ListDownload } from "../bindings/ListDownload";
import type { ListDownloadProgress } from "../bindings/ListDownloadProgress";
import type { ListFile } from "../bindings/ListFile";
import type { ListImportOptions } from "../bindings/ListImportOptions";
import type { ListImportReport } from "../bindings/ListImportReport";
import {
  AddedLink,
  BackupCopy,
  BackupRestoreOutcome,
  BackupSource,
  Bookmark,
  BookmarkChange,
  BookmarkPage,
  BookmarkSort,
  BulkChange,
  BulkChanged,
  Changed,
  Collection,
  CommandAction,
  DataSummary,
  Desktop,
  FilterState,
  CsvColumns,
  ExportFormat,
  ExportOutcome,
  ImportProgress,
  RestoreCheck,
  RestoreMode,
  RestoreOutcome,
  RestoreProblem,
  RestoreSummary,
  ImportSummary,
  LibraryPlace,
  LibraryStatus,
  CaptureStatus,
  Feedback,
  PickedCopy,
  SaveCopyOutcome,
  DuplicateGroup,
  MergeGroup,
  Merged,
  CheckedLink,
  LinkCheckProgress,
  LinkCheckReport,
  LinkCheckState,
  PreviewCounts,
  PreviewRefresh,
  PreviewScope,
  LinkFailure,
  Replaced,
  StarterLibrary,
  StarterLink,
  Undo,
  UpdateStatus,
  McpAccess,
  McpSetup,
  McpStatus,
  OfflineArticle,
  OfflineCopy,
  OfflineCopyContent,
  OfflineStats,
  SupporterStatus,
  SupporterPrices,
  PlanInterval,
  CheckoutState,
  BackupFolder,
  SyncAccount,
  SyncDevice,
  SyncStatus,
  Feed,
  FeedArticle,
  FeedCandidate,
  FeedDestination,
  FeedHealth,
  FeedItem,
  FeedItemPage,
  FeedSave,
  FeedItemQuery,
  FeedPreview,
  FeedsChanged,
  FeedsRefresh,
  LinkPreview,
  OpmlExport,
  OpmlImport,
  SavePlace,
} from "../types";
import type { PageRequest } from "./api";
import { demoLibrary, poster, posterOf } from "./demoData";
import { DEMO_FEEDS, DEMO_POSTS, isFull, pictureOf, postHtml, postUrl } from "./demoFeeds";
import { parseBookmarksFile } from "./bookmarksFile";
import { cursorAt, isAfter, ListOrder, listTime, matchesBookmark, orderOf, sortBookmarks } from "./library";
import { suggestFrom } from "./triage";
import { groupsOf, mergedFields } from "./duplicates";
import { CommandError } from "./errors";
import { storedValue } from "./preferences";
import { emailShape, length, MAX_MESSAGE } from "./feedback";
import i18n, { resolveLanguage, storedLanguage } from "../i18n";

const demoCaptureStatus: CaptureStatus = {
  state: "none",
  browsers: [],
  last_capture: null,
  days_silent: null,
  problem: null,
  detail: null,
  protocol: 2,
  system: "windows",
};

// v2: generated previews instead of the drawn ones of the concepts; v3: the inbox; v4: the trash.
export const DEMO_STORAGE_KEY = "koonapin.demo.v4";
/** The desktop the preview pretends to run on (NP-053): a JSON `Desktop`. */
export const DEMO_DESKTOP_KEY = "koonapin.demo.desktop";
function storedDesktop(): Desktop | null {
  try {
    return JSON.parse(localStorage.getItem(DEMO_DESKTOP_KEY) || "null") as Desktop | null;
  } catch {
    return null;
  }
}
/**
 * The update the preview pretends to find (NP-038, sheet 42): `available` offers 0.3.0 and «Update»
 * walks through the download; `failing` offers it and the download stops. Without the key the app
 * is up to date, so screenshots and visual tests stay as they were.
 */
export const DEMO_UPDATE_KEY = "koonapin.demo.update";
/** AI assistants (NP-091): off, as in a new library; no assistant ever asks the preview. */
let demoMcp: McpStatus = { access: "off", mode: "read", last_client: null, last_at: null };
const mcpListeners = new Set<(status: McpStatus) => void>();
let demoUpdate: UpdateStatus | null = null;
const updateListeners = new Set<(status: UpdateStatus) => void>();
function storedUpdate(): string | null {
  try {
    return localStorage.getItem(DEMO_UPDATE_KEY);
  } catch {
    return null;
  }
}
const DEMO_NEW_VERSION = "0.3.0";
const demoOffer = (): UpdateStatus => ({
  state: "available",
  version: DEMO_NEW_VERSION,
  notes: [
    "Koona Pin checks koona.app once a day for a new version and installs it only when you say so.",
    "The start with the session on Linux survives a sudden power-off.",
    "Settings → Updates shows when the last check ran.",
  ],
  notes_url: `https://koona.app/pin/changelog/#${DEMO_NEW_VERSION}`,
});
function currentDemoUpdate(): UpdateStatus {
  demoUpdate ??= storedUpdate() ? demoOffer() : { state: "up_to_date", checked_at: new Date().toISOString() };
  return demoUpdate;
}
function setDemoUpdate(status: UpdateStatus) {
  demoUpdate = status;
  updateListeners.forEach((fn) => fn(status));
}
let demoDownload: number | null = null;

/**
 * Supporter (NP-066, sheet 45): `free` shows the row and the dialog, whose test payment is seen
 * after two polls; `existing` pays with the email of an account that existed before, so the payment
 * asks for the code; `background` has the app see the payment before the dialog does;
 * `later_sign_in` and `later_paid` have it see an earlier purchase while the dialog shows the plans; `supporter`, `canceling`, `past_due`, `offline`,
 * `five_years`, `five_years_renewing` are the states of the plan dialog; `no_server` makes every request fail. Without the key the build sells nothing, as a release.
 */
export const DEMO_SUPPORTER_KEY = "koonapin.demo.supporter";
/** «Mark as read at the end» (NP-124): "false" turns it off, as app_settings does. */
const DEMO_MARK_AT_END_KEY = "koonapin.demo.readingMarkAtEnd";
const demoMarkAtEnd = () => {
  try {
    return localStorage.getItem(DEMO_MARK_AT_END_KEY) !== "false";
  } catch {
    return true;
  }
};
/** «Save articles I open in Reading» (NP-126): "true" turns it on; off by default, as app_settings has it. */
const DEMO_SAVE_OFFLINE_KEY = "koonapin.demo.readingSaveOffline";
/** A demo switch from localStorage; none where storage cannot be read. */
function demoSwitch(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
const storedSupporter = () => demoSwitch(DEMO_SUPPORTER_KEY);
const supporterListeners = new Set<(status: SupporterStatus) => void>();
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
function demoPlan(kind: string | null): SupporterStatus["plan"] {
  // `offline_until` as the server signs it: 30 days ahead, never past the period and a week.
  const plan = { also_renews: false };
  if (kind === "supporter") return { ...plan, status: "active", interval: "year", valid_until: inDays(365), renews_at: inDays(365), offline_until: inDays(30) };
  if (kind === "canceling") return { ...plan, status: "canceling", interval: "year", valid_until: inDays(20), renews_at: null, offline_until: inDays(30) };
  if (kind === "past_due") return { ...plan, status: "past_due", interval: "month", valid_until: inDays(20), renews_at: inDays(20), offline_until: inDays(27) };
  if (kind === "offline") return { ...plan, status: "active", interval: "year", valid_until: inDays(-2), renews_at: inDays(-2), offline_until: inDays(5) };
  // Supporter · 5 years, paid once; `five_years_renewing` while a subscription still renews too.
  const fiveYears = { status: "active", interval: "five_years", valid_until: inDays(1826), renews_at: null, offline_until: inDays(30) } as const;
  if (kind === "five_years") return { ...fiveYears, also_renews: false };
  if (kind === "five_years_renewing") return { ...fiveYears, also_renews: true };
  return null;
}
let demoSupporter: SupporterStatus | null = null;
function currentDemoSupporter(): SupporterStatus {
  const kind = storedSupporter();
  const plan = demoPlan(kind);
  demoSupporter ??= {
    available: kind !== null,
    sandbox: true,
    email: plan ? "anna@example.com" : null,
    plan,
    check_failed: kind === "offline",
    plan_unknown: false,
    awaiting_sign_in: false,
  };
  return demoSupporter;
}
function setDemoSupporter(status: SupporterStatus) {
  demoSupporter = status;
  supporterListeners.forEach((fn) => fn(status));
}
let demoPolls = 0;
/** The plan of the last purchase started: five years paid once become that plan. */
let demoBought: PlanInterval | null = null;

/** Backups to a folder (commercial/backup_folder.rs): `koonapin.demo.backupFolder` = `unreachable` starts with a folder that cannot be reached. */
const folderListeners = new Set<(folder: BackupFolder) => void>();
let demoFolder: BackupFolder | null = null;
function currentDemoFolder(): BackupFolder {
  let kind: string | null = null;
  try {
    kind = localStorage.getItem("koonapin.demo.backupFolder");
  } catch {
    kind = null;
  }
  demoFolder ??=
    kind === "unreachable"
      ? { path: "D:\\Dropbox\\Koona Pin", last_copy_at: inDays(-3), unreachable: true }
      : { path: null, last_copy_at: null, unreachable: false };
  return demoFolder;
}
function setDemoFolder(folder: BackupFolder) {
  demoFolder = folder;
  folderListeners.forEach((fn) => fn(folder));
}

/**
 * Sync (commercial/sync, NP-059, NP-063, sheet 46): `koonapin.demo.sync` is the state the preview
 * starts in, so every screen can be seen without a relay. The account's computers are Home iMac (the
 * main one), Office laptop and Studio PC.
 *
 * - `off` (the default): sync never turned on here and the account has no main computer; «Set up…»
 *   makes this the main computer of one (frame 02).
 * - `off_join`: sync off here, the account's main computer is Home iMac (frame 14); «Turn on sync»
 *   waits for it with the code (frame 06).
 * - `on`: this is Home iMac, the main computer of three (frame 03).
 * - `other`: this is Office laptop; Home iMac, the main one, is offline (frame 04). `start_over`: it
 *   has been offline for 12 days (frame 13 from «Make this the main computer»).
 * - `pairing`: Office laptop wants to join, the code on the main computer (frame 05).
 * - `pending`: this new computer waits for Home iMac, the code shown (frame 06); `rejected`: the
 *   main computer declined it.
 * - `receiving`: the first sync brings the library here (frame 07).
 * - `main_asked`: on Home iMac, Office laptop asks to become the main computer (frame 12);
 *   `asking_main`: Office laptop waits for that answer.
 * - Banners (frame 11): `offline`, `others_offline`, `added`, `skew`, `update`, `started_over`,
 *   `revoked`, `signed_out`, `syncing`. «Sync stops on…» is `on` with `koonapin.demo.supporter` = `canceling`.
 */
export const DEMO_SYNC_KEY = "koonapin.demo.sync";
const syncListeners = new Set<(status: SyncStatus) => void>();
let demoSync: SyncStatus | null = null;
const THIS_DEVICE = "0f8e2c1a-5b7d-4e39-9a61-3c2d4b5e6f70";
const HUB_DEVICE = "6a1b9c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const LAPTOP_DEVICE = "c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f";
const STUDIO_DEVICE = "9e8d7c6b-5a49-4382-b716-0f1e2d3c4b5a";
const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000;
const isoMinutesAgo = (minutes: number) => new Date(minutesAgo(minutes)).toISOString();
function demoDevice(id: string, name: string, extra: Partial<SyncDevice> = {}): SyncDevice {
  return { id, name, online: false, is_hub: false, status: "active", last_seen: minutesAgo(90), platform: null, app: null, last_sync_at: null, ...extra };
}
/** The account's bookmarks, as sync counts them: the preview's own library, so the dialog agrees with it. */
const demoLibraryCount = () => bookmarks.filter((b) => !b.deleted_at).length;
/** What Home iMac, Office laptop and Studio PC say of themselves in their `hello`. */
// The computers run the version this preview was built from.
const IMAC = { platform: "macos", app: packageVersion } as const;
const LAPTOP = { platform: "windows", app: packageVersion } as const;
const STUDIO = { platform: "linux", app: "0.12.0" } as const;
function demoSyncState(kind: string | null): SyncStatus {
  // On Home iMac, the main computer.
  const hub = demoDevice(THIS_DEVICE, "Home iMac", { ...IMAC, online: true, is_hub: true, last_seen: minutesAgo(0), last_sync_at: isoMinutesAgo(0) });
  const laptop = demoDevice(LAPTOP_DEVICE, "Office laptop", { ...LAPTOP, online: true, last_seen: minutesAgo(2), last_sync_at: isoMinutesAgo(2) });
  const studio = demoDevice(STUDIO_DEVICE, "Studio PC", { ...STUDIO, last_seen: minutesAgo(180), last_sync_at: isoMinutesAgo(26 * 60) });
  const on: SyncStatus = {
    enabled: true,
    available: true,
    phase: { state: "online" },
    is_hub: true,
    hub: THIS_DEVICE,
    device: hub,
    devices: [hub, laptop, studio],
    pairing: null,
    last_sync_at: isoMinutesAgo(0),
    error: null,
    hub_change: null,
    notices: [],
    bookmarks: demoLibraryCount(),
    clock_offset_ms: 400,
    update_from: null,
    epoch: 2,
  };
  // On Office laptop, another computer; Home iMac is the main one, away `hubAway` minutes.
  const other = (hubAway: number | null): SyncStatus => {
    const me = demoDevice(THIS_DEVICE, "Office laptop", { ...LAPTOP, online: true, last_seen: minutesAgo(0), last_sync_at: isoMinutesAgo(0) });
    const main = demoDevice(
      HUB_DEVICE,
      "Home iMac",
      hubAway === null
        ? { ...IMAC, online: true, is_hub: true, last_seen: minutesAgo(1), last_sync_at: isoMinutesAgo(1) }
        : { ...IMAC, is_hub: true, last_seen: minutesAgo(hubAway), last_sync_at: isoMinutesAgo(hubAway) },
    );
    const pc = demoDevice(STUDIO_DEVICE, "Studio PC", { ...STUDIO, online: true, last_seen: minutesAgo(1), last_sync_at: isoMinutesAgo(1) });
    return { ...on, is_hub: false, hub: HUB_DEVICE, device: me, devices: [main, me, pc] };
  };
  switch (kind) {
    case "on":
      return on;
    case "other":
      return other(2 * 24 * 60);
    case "start_over":
      return other(12 * 24 * 60);
    case "pairing": {
      const fresh = demoDevice(LAPTOP_DEVICE, "Office laptop", { ...LAPTOP, online: true, status: "pending", last_seen: minutesAgo(0) });
      return { ...on, devices: [hub, studio, fresh], pairing: { role: "hub", peer: LAPTOP_DEVICE, peer_name: "Office laptop", code: "482913" } };
    }
    case "pending":
    case "rejected": {
      const me = demoDevice(THIS_DEVICE, "Office laptop", { ...LAPTOP, online: true, status: "pending", last_seen: minutesAgo(0) });
      const main = demoDevice(HUB_DEVICE, "Home iMac", { online: true, is_hub: true, last_seen: minutesAgo(0) });
      return {
        ...on,
        phase: { state: "pending" },
        is_hub: false,
        hub: HUB_DEVICE,
        device: me,
        devices: [main, me],
        pairing: kind === "pending" ? { role: "asking", peer: HUB_DEVICE, peer_name: "Home iMac", code: "482913" } : null,
        last_sync_at: null,
        error: kind === "rejected" ? "pairing_rejected" : null,
        epoch: null,
      };
    }
    case "receiving":
      return { ...other(null), phase: { state: "syncing", done: 4210, total: 12480 }, last_sync_at: null };
    case "syncing":
      return { ...on, phase: { state: "syncing", done: 38, total: 120 } };
    case "main_asked":
      return { ...on, hub_change: { role: "hub", peer: LAPTOP_DEVICE, peer_name: "Office laptop" } };
    case "asking_main":
      return { ...other(null), hub_change: { role: "asking", peer: HUB_DEVICE, peer_name: "Home iMac" } };
    case "offline":
      return { ...on, phase: { state: "paused", reason: "offline" }, devices: [hub, { ...laptop, online: false }, studio], last_sync_at: isoMinutesAgo(40) };
    case "others_offline":
      return { ...on, devices: [hub, { ...laptop, online: false, last_seen: minutesAgo(25) }, studio], last_sync_at: isoMinutesAgo(25) };
    case "added":
      return {
        ...other(null),
        notices: [{ kind: "device_added", id: "notice-added", device: STUDIO_DEVICE, name: "Studio PC", by_name: "Home iMac", at: isoMinutesAgo(0) }],
      };
    case "skew":
      return { ...on, phase: { state: "paused", reason: "clock_skew" }, last_sync_at: isoMinutesAgo(60), clock_offset_ms: 7 * 60_000 + 12_000 };
    case "update": {
      // Office laptop runs an older version than Home iMac, which said so.
      const base = other(null);
      const old = { ...base.device, app: "0.12.0" };
      return {
        ...base,
        phase: { state: "paused", reason: "update_needed" },
        device: old,
        devices: base.devices.map((d) => (d.id === old.id ? old : d)),
        last_sync_at: isoMinutesAgo(60),
        update_from: HUB_DEVICE,
      };
    }
    case "revoked":
      return { ...other(null), phase: { state: "paused", reason: "revoked" } };
    case "signed_out":
      return { ...on, phase: { state: "paused", reason: "signed_out" } };
    case "started_over": {
      const base = other(null);
      return {
        ...base,
        phase: { state: "paused", reason: "started_over" },
        hub: STUDIO_DEVICE,
        devices: base.devices.map((d) => ({ ...d, is_hub: d.id === STUDIO_DEVICE })),
        notices: [{ kind: "started_over", id: "notice-started-over", by: STUDIO_DEVICE, by_name: "Studio PC", at: isoMinutesAgo(30) }],
      };
    }
  }
  const alone = demoDevice(THIS_DEVICE, kind === "off_join" ? "Office laptop" : "Home iMac", { status: "unregistered", last_seen: null });
  return { ...on, enabled: false, phase: { state: "off" }, is_hub: false, hub: null, device: alone, devices: [], last_sync_at: null, clock_offset_ms: null, epoch: null };
}
/**
 * What the relay says of the account before this computer turns sync on: `off_join` has Home iMac;
 * a computer that turned sync off keeps its account's main computer, unless that was itself.
 */
function demoSyncAccount(): SyncAccount {
  const status = currentDemoSync();
  if (status.devices.length === 0) return { main_name: demoSwitch(DEMO_SYNC_KEY) === "off_join" ? "Home iMac" : null };
  const hub = status.devices.find((d) => d.is_hub && d.id !== status.device.id);
  return { main_name: hub?.name ?? null };
}
function currentDemoSync(): SyncStatus {
  demoSync ??= demoSyncState(demoSwitch(DEMO_SYNC_KEY));
  return demoSync;
}
function setDemoSync(status: SyncStatus) {
  demoSync = status;
  syncListeners.forEach((fn) => fn(status));
}
const syncPause = () => new Promise((resolve) => setTimeout(resolve, 300));
function needSyncRunning() {
  if (!currentDemoSync().enabled) throw new CommandError("invalid_request", "Sync is not running");
}
function changeDemoDevices(change: (devices: SyncDevice[]) => SyncDevice[]): SyncStatus {
  const status = currentDemoSync();
  const devices = change(status.devices);
  const device = devices.find((d) => d.id === status.device.id) ?? status.device;
  const hub = devices.find((d) => d.is_hub)?.id ?? status.hub;
  setDemoSync({ ...status, devices, device, hub, is_hub: hub === status.device.id, error: null });
  return currentDemoSync();
}
/** This computer becomes the main one; `others` is what happens to the rest. */
function demoBecomeHub(status: SyncStatus, others: (d: SyncDevice) => SyncDevice = (d) => d): SyncStatus {
  const devices = status.devices.map((d) => (d.id === status.device.id ? { ...d, is_hub: true, online: true } : others({ ...d, is_hub: false })));
  const device = devices.find((d) => d.id === status.device.id)!;
  return {
    ...status,
    devices,
    device,
    hub: device.id,
    is_hub: true,
    phase: { state: "online" },
    error: null,
    hub_change: null,
    last_sync_at: new Date().toISOString(),
  };
}
const noServer = () => {
  if (storedSupporter() === "no_server") throw new CommandError("network", "No connection", "no_connection");
};

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A page for the reading sheet of the preview (NP-123): long enough to scroll, about its own title; the description is its dek (NP-122). */
function demoArticle(b: Bookmark): string {
  const title = escapeHtml(b.title || b.domain);
  const about = escapeHtml(b.description ?? "");
  const picture = b.image_url?.startsWith("https:") ? `<figure><img src="${escapeHtml(b.image_url)}" alt=""></figure>` : "";
  const paragraphs = [
    `${title} is the page this bookmark was saved from.`,
    "A page in a browser comes with everything around the text: menus, banners, a cookie notice, the next article and the one after it. The reading sheet keeps the words and the pictures that belong to them, set in one column at a size that is easy to follow.",
    "The text is taken from the page when you open it. Nothing runs from the site itself: no scripts, no frames, no forms. Links still work and open in your browser, so a reference is one click away.",
    `If something looks wrong, the button at the top opens ${escapeHtml(b.domain)} in the browser as the site meant it. The bookmark stays where it was, with its collection, tags and notes.`,
    "Press the arrow keys to move between the selected bookmarks without closing the sheet, and Esc to go back to the list where you left it.",
    "Long articles keep their place: scroll half way, close the sheet, and the next time it opens it starts where you stopped. An article you have read to the end is marked as read.",
    `That is all there is to ${title}. The rest of the page — the parts that are not the article — stayed on the site.`,
  ];
  return `<!doctype html><html lang="en"><head><title>${title}</title>${about ? `<meta name="description" content="${about}">` : ""}</head><body><main><article><h1>${title}</h1>${picture}${paragraphs
    .map((text, i) => (i === 3 ? `<h2>Opening it in the browser</h2><p>${text}</p>` : `<p>${text}</p>`))
    .join("")}</article></main></body></html>`;
}

/** Capture speaks of the system the preview pretends to run on (NP-054). */
// A desktop with the system's own frame is a Mac's.
// `koonapin.demo.capture` = `failing`: the capture channel would not open, as the notification centre shows it;
// `connected`: Chrome saved a link a minute ago, as the sidebar shows a connected browser (the site's screenshots).
const demoConnected = (): Partial<CaptureStatus> => {
  const at = new Date(Date.now() - 60_000).toISOString();
  return {
    state: "connected",
    browsers: [{ browser: "chrome", last_seen: at, extension_version: "0.5.0", extension_protocol: 2, compatible: true, recent: true }],
    last_capture: { at, browser: "chrome" },
  };
};
const demoCapture = (): CaptureStatus => ({
  ...demoCaptureStatus,
  ...(storedValue("demo.capture") === "failing" ? { state: "failing" as const, problem: "channel" as const } : {}),
  ...(storedValue("demo.capture") === "connected" ? demoConnected() : {}),
  system: storedDesktop()?.linux ? "linux" : storedDesktop()?.native_frame ? "macos" : "windows",
});
const key = DEMO_STORAGE_KEY;
const stamp = (i: number) => new Date(Date.UTC(2026, 9, 2 - i, 12)).toISOString();
// The texts follow the interface's language when the library is created; a saved
// library keeps its own after a switch. Until the first change nothing is saved,
// so a reload creates it again in the current language.
const sample = demoLibrary(resolveLanguage(storedLanguage()));
/** The names the sample sites give themselves (`og:site_name`); none for some, whose cover shows the domain. */
const SITE_NAMES: Record<string, string> = {
  "vitsoe.com": "Vitsœ",
  "archdaily.com": "ArchDaily",
  "linear.app": "Linear",
  "unsplash.com": "Unsplash",
};
/** Sample bookmarks in Reading (NP-121): unread, the second one half read. */
const READING = [0, 2, 3];
let initial = {
  bookmarks: sample.bookmarks.map((b, i): Bookmark => ({
    id: b.id,
    url: b.url,
    title: b.title,
    description: b.description ?? null,
    image_url: posterOf(b),
    favicon_url: null,
    site_name: SITE_NAMES[b.domain] ?? null,
    domain: b.domain,
    notes: b.notes || null,
    is_favorite: b.favorite,
    collection_id: sample.collections.indexOf(b.collection) + 1,
    tags: b.tags,
    created_at: stamp(i),
    updated_at: stamp(i),
    revision: 1,
    triaged_at: b.inbox ? null : stamp(i),
    deleted_at: null,
    // Waiting ones came from a browser; triage says which (NP-025).
    source: b.inbox ? (i % 2 ? "firefox" : "chrome") : "import",
    reading_at: READING.includes(i) ? stamp(READING.indexOf(i)) : null,
    reading_progress: i === READING[1] ? 0.4 : 0,
    read_at: null,
    offline_at: null,
  })),
  collections: sample.collections.map((name, i): Collection => ({
    id: i + 1,
    name,
    color: null,
    icon: null,
    count: null,
    created_at: "2026-10-02T00:00:00.000Z",
  })),
};
try {
  const saved = JSON.parse(localStorage.getItem(key) || "null");
  if (saved?.bookmarks && saved?.collections) initial = saved;
} catch {
  /* Recover a corrupted preview only; never accesses the desktop DB. */
}
// Saved before NP-025, without source; before NP-121, without Reading.
let bookmarks: Bookmark[] = initial.bookmarks.map((b) => ({
  ...b,
  source: b.source ?? null,
  reading_at: b.reading_at ?? null,
  reading_progress: b.reading_progress ?? 0,
  read_at: b.read_at ?? null,
  // The preview keeps offline copies in memory only (NP-126): none survive a reload.
  offline_at: null,
}));
let collections: Collection[] = initial.collections;
/** The highest collection id handed out: like AUTOINCREMENT, a deleted one is not reused. */
let lastCollection = 0;
const nextCollection = () => {
  lastCollection = Math.max(lastCollection, ...collections.map((c) => c.id)) + 1;
  return lastCollection;
};
/** Offline copies of the preview (NP-126), by bookmark: this session only, never in localStorage. */
const copies = new Map<number, OfflineCopyContent>();
/** `offline_at` follows the copy, as the database's join does: no new revision, no command of the journal. */
function setOffline(b: Bookmark, offlineAt: string | null): Bookmark {
  const next = { ...b, offline_at: offlineAt };
  bookmarks = bookmarks.map((item) => (item.id === b.id ? next : item));
  persist();
  emit("updated", next);
  return next;
}
/** A bookmark deleted for good takes its copy with it, as the desktop app's sweep does. */
const sweepCopies = () => {
  const kept = new Set(bookmarks.map((b) => b.id));
  for (const id of copies.keys()) if (!kept.has(id)) copies.delete(id);
};
/** Everything outside the trash: what the library, its counts and catalogs show. */
const live = () => bookmarks.filter((b) => !b.deleted_at);
/** A stored change with a new revision, like an UPDATE in the desktop app. */
function change(previous: Bookmark, fields: Partial<Bookmark>): Bookmark {
  const b = { ...previous, ...fields, revision: (previous.revision ?? 1) + 1, updated_at: new Date().toISOString() };
  bookmarks = bookmarks.map((item) => (item.id === b.id ? b : item));
  persist();
  return b;
}
/** The command journal of `journal.rs`: this session only, the last 100, undone field by field. */
const JOURNAL_LIMIT = 100;
// `url` and `domain`: «Заменить адрес» (NP-036).
// Reading (NP-121): sending, taking out, marking read.
const FIELDS = [
  "url",
  "domain",
  "title",
  "notes",
  "is_favorite",
  "collection_id",
  "tags",
  "triaged_at",
  "deleted_at",
  "created_at",
  "reading_at",
  "reading_progress",
  "read_at",
] as const;
type Fields = Pick<Bookmark, (typeof FIELDS)[number]>;
type Command = { id: number; action: CommandAction; changes: { id: number; before: Fields; after: Fields }[] };
let journal: Command[] = [];
let lastCommand = 0;
/** «Не дубликаты» (NP-035): bookmarks of a group set aside, this session only. */
const dismissed = new Map<string, Set<number>>();
const fieldsOf = (b: Bookmark): Fields => Object.fromEntries(FIELDS.map((f) => [f, b[f]])) as Fields;
/** The order of tags means nothing. */
const same = (field: keyof Fields, a: Fields, b: Fields) =>
  field === "tags" ? [...(a.tags ?? [])].sort().join("\n") === [...(b.tags ?? [])].sort().join("\n") : a[field] === b[field];
const touched = (step: Command["changes"][number]) => FIELDS.filter((f) => !same(f, step.before, step.after));
/** Bookmarks the kept commands may hold together (`CHANGE_LIMIT`); the newest command stays. */
const JOURNAL_CHANGES = 50_000;
function remember(action: CommandAction, changes: Command["changes"]): number | null {
  const steps = changes.filter((step) => touched(step).length > 0);
  if (steps.length === 0) return null;
  journal = [...journal, { id: ++lastCommand, action, changes: steps }].slice(-JOURNAL_LIMIT);
  let held = journal.reduce((sum, c) => sum + c.changes.length, 0);
  while (held > JOURNAL_CHANGES && journal.length > 1) held -= journal.shift()!.changes.length;
  return lastCommand;
}
function record(action: CommandAction, previous: Bookmark, b: Bookmark): Changed {
  return { bookmark: b, command: remember(action, [{ id: b.id, before: fieldsOf(previous), after: fieldsOf(b) }]) };
}
/** What `update_bookmark` calls the change, for the undo notice. */
function actionOf(data: Partial<Fields>): CommandAction {
  const keys = Object.keys(data).filter((k) => data[k as keyof Fields] !== undefined);
  if (keys.length === 0) return "keep";
  if (keys.length === 1 && keys[0] === "is_favorite") return "favorite";
  if (keys.length === 1 && keys[0] === "tags") return "tag";
  if (keys.length === 1 && keys[0] === "collection_id") return "move";
  return "edit";
}
const listeners = new Set<(change: BookmarkChange) => void>();
const batchListeners = new Set<(changes: BookmarkChange[]) => void>();
const invalidations = new Set<() => void>();
const duplicateListeners = new Set<() => void>();
const progressListeners = new Set<(progress: ImportProgress) => void>();

type DemoListItem = { url: string; title: string | null; description: string | null; tags: string[]; sections: string[] };
type DemoList = {
  title: string;
  version: string;
  newer: boolean;
  links: DemoListItem[];
  feeds: DemoListItem[];
  sections: number;
  repeated: number;
  not_web: number;
  invalid: number;
  skipped_items: number;
  raw: Record<string, unknown>;
};

/** An http(s) address with a host, or null: the list's own links (author, homepage) are dropped otherwise. */
const demoWebUrl = (value: unknown) => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname ? url.href : null;
  } catch {
    return null;
  }
};

/** `dedupe::url_key`, roughly: host without `www.`, no fragment, no `utm_` parameters, no trailing slash. */
function demoUrlKey(href: string) {
  const url = new URL(href);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return `${host}${url.port ? `:${url.port}` : ""}${url.pathname.replace(/\/+$/, "")}${url.search}`;
}

/**
 * Preview only: `lists/format.rs` in the browser, by its cheap rules — the envelope and version,
 * 2 MB, 5,000 items and 200 sections refused rather than cut, empty only without items, http(s)
 * links with a host, a repeated address (by a rough `url_key`) merged into the first with its
 * tags, unknown item types counted. The desktop app's reader is the one that counts.
 */
export function demoList(text: string): DemoList | Exclude<ListCheck, { outcome: "ready" }> {
  if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) return { outcome: "too_big" };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch {
    return { outcome: "not_a_list" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.format !== "koona") return { outcome: "not_a_list" };
  if (raw.app !== "pin") return typeof raw.app === "string" ? { outcome: "other_app", app: raw.app } : { outcome: "not_a_list" };
  const version = /^(\d+)\.(\d+)$/.exec(String(raw.version ?? ""));
  if (!version) return { outcome: "not_a_list" };
  const [major, minor] = [Number(version[1]), Number(version[2])];
  if (raw.kind !== "list" || major > 1) return { outcome: "needs_newer_app" };
  const title = typeof raw.title === "string" ? raw.title.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  if (major !== 1 || !title) return { outcome: "not_a_list" };
  const sections = Array.isArray(raw.sections) ? (raw.sections as Record<string, unknown>[]) : [];
  if (sections.length > 200) return { outcome: "too_big" };
  const groups: [string | null, Record<string, unknown>[]][] = [
    ...sections.map((section): [string | null, Record<string, unknown>[]] => [
      typeof section?.name === "string" && section.name.trim() ? section.name.trim().slice(0, 120) : null,
      Array.isArray(section?.items) ? section.items : [],
    ]),
    [null, Array.isArray(raw.items) ? (raw.items as Record<string, unknown>[]) : []],
  ];
  const total = groups.reduce((sum, [, items]) => sum + items.length, 0);
  if (total > 5000) return { outcome: "too_big" };
  if (total === 0) return { outcome: "empty" };
  const list: DemoList = { title, version: `${major}.${minor}`, newer: minor > 0, links: [], feeds: [], sections: groups.filter(([name]) => name !== null).length, repeated: 0, not_web: 0, invalid: 0, skipped_items: 0, raw };
  const links = new Map<string, DemoListItem>();
  const feeds = new Set<string>();
  const tagsOf = (item: Record<string, unknown>) =>
    [...new Set((Array.isArray(item.tags) ? item.tags : []).filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim().toLowerCase().slice(0, 64)).filter(Boolean))].slice(0, 20);
  for (const [section, items] of groups) {
    for (const item of items) {
      if (item?.type !== "link" && item?.type !== "feed") {
        list.skipped_items++;
        continue;
      }
      const given = typeof item.url === "string" ? item.url.trim() : "";
      if (!given) {
        list.invalid++;
        continue;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(given) && !/^https?:/i.test(given)) {
        list.not_web++;
        continue;
      }
      const url = demoWebUrl(given);
      if (!url) {
        list.invalid++;
        continue;
      }
      const entry = {
        url,
        title: typeof item.title === "string" ? item.title.trim().slice(0, 300) || null : null,
        description: typeof item.description === "string" ? item.description.trim().slice(0, 1000) || null : null,
        tags: tagsOf(item),
        sections: section ? [section] : [],
      };
      if (item.type === "feed") {
        if (feeds.has(url)) list.repeated++;
        else {
          feeds.add(url);
          list.feeds.push(entry);
        }
        continue;
      }
      const key = demoUrlKey(url);
      const first = links.get(key);
      if (first) {
        // As format.rs: the repeat's tags and section join the first.
        first.tags = [...new Set([...first.tags, ...entry.tags])].slice(0, 20);
        if (section && !first.sections.includes(section)) first.sections.push(section);
        list.repeated++;
        continue;
      }
      links.set(key, entry);
      list.links.push(entry);
    }
  }
  return list;
}
const demoListDownloads = new Set<(progress: ListDownloadProgress) => void>();
function persist() {
  localStorage.setItem(key, JSON.stringify({ bookmarks, collections }));
}
const changeOf = (kind: BookmarkChange["kind"], b: Bookmark): BookmarkChange => ({
  kind,
  id: b.id,
  revision: b.revision ?? 1,
  bookmark: kind === "deleted" ? null : b,
});
function emit(kind: BookmarkChange["kind"], b: Bookmark) {
  for (const fn of listeners) fn(changeOf(kind, b));
}
/** `bookmarks-changed`: many at once in one event, one as `bookmark-changed` (`capture::emit_many`). */
function emitMany(kind: BookmarkChange["kind"], list: Bookmark[]) {
  if (list.length === 1) return emit(kind, list[0]);
  if (list.length === 0) return;
  const changes = list.map((b) => changeOf(kind, b));
  for (const fn of batchListeners) fn(changes);
}
/** What a bulk action writes to `b`, or nothing when it already holds it (`db::bulk_in`). */
function bulkFields(b: Bookmark, change: BulkChange, collectionId: number | null, now: string): Partial<Bookmark> | null {
  const sorted = { triaged_at: b.triaged_at ?? now };
  switch (change.action) {
    case "move":
    case "new_collection":
      return b.collection_id === collectionId && b.triaged_at ? null : { collection_id: collectionId, ...sorted };
    case "tag": {
      const name = change.name.trim().toLowerCase();
      const has = (b.tags ?? []).includes(name);
      return has && b.triaged_at ? null : { tags: has ? b.tags : [...(b.tags ?? []), name], ...sorted };
    }
    case "favorite":
      return b.is_favorite === change.favorite && b.triaged_at ? null : { is_favorite: change.favorite, ...sorted };
    case "trash":
      return { deleted_at: now };
    case "restore":
      return { deleted_at: null };
    // Reading is no decision: the inbox keeps a bookmark sent from it.
    case "reading":
      if (change.reading)
        return b.reading_at ? null : { reading_at: now, read_at: null, reading_progress: b.read_at ? 0 : b.reading_progress };
      return b.reading_at ? { reading_at: null } : null;
    case "read":
      if (change.read) return b.read_at ? null : { read_at: now, reading_progress: 1 };
      return b.read_at || b.reading_progress > 0 ? { read_at: null, reading_progress: 0 } : null;
  }
}
/** A JSON copy as the demo reads it: the format, the version, the lists and every address (`restore.rs` checks more). */
type CopyBookmark = {
  uid: string; url: string; title: string; description?: string | null; notes?: string | null; domain?: string;
  image_url?: string | null; favicon_url?: string | null; site_name?: string | null; is_favorite?: boolean; collection?: string | null; tags?: string[];
  source?: Bookmark["source"]; created_at: string; updated_at: string; triaged_at?: string | null; deleted_at?: string | null;
  reading_at?: string | null; reading_progress?: number; read_at?: string | null;
};
type Copy = {
  exported_at: string;
  collections: { uid: string; name: string; color?: string | null; icon?: string | null; created_at: string }[];
  tags: { uid: string; name: string }[];
  bookmarks: CopyBookmark[];
};
function readCopy(content: string): Copy | RestoreProblem {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(content.replace(/^﻿/, ""));
  } catch {
    return { problem: "not_json" };
  }
  if (value?.format !== "koona-pin" || typeof value.version !== "number") return { problem: "not_ours" };
  if (value.version > 1) return { problem: "newer", version: value.version };
  const copy = value as unknown as Copy;
  if (!Array.isArray(copy.bookmarks) || !Array.isArray(copy.collections) || !Array.isArray(copy.tags))
    return { problem: "damaged", item: "file", index: 0, damage: "structure", detail: "bookmarks, collections or tags missing" };
  for (const [i, b] of copy.bookmarks.entries()) {
    let ok = false;
    try {
      ok = ["http:", "https:"].includes(new URL(b.url).protocol);
    } catch {
      /* Not an address. */
    }
    if (!ok) return { problem: "damaged", item: "bookmark", index: i + 1, damage: "bad_address", detail: String(b.url ?? "") };
  }
  return copy;
}
/**
 * Link check (NP-036) in the browser preview: no request leaves the page.
 * Each address gets a made-up answer from its own text, so the demo and its
 * tests always see the same groups. Results live for this session only.
 */
type LinkResult = {
  url: string;
  outcome: "ok" | "gone" | "moved" | "failed" | "local";
  status: number | null;
  reason: LinkFailure | null;
  target: string | null;
  checked_at: string;
};
const linkResults = new Map<number, LinkResult>();
const linkListeners = new Set<(progress: LinkCheckProgress) => void>();
let linkRun: { timer: number; queue: number[]; done: number; total: number; whole: boolean } | null = null;
let linkLast: LinkCheckProgress | null = null;
/** When the check of the whole library under way, or stopped, began; when the last one ended. */
let linkStarted: string | null = null;
let linkFinished: string | null = null;
/** The bookmarks of the last «Проверить снова» on a group: «Продолжить» after a stop checks them. */
let linkScope: number[] | null = null;
const LINK_STEP_MS = 40;

/** The answer the demo pretends a site gave. */
export function demoAnswer(url: string): Omit<LinkResult, "url" | "checked_at"> {
  const none = { status: null, reason: null, target: null };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { outcome: "local", ...none };
  }
  const host = parsed.hostname;
  if (host === "localhost" || host.endsWith(".local") || /^(127|10)\.|^192\.168\./.test(host)) return { outcome: "local", ...none };
  const hash = [...url].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) >>> 0, 7) % 12;
  switch (hash) {
    case 0:
      return { outcome: "gone", status: 404, reason: null, target: null };
    case 1:
      return { outcome: "gone", status: 410, reason: null, target: null };
    case 2: {
      const target = new URL(parsed);
      target.pathname = `/moved${parsed.pathname}`;
      return { outcome: "moved", status: 301, reason: null, target: target.toString() };
    }
    case 3:
      return { outcome: "failed", status: null, reason: "timeout", target: null };
    case 4:
      return { outcome: "failed", status: 503, reason: "status", target: null };
    default:
      return { outcome: "ok", status: 200, reason: null, target: null };
  }
}
/** The result still describes the bookmark: same address, or the one the page moved to after «Заменить адрес». */
const holds = (r: LinkResult, b: Bookmark) => r.url === b.url || (r.outcome === "moved" && r.target === b.url);
function linkReport(): LinkCheckReport {
  const library = live();
  const group = (outcome: LinkResult["outcome"]): CheckedLink[] =>
    library
      .flatMap((b) => {
        const r = linkResults.get(b.id);
        return r && r.url === b.url && r.outcome === outcome
          ? [{ bookmark: b, status: r.status, reason: r.reason, target: r.target, checked_at: r.checked_at, conflict: !!r.target && bookmarks.some((x) => x.url === r.target) }]
          : [];
      })
      .sort((a, b) => b.checked_at.localeCompare(a.checked_at) || a.bookmark.id - b.bookmark.id);
  const valid = library.filter((b) => {
    const r = linkResults.get(b.id);
    return r && holds(r, b);
  });
  const now = (b: Bookmark) => {
    const r = linkResults.get(b.id)!;
    return r.url === b.url ? r.outcome : "ok";
  };
  const left = linkStarted ? leftToCheck(linkStarted).length : 0;
  return {
    state: linkRun ? "running" : (linkLast?.state ?? (linkStarted ? "stopped" : "idle")),
    done: linkLast && linkLast.state !== "idle" ? linkLast.done : linkStarted ? library.length - left : 0,
    total: linkLast && linkLast.state !== "idle" ? linkLast.total : linkStarted ? library.length : 0,
    eta_seconds: linkRun ? (linkLast?.eta_seconds ?? null) : null,
    finished_at: linkFinished,
    library: library.length,
    open: valid.filter((b) => now(b) === "ok").length,
    local: valid.filter((b) => now(b) === "local").length,
    unchecked: library.length - valid.length,
    gone: group("gone"),
    moved: group("moved"),
    failed: group("failed"),
  };
}
/** «Проверка ссылок N»: links that do not open or moved. */
function linksToDecide(): number {
  const report = linkReport();
  return report.gone.length + report.moved.length;
}
/** What the run started at `since` has left, those never checked first. */
function leftToCheck(since: string): number[] {
  return live()
    .filter((b) => {
      const r = linkResults.get(b.id);
      return !(r && holds(r, b) && r.checked_at >= since);
    })
    .sort((a, b) => (linkResults.get(a.id)?.checked_at ?? "").localeCompare(linkResults.get(b.id)?.checked_at ?? "") || a.id - b.id)
    .map((b) => b.id);
}
function linkProgress(state: LinkCheckState, written: boolean) {
  const run = linkRun;
  const progress: LinkCheckProgress = {
    state,
    done: run?.done ?? linkLast?.done ?? 0,
    total: run?.total ?? linkLast?.total ?? 0,
    eta_seconds: run && state === "running" ? Math.ceil(((run.total - run.done) * LINK_STEP_MS) / 1000) : null,
    written,
    error: null,
  };
  linkLast = progress;
  for (const fn of linkListeners) fn(progress);
}

/** «Refresh previews» for many (`refresh.rs`): the demo reads no pages, it walks the bookmarks with a pause. */
const refreshListeners = new Set<(progress: PreviewRefresh) => void>();
const refreshIdle: PreviewRefresh = { started_at: null, state: "idle", done: 0, total: 0, updated: 0, unchanged: 0, failed: 0, check_ids: [] };
let refreshLast: PreviewRefresh = refreshIdle;
let refreshRun: { timer: number; queue: number[]; seen: Set<number>; failed: number[]; streak: number } | null = null;
/** The pause per bookmark; a test sets `koonapin.demo.refreshStep` to slow it down or speed it up. */
function refreshStep(): number {
  try {
    return Number(localStorage.getItem("koonapin.demo.refreshStep")) || 120;
  } catch {
    return 120;
  }
}
/** A test sets `koonapin.demo.offline` to see the run stop with «no network». */
function demoOffline(): boolean {
  try {
    return localStorage.getItem("koonapin.demo.offline") === "1";
  } catch {
    return false;
  }
}
const missingPreview = (b: Bookmark) => !b.image_url || !b.site_name;
/** What the demo pretends the page gave: most give something new, some nothing, a few do not open. */
function demoRefresh(url: string): "updated" | "unchanged" | "failed" {
  const hash = [...url].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) >>> 0, 11) % 8;
  return hash === 0 ? "failed" : hash < 3 ? "unchanged" : "updated";
}
function refreshProgress(progress: PreviewRefresh) {
  refreshLast = progress;
  for (const fn of refreshListeners) fn(progress);
}
/**
 * `refresh::start`: one run at a time. While one runs, its state; with `append` (an import) the
 * new ones join it first. Pages it could not open go to the link check once it is done, after a
 * check under way.
 */
function startDemoRefresh(ids: number[], append: boolean): PreviewRefresh {
  if (refreshRun) {
    if (append) {
      const fresh = [...new Set(ids)].filter((id) => !refreshRun!.seen.has(id));
      fresh.forEach((id) => refreshRun!.seen.add(id));
      refreshRun.queue.push(...fresh);
      if (fresh.length) refreshProgress({ ...refreshLast, total: refreshLast.total + fresh.length });
    }
    return refreshLast;
  }
  const queue = [...new Set(ids)];
  const run = { timer: 0, queue, seen: new Set(queue), failed: [] as number[], streak: 0 };
  refreshRun = run;
  refreshProgress({ ...refreshIdle, started_at: new Date().toISOString(), state: "running", total: queue.length });
  const finish = (state: PreviewRefresh["state"], last: PreviewRefresh) => {
    window.clearInterval(run.timer);
    refreshRun = null;
    const check = state === "done" ? run.failed : [];
    refreshProgress({ ...last, state, check_ids: check });
    if (check.length) {
      const handOff = () => (linkRun ? window.setTimeout(handOff, 200) : void demo.startLinkCheck(check, false));
      handOff();
    }
  };
  if (queue.length === 0) {
    finish("done", refreshLast);
    return refreshLast;
  }
  run.timer = window.setInterval(() => {
    const id = run.queue.shift();
    const b = live().find((item) => item.id === id);
    const now = { ...refreshLast, done: refreshLast.done + 1 };
    if (demoOffline()) {
      run.streak++;
      now.failed++;
      if (run.streak >= 5) return finish("offline", { ...now, failed: now.failed - run.streak });
    } else {
      run.streak = 0;
      const outcome = b ? demoRefresh(b.url) : "unchanged";
      if (outcome === "updated") now.updated++;
      else if (outcome === "unchanged") now.unchanged++;
      else {
        now.failed++;
        if (id !== undefined) run.failed.push(id);
      }
      if (b && outcome === "updated") emit("updated", b);
    }
    if (run.queue.length === 0) return finish("done", now);
    refreshProgress(now);
  }, refreshStep());
  return refreshLast;
}

/** The order a list is read in, as `db::BookmarkQuery::order`: the trash and Reading keep their own. */
const listOrder = (filters: Partial<FilterState>, sort: BookmarkSort): ListOrder => ({
  sort: orderOf(sort, !!filters.onlyTrash || !!filters.onlyReading),
  language: i18n.language,
  reading: !!filters.onlyReading,
});

// feeds — the preview's feeds (NP-128): the five subscriptions and twenty posts of demoFeeds.ts,
// kept in localStorage like the sample library. Later feeds tasks add here only.
/**
 * `koonapin.demo.feeds`: `empty` follows nothing, `offline` has the last check find no connection,
 * `failing` has Ars Technica not updating for nine days. Without the key every feed is fine.
 */
export const DEMO_FEEDS_KEY = "koonapin.demo.feeds";
const DEMO_FEEDS_STATE_KEY = "koonapin.demo.feeds.v1";
const DEMO_FEEDS_REFRESH_KEY = "koonapin.demo.feedsRefreshMinutes";
interface DemoFeedRow {
  uid: string;
  url: string;
  title: string | null;
  destination: FeedDestination;
}
interface DemoItemRow {
  id: number;
  feed_uid: string;
  url: string | null;
  title: string;
  author: string | null;
  excerpt: string;
  thumbnail_url: string | null;
  published_at: string;
  fetched_at: string;
  read_at: string | null;
  /** The bookmark the post was saved as, as the cache's `bookmark_uid`. */
  bookmark_id: number | null;
  html: string;
  full: boolean;
}
interface DemoFeedsState {
  feeds: DemoFeedRow[];
  items: DemoItemRow[];
  fetched_at: string;
}
const hoursBefore = (hours: number, from = Date.now()) => new Date(from - hours * 3_600_000).toISOString();
/** The posts as a first fetch leaves them: those older than 7 days already read (plan §3.2). */
function demoFeedItems(fetchedAt: string): DemoItemRow[] {
  return DEMO_POSTS.map((post) => {
    const feed = DEMO_FEEDS.find((f) => f.uid === post.feed)!;
    return {
      id: post.id,
      feed_uid: post.feed,
      url: postUrl(feed, post),
      title: post.title,
      author: post.author,
      excerpt: post.excerpt,
      thumbnail_url: pictureOf(post),
      published_at: hoursBefore(post.hoursAgo),
      fetched_at: fetchedAt,
      read_at: post.read || post.hoursAgo > 7 * 24 ? fetchedAt : null,
      bookmark_id: null,
      html: postHtml(post),
      full: isFull(post),
    };
  });
}
function initialFeedsState(): DemoFeedsState {
  const fetchedAt = hoursBefore(2 / 60);
  if (demoSwitch(DEMO_FEEDS_KEY) === "empty") return { feeds: [], items: [], fetched_at: fetchedAt };
  return {
    feeds: DEMO_FEEDS.map((f) => ({ uid: f.uid, url: f.url, title: null, destination: f.destination })),
    items: demoFeedItems(fetchedAt),
    fetched_at: fetchedAt,
  };
}
let demoFeedsState: DemoFeedsState | null = null;
function feedsState(): DemoFeedsState {
  if (!demoFeedsState) {
    try {
      const saved = JSON.parse(localStorage.getItem(DEMO_FEEDS_STATE_KEY) || "null") as DemoFeedsState | null;
      demoFeedsState = saved?.feeds && saved?.items ? saved : initialFeedsState();
    } catch {
      demoFeedsState = initialFeedsState();
    }
  }
  return demoFeedsState;
}
const feedListeners = new Set<(change: FeedsChanged) => void>();
const feedRefreshListeners = new Set<(progress: FeedsRefresh) => void>();
/** The feed's own title and site, as the cache would know them after a fetch. */
function demoFeedSite(url: string): { title: string; site: string } {
  const known = DEMO_FEEDS.find((f) => f.url === url);
  if (known) return { title: known.feedTitle, site: known.siteUrl };
  const extra = DEMO_SITES.find((s) => s.feeds.some((f) => f.url === url));
  const feed = extra?.feeds.find((f) => f.url === url);
  if (extra && feed) return { title: feed.title, site: extra.site };
  const parsed = new URL(url);
  return { title: parsed.hostname.replace(/^www\./, ""), site: `${parsed.origin}/` };
}
function demoFeedHealth(uid: string): FeedHealth {
  const state = demoSwitch(DEMO_FEEDS_KEY);
  if (state === "offline") return { state: "offline" };
  if (state === "failing" && uid === "demo-feed-ars") return { state: "failing", since: hoursBefore(9 * 24), reason: "timeout" };
  return { state: "ok" };
}
function demoFeedList(): Feed[] {
  const { feeds, items, fetched_at } = feedsState();
  return feeds.map((row) => {
    const posts = items.filter((item) => item.feed_uid === row.uid);
    const site = demoFeedSite(row.url);
    return {
      uid: row.uid,
      url: row.url,
      title: row.title,
      feed_title: site.title,
      site_url: site.site,
      icon_url: null,
      destination: row.destination,
      unread: posts.filter((item) => !item.read_at).length,
      total: posts.length,
      fetched_at: posts.length ? fetched_at : null,
      // The demo's posts all came in the one fetch.
      newest_at: posts.length ? fetched_at : null,
      health: demoFeedHealth(row.uid),
    };
  });
}
/** Stored, then `feeds-changed` with every subscription, as the app emits it. */
function feedsChanged() {
  try {
    localStorage.setItem(DEMO_FEEDS_STATE_KEY, JSON.stringify(feedsState()));
  } catch {
    /* The preview keeps its feeds for this session only. */
  }
  const feeds = demoFeedList();
  for (const fn of feedListeners) fn({ feeds });
}
function demoFeedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new CommandError("invalid_request", "Not a valid link", "invalid_url");
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new CommandError("invalid_request", "Only HTTP and HTTPS feeds are followed", "unsupported_url");
  if (/^(localhost|127\.|10\.|192\.168\.)|\.local$/.test(url.hostname))
    throw new CommandError("invalid_request", "Feeds on this computer or the local network are not followed", "unsupported_url");
  return url;
}
/** The post's bookmark while it is out of the trash. */
const savedBookmark = (item: DemoItemRow) =>
  item.bookmark_id === null ? undefined : bookmarks.find((b) => b.id === item.bookmark_id && !b.deleted_at);
const feedItemOf = (item: DemoItemRow): FeedItem => ({
  id: item.id,
  feed_uid: item.feed_uid,
  url: item.url,
  title: item.title,
  author: item.author,
  excerpt: item.excerpt,
  thumbnail_url: item.thumbnail_url,
  published_at: item.published_at,
  fetched_at: item.fetched_at,
  read: item.read_at !== null,
  bookmark_id: savedBookmark(item)?.id ?? null,
  full: item.full,
});
/** `FeedItemPage::next`: `published_at|id` of the last post of a page. */
const feedCursor = (item: DemoItemRow) => `${item.published_at}|${item.id}`;
/** Listed after the cursor, newest first. */
function afterCursor(item: DemoItemRow, cursor: string): boolean {
  const at = cursor.lastIndexOf("|");
  const [published, id] = [cursor.slice(0, at), Number(cursor.slice(at + 1))];
  return item.published_at < published || (item.published_at === published && item.id < id);
}
const newestFirst = (a: DemoItemRow, b: DemoItemRow) =>
  b.published_at.localeCompare(a.published_at) || b.id - a.id;
const isFeedAddress = (url: URL) => /(\/(feed|rss|atom)(\.xml|\.json)?\/?|\.xml|\.rss|feed\.json)$/i.test(url.pathname);
/**
 * Sites the preview doesn't follow (NP-133), for «Follow» in «New link»: one with a feed,
 * one with posts and comments, one whose feed can't be read. Their pages have a title and a picture.
 */
interface DemoSite {
  site: string;
  name: string;
  picture: [string, string, string];
  feeds: { url: string; title: string }[];
  unreadable?: boolean;
  perDay: number;
  /** The posts a first fetch brings. */
  posts: { title: string; excerpt: string; hoursAgo: number }[];
}
const DEMO_SITES: DemoSite[] = [
  {
    site: "https://fieldnotes.example.com/",
    name: "Field Notes",
    picture: ["#55705a", "#1f2d22", "Notes"],
    feeds: [{ url: "https://fieldnotes.example.com/feed.xml", title: "Field Notes" }],
    perDay: 4.2,
    posts: [
      { title: "Walking the old railway line in late autumn", excerpt: "Twelve miles of cinder path, two viaducts and a tea room that is open on Sundays only.", hoursAgo: 2 },
      { title: "A notebook that survives the rain", excerpt: "Pencil, waxed covers and a rubber band: the field kit that has not changed in forty years.", hoursAgo: 7 },
    ],
  },
  {
    site: "https://smallbatch.example.com/",
    name: "Small Batch",
    picture: ["#a0523d", "#4a2018", "Batch"],
    feeds: [
      { url: "https://smallbatch.example.com/posts.rss", title: "Small Batch" },
      { url: "https://smallbatch.example.com/comments.rss", title: "Small Batch — comments" },
    ],
    perDay: 0.4,
    posts: [{ title: "Marmalade with the whole fruit", excerpt: "Boil the oranges whole first, then chop: less work, a softer peel.", hoursAgo: 30 }],
  },
  {
    site: "https://quiet.example.com/",
    name: "Quiet Corner",
    picture: ["#6a6f8a", "#272a3a", "Quiet"],
    feeds: [{ url: "https://quiet.example.com/rss", title: "Quiet Corner" }],
    unreadable: true,
    perDay: 1,
    posts: [],
  },
];
const demoSiteOf = (url: URL) => DEMO_SITES.find((s) => new URL(s.site).hostname === url.hostname);
/** A page's title as its `<title>` would read: the site's name, or the last part of the path. */
function demoPageTitle(site: DemoSite, url: URL): string {
  const last = url.pathname.split("/").filter(Boolean).pop();
  if (!last) return site.name;
  const words = decodeURIComponent(last).replace(/\.[a-z]+$/i, "").replace(/[-_]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
/** The posts of a demo site's feed, as its first fetch leaves them. */
function demoSitePosts(uid: string, url: string, startId: number): DemoItemRow[] {
  const site = DEMO_SITES.find((s) => s.feeds.some((f) => f.url === url));
  const fetchedAt = new Date().toISOString();
  return (site?.posts ?? []).map((post, i) => ({
    id: startId + i,
    feed_uid: uid,
    url: `${site!.site}demo/${post.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    title: post.title,
    author: null,
    excerpt: post.excerpt,
    thumbnail_url: i === 0 ? poster(site!.picture) : null,
    published_at: hoursBefore(post.hoursAgo),
    fetched_at: fetchedAt,
    read_at: null,
    bookmark_id: null,
    html: `<p>${post.excerpt}</p>`,
    full: false,
  }));
}
// end feeds

/** The demo's download tickets, as Rust hands them out. */
let demoTicket = 0;

export const demo = {
  async getBookmarks(
    filters: Partial<FilterState> = {},
    page: PageRequest = {},
  ): Promise<BookmarkPage> {
    // The preview has no sort keys: titles and sites compare by the language's collator.
    const order = listOrder(filters, page.sort ?? "newest");
    const found = sortBookmarks(
      bookmarks.filter(
        (b) =>
          (page.id === undefined || b.id === page.id) &&
          matchesBookmark(b, filters),
      ),
      order,
    );
    const rest = page.after
      ? found.filter((b) => isAfter(b, page.after!, order))
      : found;
    const items = rest.slice(0, page.limit ?? 100);
    const last = items.at(-1);
    return {
      items,
      total: page.after ? null : found.length,
      next:
        last && rest.length > items.length
          ? cursorAt(last, order)
          : null,
      since_counts:
        page.since && !page.after
          ? page.since.map(
              (start) => found.filter((b) => listTime(b) >= start).length,
            )
          : null,
    };
  },
  async getBookmarkIds(filters: Partial<FilterState> = {}, sort: BookmarkSort = "newest"): Promise<number[]> {
    const order = listOrder(filters, sort);
    return sortBookmarks(bookmarks.filter((b) => matchesBookmark(b, filters)), order).map((b) => b.id);
  },
  async rebuildSearchIndex() {
    return bookmarks.length;
  },
  async getCollections() {
    return collections.map((c) => ({
      ...c,
      count: live().filter((b) => b.collection_id === c.id).length,
    }));
  },
  async getTags() {
    return [...new Set(live().flatMap((b) => b.tags ?? []))].map(
      (name, i) => ({
        id: i + 1,
        name,
        count: live().filter((b) => b.tags?.includes(name)).length,
      }),
    );
  },
  async getDomains() {
    return [...new Set(live().map((b) => b.domain))].map((domain) => ({
      domain,
      count: live().filter((b) => b.domain === domain).length,
    }));
  },
  async suggestCollection(id: number) {
    const b = bookmarks.find((item) => item.id === id);
    return b ? suggestFrom(bookmarks, b) : null;
  },
  async getCounts() {
    const inbox = live().filter((b) => b.triaged_at === null);
    return {
      total: live().length,
      favorites: live().filter((b) => b.is_favorite).length,
      inbox: inbox.length,
      inbox_newest: inbox.reduce<string | null>((newest, b) => (newest === null || b.created_at > newest ? b.created_at : newest), null),
      inbox_imported: inbox.filter((b) => b.source === "import" || b.source === "list").length,
      trash: bookmarks.length - live().length,
      duplicates: groupsOf(bookmarks, dismissed).length,
      links: linksToDecide(),
      reading: live().filter((b) => b.reading_at).length,
      reading_unread: live().filter((b) => b.reading_at && !b.read_at).length,
      offline: live().filter((b) => b.offline_at).length,
    };
  },
  async addBookmark(
    data: {
      url: string;
      title?: string;
      collectionId?: number | null;
      tags?: string[];
    },
  ): Promise<AddedLink> {
    let url: URL;
    try {
      url = new URL(data.url.trim());
    } catch {
      throw new CommandError("invalid_request", "Not a valid link", "invalid_url");
    }
    if (!["http:", "https:"].includes(url.protocol))
      throw new CommandError("invalid_request", "Only HTTP and HTTPS links are supported", "unsupported_url");
    const previous = bookmarks.find((b) => b.url === data.url.trim());
    if (previous?.deleted_at) {
      // Saved again from the trash: back with its fields, waiting in the inbox.
      const back = change(previous, { deleted_at: null, triaged_at: null });
      emit("created", back);
      return { bookmark: back, restored: true, existing: false };
    }
    if (previous) return { bookmark: previous, restored: false, existing: true };
    const b: Bookmark = {
      // Unique even for links added within the same millisecond.
      id: Math.max(Date.now(), ...bookmarks.map((item) => item.id + 1)),
      url: data.url.trim(),
      title: data.title?.trim() || url.hostname,
      description: null,
      image_url: null,
      favicon_url: null,
      site_name: null,
      notes: null,
      domain: url.hostname.replace(/^www\./, ""),
      collection_id: data.collectionId ?? null,
      tags: data.tags ?? [],
      is_favorite: false,
      reading_at: null,
      reading_progress: 0,
      read_at: null,
      offline_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      revision: 1,
      triaged_at: null,
      deleted_at: null,
      source: "app",
    };
    bookmarks = [b, ...bookmarks];
    persist();
    emit("created", b);
    // The app reads the page and updates the bookmark, found or not; the demo
    // reads none, but answers the same way, so the preview stops waiting (NP-087).
    window.setTimeout(() => {
      const now = bookmarks.find((item) => item.id === b.id);
      if (now && now.revision === 1) emit("updated", change(now, {}));
    }, 600);
    return { bookmark: b, restored: false, existing: false };
  },
  async updateBookmark(
    id: number,
    data: {
      title?: string;
      notes?: string;
      is_favorite?: boolean;
      collection_id?: number | null;
      tags?: string[];
    },
  ) {
    const previous = bookmarks.find((b) => b.id === id);
    if (!previous) throw new CommandError("not_found", "Query returned no rows");
    const now = new Date().toISOString();
    // Any decision sorts the bookmark, as `update_bookmark` does.
    const b = {
      ...previous,
      ...data,
      revision: (previous.revision ?? 1) + 1,
      updated_at: now,
      triaged_at: previous.triaged_at ?? now,
    };
    bookmarks = bookmarks.map((item) => (item.id === id ? b : item));
    persist();
    emit("updated", b);
    return record(actionOf(data), previous, b);
  },
  async trashBookmark(id: number): Promise<Changed> {
    const previous = bookmarks.find((b) => b.id === id);
    if (!previous) throw new CommandError("not_found", "Query returned no rows");
    if (previous.deleted_at) return { bookmark: previous, command: null };
    const b = change(previous, { deleted_at: new Date().toISOString() });
    emit("updated", b);
    return record("trash", previous, b);
  },
  async restoreBookmark(id: number): Promise<Changed> {
    const previous = bookmarks.find((b) => b.id === id);
    if (!previous) throw new CommandError("not_found", "Query returned no rows");
    if (!previous.deleted_at) return { bookmark: previous, command: null };
    const b = change(previous, { deleted_at: null });
    emit("updated", b);
    return record("restore", previous, b);
  },
  async undo(command?: number | null): Promise<Undo> {
    const entry = command == null ? journal.at(-1) : journal.find((c) => c.id === command);
    if (!entry) return { outcome: "nothing" };
    journal = journal.filter((c) => c !== entry);
    const { action } = entry;
    const byId = new Map(bookmarks.map((b) => [b.id, b]));
    for (const step of entry.changes) {
      const current = byId.get(step.id);
      if (!current) return { outcome: "gone", action, title: step.after.title };
      const now = fieldsOf(current);
      if (touched(step).some((f) => !same(f, now, step.after))) return { outcome: "conflict", action, title: current.title };
      // The old address was saved again meanwhile.
      if (touched(step).includes("url") && bookmarks.some((b) => b.id !== step.id && b.url === step.before.url))
        return { outcome: "conflict", action, title: current.title };
      const collection = step.before.collection_id;
      if (touched(step).includes("collection_id") && collection !== null && !collections.some((c) => c.id === collection))
        return { outcome: "no_collection", action, title: current.title };
    }
    // One pass and one write, as bulkUpdate: undoing 1 000 bookmarks one by one
    // rewrote the whole library 1 000 times.
    const now = new Date().toISOString();
    const next = new Map<number, Bookmark>();
    for (const step of entry.changes) {
      const previous = byId.get(step.id)!;
      const fields: Partial<Bookmark> = Object.fromEntries(touched(step).map((f) => [f, step.before[f]]));
      next.set(step.id, { ...previous, ...fields, revision: (previous.revision ?? 1) + 1, updated_at: now });
    }
    bookmarks = bookmarks.map((b) => next.get(b.id) ?? b);
    persist();
    const undone = entry.changes.map((step) => next.get(step.id)!);
    emitMany("updated", undone);
    return { outcome: "undone", action, bookmarks: undone };
  },
  /** `bulk_update`: one action on every selected bookmark, one journal command, all or nothing. */
  async bulkUpdate(ids: number[], bulk: BulkChange): Promise<BulkChanged> {
    if ((bulk.action === "tag" || bulk.action === "new_collection") && !bulk.name.trim())
      throw bulk.action === "tag"
        ? new CommandError("invalid_request", "Enter a tag", "empty_tag")
        : new CommandError("invalid_request", "Enter a collection name", "empty_collection_name");
    if (bulk.action === "move" && bulk.collection_id !== null && !collections.some((c) => c.id === bulk.collection_id))
      throw new CommandError("not_found", "FOREIGN KEY constraint failed");
    const created = bulk.action === "new_collection" ? await demo.createCollection(bulk.name) : null;
    const target = created ? created.id : bulk.action === "move" ? bulk.collection_id : null;
    const restore = bulk.action === "restore";
    const chosen = new Set(ids);
    const now = new Date().toISOString();
    let count = 0;
    const steps: Command["changes"] = [];
    const changed: Bookmark[] = [];
    bookmarks = bookmarks.map((b) => {
      if (!chosen.has(b.id) || !!b.deleted_at !== restore) return b;
      count++;
      const fields = bulkFields(b, bulk, target, now);
      if (!fields) return b;
      const next = { ...b, ...fields, revision: (b.revision ?? 1) + 1, updated_at: now };
      steps.push({ id: b.id, before: fieldsOf(b), after: fieldsOf(next) });
      changed.push(next);
      return next;
    });
    persist();
    const action: CommandAction =
      bulk.action === "new_collection"
        ? "move"
        : bulk.action === "reading"
          ? bulk.reading
            ? "to_reading"
            : "from_reading"
          : bulk.action === "read"
            ? bulk.read
              ? "read"
              : "unread"
            : bulk.action;
    const command = remember(action, steps);
    emitMany("updated", changed);
    return { count, changed: changed.length, command, collection: created && { ...created, count } };
  },
  /** `reading::set_progress`: no command of the journal; at 1 it is read, unless «Mark as read at the end» is off. */
  async setReadingProgress(id: number, progress: number): Promise<Bookmark> {
    const b = bookmarks.find((item) => item.id === id);
    if (!b) throw new CommandError("not_found", "Query returned no rows");
    const p = Number.isNaN(progress) ? 0 : Math.min(1, Math.max(0, progress));
    const marks = demoMarkAtEnd();
    if (b.deleted_at || (b.reading_progress === p && (p < 1 || b.read_at || !marks))) return b;
    const next = change(b, { reading_progress: p, read_at: p >= 1 && marks ? (b.read_at ?? new Date().toISOString()) : b.read_at });
    emit("updated", next);
    return next;
  },
  async allFavorite(ids: number[]): Promise<boolean> {
    const chosen = new Set(ids);
    const shown = bookmarks.filter((b) => chosen.has(b.id) && !b.deleted_at);
    return shown.length > 0 && shown.every((b) => b.is_favorite);
  },
  async nextCollectionId(): Promise<number> {
    return Math.max(lastCollection, ...collections.map((c) => c.id)) + 1;
  },
  /** `delete_forever_many`: only those in the trash, no undo. */
  async deleteForeverMany(ids: number[]): Promise<number> {
    const chosen = new Set(ids);
    const gone = bookmarks.filter((b) => chosen.has(b.id) && b.deleted_at);
    bookmarks = bookmarks.filter((b) => !gone.includes(b));
    sweepCopies();
    persist();
    emitMany("deleted", gone.map((b) => ({ ...b, revision: (b.revision ?? 1) + 1 })));
    return gone.length;
  },
  /** Only from the trash, like the desktop app (NP-023). */
  async deleteForever(id: number) {
    const b = bookmarks.find((item) => item.id === id && item.deleted_at);
    if (!b) throw new CommandError("not_found", "This bookmark is not in the trash", "not_in_trash");
    bookmarks = bookmarks.filter((item) => item.id !== id);
    sweepCopies();
    persist();
    emit("deleted", { ...b, revision: (b.revision ?? 1) + 1 });
  },
  async emptyTrash() {
    const gone = bookmarks.length - live().length;
    bookmarks = live();
    sweepCopies();
    persist();
    invalidations.forEach((fn) => fn());
    return gone;
  },
  async createCollection(name: string, color?: string, icon?: string) {
    if (collections.some((c) => c.name === name.trim()))
      throw new CommandError("conflict", "UNIQUE constraint failed: collections.name");
    const c: Collection = {
      id: nextCollection(),
      name: name.trim(),
      color: color ?? null,
      icon: icon ?? null,
      count: 0,
      created_at: new Date().toISOString(),
    };
    collections = [...collections, c];
    persist();
    return c;
  },
  async deleteCollection(id: number) {
    collections = collections.filter((c) => c.id !== id);
    bookmarks = bookmarks.map((b) =>
      b.collection_id === id
        ? { ...b, collection_id: null, revision: (b.revision ?? 1) + 1 }
        : b,
    );
    persist();
    invalidations.forEach((fn) => fn());
    return true;
  },
  /** `import.rs` in the browser: the same folder rule, all or nothing, progress by hundreds. */
  async importHtmlBookmarks(content: string, toInbox = false): Promise<ImportSummary> {
    const parsed = parseBookmarksFile(content);
    const summary: ImportSummary = {
      added: 0,
      existing: 0,
      in_trash: 0,
      not_web: parsed.skipped.filter((s) => s.reason === "not_web").length,
      invalid: parsed.skipped.filter((s) => s.reason === "invalid").length,
      repeated: parsed.skipped.filter((s) => s.reason === "repeated").length,
      skipped: parsed.skipped.slice(0, 200),
      collections: [],
      tags: 0,
    };
    const known = new Map(bookmarks.map((b) => [b.url, b]));
    const tagsBefore = new Set(bookmarks.flatMap((b) => b.tags ?? []));
    const named = new Map(collections.map((c) => [c.name.toLocaleLowerCase(), c.id]));
    const created: Collection[] = [];
    const added: Bookmark[] = [];
    const now = new Date().toISOString();
    let id = Math.max(Date.now(), ...bookmarks.map((b) => b.id + 1));
    for (const [index, link] of parsed.links.entries()) {
      const previous = known.get(link.url);
      if (previous?.deleted_at) summary.in_trash++;
      else if (previous) summary.existing++;
      else {
        let collectionId: number | null = null;
        if (link.collection) {
          const key = link.collection.toLocaleLowerCase();
          collectionId = named.get(key) ?? null;
          if (collectionId === null) {
            const c: Collection = { id: id++, name: link.collection, color: null, icon: null, count: 0, created_at: now };
            created.push(c);
            named.set(key, c.id);
            collectionId = c.id;
          }
        }
        const url = new URL(link.url);
        added.push({
          id: id++,
          url: link.url,
          title: link.title || link.url,
          description: null,
          image_url: null,
          favicon_url: null,
          site_name: null,
          notes: null,
          domain: url.hostname.replace(/^www\./, ""),
          collection_id: collectionId,
          tags: link.tags,
          is_favorite: false,
          reading_at: null,
          reading_progress: 0,
          read_at: null,
          offline_at: null,
          created_at: link.addedAt ?? now,
          updated_at: now,
          revision: 1,
          triaged_at: toInbox ? null : now,
          deleted_at: null,
          source: "import",
        });
        summary.added++;
      }
      if ((index + 1) % 100 === 0 || index + 1 === parsed.links.length) {
        progressListeners.forEach((fn) => fn({ done: index + 1, total: parsed.links.length }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    // Written at the end, like the transaction of the desktop app.
    bookmarks = [...added, ...bookmarks];
    collections = [...collections, ...created];
    summary.collections = created.map((c) => c.name);
    summary.tags = new Set(added.flatMap((b) => b.tags ?? []).filter((t) => !tagsBefore.has(t))).size;
    persist();
    invalidations.forEach((fn) => fn());
    // The new bookmarks' pages are read in the background, joining a run under way.
    if (added.length) startDemoRefresh(added.map((b) => b.id), true);
    return summary;
  },
  /**
   * The preview has no Save dialog and no files: it answers as if the file
   * were saved under the default name, with the count the desktop app would
   * write (the trash only in JSON). Tests replace it for the other outcomes.
   */
  async exportLibrary(format: ExportFormat, columns?: CsvColumns, ids?: number[]): Promise<ExportOutcome> {
    if (format === "csv" && !columns) throw new CommandError("invalid_request", "CSV needs column titles");
    const day = new Date();
    const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    if (ids) {
      const chosen = new Set(ids);
      const count = bookmarks.filter((b) => chosen.has(b.id)).length;
      return { outcome: "saved", file_name: `koona-pin-selected-${date}.${format}`, count };
    }
    return { outcome: "saved", file_name: `koona-pin-${date}.${format}`, count: format === "json" ? bookmarks.length : live().length };
  },
  async revealExport() {
    /* No folders in the browser preview. */
  },
  /** `restore.rs` in the browser: the same checks of the format, the version and every address. */
  async checkRestore(content: string): Promise<RestoreCheck> {
    const read = readCopy(content);
    if ("problem" in read) return { outcome: "rejected", problem: read };
    return {
      outcome: "ready",
      preview: {
        bookmarks: read.bookmarks.length,
        collections: read.collections.length,
        tags: read.tags.length,
        exported_at: read.exported_at,
        current: bookmarks.length,
      },
    };
  },
  /** Merge keeps every bookmark with the same address; replace takes the copy as it is. No backups in the preview. */
  async restoreLibrary(content: string, mode: RestoreMode): Promise<RestoreOutcome> {
    const copy = readCopy(content);
    if ("problem" in copy) return { outcome: "rejected", problem: copy };
    if (mode === "replace") {
      bookmarks = [];
      collections = [];
      sweepCopies();
    }
    const summary: RestoreSummary = { added: 0, in_inbox: 0, in_trash: 0, existing: 0, collections: [], tags: 0, backup: mode === "replace" ? "koona-pin.before-restore.db" : null };
    const tagsBefore = new Set(bookmarks.flatMap((b) => b.tags ?? []));
    let id = Math.max(Date.now(), ...bookmarks.map((b) => b.id + 1), ...collections.map((c) => c.id + 1));
    const collectionOf = new Map<string, number>();
    for (const c of copy.collections) {
      const same = collections.find((existing) => existing.name.toLocaleLowerCase() === c.name.toLocaleLowerCase());
      if (same) collectionOf.set(c.uid, same.id);
      else {
        collections = [...collections, { id: id, name: c.name, color: c.color ?? null, icon: c.icon ?? null, count: 0, created_at: c.created_at }];
        summary.collections.push(c.name);
        collectionOf.set(c.uid, id++);
      }
    }
    const known = new Set(bookmarks.map((b) => b.url));
    for (const b of copy.bookmarks) {
      if (known.has(b.url)) {
        summary.existing++;
        continue;
      }
      bookmarks = [
        ...bookmarks,
        {
          id: id++,
          url: b.url,
          title: b.title,
          description: b.description ?? null,
          image_url: b.image_url ?? null,
          favicon_url: b.favicon_url ?? null,
          site_name: b.site_name ?? null,
          notes: b.notes ?? null,
          reading_at: b.reading_at ?? null,
          reading_progress: Math.min(1, Math.max(0, b.reading_progress ?? 0)),
          read_at: b.read_at ?? null,
          // Copies are never in a backup (NP-126).
          offline_at: null,
          domain: b.domain || new URL(b.url).hostname,
          collection_id: b.collection ? (collectionOf.get(b.collection) ?? null) : null,
          tags: b.tags ?? [],
          is_favorite: !!b.is_favorite,
          created_at: b.created_at,
          updated_at: b.updated_at,
          revision: 1,
          triaged_at: b.triaged_at ?? null,
          deleted_at: b.deleted_at ?? null,
          source: b.source ?? null,
        },
      ];
      summary.added++;
      if (b.deleted_at) summary.in_trash++;
      else if (!b.triaged_at) summary.in_inbox++;
    }
    summary.tags = new Set(bookmarks.flatMap((b) => b.tags ?? []).filter((t) => !tagsBefore.has(t))).size;
    persist();
    invalidations.forEach((fn) => fn());
    return { outcome: "restored", summary };
  },
  async previewList(text: string, source: string): Promise<ListCheck> {
    const list = demoList(text);
    if ("outcome" in list) return list;
    const raw = list.raw as { description?: string; author?: { name?: string; url?: string }; license?: string; updated?: string; homepage?: string; id?: string; generator?: string; language?: string };
    const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
    const known = new Map(bookmarks.map((b) => [b.url, b]));
    const saved = list.links.filter((l) => known.get(l.url) && !known.get(l.url)!.deleted_at).length;
    const trashed = list.links.filter((l) => known.get(l.url)?.deleted_at).length;
    const followed = new Set(feedsState().feeds.map((f) => f.url));
    const named = collections.find((c) => c.name.toLocaleLowerCase() === list.title.toLocaleLowerCase());
    return {
      outcome: "ready",
      preview: {
        meta: {
          title: list.title,
          description: str(raw.description),
          author_name: str(raw.author?.name),
          author_url: demoWebUrl(raw.author?.url),
          license: str(raw.license),
          language: str(raw.language),
          updated: str(raw.updated),
          homepage: demoWebUrl(raw.homepage),
          id: str(raw.id),
          generator: str(raw.generator),
          version: list.version,
        },
        source,
        newer: list.newer,
        links: list.links.length,
        feeds: list.feeds.length,
        sections: list.sections,
        sectioned_links: list.links.filter((l) => l.sections.length > 0).length,
        new_links: list.links.length - saved - trashed,
        already_saved: saved,
        in_trash: trashed,
        repeated: list.repeated,
        not_web: list.not_web,
        invalid: list.invalid,
        feeds_followed: list.feeds.filter((f) => followed.has(f.url)).length,
        skipped_details: 0,
        skipped_items: list.skipped_items,
        new_feeds: list.feeds.filter((f) => !followed.has(f.url)).map((f) => ({ url: f.url, title: f.title, site: null, section: f.sections[0] ?? null })),
        existing_collection: named ? { id: named.id, name: named.name } : null,
      },
    };
  },
  /** `lists/apply.rs` in the browser: new links only, written at the end, then the feeds. */
  async importList(text: string, options: ListImportOptions): Promise<ListImportReport> {
    const list = demoList(text);
    if ("outcome" in list) throw new CommandError("invalid_request", "This file isn't a Koona list");
    const known = new Map(bookmarks.map((b) => [b.url, b]));
    const now = new Date().toISOString();
    let id = Math.max(Date.now(), ...bookmarks.map((b) => b.id + 1));
    let collectionId: number | null = null;
    let created: Collection | null = null;
    if (options.collection.kind === "existing") collectionId = options.collection.id;
    if (options.collection.kind === "new") {
      const name = options.collection.name.trim();
      const same = collections.find((c) => c.name.toLocaleLowerCase() === name.toLocaleLowerCase());
      if (same) collectionId = same.id;
      else {
        created = { id: id++, name, color: null, icon: null, count: 0, created_at: now };
        collectionId = created.id;
      }
    }
    const report: ListImportReport = { added: 0, already_saved: 0, in_trash: 0, repeated: list.repeated, not_web: list.not_web, invalid: list.invalid, skipped_items: list.skipped_items, feeds_followed: 0, feeds_already: 0, collection_id: null };
    const tagsOf = (link: DemoListItem) => [...new Set([...link.tags, ...(options.sections_as_tags ? link.sections.map((s) => s.toLowerCase().slice(0, 64)) : [])])];
    const added: Bookmark[] = [];
    for (const [index, link] of list.links.entries()) {
      const previous = known.get(link.url);
      if (previous?.deleted_at) report.in_trash++;
      else if (previous) {
        report.already_saved++;
        if (options.existing_links === "add_tags") previous.tags = [...new Set([...(previous.tags ?? []), ...tagsOf(link)])];
      } else {
        added.push({
          id: id++,
          url: link.url,
          title: link.title || link.url,
          description: link.description,
          image_url: null,
          favicon_url: null,
          site_name: null,
          notes: null,
          domain: new URL(link.url).hostname.replace(/^www\./, ""),
          collection_id: collectionId,
          tags: tagsOf(link),
          is_favorite: false,
          reading_at: null,
          reading_progress: 0,
          read_at: null,
          offline_at: null,
          created_at: now,
          updated_at: now,
          revision: 1,
          triaged_at: options.to_inbox ? null : now,
          deleted_at: null,
          source: "list",
          source_name: list.title,
        });
        report.added++;
      }
      progressListeners.forEach((fn) => fn({ done: index + 1, total: list.links.length }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    bookmarks = [...added, ...bookmarks];
    if (created && added.length) collections = [...collections, created];
    if (added.length) report.collection_id = collectionId;
    const followed = new Set(feedsState().feeds.map((f) => f.url));
    for (const feed of list.feeds) {
      if (followed.has(feed.url)) report.feeds_already++;
      else if (options.follow_feeds.includes(feed.url)) {
        await demo.subscribeFeed(feed.url, feed.title, "feeds");
        report.feeds_followed++;
      }
    }
    persist();
    invalidations.forEach((fn) => fn());
    if (added.length) startDemoRefresh(added.map((b) => b.id), true);
    return report;
  },
  /** The preview is given no paths. */
  async readListFile(path: string): Promise<ListFile> {
    void path;
    return { outcome: "unreadable" };
  },
  /** The preview downloads nothing: the server is never reached. Tests replace it for the other outcomes. */
  async downloadList(url: string, ticket: number): Promise<ListDownload> {
    void url;
    demoListDownloads.forEach((fn) => fn({ ticket, received: 0, total: null }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { outcome: "unreachable" };
  },
  async nextListTicket(): Promise<number> {
    return ++demoTicket;
  },
  async cancelListDownload(_ticket: number): Promise<void> {},
  /** The preview has no second copy of the app to bring forward. */
  async setListOpen(open: boolean): Promise<void> {
    void open;
  },
  onListDownloadProgress(fn: (progress: ListDownloadProgress) => void) {
    demoListDownloads.add(fn);
    return () => {
      demoListDownloads.delete(fn);
    };
  },
  onImportProgress(fn: (progress: ImportProgress) => void) {
    progressListeners.add(fn);
    return () => {
      progressListeners.delete(fn);
    };
  },
  async openUrl(url: string) {
    window.open(url, "_blank", "noopener,noreferrer");
  },
  /** The preview reads no web page: a bookmark's article is written from its own title and description. */
  async fetchReaderPage(url: string): Promise<ReaderPage> {
    const b = bookmarks.find((item) => item.url === url);
    if (!b) return { kind: "failed" };
    return { kind: "page", url, status: 200, charset: "utf-8", html: demoArticle(b), truncated: false };
  },
  onBookmarkChanged(fn: (change: BookmarkChange) => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  onBookmarksChanged(fn: (changes: BookmarkChange[]) => void) {
    batchListeners.add(fn);
    return () => {
      batchListeners.delete(fn);
    };
  },
  onLibraryInvalidated(fn: () => void) {
    invalidations.add(fn);
    return () => {
      invalidations.delete(fn);
    };
  },
  async getAppSettings() {
    return {
      close_to_tray: true,
      reading_mark_at_end: demoMarkAtEnd(),
      reading_save_offline: demoSwitch(DEMO_SAVE_OFFLINE_KEY) === "true",
      // feeds (NP-128): an hour unless chosen.
      feeds_refresh_minutes: Number(demoSwitch(DEMO_FEEDS_REFRESH_KEY) ?? 60),
    };
  },
  async setReadingSaveOffline(enabled: boolean) {
    localStorage.setItem(DEMO_SAVE_OFFLINE_KEY, enabled ? "true" : "false");
  },
  /** `save_offline_copy`: the article as the reader extracted it; the preview downloads no pictures. */
  async saveOfflineCopy(bookmarkId: number, article: OfflineArticle): Promise<OfflineCopy> {
    const b = bookmarks.find((item) => item.id === bookmarkId);
    if (!b) throw new CommandError("not_found", "The bookmark is gone", "bookmark_gone");
    const copy: OfflineCopy = {
      bookmark_id: bookmarkId,
      saved_at: new Date().toISOString(),
      url: article.url,
      bytes: new TextEncoder().encode(article.html).length,
      images: (article.html.match(/<img\b/gi) ?? []).length,
      words: article.words,
    };
    copies.set(bookmarkId, { copy, article });
    setOffline(b, copy.saved_at);
    return copy;
  },
  async getOfflineCopy(bookmarkId: number): Promise<OfflineCopyContent | null> {
    return copies.get(bookmarkId) ?? null;
  },
  async removeOfflineCopy(bookmarkId: number) {
    copies.delete(bookmarkId);
    const b = bookmarks.find((item) => item.id === bookmarkId);
    if (b?.offline_at) setOffline(b, null);
  },
  async removeAllOfflineCopies(): Promise<number> {
    const count = copies.size;
    copies.clear();
    bookmarks = bookmarks.map((b) => (b.offline_at ? { ...b, offline_at: null } : b));
    persist();
    invalidations.forEach((fn) => fn());
    return count;
  },
  async offlineStats(): Promise<OfflineStats> {
    return { count: copies.size, bytes: [...copies.values()].reduce((sum, { copy }) => sum + copy.bytes, 0) };
  },
  async revealOfflineFolder() {
    /* Desktop-only: the preview keeps its copies in memory. */
  },
  /** set_reading_mark_at_end (NP-124): kept across reloads, as app_settings is. */
  async setReadingMarkAtEnd(enabled: boolean) {
    localStorage.setItem(DEMO_MARK_AT_END_KEY, enabled ? "true" : "false");
  },
  async setCloseToTray(_enabled: boolean) {
    /* Desktop-only setting. */
  },
  /** The preview has no browser extension: never connected. */
  async getCaptureStatus(): Promise<CaptureStatus> {
    return demoCapture();
  },
  onCaptureStatus(_fn: (status: CaptureStatus) => void) {
    return () => {};
  },
  async repairCapture(): Promise<CaptureStatus> {
    return demoCapture();
  },
  async getLibraryStatus(): Promise<LibraryStatus> {
    return { state: "ready", damaged: false, moved_aside: null };
  },
  onLibraryStatus(_fn: (status: LibraryStatus) => void) {
    return () => {};
  },
  async retryLibrary() {
    /* The demo library always opens. */
  },
  async revealLibraryPlace(_place: LibraryPlace) {
    /* No folders in the browser preview. */
  },
  async quitApp() {
    /* Desktop-only. */
  },
  /** Windows buttons; a test or a look at the Linux bar puts a `Desktop` into localStorage. */
  async getDesktop(): Promise<Desktop> {
    return storedDesktop() ?? { native_frame: false, linux: false, left: [], right: ["minimize", "maximize", "close"], tray: true, appimage: false };
  },
  async hideToBackground() {
    /* Desktop-only. */
  },
  onCloseToBackground(_fn: () => void) {
    return () => {};
  },
  async getAutostart() {
    return false;
  },
  async setAutostart(_enabled: boolean) {
    /* Desktop-only. */
  },
  async getDataSummary(): Promise<DataSummary> {
    return {
      library_folder: "%APPDATA%\\Koona\\Pin",
      backups_folder: "%APPDATA%\\Koona\\Pin\\backups",
      copies: 0,
      bytes: 0,
      last_copy: null,
    };
  },
  async backUpNow(): Promise<DataSummary> {
    throw new CommandError("internal", i18n.t("settings.desktopOnly"));
  },
  async getDuplicates(): Promise<DuplicateGroup[]> {
    return groupsOf(bookmarks, dismissed);
  },
  /** `dedupe::merge`: all groups or none, one journal command. */
  async mergeDuplicates(groups: MergeGroup[]): Promise<Merged> {
    const live = (id: number) => bookmarks.find((b) => b.id === id && !b.deleted_at);
    const keyed = new Map(groupsOf(bookmarks, new Map()).flatMap((g) => g.bookmarks.map((b) => [b.id, g.key] as const)));
    const seen = new Set<number>();
    for (const g of groups)
      for (const id of [g.main, ...g.others])
        if (!live(id) || seen.has(id) || keyed.get(id) !== keyed.get(g.main) || !keyed.has(id))
          throw new CommandError("not_found", "Query returned no rows");
        else seen.add(id);
    const now = new Date().toISOString();
    const steps: Command["changes"] = [];
    const changed: Bookmark[] = [];
    let trashed = 0;
    for (const g of groups) {
      if (g.others.length === 0) continue;
      const main = live(g.main)!;
      const others = g.others.map((id) => live(id)!);
      const updates: [Bookmark, Partial<Bookmark>][] = [[main, mergedFields(main, others)], ...others.map((o): [Bookmark, Partial<Bookmark>] => [o, { deleted_at: now }])];
      for (const [before, fields] of updates) {
        const after = change(before, fields);
        steps.push({ id: after.id, before: fieldsOf(before), after: fieldsOf(after) });
        changed.push(after);
      }
      trashed += others.length;
    }
    const command = remember("merge", steps);
    emitMany("updated", changed);
    const merged = groups.filter((g) => g.others.length > 0);
    return { groups: merged.length, trashed, title: merged.length === 1 ? (live(merged[0].main)?.title ?? null) : null, command };
  },
  async dismissDuplicates(key: string, ids: number[]): Promise<number> {
    const set = dismissed.get(key) ?? new Set<number>();
    ids.forEach((id) => set.add(id));
    dismissed.set(key, set);
    for (const fn of duplicateListeners) fn();
    return ids.length;
  },
  async undismissDuplicates(key: string, ids: number[]): Promise<number> {
    ids.forEach((id) => dismissed.get(key)?.delete(id));
    for (const fn of duplicateListeners) fn();
    return ids.length;
  },
  onDuplicatesChanged(fn: () => void) {
    duplicateListeners.add(fn);
    return () => {
      duplicateListeners.delete(fn);
    };
  },
  async saveBackupCopy(): Promise<SaveCopyOutcome> {
    throw new CommandError("internal", i18n.t("settings.desktopOnly"));
  },
  /** Two made-up copies, so the restore dialog of sheet 33 can be tried in the browser. */
  async listBackups(): Promise<BackupCopy[]> {
    const at = (daysAgo: number) => {
      const time = new Date();
      time.setDate(time.getDate() - daysAgo);
      time.setHours(9, 12, 0, 0);
      return time.toISOString();
    };
    const count = sample.bookmarks.length;
    return [
      { file_name: "koonapin.auto-demo-1.db", kind: "automatic", created_at: at(0), bytes: 1_300_000, bookmarks: count },
      { file_name: "koonapin.before-v4.db", kind: "before_update", created_at: at(2), bytes: 1_250_000, bookmarks: count - 2 },
    ];
  },
  async pickBackup(): Promise<PickedCopy> {
    return { outcome: "cancelled" };
  },
  /** The demo library stays as it is: there is no file to replace. */
  async restoreBackup(source: BackupSource): Promise<BackupRestoreOutcome> {
    const copy = (await this.listBackups()).find((c) => source.from === "listed" && c.file_name === source.file_name);
    if (!copy) throw new CommandError("not_found", "The copy is gone", "copy_gone");
    return { outcome: "restored", bookmarks: copy.bookmarks ?? 0, previous: "koonapin.before-restore-demo.db" };
  },
  async revealBackup(_fileName: string) {
    /* No folders in the browser preview. */
  },
  async getLinkCheck(): Promise<LinkCheckReport> {
    return linkReport();
  },
  async startLinkCheck(ids: number[] | null, resume: boolean): Promise<void> {
    if (linkRun) return;
    if (ids !== null) linkScope = ids;
    else if (!resume) linkScope = null;
    else if (linkScope) ids = linkScope;
    const whole = ids === null;
    let queue: number[];
    let before = 0;
    if (ids === null) {
      linkStarted = resume && linkStarted ? linkStarted : new Date().toISOString();
      queue = leftToCheck(linkStarted);
      before = live().length - queue.length;
    } else {
      queue = ids.filter((id) => live().some((b) => b.id === id));
    }
    const run = { timer: 0, queue, done: before, total: before + queue.length, whole };
    linkRun = run;
    linkProgress("running", false);
    const finish = () => {
      window.clearInterval(run.timer);
      if (whole) {
        linkFinished = new Date().toISOString();
        linkStarted = null;
      }
      linkScope = null;
      linkProgress("idle", true);
      linkRun = null;
    };
    run.timer = window.setInterval(() => {
      const id = run.queue.shift();
      if (id === undefined) return finish();
      const b = live().find((item) => item.id === id);
      if (b) linkResults.set(id, { url: b.url, checked_at: new Date().toISOString(), ...demoAnswer(b.url) });
      run.done++;
      if (run.queue.length === 0) return finish();
      linkProgress("running", run.done % 5 === 0);
    }, LINK_STEP_MS);
  },
  async stopLinkCheck(): Promise<void> {
    if (!linkRun) return;
    window.clearInterval(linkRun.timer);
    linkProgress("stopped", true);
    linkRun = null;
  },
  /** `linkcheck::replace`: the moved ones take their new address, one journal command. */
  async replaceAddresses(ids: number[]): Promise<Replaced> {
    const steps: Command["changes"] = [];
    const changed: Bookmark[] = [];
    let skipped = 0;
    for (const id of ids) {
      const b = live().find((item) => item.id === id);
      const r = b && linkResults.get(id);
      const target = r && r.url === b.url && r.outcome === "moved" ? r.target : null;
      if (!b || !target || bookmarks.some((x) => x.url === target)) {
        skipped++;
        continue;
      }
      const after = change(b, { url: target, domain: new URL(target).hostname.replace(/^www\./, "") });
      steps.push({ id, before: fieldsOf(b), after: fieldsOf(after) });
      changed.push(after);
    }
    const command = remember("replace", steps);
    emitMany("updated", changed);
    return { replaced: changed.length, skipped, address: changed.length === 1 ? changed[0].url : null, command };
  },
  onLinkCheck(fn: (progress: LinkCheckProgress) => void) {
    linkListeners.add(fn);
    return () => {
      linkListeners.delete(fn);
    };
  },
  async getPreviewRefresh(): Promise<PreviewRefresh> {
    return refreshLast;
  },
  async getPreviewCounts(): Promise<PreviewCounts> {
    const library = live();
    return { missing: library.filter(missingPreview).length, all: library.length };
  },
  async startPreviewRefresh(target: { scope: PreviewScope } | { ids: number[] }): Promise<PreviewRefresh> {
    const library = live();
    const queue =
      "ids" in target
        ? target.ids.filter((id) => library.some((b) => b.id === id))
        : library.filter((b) => target.scope === "all" || missingPreview(b)).sort((a, b) => b.id - a.id).map((b) => b.id);
    return startDemoRefresh(queue, false);
  },
  async stopPreviewRefresh(): Promise<void> {
    if (!refreshRun) return;
    window.clearInterval(refreshRun.timer);
    refreshRun = null;
    refreshProgress({ ...refreshLast, state: "stopped" });
  },
  onPreviewRefresh(fn: (progress: PreviewRefresh) => void) {
    refreshListeners.add(fn);
    return () => {
      refreshListeners.delete(fn);
    };
  },
  /** The demo reads no pages: the bookmark stays as it is. */
  async refreshPreview(id: number) {
    const b = bookmarks.find((item) => item.id === id && !item.deleted_at);
    if (!b) throw new CommandError("not_found", "Query returned no rows");
    return { ...b };
  },
  /** The demo library is made in its language already. */
  /** `db::reorder_collections`: every id gets its place, unknown ones change nothing. */
  async reorderCollections(ids: number[]) {
    collections = collections.map((c) => (ids.includes(c.id) ? { ...c, position: ids.indexOf(c.id) } : c));
    persist();
  },
  /** The preview compares by the interface's collator: nothing to write. */
  async setSortLanguage(_language: string) {
    return false;
  },
  async createStarterCollections(_names: string[]): Promise<Collection[]> {
    return [];
  },
  /** The preview has its own sample library: no starter set (NP-117). */
  async createStarterLibrary(_names: string[], _links: StarterLink[]): Promise<StarterLibrary> {
    return { collections: [], links: [] };
  },
  /** Starter links of the sample library: a test puts their ids into localStorage. */
  async getStarterLinks(): Promise<number[]> {
    try {
      return JSON.parse(localStorage.getItem("koonapin.demo.starter") || "[]") as number[];
    } catch {
      return [];
    }
  },
  async setTrayLabels(_labels: { open: string; quit: string; tooltip: string }) {},
  async getMcpStatus(): Promise<McpStatus> {
    return demoMcp;
  },
  async setMcpAccess(access: McpAccess): Promise<McpStatus> {
    demoMcp = { ...demoMcp, access, mode: access === "off" ? demoMcp.mode : access };
    for (const fn of mcpListeners) fn(demoMcp);
    return demoMcp;
  },
  onMcpStatus(fn: (status: McpStatus) => void) {
    mcpListeners.add(fn);
    return () => void mcpListeners.delete(fn);
  },
  async getMcpSetup(): Promise<McpSetup> {
    const server = String.raw`C:\Users\Anna\AppData\Local\Koona Pin\koonapin-mcp.exe`;
    return {
      server,
      installed: true,
      claude_code: `claude mcp add --scope user koona-pin -- "${server}"`,
      codex: `codex mcp add koona-pin -- "${server}"`,
      json: JSON.stringify({ mcpServers: { "koona-pin": { command: server } } }, null, 2),
    };
  },
  async saveMcpb(): Promise<string | null> {
    return "koona-pin.mcpb";
  },
  async feedbackReport(language: string) {
    return ["Koona Pin demo", "Browser preview", `Language: ${language}`, `Capture: ${demoCaptureStatus.state}`, `Protocol: ${demoCaptureStatus.protocol}`].join("\n");
  },
  /** The preview sends nothing: the same checks as the app, then a pause. */
  async sendFeedback(feedback: Feedback) {
    if (!feedback.message.trim()) throw new CommandError("invalid_request", "The message is empty", "empty_message");
    if (length(feedback.message) > MAX_MESSAGE)
      throw new CommandError("invalid_request", "The message is longer than 5000 characters", "message_too_long");
    if (feedback.email && !emailShape(feedback.email.trim()))
      throw new CommandError("invalid_request", "The email address does not look right", "invalid_email");
    await new Promise((resolve) => setTimeout(resolve, 300));
  },
  async getVersion() {
    return "demo";
  },
  async getUpdateStatus(): Promise<UpdateStatus> {
    return currentDemoUpdate();
  },
  onUpdateStatus(fn: (status: UpdateStatus) => void) {
    updateListeners.add(fn);
    return () => void updateListeners.delete(fn);
  },
  async checkForUpdates(): Promise<UpdateStatus> {
    const before = currentDemoUpdate();
    if (before.state !== "up_to_date" && before.state !== "check_failed") return before;
    setDemoUpdate({ state: "checking" });
    await new Promise((resolve) => setTimeout(resolve, 600));
    setDemoUpdate(storedUpdate() ? demoOffer() : { state: "up_to_date", checked_at: new Date().toISOString() });
    return currentDemoUpdate();
  },
  /** 9.8 MB in about three seconds; `failing` stops at 40 %, otherwise the preview «restarts» up to date. */
  async installUpdate() {
    const status = currentDemoUpdate();
    if (status.state !== "available" && status.state !== "failed") return;
    const total = 9_800_000;
    let received = 0;
    setDemoUpdate({ state: "downloading", version: DEMO_NEW_VERSION, received, total });
    demoDownload = window.setInterval(() => {
      received = Math.min(total, received + 350_000);
      if (storedUpdate() === "failing" && received > total * 0.4) {
        window.clearInterval(demoDownload!);
        demoDownload = null;
        setDemoUpdate({ state: "failed", version: DEMO_NEW_VERSION, problem: "no_connection" });
      } else if (received < total) {
        setDemoUpdate({ state: "downloading", version: DEMO_NEW_VERSION, received, total });
      } else {
        window.clearInterval(demoDownload!);
        demoDownload = null;
        setDemoUpdate({ state: "installing", version: DEMO_NEW_VERSION });
        window.setTimeout(() => setDemoUpdate({ state: "up_to_date", checked_at: new Date().toISOString() }), 1500);
      }
    }, 100);
  },
  async cancelUpdate() {
    if (demoDownload === null) return;
    window.clearInterval(demoDownload);
    demoDownload = null;
    setDemoUpdate(demoOffer());
  },
  async getSupporterStatus(): Promise<SupporterStatus> {
    return currentDemoSupporter();
  },
  onSupporterStatus(fn: (status: SupporterStatus) => void) {
    supporterListeners.add(fn);
    return () => void supporterListeners.delete(fn);
  },
  async getSupporterPrices(): Promise<SupporterPrices> {
    // The app's background sees an earlier purchase while the dialog shows the plans.
    const later = storedSupporter();
    if (later === "later_sign_in" || later === "later_paid") {
      window.setTimeout(() => {
        const now = currentDemoSupporter();
        setDemoSupporter(
          later === "later_sign_in"
            ? { ...now, awaiting_sign_in: true }
            : { ...now, email: "anna@example.com", plan: demoPlan("supporter"), check_failed: false },
        );
      }, 800);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    noServer();
    return {
      month: { price_id: "pri_month", total: "$2.00", currency: "USD" },
      year: { price_id: "pri_year", total: "$20.00", currency: "USD" },
      // `koonapin.demo.fiveYears` = `off`: a server that does not sell them.
      five_years: demoSwitch("koonapin.demo.fiveYears") === "off" ? null : { price_id: "pri_5y", total: "$50.00", currency: "USD" },
    };
  },
  async startCheckout(interval: PlanInterval) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    noServer();
    demoPolls = 0;
    demoBought = interval;
    return "https://koona.app/pin/checkout/?_ptxn=txn_demo";
  },
  async openCheckout(_url: string) {},
  async pollCheckout(): Promise<CheckoutState> {
    if (++demoPolls < 3) return "waiting";
    if (storedSupporter() === "existing") {
      // Kept until the code signs in, as billing.rs keeps awaiting_sign_in.
      setDemoSupporter({ ...currentDemoSupporter(), awaiting_sign_in: true });
      return "sign_in";
    }
    setDemoSupporter({ ...currentDemoSupporter(), email: "anna@example.com", plan: demoPlan(demoBought === "five_years" ? "five_years" : "supporter"), check_failed: false });
    // The app's own background check saw the payment first: the purchase is gone, the plan is here.
    if (storedSupporter() === "background") return "none";
    return "paid";
  },
  /**
   * `koonapin.demo.serverPlan` is the plan the preview's server has now (a kind of `demoPlan`, or
   * `none`), as after a change in the portal. Without it the server has nothing new; only «Try
   * again» brings back a plan that could not be checked.
   */
  async refreshSupporter(automatic = false): Promise<SupporterStatus> {
    await new Promise((resolve) => setTimeout(resolve, 400));
    noServer();
    const status = currentDemoSupporter();
    let server: string | null = null;
    try {
      server = localStorage.getItem("koonapin.demo.serverPlan");
    } catch {
      server = null;
    }
    if (server !== null) setDemoSupporter({ ...status, plan: demoPlan(server), check_failed: false, plan_unknown: false });
    else if (status.check_failed && !automatic) setDemoSupporter({ ...status, plan: demoPlan("supporter"), check_failed: false, plan_unknown: false });
    return currentDemoSupporter();
  },
  async openSupporterPortal() {},
  async sendSignInCode(email: string) {
    if (!emailShape(email.trim())) throw new CommandError("invalid_request", "The email address does not look right", "invalid_email");
    await new Promise((resolve) => setTimeout(resolve, 300));
    noServer();
  },
  /** Any code but 000000 works in the preview. */
  async verifySignInCode(email: string, code: string): Promise<SupporterStatus> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (code.replace(/\D/g, "") === "000000") throw new CommandError("invalid_request", "The code did not work", "wrong_code");
    // `free@…`: an account whose plan ended or was cancelled; `unknown@…`: signed in, but the plan
    // check failed (the server did not answer), until «Try again».
    const address = email.trim().toLowerCase();
    const unknown = address.startsWith("unknown@");
    const plan = address.startsWith("free@") || unknown ? null : demoPlan("supporter");
    setDemoSupporter({ ...currentDemoSupporter(), email: email.trim(), plan, check_failed: unknown, plan_unknown: unknown, awaiting_sign_in: false });
    return currentDemoSupporter();
  },
  async getBackupFolder(): Promise<BackupFolder> {
    return currentDemoFolder();
  },
  onBackupFolder(fn: (folder: BackupFolder) => void) {
    folderListeners.add(fn);
    return () => void folderListeners.delete(fn);
  },
  /** The preview's «picker» chooses a Dropbox folder at once and makes the first copy there. */
  async chooseBackupFolder(_title: string): Promise<BackupFolder> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    setDemoFolder({ path: "D:\\Dropbox\\Koona Pin", last_copy_at: new Date().toISOString(), unreachable: false });
    return currentDemoFolder();
  },
  async stopBackupFolder(): Promise<BackupFolder> {
    setDemoFolder({ path: null, last_copy_at: null, unreachable: false });
    return currentDemoFolder();
  },
  async openBackupFolder() {},
  async getSyncStatus(): Promise<SyncStatus> {
    return currentDemoSync();
  },
  onSyncStatus(fn: (status: SyncStatus) => void) {
    syncListeners.add(fn);
    return () => void syncListeners.delete(fn);
  },
  /** Fails as the relay would: no server, the plan's check offline (`koonapin.demo.supporter` = `offline`), no plan. */
  async getSyncAccount(): Promise<SyncAccount> {
    noServer();
    await syncPause();
    if (currentDemoSupporter().check_failed) throw new CommandError("network", "No connection", "no_connection");
    if (!currentDemoSupporter().plan) throw new CommandError("invalid_request", "Sync is for Supporters", "not_supporter");
    return demoSyncAccount();
  },
  /** An account without a main computer: this one becomes the hub of one; with one, this one waits for it. */
  async enableSync(name?: string): Promise<SyncStatus> {
    if (!currentDemoSupporter().plan) throw new CommandError("invalid_request", "Sync is for Supporters", "not_supporter");
    await syncPause();
    const named = name?.trim() || currentDemoSync().device.name;
    const main = demoSyncAccount().main_name;
    if (main) {
      const waiting = demoSyncState("pending");
      const me = { ...waiting.device, name: named };
      const devices = waiting.devices.map((d) => (d.id === me.id ? me : d.is_hub ? { ...d, name: main } : d));
      setDemoSync({ ...waiting, device: me, devices, pairing: { role: "asking", peer: HUB_DEVICE, peer_name: main, code: "482913" } });
      return currentDemoSync();
    }
    const me = demoDevice(THIS_DEVICE, named, { ...IMAC, online: true, is_hub: true, last_seen: Date.now(), last_sync_at: new Date().toISOString() });
    setDemoSync({ ...demoSyncState("on"), device: me, devices: [me], last_sync_at: new Date().toISOString() });
    return currentDemoSync();
  },
  async disableSync(): Promise<SyncStatus> {
    await syncPause();
    const status = currentDemoSync();
    setDemoSync({ ...status, enabled: false, phase: { state: "off" }, pairing: null, error: null, hub_change: null });
    return currentDemoSync();
  },
  async approveDevice(device: string): Promise<SyncStatus> {
    needSyncRunning();
    await syncPause();
    const status = changeDemoDevices((devices) => devices.map((d) => (d.id === device ? { ...d, status: "active" } : d)));
    setDemoSync({ ...status, pairing: null });
    return currentDemoSync();
  },
  async rejectDevice(device: string): Promise<SyncStatus> {
    needSyncRunning();
    await syncPause();
    const status = changeDemoDevices((devices) => devices.filter((d) => d.id !== device));
    setDemoSync({ ...status, pairing: null });
    return currentDemoSync();
  },
  async removeDevice(device: string): Promise<SyncStatus> {
    needSyncRunning();
    await syncPause();
    return changeDemoDevices((devices) => devices.filter((d) => d.id !== device));
  },
  /** The main computer offline: `hub_offline`, and the dialog offers to start over. Online, it is asked. */
  async requestMain(): Promise<SyncStatus> {
    needSyncRunning();
    await syncPause();
    const status = currentDemoSync();
    const hub = status.devices.find((d) => d.is_hub);
    if (!hub?.online) {
      setDemoSync({ ...status, error: "hub_offline" });
      return currentDemoSync();
    }
    setDemoSync({ ...status, error: null, hub_change: { role: "asking", peer: hub.id, peer_name: hub.name } });
    return currentDemoSync();
  },
  async answerMainRequest(allow: boolean): Promise<SyncStatus> {
    needSyncRunning();
    await syncPause();
    const status = currentDemoSync();
    const peer = status.hub_change?.role === "hub" ? status.hub_change.peer : null;
    if (!peer) throw new CommandError("invalid_request", "Nothing was asked");
    if (!allow) {
      setDemoSync({ ...status, hub_change: null });
      return currentDemoSync();
    }
    const devices = status.devices.map((d) => ({ ...d, is_hub: d.id === peer }));
    setDemoSync({ ...status, devices, device: devices.find((d) => d.id === status.device.id)!, hub: peer, is_hub: false, hub_change: null });
    return currentDemoSync();
  },
  async sendStartOverCode(): Promise<string> {
    await syncPause();
    noServer();
    return currentDemoSupporter().email ?? "anna@example.com";
  },
  /**
   * Any code but 000000 works, as for signing in; 111111 stands for a sign-in the relay finds too
   * old. As in the app, the relay's answer comes after the command, in the status.
   */
  async startOver(code: string): Promise<SyncStatus> {
    await syncPause();
    const digits = code.replace(/\D/g, "");
    if (digits === "000000") throw new CommandError("invalid_request", "The code did not work", "wrong_code");
    setTimeout(() => {
      if (digits === "111111") setDemoSync({ ...currentDemoSync(), error: "stale_sign_in" });
      // Every other computer is disconnected: they join again with «Join…».
      else setDemoSync(demoBecomeHub(currentDemoSync(), (d) => ({ ...d, online: false })));
    }, 600);
    return { ...currentDemoSync(), error: null };
  },
  async joinSyncAgain(): Promise<SyncStatus> {
    needSyncRunning();
    await syncPause();
    const status = currentDemoSync();
    const hub = status.devices.find((d) => d.is_hub);
    setDemoSync({
      ...status,
      phase: { state: "pending" },
      notices: status.notices.filter((n) => n.kind !== "started_over"),
      pairing: hub ? { role: "asking", peer: hub.id, peer_name: hub.name, code: "305118" } : null,
      error: null,
    });
    return currentDemoSync();
  },
  async dismissSyncNotice(id: string): Promise<SyncStatus> {
    const status = currentDemoSync();
    setDemoSync({ ...status, notices: status.notices.filter((n) => n.id !== id) });
    return currentDemoSync();
  },
  async renameDevice(device: string, name: string): Promise<SyncStatus> {
    if (!name.trim()) throw new CommandError("invalid_request", "A device needs a name");
    await syncPause();
    return changeDemoDevices((devices) => devices.map((d) => (d.id === device ? { ...d, name: name.trim() } : d)));
  },
  /** A short transfer, then online again; a pause or a problem is tried again and clears. */
  async syncNow(): Promise<SyncStatus> {
    needSyncRunning();
    const status = currentDemoSync();
    if (status.phase.state === "pending") {
      setDemoSync({ ...status, error: null });
      return currentDemoSync();
    }
    setDemoSync({ ...status, phase: { state: "syncing", done: 0, total: 12 }, error: null });
    await syncPause();
    setDemoSync({ ...currentDemoSync(), phase: { state: "online" }, last_sync_at: new Date().toISOString() });
    return currentDemoSync();
  },
  async copySyncReport(): Promise<string> {
    const status = currentDemoSync();
    return ["Koona Pin sync report", "app: preview", `phase: ${JSON.stringify(status.phase)}`, `device: ${status.device.id}`, `devices: ${status.devices.length}`].join("\n");
  },
  async signOutSupporter(): Promise<SupporterStatus> {
    setDemoSupporter({ ...currentDemoSupporter(), email: null, plan: null, check_failed: false, awaiting_sign_in: false });
    return currentDemoSupporter();
  },
  // feeds — the same methods as the desktop's (NP-128), over demoFeeds.ts. Later feeds tasks add here only.
  async listFeeds(): Promise<Feed[]> {
    return demoFeedList();
  },
  async subscribeFeed(url: string, title: string | null, destination: FeedDestination): Promise<Feed> {
    const address = demoFeedUrl(url).href;
    const state = feedsState();
    if (!state.feeds.some((f) => f.url === address)) {
      const known = DEMO_FEEDS.find((f) => f.url === address);
      const uid = known?.uid ?? `demo-feed-${Date.now()}`;
      state.feeds.push({ uid, url: address, title: title?.trim() || null, destination });
      // A sample feed followed again comes back with its posts, as a first fetch would bring them.
      if (known && !state.items.some((item) => item.feed_uid === uid))
        state.items.push(...demoFeedItems(new Date().toISOString()).filter((item) => item.feed_uid === uid));
      // A demo site's feed brings its posts, as the first fetch would (NP-133).
      if (!known) state.items.push(...demoSitePosts(uid, address, Math.max(0, ...state.items.map((item) => item.id)) + 1));
      feedsChanged();
    }
    return demoFeedList().find((f) => f.url === address)!;
  },
  async updateFeed(uid: string, title: string | null, destination: FeedDestination | null): Promise<Feed> {
    const row = feedsState().feeds.find((f) => f.uid === uid);
    if (!row) throw new CommandError("not_found", "Query returned no rows");
    if (title !== null) row.title = title.trim() || null;
    if (destination !== null) row.destination = destination;
    feedsChanged();
    return demoFeedList().find((f) => f.uid === uid)!;
  },
  /** The demo's feeds never move. */
  async acceptFeedMove(uid: string): Promise<Feed> {
    void uid;
    throw new CommandError("invalid_request", "This feed has not moved");
  },
  async unsubscribeFeed(uid: string): Promise<void> {
    const state = feedsState();
    if (!state.feeds.some((f) => f.uid === uid)) throw new CommandError("not_found", "Query returned no rows");
    state.feeds = state.feeds.filter((f) => f.uid !== uid);
    state.items = state.items.filter((item) => item.feed_uid !== uid);
    feedsChanged();
  },
  /** A sample site names its feed; an address that looks like a feed is one. The preview reads no page. */
  async previewLink(url: string): Promise<LinkPreview> {
    const address = demoFeedUrl(url);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const domain = address.hostname.replace(/^www\./, "");
    const site = DEMO_FEEDS.find((f) => new URL(f.siteUrl).hostname.replace(/^www\./, "") === domain);
    const extra = demoSiteOf(address);
    const isFeed = DEMO_FEEDS.some((f) => f.url === address.href) || isFeedAddress(address);
    const feeds: FeedCandidate[] = isFeed
      ? [{ url: address.href, title: site?.feedTitle ?? extra?.feeds.find((f) => f.url === address.href)?.title ?? null, kind: address.pathname.endsWith(".json") ? "json" : "rss" }]
      : site
        ? [{ url: site.url, title: site.feedTitle, kind: "rss" }]
        : (extra?.feeds.map((f) => ({ url: f.url, title: f.title, kind: "rss" })) ?? []);
    const subscribed = feeds.length ? feedsState().feeds.find((f) => f.url === feeds[0].url) : undefined;
    return {
      url: address.href,
      metadata: {
        title: site?.feedTitle ?? (extra && !isFeed ? demoPageTitle(extra, address) : null),
        description: null,
        image_url: extra && !isFeed ? poster(extra.picture) : null,
        favicon_url: null,
        site_name: site?.feedTitle ?? extra?.name ?? null,
        domain,
      },
      feeds,
      is_feed: isFeed,
      subscribed_uid: subscribed?.uid ?? null,
    };
  },
  async previewFeed(url: string): Promise<FeedPreview> {
    const address = demoFeedUrl(url).href;
    await new Promise((resolve) => setTimeout(resolve, 400));
    const known = DEMO_FEEDS.find((f) => f.url === address);
    const site = demoFeedSite(address);
    const extra = DEMO_SITES.find((s) => s.feeds.some((f) => f.url === address));
    if (extra?.unreadable) throw new CommandError("network", "The feed could not be read");
    if (extra) return { title: site.title, site_url: extra.site, icon_url: null, posts_per_day: extra.perDay, last_post_at: hoursBefore(extra.posts[0]?.hoursAgo ?? 3) };
    if (!known) return { title: site.title, site_url: site.site, icon_url: null, posts_per_day: 2.5, last_post_at: hoursBefore(3) };
    const posts = DEMO_POSTS.filter((p) => p.feed === known.uid);
    const days = Math.max(1, Math.max(...posts.map((p) => p.hoursAgo)) / 24);
    return {
      title: known.feedTitle,
      site_url: known.siteUrl,
      icon_url: null,
      posts_per_day: Math.round((posts.length / days) * 10) / 10,
      last_post_at: hoursBefore(Math.min(...posts.map((p) => p.hoursAgo))),
    };
  },
  async listFeedItems(query: FeedItemQuery): Promise<FeedItemPage> {
    const state = feedsState();
    const followed = new Set(state.feeds.map((f) => f.uid));
    const search = query.search?.trim().toLowerCase();
    const found = state.items
      .filter(
        (item) =>
          followed.has(item.feed_uid) &&
          (!query.feed_uid || item.feed_uid === query.feed_uid) &&
          (!query.unread_only || !item.read_at) &&
          (!search || item.title.toLowerCase().includes(search) || item.excerpt.toLowerCase().includes(search)),
      )
      .sort(newestFirst);
    const start = query.after ? found.findIndex((item) => afterCursor(item, query.after!)) : 0;
    const limit = query.limit || 50;
    const page = start < 0 ? [] : found.slice(start, start + limit);
    const more = start >= 0 && start + limit < found.length;
    return { items: page.map(feedItemOf), next: more ? feedCursor(page[page.length - 1]) : null };
  },
  async getFeedArticle(id: number): Promise<FeedArticle> {
    const item = feedsState().items.find((i) => i.id === id);
    if (!item) throw new CommandError("not_found", "Query returned no rows");
    return { id, url: item.url, title: item.title, author: item.author, published_at: item.published_at, html: item.html, full: item.full };
  },
  async setFeedItemsRead(ids: number[], read: boolean): Promise<void> {
    const now = new Date().toISOString();
    for (const item of feedsState().items) if (ids.includes(item.id)) item.read_at = read ? (item.read_at ?? now) : null;
    feedsChanged();
  },
  async markFeedRead(feedUid: string | null, upTo: string | null): Promise<number> {
    const now = new Date().toISOString();
    let marked = 0;
    for (const item of feedsState().items) {
      if (item.read_at || (feedUid && item.feed_uid !== feedUid) || (upTo && item.fetched_at > upTo)) continue;
      item.read_at = now;
      marked += 1;
    }
    feedsChanged();
    return marked;
  },
  /** S, R and F: an ordinary bookmark from the feed, as `save.rs` makes it; a saved post's own bookmark gets R and F. */
  async saveFeedItem(id: number, place: SavePlace, favorite: boolean): Promise<FeedSave> {
    const state = feedsState();
    const item = state.items.find((i) => i.id === id);
    if (!item) throw new CommandError("not_found", "Query returned no rows");
    if (!item.url) throw new CommandError("invalid_request", "The post has no link", "invalid_url");
    const now = new Date().toISOString();
    const own = savedBookmark(item);
    let saved: Bookmark;
    let created = false;
    if (own) {
      const fields: Partial<Bookmark> = {
        ...(favorite && !own.is_favorite ? { is_favorite: true } : {}),
        ...(place === "reading" && !own.reading_at ? { reading_at: now } : {}),
      };
      saved = Object.keys(fields).length ? change(own, fields) : own;
      if (saved !== own) emit("updated", saved);
    } else {
      const added = await demo.addBookmark({ url: item.url, title: item.title });
      saved = added.bookmark;
      if (!added.existing && !added.restored) {
        created = true;
        const feed = demoFeedList().find((f) => f.uid === item.feed_uid);
        saved = change(saved, {
          description: item.excerpt,
          image_url: item.thumbnail_url,
          source: "feed",
          source_name: feed?.title ?? feed?.feed_title ?? undefined,
          is_favorite: favorite,
          triaged_at: place === "library" ? now : null,
          reading_at: place === "reading" ? now : null,
        });
        emit("updated", saved);
      }
    }
    item.bookmark_id = saved.id;
    item.read_at ??= now;
    feedsChanged();
    // The demo keeps no journal: nothing to undo but a bookmark it made.
    return { bookmark: saved, created, command: null };
  },
  /** A short check of the feeds asked for: progress, then everything fetched just now. */
  async refreshFeeds(feedUid: string | null): Promise<void> {
    const state = feedsState();
    const total = feedUid ? 1 : state.feeds.length;
    for (const fn of feedRefreshListeners) fn({ running: true, done: 0, total });
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (demoSwitch(DEMO_FEEDS_KEY) !== "offline") state.fetched_at = new Date().toISOString();
    for (const fn of feedRefreshListeners) fn({ running: false, done: total, total });
    feedsChanged();
  },
  /** The posts come back as a first fetch brings them; read marks and saved links are forgotten. */
  async clearFeedCache(): Promise<void> {
    const state = feedsState();
    const followed = new Set(state.feeds.map((f) => f.uid));
    state.fetched_at = new Date().toISOString();
    state.items = demoFeedItems(state.fetched_at).filter((item) => followed.has(item.feed_uid));
    feedsChanged();
  },
  /** The preview reads no file: it pretends the file held the sample feeds, two new ones and a local one. */
  async importOpml(content: string): Promise<OpmlImport> {
    void content;
    const state = feedsState();
    const listed = [...DEMO_FEEDS.map((f) => f.url), "https://notes.example.org/atom.xml", "https://links.example.net/feed.json"];
    const added = listed.filter((url) => !state.feeds.some((f) => f.url === url));
    for (const url of added) {
      const known = DEMO_FEEDS.find((f) => f.url === url);
      await demo.subscribeFeed(url, null, known?.destination ?? "feeds");
    }
    return {
      added: added.length,
      existing: listed.length - added.length,
      skipped: [{ title: "Router status", url: "http://192.168.1.1/status.rss", reason: "refused" }],
    };
  },
  async exportOpml(): Promise<OpmlExport> {
    return { outcome: "saved", file_name: "koona-pin-feeds.opml", count: feedsState().feeds.length };
  },
  async setFeedsRefreshMinutes(minutes: number): Promise<void> {
    if (minutes !== 0 && (minutes < 5 || minutes > 24 * 60))
      throw new CommandError("invalid_request", "Check feeds every 5 minutes to once a day, or only on refresh");
    try {
      localStorage.setItem(DEMO_FEEDS_REFRESH_KEY, String(minutes));
    } catch {
      /* Kept for this session only. */
    }
  },
  onFeedsChanged(fn: (change: FeedsChanged) => void) {
    feedListeners.add(fn);
    return () => {
      feedListeners.delete(fn);
    };
  },
  onFeedsRefresh(fn: (progress: FeedsRefresh) => void) {
    feedRefreshListeners.add(fn);
    return () => {
      feedRefreshListeners.delete(fn);
    };
  },
  // end feeds
};
