# Карточка расширения в Chrome Web Store, Edge Add-ons и AMO

Материалы для публикации (NP-017, NP-046). Пакеты — `release/publish/chrome/<версия>/koonapin-chrome.zip` и `release/publish/edge/<версия>/koonapin-edge.zip` из `bun run extension:build` (без поля `key`). Картинки пересобирает `bun scripts/store-assets.mjs` (Koona Pin закрыт): настоящее расширение с тестовым приложением через настоящий host.

Обновлено 18 октября 2026 года для расширения 0.11.3 (приложение 2.3.0): подробные описания говорят, что ссылки попадают во «Входящие» приложения, называют поиск с фильтрами (всё, «Входящие», «Избранное») и коротко — что умеет приложение сейчас: режим чтения, «Почитать» и ленты (RSS, Atom, JSON Feed), которые приложение загружает само; в обосновании `alarms` исправлена частота: приложение узнаёт о браузере каждые 30 минут, а не дважды в день (`HELLO_MINUTES` в `worker.js`). Тексты 15 октября (0.11.3, приложение 1.7.1) добавили «Save to Reading» и приложение для Windows, macOS и Linux. Тексты 9 октября (0.9.2) — без «no account, no cloud»: платная синхронизация может потребовать аккаунт, решение владельца.

Safari: расширение для Safari приходит внутри приложения для Mac, в каталогах его нет; эта карточка — только Chrome Web Store, Edge Add-ons и AMO.

| Поле | Chrome Web Store | Edge Add-ons |
|---|---|---|
| Видимость | решает владелец: Public или Unlisted | Public или Hidden |
| Категория | Productivity → Workflow & Planning | Productivity |
| Языки карточки | English (основной), Русский; остальные 12 берут название и краткое описание из `_locales` | те же |
| Значок | 128×128 из пакета | `logo-300x300.png` |
| Скриншоты, по порядку | `en/1-save-1280x800.png`, `en/2-search-1280x800.png`, `en/3-library-1280x800.png`, `en/4-options-1280x800.png`; для русской карточки — те же из `ru/` | те же |
| Малая промо-плитка 440×280 | `en/promo-440x280.png`, `ru/promo-440x280.png` | те же (необязательно) |
| Сайт | https://koona.app/pin/ | https://koona.app/pin/ |
| Поддержка | https://koona.app/pin/feedback | https://koona.app/pin/feedback |
| Политика конфиденциальности | https://koona.app/pin/privacy (текст — [privacy.md](privacy.md)) | та же |

Название и краткое описание (до 132 символов) каталоги берут из `_locales` пакета (`extensionName`, `extensionDescription`): они меняются только новой версией расширения.

Что на скриншотах: 1 — статья в браузере и сообщение «Saved to Koona Pin» в углу после нажатия кнопки; 2 — быстрый поиск (Alt+Shift+D) поверх страницы, выдача по библиотеке; 3 — библиотека в приложении; 4 — настройки расширения: связь с приложением, что показывать после сохранения.

## Подробное описание

**English**

```text
Koona Pin is a desktop bookmark library. This extension adds one button to your browser: click it on any page, and the page goes to the Koona Pin app on your computer, into its Inbox.

• One click saves the page's address and title. A short note in the corner of the page confirms it.
• Save to Reading: right-click a page or a link and choose "Save page to Reading" or "Save link to Reading", or press Alt+Shift+R. The article goes to the app's Reading list, to read later in reading mode, and waits in the Inbox too.
• If Koona Pin is closed, saving a page starts it in the tray.
• Alt+Shift+D searches your saved links right from the browser: all of them, the Inbox or Favorites.
• Optionally, the button shows when the page you are on is already saved.
• If the app can't take a link at the moment, the link waits in the browser and is sent again by itself.

In the app you sort new links one card at a time, file them into collections and tags, and read saved articles in one calm column, without menus or banners. You can also follow sites' RSS, Atom or JSON feeds there; the app fetches them itself.

The extension works with the free Koona Pin desktop app for Windows, macOS and Linux: https://koona.app/pin/
It talks only to that app on the same computer, through the browser's native messaging. It makes no network requests and sends nothing to the developer.
```

**Русский**

```text
Koona Pin — библиотека закладок для компьютера. Расширение добавляет в браузер одну кнопку: нажмите её на любой странице, и страница попадёт в приложение Koona Pin на вашем компьютере, во «Входящие».

• Одно нажатие сохраняет адрес и заголовок страницы. Короткое сообщение в углу страницы подтверждает это.
• Отложить почитать: щёлкните правой кнопкой по странице или ссылке и выберите «Сохранить страницу в „Почитать“» или «Сохранить ссылку в „Почитать“», либо нажмите Alt+Shift+R. Статья попадёт в «Почитать», чтобы прочитать её позже в режиме чтения, и тоже подождёт во «Входящих».
• Если Koona Pin закрыт, сохранение запустит его в трее.
• Alt+Shift+D ищет по сохранённым ссылкам прямо в браузере: по всем, во «Входящих» или в «Избранном».
• По желанию кнопка показывает, что открытая страница уже сохранена.
• Если приложение сейчас не может принять ссылку, она ждёт в браузере и уходит повторно сама.

В приложении новые ссылки разбираются по одной карточке, раскладываются по коллекциям и тегам, а сохранённые статьи читаются в одной спокойной колонке, без меню и баннеров. Там же можно подписаться на RSS, Atom или JSON Feed сайтов — приложение загружает их само.

Расширение работает вместе с бесплатным приложением Koona Pin для Windows, macOS и Linux: https://koona.app/pin/
Оно обращается только к этому приложению на том же компьютере через Native Messaging браузера. Сетевых запросов оно не делает и разработчику ничего не отправляет.
```

## Вкладка Privacy (Chrome Web Store)

**Single purpose**

```text
Save the current page or a link (its address and title) to the Koona Pin desktop app on the same computer, to its Inbox or its Reading list, and search the links saved there.
```

**Permission justification**

| Разрешение | Текст |
|---|---|
| `activeTab` | `When the user clicks the toolbar button, chooses «Save page to Reading» in the page's right-click menu, or presses Alt+Shift+R, the extension reads the address and title of that tab to save it. It reads no other tabs and no page content.` |
| `scripting` | `Right after the user saves a page (the toolbar button, the right-click menu or Alt+Shift+R), the extension shows a short note in the corner of that tab: saved, saved to Reading, already saved, waiting for the app, or not saved. It runs only on that tab, through activeTab, reads nothing from the page, and the note can be turned off in the extension settings.` |
| `tabs` (optional) | `Optional, requested only when the user turns on «Show that a page is already saved» in the extension settings. The extension then checks the address of each page the user opens against the user's own Koona Pin library on the same computer, through native messaging, and marks the button. Turning the setting off removes the permission. Nothing is sent anywhere else.` |
| `contextMenus` | `Adds «Find a link» to the right-click menu of the extension's toolbar button, «Save page to Reading» to the right-click menu of web pages, and «Save link to Reading» to the right-click menu of links. The first opens the extension's search over the user's own Koona Pin library; the other two save that page or link to the Reading list of the Koona Pin app on the same computer. No other menus are changed.` |
| `nativeMessaging` | `The saved link is delivered to the Koona Pin desktop app on the same computer through native messaging. The app's installer or package registers the native host; the extension talks to nothing else.` |
| `storage` | `Links wait in local extension storage until the app confirms them, so nothing is lost while the app is unavailable. Also keeps the extension's settings and the time of the last save shown on the settings page.` |
| `alarms` | `Retries delivery of waiting links once a minute, and tells the app every 30 minutes that the browser is still connected.` |

Это все разрешения манифестов Chrome и Edge (`scripts/build-extension.mjs`): `activeTab`, `scripting`, `storage`, `alarms`, `nativeMessaging`, `contextMenus` и необязательное `tabs`; сочетания Alt+Shift+D и Alt+Shift+R — `commands`, разрешения не требуют. В Firefox вместо `contextMenus` — `menus` (те же пункты и ещё «Настройки» в меню кнопки) и `data_collection_permissions: none`. `unlimitedStorage` есть только в манифесте Safari (#315), в каталожных пакетах его нет.

**Remote code:** `No, I am not using remote code.`

**Data usage.** Отметить **Web history**: расширение передаёт адрес и заголовок страницы, которую пользователь сам сохраняет, — только в приложение на этом же компьютере. Остальные категории не отмечать. Отметить все три заявления: данные не продаются третьим лицам, не используются для целей, не связанных с единственным назначением, не используются для кредитных решений.

## Инструкции для проверяющих

Chrome Web Store: «Test instructions» на вкладке Privacy (учётные данные не нужны). Edge Add-ons: «Notes for certification». AMO: «Notes to Reviewer».

```text
Koona Pin is a companion extension for the Koona Pin desktop app. It saves the current page to the app's local library on the same computer through native messaging. No account or sign-in is needed, and the extension makes no network requests.

To test it with the app (Windows 11, x64):
1. Download and run the installer from https://koona.app/pin/downloads/ ("Download for Windows"). It installs per user, without administrator rights, and registers the native messaging host for Chrome and Edge.
2. Install this extension and pin its toolbar button.
3. Open any web page, for example https://example.com, and click the Koona Pin button. The button animates and a short note appears in the corner of the page: "Saved to Koona Pin". The page appears in the app's Inbox. If the app was closed, it starts in the system tray.
4. Click the button again on the same page: the note says the page is already saved, and no duplicate is created.
5. Open another page, right-click it and choose "Save page to Reading" (or press Alt+Shift+R). The note says "Saved to Reading", and the page appears in the app's Reading list and in Inbox. Right-clicking a link offers "Save link to Reading" for the linked page.
6. Alt+Shift+D (or "Find a link" in the button's right-click menu) opens a popup that searches the same local library.
7. Right-click the button → Options: the settings page shows that the extension is connected to the app.

Without the app, clicking the button keeps the link in a local queue, and the settings page says that Koona Pin isn't installed, with a download link. This is expected.

Permissions: activeTab and scripting are used only on the tab the user saves (the button, the page's right-click menu or Alt+Shift+R), to read its address and title and to show the note. contextMenus adds "Find a link" to the button's menu and "Save page to Reading" / "Save link to Reading" to the menus of pages and links. tabs is optional and requested only if the user turns on "Show that a page is already saved". nativeMessaging talks only to the Koona Pin app on the same computer.
```

Строки про SmartScreen больше нет: установщик релиза подписан Certum (NP-041, `scripts/release-windows.mjs`).

## Firefox (AMO)

Сейчас — самостоятельное распространение (NP-018): AMO подписывает XPI («On your own»), файл и `updates.json` лежат на `koona.app/pin/firefox/`, в каталоге расширение не показано. Карточка в кабинете AMO — служебная, её видит только разработчик; тексты в ней — те же, что выше. Выставить в каталог («On this site») — отдельная сборка без `browser_specific_settings.gecko.update_url` (AMO обновляет листинговые версии сам), решение владельца.

## Порядок

1. Черновики созданы, ID записаны в `STORE_EXTENSION_IDS` (`src-tauri/src/native_host.rs`): Chrome `dedcgklilbgbieabgpklellnaccpjhpc`, Edge `ocdkndgdeagephdnlmofffbapdifhkho`. С ними установщик (`--features public-release`) разрешает host только каталожным расширениям.
2. Пакет загружен в черновик, карточка заполнена по этому файлу, инструкции для проверяющих — со ссылкой на установщик. Chrome отправлен на проверку 9 октября 2026 года (0.9.1), опубликован 10 октября: https://chromewebstore.google.com/detail/dedcgklilbgbieabgpklellnaccpjhpc. Edge Add-ons опубликовал 10 октября: https://microsoftedge.microsoft.com/addons/detail/ocdkndgdeagephdnlmofffbapdifhkho.
3. Тексты карточки и картинки можно поменять и после одобрения; краткое описание и название — только новой версией пакета (0.9.2).
4. После одобрения ссылки на карточки — в `installSources` (`src/services/capture.ts`): «Подключить браузер» показывает установку из каталога вместо режима разработчика; на сайте — кнопки и плитки (лендинг и `/downloads/`), и README. Сделано для Chrome и Edge; на сайте ссылки — `CHROME_STORE` и `EDGE_ADDONS` (`pin/src/content.mjs` в andmetoo/koona-site, копия `chromeStoreId` и `edgeStoreId` из `scripts/build-extension.mjs`), а `native_host.rs` сверяет их и ссылки приложения со `STORE_EXTENSION_IDS`. Firefox ставится со страницы загрузок koona.app (`connect.site_firefox`), пока расширения нет в каталоге AMO.
