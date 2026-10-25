import { ancestors, findNode, type TreeItem, type TreeNode } from "../../../services/collectionTree";

/**
 * The Library's two chip rows for a chosen collection (2.19.0, N8). Row 1 holds the top-level
 * collections, the chosen one's top-level branch marked; row 2 shows the level under the chosen
 * collection — "All" of it and its children — or, for a collection with no children, its
 * parent's level with the collection among its siblings. Going deeper replaces row 2 with the
 * next collection's children; the way back is the row above (the branch) or "All" of the parent.
 */
export function chipRows<T extends TreeItem>(roots: readonly TreeNode<T>[], chosen: number | null): { branch: number | null; parent: TreeNode<T> | undefined } {
  const node = chosen === null ? undefined : findNode(roots, chosen);
  if (!node) return { branch: null, parent: undefined };
  const path = ancestors(roots, node.item.id);
  const branch = path[0]?.id ?? node.item.id;
  if (node.children.length > 0) return { branch, parent: node };
  const up = path.at(-1);
  return { branch, parent: up ? findNode(roots, up.id) : undefined };
}
