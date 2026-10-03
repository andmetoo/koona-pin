# Netami Pin

Локальная библиотека ссылок для Windows: светлая и тёмная темы, коллекции, теги, избранное и захват страниц из Chrome с устойчивой очередью.

**Дизайн.** Актуальный дизайн — редизайн, итерация 1 (envy green, Inter, разбор входящих, массовые действия). Пока он есть только в макетах Lunacy; в коде — прежний интерфейс «Редакция». Что главнее и где что лежит — в [гайдлайне](doc/guidelines.md).

Сайт приложения: [pin.netami.app](https://pin.netami.app).

React 19 · TypeScript · Tauri 2 · Rust · SQLite. Данные остаются в `%APPDATA%\OddClicks\oddclicks.db`.

Прежнее название — OddClicks. Интерфейс, расширение и технические идентификаторы (папка данных, имя EXE, переменные окружения, ответ `/api/health`) пока используют его; переименование в коде ещё не сделано.

Дизайн, по приоритету:

1. [Гайдлайн и приоритеты](doc/guidelines.md) — начинать отсюда
2. [Редизайн: итерация 1](doc/redesign.md) — актуальные макеты, в коде не реализовано
3. [Дизайн «Редакция»](doc/design.md) — то, что сейчас в коде; устаревает

Остальное:

- [Возможности, установка и Chrome](doc/features.md)
- [Согласованный план](doc/plan.md)
- [Протокол и архитектура](doc/architecture.md)
- [Результаты проверок](doc/testing.md)
- [Процесс разработки с ИИ-агентами](doc/development-process.md)
- [Дорожная карта](doc/roadmap.md), [сценарии](doc/scenarios.md), [решения](doc/decisions.md) и [индекс задач GitHub](doc/issues/README.md)
- [Шаблон задачи](doc/task-template.md) и [чеклист выпуска](doc/release-checklist.md)
- Слайды процесса: `design/lunacy/development_process.sketch` (20 редактируемых кадров в Lunacy)

## Разработка

Нужны Node.js, Rust, Microsoft C++ Build Tools и WebView2.

```powershell
npm ci
npm run tauri dev
```

`npm run dev` открывает браузерное превью с отдельными демонстрационными данными. Оно не обращается к пользовательской SQLite. Сравнение концептов доступно на `/concept.html`.

```powershell
npm run build
npm run tauri build
npm run extension:zip
```

Расширение: папка `extension/chrome`, архив `release/oddclicks-chrome.zip`. Архив хранится отдельно от очищаемой при сборке папки `dist`. Установка через режим разработчика описана в [инструкции](doc/features.md#chrome).
