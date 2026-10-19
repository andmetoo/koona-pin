// Mounts a notification centre with the feeds' notifications of the demo (NP-133), until App
// shows them itself (NP-132): the spec drives the real component with the real list.
import { createRoot } from "react-dom/client";
import { listFeeds } from "../../../src/services/feeds";
import { feedNotifications } from "../../../src/services/feedNotifications";
import { NotificationCenter } from "../../../src/components/shell/NotificationCenter";

export async function mount(): Promise<void> {
  const calls: string[] = [];
  (window as unknown as { feedCalls: string[] }).feedCalls = calls;
  const host = document.createElement("div");
  host.dataset.feedsFixture = "";
  host.style.cssText = "position:fixed;left:50%;top:56px;z-index:9999";
  document.body.append(host);
  const items = feedNotifications(await listFeeds(), {
    onRead: (uids) => calls.push(`read:${uids.join(",")}`),
    onShow: (uid) => calls.push(`show:${uid}`),
    onUnfollow: (uid) => calls.push(`unfollow:${uid}`),
  });
  createRoot(host).render(<NotificationCenter items={items} place="below" onClearAll={() => {}} onOpen={() => {}} />);
}
