import { useTranslation } from "react-i18next";
import { Collection } from "../../types";
import { TreeNode } from "../../services/collectionTree";
import { CollectionIcon } from "../ui/CollectionIcon";

/**
 * Under the title of a collection with children (2.19.0, frame N1): a chip
 * for each child with its total, a click opens it; on the right «Only this
 * collection» leaves out what is inside the children.
 */
export function CollectionHeader({
  node,
  only,
  onOnly,
  onOpen,
}: {
  node: TreeNode<Collection>;
  only: boolean;
  onOnly: (only: boolean) => void;
  onOpen: (id: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div data-collection-header className="flex items-start gap-3">
      <nav aria-label={t("library.insideCollection", { name: node.item.name })} className="flex min-w-0 flex-1 flex-wrap gap-1.5">
        {node.children.map((child) => (
          <button
            key={child.item.id}
            type="button"
            onClick={() => onOpen(child.item.id)}
            className="flex h-[27px] max-w-[220px] items-center gap-1.5 rounded-md border border-border bg-card px-2 text-sm text-ink transition-colors duration-150 hover:bg-hover"
          >
            <CollectionIcon collection={child.item} size={14} />
            <span className="truncate">{child.item.name}</span>
            <span className="text-xs text-subtle">{child.total}</span>
          </button>
        ))}
      </nav>
      <label className="flex h-[27px] shrink-0 cursor-default items-center gap-2 text-sm text-muted">
        <input type="checkbox" checked={only} onChange={(e) => onOnly(e.target.checked)} className="size-4 shrink-0 accent-accent" />
        {t("library.onlyCollection")}
      </label>
    </div>
  );
}
