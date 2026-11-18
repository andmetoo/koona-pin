/**
 * The room a pane's scrollbar keeps (2.25.3), as `--scrollbar-room` on the root, for the insets that take it
 * off their far side (`pageScrollInset` and its kin, PageTitle.tsx): the app's own 8 px bars on Windows and
 * Linux, nothing for a Mac's overlay bars, about 15 px for the classic bars a Mac shows with a mouse or with
 * «Show scroll bars: Always». Measured on a `.pane-scroll` as the panes are styled, not guessed by platform;
 * again whenever the window comes back to the front, since a Mac switches when a mouse comes or goes.
 */
export function trackScrollbarRoom(win: Window = window): () => void {
  const doc = win.document;
  const measure = () => {
    if (!doc.body) return;
    const probe = doc.createElement("div");
    probe.className = "pane-scroll";
    probe.style.cssText = "position:absolute;top:-10000px;left:0;width:100px;height:40px;overflow-y:scroll;visibility:hidden";
    doc.body.appendChild(probe);
    const room = Math.max(0, probe.offsetWidth - probe.clientWidth);
    probe.remove();
    doc.documentElement.style.setProperty("--scrollbar-room", `${room}px`);
  };
  measure();
  win.addEventListener("focus", measure);
  return () => win.removeEventListener("focus", measure);
}
