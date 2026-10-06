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

```powershell
npm run build
npm run tauri build
npm run extension:build
```

Установщик Windows для выпуска — `npm run build:installer` ([установка и удаление](doc/features.md#установка-и-удаление)).

Расширение для Chrome, Edge и Firefox собирается из одного исходника `extension/src`: распакованные папки `extension/build/chrome`, `edge`, `firefox` и пакеты `release/netamipin-chrome.zip`, `netamipin-edge.zip`, `netamipin-firefox.xpi`. Пакеты хранятся отдельно от очищаемой при сборке папки `dist`. Установка — в [инструкции](doc/features.md#браузеры).
