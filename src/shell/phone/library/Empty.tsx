import type { ReactNode } from "react";
import { type LucideIcon, Plus } from "lucide-react";
import { PhIcon } from "../ui/icons";

/** An empty state on a shelf: an icon in a well, a title, a line and maybe an action. */
export function Empty({ icon = Plus, title, text, children }: { icon?: LucideIcon; title: string; text?: string; children?: ReactNode }) {
  return (
    <section className="lib-empty" data-empty>
      <span className="lib-empty-icon">
        <PhIcon icon={icon} />
      </span>
      <h2 className="ph-title2">{title}</h2>
      {text && <p className="ph-subhead lib-empty-text">{text}</p>}
      {children && <div className="lib-empty-actions">{children}</div>}
    </section>
  );
}
