import { OpenFailure } from "../types";

// Strings of the library screens in both interface languages (Р-8). They move
// into the shared localization of NP-010 when it exists.
type Language = "ru" | "en";
export const language = (): Language =>
  typeof navigator !== "undefined" &&
  navigator.language.toLowerCase().startsWith("ru")
    ? "ru"
    : "en";

type Text = (f: OpenFailure) => string;
interface Failure {
  title: string;
  body: Text;
  retry: boolean;
  /** Which folder the second button opens. */
  place: "data" | "backup";
}

const failures: Record<Language, Record<OpenFailure["code"], Failure>> = {
  ru: {
    DB_LOCKED: {
      title: "Библиотека занята другой программой",
      body: () =>
        "Файл библиотеки открыт другой программой. Netami Pin ничего в него не записал — данные в том виде, в каком были. Закройте ту программу и нажмите «Повторить».",
      retry: true,
      place: "data",
    },
    DB_NEWER_SCHEMA: {
      title: "Библиотеку обновила более новая версия Netami Pin",
      body: (f) =>
        `Схема библиотеки — ${f.schema}, эта версия понимает схемы до ${f.supported}. Установите последнюю версию с pin.netami.app. Библиотека не изменена.`,
      retry: false,
      place: "data",
    },
    DB_FOREIGN: {
      title: "Это не библиотека Netami Pin",
      body: () =>
        "Файл создан другой программой. Netami Pin его не открывает и не изменяет. Уберите файл из папки с данными — при следующем запуске будет создана новая библиотека.",
      retry: true,
      place: "data",
    },
    DB_NOT_DATABASE: {
      title: "Файл библиотеки не читается",
      body: () =>
        "Файл повреждён или не является базой данных. Netami Pin его не изменяет. Замените его последней копией из папки backups и нажмите «Повторить».",
      retry: true,
      place: "data",
    },
    DB_CORRUPT: {
      title: "Библиотека повреждена",
      body: () =>
        "Проверка нашла ошибки в файле библиотеки. Чтобы не испортить данные сильнее, Netami Pin не обновляет и не изменяет его. Замените файл последней копией из папки backups и нажмите «Повторить».",
      retry: true,
      place: "data",
    },
    BACKUP_FAILED: {
      title: "Не удалось создать резервную копию перед обновлением библиотеки",
      body: (f) => `${f.detail}. Данные не изменены.`,
      retry: true,
      place: "data",
    },
    MIGRATION_FAILED: {
      title: "Не удалось обновить библиотеку",
      body: (f) =>
        `Данные не изменены.${f.backup ? ` Копия перед обновлением: ${f.backup}.` : ""} Приложение не работает с библиотекой, пока ошибка не исправлена: отправьте отчёт в поддержку.`,
      retry: false,
      place: "backup",
    },
    DB_OPEN_FAILED: {
      title: "Не удалось открыть библиотеку",
      body: (f) => `${f.detail}. Данные не изменены.`,
      retry: true,
      place: "data",
    },
  },
  en: {
    DB_LOCKED: {
      title: "The library is in use by another program",
      body: () =>
        "Another program has the library file open. Netami Pin has not written anything to it — your data is as it was. Close that program and click Try again.",
      retry: true,
      place: "data",
    },
    DB_NEWER_SCHEMA: {
      title: "A newer version of Netami Pin has updated this library",
      body: (f) =>
        `The library uses schema ${f.schema}; this version supports up to ${f.supported}. Install the latest version from pin.netami.app. The library has not been changed.`,
      retry: false,
      place: "data",
    },
    DB_FOREIGN: {
      title: "This is not a Netami Pin library",
      body: () =>
        "The file was created by another program. Netami Pin does not open or change it. Move the file out of the data folder and a new library will be created on the next start.",
      retry: true,
      place: "data",
    },
    DB_NOT_DATABASE: {
      title: "The library file cannot be read",
      body: () =>
        "The file is damaged or is not a database. Netami Pin does not change it. Replace it with the latest copy from the backups folder and click Try again.",
      retry: true,
      place: "data",
    },
    DB_CORRUPT: {
      title: "The library is damaged",
      body: () =>
        "The integrity check found errors in the library file. To avoid further damage, Netami Pin does not update or change it. Replace the file with the latest copy from the backups folder and click Try again.",
      retry: true,
      place: "data",
    },
    BACKUP_FAILED: {
      title: "Could not back up the library before updating it",
      body: (f) => `${f.detail}. Your data has not been changed.`,
      retry: true,
      place: "data",
    },
    MIGRATION_FAILED: {
      title: "Could not update the library",
      body: (f) =>
        `Your data has not been changed.${f.backup ? ` Copy made before the update: ${f.backup}.` : ""} The app does not use the library until the error is fixed: send the report to support.`,
      retry: false,
      place: "backup",
    },
    DB_OPEN_FAILED: {
      title: "Could not open the library",
      body: (f) => `${f.detail}. Your data has not been changed.`,
      retry: true,
      place: "data",
    },
  },
};

const labels = {
  ru: {
    opening: "Открываем библиотеку…",
    retry: "Повторить",
    data: "Открыть папку с данными",
    backup: "Открыть папку с копией",
    backups: "Открыть папку с копиями",
    report: "Скопировать отчёт",
    copied: "Отчёт скопирован",
    copyFailed: "Не удалось скопировать. Выделите текст отчёта вручную.",
    quit: "Выйти",
    ok: "Понятно",
    details: "Подробности",
    damaged:
      "Библиотека повреждена: проверка нашла ошибки в файле. Чтобы не испортить данные сильнее, изменения больше не сохраняются, а ссылки из браузера ждут в расширении. Закройте Netami Pin и замените файл последней резервной копией.",
    movedAside: (path: string) =>
      `Библиотека прежней тестовой сборки не подходит к новой схеме. Она сохранена как ${path}, создана новая библиотека.`,
  },
  en: {
    opening: "Opening the library…",
    retry: "Try again",
    data: "Open data folder",
    backup: "Open backup folder",
    backups: "Open backups folder",
    report: "Copy report",
    copied: "Report copied",
    copyFailed: "Could not copy. Select the report text manually.",
    quit: "Quit",
    ok: "Got it",
    details: "Details",
    damaged:
      "The library is damaged: the integrity check found errors in the file. To avoid further damage, changes are no longer saved and links from the browser wait in the extension. Quit Netami Pin and replace the file with the latest backup.",
    movedAside: (path: string) =>
      `The library of an earlier test build does not fit the new schema. It was kept as ${path} and a new library was created.`,
  },
};

export const failureText = (f: OpenFailure) => failures[language()][f.code];
export const libraryLabels = () => labels[language()];

/** Plain text for support; labels stay English so anyone can read them. */
export const failureReport = (f: OpenFailure) =>
  [
    `Netami Pin ${f.version}`,
    `Code: ${f.code}`,
    `Detail: ${f.detail}`,
    `Library: ${f.database}`,
    f.backup && `Backup: ${f.backup}`,
    f.schema !== null && `Schema: ${f.schema} (supported ${f.supported})`,
    `Language: ${typeof navigator !== "undefined" ? navigator.language : "-"}`,
  ]
    .filter(Boolean)
    .join("\n");
