# Сайт koona.app/pin

Макеты от 5 октября 2026 года, задача NP-079 (#82). Состояние: **макеты приняты владельцем 5 октября 2026 года; 7 октября 2026 года сайт переезжает на https://koona.app/pin/ ([Р-47](decisions.md#р-47-koona-домен-koonaapp-и-приложения-путями-открытый-код))** (`site/`, Astro, `scripts/build-site.mjs`, выкладывает владелец; с 9 октября 2026 года на Astro, NP-115). Источник вида — `design/lunacy/landing.sketch`; цвета, шрифт и маскот — по [гайдлайну](guidelines.md#бренд).

## Страницы и адреса

Все адреса ниже — внутри `https://koona.app/pin` (`BASE` в `site/src/content.mjs`): `/de/` — это `koona.app/pin/de/`. Лендинг, privacy, licenses и отзыв есть на всех языках сайта ([Р-49](decisions.md#р-49-сайт-на-языках-приложения)): английский без префикса, остальные — `/<код>/…`: `/ru/`, `/de/`, `/es/`, `/fr/`, `/it/`, `/pl/`, `/pt-br/`, `/sr/` (сербский латиницей), `/tr/`, `/uk/`, `/zh-cn/` (китайский упрощённый), `/ja/`, `/ko/` (NP-090, [Р-51](decisions.md#р-51-китайский-японский-и-корейский)). Загрузки, журнал изменений и документация — только на английском, без переключателя языка (решение владельца 9 октября 2026 года, NP-040): `/pin/downloads/`, `/pin/changelog/`.

| Адрес | Что |
| --- | --- |
| `/`, `/<код>/` | Лендинг |
| `/privacy`, `/<код>/privacy` | Политика конфиденциальности, текст из `extension/store/privacy.md`; на языках, кроме английского и русского, — с пометкой о переводе и ссылкой на английский текст |
| `/licenses`, `/<код>/licenses` | Лицензии шрифтов, иконок и библиотек; вёрстка страницы privacy, отдельного кадра нет |
| `/feedback`, `/<код>/feedback` и `…/feedback/sent`, `/limit`, `/long`, `/origin`, `/error` | Форма отзыва и страницы, на которые её возвращает Edge Function (NP-088) на языке формы; вёрстка страницы privacy, отдельного кадра нет. Собираются, только если задан `KOONAPIN_FEEDBACK_URL` |
| `/downloads/` | Загрузка (NP-040, NP-103), только английский: карточки Windows, Linux (`.deb`, `.rpm`, AppImage с 0.5.0 — NP-116; AUR — «Coming soon»), macOS («Coming soon»), расширения (Chrome и Edge — «Coming soon» до каталогов, Firefox — подписанный XPI); команды установки, «Good to know» для Linux, проверка `SHA256SUMS.txt`, сетевые запросы приложения, помощь. Только последняя версия: старые сборки не раздаются (Р-10) |
| `/changelog/` | Журнал изменений, только английский: у версии номер, дата и список — тот же, что показывает диалог обновления в приложении. Без постов, заголовков и скриншотов |
| `/downloads/<версия>/…`, `/updates/latest.json` | Пакеты и манифест обновлений ([Р-60](decisions.md#р-60-обновление-приложения), дополнение 9 октября) |
| `/firefox/updates.json`, `/firefox/koonapin-firefox-<версия>.xpi` | Обновления Firefox (NP-018). Адрес зашит в подписанный XPI: после первого выпуска не меняется |

Сайт статический, без серверной части и без скриптов на страницах. Единственная форма — отзыв (NP-088): обычный `<form>`, POST прямо в Edge Function `feedback` в Supabase, CSP разрешает `form-action` только `https://*.supabase.co`. Хостинг — сервер владельца с Caddy ([Р-37](decisions.md#р-37-сайт-koonaapppin-статика-на-сервере-владельца-надпись-nunito)), конфиг — `site/Caddyfile`, выкладка — ниже.

## Как устроен

С 9 октября 2026 года сайт собирает Astro (NP-115, [Р-62](decisions.md#р-62-сайт-на-astro)); вид и адреса не изменились — HTML всех 142 страниц и снимки `site:check` совпали с прежним генератором.

| Где | Что |
| --- | --- |
| `site/astro.config.mjs` | `base: '/pin'`, вывод в `release/publish/site`, `build.format: 'preserve'` — файлы там, где их ищет Caddy (`privacy.html`, `feedback/index.html`, `de/index.html`); стиль только файлом (CSP без `'unsafe-inline'`), картинки и шрифты без `data:` |
| `site/src/pages/[...lang]/` | Страницы на всех языках: `index`, `privacy`, `licenses`, `404`, `feedback/index`, `feedback/[outcome]`; английский — без префикса. Форма отзыва — только с `KOONAPIN_FEEDBACK_URL` |
| `site/src/pages/[downloads]/`, `changelog/` | Страницы только на английском; `/downloads/` — только если есть выпуск |
| `site/src/layouts/`, `components/` | Общая вёрстка (`Page`: head, шапка с меню языка, подвал; `TextPage`: страница текста), значки, маскот, скриншот, сцены, блок загрузки |
| `site/src/content.mjs`, `locales/` | Тексты, языки и их проверка (ключи как у английского, без пустых строк и смешения письменностей); читают и тесты приложения и функции отзыва |
| `site/content/changelog/<версия>.md` | Коллекция `changelog` (`site/src/content.config.mjs`): `date` сверху, затем строки `- …`. Разбор строк общий со сборкой обновления (`site/src/changelog.mjs`): диалог в приложении и страница показывают одно и то же |
| `site/src/assets.mjs` | Файлы, которые страницы берут из `design/brand`, `src-tauri/icons`, шрифт Inter и `site/src/shots`: Vite кладёт их в `/pin/_astro/` с хешем в имени |

Страниц без Astro нет: выпуски, обновления Firefox и скриншоты под прежними именами добавляет `scripts/build-site.mjs` после сборки. В страницах ноль скриптов — Astro их не добавляет, а сборка падает, если `<script>` появится.

## Правила

- Обещания приватности — про приложение и расширение, не про сайт: сайт — страница для скачивания. Сайт без cookies и рекламных трекеров, шрифт Inter, маскот и картинки лежат на нём самом; единственный сторонний скрипт — Cloudflare Web Analytics, который вставляет Cloudflare (без cookies, [Р-37](decisions.md#р-37-сайт-koonaapppin-статика-на-сервере-владельца-надпись-nunito)), он раскрыт в политике (раздел «This website»).
- Надпись «koona pin» рядом с маскотом — Nunito ExtraBold (вариант B листа «Wordmark · options»), на сайте кривыми в SVG, без файла шрифта. Остальной текст — Inter.
- Логотип один — в шапке. Маскот крупно сидит над блоком загрузки («ждёт выпуска»), не на первом экране.
- Язык: при первом заходе на `/` — по первому языку браузера (`site/Caddyfile`, регион не важен: `de-AT` → `/de/`, `pt-PT` → `/pt-br/`, `sr-RS` и `sr-Latn-RS` → `/sr/`; `zh`, `zh-CN`, `zh-Hans-SG` → `/zh-cn/`, а `zh-TW`, `zh-HK` и `zh-Hant` — английский: письмо другое); меню языка в шапке ведёт на ту же страницу другого языка. Выбор не хранится в cookies.
- Меню языка (NP-107, лист «Language menu»): кнопка «🌐 English ▾» и панель в две колонки — родное название языка и под ним название на языке страницы; текущий язык — мягкий акцент и галочка. Открывается без скриптов: `:hover` и `:focus-within` (Tab, нажатие на кнопку). На узком экране панель во всю ширину с отступами 16 px и затемнением страницы, на кнопке — код языка.
- Тексты — `site/src/locales/<код>.mjs`, термины — по [глоссарию](glossary.md). Сборка падает, если у языка другие ключи, чем у английского, пустая строка или слово из латиницы вперемешку с кириллицей. Шрифт китайского, японского и корейского — системный, по `:lang()` любого элемента с `lang`, Inter их не содержит ([guidelines.md](guidelines.md#шрифт)). Новый язык: файл текстов и строки в `site/src/locales/index.mjs`, раздел в `extension/store/privacy.md`, строки в `site/Caddyfile` (переадресация и 404) и `SITE_PATHS` в `src/services/feedback.ts` и `supabase/functions/feedback/handler.ts` ([Р-49](decisions.md#р-49-сайт-на-языках-приложения)).
- Тема — по системе (`prefers-color-scheme`), переключателя нет.
- Ширины: кадры 1440 и 390; без горизонтальной прокрутки от 360 до 1920. Заголовки — `text-wrap: balance`, чтобы на узком экране не оставалось одного слова в строке.
- Скриншоты приложения — настоящая сборка (WebView2, SQLite) в своей папке данных, `scripts/site-screenshots.mjs`: выборка закладок `site/shots/library.json`, превью — фото Unsplash из `site/shots/previews` (авторы — `CREDITS.md` там же и страница `/licenses`), Chrome подключён через хост. Фото отдаются с имени `previews.koona.test`, которое только WebView съёмки направляет на локальный сервер (`--host-resolver-rules`): картинки с локальных адресов приложение из копии отбрасывает (NP-019). Язык интерфейса снимка выбирается настройкой: по умолчанию приложение говорит по-английски (NP-085). Скрипт падает, если в сетке не загрузилось ни одно фото. Тёмных русских снимков нет: русские страницы в тёмной теме показывают английские. В макетах — браузерное превью с фото Icons8.
- Цвет второстепенного текста на сайте — `#6b6b61` вместо `--muted` `#74746a` приложения: на фоне `#faf9f6` прежний даёт 4,48:1, ниже порога 4,5:1 для мелкого текста.
- Превью закладок на публичных скриншотах — только картинки, которые можно показывать: свои или с лицензией без условий (например, CC0). OpenGraph-картинки чужих сайтов и фото Icons8 (бесплатная лицензия требует ссылки) на сайт не идут.
- На 390 скриншот обрезается: левая часть окна в половинном масштабе (боковая панель и первые карточки), а не всё окно в мелком виде.
- ~~Пока установщика нет, раздел загрузки в состоянии «beta скоро»~~ — с NP-040 на первом экране кнопка «Download», внизу блок загрузки: Windows — главная кнопка, под ней строка «Linux» с кнопками `.deb`, `.rpm` и AppImage (NP-116), расширения, ссылка на `/downloads/`. Слово «beta» на сайте не пишется — ни на кнопках, ни в строке версии (решение владельца 9 октября 2026 года). Строка версии — «0.3.5 · 9 October 2026».
- Ссылка «Changelog» — в подвале всех страниц, в шапке её нет.
- Анимации — только CSS, без скриптов: первый экран при загрузке проявляется с подъёмом на 8 px (около 0,4 с, один раз, с небольшой задержкой между заголовком, текстом и кнопками); разделы проявляются при прокрутке (`animation-timeline: view()`, без поддержки — сразу видны); наведение меняет цвет кнопок и рамки карточек, стрелка загрузки смещается на 2 px вниз. Анимируются только `opacity` и `transform`. При `prefers-reduced-motion: reduce` анимаций нет.

## Лендинг

Порядок блоков сверху вниз.

| # | Блок | Содержание |
| --- | --- | --- |
| 1 | Шапка | Маскот 36 px и надпись; ссылки «How it works», «Privacy», «Download»; меню языка. На 390 ссылок нет — логотип и язык |
| 2 | Первый экран | Заголовок, подзаголовок, плашка «скоро» и кнопка «How it works», строка «Windows 11, Linux · Chrome, Edge, Firefox · Free»; скриншот сетки приложения |
| 3 | Три свойства | Сцены из самого продукта, HTML и CSS сайта, без иконок и карточек: панель браузера с вкладками Chrome, Edge, Firefox, кнопкой Koona Pin и сообщением «Saved to Koona Pin» · окно папки с файлом библиотеки и копиями, на нём маскот · три окна приложения в рамках Windows, Linux и macOS. Под сценой заголовок и текст; слова в сценах переведены (`scene` в локали). Мягкий фон под сценой (`--soft` на `--panel`). На 900–1199 сцена слева, текст справа; на 390 в одну колонку |
| 4 | Как это работает | Три шага с номерами |
| 5 | Что внутри | Пять возможностей с иконками; на 1440 рядом скриншот списка |
| 6 | Приватность коротко | Панель на мягком акценте: заголовок, абзац, ссылка на политику, три факта о приложении и расширении (в макете четвёртый — «сайт не ставит cookies» — убран в коде) |
| 7 | Загрузка | Маскот, «beta скоро», системные требования |
| 8 | Подвал | Privacy, Licenses, Support, © 2026 Koona |

### Тексты

| Блок | English | Русский |
| --- | --- | --- |
| Заголовок | Save a link in one click. / Find it when you need it. | Сохраняйте ссылки одной кнопкой. / Находите, когда понадобятся. |
| Подзаголовок | Koona Pin is a desktop bookmark library. Pages arrive from Chrome, Edge and Firefox with one button and stay on your computer. | Koona Pin — библиотека закладок для компьютера. Страницы попадают в неё из Chrome, Edge и Firefox одной кнопкой и остаются на вашем компьютере. |
| Плашка «скоро» | Beta — coming soon | Beta — скоро |
| Строка под кнопкой | Windows 11, Linux · Chrome, Edge, Firefox · Free | Windows 11, Linux · Chrome, Edge, Firefox · Бесплатно |
| Свойство 1 | One button — Click it on any page and the link is saved — even when the app is closed. In Chrome, Edge or Firefox. | Одна кнопка — Нажмите на любой странице — ссылка сохранится, даже если приложение закрыто. В Chrome, Edge или Firefox. |
| Свойство 2 | On your computer — The library is a file on your disk, with automatic backups. Works offline. | На вашем компьютере — Библиотека — файл на вашем диске, с автоматическими копиями. Работает без сети. |
| Свойство 3 | Any computer — Windows, macOS or Linux — the same app and the same button on each. | Любой компьютер — Windows, macOS или Linux — везде то же приложение и та же кнопка. |
| Шаг 1 | Install the app — Koona Pin starts with the system and waits in the tray. | Установите приложение — Koona Pin запускается вместе с системой и ждёт в трее. |
| Шаг 2 | Add the extension — Chrome, Edge or Firefox. It talks only to the app on your computer. | Добавьте расширение — Chrome, Edge или Firefox. Оно общается только с приложением на вашем компьютере. |
| Шаг 3 | Click the button — The page lands in Inbox. Sort it later — it takes about a minute. | Нажмите кнопку — Страница попадёт во «Входящие». Разберите потом — это займёт около минуты. |
| Что внутри | Find it, sort it, keep it: Sort the inbox from the keyboard · Search titles, sites and tags · Collections and tags · Trash keeps links for 30 days · Import and export | Найти, разобрать, сохранить: Разбор входящих с клавиатуры · Поиск по названию, сайту и тегам · Коллекции и теги · Корзина хранит ссылки 30 дней · Импорт и экспорт |
| Приватность | Your links stay with you. Koona Pin keeps your library on your computer: no server ever sees your links. Only feedback you choose to send reaches the developer. Facts: the extension reads only the address and title of the tab you save · the app sends no analytics, telemetry or crash reports · everything works offline | Ваши ссылки остаются у вас. Koona Pin хранит библиотеку на вашем компьютере: ваши ссылки не видит ни один сервер. Разработчику уходит только отзыв, который вы отправите сами. Факты: расширение читает только адрес и заголовок сохраняемой вкладки · приложение не отправляет аналитику, телеметрию и отчёты о сбоях · всё работает без сети |
| Загрузка, «скоро» | The beta is on its way. Packages for Windows and Linux and the browser extensions will be published here. | Beta уже в пути. Пакеты для Windows и Linux и расширения для браузеров появятся здесь. |
| Требования | Windows 11, 64-bit (no administrator rights needed) · Linux, 64-bit (Ubuntu 26.04, Debian 13, Fedora 44, Arch Linux) · Chrome or Edge 120+, Firefox 140+ (current release or ESR 140) | Windows 11, 64 бит (права администратора не нужны) · Linux, 64 бит (Ubuntu 26.04, Debian 13, Fedora 44, Arch Linux) · Chrome или Edge 120+, Firefox 140+ (текущий релиз или ESR 140) |

Тексты подробных пунктов «Что внутри» — в кадрах. Русские строки длиннее английских на 15–25 %: плашка «скоро», ссылки подвала и заголовок «Что внутри» на 390 подобраны по русскому тексту в кадрах RU.

7 октября 2026 года тексты сайта стали без привязки к одной системе: «desktop», «для компьютера» вместо «for Windows»; системы перечисляют только строка под кнопкой и требования, Linux — по контракту Linux-beta (Р-45). В landing.sketch остались прежние тексты.

9 октября 2026 года свойства стали сценами (вариант со смягчённым фоном; нарисованы слоями в кадрах «Landing · … · NP-040» landing.sketch), блок «Работает с вашим браузером» убран: браузеры названы в первом свойстве. Третье свойство — не «без аккаунта» (будет платная синхронизация без сервера), а «любой компьютер»: Windows, macOS и Linux на равных. По той же причине «No account, no cloud» убрано из подзаголовка и описания, а третий факт о приватности — «Everything works offline»; политика конфиденциальности описывает приложение как есть и меняется вместе с синхронизацией.

## Privacy

Колонка текста 680 px на 1440, поля 16 px на 390: «← Koona Pin», заголовок, дата обновления, вводный абзац, разделы политики с подзаголовками, тот же подвал; в шапке активна ссылка «Privacy». Текст — `extension/store/privacy.md`. Перед публикацией его нужно сверить с поведением приложения; проверка обновлений (NP-038, `latest.json` с koona.app) описана 9 октября 2026 года.

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
| Language menu · 1440 · Light · open / 390 · Light · open / 1440 · Dark · open (NP-107) | 0 · 9600 / 1600 · 9600 / 2200 · 9600 |
| Downloads · 1440 · Light / Dark · EN (NP-040) | 0 · 11000 / 0 · 15300 |
| Changelog · 1440 · Light / Dark · EN (NP-040) | 1600 · 11000 / 1600 · 15300 |
| Landing · 1440 · Light / Dark · EN · NP-040 — первый экран и блок загрузки | 3200 · 11000 / 3200 · 15300 |
| Downloads · 390 · Light / Dark · EN | 4800 · 11000 / 4800 · 15300 |
| Changelog · 390 · Light / Dark · EN | 5290 · 11000 / 5290 · 15300 |
| Landing · 390 · Light / Dark · EN · NP-040 | 5780 · 11000 / 6270 · 11000 |
| Pricing · 1440 · Light / Dark · EN · NP-066 | 0 · 20000 / 1600 · 20000 |
| Pricing · 390 · Light / Dark · EN · NP-066 | 3200 · 20000 / 3690 · 20000 |
| Checkout · 1 opening, 2 didn't load, 3 closed, 4 thank you · 1440 · Light / Dark · NP-066 | 0, 1600, 3200, 4800 · 23200 / то же · 24100 |

Кадры NP-040 приняты владельцем 9 октября 2026 года. «Download · states» (0 · 7800) и прежние кадры лендинга остаются историей NP-079; источник вида загрузки — кадры NP-040.

Кадры NP-066 — страницы `/pricing/` и `/checkout/` ([Р-64](decisions.md#р-64-supporter-через-paddle)) — нарисованы 9 октября 2026 года и ждут приёмки. Окно оплаты в них — заглушка: его рисует Paddle.

## Сборка и проверка

| Команда | Что делает |
| --- | --- |
| `bun run site:build` | Собирает `release/publish/site/`: Astro строит страницы всех языков, `sitemap.xml` (`robots.txt` — у корня `koona.app`) и `/pin/_astro/` — стиль, шрифт Inter (латиница, расширенная латиница, кириллица), маскот, favicon, скриншоты с хешем в имени; затем `scripts/build-site.mjs` проверяет, что в страницах нет `<script>`, кладёт скриншоты под прежними именами в `/pin/shots/`, `release/publish/firefox` целиком со сверкой хешей XPI с `updates.json` и новейший выпуск со сверкой подписей |
| `bun run site:check` | Сборка и проверка: каждая страница каждого языка на 360, 390, 1440, 1920 в обеих темах — без горизонтальной прокрутки и обрезанных подписей, без запросов к другим доменам, без cookies, ссылки внутри сайта открываются; меню языка открывается наведением и Tab и не выходит за экран; `/pin/` ведёт на язык браузера для каждого языка сайта, а English из меню `/pin/ru/` — на `/pin/`; у каждого языка своя 404 в Caddyfile. Снимки en, ru, de, sr и ja (страницы и открытое меню) — в `test-results/site`; перед снимком страница дожидается всех картинок, в том числе ленивых |
| `bun run site:serve` | Локальный сервер `release/publish/site/` с правилами `site/Caddyfile` (`/pin` → `/pin/`, try_files, 404, переадресация языка — читается из Caddyfile, заголовки) на `http://127.0.0.1:4173/pin/`; `/` стоит за корневой сайт и ведёт на `/pin/` |
| `bun run site:shots` | Скриншоты настоящего приложения в `site/src/shots` (1920 и 1280 px WebP, `og-<lang>.jpg` 1200×630). Сначала сам собирает отладочное приложение со встроенным интерфейсом (`scripts/build-test-app.mjs`), Vite не нужен; собственный Koona Pin закрыт (один экземпляр на пользователя) |
| `bun scripts/site-wordmark.mjs` | Надпись кривыми из Nunito ExtraBold в `site/src/brand/wordmark.svg`; только если надпись меняется |

Lighthouse (мобильный, 5 октября 2026 года, `npx lighthouse@12` с Chromium Playwright через `CHROME_PATH`, на `npm run site:serve`, настоящие скриншоты): `/`, `/ru/`, `/privacy`, `/ru/licenses` — Performance 99–100, Accessibility 100, Best Practices 100, SEO 100. `connect-src 'self'` в CSP нужен только для этой проверки: Lighthouse читает `robots.txt` запросом из страницы.

## Выкладка

Выкладывает владелец ([Р-37](decisions.md#р-37-сайт-koonaapppin-статика-на-сервере-владельца-надпись-nunito), [Р-47](decisions.md#р-47-koona-домен-koonaapp-и-приложения-путями-открытый-код)). Сервер — Fedora 44 с Caddy 2 (пакет Fedora) и firewalld, с 9 октября 2026 года; домен за прокси Cloudflare (оранжевое облако), между Cloudflare и сервером — Cloudflare Origin Certificate в режиме «Full (strict)». `site/Caddyfile` — не сайт, а фрагмент для блока `koona.app`: он отвечает только на `/pin` и `/pin/*`. Без `handle_errors` и сниппетов — их имена и коды столкнулись бы с основным `Caddyfile`; 404 отвечает `file_server` со `status 404`.

1. **Сертификат сервера** (один раз, на 15 лет): Cloudflare → `koona.app` → SSL/TLS → Origin Server → Create Certificate, имена `koona.app` и `*.koona.app`. Сертификат и ключ — в `/etc/caddy/certs/koona.app.pem` и `.key`, владелец `root:caddy`, права `640`. В репозиторий они не попадают. Сертификат общий для домена: он нужен блоку `koona.app`, а не сайту Pin.
2. **Порты:** firewalld пропускает только `ssh`, `http` и `https`. SSH — только по ключу, без входа под root (`/etc/ssh/sshd_config.d/10-hardening.conf`). Обновления безопасности ставит `dnf5-automatic.timer`, без перезагрузки. SELinux включён; Caddy из пакета Fedora работает как `unconfined_service_t`, перемаркировать `/srv` не нужно.
3. **Подключение к Caddy** (один раз): в `/etc/caddy/Caddyfile` блок `koona.app` с импортом Pin и после него — корневого сайта. Корень `koona.app` (главная, `/privacy`, `robots.txt` со строкой `Sitemap: https://koona.app/pin/sitemap.xml`) — отдельный репозиторий, на сервере в `/srv/koona.app/site` (выкладка — в его README). Журнал — один на домен, без заголовков и параметров адреса, как обещает политика; за прокси в нём адрес Cloudflare, адрес посетителя — только в удаляемом заголовке `Cf-Connecting-IP`:
   ```caddyfile
   www.koona.app {
   	tls /etc/caddy/certs/koona.app.pem /etc/caddy/certs/koona.app.key
   	redir https://koona.app{uri} permanent
   }

   koona.app {
   	tls /etc/caddy/certs/koona.app.pem /etc/caddy/certs/koona.app.key
   	import /srv/koona.app/pin/Caddyfile
   	import /srv/koona.app/site/Caddyfile
   	log {
   		output file /var/log/caddy/koona.app.log {
   			roll_size 10MiB
   			roll_keep 5
   		}
   		format filter {
   			wrap console
   			fields {
   				request>headers delete
   				request>uri regexp \?.*$ ""
   			}
   		}
   	}
   }
   ```
   Скрипт ниже кладёт `site/Caddyfile` в `/srv/koona.app/pin/Caddyfile`, файлы сайта — в `/srv/koona.app/pin/site`. Стандартный блок `:80` со страницей «Caddy works!» можно удалить.
4. **Cloudflare:** SSL/TLS — «Full (strict)», «Always Use HTTPS» включён. Web Analytics (вставка скрипта, без cookies) включена, CSP её разрешает; Email Address Obfuscation и Rocket Loader выключены — они вставляют скрипты, которые CSP заблокирует; Bot Fight Mode выключен — он может ставить cookies. Кэширование — по умолчанию, без «Cache Everything» для HTML: переадресация `/pin/` на язык (`/pin/ru/`, `/pin/de/`…) зависит от языка браузера.
5. **Скриншоты** (если менялся интерфейс или выборка): закрыть свой Koona Pin, `bun run site:shots`, закоммитить `site/src/shots`.
6. **Обновления Firefox:** после `bun run extension:sign:firefox` новые XPI и `updates.json` лежат в `release/publish/firefox`; сборка сайта забирает их и сверяет хеши и адрес `https://koona.app/pin/firefox/`.
   **Обновления приложения** ([Р-60](decisions.md#р-60-обновление-приложения), дополнение 9 октября): после `bun run build:latest` сборка сайта берёт новейшую версию из `release/publish/updates`, сверяет адреса и подписи `latest.json` с файлами и кладёт пакеты в `/pin/downloads/<версия>/`, а `latest.json` — в `/pin/updates/latest.json`. Его читает каждая установленная копия обычным HTTP-запросом без браузера: проверки Cloudflare с вызовом (Under Attack, Managed Challenge, Bot Fight Mode) для `/pin/updates/` и `/pin/downloads/` не включать — updater их не пройдёт и скажет «нет связи».
7. **Выкладка** (с адресом функции отзыва в `KOONAPIN_FEEDBACK_URL` — в `.env` в корне репозитория, как в `.env.example`, или в окружении; иначе скрипт откажется — форма `/feedback` пропала бы; намеренно без неё — `-WithoutFeedback`):
   ```powershell
   pwsh scripts/deploy-site.ps1 -Server user@host
   ```
   Скрипт собирает сайт, копирует архив и `Caddyfile` по `scp`, распаковывает рядом со старой версией, проверяет конфиг (`caddy validate`; при ошибке прежний `Caddyfile` возвращается, сайт не меняется), меняет папки местами и перезагружает Caddy. Предыдущая версия остаётся в `site.old`.
8. **Проверка после выкладки:** `https://koona.app/pin` переходит на `https://koona.app/pin/`; открываются `/pin/`, `/pin/ru/`, `/pin/de/`, `/pin/sr/`, `/pin/ja/`, `/pin/zh-cn/`, `/pin/privacy`, `/pin/de/privacy`, `/pin/licenses`, `/pin/de/nowhere` отвечает немецкой 404; `https://koona.app/pin/firefox/updates.json` отдаёт JSON; `https://koona.app/pin/updates/latest.json` отдаёт JSON выложенной версии с `Cache-Control: no-cache`, а пакеты по его адресам скачиваются и совпадают с `SHA256SUMS.txt` рядом; в ответах нет `Set-Cookie`, из вставок Cloudflare в страницах только скрипт Web Analytics; с русским языком браузера `/pin/` переходит на `/pin/ru/`, с немецким — на `/pin/de/`, с китайским упрощённым — на `/pin/zh-cn/`, с китайским традиционным остаётся `/pin/`.

Проверено 5 октября 2026 года на прежнем адресе сайта (до [Р-47](decisions.md#р-47-koona-домен-koonaapp-и-приложения-путями-открытый-код)): HTTPS через Cloudflare, страницы en/ru 200, 404 на своих страницах, `/` → `/ru/` для русского браузера, `/privacy.html` → `/privacy`, `http` → `https`, без `Set-Cookie` и cookies в браузере, из сторонних хостов только `static.cloudflareinsights.com` (данные Web Analytics уходят на `/cdn-cgi/rum` того же домена), без ошибок CSP, `updates.json` и XPI 0.5.2 с совпадающим SHA-256; Lighthouse (мобильный) `/` и `/ru/` — Performance 96–97, Accessibility, Best Practices и SEO 100. На `koona.app/pin/` повторено 9 октября 2026 года на сервере Fedora 44 через Cloudflare (Full (strict)): адреса пункта 8, 404 на своих языках, переадресация языка (ru-RU, de-AT, pt-PT, sr-Latn-RS, zh-CN, ja — на свой язык; en-US, zh-TW и переход из меню остаются на `/pin/`), без `Set-Cookie`. До этого `route @welcome` стоял после `handle` (у Caddy свой порядок директив: `handle` раньше `route`) и до переадресации не доходил. `site:check` этого не ловит: `serve-site.mjs` повторяет правила сам, а не запускает Caddy.

`www.koona.app` покрывает бесплатный Universal SSL Cloudflare (`koona.app` и `*.koona.app`), Advanced Certificate Manager не нужен.

Без прокси (серое облако, `A` на сервер) из блоков `koona.app` и `www.koona.app` убираются строки `tls`: Caddy сам получит сертификат Let's Encrypt.
## Открытые вопросы

1. Ссылка «Support»: при сборке с `KOONAPIN_FEEDBACK_URL` ведёт на `/feedback` (там же ссылка на Issues), без него — на `https://github.com/andmetoo/koona-pin/issues/new/choose`. Почта на `koona.app` ([Р-9](decisions.md#р-9-распространение-windows)) — добавить, когда появится адрес.
2. Надпись Nunito ExtraBold выбрана для сайта. Перенос в `logo.sketch`, гайдлайн и боковую панель приложения — отдельной задачей, если владелец решит менять надпись везде.
