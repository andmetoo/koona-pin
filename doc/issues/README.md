# Индекс задач GitHub

Соответствие ключей и номеров [GitHub Issues](https://github.com/andmetoo/netami-pin/issues). Создано 2026-10-03. После публикации источник истины — GitHub: тексты, критерии и обсуждения меняются там, а не здесь ([Р-7](../decisions.md#р-7-ведение-backlog)). Порядок и зависимости — в [roadmap.md](../roadmap.md).

## Сценарии и выпуски

| Ключ | Issue | Название | Milestone | Родитель |
| --- | --- | --- | --- | --- |
| W0 | [#44](https://github.com/andmetoo/netami-pin/issues/44) | W0 · Основа: решения, сборка, надёжное хранилище | Windows beta | — |
| W1 | [#45](https://github.com/andmetoo/netami-pin/issues/45) | W1 · Пользователь работает с библиотекой в новом интерфейсе | Windows beta | — |
| W2 | [#46](https://github.com/andmetoo/netami-pin/issues/46) | W2 · Пользователь сохраняет ссылки из трёх браузеров | Windows beta | — |
| W3 | [#47](https://github.com/andmetoo/netami-pin/issues/47) | W3 · Пользователь разбирает входящие и безопасно удаляет лишнее | Windows beta | — |
| W4 | [#48](https://github.com/andmetoo/netami-pin/issues/48) | W4 · Пользователь организует несколько закладок за одно действие | Windows beta | — |
| W5 | [#49](https://github.com/andmetoo/netami-pin/issues/49) | W5 · Пользователь переносит и восстанавливает библиотеку | Windows beta | — |
| W6 | [#50](https://github.com/andmetoo/netami-pin/issues/50) | W6 · Пользователь очищает накопленную библиотеку | Windows beta | — |
| W7 | [#51](https://github.com/andmetoo/netami-pin/issues/51) | W7 · Пользователь устанавливает и обновляет Windows-beta | Windows beta | — |
| R-ANDROID | [#52](https://github.com/andmetoo/netami-pin/issues/52) | Android · Сохранять и разбирать ссылки на телефоне | Android | — |
| R-EXT | [#53](https://github.com/andmetoo/netami-pin/issues/53) | Расширения в каталогах · Обычная установка и обновление расширений | Расширения в каталогах | — |
| R-IOS | [#54](https://github.com/andmetoo/netami-pin/issues/54) | iOS · Сохранять и разбирать ссылки на iPhone | iOS | — |
| R-LINUX | [#55](https://github.com/andmetoo/netami-pin/issues/55) | Linux · Выпустить Netami Pin для выбранных дистрибутивов | Linux | — |
| R-MAC | [#56](https://github.com/andmetoo/netami-pin/issues/56) | macOS · Выпустить Netami Pin для macOS | macOS | — |
| R-PAID | [#57](https://github.com/andmetoo/netami-pin/issues/57) | Платные сервисы · Оплата синхронизации без риска для локальной библиотеки | Платные сервисы | — |
| R-SYNC-D | [#58](https://github.com/andmetoo/netami-pin/issues/58) | Синхронизация: проектирование · Сценарии, архитектура и модель конфликтов | Синхронизация | — |
| R-SYNC-I | [#59](https://github.com/andmetoo/netami-pin/issues/59) | Синхронизация: реализация · Библиотека на нескольких устройствах | Синхронизация | — |
| R-WIN1 | [#60](https://github.com/andmetoo/netami-pin/issues/60) | Windows 1.0 · Стабильный выпуск по итогам beta | Windows 1.0 | — |

## Задачи Windows-beta

| Ключ | Issue | Название | Milestone | Родитель |
| --- | --- | --- | --- | --- |
| NP-001 | [#3](https://github.com/andmetoo/netami-pin/issues/3) | Зафиксировать контракт Windows-beta | Windows beta | W0 |
| NP-002 | [#4](https://github.com/andmetoo/netami-pin/issues/4) | Воспроизвести проверки и настроить CI | Windows beta | W0 |
| NP-003 | [#5](https://github.com/andmetoo/netami-pin/issues/5) | Принять решения о распространении Windows | Windows beta | W0 |
| NP-004 | [#6](https://github.com/andmetoo/netami-pin/issues/6) | Завершить основу дизайна и общие состояния | Windows beta | W0 |
| NP-005 | [#7](https://github.com/andmetoo/netami-pin/issues/7) | Определить политику данных и миграций | Windows beta | W0 |
| NP-006 | [#8](https://github.com/andmetoo/netami-pin/issues/8) | Укрепить хранилище до новых миграций | Windows beta | W0 |
| NP-007 | [#9](https://github.com/andmetoo/netami-pin/issues/9) | Типизировать контракт IPC и ошибки | Windows beta | W0 |
| NP-008 | [#10](https://github.com/andmetoo/netami-pin/issues/10) | Проверить риски будущих платформ | Windows beta | W0 |
| NP-009 | [#11](https://github.com/andmetoo/netami-pin/issues/11) | Перенести бренд и технические идентификаторы Netami Pin | Windows beta | W1 |
| NP-010 | [#12](https://github.com/andmetoo/netami-pin/issues/12) | Внедрить основу интерфейса на Tailwind 4 | Windows beta | W1 |
| NP-011 | [#13](https://github.com/andmetoo/netami-pin/issues/13) | Перевести выборку и поиск на FTS5 и страницы | Windows beta | W1 |
| NP-012 | [#14](https://github.com/andmetoo/netami-pin/issues/14) | Показывать большую библиотеку сеткой и списком | Windows beta | W1 |
| NP-013 | [#15](https://github.com/andmetoo/netami-pin/issues/15) | Находить и редактировать сохранённое в новом интерфейсе | Windows beta | W1 |
| NP-014 | [#16](https://github.com/andmetoo/netami-pin/issues/16) | Исследовать Native Messaging как канал захвата | Windows beta | W2 |
| NP-015 | [#17](https://github.com/andmetoo/netami-pin/issues/17) | Собирать расширение для Chrome, Edge и Firefox из одного исходника | Windows beta | W2 |
| NP-016 | [#18](https://github.com/andmetoo/netami-pin/issues/18) | Подключать браузер и видеть состояние захвата | Windows beta | W2 |
| NP-017 | [#19](https://github.com/andmetoo/netami-pin/issues/19) | Довести захват в Chrome и Edge | Windows beta | W2 |
| NP-018 | [#20](https://github.com/andmetoo/netami-pin/issues/20) | Добавить захват в Firefox | Windows beta | W2 |
| NP-019 | [#21](https://github.com/andmetoo/netami-pin/issues/21) | Укрепить границы локального захвата | Windows beta | W2 |
| NP-020 | [#22](https://github.com/andmetoo/netami-pin/issues/22) | Принять дизайн разбора входящих | Windows beta | W3 |
| NP-021 | [#23](https://github.com/andmetoo/netami-pin/issues/23) | Ввести состояние входящих | Windows beta | W3 |
| NP-022 | [#24](https://github.com/andmetoo/netami-pin/issues/24) | Отправлять закладки в корзину и восстанавливать | Windows beta | W3 |
| NP-023 | [#25](https://github.com/andmetoo/netami-pin/issues/25) | Очищать корзину по сроку хранения | Windows beta | W3 |
| NP-024 | [#26](https://github.com/andmetoo/netami-pin/issues/26) | Вести журнал команд и отменять действия | Windows beta | W3 |
| NP-025 | [#27](https://github.com/andmetoo/netami-pin/issues/27) | Разбирать входящие с клавиатуры | Windows beta | W3 |
| NP-026 | [#28](https://github.com/andmetoo/netami-pin/issues/28) | Предлагать коллекцию по домену | Windows beta | W3 |
| NP-027 | [#29](https://github.com/andmetoo/netami-pin/issues/29) | Принять дизайн выделения и перетаскивания | Windows beta | W4 |
| NP-028 | [#30](https://github.com/andmetoo/netami-pin/issues/30) | Выделять несколько закладок | Windows beta | W4 |
| NP-029 | [#31](https://github.com/andmetoo/netami-pin/issues/31) | Выполнять массовые действия с отменой | Windows beta | W4 |
| NP-030 | [#32](https://github.com/andmetoo/netami-pin/issues/32) | Перетаскивать выделенное | Windows beta | W4 |
| NP-031 | [#33](https://github.com/andmetoo/netami-pin/issues/33) | Импортировать закладки браузера с папками | Windows beta | W5 |
| NP-032 | [#34](https://github.com/andmetoo/netami-pin/issues/34) | Экспортировать библиотеку в HTML, JSON и CSV | Windows beta | W5 |
| NP-033 | [#35](https://github.com/andmetoo/netami-pin/issues/35) | Восстанавливать библиотеку из JSON | Windows beta | W5 |
| NP-034 | [#36](https://github.com/andmetoo/netami-pin/issues/36) | Создавать и восстанавливать резервную копию | Windows beta | W5 |
| NP-035 | [#37](https://github.com/andmetoo/netami-pin/issues/37) | Находить и разбирать дубликаты | Windows beta | W6 |
| NP-036 | [#38](https://github.com/andmetoo/netami-pin/issues/38) | Проверять доступность ссылок | Windows beta | W6 |
| NP-037 | [#39](https://github.com/andmetoo/netami-pin/issues/39) | Подготовить Windows-установщик | Windows beta | W7 |
| NP-038 | [#40](https://github.com/andmetoo/netami-pin/issues/40) | Доставлять проверенные обновления | Windows beta | W7 |
| NP-039 | [#41](https://github.com/andmetoo/netami-pin/issues/41) | Провести сквозную приёмку Windows-beta | Windows beta | W7 |
| NP-040 | [#42](https://github.com/andmetoo/netami-pin/issues/42) | Подготовить загрузку, диагностику и поддержку | Windows beta | W7 |
| NP-041 | [#43](https://github.com/andmetoo/netami-pin/issues/43) | Выпустить и проверить публичную Windows-beta | Windows beta | W7 |
| NP-042 | [#77](https://github.com/andmetoo/netami-pin/issues/77) | Получить подпись кода и ключ обновлений | Windows beta | W7 |

Ключи NP-042–NP-078 зарезервированы за задачами последующих выпусков; они перечислены в родительских issues и создаются перед началом вехи.
