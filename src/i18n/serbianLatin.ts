// Serbian Latin is not translated: it is the Cyrillic file letter by letter
// (NP-089). `npm run locales:sr-latn` writes sr-Latn.json; a test keeps it in step.

const letters: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", ђ: "đ", е: "e", ж: "ž", з: "z", и: "i",
  ј: "j", к: "k", л: "l", љ: "lj", м: "m", н: "n", њ: "nj", о: "o", п: "p", р: "r",
  с: "s", т: "t", ћ: "ć", у: "u", ф: "f", х: "h", ц: "c", ч: "č", џ: "dž", ш: "š",
};

const isUpper = (c: string | undefined) => !!c && c !== c.toLowerCase();
const isLower = (c: string | undefined) => !!c && c !== c.toUpperCase();

/** One text in Latin letters: «Љубав» → «Ljubav», «ЉУБАВ» → «LJUBAV». */
export function toLatin(text: string): string {
  const chars = Array.from(text);
  return chars
    .map((c, i) => {
      const latin = letters[c.toLowerCase()];
      if (latin === undefined) return c;
      if (!isUpper(c)) return latin;
      // A capital digraph is «Lj» in a word and «LJ» in a word of capitals.
      const shouting =
        latin.length > 1 && (isUpper(chars[i + 1]) || (isUpper(chars[i - 1]) && !isLower(chars[i + 1])));
      return shouting ? latin.toUpperCase() : latin[0].toUpperCase() + latin.slice(1);
    })
    .join("");
}

type Catalog = { [key: string]: string | Catalog };

/** The whole catalog in Latin letters; the language names itself in Latin. */
export function latinCatalog(cyrillic: Catalog): Catalog {
  const walk = (node: Catalog): Catalog =>
    Object.fromEntries(
      Object.entries(node).map(([key, value]) => [key, typeof value === "string" ? toLatin(value) : walk(value)]),
    );
  return { ...walk(cyrillic), language: { name: "Srpski (latinica)" } };
}
