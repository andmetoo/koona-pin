// An article with one picture, for the picture viewer's specs on the desktop and the phone (#400).

const grid = Array.from({ length: 16 }, (_, i) => `<line x1="${i * 100}" y1="0" x2="${i * 100}" y2="1000" stroke="#fff"/>`).join("");
export const PICTURE = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="#7f93a6"/>${grid}<circle cx="800" cy="500" r="220" fill="#f4e3c3"/></svg>`,
)}`;
export const ARTICLE = `<p>A paragraph before the picture, long enough to wrap onto a second line in the column.</p>
<figure><img src="${PICTURE}" alt="A test picture"><figcaption>The caption of the picture, shown under it in the viewer.</figcaption></figure>
<p>A paragraph after it.</p>`;
