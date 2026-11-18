/** When something happened, for «… today at 14:05» or «… on 3 October at 14:05». */
export function moment(iso: string, language: string) {
  const at = new Date(iso);
  return {
    today: at.toDateString() === new Date().toDateString(),
    time: at.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" }),
    date: at.toLocaleDateString(language, { day: "numeric", month: "long" }),
  };
}
