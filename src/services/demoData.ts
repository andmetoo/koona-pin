// Sample library of the browser preview. Previews are generated here, not
// copies of the linked sites.

export interface DemoBookmark {
  id: number;
  title: string;
  description: string;
  domain: string;
  url: string;
  collection: string;
  tags: string[];
  favorite: boolean;
  /** Still waits in the inbox (NP-021). */
  inbox?: boolean;
  notes: string;
  /** Two colours and a word for the generated preview. */
  poster: [string, string, string];
}

const poster = ([from, to, word]: [string, string, string]) =>
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="320" height="200" fill="url(#g)"/><text x="24" y="172" font-family="Inter, sans-serif" font-size="34" font-weight="600" fill="#fffefa" fill-opacity="0.9">${word}</text></svg>`,
  );

export const demoBookmarks: DemoBookmark[] = [
  {
    id: 1,
    title: "Десять принципов хорошего дизайна",
    description: "Дитер Рамс о вещах, которые остаются нужными. Меньше, но лучше.",
    domain: "vitsoe.com",
    url: "https://www.vitsoe.com/rw/about/good-design",
    collection: "Дизайн",
    tags: ["дизайн", "принципы"],
    favorite: true,
    notes: "Перечитать перед следующим проектом.",
    poster: ["#c9785a", "#8a4a35", "Less, but better"],
  },
  {
    id: 2,
    title: "Архитектура тишины",
    description: "Пространство, свет и материалы. Подборка архитектуры, в которой хочется задержаться.",
    domain: "archdaily.com",
    url: "https://www.archdaily.com/",
    collection: "Вдохновение",
    tags: ["архитектура", "пространство"],
    favorite: false,
    inbox: true,
    notes: "",
    poster: ["#b8b6ab", "#5f6057", "Space · Light"],
  },
  {
    id: 3,
    title: "Типографика — это голос",
    description: "Как шрифт, ритм и расстояние меняют восприятие текста.",
    domain: "type.today",
    url: "https://type.today/ru",
    collection: "Дизайн",
    tags: ["типографика", "интерфейсы"],
    favorite: true,
    notes: "",
    poster: ["#2e302b", "#5c77a8", "Аа Бб Вв"],
  },
  {
    id: 4,
    title: "Интерфейсы, которые не мешают",
    description: "Небольшие детали, из которых складывается удобный цифровой инструмент.",
    domain: "linear.app",
    url: "https://linear.app/now",
    collection: "Разработка",
    tags: ["интерфейсы", "продукт"],
    favorite: false,
    notes: "",
    poster: ["#2f6b4f", "#1f4a36", "Small details"],
  },
  {
    id: 5,
    title: "Наблюдать повседневное",
    description: "Свет на стене, утренний стол, случайная композиция. Коллекция фотографий.",
    domain: "unsplash.com",
    url: "https://unsplash.com/",
    collection: "Вдохновение",
    tags: ["фотография"],
    favorite: false,
    inbox: true,
    notes: "",
    poster: ["#d4b862", "#b59a45", "Noticing"],
  },
  {
    id: 6,
    title: "Заметки о внимании",
    description: "Почему важно оставлять место для мыслей и собирать только то, к чему хочется вернуться.",
    domain: "are.na",
    url: "https://www.are.na/",
    collection: "Прочитать",
    tags: ["эссе", "внимание"],
    favorite: false,
    notes: "",
    poster: ["#8a6ba8", "#5c4a75", "Внимание"],
  },
];

export const demoCollections = ["Дизайн", "Разработка", "Вдохновение", "Прочитать"];

export const posterOf = (b: DemoBookmark) => poster(b.poster);
