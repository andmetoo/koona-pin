# Сайт pin.netami.app

Макеты от 5 октября 2026 года, задача NP-079 (#82). Состояние: **макеты приняты владельцем 5 октября 2026 года, сайт собран в коде** (`site/`, `scripts/build-site.mjs`); выкладывает владелец. Источник вида — `design/lunacy/landing.sketch`; цвета, шрифт и маскот — по [гайдлайну](guidelines.md#бренд).

## Страницы и адреса

| Адрес | Что |
| --- | --- |
| `/`, `/ru/` | Лендинг на английском и русском |
| `/privacy`, `/ru/privacy` | Политика конфиденциальности, текст из `extension/store/privacy.md` |
| `/licenses`, `/ru/licenses` | Лицензии шрифтов, иконок и библиотек; вёрстка страницы privacy, отдельного кадра нет |
| `/firefox/updates.json`, `/firefox/netamipin-firefox-<версия>.xpi` | Обновления Firefox (NP-018). Адрес зашит в подписанный XPI и не меняется |

Сайт статический, без серверной части и без скриптов на страницах. Хостинг — сервер владельца с Caddy ([Р-37](decisions.md#р-37-сайт-pinnetamiapp-статика-на-сервере-владельца-надпись-nunito)), конфиг — `site/Caddyfile`, выкладка — ниже.

## Правила

- Без аналитики, трекеров, cookies и сторонних доменов: шрифт Inter, маскот и картинки лежат на сайте. Иначе сайт противоречит собственной политике.
- Надпись «netami pin» рядом с маскотом — Nunito ExtraBold (вариант B листа «Wordmark · options»), на сайте кривыми в SVG, без файла шрифта. Остальной текст — Inter.
- Логотип один — в шапке. Маскот крупно сидит над блоком загрузки («ждёт выпуска»), не на первом экране.
- Язык: при первом заходе на `/` по языку браузера, переключатель EN / RU в шапке ведёт на ту же страницу другого языка. Выбор не хранится в cookies.
- Тема — по системе (`prefers-color-scheme`), переключателя нет.
- Ширины: кадры 1440 и 390; без горизонтальной прокрутки от 360 до 1920. Заголовки — `text-wrap: balance`, чтобы на узком экране не оставалось одного слова в строке.
- Скриншоты приложения — настоящая сборка (WebView2, SQLite) в своей папке данных, `scripts/site-screenshots.mjs`: выборка закладок `site/shots/library.json`, превью — фото Unsplash из `site/shots/previews` (авторы — `CREDITS.md` там же и страница `/licenses`), Chrome подключён через хост. Тёмных русских снимков нет: русские страницы в тёмной теме показывают английские. В макетах — браузерное превью с фото Icons8.
- Цвет второстепенного текста на сайте — `#6b6b61` вместо `--muted` `#74746a` приложения: на фоне `#faf9f6` прежний даёт 4,48:1, ниже порога 4,5:1 для мелкого текста.
- Превью закладок на публичных скриншотах — только картинки, которые можно показывать: свои или с лицензией без условий (например, CC0). OpenGraph-картинки чужих сайтов и фото Icons8 (бесплатная лицензия требует ссылки) на сайт не идут.
- На 390 скриншот обрезается: левая часть окна в половинном масштабе (боковая панель и первые карточки), а не всё окно в мелком виде.
- Пока установщика нет, раздел загрузки в состоянии «beta скоро» без ссылок на файлы. Ссылки на установщик и расширения добавляет NP-040, вид — лист «Download · states».

## Лендинг

Порядок блоков сверху вниз.

| # | Блок | Содержание |
| --- | --- | --- |
| 1 | Шапка | Маскот 36 px и надпись; ссылки «How it works», «Privacy», «Download»; переключатель EN / RU. На 390 ссылок нет — логотип и язык |
| 2 | Первый экран | Заголовок, подзаголовок, плашка «скоро» и кнопка «How it works», строка «Windows 11 · Chrome, Edge, Firefox · Free»; скриншот сетки приложения |
| 3 | Три свойства | Карточки с иконкой: одна кнопка · на вашем компьютере · без аккаунта |
| 4 | Как это работает | Три шага с номерами |
| 5 | Что внутри | Пять возможностей с иконками; на 1440 рядом скриншот списка |
| 6 | Браузеры | Chrome 120+, Edge 120+, Firefox 140+ |
| 7 | Приватность коротко | Панель на мягком акценте: заголовок, абзац, ссылка на политику, четыре факта |
| 8 | Загрузка | Маскот, «beta скоро», системные требования |
| 9 | Подвал | Privacy, Licenses, Support, © 2026 Netami, «No cookies, no analytics» |

### Тексты

| Блок | English | Русский |
| --- | --- | --- |
| Заголовок | Save a link in one click. / Find it when you need it. | Сохраняйте ссылки одной кнопкой. / Находите, когда понадобятся. |
| Подзаголовок | Netami Pin is a bookmark library for Windows. Pages arrive from Chrome, Edge and Firefox with one button and stay on your computer. No account, no cloud. | Netami Pin — библиотека закладок для Windows. Страницы попадают в неё из Chrome, Edge и Firefox одной кнопкой и остаются на вашем компьютере. Без аккаунта и облака. |
| Плашка «скоро» | Windows beta — coming soon | Windows-beta — скоро |
| Строка под кнопкой | Windows 11 · Chrome, Edge, Firefox · Free | Windows 11 · Chrome, Edge, Firefox · Бесплатно |
| Свойство 1 | One button — Click it on any page and the link is saved — even when the app is closed. | Одна кнопка — Нажмите на любой странице — ссылка сохранится, даже если приложение закрыто. |
| Свойство 2 | On your computer — The library is a file on your disk, with automatic backups. Works offline. | На вашем компьютере — Библиотека — файл на вашем диске, с автоматическими копиями. Работает без сети. |
| Свойство 3 | No account — Nothing to sign up for. The developer never sees your links. | Без аккаунта — Регистрироваться не нужно. Разработчик не видит ваших ссылок. |
| Шаг 1 | Install the app — Netami Pin for Windows starts with the system and waits in the tray. | Установите приложение — Netami Pin для Windows запускается вместе с системой и ждёт в трее. |
| Шаг 2 | Add the extension — Chrome, Edge or Firefox. It talks only to the app on your computer. | Добавьте расширение — Chrome, Edge или Firefox. Оно общается только с приложением на вашем компьютере. |
| Шаг 3 | Click the button — The page lands in Inbox. Sort it later — it takes about a minute. | Нажмите кнопку — Страница попадёт во «Входящие». Разберите потом — это займёт около минуты. |
| Что внутри | Find it, sort it, keep it: Sort the inbox from the keyboard · Search titles, sites and tags · Collections and tags · Trash keeps links for 30 days · Import and export | Найти, разобрать, сохранить: Разбор входящих с клавиатуры · Поиск по названию, сайту и тегам · Коллекции и теги · Корзина хранит ссылки 30 дней · Импорт и экспорт |
| Браузеры | Works with your browser | Работает с вашим браузером |
| Приватность | Your links stay with you. Netami Pin keeps everything on your computer. There is no server to send it to. Facts: the extension reads only the address and title of the tab you save · no analytics, telemetry or crash reports · no account and no cloud · this site sets no cookies | Ваши ссылки остаются у вас. Netami Pin хранит всё на вашем компьютере. Отправлять это некуда: сервера нет. Факты: расширение читает только адрес и заголовок сохраняемой вкладки · ни аналитики, ни телеметрии, ни отчётов о сбоях · ни аккаунта, ни облака · этот сайт не ставит cookies |
| Загрузка, «скоро» | Windows beta is on its way. The installer and the browser extensions will be published here. | Windows-beta уже в пути. Установщик и расширения для браузеров появятся здесь. |
| Требования | Windows 11, 64-bit (no administrator rights needed) · Chrome or Edge 120+, Firefox 140+ (current release or ESR 140) | Windows 11, 64 бит (права администратора не нужны) · Chrome или Edge 120+, Firefox 140+ (текущий релиз или ESR 140) |

Тексты подробных пунктов «Что внутри» — в кадрах. Русские строки длиннее английских на 15–25 %: плашка «скоро», ссылки подвала и заголовок «Что внутри» на 390 подобраны по русскому тексту в кадрах RU.

## Privacy

Колонка текста 680 px на 1440, поля 16 px на 390: «← Netami Pin», заголовок, дата обновления, вводный абзац, разделы политики с подзаголовками, тот же подвал; в шапке активна ссылка «Privacy». Текст — `extension/store/privacy.md`. Перед публикацией его нужно сверить с поведением приложения и дополнить: проверку обновлений (NP-038, `latest.json` с GitHub) текущая политика не упоминает.

## Кадры

Все кадры — в `design/lunacy/landing.sketch`, координаты — левый верхний угол.

| Кадр | Где |
| --- | --- |
| Landing · 1440 · Light · EN / Dark · EN / Light · RU | 0 · 0 / 1600 · 0 / 3200 · 0 |
| Landing · 390 · Light · EN / Dark · EN / Light · RU | 4800 · 0 / 5290 · 0 / 5800 · 0 |
| Wordmark · options | 0 · 4000 |
| Privacy · 1440 · Light · EN / Dark · EN / Light · RU | 0 · 5600 / 1600 · 5600 / 3200 · 5600 |
| Privacy · 390 · Light · EN / Dark · EN | 4800 · 5600 / 5290 · 5600 |
| Download · states (скоро и доступна, обе темы) | 0 · 7800 |

## Сборка и проверка

| Команда | Что делает |
| --- | --- |
| `npm run site:build` | Собирает `dist-site/`: страницы en/ru, `site.css`, шрифт Inter (латиница, расширенная латиница, кириллица), маскот, favicon, скриншоты, `robots.txt`, `sitemap.xml`; `release/firefox` целиком, если он есть, со сверкой хешей XPI с `updates.json` |
| `npm run site:check` | Сборка и проверка: каждая страница на 360, 390, 1440, 1920 в обеих темах — без горизонтальной прокрутки, без запросов к другим доменам, без cookies, ссылки внутри сайта открываются, `/` для русского браузера ведёт на `/ru/`, а EN с `/ru/` — на `/`; снимки в `test-results/site` |
| `npm run site:serve` | Локальный сервер `dist-site/` с правилами `site/Caddyfile` (try_files, 404, переадресация языка, заголовки) на `http://127.0.0.1:4173` |
| `npm run site:shots` | Скриншоты настоящего приложения в `site/src/shots` (1920 и 1280 px WebP, `og-<lang>.jpg` 1200×630). Нужна отладочная сборка (`cargo build --manifest-path src-tauri/Cargo.toml`), собственный Netami Pin закрыт (один экземпляр на пользователя) |
| `node scripts/site-wordmark.mjs` | Надпись кривыми из Nunito ExtraBold в `site/src/brand/wordmark.svg`; только если надпись меняется |

Lighthouse (мобильный, 5 октября 2026 года, `npx lighthouse@12` с Chromium Playwright через `CHROME_PATH`, на `npm run site:serve`, настоящие скриншоты): `/`, `/ru/`, `/privacy`, `/ru/licenses` — Performance 99–100, Accessibility 100, Best Practices 100, SEO 100. `connect-src 'self'` в CSP нужен только для этой проверки: Lighthouse читает `robots.txt` запросом из страницы.

## Выкладка

Выкладывает владелец ([Р-37](decisions.md#р-37-сайт-pinnetamiapp-статика-на-сервере-владельца-надпись-nunito)). Нужны Caddy 2.7 или новее на сервере и доступ по SSH с `sudo`.

1. **DNS:** запись `A` (и `AAAA`, если у сервера есть IPv6) для `pin.netami.app` на адрес сервера; для `www.pin.netami.app` — та же или `CNAME` на `pin.netami.app`. Порты 80 и 443 открыты: Caddy сам получает и продлевает сертификат.
2. **Первый раз:** в главном конфиге сервера (`/etc/caddy/Caddyfile`) добавить строку `import /srv/pin.netami.app/Caddyfile`. Скрипт ниже кладёт `site/Caddyfile` в `/srv/pin.netami.app/Caddyfile`, файлы сайта — в `/srv/pin.netami.app/site`, лог — `/var/log/caddy/pin.netami.app.log` (без заголовков, параметров адреса и с обрезанным IP).
3. **Скриншоты** (если менялся интерфейс или выборка): закрыть свой Netami Pin, `npm run site:shots`, закоммитить `site/src/shots`.
4. **Обновления Firefox:** после `npm run extension:sign:firefox` новые XPI и `updates.json` лежат в `release/firefox`; сборка сайта забирает их и сверяет хеши.
5. **Выкладка:**
   ```powershell
   pwsh scripts/deploy-site.ps1 -Server user@host
   ```
   Скрипт собирает сайт, копирует архив и `Caddyfile` по `scp`, распаковывает рядом со старой версией, проверяет конфиг (`caddy validate`), меняет папки местами и перезагружает Caddy (`systemctl reload caddy`). Предыдущая версия остаётся в `site.old`: откат — `sudo mv /srv/pin.netami.app/site.old /srv/pin.netami.app/site` после переименования текущей.
6. **Проверка после выкладки:** открываются `https://pin.netami.app`, `/ru/`, `/privacy`, `/ru/privacy`, `/licenses`; `https://pin.netami.app/firefox/updates.json` отдаёт JSON; в инструментах разработчика нет запросов к другим доменам и cookies; с русским языком браузера `/` переходит на `/ru/`.

## Открытые вопросы

1. Ссылка «Support»: сейчас ведёт на `https://github.com/andmetoo/netami-pin-releases/issues/new/choose`. Почта на `netami.app` ([Р-9](decisions.md#р-9-распространение-windows)) — добавить, когда появится адрес.
2. Надпись Nunito ExtraBold выбрана для сайта. Перенос в `logo.sketch`, гайдлайн и боковую панель приложения — отдельной задачей, если владелец решит менять надпись везде.
