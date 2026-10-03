// Collection colours of iteration 1 (doc/guidelines.md, «Цвет»). Old
// libraries keep colours of «Редакция» in the database; the interface picks
// from the new palette by id so a collection keeps its colour.
const palette = ["terracotta", "green", "blue", "ochre", "lilac"] as const;

export const collectionColor = (id: number) =>
  `var(--np-${palette[(Math.abs(id) - 1 + palette.length) % palette.length]})`;
