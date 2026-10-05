import { ext, t } from "./ext.js";
import { browserName, failure, talk } from "./native.js";
import { createQueue } from "./queue.js";
import { onMenuClicked, registerMenu } from "./menu.js";
import { GLYPHS, MARKS, BADGES, PRESS, TONES, drawIcon, frames, parseMark, parseMascot, rest, showMessage } from "./feedback.js";
const alarmName = "netamipin-delivery";
// The app counts a browser as connected while it hears from it within three
// days (NP-016); a hello twice a day keeps that true without any saving.
const helloAlarm = "netamipin-hello";
const HELLO_MINUTES = 12 * 60;
const ICONS = { 16: "icons/16.png", 32: "icons/32.png" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Both switches of «After saving» are on unless the user turned them off. */
async function preferences() {
  const { feedback, reducedMotion } = await ext.storage.local.get(["feedback", "reducedMotion"]);
  return { message: feedback?.message !== false, animate: feedback?.animate !== false && !reducedMotion };
}

// The mark and the mascot come from design/brand (the build copies them in).
let artwork;
async function art() {
  artwork ??= Promise.all(
    ["mark.svg", "mascot.svg"].map(async (file) => (await fetch(ext.runtime.getURL(file))).text()),
  ).then(([mark, mascot]) => ({ mark: parseMark(mark), mascot: parseMascot(mascot) }));
  return artwork;
}
const canvas = (size) => new OffscreenCanvas(size, size);

/** One frame of the button: for one tab, or for every tab without its own. */
async function paint(pose, title, tabId) {
  const scope = Number.isInteger(tabId) ? { tabId } : {};
  try {
    const { mark } = await art();
    const imageData = { 16: drawIcon(canvas, mark, 16, pose), 32: drawIcon(canvas, mark, 32, pose) };
    await ext.action.setIcon({ ...scope, imageData });
    if (title) await ext.action.setTitle({ ...scope, title });
  } catch {
    /* A tab may have closed since capture. */
  }
}

// A newer click on the same tab stops the older animation.
const playing = new Map();
async function play(state, title, tabId, animate) {
  const turn = (playing.get(tabId) ?? 0) + 1;
  playing.set(tabId, turn);
  for (const [pose, ms] of frames(state, animate)) {
    if (playing.get(tabId) !== turn) return;
    await paint(pose, title, tabId);
    if (ms) await sleep(ms);
  }
}

// Tabs that show «waiting» for a request: the mark turns to saved when it is
// delivered, unless the tab has loaded another page since (the browser then
// drops the tab's own icon). Kept in session storage across worker restarts.
async function waitingTabs() {
  return (await ext.storage.session.get("waitingTabs")).waitingTabs ?? {};
}
async function markWaiting(tabId, requestId) {
  await ext.storage.session.set({ waitingTabs: { ...(await waitingTabs()), [tabId]: requestId } });
}
async function forgetTab(tabId) {
  const tabs = await waitingTabs();
  if (!(tabId in tabs)) return;
  delete tabs[tabId];
  await ext.storage.session.set({ waitingTabs: tabs });
}

const outcomeState = (result) => (result.outcome === "existing" ? "existing" : "saved");
const stateTitle = (state, error) =>
  ({ saved: t("badgeSaved"), existing: t("badgeExisting"), queued: error || t("badgeWaiting"), failed: error || t("errorSaveFailed") })[state];

async function updateStatus(queue) {
  if (queue.length) {
    await ext.alarms.create(alarmName, { periodInMinutes: 1 });
    // Tabs without a mark of their own show the clock, or «!» when a link is stuck.
    const blocked = queue.some((item) => item.blocked);
    await paint(rest(blocked ? "failed" : "queued"), t("queueWaiting", queue.length));
  } else {
    await ext.alarms.clear(alarmName);
    await ext.action.setIcon({ path: ICONS }).catch(() => {});
    await ext.action.setTitle({ title: t("actionTitle") }).catch(() => {});
  }
}
const queue = createQueue({
  storage: ext.storage.local,
  changed: updateStatus,
  send: async (item) => {
    const reply = await talk({
      type: "capture",
      request_id: item.request_id,
      url: item.url,
      title: item.title,
    });
    if (!reply.ok) return { ok: false, code: reply.code, ...failure(reply) };
    await ext.storage.local.set({ lastSaved: new Date().toISOString() });
    return { ok: true, bookmark_id: reply.bookmark_id, outcome: reply.outcome };
  },
});

/**
 * Sends what waits. Without a click nothing animates (NP-080): a tab still
 * showing «waiting» for a delivered link gets its resting mark.
 */
async function deliver() {
  const results = await queue.flush();
  const tabs = await waitingTabs();
  for (const result of results) {
    const tabId = Number(Object.keys(tabs).find((id) => tabs[id] === result.request_id));
    if (!Number.isInteger(tabId)) continue;
    await forgetTab(tabId);
    const state = outcomeState(result);
    await paint(rest(state), stateTitle(state), tabId);
  }
  return results;
}
/** Tells the app this browser is here; a hello never starts a closed app. */
async function hello() {
  const reply = await talk({ type: "hello" });
  await ext.storage.local.set({ lastHello: { at: new Date().toISOString(), reply } });
  return reply;
}
async function initialize() {
  await refreshMenu();
  await ext.alarms.create(helloAlarm, { periodInMinutes: HELLO_MINUTES });
  // Versions before NP-080 wrote badge text; the marks are in the icon now.
  await ext.action.setBadgeText({ text: "" }).catch(() => {});
  await hello();
  const waiting = await queue.list();
  await updateStatus(waiting);
  if (waiting.length) await deliver();
}

/** The message on the page; browser pages refuse scripts, then the button alone answers. */
async function tell(tab, state) {
  const text = {
    saved: [t("messageSavedTitle"), t("messageSavedText")],
    existing: [t("messageExistingTitle"), t("messageExistingText")],
    queued: [t("messageQueuedTitle"), t("messageQueuedText")],
    failed: [t("messageFailedTitle"), t("messageFailedText")],
  }[state];
  try {
    const { mascot } = await art();
    const [injection] = await ext.scripting.executeScript({
      target: { tabId: tab.id },
      func: showMessage,
      args: [
        {
          state,
          title: text[0],
          text: text[1],
          label: stateTitle(state),
          mascot,
          glyph: GLYPHS[BADGES[MARKS[state]].glyph],
          tones: TONES[state],
        },
      ],
    });
    // Only the page knows whether the system asks for less motion.
    if (typeof injection?.result?.reducedMotion === "boolean")
      await ext.storage.local.set({ reducedMotion: injection.result.reducedMotion });
  } catch {
    /* chrome://, the store, PDF viewer, a closed tab. */
  }
}

async function captureTab(tab) {
  const prefs = await preferences();
  const tabId = tab.id;
  // The answer belongs to the clicked tab; every tab's icon shows only the queue.
  const onTab = Number.isInteger(tabId);
  if (onTab && prefs.animate) await paint(PRESS, t("badgeSaving"), tabId);
  else if (onTab) await ext.action.setTitle({ tabId, title: t("badgeSaving") }).catch(() => {});
  let state;
  let error;
  let code;
  let item;
  try {
    item = await queue.enqueue(tab.url || "", tab.title, tabId);
    const results = await deliver();
    const saved = results.find((result) => result.request_id === item.request_id);
    if (saved) {
      state = outcomeState(saved);
      known.set(tab.url, { saved: true, at: Date.now() });
    }
    else {
      const waiting = (await queue.list()).find((row) => row.request_id === item.request_id);
      state = waiting?.blocked ? "failed" : "queued";
      error = waiting?.error;
      code = waiting?.code;
    }
  } catch (failed) {
    state = "failed";
    error = failed.message;
  }
  if (onTab) {
    if (state === "queued") await markWaiting(tabId, item.request_id);
    else await forgetTab(tabId);
  }
  // Without the app nothing will ever be delivered: the settings page says why.
  const opensSettings = code === "host_missing";
  if (onTab && prefs.message && !opensSettings && /^https?:/.test(tab.url || "")) void tell(tab, state);
  if (onTab) await play(state, stateTitle(state, error), tabId, prefs.animate);
  if (opensSettings) await ext.runtime.openOptionsPage();
  return state;
}
// Quick search (NP-082, Р-40): the button keeps saving; the shortcut and the
// menu give it the search popup for one opening. Firefox opens a popup only
// inside the handler of the person's action, so nothing is awaited before it.
const SEARCH_COMMAND = "quick-search";
function openSearch() {
  const set = ext.action.setPopup({ popup: "search.html" });
  const opened = ext.action.openPopup();
  return Promise.allSettled([set, opened]).then(async ([, result]) => {
    await ext.action.setPopup({ popup: "" }).catch(() => {});
    return result.status === "fulfilled";
  });
}
/** The shortcut the browser has for the search now; the person may have changed it. */
async function searchShortcut() {
  const commands = (await ext.commands?.getAll?.().catch(() => [])) ?? [];
  return commands.find((command) => command.name === SEARCH_COMMAND)?.shortcut ?? "";
}
// Chrome and Edge call it contextMenus; Firefox, menus.
const menus = ext.menus ?? ext.contextMenus;
async function refreshMenu() {
  await registerMenu(menus, { settings: browserName() === "firefox", shortcut: await searchShortcut() }).catch(console.error);
}
ext.action.onClicked.addListener(captureTab);
ext.commands?.onCommand.addListener((name) => {
  if (name === SEARCH_COMMAND) void openSearch();
});
ext.commands?.onChanged?.addListener(() => void refreshMenu());
menus?.onClicked.addListener((info) => onMenuClicked(info, { openOptions: () => ext.runtime.openOptionsPage(), openSearch }));
// «Show that a page is already saved» (NP-083, Р-41): with the optional tabs
// permission the worker sees each loaded page and asks the app. A closed app
// is not started for it (the host starts it only for what the person asked):
// then there is no mark. Answers are kept a minute, so tab switches and
// reloads do not ask again.
const known = new Map();
const KNOWN_MS = 60_000;
// Pages each tab has moved to: an answer that arrives after the tab moved on
// belongs to the page before and must not mark the new one.
const pages = new Map();
const pageOf = (tabId) => pages.get(tabId) ?? 0;
async function knownEnabled() {
  const { feedback } = await ext.storage.local.get("feedback");
  return feedback?.known === true && (await ext.permissions.contains({ permissions: ["tabs"] }));
}
/** Marks the tab when its page is saved; false only when the app gave no answer. */
async function markKnown(tabId, url) {
  const page = pageOf(tabId);
  if (!/^https?:/.test(url || "") || !(await knownEnabled())) return true;
  let saved = known.get(url);
  if (!saved || Date.now() - saved.at > KNOWN_MS) {
    const reply = await talk({ type: "lookup", url });
    if (!reply.ok) return false;
    saved = { saved: reply.saved === true, at: Date.now() };
    known.set(url, saved);
    if (known.size > 500) known.delete(known.keys().next().value);
  }
  if (saved.saved && pageOf(tabId) === page) await paint(rest("existing"), stateTitle("existing"), tabId);
  return true;
}
// A new page in the tab drops its icon; a later delivery must not mark that page.
ext.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === "loading" || change.url) pages.set(tabId, pageOf(tabId) + 1);
  if (change.status === "loading") void forgetTab(tabId);
  if (change.status === "complete") void markKnown(tabId, tab?.url);
});
// Turned on: the tabs already open get their marks too. Each lookup starts a
// host process, so a few at a time: dozens at once would crowd the app's
// pipe, and a tab refused there would get no mark. Tabs on the same page
// then find the answer kept.
const LOOKUPS_AT_ONCE = 4;
ext.storage.onChanged.addListener((changes) => {
  const { newValue, oldValue } = changes.feedback ?? {};
  if (!newValue?.known || oldValue?.known) return;
  void ext.tabs.query({}).then((tabs) => {
    const lane = async () => {
      for (let tab = tabs.shift(); tab; tab = tabs.shift())
        // No answer (the app is closed, the host missing): no other tab gets one either.
        if (!(await markKnown(tab.id, tab.url))) tabs.length = 0;
    };
    return Promise.all(Array.from({ length: LOOKUPS_AT_ONCE }, lane));
  });
});
ext.tabs.onRemoved.addListener((tabId) => {
  pages.delete(tabId);
  void forgetTab(tabId);
});
ext.runtime.onInstalled.addListener(() => {
  void initialize();
});
ext.runtime.onStartup.addListener(() => {
  void initialize();
});
ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === alarmName) void deliver();
  if (alarm.name === helloAlarm) void hello();
});
ext.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    sender.id !== ext.runtime.id ||
    !sender.url?.startsWith(ext.runtime.getURL(""))
  )
    return;
  const handle = async () => {
    switch (message.type) {
      case "queue":
        return { queue: await queue.list() };
      case "remove":
        await queue.remove(message.request_id);
        return { ok: true };
      case "retry":
        await queue.retry();
        await deliver();
        return { ok: true };
      case "status": {
        const reply = await hello();
        const { lastSaved } = await ext.storage.local.get("lastSaved");
        return { reply, lastSaved: lastSaved ?? null };
      }
      default:
        throw new Error(t("errorUnknownAction"));
    }
  };
  handle()
    .then(respond)
    .catch((error) => respond({ error: error.message }));
  return true;
});
// Recreate the alarm after worker restarts: Chrome does not guarantee its persistence.
void queue.list().then(updateStatus).catch(console.error);
// Chrome and Edge change shortcuts on their own page and say nothing: the
// menu takes the current one whenever the worker wakes.
void refreshMenu();
