export type PreviewKind =
  "rams" | "architecture" | "type" | "code" | "photo" | "article";
export interface ConceptBookmark {
  id: number;
  title: string;
  description: string;
  domain: string;
  url: string;
  collection: string;
  tags: string[];
  date: string;
  favorite: boolean;
  preview: PreviewKind;
  notes: string;
}

export const seedBookmarks: ConceptBookmark[] = [
  {
    id: 1,
    title: "Десять принципов хорошего дизайна",
    description:
      "Дитер Рамс о вещах, которые остаются нужными. Меньше, но лучше.",
    domain: "vitsoe.com",
    url: "https://www.vitsoe.com/rw/about/good-design",
    collection: "Дизайн",
    tags: ["дизайн", "принципы"],
    date: "Сегодня",
    favorite: true,
    preview: "rams",
    notes: "Перечитать перед следующим проектом.",
  },
  {
    id: 2,
    title: "Архитектура тишины",
    description:
      "Пространство, свет и материалы. Подборка архитектуры, в которой хочется задержаться.",
    domain: "archdaily.com",
    url: "https://www.archdaily.com/",
    collection: "Вдохновение",
    tags: ["архитектура", "пространство"],
    date: "Сегодня",
    favorite: false,
    preview: "architecture",
    notes: "",
  },
  {
    id: 3,
    title: "Типографика — это голос",
    description: "Как шрифт, ритм и расстояние меняют восприятие текста.",
    domain: "type.today",
    url: "https://type.today/ru",
    collection: "Дизайн",
    tags: ["типографика", "интерфейсы"],
    date: "Вчера",
    favorite: true,
    preview: "type",
    notes: "",
  },
  {
    id: 4,
    title: "Интерфейсы, которые не мешают",
    description:
      "Небольшие детали, из которых складывается удобный цифровой инструмент.",
    domain: "linear.app",
    url: "https://linear.app/now",
    collection: "Разработка",
    tags: ["интерфейсы", "продукт"],
    date: "Вчера",
    favorite: false,
    preview: "code",
    notes: "",
  },
  {
    id: 5,
    title: "Наблюдать повседневное",
    description:
      "Свет на стене, утренний стол, случайная композиция. Коллекция фотографий.",
    domain: "unsplash.com",
    url: "https://unsplash.com/",
    collection: "Вдохновение",
    tags: ["фотография"],
    date: "28 сентября",
    favorite: false,
    preview: "photo",
    notes: "",
  },
  {
    id: 6,
    title: "Заметки о внимании",
    description:
      "Почему важно оставлять место для мыслей и собирать только то, к чему хочется вернуться.",
    domain: "are.na",
    url: "https://www.are.na/",
    collection: "Прочитать",
    tags: ["эссе", "внимание"],
    date: "27 сентября",
    favorite: false,
    preview: "article",
    notes: "",
  },
];

export const collectionNames = [
  "Дизайн",
  "Разработка",
  "Вдохновение",
  "Прочитать",
];
