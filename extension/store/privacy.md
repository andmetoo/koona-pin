# Koona Pin — privacy policy

Text for https://koona.app/pin/privacy in the site's languages (NP-107). English is the original; Russian was written alongside it; the other sections are translations without a native speaker's review, and the site says so on their pages. Serbian is in Latin script, the site's one Serbian. Last updated: 7 October 2026.

---

## English

Koona Pin is a desktop app that keeps your bookmarks on your computer, and a browser extension for Chrome, Edge and Firefox that saves pages to it. There is no account and no cloud. The developer does not receive your bookmarks; only feedback you choose to send reaches them.

**What the extension handles.** When you click the Koona Pin button, the extension reads the address (URL) and title of the current tab. It reads no other tabs and no page content. Right after the click it shows a short note in the corner of that tab; the note reads nothing from the page. When you search your links from the extension, the words you type go to the app on this computer, the same way. If you turn on «Show that a page is already saved», the browser asks you for access to your tabs, and the extension then sends the address of each page you open to the app on this computer to check whether it is in your library; turning it off gives the access back.

**Where it goes.** The extension passes the address and title to the Koona Pin app on the same computer through the browser's native messaging. Until the app confirms a link, the link waits in the extension's local storage in your browser. The extension also keeps the time of the last save and the result of its last check of the app. Removing the extension or the browser profile deletes this data.

**What the app keeps.** The app stores your bookmarks, collections, tags and notes in a library file on your computer, and keeps local backup copies of it. It records which browsers saved links and when, to show the connection status.

**Network requests.** The extension makes none. The app connects to the website of a link you save to read its title, description, preview image and icon; that website sees an ordinary request from your computer. When a site has no icon, the app asks Google's favicon service for one and sends it the site's domain name. When you start a link check, the app requests the address of each saved link once, without loading the page, to see whether it still opens; addresses on your computer or local network are not requested. Nothing is sent to the developer on its own: no analytics, no telemetry, no crash reports.

**Feedback you send.** «Send feedback» in the app and the feedback form on this website send the developer what you write: the type (bug, idea or question), your message and, if you give one, an email address for the reply. The app adds its version, the operating system version and the interface language, and — only if «Attach report» is ticked — the report shown in the dialog before sending: the capture status and, if capture fails, the system's error message with your user folder shortened, the protocol and versions of the extensions and when each browser last wrote; no links, titles, tags or notes. Nothing leaves your computer until you press Send. Messages are stored in a Supabase database in the European Union (Frankfurt) for up to 12 months and then deleted. The developer gets a Telegram notification with only the type, the versions and the length of the message — not its text, the email address or the report. Against spam, the function keeps the address of your connection for one day, only as a salted hash; Supabase, which hosts the database, also keeps short technical logs of requests with that address. To have a message deleted sooner, ask through Support on this website and say roughly when you sent it.

**This website.** koona.app/pin is delivered through Cloudflare. Cloudflare Web Analytics counts visits to the site without cookies; the server keeps short access logs of the pages it served, without your IP address.

**Sharing.** Your data is not sold, shared or transferred to anyone, and is not used for anything other than saving and showing your bookmarks.

**Contact.** https://koona.app/pin/

---

## Русский

Koona Pin — настольное приложение, которое хранит закладки на вашем компьютере, и расширение для Chrome, Edge и Firefox, которое сохраняет в него страницы. Аккаунта и облака нет. Разработчик ваших закладок не получает; к нему попадает только отзыв, который вы отправите сами.

**Что обрабатывает расширение.** Когда вы нажимаете кнопку Koona Pin, расширение читает адрес (URL) и заголовок текущей вкладки. Другие вкладки и содержимое страниц оно не читает. Сразу после нажатия оно показывает короткое сообщение в углу этой вкладки; сообщение ничего не читает со страницы. Когда вы ищете ссылки из расширения, набранные слова тем же путём уходят в приложение на этом компьютере. Если включить «Показывать, что страница уже сохранена», браузер спросит доступ к вкладкам, и расширение будет передавать адрес каждой открытой страницы приложению на этом компьютере, чтобы проверить, есть ли она в библиотеке; выключение возвращает доступ.

**Куда это попадает.** Расширение передаёт адрес и заголовок приложению Koona Pin на этом же компьютере через Native Messaging браузера. Пока приложение не подтвердит ссылку, она ждёт в локальном хранилище расширения в вашем браузере. Ещё расширение хранит время последнего сохранения и результат последней проверки связи с приложением. Удаление расширения или профиля браузера удаляет эти данные.

**Что хранит приложение.** Приложение хранит закладки, коллекции, теги и заметки в файле библиотеки на вашем компьютере и делает его локальные резервные копии. Оно запоминает, из каких браузеров и когда сохранялись ссылки, чтобы показывать состояние подключения.

**Сетевые запросы.** Расширение их не делает. Приложение обращается к сайту сохранённой ссылки, чтобы получить заголовок, описание, превью и значок; сайт видит обычный запрос с вашего компьютера. Если у сайта нет значка, приложение запрашивает его у сервиса значков Google и передаёт ему доменное имя сайта. Когда вы запускаете проверку ссылок, приложение один раз запрашивает адрес каждой сохранённой ссылки, не загружая страницу, чтобы узнать, открывается ли она; адреса на вашем компьютере и в локальной сети не запрашиваются. Сами по себе разработчику ничего не отправляется: ни аналитики, ни телеметрии, ни отчётов о сбоях.

**Отзыв, который вы отправляете сами.** «Отправить отзыв» в приложении и форма отзыва на этом сайте передают разработчику то, что вы напишете: тип (ошибка, идея или вопрос), сообщение и, если укажете, почту для ответа. Приложение добавляет свою версию, версию операционной системы и язык интерфейса, а если отмечено «Приложить отчёт» — отчёт, который показывается в окне до отправки: состояние захвата и, если захват не работает, текст ошибки системы с сокращённым путём к папке пользователя, протокол и версии расширений и когда каждый браузер писал в последний раз; без ссылок, названий, тегов и заметок. С компьютера ничего не уходит, пока вы не нажмёте «Отправить». Сообщения хранятся в базе Supabase в Евросоюзе (Франкфурт) до 12 месяцев и затем удаляются. Разработчик получает уведомление в Telegram только с типом, версиями и длиной сообщения — без его текста, почты и отчёта. Для защиты от спама функция хранит адрес вашего подключения сутки и только в виде хеша с солью; Supabase, где лежит база, ещё ведёт короткие технические журналы запросов с этим адресом. Чтобы удалить сообщение раньше, напишите через «Поддержку» на этом сайте и укажите, когда примерно его отправили.

**Этот сайт.** koona.app/pin доставляет Cloudflare. Cloudflare Web Analytics считает посещения сайта без cookies; сервер ведёт короткие журналы отданных страниц без вашего IP-адреса.

**Передача.** Ваши данные не продаются, не передаются и не используются ни для чего, кроме сохранения и показа ваших закладок.

**Связь.** https://koona.app/pin/

---

## Srpski

Koona Pin je aplikacija za računar koja čuva vaše obeleživače na vašem računaru, i proširenje za Chrome, Edge i Firefox koje u nju čuva stranice. Nema naloga ni oblaka. Programer ne dobija vaše obeleživače; do njega stiže samo komentar koji sami odlučite da pošaljete.

**Šta proširenje obrađuje.** Kada kliknete na dugme Koona Pin, proširenje čita adresu (URL) i naslov trenutne kartice. Druge kartice i sadržaj stranica ne čita. Odmah posle klika prikazuje kratku poruku u uglu te kartice; poruka ništa ne čita sa stranice. Kada pretražujete linkove iz proširenja, reči koje ukucate na isti način idu aplikaciji na ovom računaru. Ako uključite „Prikaži da je stranica već sačuvana“, pregledač traži pristup vašim karticama, a proširenje tada šalje adresu svake stranice koju otvorite aplikaciji na ovom računaru da proveri da li je u vašoj biblioteci; isključivanje vraća taj pristup.

**Gde to ide.** Proširenje prosleđuje adresu i naslov aplikaciji Koona Pin na istom računaru preko Native Messaging-a pregledača. Dok aplikacija ne potvrdi link, on čeka u lokalnom skladištu proširenja u vašem pregledaču. Proširenje čuva i vreme poslednjeg čuvanja i rezultat poslednje provere veze sa aplikacijom. Uklanjanje proširenja ili profila pregledača briše ove podatke.

**Šta aplikacija čuva.** Aplikacija čuva vaše obeleživače, kolekcije, oznake i beleške u datoteci biblioteke na vašem računaru i pravi njene lokalne rezervne kopije. Beleži iz kojih pregledača i kada su linkovi sačuvani, da bi prikazala stanje veze.

**Mrežni zahtevi.** Proširenje ih ne šalje. Aplikacija se povezuje sa sajtom linka koji sačuvate da pročita naslov, opis, sliku pregleda i ikonu; taj sajt vidi običan zahtev sa vašeg računara. Kada sajt nema ikonu, aplikacija je traži od Google-ovog servisa za ikone i šalje mu ime domena sajta. Kada pokrenete proveru linkova, aplikacija jednom zahteva adresu svakog sačuvanog linka, bez učitavanja stranice, da vidi da li se još otvara; adrese na vašem računaru ili u lokalnoj mreži se ne zahtevaju. Ništa se programeru ne šalje samo od sebe: ni analitika, ni telemetrija, ni izveštaji o padovima.

**Komentar koji šaljete.** „Pošalji komentar“ u aplikaciji i obrazac za komentare na ovom sajtu šalju programeru ono što napišete: vrstu (greška, ideja ili pitanje), vašu poruku i, ako je navedete, adresu e-pošte za odgovor. Aplikacija dodaje svoju verziju, verziju operativnog sistema i jezik interfejsa, a samo ako je označeno „Priloži izveštaj“ — izveštaj prikazan u prozoru pre slanja: stanje hvatanja i, ako hvatanje ne radi, poruku o grešci sistema sa skraćenom putanjom do korisničke fascikle, protokol i verzije proširenja i kada je svaki pregledač poslednji put upisao; bez linkova, naslova, oznaka i beleški. Ništa ne napušta vaš računar dok ne pritisnete „Pošalji“. Poruke se čuvaju u bazi Supabase u Evropskoj uniji (Frankfurt) do 12 meseci, a zatim se brišu. Programer dobija obaveštenje u Telegram-u samo sa vrstom, verzijama i dužinom poruke — bez njenog teksta, adrese e-pošte i izveštaja. Radi zaštite od neželjenih poruka, funkcija jedan dan čuva adresu vaše veze, i to samo kao heš sa solju; Supabase, gde se nalazi baza, vodi i kratke tehničke zapise zahteva sa tom adresom. Da biste poruku obrisali ranije, zatražite to preko „Podrške“ na ovom sajtu i navedite otprilike kada ste je poslali.

**Ovaj sajt.** koona.app/pin isporučuje Cloudflare. Cloudflare Web Analytics broji posete sajtu bez kolačića; server vodi kratke zapise isporučenih stranica, bez vaše IP adrese.

**Deljenje.** Vaši podaci se ne prodaju, ne dele i ne prenose nikome i ne koriste se ni za šta osim za čuvanje i prikaz vaših obeleživača.

**Kontakt.** https://koona.app/pin/

---

## Deutsch

Koona Pin ist eine Desktop-App, die Ihre Lesezeichen auf Ihrem Computer speichert, und eine Browser-Erweiterung für Chrome, Edge und Firefox, die Seiten darin speichert. Es gibt kein Konto und keine Cloud. Der Entwickler erhält Ihre Lesezeichen nicht; nur Feedback, das Sie selbst senden, erreicht ihn.

**Was die Erweiterung verarbeitet.** Wenn Sie auf die Koona-Pin-Schaltfläche klicken, liest die Erweiterung die Adresse (URL) und den Titel des aktuellen Tabs. Andere Tabs und Seiteninhalte liest sie nicht. Direkt nach dem Klick zeigt sie einen kurzen Hinweis in der Ecke dieses Tabs; der Hinweis liest nichts von der Seite. Wenn Sie Ihre Links aus der Erweiterung durchsuchen, gehen die eingegebenen Wörter auf demselben Weg an die App auf diesem Computer. Wenn Sie „Zeigen, dass eine Seite schon gespeichert ist“ einschalten, fragt der Browser nach Zugriff auf Ihre Tabs, und die Erweiterung sendet dann die Adresse jeder geöffneten Seite an die App auf diesem Computer, um zu prüfen, ob sie in Ihrer Bibliothek ist; Ausschalten gibt den Zugriff zurück.

**Wohin es geht.** Die Erweiterung übergibt Adresse und Titel über Native Messaging des Browsers an die Koona-Pin-App auf demselben Computer. Bis die App einen Link bestätigt, wartet er im lokalen Speicher der Erweiterung in Ihrem Browser. Die Erweiterung speichert außerdem den Zeitpunkt der letzten Speicherung und das Ergebnis ihrer letzten Prüfung der App. Das Entfernen der Erweiterung oder des Browserprofils löscht diese Daten.

**Was die App speichert.** Die App speichert Ihre Lesezeichen, Sammlungen, Tags und Notizen in einer Bibliotheksdatei auf Ihrem Computer und legt lokale Sicherungen davon an. Sie vermerkt, welche Browser wann Links gespeichert haben, um den Verbindungsstatus anzuzeigen.

**Netzwerkanfragen.** Die Erweiterung stellt keine. Die App verbindet sich mit der Website eines gespeicherten Links, um Titel, Beschreibung, Vorschaubild und Symbol zu lesen; diese Website sieht eine gewöhnliche Anfrage von Ihrem Computer. Hat eine Website kein Symbol, fragt die App den Favicon-Dienst von Google danach und sendet ihm den Domainnamen der Website. Wenn Sie eine Linkprüfung starten, fragt die App die Adresse jedes gespeicherten Links einmal ab, ohne die Seite zu laden, um zu sehen, ob sie noch erreichbar ist; Adressen auf Ihrem Computer oder in Ihrem lokalen Netzwerk werden nicht abgefragt. Von selbst wird nichts an den Entwickler gesendet: keine Analysedaten, keine Telemetrie, keine Absturzberichte.

**Feedback, das Sie senden.** „Feedback senden“ in der App und das Feedback-Formular auf dieser Website senden dem Entwickler, was Sie schreiben: die Art (Fehler, Idee oder Frage), Ihre Nachricht und, falls angegeben, eine E-Mail-Adresse für die Antwort. Die App fügt ihre Version, die Version des Betriebssystems und die Sprache der Oberfläche hinzu und — nur wenn „Bericht anhängen“ angehakt ist — den Bericht, der vor dem Senden im Fenster angezeigt wird: den Erfassungsstatus und, falls die Erfassung nicht funktioniert, die Fehlermeldung des Systems mit gekürztem Benutzerordner, das Protokoll und die Versionen der Erweiterungen und wann jeder Browser zuletzt geschrieben hat; keine Links, Titel, Tags oder Notizen. Nichts verlässt Ihren Computer, bevor Sie auf „Senden“ drücken. Nachrichten werden in einer Supabase-Datenbank in der Europäischen Union (Frankfurt) bis zu 12 Monate gespeichert und dann gelöscht. Der Entwickler erhält eine Telegram-Benachrichtigung nur mit Art, Versionen und Länge der Nachricht — nicht mit ihrem Text, der E-Mail-Adresse oder dem Bericht. Gegen Spam speichert die Funktion die Adresse Ihrer Verbindung einen Tag lang, nur als gesalzenen Hash; Supabase, das die Datenbank betreibt, führt außerdem kurze technische Protokolle der Anfragen mit dieser Adresse. Um eine Nachricht früher löschen zu lassen, bitten Sie darum über „Support“ auf dieser Website und nennen Sie ungefähr, wann Sie sie gesendet haben.

**Diese Website.** koona.app/pin wird über Cloudflare ausgeliefert. Cloudflare Web Analytics zählt Besuche der Website ohne Cookies; der Server führt kurze Zugriffsprotokolle der ausgelieferten Seiten, ohne Ihre IP-Adresse.

**Weitergabe.** Ihre Daten werden nicht verkauft, geteilt oder an Dritte übertragen und für nichts anderes verwendet, als Ihre Lesezeichen zu speichern und anzuzeigen.

**Kontakt.** https://koona.app/pin/

---

## Español

Koona Pin es una aplicación de escritorio que guarda tus marcadores en tu ordenador, y una extensión para Chrome, Edge y Firefox que guarda páginas en ella. No hay cuenta ni nube. El desarrollador no recibe tus marcadores; solo le llegan los comentarios que tú decidas enviar.

**Qué maneja la extensión.** Cuando haces clic en el botón de Koona Pin, la extensión lee la dirección (URL) y el título de la pestaña actual. No lee otras pestañas ni el contenido de las páginas. Justo después del clic muestra un aviso breve en la esquina de esa pestaña; el aviso no lee nada de la página. Cuando buscas tus enlaces desde la extensión, las palabras que escribes van del mismo modo a la aplicación de este ordenador. Si activas «Mostrar que una página ya está guardada», el navegador te pide acceso a tus pestañas, y la extensión envía entonces la dirección de cada página que abres a la aplicación de este ordenador para comprobar si está en tu biblioteca; al desactivarlo se devuelve el acceso.

**Adónde va.** La extensión pasa la dirección y el título a la aplicación Koona Pin del mismo ordenador mediante la mensajería nativa (Native Messaging) del navegador. Hasta que la aplicación confirma un enlace, este espera en el almacenamiento local de la extensión en tu navegador. La extensión también guarda la hora del último guardado y el resultado de su última comprobación de la aplicación. Quitar la extensión o el perfil del navegador borra estos datos.

**Qué guarda la aplicación.** La aplicación guarda tus marcadores, colecciones, etiquetas y notas en un archivo de biblioteca en tu ordenador y hace copias de seguridad locales de él. Registra qué navegadores guardaron enlaces y cuándo, para mostrar el estado de la conexión.

**Solicitudes de red.** La extensión no hace ninguna. La aplicación se conecta al sitio web de un enlace que guardas para leer su título, descripción, imagen de vista previa e icono; ese sitio ve una solicitud normal desde tu ordenador. Cuando un sitio no tiene icono, la aplicación se lo pide al servicio de favicons de Google y le envía el nombre de dominio del sitio. Cuando inicias una comprobación de enlaces, la aplicación solicita una vez la dirección de cada enlace guardado, sin cargar la página, para ver si todavía abre; las direcciones de tu ordenador o de tu red local no se solicitan. Nada se envía al desarrollador por sí solo: ni analíticas, ni telemetría, ni informes de errores.

**Comentarios que envías.** «Enviar comentarios» en la aplicación y el formulario de comentarios de este sitio envían al desarrollador lo que escribes: el tipo (error, idea o pregunta), tu mensaje y, si lo indicas, una dirección de correo para la respuesta. La aplicación añade su versión, la versión del sistema operativo y el idioma de la interfaz y, solo si está marcado «Adjuntar informe», el informe que se muestra en la ventana antes de enviar: el estado de la captura y, si la captura falla, el mensaje de error del sistema con tu carpeta de usuario abreviada, el protocolo y las versiones de las extensiones y cuándo escribió cada navegador por última vez; sin enlaces, títulos, etiquetas ni notas. Nada sale de tu ordenador hasta que pulsas Enviar. Los mensajes se guardan en una base de datos de Supabase en la Unión Europea (Fráncfort) hasta 12 meses y después se eliminan. El desarrollador recibe una notificación de Telegram solo con el tipo, las versiones y la longitud del mensaje, no con su texto, el correo ni el informe. Contra el spam, la función guarda la dirección de tu conexión durante un día, solo como hash con sal; Supabase, que aloja la base de datos, también guarda registros técnicos breves de las solicitudes con esa dirección. Para que se elimine un mensaje antes, pídelo a través de Soporte en este sitio e indica aproximadamente cuándo lo enviaste.

**Este sitio web.** koona.app/pin se sirve a través de Cloudflare. Cloudflare Web Analytics cuenta las visitas al sitio sin cookies; el servidor guarda registros de acceso breves de las páginas servidas, sin tu dirección IP.

**Compartir.** Tus datos no se venden, no se comparten ni se transfieren a nadie, y no se usan para nada más que guardar y mostrar tus marcadores.

**Contacto.** https://koona.app/pin/

---

## Français

Koona Pin est une application de bureau qui garde vos signets sur votre ordinateur, et une extension pour Chrome, Edge et Firefox qui y enregistre des pages. Il n’y a ni compte ni cloud. Le développeur ne reçoit pas vos signets ; seul l’avis que vous choisissez d’envoyer lui parvient.

**Ce que l’extension traite.** Quand vous cliquez sur le bouton Koona Pin, l’extension lit l’adresse (URL) et le titre de l’onglet actif. Elle ne lit pas les autres onglets ni le contenu des pages. Juste après le clic, elle affiche une courte notification dans le coin de cet onglet ; la notification ne lit rien de la page. Quand vous cherchez vos liens depuis l’extension, les mots saisis vont de la même façon à l’application de cet ordinateur. Si vous activez « Indiquer qu’une page est déjà enregistrée », le navigateur vous demande l’accès à vos onglets, et l’extension envoie alors l’adresse de chaque page ouverte à l’application de cet ordinateur pour vérifier si elle est dans votre bibliothèque ; la désactivation rend cet accès.

**Où cela va.** L’extension transmet l’adresse et le titre à l’application Koona Pin du même ordinateur par la messagerie native (Native Messaging) du navigateur. Tant que l’application n’a pas confirmé un lien, celui-ci attend dans le stockage local de l’extension, dans votre navigateur. L’extension garde aussi l’heure du dernier enregistrement et le résultat de sa dernière vérification de l’application. Supprimer l’extension ou le profil du navigateur efface ces données.

**Ce que l’application conserve.** L’application conserve vos signets, collections, étiquettes et notes dans un fichier de bibliothèque sur votre ordinateur, et en fait des sauvegardes locales. Elle note quels navigateurs ont enregistré des liens et quand, pour afficher l’état de la connexion.

**Requêtes réseau.** L’extension n’en fait aucune. L’application se connecte au site d’un lien que vous enregistrez pour lire son titre, sa description, son image d’aperçu et son icône ; ce site voit une requête ordinaire venant de votre ordinateur. Quand un site n’a pas d’icône, l’application la demande au service de favicons de Google et lui envoie le nom de domaine du site. Quand vous lancez une vérification des liens, l’application interroge une fois l’adresse de chaque lien enregistré, sans charger la page, pour voir si elle s’ouvre encore ; les adresses de votre ordinateur ou de votre réseau local ne sont pas interrogées. Rien n’est envoyé de lui-même au développeur : ni statistiques, ni télémétrie, ni rapports de plantage.

**L’avis que vous envoyez.** « Envoyer un avis » dans l’application et le formulaire d’avis de ce site envoient au développeur ce que vous écrivez : le type (bug, idée ou question), votre message et, si vous en donnez une, une adresse e-mail pour la réponse. L’application ajoute sa version, la version du système d’exploitation et la langue de l’interface et, seulement si « Joindre le rapport » est coché, le rapport affiché dans la fenêtre avant l’envoi : l’état de la capture et, si la capture échoue, le message d’erreur du système avec votre dossier utilisateur abrégé, le protocole et les versions des extensions et la dernière écriture de chaque navigateur ; ni liens, ni titres, ni étiquettes, ni notes. Rien ne quitte votre ordinateur avant que vous appuyiez sur Envoyer. Les messages sont conservés dans une base de données Supabase dans l’Union européenne (Francfort) jusqu’à 12 mois, puis supprimés. Le développeur reçoit une notification Telegram avec uniquement le type, les versions et la longueur du message — sans son texte, l’adresse e-mail ni le rapport. Contre le spam, la fonction garde l’adresse de votre connexion pendant un jour, uniquement sous forme de hachage salé ; Supabase, qui héberge la base de données, conserve aussi de courts journaux techniques des requêtes avec cette adresse. Pour faire supprimer un message plus tôt, demandez-le via Assistance sur ce site en indiquant à peu près quand vous l’avez envoyé.

**Ce site.** koona.app/pin est distribué par Cloudflare. Cloudflare Web Analytics compte les visites du site sans cookies ; le serveur conserve de courts journaux d’accès des pages servies, sans votre adresse IP.

**Partage.** Vos données ne sont ni vendues, ni partagées, ni transférées à qui que ce soit, et ne servent à rien d’autre qu’à enregistrer et afficher vos signets.

**Contact.** https://koona.app/pin/

---

## Italiano

Koona Pin è un’app desktop che tiene i tuoi segnalibri sul tuo computer, e un’estensione per Chrome, Edge e Firefox che vi salva le pagine. Non ci sono account né cloud. Lo sviluppatore non riceve i tuoi segnalibri; gli arriva solo il feedback che scegli di inviare.

**Cosa tratta l’estensione.** Quando fai clic sul pulsante di Koona Pin, l’estensione legge l’indirizzo (URL) e il titolo della scheda attuale. Non legge altre schede né il contenuto delle pagine. Subito dopo il clic mostra un breve avviso nell’angolo di quella scheda; l’avviso non legge nulla dalla pagina. Quando cerchi i tuoi link dall’estensione, le parole che scrivi vanno allo stesso modo all’app su questo computer. Se attivi «Mostra che una pagina è già salvata», il browser ti chiede l’accesso alle schede, e l’estensione invia allora l’indirizzo di ogni pagina che apri all’app su questo computer per controllare se è nella tua libreria; disattivandolo l’accesso viene restituito.

**Dove va.** L’estensione passa indirizzo e titolo all’app Koona Pin sullo stesso computer tramite la messaggistica nativa (Native Messaging) del browser. Finché l’app non conferma un link, questo resta in attesa nell’archivio locale dell’estensione nel tuo browser. L’estensione conserva anche l’ora dell’ultimo salvataggio e l’esito del suo ultimo controllo dell’app. Rimuovere l’estensione o il profilo del browser cancella questi dati.

**Cosa conserva l’app.** L’app conserva segnalibri, raccolte, tag e note in un file di libreria sul tuo computer e ne fa copie di backup locali. Registra quali browser hanno salvato link e quando, per mostrare lo stato della connessione.

**Richieste di rete.** L’estensione non ne fa. L’app si collega al sito di un link che salvi per leggerne titolo, descrizione, immagine di anteprima e icona; quel sito vede una normale richiesta dal tuo computer. Quando un sito non ha un’icona, l’app la chiede al servizio favicon di Google e gli invia il nome di dominio del sito. Quando avvii un controllo dei link, l’app richiede una volta l’indirizzo di ogni link salvato, senza caricare la pagina, per vedere se si apre ancora; gli indirizzi sul tuo computer o sulla rete locale non vengono richiesti. Niente viene inviato da sé allo sviluppatore: niente statistiche, niente telemetria, niente rapporti sugli arresti anomali.

**Il feedback che invii.** «Invia feedback» nell’app e il modulo di feedback su questo sito inviano allo sviluppatore ciò che scrivi: il tipo (errore, idea o domanda), il tuo messaggio e, se lo indichi, un indirizzo email per la risposta. L’app aggiunge la sua versione, la versione del sistema operativo e la lingua dell’interfaccia e, solo se «Allega il rapporto» è spuntato, il rapporto mostrato nella finestra prima dell’invio: lo stato della cattura e, se la cattura non funziona, il messaggio di errore del sistema con la cartella utente abbreviata, il protocollo e le versioni delle estensioni e quando ogni browser ha scritto l’ultima volta; niente link, titoli, tag o note. Nulla lascia il tuo computer finché non premi Invia. I messaggi sono conservati in un database Supabase nell’Unione europea (Francoforte) fino a 12 mesi e poi eliminati. Lo sviluppatore riceve una notifica Telegram con solo il tipo, le versioni e la lunghezza del messaggio, non il testo, l’indirizzo email o il rapporto. Contro lo spam, la funzione conserva l’indirizzo della tua connessione per un giorno, solo come hash con sale; anche Supabase, che ospita il database, tiene brevi log tecnici delle richieste con quell’indirizzo. Per far eliminare prima un messaggio, chiedilo tramite Assistenza su questo sito indicando più o meno quando l’hai inviato.

**Questo sito.** koona.app/pin è distribuito tramite Cloudflare. Cloudflare Web Analytics conta le visite al sito senza cookie; il server tiene brevi log di accesso delle pagine servite, senza il tuo indirizzo IP.

**Condivisione.** I tuoi dati non vengono venduti, condivisi o trasferiti a nessuno, e non sono usati per altro che salvare e mostrare i tuoi segnalibri.

**Contatti.** https://koona.app/pin/

---

## Português (Brasil)

O Koona Pin é um aplicativo de computador que guarda seus marcadores no seu computador, e uma extensão para Chrome, Edge e Firefox que salva páginas nele. Não há conta nem nuvem. O desenvolvedor não recebe seus marcadores; só chega a ele o feedback que você decidir enviar.

**O que a extensão processa.** Quando você clica no botão do Koona Pin, a extensão lê o endereço (URL) e o título da aba atual. Ela não lê outras abas nem o conteúdo das páginas. Logo após o clique, ela mostra um aviso curto no canto dessa aba; o aviso não lê nada da página. Quando você pesquisa seus links pela extensão, as palavras digitadas vão da mesma forma para o aplicativo neste computador. Se você ativar “Mostrar que uma página já está salva”, o navegador pede acesso às suas abas, e a extensão passa a enviar o endereço de cada página que você abre para o aplicativo neste computador, para verificar se ela está na sua biblioteca; desativar devolve esse acesso.

**Para onde vai.** A extensão passa o endereço e o título para o aplicativo Koona Pin no mesmo computador pelo Native Messaging do navegador. Até o aplicativo confirmar um link, ele espera no armazenamento local da extensão no seu navegador. A extensão também guarda a hora do último salvamento e o resultado da sua última verificação do aplicativo. Remover a extensão ou o perfil do navegador apaga esses dados.

**O que o aplicativo guarda.** O aplicativo guarda seus marcadores, coleções, tags e notas em um arquivo de biblioteca no seu computador e faz cópias de backup locais dele. Ele registra quais navegadores salvaram links e quando, para mostrar o estado da conexão.

**Solicitações de rede.** A extensão não faz nenhuma. O aplicativo se conecta ao site de um link que você salva para ler o título, a descrição, a imagem de prévia e o ícone; esse site vê uma solicitação comum do seu computador. Quando um site não tem ícone, o aplicativo o pede ao serviço de favicons do Google e envia a ele o nome de domínio do site. Quando você inicia uma verificação de links, o aplicativo solicita uma vez o endereço de cada link salvo, sem carregar a página, para ver se ele ainda abre; endereços no seu computador ou na sua rede local não são solicitados. Nada é enviado ao desenvolvedor por conta própria: nem análises, nem telemetria, nem relatórios de falhas.

**O feedback que você envia.** “Enviar feedback” no aplicativo e o formulário de feedback deste site enviam ao desenvolvedor o que você escreve: o tipo (erro, ideia ou pergunta), sua mensagem e, se você informar, um endereço de e-mail para a resposta. O aplicativo adiciona sua versão, a versão do sistema operacional e o idioma da interface e, somente se “Anexar relatório” estiver marcado, o relatório mostrado na janela antes do envio: o estado da captura e, se a captura falhar, a mensagem de erro do sistema com sua pasta de usuário abreviada, o protocolo e as versões das extensões e quando cada navegador escreveu pela última vez; sem links, títulos, tags ou notas. Nada sai do seu computador até você clicar em Enviar. As mensagens ficam armazenadas em um banco de dados Supabase na União Europeia (Frankfurt) por até 12 meses e depois são excluídas. O desenvolvedor recebe uma notificação no Telegram apenas com o tipo, as versões e o tamanho da mensagem — não com o texto, o e-mail ou o relatório. Contra spam, a função guarda o endereço da sua conexão por um dia, apenas como hash com sal; o Supabase, que hospeda o banco de dados, também mantém registros técnicos curtos das solicitações com esse endereço. Para que uma mensagem seja excluída antes, peça pelo Suporte deste site e diga mais ou menos quando a enviou.

**Este site.** koona.app/pin é entregue pela Cloudflare. O Cloudflare Web Analytics conta as visitas ao site sem cookies; o servidor mantém registros curtos de acesso das páginas servidas, sem o seu endereço IP.

**Compartilhamento.** Seus dados não são vendidos, compartilhados nem transferidos a ninguém, e não são usados para nada além de salvar e mostrar seus marcadores.

**Contato.** https://koona.app/pin/

---

## Polski

Koona Pin to aplikacja na komputer, która przechowuje Twoje zakładki na Twoim komputerze, oraz rozszerzenie do Chrome, Edge i Firefoksa, które zapisuje w niej strony. Nie ma konta ani chmury. Twórca nie otrzymuje Twoich zakładek; trafia do niego tylko opinia, którą sam zdecydujesz się wysłać.

**Co przetwarza rozszerzenie.** Gdy klikniesz przycisk Koona Pin, rozszerzenie odczytuje adres (URL) i tytuł bieżącej karty. Nie odczytuje innych kart ani treści stron. Zaraz po kliknięciu pokazuje krótkie powiadomienie w rogu tej karty; powiadomienie niczego nie odczytuje ze strony. Gdy przeszukujesz swoje linki z rozszerzenia, wpisane słowa trafiają tą samą drogą do aplikacji na tym komputerze. Jeśli włączysz „Pokazuj, że strona jest już zapisana”, przeglądarka poprosi o dostęp do kart, a rozszerzenie będzie wtedy wysyłać adres każdej otwieranej strony do aplikacji na tym komputerze, aby sprawdzić, czy jest w Twojej bibliotece; wyłączenie zwraca ten dostęp.

**Dokąd to trafia.** Rozszerzenie przekazuje adres i tytuł do aplikacji Koona Pin na tym samym komputerze przez Native Messaging przeglądarki. Dopóki aplikacja nie potwierdzi linku, czeka on w lokalnej pamięci rozszerzenia w Twojej przeglądarce. Rozszerzenie przechowuje też czas ostatniego zapisu i wynik ostatniego sprawdzenia aplikacji. Usunięcie rozszerzenia lub profilu przeglądarki usuwa te dane.

**Co przechowuje aplikacja.** Aplikacja przechowuje Twoje zakładki, kolekcje, tagi i notatki w pliku biblioteki na Twoim komputerze i tworzy jego lokalne kopie zapasowe. Zapamiętuje, z których przeglądarek i kiedy zapisywano linki, aby pokazywać stan połączenia.

**Żądania sieciowe.** Rozszerzenie ich nie wysyła. Aplikacja łączy się ze stroną zapisanego linku, aby odczytać tytuł, opis, obraz podglądu i ikonę; ta strona widzi zwykłe żądanie z Twojego komputera. Gdy strona nie ma ikony, aplikacja prosi o nią usługę ikon Google i przekazuje jej nazwę domeny strony. Gdy uruchomisz sprawdzanie linków, aplikacja jeden raz odpytuje adres każdego zapisanego linku, bez ładowania strony, aby zobaczyć, czy nadal się otwiera; adresy na Twoim komputerze lub w sieci lokalnej nie są odpytywane. Nic nie jest wysyłane do twórcy samo z siebie: ani analityka, ani telemetria, ani raporty o awariach.

**Opinia, którą wysyłasz.** „Wyślij opinię” w aplikacji i formularz opinii na tej stronie wysyłają twórcy to, co napiszesz: rodzaj (błąd, pomysł lub pytanie), Twoją wiadomość i, jeśli go podasz, adres e-mail do odpowiedzi. Aplikacja dodaje swoją wersję, wersję systemu operacyjnego i język interfejsu, a tylko gdy zaznaczono „Dołącz raport” — raport pokazany w oknie przed wysłaniem: stan przechwytywania i, jeśli przechwytywanie nie działa, komunikat błędu systemu ze skróconą ścieżką folderu użytkownika, protokół i wersje rozszerzeń oraz kiedy każda przeglądarka pisała ostatnio; bez linków, tytułów, tagów i notatek. Nic nie opuszcza Twojego komputera, dopóki nie klikniesz „Wyślij”. Wiadomości są przechowywane w bazie Supabase w Unii Europejskiej (Frankfurt) do 12 miesięcy, a następnie usuwane. Twórca dostaje powiadomienie w Telegramie tylko z rodzajem, wersjami i długością wiadomości — bez jej treści, adresu e-mail i raportu. W ramach ochrony przed spamem funkcja przechowuje adres Twojego połączenia przez jeden dzień, tylko jako skrót z solą; Supabase, który utrzymuje bazę, prowadzi też krótkie logi techniczne żądań z tym adresem. Aby wiadomość została usunięta wcześniej, poproś o to przez „Pomoc” na tej stronie i podaj, mniej więcej kiedy ją wysłałeś.

**Ta strona.** koona.app/pin jest dostarczana przez Cloudflare. Cloudflare Web Analytics liczy wizyty na stronie bez plików cookie; serwer prowadzi krótkie logi dostępu do udostępnionych stron, bez Twojego adresu IP.

**Udostępnianie.** Twoje dane nie są sprzedawane, udostępniane ani przekazywane nikomu i nie są używane do niczego poza zapisywaniem i wyświetlaniem Twoich zakładek.

**Kontakt.** https://koona.app/pin/

---

## Українська

Koona Pin — застосунок для комп'ютера, який зберігає ваші закладки на вашому комп'ютері, і розширення для Chrome, Edge і Firefox, яке зберігає в нього сторінки. Облікового запису й хмари немає. Розробник ваших закладок не отримує; до нього потрапляє лише відгук, який ви надішлете самі.

**Що обробляє розширення.** Коли ви натискаєте кнопку Koona Pin, розширення читає адресу (URL) і заголовок поточної вкладки. Інші вкладки й вміст сторінок воно не читає. Одразу після натискання воно показує коротке повідомлення в куті цієї вкладки; повідомлення нічого не читає зі сторінки. Коли ви шукаєте посилання з розширення, набрані слова тим самим шляхом надходять до застосунку на цьому комп'ютері. Якщо ввімкнути «Показувати, що сторінку вже збережено», браузер попросить доступ до вкладок, і розширення передаватиме адресу кожної відкритої сторінки застосунку на цьому комп'ютері, щоб перевірити, чи є вона в бібліотеці; вимкнення повертає доступ.

**Куди це потрапляє.** Розширення передає адресу й заголовок застосунку Koona Pin на цьому ж комп'ютері через Native Messaging браузера. Поки застосунок не підтвердить посилання, воно чекає в локальному сховищі розширення у вашому браузері. Ще розширення зберігає час останнього збереження й результат останньої перевірки зв'язку із застосунком. Видалення розширення або профілю браузера видаляє ці дані.

**Що зберігає застосунок.** Застосунок зберігає закладки, колекції, теги й нотатки у файлі бібліотеки на вашому комп'ютері й робить його локальні резервні копії. Він запам'ятовує, з яких браузерів і коли зберігалися посилання, щоб показувати стан підключення.

**Мережеві запити.** Розширення їх не робить. Застосунок звертається до сайту збереженого посилання, щоб отримати заголовок, опис, прев'ю й значок; сайт бачить звичайний запит із вашого комп'ютера. Якщо в сайту немає значка, застосунок запитує його в сервісу значків Google і передає йому доменне ім'я сайту. Коли ви запускаєте перевірку посилань, застосунок один раз запитує адресу кожного збереженого посилання, не завантажуючи сторінку, щоб дізнатися, чи відкривається вона; адреси на вашому комп'ютері й у локальній мережі не запитуються. Самі по собі розробникові нічого не надсилається: ні аналітики, ні телеметрії, ні звітів про збої.

**Відгук, який ви надсилаєте.** «Надіслати відгук» у застосунку й форма відгуку на цьому сайті передають розробникові те, що ви напишете: тип (помилка, ідея чи запитання), повідомлення й, якщо вкажете, пошту для відповіді. Застосунок додає свою версію, версію операційної системи й мову інтерфейсу, а якщо позначено «Додати звіт» — звіт, який показується у вікні до надсилання: стан захоплення й, якщо захоплення не працює, текст помилки системи зі скороченим шляхом до теки користувача, протокол і версії розширень і коли кожен браузер писав востаннє; без посилань, назв, тегів і нотаток. З комп'ютера нічого не надходить, доки ви не натиснете «Надіслати». Повідомлення зберігаються в базі Supabase в Євросоюзі (Франкфурт) до 12 місяців і потім видаляються. Розробник отримує сповіщення в Telegram лише з типом, версіями й довжиною повідомлення — без його тексту, пошти й звіту. Для захисту від спаму функція зберігає адресу вашого підключення добу й лише як хеш із сіллю; Supabase, де розміщено базу, також веде короткі технічні журнали запитів із цією адресою. Щоб видалити повідомлення раніше, напишіть через «Підтримку» на цьому сайті й укажіть, коли приблизно його надіслали.

**Цей сайт.** koona.app/pin доставляє Cloudflare. Cloudflare Web Analytics рахує відвідування сайту без cookies; сервер веде короткі журнали відданих сторінок без вашої IP-адреси.

**Передавання.** Ваші дані не продаються, не передаються й не використовуються ні для чого, крім збереження й показу ваших закладок.

**Зв'язок.** https://koona.app/pin/

---

## Türkçe

Koona Pin, yer işaretlerinizi bilgisayarınızda tutan bir masaüstü uygulaması ve sayfaları ona kaydeden Chrome, Edge ve Firefox uzantısıdır. Hesap ve bulut yoktur. Geliştirici yer işaretlerinizi almaz; ona yalnızca sizin göndermeyi seçtiğiniz geri bildirim ulaşır.

**Uzantının işlediği veriler.** Koona Pin düğmesine tıkladığınızda uzantı, geçerli sekmenin adresini (URL) ve başlığını okur. Başka sekmeleri ve sayfa içeriğini okumaz. Tıklamadan hemen sonra o sekmenin köşesinde kısa bir bildirim gösterir; bildirim sayfadan hiçbir şey okumaz. Uzantıdan bağlantılarınızda arama yaptığınızda yazdığınız sözcükler aynı yoldan bu bilgisayardaki uygulamaya gider. “Bir sayfanın zaten kayıtlı olduğunu göster” seçeneğini açarsanız tarayıcı sekmelerinize erişim ister ve uzantı, açtığınız her sayfanın adresini kitaplığınızda olup olmadığını denetlemek için bu bilgisayardaki uygulamaya gönderir; kapatmak bu erişimi geri verir.

**Nereye gider.** Uzantı adresi ve başlığı, tarayıcının Native Messaging özelliğiyle aynı bilgisayardaki Koona Pin uygulamasına iletir. Uygulama bir bağlantıyı onaylayana kadar bağlantı, tarayıcınızdaki uzantının yerel depolamasında bekler. Uzantı ayrıca son kaydetme zamanını ve uygulamayı son denetlemesinin sonucunu saklar. Uzantıyı veya tarayıcı profilini kaldırmak bu verileri siler.

**Uygulamanın sakladıkları.** Uygulama yer işaretlerinizi, koleksiyonlarınızı, etiketlerinizi ve notlarınızı bilgisayarınızdaki bir kitaplık dosyasında saklar ve bu dosyanın yerel yedeklerini alır. Bağlantı durumunu göstermek için hangi tarayıcıların ne zaman bağlantı kaydettiğini not eder.

**Ağ istekleri.** Uzantı hiç istek yapmaz. Uygulama, kaydettiğiniz bir bağlantının başlığını, açıklamasını, önizleme görselini ve simgesini okumak için o web sitesine bağlanır; o site bilgisayarınızdan gelen sıradan bir istek görür. Bir sitenin simgesi yoksa uygulama bunu Google'ın favicon hizmetinden ister ve ona sitenin alan adını gönderir. Bir bağlantı denetimi başlattığınızda uygulama, hâlâ açılıp açılmadığını görmek için her kayıtlı bağlantının adresini sayfayı yüklemeden bir kez ister; bilgisayarınızdaki veya yerel ağınızdaki adresler istenmez. Geliştiriciye kendiliğinden hiçbir şey gönderilmez: analiz verisi, telemetri veya çökme raporu yoktur.

**Gönderdiğiniz geri bildirim.** Uygulamadaki “Geri bildirim gönder” ve bu sitedeki geri bildirim formu, yazdıklarınızı geliştiriciye gönderir: tür (hata, fikir veya soru), mesajınız ve verirseniz yanıt için bir e-posta adresi. Uygulama kendi sürümünü, işletim sistemi sürümünü ve arayüz dilini ekler; yalnızca “Rapor ekle” işaretliyse göndermeden önce pencerede gösterilen raporu da ekler: yakalama durumu ve yakalama çalışmıyorsa kullanıcı klasörü kısaltılmış sistem hata mesajı, uzantıların protokolü ve sürümleri ve her tarayıcının en son ne zaman yazdığı; bağlantı, başlık, etiket veya not yoktur. Gönder'e basana kadar bilgisayarınızdan hiçbir şey çıkmaz. Mesajlar Avrupa Birliği'ndeki (Frankfurt) bir Supabase veritabanında 12 aya kadar saklanır ve sonra silinir. Geliştirici yalnızca türü, sürümleri ve mesajın uzunluğunu içeren bir Telegram bildirimi alır — metni, e-posta adresini veya raporu değil. İstenmeyen iletilere karşı işlev, bağlantınızın adresini bir gün boyunca yalnızca tuzlanmış bir özet olarak saklar; veritabanını barındıran Supabase de bu adresle isteklerin kısa teknik kayıtlarını tutar. Bir mesajın daha erken silinmesi için bu sitedeki Destek üzerinden isteyin ve yaklaşık ne zaman gönderdiğinizi belirtin.

**Bu web sitesi.** koona.app/pin, Cloudflare üzerinden sunulur. Cloudflare Web Analytics site ziyaretlerini çerez kullanmadan sayar; sunucu, sunulan sayfaların kısa erişim kayıtlarını IP adresiniz olmadan tutar.

**Paylaşım.** Verileriniz satılmaz, paylaşılmaz veya kimseye aktarılmaz ve yer işaretlerinizi kaydedip göstermek dışında hiçbir şey için kullanılmaz.

**İletişim.** https://koona.app/pin/
