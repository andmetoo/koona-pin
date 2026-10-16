import { test, expect, type Page } from "@playwright/test";

// Sync between a Supporter's computers (NP-059, NP-063, sheet 46), in the demo: `koonapin.demo.sync`
// starts the preview in a state of sync (src/services/demo.ts) so every screen is seen without a relay.
async function start(page: Page, sync: string | null, supporter: string | null = "supporter") {
  await page.goto("/");
  await page.evaluate(
    ([s, p]) => {
      localStorage.removeItem("koonapin.demo.v4");
      if (s) localStorage.setItem("koonapin.demo.sync", s);
      else localStorage.removeItem("koonapin.demo.sync");
      if (p) localStorage.setItem("koonapin.demo.supporter", p);
      else localStorage.removeItem("koonapin.demo.supporter");
    },
    [sync, supporter],
  );
  await page.reload();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
}
/** The Sync dialog from the perk of the Supporter dialog, as a person opens it. */
async function openSync(page: Page) {
  await page.locator("[data-plan-row]").click();
  const plan = page.getByRole("dialog", { name: "Supporter" });
  await plan.locator("li", { hasText: "Sync, Reading included" }).getByRole("button").click();
  return page.getByRole("dialog");
}

test("Sync: the perk of the Supporter dialog turns sync on; this computer becomes the main one (frames 01, 02, 03)", async ({ page }) => {
  await start(page, null);
  await page.locator("[data-plan-row]").click();
  const plan = page.getByRole("dialog", { name: "Supporter" });
  const perk = plan.locator("li", { hasText: "Sync, Reading included" });
  await expect(perk.locator("[data-sync-perk]")).toHaveAttribute("data-sync-perk", "off");
  await expect(perk).toContainText("Koona's server keeps none of your library");
  // Every perk works already: none of them says «Soon».
  await expect(plan.getByText("Soon")).toHaveCount(0);
  await perk.getByRole("button", { name: "Set up…" }).click();
  const setup = page.getByRole("dialog", { name: "Sync" });
  await expect(setup.locator("[data-sync-view]")).toHaveAttribute("data-sync-view", "setup");
  // The account has no main computer yet: this one becomes it.
  await expect(setup.locator("[data-sync-account]")).toHaveAttribute("data-sync-account", "main");
  await expect(setup.locator("[data-sync-account]")).toContainText("This computer becomes the main one");
  await expect(setup).not.toContainText("Sync already on at another computer?");
  await expect(setup).toContainText("Encrypted on your computers before it leaves them.");
  await setup.getByLabel("This computer's name").fill("Desk iMac");
  await setup.getByRole("button", { name: "Turn on sync" }).click();
  await expect(setup.locator("[data-sync-view]")).toHaveAttribute("data-sync-view", "overview");
  await expect(setup.locator('[data-sync-device="Desk iMac"]')).toContainText("Main");
  await expect(setup.locator('[data-sync-banner="online"]')).toContainText("Synced just now");
  await expect(setup.locator('[data-sync-device="Desk iMac"]')).toContainText("macOS · Koona Pin");
  await expect(setup).toContainText("Add a computer");
  await setup.getByRole("button", { name: "Done" }).click();
  await page.locator("[data-plan-row]").click();
  await expect(plan.locator("[data-sync-perk]")).toHaveAttribute("data-sync-perk", "ok");
  await expect(plan.locator("[data-sync-perk]")).toContainText("Synced · 1 computer · just now");
  await expect(plan.getByRole("button", { name: "Manage…" })).toBeVisible();
});

test("Sync: Settings → Data has its row with Supporter, «Learn more» without, nothing in a build that sells nothing (frame 10)", async ({ page }) => {
  const settings = () => page.getByRole("button", { name: "Settings" }).first().click();
  await start(page, "on", null);
  await settings();
  await expect(page.locator("[data-sync-settings]")).toHaveCount(0);

  await start(page, "on", "free");
  await settings();
  const free = page.locator('[data-sync-settings="free"]');
  await expect(free).toContainText("Sync — with Supporter");
  await free.getByRole("button", { name: "Learn more" }).click();
  await expect(page.getByRole("dialog", { name: "Support Koona Pin" })).toBeVisible();

  await start(page, "on");
  await settings();
  const row = page.locator('[data-sync-settings="supporter"]');
  await expect(row).toContainText("On · 3 computers · synced just now");
  await row.getByRole("button", { name: "Manage…" }).click();
  await expect(page.getByRole("dialog", { name: "Sync" }).locator("[data-sync-view]")).toHaveAttribute("data-sync-view", "overview");
});

test("Sync: on the main computer — rename this one, remove another after a confirmation, details and the report (frames 03, 08, 09)", async ({ page }) => {
  await start(page, "on");
  const dialog = await openSync(page);
  await expect(dialog.locator("[data-sync-hub]")).toBeVisible();
  await expect(dialog.locator('[data-sync-banner="online"]')).toContainText("Synced just now");
  await expect(dialog.locator('[data-sync-banner="online"]')).toContainText("3 computers · 12,480 bookmarks");
  await expect(dialog.locator('[data-sync-device="Home iMac"]')).toContainText("macOS · Koona Pin 0.13.0");
  await expect(dialog.locator('[data-sync-device="Office laptop"]')).toContainText("Windows · online");
  await expect(dialog.locator('[data-sync-device="Studio PC"]')).toContainText("Linux · last seen 3 hours ago");
  // No menus: the buttons are on the rows.
  await dialog.locator('[data-sync-device="Home iMac"]').getByRole("button", { name: "Rename…" }).click();
  await dialog.getByLabel("New name of Home iMac").fill("Home Mac mini");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.locator('[data-sync-device="Home Mac mini"]')).toContainText("Main");

  await dialog.locator('[data-sync-device="Studio PC"]').getByRole("button", { name: "Remove…" }).click();
  const remove = page.getByRole("dialog", { name: "Remove Studio PC?" });
  await expect(remove).toContainText("Your other computers get a new key");
  await remove.getByRole("button", { name: "Keep" }).click();
  await expect(dialog.locator('[data-sync-device="Studio PC"]')).toBeVisible();
  await dialog.locator('[data-sync-device="Studio PC"]').getByRole("button", { name: "Remove…" }).click();
  await page.getByRole("dialog", { name: "Remove Studio PC?" }).getByRole("button", { name: "Remove" }).click();
  const overview = page.getByRole("dialog", { name: "Sync" });
  await expect(overview.locator('[data-sync-device="Studio PC"]')).toHaveCount(0);

  await overview.getByRole("button", { name: "Details" }).click();
  const details = page.getByRole("dialog", { name: "Sync details" });
  await expect(details).toContainText("Main computer");
  await expect(details.locator('[data-sync-detail="state"]')).toContainText(/Online · synced \d/);
  await expect(details.locator('[data-sync-detail="this"]')).toContainText("Home Mac mini · 0f8e…6f70");
  await expect(details.locator('[data-sync-detail="clock"]')).toContainText("+0.4 sec against the server");
  await expect(details.locator('[data-sync-detail="key"]')).toContainText("Encryption key");
  await expect(details.locator('[data-sync-detail="key"]')).toContainText("Generation 2");
  await expect(details).toContainText("What each computer has");
  await expect(details.locator("[data-sync-detail^='device:']")).toHaveCount(1);
  // Its last sync was 2 minutes ago: just after midnight that is «yesterday 11:59 PM».
  await expect(details.locator("[data-sync-detail^='device:']")).toContainText(/Office laptop\s*up to (\d|yesterday \d)/);
  await expect(details).not.toContainText("Last sync");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await details.getByRole("button", { name: "Copy report" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Copied" })).toBeVisible();
  await details.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("dialog", { name: "Sync" }).locator("[data-sync-view]")).toHaveAttribute("data-sync-view", "overview");
});

test("Sync: another computer, the main one away for days — make this the main one by starting over with the email code (frames 04, 13)", async ({ page }) => {
  await start(page, "start_over");
  const dialog = await openSync(page);
  await expect(dialog.locator('[data-sync-banner="online:main_offline"]')).toContainText("Home iMac, the main computer, is offline.");
  await expect(dialog.locator('[data-sync-device="Home iMac"]')).toContainText("Main");
  await expect(dialog).toContainText("Only the main computer adds and removes computers.");
  await expect(dialog.getByRole("button", { name: "Remove…" })).toHaveCount(0);
  await expect(dialog).toContainText("Main is offline — by email");
  await dialog.getByRole("button", { name: "Make this the main computer" }).click();
  const startOver = page.getByRole("dialog", { name: "Start over from this computer?" });
  await expect(startOver).toContainText("Home iMac, the main computer, hasn't been online for 12 days.");
  await expect(startOver).toContainText("Nothing is deleted.");
  const code = startOver.getByLabel("Code from the email to anna@example.com");
  await code.fill("000000");
  await startOver.getByRole("button", { name: "Start over" }).click();
  await expect(startOver.getByRole("alert")).toContainText("This code didn't work.");
  // The relay refuses a sign-in too old after the command returned: the dialog waits for it, says
  // so and asks for a new code.
  await code.fill("111111");
  await startOver.getByRole("button", { name: "Start over" }).click();
  await expect(startOver.getByRole("alert")).toBeVisible();
  await expect(startOver.getByRole("alert")).not.toContainText("This code didn't work.");
  await expect(code).toHaveValue("");
  await code.fill("482913");
  await startOver.getByRole("button", { name: "Start over" }).click();
  const overview = page.getByRole("dialog", { name: "Sync" });
  await expect(overview.locator("[data-sync-hub]")).toBeVisible();
  await expect(overview.locator('[data-sync-device="Office laptop"]')).toContainText("Main");
});

test("Sync: the main computer approves a new one by its code; the new one waits, is rejected and tries again, receives the library (frames 05, 06, 07)", async ({ page }) => {
  // The dialog opens by itself on the main computer.
  await start(page, "pairing");
  const join = page.getByRole("dialog", { name: "Office laptop wants to join" });
  await expect(join.locator("[data-sync-code]")).toHaveText("482 913");
  await join.getByRole("button", { name: "Codes match" }).click();
  const overview = page.getByRole("dialog", { name: "Sync" });
  await expect(overview.locator('[data-sync-device="Office laptop"]')).toContainText("Windows · online");
  // Closed, it does not come back for the same request.
  await overview.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await start(page, "pending");
  const waiting = await openSync(page);
  await expect(waiting).toHaveAccessibleName("Waiting for Home iMac");
  await expect(waiting.locator("[data-sync-code]")).toHaveText("482 913");
  await expect(waiting).toContainText("Your bookmarks on this computer are kept and merged.");
  await waiting.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.locator("[data-plan-row]").click();
  await expect(page.locator("[data-sync-perk]")).toHaveAttribute("data-sync-perk", "off");

  await start(page, "receiving");
  const receiving = await openSync(page);
  await expect(receiving).toContainText("Receiving the library from Home iMac…");
  await expect(receiving).toContainText("4,210 of 12,480 changes");
  await expect(receiving.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "4210");
  await receiving.getByRole("button", { name: "Hide" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // A rejected computer tries again.
  await start(page, "rejected");
  const rejected = await openSync(page);
  const banner = rejected.locator('[data-sync-banner="problem:pairing_rejected"]');
  await expect(banner).toContainText("Home iMac didn't approve this computer");
  await banner.getByRole("button", { name: "Try again" }).click();
  await expect(banner).toHaveCount(0);
});

test("Sync: the main computer allows or denies handing over (frame 12)", async ({ page }) => {
  await start(page, "main_asked");
  const asked = page.getByRole("dialog", { name: "Make Office laptop the main computer?" });
  await expect(asked).toContainText("After this, Home iMac is an ordinary computer and keeps syncing.");
  await asked.getByRole("button", { name: "Allow" }).click();
  const overview = page.getByRole("dialog", { name: "Sync" });
  await expect(overview.locator('[data-sync-device="Office laptop"]')).toContainText("Main");
  await expect(overview.locator("[data-sync-hub]")).toHaveCount(0);

  await start(page, "main_asked");
  await page.getByRole("dialog", { name: "Make Office laptop the main computer?" }).getByRole("button", { name: "Deny" }).click();
  await expect(page.getByRole("dialog", { name: "Sync" }).locator("[data-sync-hub]")).toBeVisible();

  // On the asking computer: the request waits for the main one.
  await start(page, "asking_main");
  const asking = await openSync(page);
  await expect(asking.locator('[data-sync-banner="hub_change:asking"]')).toContainText("Waiting for Home iMac");
});

// The words of each banner are checked in src/components/commercial/syncText.test.ts.
test("Sync: every state has its banner and the action it offers (frame 11)", async ({ page }) => {
  for (const [state, id, action] of [
    ["offline", "paused:offline", null],
    ["others_offline", "online:others_offline", null],
    ["added", "notice:device_added", "Review"],
    ["skew", "paused:clock_skew", "Try again"],
    ["update", "paused:update_needed", "Update"],
    ["started_over", "notice:started_over", "Join…"],
    ["revoked", "paused:revoked", "Add again"],
    ["signed_out", "paused:signed_out", "Sign in…"],
    ["syncing", "syncing", null],
  ] as const) {
    await start(page, state);
    const dialog = await openSync(page);
    const banner = dialog.locator(`[data-sync-banner="${id}"]`);
    await expect(banner, state).toBeVisible();
    if (action) await expect(banner.getByRole("button", { name: action }), state).toBeVisible();
    else await expect(banner.getByRole("button"), state).toHaveCount(0);
  }
  // The newer version is named by the computer that has it.
  await start(page, "update");
  let dialog = await openSync(page);
  await expect(dialog.locator('[data-sync-banner="paused:update_needed"]')).toContainText("Home iMac has a newer version.");
  await expect(dialog.locator('[data-sync-device="Office laptop"]')).toContainText("Windows · Koona Pin 0.12.0");
  // «Review» marks the computer added and the notice goes.
  await start(page, "added");
  dialog = await openSync(page);
  await dialog.locator('[data-sync-banner="notice:device_added"]').getByRole("button", { name: "Review" }).click();
  await expect(dialog.locator('[data-sync-banner="notice:device_added"]')).toHaveCount(0);
  await expect(dialog.locator('[data-sync-device="Studio PC"]')).toHaveAttribute("data-highlight", "true");
  // «Join…» pairs this computer with the new main one.
  await start(page, "started_over");
  dialog = await openSync(page);
  await dialog.getByRole("button", { name: "Join…" }).click();
  await expect(page.getByRole("dialog", { name: "Waiting for Studio PC" }).locator("[data-sync-code]")).toHaveText("305 118");
  // A plan that ends within a month: «Sync stops on…».
  await start(page, "on", "canceling");
  dialog = await openSync(page);
  await expect(dialog.locator('[data-sync-banner="plan_ends"]')).toContainText("Sync stops on");
});

test("Sync: on a second computer the first screen names the main one; turning on waits for it (frames 14, 06)", async ({ page }) => {
  await start(page, "off_join");
  const setup = await openSync(page);
  await expect(setup.locator("[data-sync-view]")).toHaveAttribute("data-sync-view", "setup");
  await expect(setup.locator("[data-sync-account]")).toHaveAttribute("data-sync-account", "join");
  await expect(setup.locator("[data-sync-account]")).toHaveText(
    "Home iMac is your main computer. Turn on sync here, then confirm the code on Home iMac. Bookmarks on this computer stay and merge in.",
  );
  await expect(setup.getByText(/^This computer becomes the main one/)).toBeHidden();
  await expect(setup.getByLabel("This computer's name")).toHaveValue("Office laptop");
  await setup.getByRole("button", { name: "Turn on sync" }).click();
  const waiting = page.getByRole("dialog", { name: "Waiting for Home iMac" });
  await expect(waiting.locator("[data-sync-code]")).toHaveText("482 913");
  // Cancelled, the account still has its main computer.
  await waiting.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const again = await openSync(page);
  await expect(again.locator("[data-sync-account]")).toHaveAttribute("data-sync-account", "join");
});

test("Sync: the first screen keeps both possibilities while asking, and when the account can't be asked (frame 02)", async ({ page }) => {
  await start(page, null, "offline");
  const setup = await openSync(page);
  const lead = setup.locator("[data-sync-account]");
  await expect(lead).toHaveAttribute("data-sync-account", "unknown");
  await expect(lead).toContainText("The main computer approves this one with a code.");
  await expect(setup.getByRole("button", { name: "Turn on sync" })).toBeEnabled();

  // While the answer is on its way the lead is neutral and keeps its place.
  await start(page, "off_join");
  await page.evaluate(async () => {
    // A relay that takes its time: the answer waits for release().
    const { api } = await import("/src/services/api.ts");
    const ask = api.getSyncAccount.bind(api);
    const w = window as unknown as { release: () => void };
    api.getSyncAccount = () => new Promise((resolve) => (w.release = () => resolve(ask())));
  });
  const open = await openSync(page);
  const asking = open.locator("[data-sync-account]");
  await expect(asking).toHaveAttribute("data-sync-account", "loading");
  await expect(asking).toContainText("The main computer approves this one with a code.");
  await open.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  const before = await open.getByLabel("This computer's name").boundingBox();
  await page.evaluate(() => (window as unknown as { release: () => void }).release());
  await expect(asking).toHaveAttribute("data-sync-account", "join");
  const after = await open.getByLabel("This computer's name").boundingBox();
  expect(after?.y).toBe(before?.y);
});
