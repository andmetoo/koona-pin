import type { CSSProperties } from "react";
import { COLLECTION_GLYPHS } from "../../../components/ui/CollectionIcon";
import { collectionTint, iconKind } from "../../../services/collections";
import { PhIcon } from "./icons";

/**
 * A collection's mark (2.19.0): its Lucide icon in its colour, its emoji, or the dot. The glyphs
 * are the desktop's (`CollectionIcon`); the colour goes on `--dot`, so the chip and the row can
 * recolour the glyph (an active chip draws it in ink).
 */
export function CollectionGlyph({ collection, size = 16 }: { collection: { id: number; color: string | null; icon: string | null }; size?: number }) {
  const kind = iconKind(collection.icon);
  const style = { "--dot": collectionTint(collection) } as CSSProperties;
  if (kind?.kind === "lucide") return <PhIcon icon={COLLECTION_GLYPHS[kind.name]} size={size} strokeWidth={1.5} className="ph-glyph" style={style} />;
  if (kind?.kind === "emoji")
    return (
      <span className="ph-glyph ph-glyph-emoji" style={{ ...style, fontSize: size - 2 }} aria-hidden="true">
        {kind.text}
      </span>
    );
  return <span className="ph-chip-dot" style={style} aria-hidden="true" />;
}
