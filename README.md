# Netami Pin

Локальная библиотека ссылок для Windows: интерфейс «Редакция», светлая и тёмная темы, коллекции, теги, избранное и захват страниц из Chrome с устойчивой очередью.

Сайт приложения: [pin.netami.app](https://pin.netami.app).

React 19 · TypeScript · Tauri 2 · Rust · SQLite. Данные остаются в `%APPDATA%\OddClicks\oddclicks.db`.

Прежнее название — OddClicks. Интерфейс, расширение и технические идентификаторы (папка данных, имя EXE, переменные окружения, ответ `/api/health`) пока используют его; переименование в коде ещё не сделано.

- [Возможности, установка и Chrome](doc/features.md)
- [Дизайн, концепты и движение](doc/design.md)
- [Редизайн: итерация 1 (макеты, не реализовано)](doc/redesign.md)
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

Расширение: папка `extension/chrome`, архив `release/oddclicks-chrome.zip`. Архив хранится отдельно от очищаемой при сборке папки `dist`. Установка через режим разработчика описана в [инструкции](doc/features.md#chrome).
