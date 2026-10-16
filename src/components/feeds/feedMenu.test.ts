import { describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import type { Feed } from "../../types";
import { feedMenu } from "./FeedMenu";

const feed = (patch: Partial<Feed> = {}): Feed => ({
  uid: "f",
  url: "https://example.com/feed",
  title: null,
  feed_title: "Example",
  site_url: "https://example.com/",
  icon_url: null,
  destination: "feeds",
  unread: 1,
  total: 3,
  fetched_at: null,
  newest_at: null,
  health: { state: "ok" },
  ...patch,
});
const actions = () => ({
  rename: vi.fn(),
  destination: vi.fn(),
  markRead: vi.fn(),
  updateAddress: vi.fn(),
  copy: vi.fn(),
  openSite: vi.fn(),
  unfollow: vi.fn(),
});
const ids = (entries: ReturnType<typeof feedMenu>) => entries.map((e) => (e === "separator" ? "—" : e.id));

describe("feedMenu (NP-129)", () => {
  const t = i18n.getFixedT("en");
  it("offers «Update the address» only for a feed that moved", () => {
    expect(ids(feedMenu(feed(), t, actions()))).not.toContain("updateAddress");
    const moved = feed({ health: { state: "moved", to: "https://new.example.com/feed" } });
    const act = actions();
    const entry = feedMenu(moved, t, act).find((e) => e !== "separator" && e.id === "updateAddress");
    expect(entry && entry !== "separator" && entry.label).toBe("Update the address");
    if (entry && entry !== "separator") entry.onSelect?.();
    expect(act.updateAddress).toHaveBeenCalledWith(moved);
  });
});
