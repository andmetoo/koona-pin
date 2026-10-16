import { test, expect, type Page } from "@playwright/test";

// Following a site from «New link» (NP-133): the page's real preview, the feed offer with
// «Follow» off by default, «Save and follow», a bare feed, the feeds' notifications and OPML.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("fresh")) return;
    sessionStorage.setItem("fresh", "1");
    localStorage.removeItem("koonapin.demo.v4");
    localStorage.removeItem("koonapin.demo.feeds.v1");
    localStorage.removeItem("koonapin.demo.feeds");
  });
  await page.goto("/");
  await expect(page.locator("[data-bookmark-id]").first()).toBeVisible();
  // Every call the sheet makes to the backend, by name and arguments.
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const w = window as unknown as { calls: string[] };
    w.calls = [];
    const methods = api as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const name of ["previewLink", "previewFeed", "subscribeFeed", "addBookmark"]) {
      const original = methods[name].bind(api);
      methods[name] = (...args) => {
        w.calls.push(`${name} ${args.map((a) => JSON.stringify(a)).join(" ")}`);
        return original(...args);
      };
    }
  });
});

const sheet = (page: Page) => page.getByRole("dialog", { name: "Add link" });
const field = (page: Page) => sheet(page).getByRole("textbox", { name: "Link" });
const offer = (page: Page) => sheet(page).locator("[data-feed-offer]");
const calls = (page: Page, name?: string) =>
  page.evaluate((name) => (window as unknown as { calls: string[] }).calls.filter((c) => !name || c.startsWith(`${name} `)), name);
const open = async (page: Page, link: string) => {
  await page.getByRole("complementary").getByRole("button", { name: "New link", exact: true }).click();
  await field(page).fill(link);
};

test("a page with a feed: its real title, «Follow» off, and saving makes exactly one request", async ({ page }) => {
  await open(page, "fieldnotes.example.com/walking-the-old-railway");
  const preview = sheet(page).locator("[data-add-preview=new]");
  await expect(preview).toContainText("Walking the old railway");
  await expect(preview.locator("img")).toHaveAttribute("src", /^data:image\/svg/);
  await expect(offer(page)).toContainText("Field Notes has a feed");
  await expect(offer(page)).toHaveAttribute("data-feed-offer", "off");
  await expect(sheet(page).getByRole("switch", { name: "Follow Field Notes" })).toHaveAttribute("aria-checked", "false");
  await expect(sheet(page).getByRole("button", { name: "Save link" })).toBeVisible();
  await expect(sheet(page).getByRole("group", { name: "New posts go to" })).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.locator("[data-bookmark-id]").first()).toContainText("fieldnotes.example.com");
  // The page once, after the address settled; the feed never; no subscription.
  expect(await calls(page, "previewLink")).toEqual(['previewLink "https://fieldnotes.example.com/walking-the-old-railway"']);
  expect(await calls(page, "previewFeed")).toEqual([]);
  expect(await calls(page, "subscribeFeed")).toEqual([]);
});

test("typing asks only once the address stops changing; going back to it asks nothing more", async ({ page }) => {
  await open(page, "fieldnotes.example.com/a");
  await field(page).pressSequentially("bc", { delay: 100 });
  await expect(offer(page)).toContainText("Field Notes has a feed");
  expect(await calls(page, "previewLink")).toEqual(['previewLink "https://fieldnotes.example.com/abc"']);
  await field(page).press("Backspace");
  await expect(sheet(page).locator("[data-add-preview=new]")).toContainText("Ab");
  await field(page).pressSequentially("c");
  await expect(sheet(page).locator("[data-add-preview=new]")).toContainText("Abc");
  await page.waitForTimeout(600);
  expect(await calls(page, "previewLink")).toEqual(['previewLink "https://fieldnotes.example.com/abc"', 'previewLink "https://fieldnotes.example.com/ab"']);
});

test("«Save and follow» saves the bookmark, then follows the feed; its posts are there", async ({ page }) => {
  await open(page, "https://fieldnotes.example.com/");
  await sheet(page).getByRole("switch", { name: "Follow Field Notes" }).click();
  await expect(offer(page)).toContainText(/About 4 new posts a day · last one 2 hr\. ago/);
  const places = sheet(page).getByRole("group", { name: "New posts go to" });
  await expect(places.getByRole("button", { name: "Feeds only" })).toHaveAttribute("aria-pressed", "true");
  await places.getByRole("button", { name: "Also notify me" }).click();
  await sheet(page).getByRole("button", { name: "Save and follow" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect.poll(() => calls(page, "subscribeFeed")).toEqual(['subscribeFeed "https://fieldnotes.example.com/feed.xml" null "notify"']);
  // One request to the page, one to the feed; the bookmark before the subscription.
  const all = await calls(page);
  expect(all.filter((c) => c.startsWith("preview"))).toEqual(['previewLink "https://fieldnotes.example.com/"', 'previewFeed "https://fieldnotes.example.com/feed.xml"']);
  expect(all.findIndex((c) => c.startsWith("addBookmark"))).toBeLessThan(all.findIndex((c) => c.startsWith("subscribeFeed")));
  const followed = await page.evaluate(async () => {
    const { listFeeds } = await import("/src/services/feeds.ts");
    return (await listFeeds()).find((f) => f.url === "https://fieldnotes.example.com/feed.xml");
  });
  expect(followed).toMatchObject({ feed_title: "Field Notes", destination: "notify", total: 2, unread: 2 });
});

test("a bare feed address: «Follow <title>», no bookmark", async ({ page }) => {
  const before = await page.locator("[data-bookmark-id]").count();
  await open(page, "https://fieldnotes.example.com/feed.xml");
  await expect(offer(page)).toContainText("Follow Field Notes");
  await expect(offer(page)).toContainText("About 4 new posts a day");
  await expect(sheet(page).getByRole("button", { name: "Library", exact: true })).toHaveCount(0);
  await expect(sheet(page).getByRole("button", { name: "Title and tags" })).toHaveCount(0);
  await sheet(page).getByRole("button", { name: "Follow", exact: true }).click();
  await expect(sheet(page)).toHaveCount(0);
  expect(await calls(page, "subscribeFeed")).toEqual(['subscribeFeed "https://fieldnotes.example.com/feed.xml" null "feeds"']);
  expect(await calls(page, "addBookmark")).toEqual([]);
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(before);
});

test("several feeds: the first, and a list to switch", async ({ page }) => {
  await open(page, "smallbatch.example.com");
  const pick = sheet(page).getByRole("combobox", { name: "Which feed" });
  await expect(pick).toHaveValue("0");
  await pick.selectOption({ label: "Small Batch — comments" });
  await sheet(page).getByRole("switch", { name: "Follow Small Batch — comments" }).click();
  await expect(offer(page)).toContainText("About 3 new posts a week");
  await sheet(page).getByRole("button", { name: "Save and follow" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect.poll(() => calls(page, "subscribeFeed")).toEqual(['subscribeFeed "https://smallbatch.example.com/comments.rss" null "feeds"']);
});

test("a site already followed says so; a feed that can't be read falls back to «Save link»", async ({ page }) => {
  await open(page, "https://www.theverge.com/2026/10/some-story");
  await expect(offer(page)).toHaveAttribute("data-feed-offer", "followed");
  await expect(offer(page)).toContainText("You follow this site");
  await expect(sheet(page).getByRole("switch")).toHaveCount(0);

  await field(page).fill("quiet.example.com");
  await sheet(page).getByRole("switch", { name: "Follow Quiet Corner" }).click();
  await expect(offer(page)).toContainText("This feed can’t be read");
  await expect(offer(page)).toHaveAttribute("data-feed-offer", "unreadable");
  await expect(sheet(page).getByRole("button", { name: "Save link" })).toBeVisible();
  await expect(sheet(page).getByRole("group", { name: "New posts go to" })).toHaveCount(0);
});

test("feeds that notify: «N new posts», their names and Read; a feed failing for a week: Show and Unfollow", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("koonapin.demo.feeds", "failing"));
  await page.reload();
  await expect(page.locator("[data-bookmark-id]").first()).toBeVisible();
  await page.evaluate(async () => {
    const { mount } = await import("/tests/ui/fixtures/feedNotifications.tsx");
    await mount();
  });
  const bell = page.locator("[data-feeds-fixture] [data-notification-bell]");
  await expect(bell).toHaveAccessibleName("Notifications, 2 new");
  await bell.click();
  const centre = page.getByRole("dialog", { name: "Notifications" });
  const feeds = centre.locator("[data-notification=feeds]");
  await expect(feeds).toContainText("3 new posts");
  await expect(feeds).toContainText("from Serious Eats");
  await expect(feeds.locator(".nt-thumb")).toHaveCount(1);
  const problem = centre.locator("[data-notification=problem]");
  await expect(problem).toContainText("Ars Technica isn’t updating");
  await expect(problem.getByRole("button", { name: "Unfollow" })).toBeVisible();
  await feeds.getByRole("button", { name: "Read" }).click();
  await bell.click();
  await centre.locator("[data-notification=problem]").getByRole("button", { name: "Show" }).click();
  await bell.click();
  await centre.locator("[data-notification=problem]").getByRole("button", { name: "Unfollow" }).click();
  expect(await page.evaluate(() => (window as unknown as { feedCalls: string[] }).feedCalls)).toEqual([
    "read:demo-feed-eats",
    "show:demo-feed-ars",
    "unfollow:demo-feed-ars",
  ]);
});

test("More → «Import feeds (OPML)…» takes an OPML file and follows its feeds", async ({ page }) => {
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Import feeds (OPML)…" }).click();
  // App opens it for feeds (NP-132): titled «Import feeds» from the start.
  const dialog = page.getByRole("dialog", { name: "Import feeds" });
  await expect(dialog.locator("input[type=file]")).toHaveAttribute("accept", /\.opml,\.xml/);
  const opml = `<?xml version="1.0"?><opml version="2.0"><head><title>Reader</title></head><body>
    <outline text="Tech"><outline type="rss" text="Ars" xmlUrl="https://feeds.arstechnica.com/arstechnica/index"/>
    <outline type="rss" text="Notes" xmlUrl="https://notes.example.org/atom.xml"/></outline>
    <outline text="Links" xmlUrl="https://links.example.net/feed.json"/></body></opml>`;
  await dialog.locator("input[type=file]").setInputFiles({ name: "feeds.opml", mimeType: "text/x-opml", buffer: Buffer.from(opml) });
  const feeds = page.getByRole("dialog", { name: "Import feeds" });
  await expect(feeds).toContainText("3 feeds");
  await expect(feeds).toContainText("New posts go to Feeds");
  await expect(feeds.getByRole("radiogroup")).toHaveCount(0);
  await feeds.getByRole("button", { name: "Import", exact: true }).click();
  const done = page.getByRole("dialog", { name: "Import finished" });
  await expect(done.getByRole("status")).toHaveText("Following 2 new feeds");
  await expect(done).toContainText("Already followed — left as they were");
  await done.getByRole("button", { name: "Show the skipped addresses" }).click();
  await expect(done).toContainText("Router status — On this computer or the local network");
});
