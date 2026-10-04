import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("netamipin.demo.v4"));
  await page.reload();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
});
test("hover keeps card and preview geometry stable", async ({ page }) => {
  const card = page.locator('[data-bookmark-id="1"]');
  const before = await card.boundingBox();
  const image = await card.locator("[data-preview]").boundingBox();
  await card.hover();
  await page.waitForTimeout(220);
  expect(await card.boundingBox()).toEqual(before);
  expect(await card.locator("[data-preview]").boundingBox()).toEqual(image);
});
test("search, favorites and list view", async ({ page }) => {
  await page.getByRole("textbox", { name: "Поиск в библиотеке" }).fill("АРХИТЕКТУРА");
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
  await page.getByRole("textbox", { name: "Поиск в библиотеке" }).fill("");
  await page.getByRole("button", { name: "Избранное 2" }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(2);
  await page.getByRole("button", { name: "Список", exact: true }).click();
  await expect(page.locator('[data-view="list"]')).toBeVisible();
});
test("dialog restores focus and editor persists collection clearing", async ({ page }) => {
  const add = page.getByRole("button", { name: "Добавить ссылку", exact: true });
  await add.click();
  await page.keyboard.press("Escape");
  await expect(add).toBeFocused();
  await page.locator('[data-bookmark-id="1"]').hover();
  await page.getByRole("button", { name: /^Действия:/ }).first().click();
  await page.getByRole("menuitem", { name: "Изменить…" }).click();
  await page.getByLabel("Коллекция", { exact: true }).selectOption("");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await page.getByRole("button", { name: "Список", exact: true }).click();
  await expect(page.locator('[data-bookmark-id="1"] [data-collection]')).toContainText("Без коллекции");
});
test("card menu moves a bookmark to a collection with the keyboard", async ({ page }) => {
  await page.locator('[data-bookmark-id="2"]').hover();
  await page.getByRole("button", { name: /^Действия: Архитектура/ }).click();
  await expect(page.getByRole("menuitem").first()).toBeFocused();
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "В коллекцию" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("menuitem", { name: "Разработка" }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  // Escape closes the menu and returns focus to its button.
  const trigger = page.getByRole("button", { name: /^Действия: Архитектура/ });
  await page.locator('[data-bookmark-id="2"]').hover();
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.getByRole("button", { name: "Список", exact: true }).click();
  await expect(page.locator('[data-bookmark-id="2"] [data-collection]')).toContainText("Разработка");
});
for (const width of [800, 1200, 1600])
  test(`layout at ${width}px and both themes`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 800 ? 550 : 800 });
    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    for (const [theme, label] of [
      ["light", "Светлая"],
      ["dark", "Тёмная"],
    ]) {
      await page.getByRole("radio", { name: label }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    }
    await page.getByRole("button", { name: "Все закладки" }).click();
    await page.screenshot({ path: `test-results/library-${width}.png` });
  });
test("language switches without a restart", async ({ page }) => {
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await page.getByLabel("Язык", { exact: true }).selectOption("en");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByLabel("Language", { exact: true }).selectOption("system");
  await expect(page.getByRole("heading", { name: "Настройки" })).toBeVisible();
});
test("incoming capture preserves reading position until explicitly revealed", async ({ page }) => {
  // A short window, so the six cards scroll.
  await page.setViewportSize({ width: 1200, height: 550 });
  const scroll = page.locator('[data-scroll="main"]');
  await scroll.evaluate((el) => (el.scrollTop = 180));
  const before = await scroll.evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThan(20);
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const { bookmark: incoming } = await api.addBookmark({
      url: "https://example.com/incoming",
      title: "Incoming capture",
    });
    await api.updateBookmark(incoming.id, {
      notes: "Метаданные поступили до следующего кадра",
    });
  });
  await expect(page.getByRole("button", { name: "Новые закладки · 1" })).toBeVisible();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
  expect(await scroll.evaluate((el) => el.scrollTop)).toBe(before);
  await page.getByRole("button", { name: "Новые закладки · 1" }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(7);
  expect(await scroll.evaluate((el) => el.scrollTop)).toBe(0);
});
test("inbox: new links wait there until a decision, the banner hides until a newer one", async ({ page }) => {
  const inbox = (count: number) => page.getByRole("button", { name: `Входящие ${count}`, exact: true });
  const banner = page.getByRole("region", { name: "Новые закладки" });
  const cards = page.locator("[data-bookmark-id]");
  const capture = (url: string) =>
    page.evaluate(async (url) => {
      const { api } = await import("/src/services/api.ts");
      await api.addBookmark({ url, title: "Из браузера" });
    }, url);
  // All bookmarks include the inbox; the banner leads there.
  await expect(inbox(2)).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Все закладки\s*6/);
  await expect(banner).toContainText("2 новые закладки ждут разбора — оставить, разложить или выбросить займёт около минуты");
  await inbox(2).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Входящие\s*2/);
  await expect(cards).toHaveCount(2);
  // In the section the banner stays: it is the way into triage, and it cannot be hidden there.
  await expect(banner.getByRole("button", { name: "Разобрать" })).toBeVisible();
  await expect(banner.getByRole("button", { name: "Скрыть до новых закладок" })).toHaveCount(0);
  // Search stays in the section.
  await page.getByRole("textbox", { name: "Поиск в библиотеке" }).fill("тишины");
  await expect(cards).toHaveCount(1);
  await expect(page.getByText("1 из 2")).toBeVisible();
  await page.getByRole("textbox", { name: "Поиск в библиотеке" }).fill("");
  // A capture is in the inbox and its counter at once.
  await capture("https://example.com/captured");
  await expect(cards).toHaveCount(3);
  await expect(inbox(3)).toBeVisible();
  // A decision, here the star, takes a bookmark out of the inbox.
  await page.locator('[data-bookmark-id="2"]').hover();
  await page.locator('[data-bookmark-id="2"]').getByRole("button", { name: "В избранное" }).click();
  await expect(cards).toHaveCount(2);
  await expect(inbox(2)).toBeVisible();
  await expect(page.getByRole("button", { name: "Избранное 3" })).toBeVisible();

  // Hidden until a bookmark newer than the ones waiting arrives, also after a restart.
  await page.getByRole("button", { name: "Все закладки" }).click();
  await banner.getByRole("button", { name: "Скрыть до новых закладок" }).click();
  await expect(banner).toHaveCount(0);
  await page.reload();
  await expect(cards).toHaveCount(7);
  await expect(banner).toHaveCount(0);
  await expect(inbox(2)).toBeVisible();
  await capture("https://example.com/newer");
  await expect(banner).toContainText("3 новые закладки ждут разбора");

  // Nothing left: no banner, no badge, the empty inbox.
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    for (const b of (await api.getBookmarks({ onlyInbox: true })).items) await api.updateBookmark(b.id, { notes: "Решено" });
  });
  await expect(banner).toHaveCount(0);
  await page.getByRole("button", { name: "Входящие", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Всё разобрано" })).toBeVisible();
});
test("trash: delete without a dialog, undo, restore with every field, a link saved again comes back", async ({ page }) => {
  const nav = (name: string) => page.getByRole("button", { name, exact: true });
  const cards = page.locator("[data-bookmark-id]");
  const toast = page.locator(".fixed[role=status]");
  // The context menu works on a card and on a row alike.
  const trashCard = async (id: number) => {
    await page.locator(`[data-bookmark-id="${id}"]`).click({ button: "right" });
    await page.getByRole("menuitem", { name: "В корзину" }).click();
  };
  // The undo notice: its button, then Ctrl Z.
  await trashCard(1);
  await expect(toast).toContainText("Перемещено в корзину");
  await expect(cards).toHaveCount(5);
  await toast.getByRole("button", { name: /Отменить/ }).click();
  await expect(cards).toHaveCount(6);
  await trashCard(1);
  await expect(nav("Корзина 1")).toBeVisible();
  await page.keyboard.press("Control+z");
  await expect(toast).toContainText("Возвращено из корзины: «Десять принципов хорошего дизайна»");
  await expect(nav("Корзина 0")).toBeVisible();

  // In the trash: out of counts and search, newest deletion first, days left, the note.
  await trashCard(3);
  await trashCard(1);
  await expect(nav("Избранное 0")).toBeVisible();
  await expect(nav("Все закладки 4")).toBeVisible();
  await expect(nav("Дизайн 0")).toBeVisible();
  await page.getByRole("textbox", { name: "Поиск в библиотеке" }).fill("принципов");
  await expect(cards).toHaveCount(0);
  await page.getByRole("textbox", { name: "Поиск в библиотеке" }).fill("");
  await nav("Корзина 2").click();
  await expect(page.getByText(/«Восстановить» вернёт закладку с заметкой/)).toBeVisible();
  await expect(page.getByRole("region", { name: "Новые закладки" })).toHaveCount(0);
  await expect(cards.first()).toHaveAttribute("data-bookmark-id", "1");
  await expect(cards.first()).toContainText("ещё 30 дней");
  await page.getByRole("textbox", { name: "Поиск в библиотеке" }).fill("типографика");
  await expect(cards).toHaveCount(1);
  await page.getByRole("textbox", { name: "Поиск в библиотеке" }).fill("");

  // Restore brings back the star, the collection and the tags.
  await page.getByRole("button", { name: "Список", exact: true }).click();
  const row = page.locator('[data-bookmark-id="1"]');
  await row.hover();
  await row.getByRole("button", { name: "Восстановить" }).click();
  await expect(cards).toHaveCount(1);
  await nav("Избранное 1").click();
  await expect(row).toContainText("Дизайн");
  await expect(row.getByRole("button", { name: "принципы" })).toBeVisible();

  // Added again by hand: back from the trash, waiting in the inbox.
  await page.getByRole("button", { name: "Добавить ссылку", exact: true }).click();
  await page.getByLabel("Ссылка", { exact: true }).fill("https://type.today/ru");
  await page.getByRole("button", { name: "Сохранить ссылку" }).click();
  await expect(toast).toContainText("Возвращено из корзины во «Входящие»");
  await expect(nav("Корзина 0")).toBeVisible();
  await expect(nav("Входящие 3")).toBeVisible();

  // An import leaves a link in the trash where it is and says so.
  await trashCard(3);
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  await page.getByRole("menuitem", { name: /Закладки браузера/ }).click();
  await page.locator("input[type=file]").setInputFiles({
    name: "bookmarks.html",
    mimeType: "text/html",
    buffer: Buffer.from('<a href="https://type.today/ru">Типографика</a>'),
  });
  await page.getByRole("button", { name: "Импортировать", exact: true }).click();
  const report = page.getByRole("dialog", { name: "Импорт завершён" });
  await expect(report.getByRole("status")).toHaveText("Новых закладок нет");
  await expect(report).toContainText("В корзине — остались там1");
  await report.getByRole("button", { name: "Готово" }).click();
  await expect(nav("Корзина 1")).toBeVisible();
  await nav("Корзина 1").click();
  await page.locator('[data-bookmark-id="3"]').hover();
  await page.locator('[data-bookmark-id="3"]').getByRole("button", { name: "Восстановить" }).click();
  await expect(page.getByRole("heading", { name: "Корзина пуста" })).toBeVisible();
});
test("trash: deleting for good asks first, «Оставить» keeps it, emptying takes the rest", async ({ page }) => {
  const nav = (name: string) => page.getByRole("button", { name, exact: true });
  const cards = page.locator("[data-bookmark-id]");
  const toast = page.locator(".fixed[role=status]");
  for (const id of [1, 2, 3]) {
    await page.locator(`[data-bookmark-id="${id}"]`).click({ button: "right" });
    await page.getByRole("menuitem", { name: "В корзину" }).click();
  }
  await nav("Корзина 3").click();
  await page.getByRole("button", { name: "Список", exact: true }).click();

  // One bookmark from the row: the dialog names it, «Оставить» changes nothing.
  const row = page.locator('[data-bookmark-id="1"]');
  await row.hover();
  await row.getByRole("button", { name: "Удалить навсегда…" }).click();
  const dialog = page.getByRole("dialog", { name: "Удалить навсегда?" });
  await expect(dialog).toContainText("«Десять принципов хорошего дизайна» будет удалена навсегда");
  await dialog.getByRole("button", { name: "Оставить" }).click();
  await expect(cards).toHaveCount(3);
  await row.hover();
  await row.getByRole("button", { name: "Удалить навсегда…" }).click();
  await dialog.getByRole("button", { name: "Удалить навсегда" }).click();
  await expect(toast).toContainText("Удалено навсегда");
  await expect(toast.getByRole("button", { name: /Отменить/ })).toHaveCount(0);
  await expect(cards).toHaveCount(2);
  await expect(nav("Корзина 2")).toBeVisible();

  // The menu of a bookmark in the trash offers it too.
  await page.locator('[data-bookmark-id="2"]').click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Удалить навсегда…" })).toBeVisible();
  await page.keyboard.press("Escape");

  // The whole trash: the count in the dialog, then empty.
  await page.getByRole("button", { name: "Очистить корзину…" }).click();
  const empty = page.getByRole("dialog", { name: "Очистить корзину?" });
  await expect(empty).toContainText("2 закладки будут удалены навсегда");
  await empty.getByRole("button", { name: "Удалить навсегда" }).click();
  await expect(toast).toContainText("Корзина очищена: 2 закладки удалены навсегда");
  await expect(page.getByRole("heading", { name: "Корзина пуста" })).toBeVisible();
  await expect(nav("Все закладки 3")).toBeVisible();
  // Gone after a restart too.
  await page.reload();
  await expect(nav("Корзина 0")).toBeVisible();
});
test("undo: Ctrl Z takes actions back one by one, a decision returns to the inbox, a later change wins", async ({ page }) => {
  const nav = (name: string) => page.getByRole("button", { name, exact: true });
  const card = (id: number) => page.locator(`[data-bookmark-id="${id}"]`);
  const toast = page.locator(".fixed[role=status]");
  const alert = page.locator(".fixed[role=alert]");
  // Two decisions about a bookmark from the inbox: the star, then a collection.
  await card(2).hover();
  await card(2).getByRole("button", { name: "В избранное" }).click();
  await expect(nav("Входящие 1")).toBeVisible();
  await card(2).click({ button: "right" });
  await page.getByRole("menuitem", { name: "В коллекцию" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("menuitem", { name: "Разработка" }).click();
  await expect(toast).toContainText("Перемещено в «Разработка»");
  await expect(toast.getByRole("button", { name: /Отменить/ })).toBeVisible();
  // The last action first, then the one before: the bookmark waits in the inbox again.
  await page.keyboard.press("Control+z");
  await expect(toast).toContainText("Отменено: «Архитектура тишины»");
  await page.getByRole("button", { name: "Список", exact: true }).click();
  await expect(card(2).locator("[data-collection]")).toContainText("Вдохновение");
  await page.keyboard.press("Control+z");
  await expect(nav("Входящие 2")).toBeVisible();
  await expect(nav("Избранное 2")).toBeVisible();
  await page.keyboard.press("Control+z");
  await expect(toast).toContainText("Отменять нечего");

  // The editor's save is one action; its notice undoes it.
  await card(3).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Изменить…" }).click();
  await page.getByLabel("Название", { exact: true }).fill("Голос шрифта");
  await page.getByLabel("Заметка", { exact: true }).fill("Показать команде");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(card(3)).toContainText("Голос шрифта");
  await toast.getByRole("button", { name: /Отменить/ }).click();
  await expect(toast).toContainText("Отменено: «Типографика — это голос»");
  await expect(card(3)).toContainText("Типографика — это голос");

  // Saved again from the trash meanwhile: «to the trash» is not undone over it.
  await card(3).click({ button: "right" });
  await page.getByRole("menuitem", { name: "В корзину" }).click();
  await page.getByRole("button", { name: "Добавить ссылку", exact: true }).click();
  await page.getByLabel("Ссылка", { exact: true }).fill("https://type.today/ru");
  await page.getByRole("button", { name: "Сохранить ссылку" }).click();
  await expect(toast).toContainText("Возвращено из корзины во «Входящие»");
  await page.keyboard.press("Control+z");
  await expect(alert).toContainText("Не отменено: «Типографика — это голос» изменили после этого действия");
  await expect(nav("Входящие 3")).toBeVisible();
  await expect(nav("Корзина 0")).toBeVisible();

  // Deleted for good: nothing to bring back, and it says so.
  await card(1).click({ button: "right" });
  await page.getByRole("menuitem", { name: "В корзину" }).click();
  await nav("Корзина 1").click();
  await card(1).hover();
  await card(1).getByRole("button", { name: "Удалить навсегда…" }).click();
  await page.getByRole("dialog", { name: "Удалить навсегда?" }).getByRole("button", { name: "Удалить навсегда" }).click();
  await expect(toast).toContainText("Удалено навсегда");
  await page.keyboard.press("Control+z");
  await expect(alert).toContainText("Не отменено: «Десять принципов хорошего дизайна» уже удалена навсегда");
  await expect(nav("Корзина 0")).toBeVisible();
});
test("triage: every key, a failed decision, undo, a new link, the end and back to the library", async ({ page }) => {
  const nav = (name: string) => page.getByRole("button", { name, exact: true });
  const heading = page.getByRole("heading", { level: 1 });
  const title = page.locator("[data-triage-card] h2");
  const toast = page.locator(".fixed[role=status]");
  const alert = page.locator(".fixed[role=alert]");
  const add = (url: string, title: string) =>
    page.evaluate(
      async ([url, title]) => {
        const { api } = await import("/src/services/api.ts");
        await api.addBookmark({ url, title });
      },
      [url, title],
    );
  // Three new links join the two waiting: the queue goes newest first.
  for (const [url, name] of [
    ["https://example.com/a", "Первая новая"],
    ["https://example.com/b", "Вторая новая"],
    ["https://example.com/c", "Третья новая"],
  ])
    await add(url, name);
  await page.evaluate(() => {
    (window as unknown as { opened: string[] }).opened = [];
    window.open = (url) => ((window as unknown as { opened: string[] }).opened.push(String(url)), null);
  });
  await page.getByRole("region", { name: "Новые закладки" }).getByRole("button", { name: "Разобрать" }).click();
  await expect(heading).toHaveText(/Разбор входящих\s*1 из 5/);
  await expect(title).toHaveText("Третья новая");
  await expect(page.locator("[data-triage-card]")).toContainText(/example\.com\s*· добавлено вручную сегодня в \d/);
  await expect(page.getByText("Дальше")).toBeVisible();

  // F and T stay on the card; Space opens the page.
  await page.keyboard.press("f");
  await expect(nav("Избранное 3")).toBeVisible();
  await page.keyboard.press("t");
  await page.getByRole("textbox", { name: "Новый тег" }).fill("Срочно");
  await page.keyboard.press("Enter");
  await expect(toast).toContainText("Тег «срочно» добавлен");
  await expect(page.locator("[data-triage-card] ~ div").getByText("#срочно")).toBeVisible();
  await page.keyboard.press("Space");
  expect(await page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual(["https://example.com/c"]);
  await expect(heading).toHaveText(/1 из 5/);

  // A number files and moves on; ← to the trash; Z brings it back to the card.
  await page.keyboard.press("2");
  await expect(heading).toHaveText(/2 из 5/);
  await expect(page.getByRole("listitem").filter({ hasText: "Третья новая" })).toContainText("→ Разработка");
  await page.keyboard.press("ArrowLeft");
  await expect(nav("Корзина 1")).toBeVisible();
  await page.keyboard.press("z");
  await expect(toast).toContainText("Снова в очереди: Вторая новая");
  await expect(title).toHaveText("Вторая новая");
  await expect(heading).toHaveText(/2 из 5/);
  await expect(nav("Корзина 0")).toBeVisible();
  await page.keyboard.press("ArrowRight");

  // E: the editor; its save is a decision and moves on.
  await expect(title).toHaveText("Первая новая");
  await page.keyboard.press("e");
  await page.getByLabel("Название", { exact: true }).fill("Первая, исправленная");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(heading).toHaveText(/4 из 5/);
  await expect(page.getByRole("listitem").filter({ hasText: "Первая, исправленная" })).toContainText("оставлено");

  // A link saved during triage joins the end.
  await add("https://example.com/d", "Пришла во время разбора");
  await expect(heading).toHaveText(/4 из 6\s*\+1 новая/);

  // A failed decision keeps the card; «Повторить» or the same key tries again.
  await expect(title).toHaveText("Архитектура тишины");
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const { CommandError } = await import("/src/services/errors.ts");
    const original = api.trashBookmark;
    api.trashBookmark = async (id) => {
      api.trashBookmark = original;
      throw new CommandError("database_busy", "busy");
    };
  });
  await page.keyboard.press("ArrowLeft");
  await expect(alert).toContainText("Не удалось переместить в корзину: библиотека занята");
  await expect(alert.getByRole("button", { name: "Повторить" })).toBeVisible();
  await expect(heading).toHaveText(/4 из 6/);
  await page.keyboard.press("ArrowLeft");
  await expect(heading).toHaveText(/5 из 6/);
  await expect(alert).toHaveCount(0);

  // The end: the summary, the badge gone; Z brings the last card back.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("heading", { name: "Входящие разобраны" })).toBeVisible();
  await expect(page.getByText("6 решений: 4 оставлено, 1 разложено по коллекциям, 1 в корзине.")).toBeVisible();
  await expect(nav("Входящие")).toBeVisible();
  await page.keyboard.press("z");
  await expect(title).toHaveText("Пришла во время разбора");
  await expect(nav("Входящие 1")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  // Ten bookmarks, one of them in the trash.
  await expect(heading).toHaveText(/Все закладки\s*9/);
});
test("triage: a collection is suggested by the site, explained, and nothing changes until chosen", async ({ page }) => {
  // Two links from example.org already lie in «Вдохновение»; a third waits.
  const newId = await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    for (const n of [1, 2]) {
      const { bookmark } = await api.addBookmark({ url: `https://example.org/${n}`, title: `Пример ${n}` });
      await api.updateBookmark(bookmark.id, { collection_id: 3 });
    }
    return (await api.addBookmark({ url: "https://example.org/new", title: "Ещё пример" })).bookmark.id;
  });
  await page.getByRole("region", { name: "Новые закладки" }).getByRole("button", { name: "Разобрать" }).click();
  await expect(page.locator("[data-triage-card] h2")).toHaveText("Ещё пример");
  const offered = page.locator("[data-suggested]");
  const chips = page.locator("[data-keys] button");
  await expect(offered).toHaveText(/1\s*Вдохновение\s*предложено/);
  await expect(chips.nth(1)).toHaveText(/2\s*Дизайн/);
  await offered.hover();
  await expect(page.getByRole("tooltip").filter({ hasText: "Ссылки с example.org" })).toHaveText(
    "Ссылки с example.org чаще всего лежат в «Вдохновение»: 2 из 2",
  );
  // Shown, not applied: the bookmark still waits without a collection.
  const stored = () =>
    page.evaluate(async (id) => {
      const { api } = await import("/src/services/api.ts");
      const { items } = await api.getBookmarks({}, { id });
      return [items[0].collection_id, items[0].triaged_at];
    }, newId);
  expect(await stored()).toEqual([null, null]);
  await page.keyboard.press("1");
  await expect(page.getByRole("listitem").filter({ hasText: "Ещё пример" })).toContainText("→ Вдохновение");
  expect((await stored())[0]).toBe(3);
  // A site with nothing filed: no suggestion, the sidebar order.
  await expect(page.locator("[data-triage-card] h2")).toHaveText("Архитектура тишины");
  await expect(offered).toHaveCount(0);
  await expect(chips.first()).toHaveText(/1\s*Дизайн/);
});
test("triage: Esc goes back where it was opened, the inbox always offers it", async ({ page }) => {
  await page.getByRole("button", { name: "Входящие 2", exact: true }).click();
  const banner = page.getByRole("region", { name: "Новые закладки" });
  // In the inbox the banner has no «hide»: it is the way into triage.
  await expect(banner.getByRole("button", { name: "Скрыть до новых закладок" })).toHaveCount(0);
  await banner.getByRole("button", { name: "Разобрать" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Разбор входящих\s*1 из 2/);
  await page.keyboard.press("ArrowRight");
  await page.getByRole("button", { name: "Закончить" }).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Входящие\s*1/);
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
});
test("metadata updates keep order and filtered captures stay out of the list", async ({ page }) => {
  const ids = await page
    .locator("[data-bookmark-id]")
    .evaluateAll((elements) => elements.map((e) => e.getAttribute("data-bookmark-id")));
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    await api.updateBookmark(3, { notes: "Updated asynchronously" });
  });
  expect(
    await page.locator("[data-bookmark-id]").evaluateAll((elements) => elements.map((e) => e.getAttribute("data-bookmark-id"))),
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
test("an older search response cannot replace the current query", async ({ page }) => {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const original = api.getBookmarks;
    api.getBookmarks = async (filters) => {
      const rows = await original(filters);
      if (filters?.search === "Архитектура") await new Promise((resolve) => setTimeout(resolve, 450));
      return rows;
    };
  });
  await page.getByRole("textbox", { name: "Поиск в библиотеке" }).fill("Архитектура");
  await page.waitForTimeout(190);
  await page.getByRole("textbox", { name: "Поиск в библиотеке" }).fill("Типографика");
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
  await page.waitForTimeout(500);
  await expect(page.locator('[data-bookmark-id="3"]')).toBeVisible();
});

test("list geometry stays within the window and broken previews keep their space", async ({ page }) => {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const data = {
      bookmarks: (await api.getBookmarks()).items,
      collections: await api.getCollections(),
    };
    data.bookmarks[0].image_url = "/broken-preview.png";
    data.bookmarks[0].title = "Очень длинный заголовок ".repeat(12);
    localStorage.setItem("netamipin.demo.v4", JSON.stringify(data));
  });
  await page.reload();
  await expect(page.locator('[data-bookmark-id="1"] [data-preview-fallback]')).toBeVisible();
  await page.getByRole("button", { name: "Список", exact: true }).click();
  const preview = await page.locator('[data-bookmark-id="1"] [data-preview]').boundingBox();
  expect(preview?.width).toBe(64);
  expect(preview?.height).toBe(44);
  expect(await page.locator('[data-scroll="main"]').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.locator('[data-bookmark-id="1"]').evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
});

test("save errors preserve entered data and HTML import skips duplicate and unsupported links", async ({ page }) => {
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
  await page.getByRole("button", { name: "Добавить ссылку", exact: true }).click();
  await page.getByLabel("Ссылка", { exact: true }).fill("https://example.com/new-link");
  await page.getByLabel("Название", { exact: true }).fill("Моя находка");
  await page.getByRole("button", { name: "Сохранить ссылку" }).click();
  await expect(page.getByRole("alert")).toContainText("Не удалось записать");
  await expect(page.getByLabel("Название", { exact: true })).toHaveValue("Моя находка");
  await page.getByRole("button", { name: "Сохранить ссылку" }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(7);
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  await page.getByRole("menuitem", { name: /Закладки браузера/ }).click();
  await page.locator("input[type=file]").setInputFiles({
    name: "bookmarks.html",
    mimeType: "text/html",
    buffer: Buffer.from(
      '<a href="https://example.com/new-link">Duplicate</a><a href="https://example.com/imported">Импортировано</a><a href="javascript:alert(1)">Unsupported</a>',
    ),
  });
  await page.getByRole("button", { name: "Импортировать", exact: true }).click();
  const report = page.getByRole("dialog", { name: "Импорт завершён" });
  await expect(report.getByRole("status")).toHaveText("1 закладка добавлена в библиотеку");
  await expect(report).toContainText("Уже были в библиотеке — не изменены1");
  await expect(report).toContainText("Не веб-адрес (javascript:, place:, file:)1");
  await report.getByRole("button", { name: "Готово" }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(8);
});

const fixture = (name: string) => new URL(`../fixtures/bookmarks/${name}.html`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
async function openImport(page: import("@playwright/test").Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  await page.getByRole("menuitem", { name: /Закладки браузера/ }).click();
  await page.locator("dialog input[type=file]").setInputFiles(file);
  return page.getByRole("dialog");
}

test("import: browser folders become collections and tags, the report gives reasons, a repeated import changes nothing", async ({ page }) => {
  const dialog = await openImport(page, fixture("chrome"));
  await expect(dialog).toContainText("7 ссылок в 4 папках · выбрать другой файл");
  await expect(dialog.getByRole("radio", { name: "Библиотека" })).toHaveAttribute("aria-checked", "true");
  await dialog.getByRole("button", { name: "Импортировать", exact: true }).click();

  const report = page.getByRole("dialog", { name: "Импорт завершён" });
  await expect(report.getByRole("status")).toHaveText("7 закладок добавлено в библиотеку");
  await expect(report).toContainText("2 новые коллекции: Работа, Чтение · 2 новых тега");
  await expect(report).toContainText("Пропущено3");
  await expect(report).toContainText("Повтор внутри файла1");
  await report.getByRole("button", { name: "Показать пропущенные адреса" }).click();
  await expect(report.getByRole("listitem")).toHaveText(["javascript:void(document.title)", "https://github.com/", "chrome://settings/"]);
  await report.getByRole("button", { name: "Готово" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Top-level folder → collection, nested folders → tags, the browser's date kept.
  await page.getByRole("button", { name: /^Работа 3/ }).click();
  await page.getByRole("button", { name: "Список", exact: true }).click();
  const tokio = page.locator("[data-bookmark-id]", { hasText: "Tokio" });
  await expect(tokio.getByRole("button", { name: "rust" })).toBeVisible();
  await expect(tokio.getByRole("button", { name: "async" })).toBeVisible();
  await expect(tokio.locator("time")).toHaveAttribute("datetime", "2023-07-22T04:31:40.000Z");

  // Again: nothing new, nothing changed.
  const again = await openImport(page, fixture("chrome"));
  await again.getByRole("button", { name: "Импортировать", exact: true }).click();
  await expect(report.getByRole("status")).toHaveText("Новых закладок нет");
  await expect(report).toContainText("Уже были в библиотеке — не изменены7");
  await expect(report).not.toContainText("новые коллекции");
});

test("import into the inbox: the banner counts the import; an error changes nothing; an empty file is named", async ({ page }) => {
  const dialog = await openImport(page, fixture("firefox"));
  await dialog.getByRole("radio", { name: "Входящие" }).click();
  await dialog.getByRole("button", { name: "Импортировать", exact: true }).click();
  const report = page.getByRole("dialog", { name: "Импорт завершён" });
  await expect(report.getByRole("status")).toHaveText("7 закладок добавлено во «Входящие»");
  await report.getByRole("button", { name: "Открыть «Входящие»" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Входящие");
  await expect(page.getByRole("region", { name: "Новые закладки" })).toContainText("9 новых закладок ждут разбора — 7 из импорта");

  // The library is busy: the dialog keeps the file and offers to try again.
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const { CommandError } = await import("/src/services/errors.ts");
    api.importHtmlBookmarks = async () => {
      throw new CommandError("busy", "Библиотека занята.");
    };
  });
  const failing = await openImport(page, fixture("edge"));
  await failing.getByRole("button", { name: "Импортировать", exact: true }).click();
  await expect(failing.getByRole("alert")).toContainText("Не удалось импортировать. Библиотека занята.");
  await expect(failing.getByRole("alert")).toContainText("Ничего не добавлено — библиотека осталась как была.");
  await expect(failing.getByRole("button", { name: "Повторить" })).toBeVisible();
  await expect(failing).toContainText("edge.html");
  await failing.getByRole("button", { name: "Отмена" }).click();
  await expect(page.getByRole("button", { name: /^Design/ })).toHaveCount(0);

  const empty = await openImport(page, { name: "notes.html", mimeType: "text/html", buffer: Buffer.from("<html><body>Notes</body></html>") });
  await expect(empty.getByRole("alert")).toContainText("В этом файле нет закладок");
  await expect(empty.getByRole("button", { name: "Импортировать", exact: true })).toBeDisabled();
});

test("export: saved says how many and offers Show; cancelled says nothing; a failure names the reason and tries again", async ({ page }) => {
  const exportAs = async (item: RegExp) => {
    await page.getByRole("button", { name: "Ещё", exact: true }).click();
    await page.getByRole("menuitem", { name: item }).click();
  };
  const toast = page.locator("[role=status], [role=alert]").filter({ hasText: /сохран/i });
  // The trash stays out of HTML and CSV; JSON takes everything.
  await page.locator('[data-bookmark-id="2"]').hover();
  await page.locator('[data-bookmark-id="2"]').getByRole("button", { name: /^Действия:/ }).click();
  await page.getByRole("menuitem", { name: "В корзину" }).click();
  await exportAs(/HTML для браузера/);
  await expect(toast).toContainText(/^5 закладок сохранено в netami-pin-\d{4}-\d{2}-\d{2}\.html/);
  await expect(toast.getByRole("button", { name: "Показать" })).toBeVisible();
  await exportAs(/JSON — полная копия/);
  await expect(toast).toContainText(/^6 закладок сохранено в netami-pin-.*\.json/);

  // CSV gets its column titles in the interface's language; a cancelled dialog says nothing.
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const calls: unknown[] = [];
    (window as unknown as { exportCalls: unknown[] }).exportCalls = calls;
    let attempt = 0;
    api.exportLibrary = async (format, columns) => {
      calls.push({ format, columns });
      attempt++;
      if (attempt === 1) return { outcome: "cancelled" };
      if (attempt === 2) return { outcome: "failed", file_name: "netami-pin.csv", folder: "D:\\", problem: "disk_full", detail: "There is not enough space on the disk. (os error 112)" };
      return { outcome: "saved", file_name: "netami-pin.csv", count: 5 };
    };
  });
  await exportAs(/CSV для таблиц/);
  await expect.poll(() => page.evaluate(() => (window as unknown as { exportCalls: unknown[] }).exportCalls.length)).toBe(1);
  await expect(page.getByText("netami-pin.csv", { exact: false })).toHaveCount(0);
  const calls = await page.evaluate(() => (window as unknown as { exportCalls: { format: string; columns: Record<string, string> }[] }).exportCalls);
  expect(calls[0]).toMatchObject({ format: "csv", columns: { title: "Название", inbox: "Во входящих", saved: "Сохранено" } });

  await exportAs(/CSV для таблиц/);
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Не удалось сохранить netami-pin.csv: на диске нет места. Ничего не записано.");
  await alert.getByRole("button", { name: "Повторить" }).click();
  await expect(toast).toContainText("5 закладок сохранено в netami-pin.csv");
});

test("import of 10 000 links shows progress and keeps the window usable", async ({ page }) => {
  let html = "<DL>";
  for (let i = 0; i < 10_000; i++) html += `<DT><A HREF="https://example.com/${i}" ADD_DATE="1700000000">Link ${i}</A>`;
  const dialog = await openImport(page, { name: "big.html", mimeType: "text/html", buffer: Buffer.from(html + "</DL>") });
  await expect(dialog).toContainText("10 000 ссылок");
  await dialog.getByRole("button", { name: "Импортировать", exact: true }).click();
  await expect(page.getByRole("progressbar")).toBeVisible();
  // Escape does not close it while the file is being written.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Импорт завершён" }).getByRole("status")).toHaveText("10 000 закладок добавлено в библиотеку", { timeout: 20_000 });
});

test("a large library loads page by page while scrolling", async ({ page }) => {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const [first] = (await api.getBookmarks()).items;
    const bookmarks = Array.from({ length: 250 }, (_, i) => ({
      ...first,
      id: i + 1,
      url: `https://example.com/${i + 1}`,
      title: i % 2 ? `Ёлка ${i + 1}` : `Запись ${i + 1}`,
      tags: [],
      // Every fifth one shares a time with its neighbour: the id breaks the tie.
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 250 - i + (i % 5 === 0 ? 1 : 0))).toISOString(),
    }));
    localStorage.setItem("netamipin.demo.v4", JSON.stringify({ bookmarks, collections: await api.getCollections() }));
  });
  await page.reload();
  // Virtualized: only rows near the screen are in the DOM; `data-loaded` counts the pages read.
  const list = page.locator("[data-loaded]");
  await expect(list).toHaveAttribute("data-loaded", "100");
  expect(await page.locator("[data-bookmark-id]").count()).toBeLessThan(60);
  const scroll = page.locator('[data-scroll="main"]');
  await scroll.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(list).toHaveAttribute("data-loaded", "200");
  await scroll.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(list).toHaveAttribute("data-loaded", "250");
  await scroll.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  // The oldest bookmark (id 250 here: the list starts with id 1) ends the list.
  await expect(page.locator('[data-bookmark-id="250"]')).toBeVisible();
  await expect(page.locator("[data-bookmark-id]").last()).toHaveAttribute("data-bookmark-id", "250");

  // «е» finds «Ёлка»; the count covers every page, not only the loaded one.
  await page.getByRole("textbox", { name: "Поиск в библиотеке" }).fill("елка");
  await expect(page.getByText("125 из 250")).toBeVisible();
  await expect(list).toHaveAttribute("data-loaded", "100");
});

/** 250 demo bookmarks, newest first by id; odd ones are titled «Ёлка». */
async function largeLibrary(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const [first] = (await api.getBookmarks()).items;
    const bookmarks = Array.from({ length: 250 }, (_, i) => ({
      ...first,
      id: i + 1,
      url: `https://example.com/${i + 1}`,
      title: `Запись ${i + 1}`,
      tags: [],
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }));
    localStorage.setItem("netamipin.demo.v4", JSON.stringify({ bookmarks, collections: await api.getCollections() }));
  });
  await page.reload();
  await expect(page.locator("[data-loaded]")).toHaveAttribute("data-loaded", "100");
}

test("a change during a page request shows the newer version", async ({ page }) => {
  await largeLibrary(page);
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const original = api.getBookmarks;
    api.getBookmarks = async (filters, request) => {
      const result = await original(filters, request);
      // The page is read, then bookmark 150 (first on it) changes before it arrives.
      if (request?.after && request.after.id === 151) {
        await api.updateBookmark(150, { title: "Изменено во время загрузки" });
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return result;
    };
  });
  await page.locator('[data-scroll="main"]').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(page.locator("[data-loaded]")).toHaveAttribute("data-loaded", /^(200|250)$/);
  await expect(page.locator('[data-bookmark-id="150"]')).toContainText("Изменено во время загрузки");
});

test("a failing next page is not retried in a loop", async ({ page }) => {
  await largeLibrary(page);
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const original = api.getBookmarks;
    (window as unknown as { failures: number }).failures = 0;
    api.getBookmarks = async (filters, request) => {
      if (request?.after) {
        (window as unknown as { failures: number }).failures++;
        throw new Error("Диск недоступен");
      }
      return original(filters, request);
    };
  });
  await page.locator('[data-scroll="main"]').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(page.getByText("Диск недоступен")).toBeVisible();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as { failures: number }).failures)).toBe(1);
  await expect(page.locator("[data-loaded]")).toHaveAttribute("data-loaded", "100");
});

test("a changed bookmark joins an open search by the search rules", async ({ page }) => {
  const search = page.getByRole("textbox", { name: "Поиск в библиотеке" });
  await search.fill("ёлочн ИГРУШКИ");
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(0);
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    await api.updateBookmark(3, { notes: "Игрушки для елочных базаров" });
  });
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
  await expect(page.locator('[data-bookmark-id="3"]')).toBeVisible();
  await expect(page.getByText("1 из 6")).toBeVisible();
});

test("list rows: date groups over all pages, hover actions, the checkbox selects", async ({ page }) => {
  await page.clock.setFixedTime(new Date(2026, 9, 3, 12, 0));
  await largeLibrary(page);
  await page.getByRole("button", { name: "Список", exact: true }).click();
  // 250 bookmarks from January: one group «Раньше» sized by the database, not by the 100 loaded rows.
  await expect(page.getByRole("heading", { name: "Раньше 250" })).toBeVisible();

  const row = page.locator('[data-bookmark-id="250"]');
  const bar = page.getByRole("toolbar", { name: "Выделенные закладки" });
  await row.hover();
  const checkbox = row.getByRole("checkbox");
  await checkbox.click();
  await expect(checkbox).toHaveAttribute("aria-checked", "true");
  await expect(row).toHaveAttribute("data-selected", "true");
  await expect(bar.getByRole("status")).toHaveText("1 выбрано");
  // A changed bookmark stays selected.
  await row.getByRole("button", { name: "В коллекцию" }).click();
  await page.getByRole("menuitem", { name: "Разработка" }).click();
  await expect(row.locator("[data-collection]")).toContainText("Разработка");
  await expect(row).toHaveAttribute("data-selected", "true");
  // A deleted one leaves the selection silently.
  await row.hover();
  await row.getByRole("button", { name: "В корзину" }).click();
  await expect(page.locator('[data-bookmark-id="250"]')).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Раньше 249" })).toBeVisible();
  await expect(bar).toHaveCount(0);
});

for (const view of ["Сетка", "Список"])
  test(`selection in the ${view === "Сетка" ? "grid" : "list"}: Ctrl and Shift click, a frame that scrolls and loads pages, Esc`, async ({ page }) => {
    await largeLibrary(page);
    await page.getByRole("button", { name: view, exact: true }).click();
    const popups: unknown[] = [];
    page.on("popup", (popup) => popups.push(popup));
    const bar = page.getByRole("toolbar", { name: "Выделенные закладки" });
    const count = bar.getByRole("status");
    const selected = page.locator("[data-selected]");
    const title = (id: number) => page.locator(`[data-bookmark-id="${id}"]`).getByRole("button", { name: `Запись ${id}`, exact: true });

    // Newest first: 250, 249, 248…
    await title(250).click({ modifiers: ["Control"] });
    await expect(count).toHaveText("1 выбрано");
    await title(247).click({ modifiers: ["Shift"] });
    await expect(count).toHaveText("4 выбрано");
    await title(249).click({ modifiers: ["Control"] });
    await expect(count).toHaveText("3 выбрано");
    await expect(selected).toHaveCount(3);
    expect(popups).toHaveLength(0);
    await expect(bar.getByRole("button", { name: "В корзину" })).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    await expect(bar).toHaveCount(0);

    // A frame from the empty margin down past the bottom edge scrolls the list;
    // pages load on the way and the frame keeps selecting rows that left the DOM.
    const scroll = page.locator('[data-scroll="main"]');
    const box = (await scroll.boundingBox())!;
    await page.mouse.move(box.x + 10, box.y + 3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 60, box.y + 200, { steps: 5 });
    await page.mouse.move(box.x + box.width - 60, box.y + box.height + 150, { steps: 5 });
    const selectedCount = async () => Number(((await count.textContent()) ?? "0").split(" ")[0]);
    await expect.poll(selectedCount, { timeout: 15_000 }).toBeGreaterThan(100);
    await page.mouse.up();
    await expect(page.locator("[data-selection-frame]")).toHaveCount(0);
    expect(Number(await page.locator("[data-loaded]").getAttribute("data-loaded"))).toBeGreaterThan(100);
    const framed = await selectedCount();
    // Scrolling back keeps it: the selection is by id, not by element.
    await scroll.evaluate((el) => el.scrollTo({ top: 0 }));
    await expect(page.locator('[data-bookmark-id="250"]')).toHaveAttribute("data-selected", "true");
    await expect(count).toHaveText(`${framed} выбрано`);

    // A frame without a modifier replaces the selection, with Ctrl it adds.
    await page.mouse.move(box.x + 10, box.y + 3);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + 60, { steps: 5 });
    await page.mouse.up();
    await expect(count).toHaveText("1 выбрано");
    await title(240).click({ modifiers: ["Control"] });
    await expect(count).toHaveText("2 выбрано");

    // A click on an empty place clears it.
    await page.mouse.click(box.x + 10, box.y + box.height - 10);
    await expect(bar).toHaveCount(0);
  });

test("selection: Ctrl A takes every match of 10 000 without loading them; search keeps it, another section clears it", async ({ page }) => {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const [first] = (await api.getBookmarks()).items;
    const bookmarks = Array.from({ length: 10_000 }, (_, i) => ({
      ...first,
      id: i + 1,
      url: `https://example.com/${i + 1}`,
      title: i % 10 ? `Запись ${i + 1}` : `Ёлка ${i + 1}`,
      description: null,
      notes: null,
      image_url: null,
      tags: [],
      is_favorite: i < 3,
      created_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
    }));
    localStorage.setItem("netamipin.demo.v4", JSON.stringify({ bookmarks, collections: await api.getCollections() }));
  });
  await page.reload();
  await expect(page.locator("[data-loaded]")).toHaveAttribute("data-loaded", "100");
  const bar = page.getByRole("toolbar", { name: "Выделенные закладки" });
  const search = page.getByRole("textbox", { name: "Поиск в библиотеке" });

  // In the search field Ctrl A is the field's own.
  await search.fill("ёлка");
  await search.press("Control+a");
  await expect(bar).toHaveCount(0);
  await search.fill("");
  await page.locator('[data-scroll="main"]').click({ position: { x: 5, y: 5 } });

  const started = Date.now();
  await page.keyboard.press("Control+a");
  await expect(bar.getByRole("status")).toHaveText("10000 выбрано");
  expect(Date.now() - started).toBeLessThan(1000);
  // Selected, not loaded: the list still holds one page.
  await expect(page.locator("[data-loaded]")).toHaveAttribute("data-loaded", "100");

  // Search narrows the list, not the selection; the hint counts what it hides.
  await search.fill("ёлка");
  await expect(page.getByText("9000 из 10000 выбранных скрыты поиском — действия их учитывают")).toBeVisible();
  await expect(page.locator('[data-bookmark-id="9991"]')).toHaveAttribute("data-selected", "true");
  // Esc in the field clears the query first and keeps the selection.
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(page.getByText("Shift / Ctrl — добавить к выделению", { exact: false })).toBeVisible();

  // Another section clears it.
  await page.getByRole("button", { name: /^Избранное/ }).click();
  await expect(bar).toHaveCount(0);
  // Ctrl A there adds that section only; Esc in the empty field clears it.
  await page.locator('[data-scroll="main"]').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+a");
  await expect(bar.getByRole("status")).toHaveText("3 выбрано");
  await search.focus();
  await search.press("Escape");
  await expect(bar).toHaveCount(0);
});

test("a click on a domain filters by site; Esc clears the search; nothing found offers the whole library", async ({ page }) => {
  await page.locator('[data-bookmark-id="1"]').getByRole("button", { name: "Только закладки с vitsoe.com" }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("1 из 6");
  await page.getByRole("button", { name: "Убрать фильтр по сайту vitsoe.com" }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);

  const search = page.getByRole("textbox", { name: "Поиск в библиотеке" });
  await page.getByRole("button", { name: /^Вдохновение/ }).click();
  await search.fill("типографика");
  await expect(page.getByRole("heading", { name: "В «Вдохновение» ничего не нашлось по «типографика»" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("0 из 2");
  await expect(page.locator("label kbd")).toHaveText("Esc");
  await page.getByRole("button", { name: "Искать во всей библиотеке" }).click();
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(1);
  await expect(search).toHaveValue("типографика");
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(page.locator("[data-bookmark-id]")).toHaveCount(6);
});

test("editor: empty title is marked, tags are chips, Ctrl Enter saves, Cancel keeps the bookmark", async ({ page }) => {
  const card = page.locator('[data-bookmark-id="1"]');
  await card.hover();
  await card.getByRole("button", { name: /^Действия:/ }).click();
  await page.getByRole("menuitem", { name: "Изменить…" }).click();
  const title = page.getByLabel("Название", { exact: true });
  await title.fill("");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(title).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Название не может быть пустым")).toBeVisible();
  await expect(title).toBeFocused();

  await title.fill("Десять принципов");
  const tags = page.getByLabel("Теги", { exact: true });
  await page.getByRole("button", { name: "Убрать тег принципы" }).click();
  await tags.fill("Рамс");
  await tags.press("Enter");
  await tags.fill("braun");
  // Ctrl Enter saves from any field and keeps the tag still being typed.
  await tags.press("Control+Enter");
  await expect(page.getByRole("status")).toContainText("Изменения сохранены");
  await page.getByRole("button", { name: "Список", exact: true }).click();
  const row = page.locator('[data-bookmark-id="1"]');
  await expect(row).toContainText("Десять принципов");
  await expect(row.getByRole("button", { name: "рамс" })).toBeVisible();
  await expect(row.getByRole("button", { name: "braun" })).toBeVisible();
  await expect(row.getByRole("button", { name: "принципы" })).toHaveCount(0);

  await row.hover();
  await row.getByRole("button", { name: /^Открыть:/ }).first().focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Изменить…" }).click();
  await page.getByLabel("Название", { exact: true }).fill("Не сохранится");
  await page.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(row).toContainText("Десять принципов");
  await row.hover();
  await row.getByRole("button", { name: /^Открыть:/ }).first().focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Изменить…" }).click();
  // No confirmation: the bookmark goes to the trash and the editor closes.
  const editor = page.getByRole("complementary", { name: "Изменить закладку" });
  await editor.getByRole("button", { name: "В корзину" }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Перемещено в корзину");
  await expect(page.locator('[data-bookmark-id="1"]')).toHaveCount(0);
});

test("editor: a failed save shows the reason and keeps everything typed", async ({ page }) => {
  await page.evaluate(async () => {
    const { api } = await import("/src/services/api.ts");
    const { CommandError } = await import("/src/services/errors.ts");
    const original = api.updateBookmark;
    let failed = false;
    api.updateBookmark = async (id, data) => {
      if (!failed) {
        failed = true;
        throw new CommandError("database_busy", "busy");
      }
      return original(id, data);
    };
  });
  const card = page.locator('[data-bookmark-id="2"]');
  await card.hover();
  await card.getByRole("button", { name: /^Действия:/ }).click();
  await page.getByRole("menuitem", { name: "Изменить…" }).click();
  await page.getByLabel("Название", { exact: true }).fill("Тишина и свет");
  await page.getByLabel("Заметка", { exact: true }).fill("Перечитать зимой");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Не удалось сохранить — изменения остались в форме.");
  await expect(page.getByLabel("Название", { exact: true })).toHaveValue("Тишина и свет");
  await expect(page.getByLabel("Заметка", { exact: true })).toHaveValue("Перечитать зимой");
  await page.getByRole("button", { name: "Сохранить ещё раз", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Изменения сохранены");
  await expect(page.locator('[data-bookmark-id="2"]')).toContainText("Тишина и свет");
});
test("connect dialog: steps for each browser, no token and no bookmarklet", async ({ page }) => {
  await page.getByRole("button", { name: "Браузер не подключён" }).click();
  const dialog = page.getByRole("dialog", { name: "Подключить браузер" });
  await expect(dialog.locator('[data-capture="none"]')).toContainText("Браузер не подключён");
  await expect(dialog).toContainText("extension/build/chrome");
  await dialog.getByRole("radio", { name: "Edge" }).click();
  await expect(dialog).toContainText("edge://extensions");
  await dialog.getByRole("radio", { name: "Firefox" }).click();
  await expect(dialog).toContainText("netamipin-firefox.xpi");
  await expect(dialog).toContainText("about:addons");
  await expect(dialog).not.toContainText(/токен|букмарклет/i);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  const block = page.locator('[data-capture="none"]');
  await expect(block).toContainText("Расширение сохраняет страницу одним нажатием");
  await block.getByRole("button", { name: "Подключить", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Подключить браузер" })).toBeVisible();
});
