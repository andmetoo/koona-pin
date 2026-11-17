/**
 * Settings → Storage → «Cleaned tag names»: a tag's old name as text a person can read. What the
 * cleaning took out of it (`db::tag_name`) is nothing anyone sees, so each such character is shown
 * by its code, `co`+U+00AD+`op`, and so is any other one that would not show or would turn the line
 * around (a control, a format or bidi character, a space other than the plain one). Inside an emoji
 * the joiner and the variation selectors are part of what is seen and stay as they are.
 */
export type NamePart = { text: string } | { code: string };

const UNSEEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]|(?! )\p{Zs}/u;
const EMOJI = /\p{Extended_Pictographic}/u;
const EMOJI_GLUE = /[\u{200D}\u{FE0E}\u{FE0F}]/u;

/** «U+00AD», «U+E0041». */
export const codeOf = (char: string) => `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

const graphemes = (text: string): string[] =>
  typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((s) => s.segment)
    : [text];

/** The name in runs of visible text and single characters shown by their code. */
export function visibleName(name: string): NamePart[] {
  const parts: NamePart[] = [];
  const add = (text: string) => {
    const last = parts[parts.length - 1];
    if (last && "text" in last) last.text += text;
    else parts.push({ text });
  };
  for (const grapheme of graphemes(name)) {
    const emoji = EMOJI.test(grapheme);
    for (const char of grapheme) {
      if (UNSEEN.test(char) && !(emoji && EMOJI_GLUE.test(char))) parts.push({ code: codeOf(char) });
      else add(char);
    }
  }
  return parts;
}
