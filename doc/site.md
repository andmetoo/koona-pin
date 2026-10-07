# Сайт koona.app/pin

Макеты от 5 октября 2026 года, задача NP-079 (#82). Состояние: **макеты приняты владельцем 5 октября 2026 года; 7 октября 2026 года сайт переезжает на https://koona.app/pin/ ([Р-47](decisions.md#р-47-koona-домен-koonaapp-и-приложения-путями-открытый-код))** (`site/`, `scripts/build-site.mjs`, выкладывает владелец). Источник вида — `design/lunacy/landing.sketch`; цвета, шрифт и маскот — по [гайдлайну](guidelines.md#бренд).

## Страницы и адреса

Все адреса ниже — внутри `https://koona.app/pin` (`BASE` в `site/src/content.mjs`): `/ru/` — это `koona.app/pin/ru/`. Разделы следующих задач (например, загрузки) идут внутри языка: `/pin/downloads/`, `/pin/ru/downloads/`.

| Адрес | Что |
| --- | --- |
| `/`, `/ru/` | Лендинг на английском и русском |
| `/privacy`, `/ru/privacy` | Политика конфиденциальности, текст из `extension/store/privacy.md` |
| `/licenses`, `/ru/licenses` | Лицензии шрифтов, иконок и библиотек; вёрстка страницы privacy, отдельного кадра нет |
| `/feedback`, `/ru/feedback` и `/feedback/sent`, `/limit`, `/long`, `/origin`, `/error` | Форма отзыва и страницы, на которые её возвращает Edge Function (NP-088); вёрстка страницы privacy, отдельного кадра нет. Собираются, только если задан `KOONAPIN_FEEDBACK_URL` |
| `/firefox/updates.json`, `/firefox/koonapin-firefox-<версия>.xpi` | Обновления Firefox (NP-018). Адрес зашит в подписанный XPI: после первого выпуска не меняется |

Сайт статический, без серверной части и без скриптов на страницах. Единственная форма — отзыв (NP-088): обычный `<form>`, POST прямо в Edge Function `feedback` в Supabase, CSP разрешает `form-action` только `https://*.supabase.co`. Хостинг — сервер владельца с Caddy ([Р-37](decisions.md#р-37-сайт-koonaapppin-статика-на-сервере-владельца-надпись-nunito)), конфиг — `site/Caddyfile`, выкладка — ниже.

## Правила

- Обещания приватности — про приложение и расширение, не про сайт: сайт — страница для скачивания. Сайт без cookies и рекламных трекеров, шрифт Inter, маскот и картинки лежат на нём самом; единственный сторонний скрипт — Cloudflare Web Analytics, который вставляет Cloudflare (без cookies, [Р-37](decisions.md#р-37-сайт-koonaapppin-статика-на-сервере-владельца-надпись-nunito)), он раскрыт в политике (раздел «This website»).
- Надпись «koona pin» рядом с маскотом — Nunito ExtraBold (вариант B листа «Wordmark · options»), на сайте кривыми в SVG, без файла шрифта. Остальной текст — Inter.
- Логотип один — в шапке. Маскот крупно сидит над блоком загрузки («ждёт выпуска»), не на первом экране.
- Язык: при первом заходе на `/` по языку браузера, переключатель EN / RU в шапке ведёт на ту же страницу другого языка. Выбор не хранится в cookies.
- Тема — по системе (`prefers-color-scheme`), переключателя нет.
- Ширины: кадры 1440 и 390; без горизонтальной прокрутки от 360 до 1920. Заголовки — `text-wrap: balance`, чтобы на узком экране не оставалось одного слова в строке.
- Скриншоты приложения — настоящая сборка (WebView2, SQLite) в своей папке данных, `scripts/site-screenshots.mjs`: выборка закладок `site/shots/library.json`, превью — фото Unsplash из `site/shots/previews` (авторы — `CREDITS.md` там же и страница `/licenses`), Chrome подключён через хост. Фото отдаются с имени `previews.koona.test`, которое только WebView съёмки направляет на локальный сервер (`--host-resolver-rules`): картинки с локальных адресов приложение из копии отбрасывает (NP-019). Язык интерфейса снимка выбирается настройкой: по умолчанию приложение говорит по-английски (NP-085). Скрипт падает, если в сетке не загрузилось ни одно фото. Тёмных русских снимков нет: русские страницы в тёмной теме показывают английские. В макетах — браузерное превью с фото Icons8.
- Цвет второстепенного текста на сайте — `#6b6b61` вместо `--muted` `#74746a` приложения: на фоне `#faf9f6` прежний даёт 4,48:1, ниже порога 4,5:1 для мелкого текста.
- Превью закладок на публичных скриншотах — только картинки, которые можно показывать: свои или с лицензией без условий (например, CC0). OpenGraph-картинки чужих сайтов и фото Icons8 (бесплатная лицензия требует ссылки) на сайт не идут.
- На 390 скриншот обрезается: левая часть окна в половинном масштабе (боковая панель и первые карточки), а не всё окно в мелком виде.
- Пока установщика нет, раздел загрузки в состоянии «beta скоро» без ссылок на файлы. Ссылки на установщик и расширения добавляет NP-040, вид — лист «Download · states».

## Лендинг

Порядок блоков сверху вниз.

| # | Блок | Содержание |
| --- | --- | --- |
| 1 | Шапка | Маскот 36 px и надпись; ссылки «How it works», «Privacy», «Download»; переключатель EN / RU. На 390 ссылок нет — логотип и язык |
| 2 | Первый экран | Заголовок, подзаголовок, плашка «скоро» и кнопка «How it works», строка «Windows 11, Linux · Chrome, Edge, Firefox · Free»; скриншот сетки приложения |
| 3 | Три свойства | Карточки с иконкой: одна кнопка · на вашем компьютере · без аккаунта |
| 4 | Как это работает | Три шага с номерами |
| 5 | Что внутри | Пять возможностей с иконками; на 1440 рядом скриншот списка |
| 6 | Браузеры | Chrome 120+, Edge 120+, Firefox 140+ |
| 7 | Приватность коротко | Панель на мягком акценте: заголовок, абзац, ссылка на политику, три факта о приложении и расширении (в макете четвёртый — «сайт не ставит cookies» — убран в коде) |
| 8 | Загрузка | Маскот, «beta скоро», системные требования |
| 9 | Подвал | Privacy, Licenses, Support, © 2026 Koona |

### Тексты

| Блок | English | Русский |
| --- | --- | --- |
| Заголовок | Save a link in one click. / Find it when you need it. | Сохраняйте ссылки одной кнопкой. / Находите, когда понадобятся. |
| Подзаголовок | Koona Pin is a desktop bookmark library. Pages arrive from Chrome, Edge and Firefox with one button and stay on your computer. No account, no cloud. | Koona Pin — библиотека закладок для компьютера. Страницы попадают в неё из Chrome, Edge и Firefox одной кнопкой и остаются на вашем компьютере. Без аккаунта и облака. |
| Плашка «скоро» | Beta — coming soon | Beta — скоро |
| Строка под кнопкой | Windows 11, Linux · Chrome, Edge, Firefox · Free | Windows 11, Linux · Chrome, Edge, Firefox · Бесплатно |
| Свойство 1 | One button — Click it on any page and the link is saved — even when the app is closed. | Одна кнопка — Нажмите на любой странице — ссылка сохранится, даже если приложение закрыто. |
| Свойство 2 | On your computer — The library is a file on your disk, with automatic backups. Works offline. | На вашем компьютере — Библиотека — файл на вашем диске, с автоматическими копиями. Работает без сети. |
| Свойство 3 | No account — Nothing to sign up for. The developer never sees your links. | Без аккаунта — Регистрироваться не нужно. Разработчик не видит ваших ссылок. |
| Шаг 1 | Install the app — Koona Pin starts with the system and waits in the tray. | Установите приложение — Koona Pin запускается вместе с системой и ждёт в трее. |
| Шаг 2 | Add the extension — Chrome, Edge or Firefox. It talks only to the app on your computer. | Добавьте расширение — Chrome, Edge или Firefox. Оно общается только с приложением на вашем компьютере. |
| Шаг 3 | Click the button — The page lands in Inbox. Sort it later — it takes about a minute. | Нажмите кнопку — Страница попадёт во «Входящие». Разберите потом — это займёт около минуты. |
| Что внутри | Find it, sort it, keep it: Sort the inbox from the keyboard · Search titles, sites and tags · Collections and tags · Trash keeps links for 30 days · Import and export | Найти, разобрать, сохранить: Разбор входящих с клавиатуры · Поиск по названию, сайту и тегам · Коллекции и теги · Корзина хранит ссылки 30 дней · Импорт и экспорт |
| Браузеры | Works with your browser | Работает с вашим браузером |
| Приватность | Your links stay with you. Koona Pin keeps your library on your computer: no server ever sees your links. Only feedback you choose to send reaches the developer. Facts: the extension reads only the address and title of the tab you save · the app sends no analytics, telemetry or crash reports · no account and no cloud | Ваши ссылки остаются у вас. Koona Pin хранит библиотеку на вашем компьютере: ваши ссылки не видит ни один сервер. Разработчику уходит только отзыв, который вы отправите сами. Факты: расширение читает только адрес и заголовок сохраняемой вкладки · приложение не отправляет аналитику, телеметрию и отчёты о сбоях · ни аккаунта, ни облака |
| Загрузка, «скоро» | The beta is on its way. Packages for Windows and Linux and the browser extensions will be published here. | Beta уже в пути. Пакеты для Windows и Linux и расширения для браузеров появятся здесь. |
| Требования | Windows 11, 64-bit (no administrator rights needed) · Linux, 64-bit (Ubuntu 24.04 and 26.04, Fedora 44 and 45, Arch Linux) · Chrome or Edge 120+, Firefox 140+ (current release or ESR 140) | Windows 11, 64 бит (права администратора не нужны) · Linux, 64 бит (Ubuntu 24.04 и 26.04, Fedora 44 и 45, Arch Linux) · Chrome или Edge 120+, Firefox 140+ (текущий релиз или ESR 140) |

Тексты подробных пунктов «Что внутри» — в кадрах. Русские строки длиннее английских на 15–25 %: плашка «скоро», ссылки подвала и заголовок «Что внутри» на 390 подобраны по русскому тексту в кадрах RU.

7 октября 2026 года тексты сайта стали без привязки к одной системе: «desktop», «для компьютера» вместо «for Windows»; системы перечисляют только строка под кнопкой и требования, Linux — по контракту Linux-beta (Р-45). В landing.sketch остались прежние тексты.

## Privacy

Колонка текста 680 px на 1440, поля 16 px на 390: «← Koona Pin», заголовок, дата обновления, вводный абзац, разделы политики с подзаголовками, тот же подвал; в шапке активна ссылка «Privacy». Текст — `extension/store/privacy.md`. Перед публикацией его нужно сверить с поведением приложения и дополнить: проверку обновлений (NP-038, `latest.json` с GitHub) текущая политика не упоминает.

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
| `npm run site:build` | Собирает `release/publish/site/`: страницы en/ru, `site.css`, шрифт Inter (латиница, расширенная латиница, кириллица), маскот, favicon, скриншоты, `sitemap.xml` (`robots.txt` — у корня `koona.app`); `release/publish/firefox` целиком, если он есть, со сверкой хешей XPI с `updates.json` |
| `npm run site:check` | Сборка и проверка: каждая страница на 360, 390, 1440, 1920 в обеих темах — без горизонтальной прокрутки, без запросов к другим доменам, без cookies, ссылки внутри сайта открываются, `/pin/` для русского браузера ведёт на `/pin/ru/`, а EN с `/pin/ru/` — на `/pin/`; снимки в `test-results/site` |
| `npm run site:serve` | Локальный сервер `release/publish/site/` с правилами `site/Caddyfile` (`/pin` → `/pin/`, try_files, 404, переадресация языка, заголовки) на `http://127.0.0.1:4173/pin/`; `/` стоит за корневой сайт и ведёт на `/pin/` |
| `npm run site:shots` | Скриншоты настоящего приложения в `site/src/shots` (1920 и 1280 px WebP, `og-<lang>.jpg` 1200×630). Нужна отладочная сборка (`cargo build --manifest-path src-tauri/Cargo.toml`), собственный Koona Pin закрыт (один экземпляр на пользователя) |
| `node scripts/site-wordmark.mjs` | Надпись кривыми из Nunito ExtraBold в `site/src/brand/wordmark.svg`; только если надпись меняется |

Lighthouse (мобильный, 5 октября 2026 года, `npx lighthouse@12` с Chromium Playwright через `CHROME_PATH`, на `npm run site:serve`, настоящие скриншоты): `/`, `/ru/`, `/privacy`, `/ru/licenses` — Performance 99–100, Accessibility 100, Best Practices 100, SEO 100. `connect-src 'self'` в CSP нужен только для этой проверки: Lighthouse читает `robots.txt` запросом из страницы.

## Выкладка

Выкладывает владелец ([Р-37](decisions.md#р-37-сайт-koonaapppin-статика-на-сервере-владельца-надпись-nunito), [Р-47](decisions.md#р-47-koona-домен-koonaapp-и-приложения-путями-открытый-код)). Сервер — Ubuntu в Oracle Cloud с Caddy 2, домен за прокси Cloudflare (оранжевое облако), между Cloudflare и сервером — Cloudflare Origin Certificate в режиме «Full (strict)». `site/Caddyfile` — не сайт, а фрагмент для блока `koona.app`: он отвечает только на `/pin` и `/pin/*`. Без `handle_errors` и сниппетов — их имена и коды столкнулись бы с основным `Caddyfile`; 404 отвечает `file_server` со `status 404`.

1. **Сертификат сервера** (один раз, на 15 лет): Cloudflare → `koona.app` → SSL/TLS → Origin Server → Create Certificate, имена `koona.app` и `*.koona.app`. Сертификат и ключ — в `/etc/caddy/certs/koona.app.pem` и `.key`, владелец `root:caddy`, права `640`. В репозиторий они не попадают. Сертификат общий для домена: он нужен блоку `koona.app`, а не сайту Pin.
2. **Порт 443** открыт в Security List сети Oracle (VCN) и в `iptables` сервера (`netfilter-persistent save`). Можно открыть только для [адресов Cloudflare](https://www.cloudflare.com/ips/).
3. **Подключение к Caddy** (один раз): в `/etc/caddy/Caddyfile` блок корневого сайта, внутри — строка импорта Pin. Корень `koona.app` (главная, `robots.txt` со строкой `Sitemap: https://koona.app/pin/sitemap.xml`) — вне этого репозитория. Журнал — один на домен, без заголовков и параметров адреса, как обещает политика; за прокси в нём адрес Cloudflare, адрес посетителя — только в удаляемом заголовке `Cf-Connecting-IP`:
   ```caddyfile
   www.koona.app {
   	tls /etc/caddy/certs/koona.app.pem /etc/caddy/certs/koona.app.key
   	redir https://koona.app{uri} permanent
   }

   koona.app {
   	tls /etc/caddy/certs/koona.app.pem /etc/caddy/certs/koona.app.key
   	import /srv/koona.app/pin/Caddyfile
   	# …правила корневого сайта koona.app…
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
4. **Cloudflare:** SSL/TLS — «Full (strict)», «Always Use HTTPS» включён. Web Analytics (вставка скрипта, без cookies) включена, CSP её разрешает; Email Address Obfuscation и Rocket Loader выключены — они вставляют скрипты, которые CSP заблокирует; Bot Fight Mode выключен — он может ставить cookies. Кэширование — по умолчанию, без «Cache Everything» для HTML: переадресация `/pin/` → `/pin/ru/` зависит от языка браузера.
5. **Скриншоты** (если менялся интерфейс или выборка): закрыть свой Koona Pin, `npm run site:shots`, закоммитить `site/src/shots`.
6. **Обновления Firefox:** после `npm run extension:sign:firefox` новые XPI и `updates.json` лежат в `release/publish/firefox`; сборка сайта забирает их и сверяет хеши и адрес `https://koona.app/pin/firefox/`.
7. **Выкладка** (с адресом функции отзыва в `KOONAPIN_FEEDBACK_URL` — в `.env` в корне репозитория, как в `.env.example`, или в окружении; иначе скрипт откажется — форма `/feedback` пропала бы; намеренно без неё — `-WithoutFeedback`):
   ```powershell
   pwsh scripts/deploy-site.ps1 -Server user@host
   ```
   Скрипт собирает сайт, копирует архив и `Caddyfile` по `scp`, распаковывает рядом со старой версией, проверяет конфиг (`caddy validate`; при ошибке прежний `Caddyfile` возвращается, сайт не меняется), меняет папки местами и перезагружает Caddy. Предыдущая версия остаётся в `site.old`.
8. **Проверка после выкладки:** `https://koona.app/pin` переходит на `https://koona.app/pin/`; открываются `/pin/`, `/pin/ru/`, `/pin/privacy`, `/pin/ru/privacy`, `/pin/licenses`; `https://koona.app/pin/firefox/updates.json` отдаёт JSON; в ответах нет `Set-Cookie`, из вставок Cloudflare в страницах только скрипт Web Analytics; с русским языком браузера `/pin/` переходит на `/pin/ru/`.

Проверено 5 октября 2026 года на прежнем адресе сайта (до [Р-47](decisions.md#р-47-koona-домен-koonaapp-и-приложения-путями-открытый-код)): HTTPS через Cloudflare, страницы en/ru 200, 404 на своих страницах, `/` → `/ru/` для русского браузера, `/privacy.html` → `/privacy`, `http` → `https`, без `Set-Cookie` и cookies в браузере, из сторонних хостов только `static.cloudflareinsights.com` (данные Web Analytics уходят на `/cdn-cgi/rum` того же домена), без ошибок CSP, `updates.json` и XPI 0.5.2 с совпадающим SHA-256; Lighthouse (мобильный) `/` и `/ru/` — Performance 96–97, Accessibility, Best Practices и SEO 100. На `koona.app/pin/` проверку повторить после первой выкладки.

`www.koona.app` покрывает бесплатный Universal SSL Cloudflare (`koona.app` и `*.koona.app`), Advanced Certificate Manager не нужен.

Без прокси (серое облако, `A` на сервер) из блоков `koona.app` и `www.koona.app` убираются строки `tls`: Caddy сам получит сертификат Let's Encrypt.
## Открытые вопросы

1. Ссылка «Support»: при сборке с `KOONAPIN_FEEDBACK_URL` ведёт на `/feedback` (там же ссылка на Issues), без него — на `https://github.com/andmetoo/koona-pin/issues/new/choose`. Почта на `koona.app` ([Р-9](decisions.md#р-9-распространение-windows)) — добавить, когда появится адрес.
2. Надпись Nunito ExtraBold выбрана для сайта. Перенос в `logo.sketch`, гайдлайн и боковую панель приложения — отдельной задачей, если владелец решит менять надпись везде.
