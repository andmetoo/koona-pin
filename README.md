# Koona Pin

Локальная библиотека ссылок для компьютера — Windows, следом Linux: светлая и тёмная темы, коллекции, теги, избранное и захват страниц из Chrome, Edge и Firefox с устойчивой очередью. Интерфейс на английском, русском, сербском и восьми европейских языках ([Языки](doc/features.md#языки)).

**Дизайн.** Актуальный дизайн — редизайн, итерация 1 (envy green, Inter, разбор входящих, массовые действия). В коде — его основа (NP-010): оболочка, компоненты, настройки; остальные экраны доводятся задачами дорожной карты. Что главнее и где что лежит — в [гайдлайне](doc/guidelines.md).

Сайт приложения: [koona.app/pin](https://koona.app/pin/). Исходники — `site/`, сборка `npm run site:build`, проверка `npm run site:check`, выкладка на сервер владельца с Caddy — `pwsh scripts/deploy-site.ps1 -Server user@host`; подробно — [doc/site.md](doc/site.md#выкладка).

React 19 · TypeScript · Tauri 2 · Rust · SQLite. Данные хранятся в `%APPDATA%\Koona Pin\koonapin.db`.

Прежнее название — OddClicks. Данные OddClicks и тестовых сборок до схемы 1 не переносятся ([Р-11](doc/decisions.md#р-11-чистая-схема-1-вместо-переноса-данных)). С уходом HTTP-сервера (NP-016) старого имени в коде не осталось.

Дизайн, по приоритету:

1. [Гайдлайн и приоритеты](doc/guidelines.md) — начинать отсюда
2. [Редизайн: итерация 1](doc/redesign.md) — актуальные макеты, в коде основа
3. [Дизайн «Редакция»](doc/design.md) — прежний интерфейс, архив

Остальное:

- [Возможности, установка и расширение](doc/features.md)
- [Согласованный план](doc/plan.md)
- [Протокол и архитектура](doc/architecture.md)
- [Проверки и CI](doc/testing.md)
- [Процесс разработки с ИИ-агентами](doc/development-process.md)
- [Дорожная карта](doc/roadmap.md), [сценарии](doc/scenarios.md), [решения](doc/decisions.md) и [индекс задач GitHub](doc/issues/README.md)
- [Шаблон задачи](doc/task-template.md) и [чеклист выпуска](doc/release-checklist.md)
- Выпуски и обратная связь — в этом же репозитории [andmetoo/koona-pin](https://github.com/andmetoo/koona-pin) ([Р-9](doc/decisions.md#р-9-распространение-windows), [Р-47](doc/decisions.md#р-47-koona-домен-koonaapp-и-приложения-путями-открытый-код)): формы issues — `.github/ISSUE_TEMPLATE`, сообщения об уязвимостях — [SECURITY.md](SECURITY.md), метки и настройки — `scripts/setup-repo.ps1`
- Слайды процесса: `design/lunacy/development_process.sketch` (20 редактируемых кадров в Lunacy)

## Разработка

Нужны Node.js (версия в `.nvmrc`), Rust (версия в `rust-toolchain.toml`, rustup установит её сам), Microsoft C++ Build Tools и WebView2. Все проверки и CI описаны в [doc/testing.md](doc/testing.md).

```powershell
npm ci
npm run tauri dev
```

На Linux — пакеты из `bash scripts/linux/deps.sh`, затем то же; проверка Linux — матрица `.github/workflows/linux.yml` через `act` ([Linux](doc/testing.md#linux)).

`npm run dev` открывает браузерное превью с отдельными демонстрационными данными на языке интерфейса. Оно не обращается к пользовательской SQLite.

Строки интерфейса — `src/locales/<код>.json`, источник — `en.json`; как добавить строку или язык — в [гайдлайне](doc/guidelines.md#языки-интерфейса), термины — в [глоссарии](doc/glossary.md). После правки `sr.json` — `npm run locales:sr-latn`.

Расширение для Chrome, Edge и Firefox собирается из одного исходника `extension/src`; установка — в [инструкции](doc/features.md#браузеры).

## Сборки: что где

Всё, что уносится из репозитория — людям, в каталоги, на тестовую машину, в свой браузер, — лежит в `release/` (в Git не попадает): сначала зачем, потом платформа, потом версия. Пути задаёт один файл, [`scripts/lib/paths.mjs`](scripts/lib/paths.mjs). Настройки сборок (адрес отзыва, ключ каталога Chrome, секреты подписи) — в `.env`, шаблон [`.env.example`](.env.example).

| Что | Команда | Результат |
| --- | --- | --- |
| Установщик Windows для проверки, без подписи | `npm run build:installer` | `release/test/windows/<версия>/` — установщик и `SHA256SUMS.txt` |
| Установщик Windows для выпуска, подписанный | `npm run build:installer -- --sign` | `release/publish/windows/<версия>/` |
| Расширение для каталогов Chrome и Edge | `npm run extension:build` | `release/publish/chrome/<версия>/`, `release/publish/edge/<версия>/` |
| Расширение с ID каталога Chrome для тестовой машины | `npm run extension:build` с `CHROME_STORE_PUBLIC_KEY` | `release/test/chrome-edge/<версия>/` |
| Расширение для своего браузера («Загрузить распакованное», тесты) | `npm run extension:build` | `release/dev/chrome`, `edge`, `firefox` |
| Подписанное расширение Firefox и `updates.json` | `npm run extension:sign:firefox` | `release/publish/firefox/` (выкладывается с сайтом) |
| Сайт koona.app/pin | `npm run site:build` (`site:check` — с проверкой) | `release/publish/site/` (выкладывает `scripts/deploy-site.ps1`) |
| Приложение для разработки | `npm run tauri dev` | окно приложения, файл не нужен |

`publish/` — людям и в каталоги, `test/` — только на тестовую машину, `dev/` — только на этот компьютер. Рабочие папки инструментов из рук не берутся: `src-tauri/target` (Cargo и Tauri: EXE, промежуточные файлы установщика) и `dist/` (интерфейс приложения для Tauri). `npm run tauri build` собирает только EXE в `src-tauri/target/release`, установщик — только `build:installer`.

**Мусор тестов.** Каждый прогон теста и скрипта оставляет свою папку в `.test-data`, а Rust-тесты — папки `koonapin-*` во временной папке системы. `npm run clean` убирает их вместе с `test-results` и `playwright-report`; `libraries` (тестовые библиотеки) и всё, что менялось за последние 30 минут, остаются, `release/` не трогается. Сам он запускается перед `check`, `test:native`, `test:host`, `test:extension`, `test:extension:firefox` и `build:installer`. `npm run clean -- --list` показывает, сколько занимают папки сборок, `npm run clean -- --cargo` ещё и очищает папки Cargo — следующая сборка пойдёт с нуля.

## Лицензия

Open core ([Р-48](doc/decisions.md#р-48-лицензия-open-core-agpl-30-cla-и-товарный-знак)): код — [GNU AGPL 3.0](LICENSE) (`AGPL-3.0-only`), платные возможности — под коммерческой лицензией, название, маскот и логотип — товарные знаки ([TRADEMARKS.md](TRADEMARKS.md)). Что под какой лицензией — [LICENSING.md](LICENSING.md); участие — по [CLA](CLA.md), правила — [CONTRIBUTING.md](CONTRIBUTING.md).
