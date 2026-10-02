# Архитектура и локальный протокол

## Frontend

`App.tsx` собирает оболочку и сценарии. `components/ui` содержит окно, карточку, редактор и диалог. `useLibrary` отделяет результаты, справочники, счётчики и события. `services/library.ts` содержит чистые правила фильтрации и объединения по `id`.

`services/api.ts` — типизированная граница IPC. В Tauri она вызывает Rust-команды, в браузере — независимый `demo.ts` с ключом localStorage `oddclicks.demo.v1`. Превью не обращается к основной базе.

Поиск задерживается на 150 мс. Номер запроса и версия событий не дают старому ответу заменить новые результаты. Повторные события отбрасываются по ревизии; удаление содержит следующую ревизию без записи. Общие счётчики не зависят от поиска.

## Rust и SQLite

`capture.rs` обслуживает IPC-добавление, HTTP и HTML-импорт. Допускаются HTTP/HTTPS с хостом. Дубликаты сравниваются по полному сохранённому URL; существующая запись не меняется. Вставка, теги и квитанция выполняются в одной транзакции; успех возвращается после commit.

`db.rs` содержит запросы и миграцию `user_version=1`: ревизии, квитанции, настройки. `capture_receipts` намеренно не имеет внешнего ключа на закладку: квитанция переживает удаление. Backup API создаёт согласованную копию до миграции, включая WAL.

Метаданные запрашиваются отдельно через Tauri async runtime. UPDATE по исходному `id` не создаёт удалённую запись. Заголовок применяется только при совпадении исходной ревизии: правка после запуска задачи сохраняет пользовательский заголовок.

Событие `bookmark-changed`: `{ kind: "created" | "updated" | "deleted", id, revision, bookmark }`. Массовая операция выдаёт `library-invalidated`. Patch коллекции: `{ action: "keep" }`, `{ action: "clear" }`, `{ action: "set", id: 1 }`.

У строки окна есть разрешения для сворачивания, разворачивания, закрытия и перетаскивания; последнее нужно отдельно для `data-tauri-drag-region` согласно [документации Tauri](https://v2.tauri.app/learn/window-customization/).

## HTTP v1

Адрес: `http://127.0.0.1:28765`. Токен из двух случайных UUID хранится в локальных настройках и переносится пользователем в Chrome. Захват требует `Authorization: Bearer <token>`.

```http
POST /api/v1/capture
Content-Type: application/json
Authorization: Bearer <локальный токен>

{"request_id":"постоянный UUID захвата","url":"https://example.com/article","title":"Название страницы"}
```

```json
{ "bookmark_id": 42, "outcome": "created" }
```

Повтор URL с новым request_id возвращает `existing`. Повтор исходного request_id возвращает квитанцию, даже если закладка удалена; он не вставляет запись снова. Один request_id с другим URL возвращает конфликт. Максимум URL — 8192 символа, request_id — 128 символов, тело HTTP — 64 KiB.

| Статус | Код                   | Причина                                             |
| ------ | --------------------- | --------------------------------------------------- |
| 200    | —                     | Подтверждённая транзакция, `created` или `existing` |
| 400    | `invalid_request`     | Неверные данные                                     |
| 401    | `unauthorized`        | Нет токена или токен не подходит                    |
| 404    | `not_found`           | Неизвестный endpoint                                |
| 405    | `method_not_allowed`  | Неверный метод                                      |
| 409    | `request_id_conflict` | Идентификатор относится к другому URL               |
| 500    | `database_error`      | Запись не подтверждена                              |

Ошибка имеет `code` и `message`. `GET /api/health` возвращает `{ "status":"ok", "app":"OddClicks", "protocol":1 }`. Без токена health доступен для диагностики; переданный Authorization проверяется. IPC `get_server_status` сообщает фактический результат привязки порта.

Совместимый `/api/add` принимает GET/POST с query-параметрами либо POST с JSON, без токена. Это ограничение совместимости: токен защищает новый v1 API, старый канал допускает локальное добавление ссылок.

## Расширение

MV3 worker выполняет запросы. `queue.js` последовательно обрабатывает добавление, отправку, повтор и удаление через одну цепочку операций. `chrome.storage.local` хранит URL, название, request_id, время и ошибку. Подтверждение требует целый `bookmark_id` и известный `outcome`.

`activeTab` даёт доступ к выбранной странице после нажатия; `storage` хранит очередь; `alarms` возобновляет доставку. Host permission относится к `127.0.0.1` (Chrome match patterns не ограничивают порт), CSP и код ограничивают сервер портом 28765. Content scripts и удалённый код отсутствуют.

Основания: [сетевые запросы](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests), [жизненный цикл worker](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle), [chrome.alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms).

Для тестов `ODDCLICKS_DATA_DIR` меняет каталог SQLite, `WEBVIEW2_USER_DATA_FOLDER` — профиль WebView2. Обычный запуск сохраняет существующий путь.
