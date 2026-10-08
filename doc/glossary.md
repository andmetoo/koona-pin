# Глоссарий интерфейса

Дата: 7 октября 2026 года. Задачи NP-089 и NP-090, решения [Р-46](decisions.md#р-46-сербский-и-восемь-европейских-языков) и [Р-51](decisions.md#р-51-китайский-японский-и-корейский).

Термины совпадают в приложении (`src/locales`), расширении (`extension/src/_locales`) и на сайте. Новый перевод начинается с этой таблицы. Если термин меняется, его меняют здесь и во всех трёх местах одним изменением. Английский — источник ([Р-42](decisions.md#р-42-английский--язык-по-умолчанию-и-исходный-язык-строк)). Сербская латиница не переводится: `sr-Latn.json` собирает `bun run locales:sr-latn` из кириллицы.

Не переводятся: Koona Pin, Windows, Chrome, Edge, Firefox, Chrome Web Store, Edge Add-ons, HTML, JSON, CSV, URL, HTTP/HTTPS, Ctrl, Shift, Alt, Esc, Enter, Del.

## Термины

| en | ru | sr | de | es | fr | it | pt-BR | pl | uk | tr | zh-CN | ja | ko |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Library | Библиотека | Библиотека | Bibliothek | Biblioteca | Bibliothèque | Libreria | Biblioteca | Biblioteka | Бібліотека | Kitaplık | 资料库 | ライブラリ | 라이브러리 |
| Bookmark | Закладка | Обележивач | Lesezeichen | Marcador | Signet | Segnalibro | Marcador | Zakładka | Закладка | Yer işareti | 书签 | ブックマーク | 북마크 |
| Link | Ссылка | Линк | Link | Enlace | Lien | Link | Link | Link | Посилання | Bağlantı | 链接 | リンク | 링크 |
| Inbox | Входящие | Пријемно сандуче | Eingang | Bandeja de entrada | Boîte de réception | In arrivo | Caixa de entrada | Skrzynka odbiorcza | Вхідні | Gelen kutusu | 收件箱 | インボックス | 받은함 |
| Sort inbox (triage) | Разбор входящих | Разврставање | Eingang sortieren | Ordenar la bandeja | Trier la boîte de réception | Smista In arrivo | Organizar a caixa de entrada | Porządkowanie skrzynki | Розбір вхідних | Gelen kutusunu düzenle | 整理收件箱 | インボックスを整理 | 받은함 정리 |
| Keep | Оставить | Задржи | Behalten | Conservar | Garder | Tieni | Manter | Zostaw | Залишити | Tut | 保留 | 残す | 유지 |
| Collection | Коллекция | Колекција | Sammlung | Colección | Collection | Raccolta | Coleção | Kolekcja | Колекція | Koleksiyon | 合集 | コレクション | 컬렉션 |
| Tag | Тег | Ознака | Tag | Etiqueta | Étiquette | Tag | Tag | Tag | Тег | Etiket | 标签 | タグ | 태그 |
| Note | Заметка | Белешка | Notiz | Nota | Note | Nota | Nota | Notatka | Нотатка | Not | 笔记 | メモ | 메모 |
| Favorites | Избранное | Омиљено | Favoriten | Favoritos | Favoris | Preferiti | Favoritos | Ulubione | Обране | Favoriler | 星标 | お気に入り | 즐겨찾기 |
| Trash | Корзина | Отпад | Papierkorb | Papelera | Corbeille | Cestino | Lixeira | Kosz | Кошик | Çöp kutusu | 回收站 | ゴミ箱 | 휴지통 |
| Move to Trash | В корзину | Премести у отпад | In den Papierkorb | Mover a la papelera | Mettre à la corbeille | Sposta nel cestino | Mover para a lixeira | Przenieś do kosza | У кошик | Çöp kutusuna taşı | 移到回收站 | ゴミ箱に移動 | 휴지통으로 이동 |
| Delete forever | Удалить навсегда | Трајно обриши | Endgültig löschen | Eliminar definitivamente | Supprimer définitivement | Elimina definitivamente | Excluir permanentemente | Usuń na zawsze | Видалити назавжди | Kalıcı olarak sil | 永久删除 | 完全に削除 | 영구 삭제 |
| Restore | Восстановить | Врати | Wiederherstellen | Restaurar | Restaurer | Ripristina | Restaurar | Przywróć | Відновити | Geri yükle | 恢复 | 復元 | 복원 |
| Undo | Отменить | Опозови | Rückgängig | Deshacer | Annuler | Annulla | Desfazer | Cofnij | Скасувати | Geri al | 撤销 | 元に戻す | 실행 취소 |
| Backup | Резервная копия | Резервна копија | Sicherung | Copia de seguridad | Sauvegarde | Backup | Backup | Kopia zapasowa | Резервна копія | Yedek | 备份 | バックアップ | 백업 |
| Import / Export | Импорт / Экспорт | Увоз / Извоз | Import / Export | Importar / Exportar | Importer / Exporter | Importa / Esporta | Importar / Exportar | Import / Eksport | Імпорт / Експорт | İçe aktar / Dışa aktar | 导入 / 导出 | インポート / エクスポート | 가져오기 / 내보내기 |
| Duplicates | Дубликаты | Дупликати | Duplikate | Duplicados | Doublons | Duplicati | Duplicatas | Duplikaty | Дублікати | Yinelenenler | 重复项 | 重複 | 중복 항목 |
| Merge | Объединить | Спој | Zusammenführen | Combinar | Fusionner | Unisci | Mesclar | Scal | Об'єднати | Birleştir | 合并 | 統合 | 병합 |
| Link check | Проверка ссылок | Провера линкова | Linkprüfung | Comprobación de enlaces | Vérification des liens | Controllo dei link | Verificação de links | Sprawdzanie linków | Перевірка посилань | Bağlantı denetimi | 链接检查 | リンクチェック | 링크 검사 |
| Selection | Выделение | Избор | Auswahl | Selección | Sélection | Selezione | Seleção | Zaznaczenie | Виділення | Seçim | 选择 | 選択 | 선택 |
| Sort by (list order) | Сортировка | Редослед | Sortieren nach | Ordenar por | Trier par | Ordina per | Ordenar por | Sortuj według | Сортування | Sıralama | 排序方式 | 並べ替え | 정렬 기준 |
| Search index | Поисковый индекс | Индекс претраге | Suchindex | Índice de búsqueda | Index de recherche | Indice di ricerca | Índice de pesquisa | Indeks wyszukiwania | Пошуковий індекс | Arama dizini | 搜索索引 | 検索インデックス | 검색 색인 |
| Extension | Расширение | Проширење | Erweiterung | Extensión | Extension | Estensione | Extensão | Rozszerzenie | Розширення | Uzantı | 扩展 | 拡張機能 | 확장 프로그램 |
| Queue (extension) | Очередь | Ред | Warteschlange | Cola | File d'attente | Coda | Fila | Kolejka | Черга | Kuyruk | 队列 | キュー | 대기열 |
| Tray | Трей | Област обавештења | Infobereich | Bandeja del sistema | Zone de notification | Area di notifica | Bandeja do sistema | Zasobnik systemowy | Системний лоток | Sistem tepsisi | 系统托盘 | 通知領域 | 알림 영역 |
| Settings | Настройки | Подешавања | Einstellungen | Configuración | Paramètres | Impostazioni | Configurações | Ustawienia | Налаштування | Ayarlar | 设置 | 設定 | 설정 |
| Send feedback | Отправить отзыв | Пошаљи коментар | Feedback senden | Enviar comentarios | Envoyer un avis | Invia feedback | Enviar feedback | Wyślij opinię | Надіслати відгук | Geri bildirim gönder | 发送反馈 | フィードバックを送信 | 피드백 보내기 |

«Bookmark» в pt-BR — «Marcador», а не «Favorito», как в Chrome: «Favoritos» в Koona Pin — раздел со звездой.

«Sort by» — порядок списка (NP-114), «Sort inbox» — разбор входящих: в английском оба через «Sort», в остальных языках — разные слова («Сортировка» и «Разбор входящих»), их не путать.

## Обращение и типографика

| Язык | Обращение | Кавычки | Заметки |
| --- | --- | --- | --- |
| ru | вы, повелительное «Откройте» | «…» | — |
| sr | ви, «Отворите» | „…“ | Кириллица — источник, латиница — транслитерация 1:1 |
| de | Sie | „…“ | Существительные с прописной; длинные составные слова — первые кандидаты на обрезку |
| es | tú | «…» | ¿…? и ¡…! |
| fr | vous | « … » с неразрывным пробелом | Неразрывный пробел перед `: ; ? !` |
| it | tu | «…» | — |
| pt-BR | você | “…” | — |
| pl | ty, «Otwórz» | „…” | — |
| uk | ви, «Відкрийте» | «…» | Апостроф — `'` (U+0027), как в Windows |
| tr | siz, «Açın» | “…” | `İ/i` и `I/ı` — разные буквы |
| zh-CN | 你, не 您 | “…” | Упрощённое письмо; знаки препинания полноширинные (，。：（）); между иероглифами и латиницей или числом — пробел |
| ja | です/ます | 「…」 | 、。 и полноширинные скобки; между японским и латиницей или числом — пробел, как в Windows |
| ko | 합니다체; кнопки — коротко («저장», «삭제») | ‘…’ | Частица после подстановки — двойной формой: `{{name}}을(를)`, `(으)로`; перенос по словам |

## Как добавить язык

См. [guidelines.md](guidelines.md#языки-интерфейса).
