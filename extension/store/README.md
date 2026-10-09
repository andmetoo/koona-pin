# Карточка расширения в Chrome Web Store, Edge Add-ons и AMO

Материалы для публикации (NP-017, NP-046, [Р-6](../../doc/decisions.md#р-6-захват-из-браузера)). Пакеты — `release/publish/chrome/<версия>/koonapin-chrome.zip` и `release/publish/edge/<версия>/koonapin-edge.zip` из `bun run extension:build` (без поля `key`). Картинки пересобирает `bun scripts/store-assets.mjs` (Koona Pin закрыт): настоящее расширение с тестовым приложением через настоящий host.

Обновлено 9 октября 2026 года для расширения 0.9.2: тексты без «no account, no cloud» (платная синхронизация может потребовать аккаунт — решение владельца), краткое описание исправлено (закрытое приложение запускается, а не ждёт очереди), четыре скриншота вместо одного.

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
Koona Pin is a desktop bookmark library. This extension adds one button to your browser: click it on any page, and the page goes to the Koona Pin app on your computer.

• One click saves the page's address and title. A short note in the corner of the page confirms it.
• If Koona Pin is closed, saving a page starts it in the tray.
• Alt+Shift+D searches your saved links right from the browser.
• Optionally, the button shows when the page you are on is already saved.
• If the app can't take a link at the moment, the link waits in the browser and is sent again by itself.

The extension works with the free Koona Pin desktop app for Windows and Linux: https://koona.app/pin/
It talks only to that app on the same computer, through the browser's native messaging. It makes no network requests and sends nothing to the developer.
```

**Русский**

```text
Koona Pin — библиотека закладок для компьютера. Расширение добавляет в браузер одну кнопку: нажмите её на любой странице, и страница попадёт в приложение Koona Pin на вашем компьютере.

• Одно нажатие сохраняет адрес и заголовок страницы. Короткое сообщение в углу страницы подтверждает это.
• Если Koona Pin закрыт, сохранение запустит его в трее.
• Alt+Shift+D ищет по сохранённым ссылкам прямо в браузере.
• По желанию кнопка показывает, что открытая страница уже сохранена.
• Если приложение сейчас не может принять ссылку, она ждёт в браузере и уходит повторно сама.

Расширение работает вместе с бесплатным приложением Koona Pin для Windows и Linux: https://koona.app/pin/
Оно обращается только к этому приложению на том же компьютере через Native Messaging браузера. Сетевых запросов оно не делает и разработчику ничего не отправляет.
```

## Вкладка Privacy (Chrome Web Store)

**Single purpose**

```text
Save the current page (its address and title) to the Koona Pin desktop app on the same computer with one click, and search the links saved there.
```

**Permission justification**

| Разрешение | Текст |
|---|---|
| `activeTab` | `When the user clicks the toolbar button, the extension reads the address and title of that tab to save it. It reads no other tabs and no page content.` |
| `scripting` | `Right after the user clicks the toolbar button, the extension shows a short note in the corner of that tab: saved, already saved, waiting for the app, or not saved. It runs only on the clicked tab, through activeTab, reads nothing from the page, and the note can be turned off in the extension settings.` |
| `tabs` (optional) | `Optional, requested only when the user turns on «Show that a page is already saved» in the extension settings. The extension then checks the address of each page the user opens against the user's own Koona Pin library on the same computer, through native messaging, and marks the button. Turning the setting off removes the permission. Nothing is sent anywhere else.` |
| `contextMenus` | `Adds «Find a link» to the right-click menu of the extension's toolbar button. It opens the extension's search over the user's own Koona Pin library. No other menus are changed.` |
| `nativeMessaging` | `The saved link is delivered to the Koona Pin desktop app on the same computer through native messaging. The app's installer or package registers the native host; the extension talks to nothing else.` |
| `storage` | `Links wait in local extension storage until the app confirms them, so nothing is lost while the app is unavailable. Also keeps the time of the last save shown on the settings page.` |
| `alarms` | `Retries delivery of waiting links once a minute, and tells the app twice a day that the browser is still connected.` |

**Remote code:** `No, I am not using remote code.`

**Data usage.** Отметить **Web history**: расширение передаёт адрес и заголовок страницы, которую пользователь сам сохраняет, — только в приложение на этом же компьютере. Остальные категории не отмечать. Отметить все три заявления: данные не продаются третьим лицам, не используются для целей, не связанных с единственным назначением, не используются для кредитных решений.

## Инструкции для проверяющих

Chrome Web Store: «Test instructions» на вкладке Privacy (учётные данные не нужны). Edge Add-ons: «Notes for certification». AMO: «Notes to Reviewer».

```text
Koona Pin is a companion extension for the Koona Pin desktop app. It saves the current page to the app's local library on the same computer through native messaging. No account or sign-in is needed, and the extension makes no network requests.

To test it with the app (Windows 11, x64):
1. Download and run the installer from https://koona.app/pin/downloads/ ("Download for Windows"). It installs per user, without administrator rights, and registers the native messaging host for Chrome and Edge. Windows SmartScreen may warn that the app is new: choose "More info" → "Run anyway".
2. Install this extension and pin its toolbar button.
3. Open any web page, for example https://example.com, and click the Koona Pin button. The button animates and a short note appears in the corner of the page: "Saved to Koona Pin". The page appears in the app's Inbox. If the app was closed, it starts in the system tray.
4. Click the button again on the same page: the note says the page is already saved, and no duplicate is created.
5. Alt+Shift+D (or "Find a link" in the button's right-click menu) opens a popup that searches the same local library.
6. Right-click the button → Options: the settings page shows that the extension is connected to the app.

Without the app, clicking the button keeps the link in a local queue, and the settings page says that Koona Pin isn't installed, with a download link. This is expected.

Permissions: activeTab and scripting are used only on the tab where the button is clicked, to read its address and title and to show the note. tabs is optional and requested only if the user turns on "Show that a page is already saved". nativeMessaging talks only to the Koona Pin app on the same computer.
```

Строку про SmartScreen убрать, когда установщик будет подписан Certum (NP-041).

## Firefox (AMO)

Сейчас — самостоятельное распространение ([Р-6](../../doc/decisions.md#р-6-захват-из-браузера), NP-018): AMO подписывает XPI («On your own»), файл и `updates.json` лежат на `koona.app/pin/firefox/`, в каталоге расширение не показано. Карточка в кабинете AMO — служебная, её видит только разработчик; тексты в ней — те же, что выше. Выставить в каталог («On this site») — отдельная сборка без `browser_specific_settings.gecko.update_url` (AMO обновляет листинговые версии сам), решение владельца.

## Порядок

1. Черновики созданы, ID записаны в `STORE_EXTENSION_IDS` (`src-tauri/src/native_host.rs`): Chrome `dedcgklilbgbieabgpklellnaccpjhpc`, Edge `ocdkndgdeagephdnlmofffbapdifhkho`. С ними установщик (`--features public-release`) разрешает host только каталожным расширениям.
2. Пакет загружен в черновик, карточка заполнена по этому файлу, инструкции для проверяющих — со ссылкой на установщик. Chrome отправлен на проверку 9 октября 2026 года (0.9.1).
3. Тексты карточки и картинки можно поменять и после одобрения; краткое описание и название — только новой версией пакета (0.9.2).
4. После одобрения ссылки на карточки — в `storeLinks` (`src/services/capture.ts`): «Подключить браузер» показывает установку из каталога вместо режима разработчика; на сайте — кнопки Chrome и Edge вместо «soon» (лендинг и `/downloads/`).
