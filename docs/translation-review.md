# Translation review

How to correct Koona Pin’s interface copy so it reads as a person wrote it, and so it follows Apple’s writing guidelines. English is the source. The other languages mostly translate that English word for word, so a metaphor or an ambiguous sentence in `en.json` becomes the same mistake in every catalog.

This is a correction guide. It does not change the catalogs. Apply it by editing `src/locales/en.json` first, then each other language, using the glossary in [Translating](translating.md).

## What was reviewed

| Surface | Where | Size |
| --- | --- | --- |
| App | `src/locales/*.json` | 2,162 keys in English, the same keys in German, Spanish, French, Italian, Japanese, Korean, Polish, Portuguese (Brazil), Russian, Serbian, Turkish, Ukrainian and Chinese (Simplified). Serbian Latin is generated from Serbian and was not reviewed on its own. |
| Extension | `extension/src/_locales/*/messages.json` | The same languages, Chrome’s codes. It must use the same words as the app. |
| iPhone share sheet | `src-tauri/plugins/koona-share/ios-extension/Strings/*.lproj` | Generated from `phone.share`. Do not edit the `.strings` files. |
| Android share sheet | `src-tauri/plugins/koona-share/android/.../strings.xml` | Generated from `phone.share` by `bun run locales:android`. |

The review compared the strings people see first — navigation, buttons, empty screens, alerts, the editor, and the phone — in every language, and checked the rest of the English catalog for wording that cannot be translated cleanly. It is not a new line for all 2,162 keys.

## The standard

Apple’s writing guidance ([Writing](https://developer.apple.com/design/human-interface-guidelines/writing), [Alerts](https://developer.apple.com/design/human-interface-guidelines/alerts), and the WWDC sessions on interface writing from 2022, 2024 and 2025) plus the glossary already in `docs/translating.md`.

Voice for Koona Pin: a calm person telling you what happened and what you can do. Second person. Contractions. Present tense. Active voice. No jokes, no “oops”, no “please” and “sorry” as filler, and an exclamation mark only when something is actually worth celebrating.

Rules that the current copy breaks:

1. **One name per thing, spelled the same way every time.** Trash, Favorites, Reading, Inbox, Library and Collection are the names of places. Capitalize them in every language’s equivalent, including in the middle of a sentence. “Move to trash” and “Move to Trash” are two different labels today.
2. **Sentence case for buttons, rows and alert titles that are full sentences.** Capitalize the first word and proper names only. A button is a verb, one or two words, with no period: “Delete forever”, “Try again”. A button that only dismisses information can say “Got it”. Use “Cancel” to cancel. Do not use “Yes”, “No” or “OK” for a choice.
3. **An alert title says what is happening.** “Delete collection?” is the right shape. The message adds the consequence once. It does not repeat the button, and it does not put the button’s title in quotation marks. Say “choose Delete” so the same sentence works for a click and a tap.
4. **Say the result, not a picture.** “Your bookmarks will live here” describes a house. People need to know the screen is empty and how to fill it.
5. **One sentence stays in one string.** “Supporters keep Koona Pin going” plus a second string “and get a few things more…” cannot be translated. German has to start the second line with “und”, and Russian turns “supporters” into a singular product name.
6. **Platform words.** On iPhone: “tap”, and “touch and hold”. On Mac and Windows: “click”. “Long-press” is not an Apple term. In Chinese, tap is 轻点 and touch and hold is 按住. 点按 is the Mac word for click, and it is what the phone strings say now.
7. **The glossary wins when English is ambiguous.** “Sort” the inbox and “Sort by” the list are different actions. German, French and Spanish use the same verb for both. Turkish uses Düzenle for inbox Sort and for Edit.

Spelling in English should be American, matching Apple’s own English and the rest of this catalog: color, licenses, favorites. Today the desktop says “Licenses” and the phone says “Licences”, and the icon dialog says “colour”.

Quotation marks in English are “…” . The source currently uses «…», which is French and Russian punctuation, and translators copied it.

## Fix the English first

These are the strings that make the other languages sound translated. Replace the English, then retranslate. Do not polish a German sentence that is a faithful rendering of a bad English one.

| Key | Now | Corrected | Why |
| --- | --- | --- | --- |
| `empty.library` | Your bookmarks will live here | Bookmarks you save show up here | “Live” was translated as dwell: wohnen, habiter, vivirán, vivranno, vão morar, zamieszkają, yaşayacak, житимуть, живети. Russian, Japanese, Korean and Chinese already dropped the metaphor. |
| `empty.libraryHint` | Import bookmarks from your browser, connect the extension or add a link by hand. | Import from your browser, connect the extension, or add a link. | The buttons under this line already say that. Keep one short instruction. |
| `empty.readingHint` | …Read ones leave after a week. | …Bookmarks you’ve read leave after a week. | “Read ones” is not a phrase. Every language guessed. |
| `empty.inbox` / `phone.inbox.allSorted` | All sorted | Nothing to sort | “Sorted” is also the list order. French, German and Spanish then used the same verb as “Sort by”. |
| `empty.inboxHint` | New bookmarks from the browser and imports land here and wait for a decision. | New bookmarks from your browser, and from imports, wait here until you decide. | “Land” and “a decision” are vague. Name the person. |
| `phone.inbox.emptyShare` | Links you save from other apps land here. Sort them in a minute. | Links you save from other apps wait here. You can sort them in about a minute. | German, French, Spanish and Italian read this as an order with a deadline (“sort them within one minute”). Japanese, Korean, Chinese and Polish read it as a promise. The second reading is the one to keep. |
| `phone.inbox.emptyAdd` | Links you save land here. Sort them in a minute. | Links you save wait here. You can sort them in about a minute. | Same split. |
| `inbox.banner_one` | {{count}} new bookmark is waiting — keeping, filing or tossing it takes a moment | {{count}} new bookmark is waiting. Keeping, filing or deleting it takes a moment. | “Tossing” is cute and becomes “throw away”, which sounds harsher than Move to Trash. Use the action’s real name. |
| `phone.library.empty.favoritesHint` | Long-press a bookmark and choose Add to favorites | Touch and hold a bookmark, then choose Add to Favorites. | Apple’s term is touch and hold. Quote nothing. Capitalize the place name. |
| `phone.library.empty.readingHint` | Open a bookmark and tap the book, or long-press it and choose Send to Reading. Read ones leave after a week. | Open a bookmark and tap the book, or touch and hold it and choose Send to Reading. Bookmarks you’ve read leave after a week. | “The book” names an icon the sentence never explains. If the control has no name, give the button a name and use that. |
| `phone.library.empty.libraryHint` | Tap + to save a link: it waits here with its title and picture. | Tap + to save a link. It shows up here with its title and picture. | “It waits” makes the link a person. Same pattern as “will live here”. |
| `phone.settings.sample` | Reading is quieter here: the article's own words, in a calm column, at the size you like. | The article’s own words, in one column, at the size you like. | This line is a type sample. “Quieter” and “calm” became “the room is silent” in several languages. A sample does not need a mood. |
| `phone.you.freeText` | Your library, Reading and progress on every device, encrypted before it leaves them. | Your library, Reading and progress stay on every device, encrypted before they leave it. | The current line has no verb. Translators invented one, and Japanese and Korean stopped addressing “you”. |
| `phone.supporter.lead` + `leadText` | Supporters keep Koona Pin going / and get a few things more on this phone. | Supporters keep Koona Pin going, and get a few extra things on this phone. | Put the sentence in one string, or make each string a full sentence. |
| `editor.saveFailed` | Couldn’t save — your changes are still in the form. | Couldn’t save. Your changes are still here. | “Form” is a word for the person who built the screen. |
| `editor.titleRequired` | Title can’t be empty | Add a title | Say what to do. “Can’t be empty” describes a validation rule. |
| `confirm.deleteCollectionText` | Bookmarks of «{{name}}» stay in the library without a collection. | Bookmarks in “{{name}}” stay in your library, with no collection. | English uses «». “Bookmarks of X” is the word order of a translation. |
| `confirm.emptyTrash` | Empty trash? | Empty Trash? | Trash is the name of the place. |
| `confirm.emptyTrashText_*` | …deleted for good. This can't be undone, and it won't come back with Restore. | …will be deleted. You can’t undo this, and Restore won’t bring them back. | One consequence, said once. “For good” plus “can’t be undone” plus “won’t come back” is the same fact three times. |
| `confirm.deleteForeverText` | «{{title}}» will be deleted for good. This can't be undone. | “{{title}}” will be deleted, and you can’t undo it. | Same. |
| `card.delete` / `phone.inbox.toTrash` | Move to trash | Move to Trash | Match `phone.edit.trash`, which already says Trash. |
| `card.favorite` | Add to favorites | Add to Favorites | The place is called Favorites in the sidebar. |
| `common.retry` | Try again | Try again | Keep this. Several languages shortened it to the system word Retry (再試行, 重试, Reintentar, Повторить). The English is the better line. Ask them to translate “try again”, not “retry”. |
| `common.ok` | Got it | Got it | Keep this. Japanese replaced it with OK, and Korean with 확인, which is the system OK. |
| `feedback.sentTitle` | Sent. Thank you! | Sent. Thank you. | An exclamation mark is for a celebration. Sending a message is not one. |
| `update.failed` body | Something went wrong while updating. Try again later. | Couldn’t update. Try again later. | “Something went wrong” names nothing. The title already has room for the fact. |
| `nav.all` | All bookmarks | All bookmarks | Spanish dropped “All” and says only Marcadores, so the row looks like the word Bookmark. Keep “All” in every language. |
| `settings` licences on the phone | Licences | Licenses | Same word as desktop Settings. |
| `collectionStyle.title` | Icon and colour | Icon and color | American spelling, like the rest of the English. |

Buttons and short labels that are already right, and should stay: Close, Cancel, Done, Save, Keep, Delete, Got it, Try again. “Keep” must stay a decision about this bookmark (“leave it as it is”), not the verb “maintain a setting”. Korean 유지 is the second meaning.

Search the English file for « and replace each pair with “”. Search for `Could not` and use `Couldn’t`, which is already the voice of the other errors. Search for `trash` and `favorites` in the middle of a sentence and capitalize the place name.

`settings.openLinksHint` (“the shutter on a cover”) uses a word the interface never shows. Name the control the way the screen names it, or describe it as “the button on a cover”.

## How to correct a language

Work from the corrected English, not from the current translation. For each string:

- Read it aloud. If you would not say it to someone holding the phone, rewrite it.
- Use the one glossary word. Inbox sort and list sort get different verbs. Edit and inbox Sort get different verbs.
- Keep the address in [Translating](translating.md): German Sie, French vous, Spanish tú, Italian tu, Portuguese você, Polish ty, Russian, Ukrainian and Serbian ви, Turkish siz, Chinese 你, Japanese です/ます, Korean 해요체 for sentences and a short verb for buttons.
- Use that language’s quotation marks, including the no-break spaces in French (« … »).
- Leave `{{name}}`, `{{count}}` and the plural suffixes exactly as they are.
- Do not translate Koona Pin, or the product names listed as “not translated” in the glossary. Translate Reading, Inbox, Trash and the other glossary terms, and use the same translation every time. Supporter may stay as the plan’s name.
- A button stays a verb. Do not turn “Try again” into a noun like “retry attempt”.
- On phone strings, use the platform’s word for tap and for touch and hold.

After a language changes, run `bun run test`. If `sr.json` changed, regenerate Latin with `bun run locales:sr-latn`. If `phone.share` changed, regenerate the native share sheets. Then `bun run test:ui -- --grep @languages`, because German, French and Polish run long and the sidebar has a fixed slot.

## What each language needs

The tables are the lines to change. The note under each language is the habit to apply everywhere else.

### German

Address is Sie in most of the app and du in feeds, import, Supporter and one phone sentence (`phone.reader.finishText`, “Du kannst es…”). The glossary says Sie. Change the du lines. There are about seventeen of them, against Sie everywhere else.

| Now | Corrected |
| --- | --- |
| Hier werden Ihre Lesezeichen wohnen | Gespeicherte Lesezeichen erscheinen hier |
| Sortieren Sie sie in einer Minute. | Sie können sie in etwa einer Minute einordnen. |
| `inbox.sort` Sortieren, next to Sortieren nach | Einordnen |
| Gelesene verlassen die Liste nach einer Woche. | Gelesene Lesezeichen verlassen die Liste nach einer Woche. |
| Der Link wandert zu „Gelesen“. Du kannst es… | Der Link wandert zu „Gelesen“. Sie können es gleich danach widerrufen. |

“Wohnen” and “landen” are the English metaphors. “Einordnen” keeps inbox Sort away from “Sortieren nach”.

### French

Vous is consistent. The failure is stacked grammar and one verb for two actions.

| Now | Corrected |
| --- | --- |
| Vos signets habiteront ici | Les signets que vous enregistrez apparaissent ici |
| Triez-les en une minute. | Vous pouvez les trier en une minute environ. |
| Ajouter à À lire | Mettre dans À lire |
| `inbox.sort` Trier, next to Trier par | Classer |
| Les signets lus partent au bout d’une semaine. | Les signets lus quittent la liste au bout d’une semaine. |

“Ajouter à À lire” cannot be read aloud. “Partent” is the English “leave” used for people.

### Spanish

Tú is consistent. “All bookmarks” lost the word All.

| Now | Corrected |
| --- | --- |
| Aquí vivirán tus marcadores | Los marcadores que guardes aparecen aquí |
| `nav.all` Marcadores | Todos los marcadores |
| Ordénalos en un minuto. | Puedes ordenarlos en un minuto aproximadamente. |
| `inbox.sort` Ordenar, next to Ordenar por | Clasificar |
| `common.retry` Reintentar | Inténtalo de nuevo |
| Los leídos se van al cabo de una semana. | Los marcadores leídos salen de la lista al cabo de una semana. |

Reintentar is the system label for Retry. The English says Try again.

### Italian

Tu is consistent, and Smista versus Ordina per already follows the glossary. Keep that.

| Now | Corrected |
| --- | --- |
| Qui vivranno i tuoi segnalibri | I segnalibri che salvi compaiono qui |
| Smistali in un minuto. | Puoi smistarli in un minuto circa. |
| Quelli letti escono dopo una settimana. | I segnalibri letti escono dall’elenco dopo una settimana. |
| Aggiungi a Da leggere | Metti in Da leggere |

### Portuguese (Brazil)

Você is consistent, and Marcador is used for a bookmark, which is what the glossary requires.

| Now | Corrected |
| --- | --- |
| Seus marcadores vão morar aqui | Os marcadores que você salvar aparecem aqui |
| Organize-os em um minuto. | Você pode organizá-los em cerca de um minuto. |
| `common.done` Concluir | Pronto |
| Os lidos saem depois de uma semana. | Os marcadores lidos saem da lista depois de uma semana. |

Concluir means “to conclude a task”. Apple’s Done in this kind of bar is Pronto.

### Polish

Ty is consistent, and “Uporządkujesz je w minutę” already has the promise, not the deadline. Keep that shape.

| Now | Corrected |
| --- | --- |
| Tu zamieszkają twoje zakładki | Zapisane zakładki pojawią się tutaj |
| Przeczytane znikają stąd po tygodniu. | Przeczytane zakładki znikają stąd po tygodniu. |

Zostaw for Keep is already something a person would say. Keep it.

### Russian

Вы is consistent, and this catalog already avoided the worst metaphor (“Здесь будут ваши закладки”). Use it as the model for the others.

| Now | Corrected |
| --- | --- |
| `common.retry` Повторить | Ещё раз |
| Supporter поддерживает Koona Pin / и получает чуть больше… | Те, кто поддерживает Koona Pin, помогают ему развиваться и получают на этом телефоне несколько дополнительных возможностей. |
| Прочитанные уходят отсюда через неделю. | Прочитанные закладки уходят отсюда через неделю. |

Повторить is “repeat”. Ещё раз is “try again”. The Supporter lines became singular because the English sentence was cut in half. Write them as one sentence about people, and leave the product name Supporter untranslated only where it is the plan’s name (`phone.you.supporter`).

### Ukrainian

Same corrections as Russian. “Тут житимуть ваші закладки” still has the dwelling metaphor. Use “Збережені закладки з’являться тут”. The apostrophe in Ukrainian stays U+0027, as the glossary says.

### Serbian

Ви is consistent. Отпад is the right system name for Trash. “Овде ће живети ваши обележивачи” is the dwelling metaphor: “Сачувани обележивачи појавиће се овде”. In `phone.reader.finishText`, “Веза прелази у Прочитано” calls the bookmark a connection. Use “Обележивач прелази у Прочитано”. Regenerate `sr-Latn.json` after editing `sr.json`. Do not edit the Latin file.

### Turkish

Siz is consistent. Yer işareti is the dictionary gloss of “bookmark” and it makes every button long. Firefox and everyday Turkish use yer imi. Use yer imi for Bookmark and bağlantı for Link, and keep them apart the way the glossary does.

| Now | Corrected |
| --- | --- |
| Yer işaretleriniz burada yaşayacak | Kaydettiğiniz yer imleri burada görünür |
| `inbox.sort` Düzenle | Ayır |
| Bir dakikada düzenleyin. | Yaklaşık bir dakikada ayırabilirsiniz. |

Düzenle is already the word for Edit. Ayır is the inbox decision, and Sıralama stays the list order.

### Japanese

です/ます is in place, and several empty states are already natural (ここにブックマークが並びます, 1 分で整理できます). Keep the space between Japanese and Latin text.

| Now | Corrected |
| --- | --- |
| `common.ok` OK | わかりました |
| `common.retry` 再試行 | もう一度試す |
| `nav.inbox` インボックス | 受信トレイ |
| `nav.links` リンクチェック | リンクを確認 |
| 長押し | タッチして押さえたまま |

受信トレイ is the system name for an inbox. インボックス and リンクチェック are the English words written in katakana. 再試行 is the system word for Retry.

### Korean

Buttons are already short, which is right. The speech level is mixed: some lines are 합니다 and some are 해요. The glossary currently asks for 합니다체. The empty states already use 해요체, and that is the warmer voice for this app, so change the glossary to 해요체 and use it for every sentence.

| Now | Corrected |
| --- | --- |
| `common.keep` 유지 | 두기 |
| `common.ok` 확인 | 알겠어요 |
| `common.retry` 다시 시도 | 다시 시도하기 |
| 길게 누르고 | 길게 터치하기 |

유지 means “keep a setting turned on”. 두기 means “leave this bookmark as it is”, which is the triage decision. After a placeholder, keep both particle forms (`{{name}}을(를)`).

### Chinese (Simplified)

你 is already used, and the empty library line is already plain (你的书签将存放在这里). Punctuation is full-width. Keep the space between Chinese and Latin text.

| Now | Corrected |
| --- | --- |
| `nav.favorites` 星标 | 收藏 |
| `card.favorite` 加星标 | 加入收藏 |
| `common.retry` 重试 | 再试一次 |
| 点按 + | 轻点 + |
| 长按书签 | 按住书签 |
| 它会带着标题和图片在这里等你 | 保存后会显示在这里，带有标题和图片 |

星标 describes the star icon. 收藏 is the place. 点按 is click on a Mac. On iPhone the words are 轻点 and 按住. “在这里等你” makes the link wait for you, which is the English metaphor again.

## What is already in good shape

- Close, Cancel, Save, Delete and the alert question “Delete collection?” are the right shape in every language, with the right punctuation (¿ in Spanish, full-width ？ in Japanese and Chinese, a no-break space before ? in French).
- Trash uses the system word: Papierkorb, Corbeille, Papelera, Cestino, Lixeira, Kosz, Корзина, ゴミ箱, 휴지통, 回收站.
- Placeholders, plural suffixes and the “do not translate Koona Pin” rule are holding. The locale tests already catch a missing key, a missing plural and a broken `{{name}}`.
- Russian, Japanese, Korean and Chinese empty states are often more natural than the English they came from. When English is corrected, do not translate the new line back into the old metaphor. Keep the plain version.
- Italian Smista / Ordina per, Russian Разобрать / Сортировка, Japanese 整理 / 並べ替え, Korean 정리 / 정렬 and Chinese 整理 / 排序方式 already separate inbox Sort from Sort by. German, French and Spanish should copy that split, not those words.

## Order of work

1. Correct `en.json` using the table above, including « → “”, Trash, Favorites, color, licenses, and Couldn’t.
2. Retranslate the changed keys in each language using the per-language table, and apply that language’s habit to the same kind of sentence elsewhere (metaphors, “try again”, touch and hold, one verb per action).
3. Regenerate Serbian Latin, and the iOS and Android share strings if `phone.share` moved.
4. Give the extension catalogs the same glossary words. The store description can stay a sentence, but Inbox, Reading, Favorites and Trash must match the app.
5. Run `bun run test` and the `@languages` UI check.

The catalogs are complete. The work is to make the English say one plain thing, and to stop the other languages from translating the picture instead of the thing.
