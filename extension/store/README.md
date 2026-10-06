# Карточка расширения в Chrome Web Store и Edge Add-ons

Материалы для непубличной публикации (NP-017, [Р-6](../../doc/decisions.md#р-6-захват-из-браузера)). Пакеты — `release/publish/chrome/<версия>/netamipin-chrome.zip` и `release/publish/edge/<версия>/netamipin-edge.zip` из `npm run extension:build` (без поля `key`). Картинки пересобирает `node scripts/store-assets.mjs`.

| Поле | Chrome Web Store | Edge Add-ons |
|---|---|---|
| Видимость | Unlisted | Hidden |
| Категория | Productivity → Workflow & Planning | Productivity |
| Языки карточки | English (основной), Русский | English (основной), Русский |
| Значок | 128×128 из пакета | `logo-300x300.png` |
| Скриншоты | `en/options-1280x800.png`, для русской карточки `ru/options-1280x800.png` | те же |
| Малая промо-плитка 440×280 | `en/promo-440x280.png`, `ru/promo-440x280.png` | те же (необязательно) |
| Сайт | https://pin.netami.app | https://pin.netami.app |
| Поддержка | https://pin.netami.app | https://pin.netami.app |
| Политика конфиденциальности | https://pin.netami.app/privacy (текст — [privacy.md](privacy.md)) | та же |

Название и краткое описание каталоги берут из `_locales` (`extensionName`, `extensionDescription`).

## Подробное описание

**English**

```text
Netami Pin keeps your links on your own computer. This extension adds one button to the toolbar: click it on any page and the page goes to the Netami Pin library — no account, no cloud.

• One click saves the page's address and title.
• If Netami Pin is closed, saving a page starts it in the tray.
• If the app can't take the link right now, the link waits in the browser and is sent again automatically.
• The settings page shows whether the extension is connected to the app and which links are waiting.

The extension works together with the Netami Pin desktop app for Windows (https://pin.netami.app). It talks only to that app on the same computer, through the browser's native messaging. Nothing is sent to the developer or to any server.
```

**Русский**

```text
Netami Pin хранит ваши ссылки на вашем компьютере. Расширение добавляет на панель одну кнопку: нажмите её на любой странице, и страница попадёт в библиотеку Netami Pin — без аккаунта и облака.

• Одно нажатие сохраняет адрес и заголовок страницы.
• Если Netami Pin закрыт, сохранение запустит его в трее.
• Если приложение сейчас не может принять ссылку, она ждёт в браузере и уходит повторно сама.
• Страница настроек показывает, связано ли расширение с приложением и какие ссылки ждут отправки.

Расширение работает вместе с приложением Netami Pin для Windows (https://pin.netami.app). Оно обращается только к этому приложению на том же компьютере через Native Messaging браузера. Разработчику и на какие-либо серверы ничего не отправляется.
```

## Вкладка Privacy (Chrome Web Store)

**Single purpose**

```text
Save the current page (its address and title) to the Netami Pin desktop app on the same computer with one click.
```

**Permission justification**

| Разрешение | Текст |
|---|---|
| `activeTab` | `When the user clicks the toolbar button, the extension reads the address and title of that tab to save it. It reads no other tabs and no page content.` |
| `scripting` | `Right after the user clicks the toolbar button, the extension shows a short note in the corner of that tab: saved, already saved, waiting for the app, or not saved. It runs only on the clicked tab, through activeTab, reads nothing from the page, and the note can be turned off in the extension settings.` |
| `tabs` (optional) | `Optional, requested only when the user turns on «Show that a page is already saved» in the extension settings. The extension then checks the address of each page the user opens against the user's own Netami Pin library on the same computer, through native messaging, and marks the button. Turning the setting off removes the permission. Nothing is sent anywhere else.` |
| `contextMenus` | `Adds «Find a link» to the right-click menu of the extension's toolbar button. It opens the extension's search over the user's own Netami Pin library. No other menus are changed.` |
| `nativeMessaging` | `The saved link is delivered to the Netami Pin desktop app on the same computer through native messaging. The app's installer registers the native host; the extension talks to nothing else.` |
| `storage` | `Links wait in local extension storage until the app confirms them, so nothing is lost while the app is closed or busy. Also keeps the time of the last save shown on the settings page.` |
| `alarms` | `Retries delivery of waiting links once a minute, and tells the app twice a day that the browser is still connected.` |

**Remote code:** `No, I am not using remote code.`

**Data usage.** Отметить **Web history**: расширение передаёт адрес и заголовок страницы, которую пользователь сам сохраняет, — только в приложение на этом же компьютере. Остальные категории не отмечать. Отметить все три заявления: данные не продаются третьим лицам, не используются для целей, не связанных с единственным назначением, не используются для кредитных решений.

## Заметки для проверки

Edge Add-ons: поле «Notes for certification». Chrome Web Store: поле для проверяющих на вкладке Distribution, если оно есть.

```text
The extension is a companion to the Netami Pin desktop app for Windows. Without the app, clicking the button keeps the link in a local queue and the settings page says that Netami Pin isn't installed, with a download link. With the app installed (https://pin.netami.app), clicking the button saves the current page to the app's library; the app starts in the tray if it was closed. A short note in the corner of the page and an animation of the button confirm the save; the note can be turned off in the extension settings. Alt+Shift+D (or «Find a link» in the button's right-click menu) opens a popup that searches the same local library through the app; a click on the button still saves the page. The extension has no host permissions and makes no network requests.
```

## Порядок

1. Загрузить пакет в черновик. ID появляется сразу: в Chrome Web Store — в адресе и на вкладке Package, в Edge — «CRX ID» в Extension identity. ID в Edge отличается от ID в Chrome.
2. ID вписать в `STORE_EXTENSION_IDS` (`src-tauri/src/native_host.rs`): с ними установщик (`--features public-release`) разрешает host только каталожным расширениям.
3. Заполнить карточку по этому файлу. На проверку с видимостью Unlisted / Hidden отправлять после установщика (NP-037): без приложения проверяющий видит только «Netami Pin не установлен» (решение владельца 4 окт. 2026). В заметку для проверяющих — ссылку на установщик.
4. После одобрения ссылки на карточки — в `storeLinks` (`src/services/capture.ts`): «Подключить браузер» показывает установку из каталога вместо режима разработчика.
