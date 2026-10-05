# Netami Pin — privacy policy

Text for https://pin.netami.app/privacy, in English and Russian. Last updated: 5 October 2026.

---

## English

Netami Pin is a desktop app for Windows that keeps your bookmarks on your computer, and a browser extension for Chrome, Edge and Firefox that saves pages to it. There is no account and no cloud. The developer does not receive your data.

**What the extension handles.** When you click the Netami Pin button, the extension reads the address (URL) and title of the current tab. It reads no other tabs and no page content. Right after the click it shows a short note in the corner of that tab; the note reads nothing from the page. When you search your links from the extension, the words you type go to the app on this computer, the same way.

**Where it goes.** The extension passes the address and title to the Netami Pin app on the same computer through the browser's native messaging. Until the app confirms a link, the link waits in the extension's local storage in your browser. The extension also keeps the time of the last save and the result of its last check of the app. Removing the extension or the browser profile deletes this data.

**What the app keeps.** The app stores your bookmarks, collections, tags and notes in a library file on your computer, and keeps local backup copies of it. It records which browsers saved links and when, to show the connection status.

**Network requests.** The extension makes none. The app connects to the website of a link you save to read its title, description, preview image and icon; that website sees an ordinary request from your computer. When a site has no icon, the app asks Google's favicon service for one and sends it the site's domain name. When you start a link check, the app requests the address of each saved link once, without loading the page, to see whether it still opens; addresses on your computer or local network are not requested. Nothing is sent to the developer: no analytics, no telemetry, no crash reports.

**This website.** pin.netami.app is delivered through Cloudflare. Cloudflare Web Analytics counts visits to the site without cookies; the server keeps short access logs of the pages it served, without your IP address.

**Sharing.** Your data is not sold, shared or transferred to anyone, and is not used for anything other than saving and showing your bookmarks.

**Contact.** https://pin.netami.app

---

## Русский

Netami Pin — приложение для Windows, которое хранит закладки на вашем компьютере, и расширение для Chrome, Edge и Firefox, которое сохраняет в него страницы. Аккаунта и облака нет. Разработчик ваших данных не получает.

**Что обрабатывает расширение.** Когда вы нажимаете кнопку Netami Pin, расширение читает адрес (URL) и заголовок текущей вкладки. Другие вкладки и содержимое страниц оно не читает. Сразу после нажатия оно показывает короткое сообщение в углу этой вкладки; сообщение ничего не читает со страницы. Когда вы ищете ссылки из расширения, набранные слова тем же путём уходят в приложение на этом компьютере.

**Куда это попадает.** Расширение передаёт адрес и заголовок приложению Netami Pin на этом же компьютере через Native Messaging браузера. Пока приложение не подтвердит ссылку, она ждёт в локальном хранилище расширения в вашем браузере. Ещё расширение хранит время последнего сохранения и результат последней проверки связи с приложением. Удаление расширения или профиля браузера удаляет эти данные.

**Что хранит приложение.** Приложение хранит закладки, коллекции, теги и заметки в файле библиотеки на вашем компьютере и делает его локальные резервные копии. Оно запоминает, из каких браузеров и когда сохранялись ссылки, чтобы показывать состояние подключения.

**Сетевые запросы.** Расширение их не делает. Приложение обращается к сайту сохранённой ссылки, чтобы получить заголовок, описание, превью и значок; сайт видит обычный запрос с вашего компьютера. Если у сайта нет значка, приложение запрашивает его у сервиса значков Google и передаёт ему доменное имя сайта. Когда вы запускаете проверку ссылок, приложение один раз запрашивает адрес каждой сохранённой ссылки, не загружая страницу, чтобы узнать, открывается ли она; адреса на вашем компьютере и в локальной сети не запрашиваются. Разработчику ничего не отправляется: ни аналитики, ни телеметрии, ни отчётов о сбоях.

**Этот сайт.** pin.netami.app доставляет Cloudflare. Cloudflare Web Analytics считает посещения сайта без cookies; сервер ведёт короткие журналы отданных страниц без вашего IP-адреса.

**Передача.** Ваши данные не продаются, не передаются и не используются ни для чего, кроме сохранения и показа ваших закладок.

**Связь.** https://pin.netami.app
