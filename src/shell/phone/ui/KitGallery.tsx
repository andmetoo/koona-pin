import { type CSSProperties, type ReactNode, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Check, Grid2x2, Heart, List, Plus, Search, Settings, SquareArrowOutUpRight, Tag, Trash2, Undo2, X } from "lucide-react";
import "../../../styles/phone.css";
import { AccountCluster } from "./AccountCluster";
import { Button, CircleButton } from "./buttons";
import { Checkbox, Chip, Field, SearchField, Segmented, Toggle } from "./controls";
import { NavPill } from "./NavPill";
import { Progress } from "./Progress";
import { Header } from "./Screen";
import { Sheet } from "./Sheet";
import { Shelf, ShelfRow } from "./Shelf";
import { Snackbar } from "./Snackbar";

/**
 * The kit side by side with the Components style board (Lunacy y 3000, x 1480 light, x 4840 dark),
 * for review only: nothing in the app imports it. A Playwright test or the console mounts it over
 * a phone page with `(await import("/src/shell/phone/ui/KitGallery.tsx")).mountKitGallery()`. The
 * texts are the board's sample content, not interface strings.
 */
export function mountKitGallery() {
  const host = document.createElement("div");
  host.className = "phone";
  host.dataset.kit = "";
  host.style.cssText = "z-index:1000;overflow:auto";
  document.body.appendChild(host);
  createRoot(host).render(
    <StrictMode>
      <KitGallery />
    </StrictMode>,
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 28 }}>
      <h2 className="ph-eyebrow" style={{ color: "var(--ph-meta)" }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

const row = { display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" } as const;
/** The nav pill is positioned for a screen: in the gallery it sits in a box of its height. */
const pillBox = { position: "relative", height: 60, width: 361, "--ph-pill-bottom": "0px" } as CSSProperties;

function KitGallery() {
  const [view, setView] = useState<"list" | "grid">("list");
  const [scope, setScope] = useState("unread");
  const [on, setOn] = useState(true);
  const [query, setQuery] = useState("trigram");
  const [title, setTitle] = useState("You own your data, in spite of the cloud");
  const [note, setNote] = useState("");
  const [checked, setChecked] = useState(true);
  return (
    <div style={{ padding: "24px 20px 80px", columnWidth: 380, columnGap: 40 }}>
      <Group title="Nav pill · 4 places + new link">
        {(["inbox", "all", "feeds"] as const).map((tab) => (
          <div key={tab} style={pillBox}>
            <NavPill tab={tab} inbox={tab === "inbox" ? 12 : 7} onTab={() => {}} onNew={() => {}} />
          </div>
        ))}
      </Group>
      <Group title="Snackbar · above the pill">
        <Snackbar text="Kept · The SQLite query planner" action={{ label: "Undo", run: () => {} }} onTimeout={() => {}} duration={1e9} />
        <Snackbar text="Moved to Trash · 30 days" icon={Trash2} action={{ label: "Undo", run: () => {} }} onTimeout={() => {}} duration={1e9} />
      </Group>
      <Group title="Progress">
        <Progress done={5} total={12} />
      </Group>
      <Group title="Buttons · flat, filled primary, transparent">
        <div style={row}>
          <Button kind="primary" style={{ width: 170 }}>
            Save
          </Button>
          <Button icon={SquareArrowOutUpRight}>Open Koona Pin</Button>
          <Button kind="ink" icon={Plus} style={{ width: 170 }}>
            New link
          </Button>
          <Button kind="soft" icon={Tag}>
            Add tag
          </Button>
          <Button compact>Done</Button>
          <Button kind="ghost" icon={Undo2}>
            Undo last decision
          </Button>
        </div>
      </Group>
      <Group title="Circle buttons · glass, clear, ink">
        <div style={row}>
          <CircleButton icon={Search} label="Search" />
          <CircleButton icon={X} kind="clear" label="Close" />
          <CircleButton icon={Plus} kind="ink" size={44} label="New link" />
          <CircleButton icon={Check} kind="accent" label="Done" />
        </div>
      </Group>
      <Group title="Chips · 36 / 40">
        <div style={row}>
          <Chip active>All</Chip>
          <Chip icon={Heart}>Favorites</Chip>
          <Chip dot="var(--ph-coral)">Design</Chip>
          <Chip>Sort</Chip>
        </div>
        <div style={row}>
          <Chip large dot="var(--ph-teal)" suggested>
            Local-first
          </Chip>
          <Chip icon={Tag}>Tag</Chip>
        </div>
      </Group>
      <Group title="Search · segmented · toggle · account cluster">
        <SearchField value="" onChange={() => {}} placeholder="Search 2,418 links" />
        <SearchField value={query} onChange={setQuery} placeholder="Search" />
        <div style={row}>
          <Segmented
            label="View"
            value={view}
            onChange={setView}
            options={[
              { value: "list", label: "List", icon: List },
              { value: "grid", label: "Grid", icon: Grid2x2 },
            ]}
          />
          <Segmented
            label="Show"
            value={scope}
            onChange={setScope}
            options={[
              { value: "all", label: "All" },
              { value: "unread", label: "Unread" },
              { value: "saved", label: "Saved" },
            ]}
          />
          <Toggle checked={on} onChange={setOn} label="Follow" />
          <Toggle checked={!on} onChange={(v) => setOn(!v)} label="Follow" />
        </div>
        <div style={row}>
          {(["synced", "syncing", "offline", "error"] as const).map((state) => (
            <AccountCluster key={state} supporter sync={state} onOpen={() => {}} />
          ))}
          <AccountCluster supporter={false} sync="offline" onOpen={() => {}} />
        </div>
      </Group>
      <Group title="Fields · single line = pill, multiline r 20">
        <Field label="Title" value={title} onChange={setTitle} />
        <Field label="Note" multiline value={note} onChange={setNote} placeholder="Add a note" />
        <div style={row}>
          <Checkbox checked={checked} onChange={setChecked} label="Local-first" />
          <Checkbox checked={!checked} onChange={(v) => setChecked(!v)} label="Design" />
        </div>
      </Group>
      <Group title="Header · large title, circle buttons">
        <div style={{ position: "relative", margin: "0 -20px" }}>
          <Header title="Library" meta="2,418 links" account={<AccountCluster supporter sync="synced" onOpen={() => {}} />} />
        </div>
      </Group>
      <Group title="Shelf · one surface per section">
        <div style={{ margin: "0 -20px" }}>
          <Shelf label="Settings">
            <ShelfRow icon={Settings} title="Appearance" detail="System" chevron onClick={() => {}} />
            <ShelfRow icon={Heart} title="Supporter" subtitle="Thank you · yearly plan" chevron onClick={() => {}} />
            <ShelfRow title="Local-first" trailing={<Checkbox checked onChange={() => {}} label="Local-first" />} />
          </Shelf>
        </div>
      </Group>
      <Group title="Bottom sheet · detached, concentric r 34">
        <Sheet inline label="Move to collection" title="Move to collection" footer={<Button kind="primary" block>Done</Button>}>
          <SearchField value="" onChange={() => {}} placeholder="Find or create" />
        </Sheet>
      </Group>
    </div>
  );
}
