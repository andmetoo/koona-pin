# OddClicks

Локальная библиотека ссылок для Windows: интерфейс «Редакция», светлая и тёмная темы, коллекции, теги, избранное и захват страниц из Chrome с устойчивой очередью.

React 19 · TypeScript · Tauri 2 · Rust · SQLite. Данные остаются в `%APPDATA%\OddClicks\oddclicks.db`.

- [Возможности, установка и Chrome](doc/features.md)
- [Дизайн, концепты и движение](doc/design.md)
- [Согласованный план](doc/plan.md)
- [Протокол и архитектура](doc/architecture.md)
- [Результаты проверок](doc/testing.md)

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

Расширение: папка `extension/chrome`, архив `dist/oddclicks-chrome.zip`. Установка через режим разработчика описана в [инструкции](doc/features.md#chrome).
