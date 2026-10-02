import { PreviewKind } from "./data";

/** Local, deterministic study artwork, not captured previews of the linked websites. */
export function Preview({ kind }: { kind: PreviewKind }) {
  return (
    <div className={`study-preview study-preview--${kind}`} aria-hidden="true">
      {kind === "rams" && (
        <>
          <span className="poster-caption">DIETER RAMS / 1976</span>
          <strong>
            Less,
            <br />
            but better.
          </strong>
          <span className="poster-number">10</span>
        </>
      )}
      {kind === "architecture" && (
        <>
          <div className="architect-wall" />
          <div className="architect-door" />
          <div className="architect-floor" />
          <span className="poster-caption">SPACE / LIGHT / FORM</span>
        </>
      )}
      {kind === "type" && (
        <>
          <span className="poster-caption">КИРИЛЛИЦА · ЛАТИНИЦА</span>
          <strong>Аа</strong>
          <span className="type-sample">Бб Вв Гг Дд Ее Жж</span>
        </>
      )}
      {kind === "code" && (
        <>
          <span className="poster-caption">CRAFTED WITH INTENTION</span>
          <div className="mini-interface">
            <div className="mini-rail" />
            <div className="mini-content">
              <i />
              <i />
              <i />
              <i />
            </div>
          </div>
          <span className="poster-caption code-caption">
            Small details. Big difference.
          </span>
        </>
      )}
      {kind === "photo" && (
        <>
          <div className="photo-shadow" />
          <div className="photo-vase" />
          <div className="photo-branch" />
          <div className="photo-table" />
          <span className="poster-caption">THE ART OF NOTICING</span>
        </>
      )}
      {kind === "article" && (
        <>
          <span className="poster-caption">ЗАМЕТКИ НА ПОЛЯХ</span>
          <div className="article-lines">
            <span />
            <span />
            <span />
            <span />
          </div>
          <strong>
            Внимание —<br />
            это выбор.
          </strong>
        </>
      )}
    </div>
  );
}
