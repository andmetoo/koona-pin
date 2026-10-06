// Texts of koona.app/pin, English and Russian, as in landing.sketch (doc/site.md).
import { existsSync } from "node:fs";

// KOONAPIN_FEEDBACK_URL below: from the environment or from .env in the repository root
// (.env.example), for site:build, site:check and deploy-site.ps1 alike. The environment wins.
const dotenv = new URL("../../.env", import.meta.url);
if (existsSync(dotenv)) process.loadEnvFile(dotenv);

export const content = {
  en: {
    lang: "en",
    title: "Koona Pin — bookmarks for Windows, saved in one click",
    description:
      "A bookmark library for Windows. Save pages from Chrome, Edge and Firefox with one button; they stay on your computer. No account, no cloud.",
    nav: { how: "How it works", privacy: "Privacy", download: "Download" },
    langSwitch: "Language",
    h1: ["Save a link in one click.", "Find it when you need it."],
    sub: "Koona Pin is a bookmark library for Windows. Pages arrive from Chrome, Edge and Firefox with one button and stay on your computer. No account, no cloud.",
    soon: "Windows beta — coming soon",
    how: "How it works",
    meta: ["Windows 11", "Chrome, Edge, Firefox", "Free"],
    shotAlt: "Koona Pin with eight bookmarks in a grid: previews, sites, titles, collections and tags in the sidebar, two new bookmarks waiting in Inbox.",
    listAlt: "The same library as a list grouped by date, with tags, collections and dates.",
    pillars: [
      ["One button", "Click it on any page and the link is saved — even when the app is closed."],
      ["On your computer", "The library is a file on your disk, with automatic backups. Works offline."],
      ["No account", "Nothing to sign up for. The developer never sees your links."],
    ],
    howTitle: "How it works",
    steps: [
      ["Install the app", "Koona Pin for Windows starts with the system and waits in the tray."],
      ["Add the extension", "Chrome, Edge or Firefox. It talks only to the app on your computer."],
      ["Click the button", "The page lands in Inbox. Sort it later — it takes about a minute."],
    ],
    insideTitle: "Find it, sort it, keep it",
    inside: [
      ["Sort the inbox from the keyboard", "Keep, file or toss — one key each."],
      ["Search titles, sites and tags", "Results while you type, Ctrl K from anywhere."],
      ["Collections and tags", "Group links the way you think about them."],
      ["Trash keeps links for 30 days", "Delete without fear, restore in one click."],
      ["Import and export", "Bring bookmarks from your browser, take them out as HTML, JSON or CSV."],
    ],
    browsersTitle: "Works with your browser",
    browsers: ["Chrome 120+", "Edge 120+", "Firefox 140+"],
    privacyTitle: "Your links stay with you",
    privacyBody: "Koona Pin keeps your library on your computer: no server ever sees your links. Only feedback you choose to send reaches the developer.",
    privacyFacts: [
      "The extension reads only the address and title of the tab you save.",
      "The app sends no analytics, telemetry or crash reports.",
      "No account and no cloud.",
    ],
    privacyLink: "Read the privacy policy",
    dlTitle: "Windows beta is on its way",
    dlBody: "The installer and the browser extensions will be published here.",
    req: [
      ["Windows 11, 64-bit", "No administrator rights needed"],
      ["Chrome or Edge 120+, Firefox 140+", "Current release or ESR 140"],
    ],
    footer: { privacy: "Privacy", licenses: "Licenses", support: "Support" },
    back: "Koona Pin",
    privacyPage: { title: "Privacy policy", updated: "Last updated 6 October 2026", section: "English" },
    licenses: {
      title: "Licenses",
      lead: "What this site is made of and under which terms.",
      items: [
        ["Inter", "Text typeface. SIL Open Font License 1.1.", "https://github.com/rsms/inter"],
        ["Nunito", "The wordmark, shipped as outlines. SIL Open Font License 1.1.", "https://github.com/googlefonts/nunito"],
        ["Lucide", "Icons. ISC License.", "https://lucide.dev/license"],
        ["Photos in the screenshots", "Bookmark previews from Unsplash under the Unsplash License, by Teddy GR, Vishnu Mohanan, Chris Ried, Milad Fakurian, Jordan Harrison, Bennie Bates and Anders Jildén.", "https://unsplash.com/license"],
      ],
      app: "The licenses of the app and its components ship with the app.",
    },
    notFound: { title: "Page not found", body: "This address doesn't lead anywhere on the site.", home: "Go to the home page" },
    feedback: {
      title: "Send feedback",
      lead: "Found a bug, have an idea or a question? Write to the developer.",
      kind: "Type",
      kinds: { bug: "Bug", idea: "Idea", question: "Question" },
      message: "Message",
      placeholder: "What happened, or what would you like?",
      email: "Email for a reply (optional)",
      trap: "Leave this field empty",
      send: "Send",
      note: "Stored in the EU for up to 12 months.",
      privacy: "Privacy policy",
      app: "In the app it is quicker: Settings → Support → Send feedback adds the versions for you.",
      github: "Prefer to report in public? Issues on GitHub",
      again: "Write a new message",
      sent: { title: "Sent. Thank you!", body: "The developer reads every message. If you left an email, the reply will come there." },
      limit: { title: "Too many messages", body: "Too many messages from this network in the last hour. Try again later: your browser's Back button returns to the form with your text." },
      long: { title: "Message too long", body: "A message can be from 1 to 5000 characters. Your browser's Back button returns to the form with your text — shorten it and send it again." },
      origin: { title: "Couldn't send", body: "The browser did not say which site the form came from, so the message was not accepted. This happens with strict privacy settings or extensions that hide the referrer: allow it for koona.app/pin and send again with the browser's Back button, or report on GitHub." },
      error: { title: "Couldn't send", body: "The message didn't go through. Your browser's Back button returns to the form with your text: try again, or report it on GitHub." },
    },
    skip: "Skip to content",
  },
  ru: {
    lang: "ru",
    title: "Koona Pin — закладки для Windows одной кнопкой",
    description:
      "Библиотека закладок для Windows. Сохраняйте страницы из Chrome, Edge и Firefox одной кнопкой — они остаются на вашем компьютере. Без аккаунта и облака.",
    nav: { how: "Как это работает", privacy: "Приватность", download: "Скачать" },
    langSwitch: "Язык",
    h1: ["Сохраняйте ссылки одной кнопкой.", "Находите, когда понадобятся."],
    sub: "Koona Pin — библиотека закладок для Windows. Страницы попадают в неё из Chrome, Edge и Firefox одной кнопкой и остаются на вашем компьютере. Без аккаунта и облака.",
    soon: "Windows-beta — скоро",
    how: "Как это работает",
    meta: ["Windows 11", "Chrome, Edge, Firefox", "Бесплатно"],
    shotAlt: "Koona Pin с восемью закладками сеткой: превью, сайты, заголовки, коллекции и теги в боковой панели, две новые закладки ждут во «Входящих».",
    listAlt: "Та же библиотека списком по датам, с тегами, коллекциями и датами.",
    pillars: [
      ["Одна кнопка", "Нажмите на любой странице — ссылка сохранится, даже если приложение закрыто."],
      ["На вашем компьютере", "Библиотека — файл на вашем диске, с автоматическими копиями. Работает без сети."],
      ["Без аккаунта", "Регистрироваться не нужно. Разработчик не видит ваших ссылок."],
    ],
    howTitle: "Как это работает",
    steps: [
      ["Установите приложение", "Koona Pin для Windows запускается вместе с системой и ждёт в трее."],
      ["Добавьте расширение", "Chrome, Edge или Firefox. Оно общается только с приложением на вашем компьютере."],
      ["Нажмите кнопку", "Страница попадёт во «Входящие». Разберите потом — это займёт около минуты."],
    ],
    insideTitle: "Найти, разобрать, сохранить",
    inside: [
      ["Разбор входящих с клавиатуры", "Оставить, разложить или выбросить — одна клавиша."],
      ["Поиск по названию, сайту и тегам", "Результаты по мере ввода, Ctrl K откуда угодно."],
      ["Коллекции и теги", "Группируйте ссылки так, как вы о них думаете."],
      ["Корзина хранит ссылки 30 дней", "Удаляйте без страха, восстанавливайте одним щелчком."],
      ["Импорт и экспорт", "Перенесите закладки из браузера, заберите их в HTML, JSON или CSV."],
    ],
    browsersTitle: "Работает с вашим браузером",
    browsers: ["Chrome 120+", "Edge 120+", "Firefox 140+"],
    privacyTitle: "Ваши ссылки остаются у вас",
    privacyBody: "Koona Pin хранит библиотеку на вашем компьютере: ваши ссылки не видит ни один сервер. Разработчику уходит только отзыв, который вы отправите сами.",
    privacyFacts: [
      "Расширение читает только адрес и заголовок сохраняемой вкладки.",
      "Приложение не отправляет аналитику, телеметрию и отчёты о сбоях.",
      "Ни аккаунта, ни облака.",
    ],
    privacyLink: "Политика конфиденциальности",
    dlTitle: "Windows-beta уже в пути",
    dlBody: "Установщик и расширения для браузеров появятся здесь.",
    req: [
      ["Windows 11, 64 бит", "Права администратора не нужны"],
      ["Chrome или Edge 120+, Firefox 140+", "Текущий релиз или ESR 140"],
    ],
    footer: { privacy: "Приватность", licenses: "Лицензии", support: "Поддержка" },
    back: "Koona Pin",
    privacyPage: { title: "Политика конфиденциальности", updated: "Обновлено 6 октября 2026 года", section: "Русский" },
    licenses: {
      title: "Лицензии",
      lead: "Из чего сделан этот сайт и на каких условиях.",
      items: [
        ["Inter", "Шрифт текста. SIL Open Font License 1.1.", "https://github.com/rsms/inter"],
        ["Nunito", "Надпись-логотип, кривыми. SIL Open Font License 1.1.", "https://github.com/googlefonts/nunito"],
        ["Lucide", "Иконки. Лицензия ISC.", "https://lucide.dev/license"],
        ["Фото на скриншотах", "Превью закладок с Unsplash по лицензии Unsplash; авторы — Teddy GR, Vishnu Mohanan, Chris Ried, Milad Fakurian, Jordan Harrison, Bennie Bates и Anders Jildén.", "https://unsplash.com/license"],
      ],
      app: "Лицензии приложения и его компонентов поставляются вместе с приложением.",
    },
    notFound: { title: "Страница не найдена", body: "По этому адресу на сайте ничего нет.", home: "На главную" },
    feedback: {
      title: "Отправить отзыв",
      lead: "Нашли ошибку, есть идея или вопрос? Напишите разработчику.",
      kind: "Тип",
      kinds: { bug: "Ошибка", idea: "Идея", question: "Вопрос" },
      message: "Сообщение",
      placeholder: "Что случилось или чего не хватает?",
      email: "Почта для ответа (необязательно)",
      trap: "Оставьте это поле пустым",
      send: "Отправить",
      note: "Хранится в ЕС до 12 месяцев.",
      privacy: "Политика конфиденциальности",
      app: "Из приложения быстрее: «Настройки» → «Поддержка» → «Отправить отзыв» само добавит версии.",
      github: "Хотите сообщить публично? Issues на GitHub",
      again: "Написать новое сообщение",
      sent: { title: "Отправлено. Спасибо!", body: "Разработчик читает каждое сообщение. Если вы оставили почту, ответ придёт туда." },
      limit: { title: "Слишком много сообщений", body: "Слишком много сообщений из этой сети за последний час. Повторите позже: кнопка «Назад» браузера вернёт форму с вашим текстом." },
      long: { title: "Слишком длинное сообщение", body: "В сообщении может быть от 1 до 5000 символов. Кнопка «Назад» браузера вернёт форму с вашим текстом — сократите его и отправьте снова." },
      origin: { title: "Не отправилось", body: "Браузер не сообщил, с какого сайта пришла форма, поэтому сообщение не принято. Так бывает со строгими настройками приватности или расширениями, которые скрывают источник перехода: разрешите его для koona.app/pin и отправьте снова кнопкой «Назад» браузера или сообщите на GitHub." },
      error: { title: "Не отправилось", body: "Сообщение не дошло. Кнопка «Назад» браузера вернёт форму с вашим текстом: повторите или сообщите на GitHub." },
    },
    skip: "Перейти к содержимому",
  },
};

export const SUPPORT = "https://github.com/andmetoo/koona-pin/issues/new/choose";
// The Edge Function `feedback` (NP-088): the site form posts here. Without it the
// build leaves the form out and «Support» keeps pointing at GitHub.
export const FEEDBACK_ENDPOINT = process.env.KOONAPIN_FEEDBACK_URL || "";
export const ORIGIN = "https://koona.app";
// Every app of koona.app is a path of it (Р-47): pages, assets and redirects of this site are under BASE.
export const BASE = "/pin";
export const SITE = `${ORIGIN}${BASE}`;
