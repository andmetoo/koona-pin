# Netami Pin

Локальная библиотека ссылок для Windows: светлая и тёмная темы, коллекции, теги, избранное и захват страниц из Chrome, Edge и Firefox с устойчивой очередью.

**Дизайн.** Актуальный дизайн — редизайн, итерация 1 (envy green, Inter, разбор входящих, массовые действия). В коде — его основа (NP-010): оболочка, компоненты, настройки, английский и русский; остальные экраны доводятся задачами дорожной карты. Что главнее и где что лежит — в [гайдлайне](doc/guidelines.md).

Сайт приложения: [pin.netami.app](https://pin.netami.app). Исходники — `site/`, сборка `npm run site:build`, проверка `npm run site:check`, выкладка на сервер владельца с Caddy — `pwsh scripts/deploy-site.ps1 -Server user@host`; подробно — [doc/site.md](doc/site.md#выкладка).

React 19 · TypeScript · Tauri 2 · Rust · SQLite. Данные хранятся в `%APPDATA%\Netami Pin\netamipin.db`.

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
- Выпуски и обратная связь — публичный репозиторий [andmetoo/netami-pin-releases](https://github.com/andmetoo/netami-pin-releases) ([Р-9](doc/decisions.md#р-9-распространение-windows)): README, формы issues и SECURITY.md лежат в нём, метки и настройки — `scripts/setup-releases-repo.ps1`
- Слайды процесса: `design/lunacy/development_process.sketch` (20 редактируемых кадров в Lunacy)

## Разработка

Нужны Node.js (версия в `.nvmrc`), Rust (версия в `rust-toolchain.toml`, rustup установит её сам), Microsoft C++ Build Tools и WebView2. Все проверки и CI описаны в [doc/testing.md](doc/testing.md).

```powershell
npm ci
npm run tauri dev
```

`npm run dev` открывает браузерное превью с отдельными демонстрационными данными на языке интерфейса. Оно не обращается к пользовательской SQLite.

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
| Сайт pin.netami.app | `npm run site:build` (`site:check` — с проверкой) | `release/publish/site/` (выкладывает `scripts/deploy-site.ps1`) |
| Приложение для разработки | `npm run tauri dev` | окно приложения, файл не нужен |

`publish/` — людям и в каталоги, `test/` — только на тестовую машину, `dev/` — только на этот компьютер. Рабочие папки инструментов из рук не берутся: `src-tauri/target` (Cargo и Tauri: EXE, промежуточные файлы установщика) и `dist/` (интерфейс приложения для Tauri). `npm run tauri build` собирает только EXE в `src-tauri/target/release`, установщик — только `build:installer`.
