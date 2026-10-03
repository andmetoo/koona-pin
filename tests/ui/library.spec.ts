import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("netamipin.demo.v1"));
  await page.reload();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
});
test("hover keeps card and preview geometry stable", async ({ page }) => {
  const card = page.locator('[data-bookmark-id="1"]');
  const before = await card.boundingBox();
  const image = await card.locator(".study-preview-link").boundingBox();
  await card.hover();
  await page.waitForTimeout(220);
  expect(await card.boundingBox()).toEqual(before);
  expect(await card.locator(".study-preview-link").boundingBox()).toEqual(
    image,
  );
});
test("search, favorites and list view", async ({ page }) => {
  await page
    .getByRole("textbox", { name: "Поиск в библиотеке" })
    .fill("АРХИТЕКТУРА");
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
  await page.getByRole("textbox", { name: "Поиск в библиотеке" }).fill("");
  await page.getByRole("button", { name: "Избранное 2" }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(2);
  await page.getByRole("button", { name: "Список", exact: true }).click();
  await expect(page.locator(".study-bookmarks--list")).toBeVisible();
});
test("dialog restores focus and editor persists collection clearing", async ({
  page,
}) => {
  const add = page.getByRole("button", {
    name: "Добавить ссылку",
    exact: true,
  });
  await add.click();
  await page.keyboard.press("Escape");
  await expect(add).toBeFocused();
  await page.locator('[data-bookmark-id="1"] summary').click();
  await page
    .getByRole("button", { name: "Редактировать", exact: true })
    .click();
  await page.getByLabel("Коллекция", { exact: true }).selectOption("");
  await page.getByRole("button", { name: "Сохранить изменения" }).click();
  await expect(page.locator('[data-bookmark-id="1"] footer')).toContainText(
    "Без коллекции",
  );
});
for (const width of [800, 1200, 1600])
  test(`layout at ${width}px and both themes`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 800 ? 550 : 800 });
    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    for (const theme of ["light", "dark"]) {
      await page.getByLabel("Тема", { exact: true }).selectOption(theme);
      await expect(page.locator("html")).toHaveAttribute(
        "data-study-theme",
        theme,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
      ).toBe(false);
    }
    await page.keyboard.press("Escape");
    await page.screenshot({ path: `test-results/library-${width}.png` });
  });
test("incoming capture preserves reading position until explicitly revealed", async ({
  page,
}) => {
  await page.evaluate(() => {
    document.querySelector(".study-main-scroll")!.scrollTop = 180;
  });
  const before = await page
    .locator(".study-main-scroll")
    .evaluate((el) => el.scrollTop);
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const incoming = await api.addBookmark({
      url: "https://example.com/incoming",
      title: "Incoming capture",
    });
    await api.updateBookmark(incoming.id, {
      notes: "Метаданные поступили до следующего кадра",
    });
  });
  await expect(
    page.getByRole("button", { name: "Новые закладки · 1" }),
  ).toBeVisible();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
  expect(
    await page.locator(".study-main-scroll").evaluate((el) => el.scrollTop),
  ).toBe(before);
  await page.getByRole("button", { name: "Новые закладки · 1" }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(7);
  expect(
    await page.locator(".study-main-scroll").evaluate((el) => el.scrollTop),
  ).toBe(0);
});
test("metadata updates keep order and filtered captures stay out of the list", async ({
  page,
}) => {
  const ids = await page
    .locator("[data-bookmark-id]")
    .evaluateAll((elements) =>
      elements.map((e) => e.getAttribute("data-bookmark-id")),
    );
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    await api.updateBookmark(3, { notes: "Updated asynchronously" });
  });
  expect(
    await page
      .locator("[data-bookmark-id]")
      .evaluateAll((elements) =>
        elements.map((e) => e.getAttribute("data-bookmark-id")),
      ),
  ).toEqual(ids);
  await page.getByRole("button", { name: "Избранное 2" }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(2);
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    await api.addBookmark({
      url: "https://example.com/not-a-favorite",
      title: "Not a favorite",
    });
  });
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(2);
});
test("an older search response cannot replace the current query", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const original = api.getBookmarks;
    api.getBookmarks = async (filters) => {
      const rows = await original(filters);
      if (filters?.search === "Архитектура")
        await new Promise((resolve) => setTimeout(resolve, 450));
      return rows;
    };
  });
  await page
    .getByRole("textbox", { name: "Поиск в библиотеке" })
    .fill("Архитектура");
  await page.waitForTimeout(190);
  await page
    .getByRole("textbox", { name: "Поиск в библиотеке" })
    .fill("Типографика");
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
  await page.waitForTimeout(500);
  await expect(page.locator('[data-bookmark-id="3"]')).toBeVisible();
});

test("list geometry stays within the window and broken previews keep their space", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const data = {
      bookmarks: await api.getBookmarks(),
      collections: await api.getCollections(),
    };
    data.bookmarks[0].preview_kind = null;
    data.bookmarks[0].image_url = "/broken-preview.png";
    data.bookmarks[0].title = "Очень длинный заголовок ".repeat(12);
    localStorage.setItem("netamipin.demo.v1", JSON.stringify(data));
  });
  await page.reload();
  await expect(
    page.locator('[data-bookmark-id="1"] .bookmark-fallback'),
  ).toBeVisible();
  await page.getByRole("button", { name: "Список", exact: true }).click();
  const preview = await page
    .locator('[data-bookmark-id="1"] .study-preview-link')
    .boundingBox();
  expect(preview?.width).toBe(130);
  expect(
    await page
      .locator(".study-main-scroll")
      .evaluate((el) => el.scrollWidth > el.clientWidth),
  ).toBe(false);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page
      .locator('[data-bookmark-id="1"]')
      .evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe("0s");
});

test("save errors preserve entered data and HTML import skips duplicate and unsupported links", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const original = api.addBookmark;
    let failed = false;
    api.addBookmark = async (data) => {
      if (!failed) {
        failed = true;
        throw new Error("Не удалось записать ссылку");
      }
      return original(data);
    };
  });
  await page
    .getByRole("button", { name: "Добавить ссылку", exact: true })
    .click();
  await page
    .getByLabel("Ссылка", { exact: true })
    .fill("https://example.com/new-link");
  await page.getByLabel("Название", { exact: true }).fill("Моя находка");
  await page.getByRole("button", { name: "Сохранить ссылку" }).click();
  await expect(page.getByRole("alert")).toContainText("Не удалось записать");
  await expect(page.getByLabel("Название", { exact: true })).toHaveValue(
    "Моя находка",
  );
  await page.getByRole("button", { name: "Сохранить ссылку" }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(7);
  await page.getByRole("button", { name: "Импорт", exact: true }).click();
  await page.locator("input[type=file]").setInputFiles({
    name: "bookmarks.html",
    mimeType: "text/html",
    buffer: Buffer.from(
      '<a href="https://example.com/new-link">Duplicate</a><a href="https://example.com/imported">Импортировано</a><a href="javascript:alert(1)">Unsupported</a>',
    ),
  });
  await page
    .getByRole("button", { name: "Импортировать", exact: true })
    .click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(8);
  await expect(page.getByRole("status")).toContainText("Новых ссылок: 1");
});
