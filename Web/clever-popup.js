import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import { onStaleCountChange, showToast, staleNodes } from "./utils.js";
import { rebuildStaleNodes } from "./node-tools.js";
import { openReportPanel, lastError } from "./livedev-error-report.js";
import { setToolbarAutoShow, resetToolbarPosition } from "./align-toolbar.js";
import {
  isAlignSnapEnabled,
  onAlignSnapChange,
  toggleAlignSnapEnabled,
} from "./align-snap-guides.js";
import { openWorkflowGalleryModal } from "./workflow-gallery.js";
import { openConsoleFilterModal } from "./console-filter.js";
import { ACCENT, ACCENT_DIM, DANGER, DANGER_DIM, LD_ICONS } from "./livedev-theme.js";

const menuSvg = (inner) =>
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  inner +
  "</svg>";

const MENU_ICON = {
  brand: menuSvg('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'),
  console: menuSvg('<rect x="3" y="4" width="18" height="16" rx="2"/><polyline points="7 9 10 12 7 15"/><line x1="12" y1="15" x2="17" y2="15"/>'),
  config: menuSvg('<line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="16" cy="12" r="2"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="11" cy="18" r="2"/>'),
  memory: menuSvg('<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>'),
  report: menuSvg('<path d="M8 2l1.88 1.88"/><path d="M14.12 3.88L16 2"/><path d="M9 7.13v-1a3 3 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><line x1="12" y1="20" x2="12" y2="11"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/>'),
  deps: menuSvg('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>'),
  toolbar: menuSvg('<rect x="3" y="14" width="18" height="6" rx="2"/><line x1="7" y1="17" x2="7.01" y2="17"/><line x1="11" y1="17" x2="17" y2="17"/><path d="M8 9l4-4 4 4"/><line x1="12" y1="5" x2="12" y2="12"/>'),
  restart: menuSvg('<path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>'),
  shutdown: menuSvg('<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>'),
  rebuild: menuSvg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>'),
  reloadAll: menuSvg('<path d="M21.5 2v6h-6"/><path d="M2.5 22v-6h6"/><path d="M2 11.5a10 10 0 0 1 18.8-4.3L21.5 8"/><path d="M22 12.5a10 10 0 0 1-18.8 4.2L2.5 16"/>'),
  logFilter: menuSvg('<polygon points="3 5 21 5 14 13 14 19 10 21 10 13 3 5"/>'),
  update: menuSvg('<path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/>'),
};

function injectPopupTheme() {
  const existing = document.getElementById("livedev-popup-theme");
  const st = existing || document.createElement("style");
  st.id = "livedev-popup-theme";
  st.textContent = `
#livedev-btn {
  display: inline-flex;
  align-items: center;
  align-self: center;
  gap: 6px;
  height: 32px;
  font-size: 12px;
  font-weight: 600;
  padding: 0 11px;
  margin: 0 3px;
  box-sizing: border-box;
  cursor: pointer;
  border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(16, 18, 22, 0.84);
  color: ${ACCENT};
  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  transition: background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease, transform 0.12s ease;
}
#livedev-btn:hover,
#livedev-btn.is-open {
  background: rgba(56, 192, 196, 0.16);
  border-color: ${ACCENT};
  box-shadow: 0 4px 16px rgba(56, 192, 196, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.10);
}
#livedev-btn:active {
  transform: scale(0.96);
}
#livedev-btn svg {
  display: block;
  flex-shrink: 0;
}
#livedev-snap-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  align-self: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  margin: 0 3px 0 0;
  box-sizing: border-box;
  cursor: pointer;
  border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(16, 18, 22, 0.84);
  color: #888;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease, transform 0.12s ease;
}
#livedev-snap-btn.is-active {
  color: ${ACCENT};
  background: rgba(56, 192, 196, 0.14);
  border-color: rgba(56, 192, 196, 0.45);
  box-shadow: 0 3px 14px rgba(56, 192, 196, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.08);
}
#livedev-snap-btn:hover {
  color: ${ACCENT};
  background: rgba(56, 192, 196, 0.20);
  border-color: ${ACCENT};
  box-shadow: 0 4px 16px rgba(56, 192, 196, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.10);
}
#livedev-snap-btn:active {
  transform: scale(0.94);
}
#livedev-snap-btn svg {
  display: block;
  flex-shrink: 0;
}
#livedev-snap-btn .ld-snap-dot {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: ${ACCENT};
  opacity: 0;
  transition: opacity 0.15s ease;
  pointer-events: none;
}
#livedev-snap-btn.is-active .ld-snap-dot {
  opacity: 1;
}
#livedev-gallery-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  align-self: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  margin: 0 3px 0 0;
  box-sizing: border-box;
  cursor: pointer;
  border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(16, 18, 22, 0.84);
  color: ${ACCENT};
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease, transform 0.12s ease;
}
#livedev-gallery-btn:hover {
  background: rgba(56, 192, 196, 0.18);
  border-color: ${ACCENT};
  box-shadow: 0 4px 16px rgba(56, 192, 196, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.10);
}
#livedev-gallery-btn:active {
  transform: scale(0.94);
}
#livedev-gallery-btn svg {
  display: block;
  flex-shrink: 0;
}
#livedev-menu-popup {
  position: fixed;
  z-index: 999999;
  min-width: 268px;
  padding: 10px;
  border-radius: 14px;
  background: rgba(16, 18, 22, 0.90);
  border: 1px solid rgba(255, 255, 255, 0.10);
  box-shadow: 0 16px 42px rgba(0, 0, 0, 0.62), 0 2px 10px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(16px) saturate(145%);
  -webkit-backdrop-filter: blur(16px) saturate(145%);
  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  font-size: 12px;
  color: #d8dee6;
  box-sizing: border-box;
}
#livedev-menu-popup::before {
  content: "";
  position: absolute;
  top: -1px;
  left: 18%;
  right: 18%;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(56, 192, 196, 0.65), transparent);
  pointer-events: none;
}
#livedev-menu-popup .ld-pop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 4px 8px;
  margin-bottom: 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
#livedev-menu-popup .ld-pop-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: ${ACCENT};
}
#livedev-menu-popup .ld-pop-sub {
  font-size: 10.5px;
  color: #888;
}
#livedev-menu-popup .ld-pop-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(118px, 1fr));
  gap: 6px;
}
#livedev-menu-popup .ld-pop-btn {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  background: rgba(255, 255, 255, 0.035);
  color: #d8dee6;
  cursor: pointer;
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  text-align: left;
  white-space: nowrap;
  transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease, transform 0.12s ease, box-shadow 0.14s ease;
}
#livedev-menu-popup .ld-pop-btn .ld-pop-ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.05);
  color: #cbd3dc;
  flex-shrink: 0;
  transition: background 0.14s ease, color 0.14s ease;
}
#livedev-menu-popup .ld-pop-btn:hover {
  background: rgba(56, 192, 196, 0.14);
  border-color: rgba(56, 192, 196, 0.45);
  color: #ffffff;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(56, 192, 196, 0.16);
}
#livedev-menu-popup .ld-pop-btn:hover .ld-pop-ico {
  background: rgba(56, 192, 196, 0.22);
  color: ${ACCENT};
}
#livedev-menu-popup .ld-pop-btn:active {
  transform: scale(0.96);
}
#livedev-menu-popup .ld-pop-btn.is-active {
  border-color: ${ACCENT_DIM};
  background: rgba(56, 192, 196, 0.10);
  color: ${ACCENT};
}
#livedev-menu-popup .ld-pop-btn.is-active .ld-pop-ico {
  background: rgba(56, 192, 196, 0.20);
  color: ${ACCENT};
}
#livedev-menu-popup .ld-pop-btn.is-danger:hover {
  background: rgba(229, 115, 115, 0.15);
  border-color: rgba(229, 115, 115, 0.48);
  color: ${DANGER};
  box-shadow: 0 4px 12px rgba(229, 115, 115, 0.18);
}
#livedev-menu-popup .ld-pop-btn.is-danger:hover .ld-pop-ico {
  background: rgba(229, 115, 115, 0.22);
  color: ${DANGER};
}
#livedev-menu-popup .ld-pop-btn.is-alert {
  border-color: ${DANGER_DIM};
  color: ${DANGER};
}
#livedev-menu-popup .ld-pop-btn.is-alert .ld-pop-ico {
  background: rgba(229, 115, 115, 0.16);
  color: ${DANGER};
}
#livedev-menu-popup .ld-pop-btn.is-full {
  grid-column: 1 / -1;
  justify-content: center;
  border-color: ${ACCENT_DIM};
  background: rgba(56, 192, 196, 0.12);
  color: ${ACCENT};
  font-weight: 600;
}
#livedev-menu-popup .ld-pop-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-left: auto;
  flex-shrink: 0;
}
`;
  if (!existing) document.head.appendChild(st);
}

function lsGet(key, fallback) {
  try {
    const value = localStorage.getItem("livedev_" + key);
    return value != null ? JSON.parse(value) : fallback;
  } catch (e) {
    return fallback;
  }
}

app.registerExtension({
  name: "LiveDev.Popup",
  async setup() {
    // Already initialized below as top-level code
  },
});

let popup = null;
function closePopup() { if (popup) { try { popup.remove(); } catch(e) {} popup = null; } }

// Restart and then wait for the server to answer again before reloading, so the page never comes
// back up against a server that is still going down. Shared, because an update ends the same way a
// plain restart does.
async function restartAndReload() {
  showToast("Restarting server...");
  await api.fetchApi("/livedev/restart", { method: "POST" });
  await new Promise(r => setTimeout(r, 2500));
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(window.location.href, { method: "HEAD", cache: "no-store" });
      if (res.ok) { window.location.reload(); return; }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 1500));
  }
  showToast("Server did not restart in time");
}

// An available update has to be visible without opening the menu, so the button itself carries a
// marker. The check is a network round trip, so it runs once shortly after load rather than on every
// render, and the server caches the answer for five minutes.
let liveDevBtn = null;
let updateInfo = null;
let staleCount = 0;

/**
 * One marker on the button, for however many reasons there are to open the menu: a newer ComfyUI
 * release, or nodes whose class changed since they were built. The title is composed from both, so
 * whichever check ran last cannot erase the other's reason.
 */
function refreshBadge() {
  if (!liveDevBtn) return;
  const reasons = [];
  if (updateInfo) reasons.push(`ComfyUI ${updateInfo.latest} is available`);
  if (staleCount) reasons.push(`${staleCount} node${staleCount === 1 ? "" : "s"} can be rebuilt`);
  liveDevBtn.title = reasons.join("   \u00b7   ");
  let mark = liveDevBtn.querySelector(".livedev-mark");
  if (!reasons.length) {
    if (mark) mark.remove();
    return;
  }
  liveDevBtn.style.position = "relative";
  if (!mark) {
    mark = document.createElement("span");
    mark.className = "livedev-mark";
    liveDevBtn.appendChild(mark);
  }
  // A release gets the word: "there is a new version" is the one reason worth spelling out at a
  // glance. Nodes that need rebuilding keep the dot, because their count is already in the menu.
  if (updateInfo) {
    mark.textContent = "New";
    mark.style.cssText = "position:absolute;top:-9px;right:-8px;font-size:9px;font-weight:bold;line-height:1;padding:2px 4px;border-radius:7px;background:#38c0c4;color:#0d0d0d;letter-spacing:0.3px;";
  } else {
    mark.textContent = "";
    mark.style.cssText = "position:absolute;top:-3px;right:-3px;width:8px;height:8px;border-radius:50%;background:#38c0c4;box-shadow:0 0 0 2px #1a1a1a;";
  }
}

function markUpdate(info) {
  updateInfo = info;
  refreshBadge();
}

function unmarkUpdate() {
  updateInfo = null;
  refreshBadge();
}

// Called by the reload listener when a changed node class leaves nodes on the canvas behind it.
export function setStaleCount(count) {
  staleCount = Math.max(0, count | 0);
  refreshBadge();
}

// The badge follows the shared list instead of being told separately, so it cannot disagree with what
// the two menus offer.
onStaleCountChange(setStaleCount);

async function checkUpdate() {
  try {
    const res = await api.fetchApi("/livedev/update_check");
    const data = await res.json();
    // `updater` is the server saying it has a script for this install. Without it the cell would
    // appear and then fail, which is worse than not offering it.
    updateInfo = data?.ok && data.available && data.updater ? data : null;
  } catch (e) {
    updateInfo = null;
  }
  if (updateInfo) markUpdate(updateInfo);
  return updateInfo;
}

function makeMenuBtn() {
  injectPopupTheme();
  const btn = document.createElement("button");
  btn.id = "livedev-btn";
  liveDevBtn = btn;
  btn.innerHTML = MENU_ICON.brand + "<span>LiveDev</span>";
  const lit = (on) => {
    btn.classList.toggle("is-open", Boolean(on));
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    if (popup) { closePopup(); lit(false); return; }
    lit(true);
    popup = document.createElement("div");
    popup.id = "livedev-menu-popup";

    const head = document.createElement("div");
    head.className = "ld-pop-head";
    head.innerHTML =
      `<span class="ld-pop-title">${MENU_ICON.brand}<span>LiveDev</span></span>` +
      `<span class="ld-pop-sub">Control Hub</span>`;
    popup.appendChild(head);

    const inner = document.createElement("div");
    inner.className = "ld-pop-grid";

    function opt(iconSvg, label, onClick, opts = {}) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "ld-pop-btn";
      if (opts.danger) el.classList.add("is-danger");
      if (opts.active) el.classList.add("is-active");
      if (opts.alert) el.classList.add("is-alert");
      if (opts.full) el.classList.add("is-full");

      const ico = document.createElement("span");
      ico.className = "ld-pop-ico";
      ico.innerHTML = iconSvg;

      const txt = document.createElement("span");
      txt.textContent = label;

      el.appendChild(ico);
      el.appendChild(txt);

      if (opts.dotColor) {
        const dot = document.createElement("span");
        dot.className = "ld-pop-dot";
        dot.style.background = opts.dotColor;
        el.appendChild(dot);
      }
      if (opts.title) el.title = opts.title;

      el.onclick = async (ev) => {
        ev.stopPropagation();
        await onClick();
        closePopup();
        lit(false);
      };
      inner.appendChild(el);
      return el;
    }

    // 1. Console
    opt(MENU_ICON.console, "Console", async () => {
      await api.fetchApi("/livedev/clear_console", { method: "POST" });
      showToast("Console cleared");
    }, { title: "Clear server console output" });

    // 2. Config
    opt(MENU_ICON.config, "Config", async () => {
      if (typeof window.showLiveDevDialog === "function") window.showLiveDevDialog();
      else showToast("LiveDev: config dialog not ready");
    }, { title: "Configure watched and excluded custom_nodes" });

    // 3. Memory
    opt(MENU_ICON.memory, "Memory", async () => {
      const res = await api.fetchApi("/livedev/free_memory", { method: "POST" });
      const d = await res.json();
      if (!d.ok) { showToast("[LiveDev] " + (d.error || "cleanup failed")); return; }
      const ram = Math.max(0, (d.before?.ram_mb || 0) - (d.after?.ram_mb || 0));
      const vram = Math.max(0, (d.before?.vram_mb || 0) - (d.after?.vram_mb || 0));
      if (!d.unloaded && !ram && !vram) {
        showToast("[LiveDev] nothing to free - no models are loaded");
        return;
      }
      const models = d.unloaded ? `, ${d.unloaded} model${d.unloaded === 1 ? "" : "s"} unloaded` : "";
      showToast(`[LiveDev] freed ${ram} MB RAM, ${vram} MB VRAM${models}`);
    }, { title: "Unload models and reclaim RAM / VRAM" });

    // 4. Report
    {
      const captured = lastError();
      opt(MENU_ICON.report, "Report", async () => { await openReportPanel(captured); }, {
        alert: Boolean(captured),
        dotColor: captured ? DANGER : null,
        title: captured ? "Open captured error report" : "Open Error Report panel",
      });
    }

    // 5. Deps
    opt(MENU_ICON.deps, "Deps", async () => {
      if (typeof window.scanAllLiveDevDeps === "function") {
        await window.scanAllLiveDevDeps();
      } else {
        showToast("[LiveDev] dependency scanner not ready");
      }
    }, { title: "Scan custom_nodes dependencies and manage packages" });

    // 6. Toolbar
    {
      const pinned = window._tbAutoShow !== false;
      opt(MENU_ICON.toolbar, "Toolbar", async () => {
        if (!window._tbAutoShow) {
          resetToolbarPosition();
          setToolbarAutoShow(true);
          showToast("LiveDev: alignment toolbar shown");
        } else {
          setToolbarAutoShow(false);
          showToast("LiveDev: toolbar set to 2+ nodes only");
        }
      }, {
        active: pinned,
        dotColor: pinned ? ACCENT : null,
        title: pinned
          ? "Toolbar is always visible (click to auto-hide)"
          : "Toolbar is hidden until 2+ nodes selected (click to show & center)",
      });
    }

    // 7. Restart
    opt(MENU_ICON.restart, "Restart", async () => {
      if (!confirm("Restart ComfyUI server?")) return;
      await restartAndReload();
    }, { danger: true, title: "Restart ComfyUI server and reload page" });

    // 8. Shutdown
    opt(MENU_ICON.shutdown, "Shutdown", async () => {
      if (!confirm("Shutdown ComfyUI server?")) return;
      await api.fetchApi("/livedev/shutdown", { method: "POST" });
      showToast("Shutting down...");
    }, { danger: true, title: "Stop the ComfyUI server process" });

    // 9. Rebuild
    {
      const count = staleNodes().length;
      opt(MENU_ICON.rebuild, `Rebuild (${count})`, async () => { rebuildStaleNodes(); }, {
        active: count > 0,
        dotColor: count > 0 ? ACCENT : null,
        title: "Rebuild canvas nodes whose class schema changed after reload",
      });
    }

    // 10. Reload All
    opt(MENU_ICON.reloadAll, "Reload All", async () => {
      if (lsGet("confirmReloadAll", true) && !confirm("Reload every watched module?")) return;
      showToast("LiveDev: reloading every module...");
      const res = await api.fetchApi("/livedev/reload_all", { method: "POST" });
      const d = await res.json();
      if (!d.ok) { showToast("LiveDev: " + (d.error || "reload failed")); return; }
      showToast(`LiveDev: reloaded ${d.reloaded.length} modules`);
    }, { title: "Reload all watched custom node packs" });

    // 11. Log Filter (right before Update)
    opt(MENU_ICON.logFilter, "Log Filter", async () => {
      openConsoleFilterModal();
    }, { full: true, title: "Inspect console writers and silence noisy custom nodes" });

    // 12. Update (conditional — shown at the bottom when a newer ComfyUI release exists)
    {
      const item = opt(MENU_ICON.update, "Update", async () => {
        const latest = item.dataset.latest || "the latest release";
        if (!confirm(
            `Update ComfyUI to ${latest}?\n\n` +
            "The files are replaced now, but the running server keeps executing the old ones, " +
            "so ComfyUI restarts afterwards.")) return;
        showToast("[LiveDev] updating ComfyUI...");
        const res = await api.fetchApi("/livedev/update", { method: "POST" });
        const d = await res.json();
        if (!d.ok) {
          showToast(`[LiveDev] update failed: ${d.error || "exit " + d.returncode}`);
          console.warn("[LiveDev] updater output:\n" + (d.output || ""));
          return;
        }
        await restartAndReload();
      }, { full: true });
      item.style.display = "none";
      checkUpdate().then(d => {
        if (d) {
          item.dataset.latest = d.latest;
          item.title = `${d.current}  ->  ${d.latest}`;
          item.style.display = "";
          const isNew = document.createElement("span");
          isNew.textContent = "New";
          isNew.style.cssText = `position:absolute;top:-6px;left:8px;font-size:9px;font-weight:bold;line-height:1;padding:2px 5px;border-radius:7px;background:${ACCENT};color:#0d0d0d;letter-spacing:0.3px;`;
          item.appendChild(isNew);
          const skip = document.createElement("span");
          skip.textContent = "\u2715";
          skip.title = `Stop offering ${d.latest}`;
          skip.style.cssText = "position:absolute;top:-5px;right:8px;width:15px;height:15px;border-radius:50%;background:#2a2a2a;border:1px solid #777;color:#bbb;font-size:9px;line-height:13px;text-align:center;cursor:pointer;";
          skip.onclick = async (ev) => {
            ev.stopPropagation();
            await api.fetchApi("/livedev/update_ignore", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ version: d.latest }),
            });
            unmarkUpdate();
            item.style.display = "none";
            showToast(`[LiveDev] ${d.latest} will not be offered again`);
          };
          item.appendChild(skip);
        }
      });
    }

    popup.appendChild(inner);
    document.body.appendChild(popup);

    // Position safely inside viewport
    const rect = btn.getBoundingClientRect();
    const popRect = popup.getBoundingClientRect();
    const left = Math.min(
      Math.max(8, rect.left + rect.width - popRect.width),
      Math.max(8, window.innerWidth - popRect.width - 8)
    );
    popup.style.top = (rect.bottom + 6) + "px";
    popup.style.left = Math.round(left) + "px";
  };
  document.addEventListener("click", (e) => {
    if (popup && !popup.contains(e.target) && !btn.contains(e.target)) { closePopup(); lit(false); }
  });
  return btn;
}

// ---- System Stats Glass Card ----
function createStatsBar() {
  const container = document.createElement("div");
  container.id = "livedev-stats";
  // No frame around the group: each pill is its own box, and an outer one on top of them was the
  // reason the old bar read as a block rather than a row of readings.
  container.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:5px;padding:2px 4px;margin:0 4px;";

  // A pill per metric, the way Crystools draws its monitor: the name carries the metric's own
  // colour and the value carries the number. The 2px bar along the bottom is what holds the level,
  // so the pill keeps the compactness of a label without giving up the reading.
  const HUE = { cpu: "#38c0c4", gpu: "#38c0c4", vram: "#38c0c4", ram: "#38c0c4" };

  function makePill(label, hue) {
    const pill = document.createElement("div");
    // Two lines, both with line-height 1, so the second one costs about ten pixels rather than the
    // sixteen a normal line box would add. The pill has to stay under the queue button's height.
    // flex-basis 0 is what makes the pills equal: with any other basis the widest content wins, so
    // VRAM with its second line came out wider than CPU with nothing under it. min-width 0 lets the
    // basis hold when the row is narrow, and max-width keeps them from stretching on a wide window.
    pill.style.cssText = "position:relative;display:flex;flex-direction:column;gap:1px;padding:2px 9px 6px;background:rgba(255,255,255,0.045);border:1px solid rgba(255,255,255,0.09);border-radius:6px;overflow:hidden;flex:1 1 0;min-width:0;max-width:124px;";

    const top = document.createElement("div");
    top.style.cssText = "display:flex;align-items:baseline;gap:6px;line-height:1.05;";

    const name = document.createElement("span");
    name.textContent = label;
    name.style.cssText = `color:${hue};font-size:11px;font-weight:bold;letter-spacing:0.03em;`;

    const value = document.createElement("span");
    value.textContent = "\u2014";
    value.style.cssText = "color:#ddd;font-size:12px;font-weight:bold;font-variant-numeric:tabular-nums;margin-left:auto;";

    // Always present, even when empty, so every pill in the row is the same height.
    const note = document.createElement("div");
    note.textContent = "\u00a0";
    note.style.cssText = "color:#888;font-size:10px;line-height:1.05;text-align:right;font-variant-numeric:tabular-nums;";

    const track = document.createElement("div");
    // Four pixels rather than two, and a track that can be seen. At three per cent the fill is three
    // pixels of a hundred either way, so the empty part has to be legible or the pill looks blank.
    // The bar sits in the bottom padding, so it costs the pill no height.
    track.style.cssText = "position:absolute;left:0;right:0;bottom:0;height:4px;background:rgba(255,255,255,0.13);";
    const fill = document.createElement("div");
    fill.style.cssText = `height:100%;width:0%;background:${hue};transition:width 0.2s linear,background 0.2s linear;`;
    track.appendChild(fill);

    top.append(name, value);
    pill.append(top, note, track);
    pill._value = value;
    pill._note = note;
    pill._name = name;
    pill._fill = fill;
    pill._hue = hue;
    return pill;
  }

  function setPill(pill, pct, note) {
    pill._value.textContent = pct + "%";
    pill._note.textContent = note || "\u00a0";
    pill._fill.style.width = Math.min(100, pct) + "%";
    // The whole pill changes, not only the bar. At eighty per cent the name is as much of the warning
    // as the level is, and a pill whose name stays calm while its bar is red is half a signal.
    const colour = pct >= 80 ? "#e57373" : pct >= 50 ? "#38c0c4" : pill._hue;
    pill._fill.style.background = colour;
    pill._name.style.color = colour;
  }

  const cpuRow = makePill("CPU", HUE.cpu);
  const gpuRow = makePill("GPU", HUE.gpu);
  const vramRow = makePill("VRAM", HUE.vram);
  const ramRow = makePill("RAM", HUE.ram);
  container.appendChild(cpuRow);
  container.appendChild(gpuRow);
  container.appendChild(vramRow);
  container.appendChild(ramRow);
  const all = [cpuRow, gpuRow, vramRow, ramRow];
  // Compact trims the pill's padding and the gap between them; the reading and the bar are the same,
  // only the box around them is smaller, which is what makes four pills fit a narrow window.
  if (lsGet("compactBar", false)) {
    container.style.gap = "3px";
    for (const pill of all) pill.style.padding = "1px 6px 4px";
  }

  // The bar has room for four numbers and the response carries more than four. A tooltip holds the
  // rest, but only while the pointer stays on the bar, which is no use for reading a figure while a
  // run is going. The same data opens in a panel instead, and the panel stays until it is closed.
  let detail = null;
  let latest = null;

  function detailRow(name, value) {
    const line = document.createElement("div");
    line.style.cssText = "display:flex;justify-content:space-between;gap:18px;padding:2px 0;";
    const left = document.createElement("span");
    left.textContent = name;
    left.style.cssText = "color:#999;";
    const right = document.createElement("span");
    right.textContent = value;
    right.style.cssText = "color:#ddd;font-variant-numeric:tabular-nums;";
    line.append(left, right);
    return line;
  }

  function fillDetail() {
    if (!detail || !latest) return;
    detail.textContent = "";
    const d = latest;

    const title = document.createElement("div");
    title.textContent = "LiveDev";
    // Dimmer than the two column headings, so the headings read as the structure and the title does
    // not compete with them.
    title.style.cssText = "color:#888;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:8px;";
    detail.appendChild(title);

    // Two columns, because the two sets of numbers answer different questions and reading them as
    // one list is what made "Process 2.45 GB" look like a machine figure. Everything the server
    // itself is holding belongs on the left; everything the machine is doing belongs on the right.
    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:0 22px;";
    detail.appendChild(grid);

    function column(name, rows) {
      const cell = document.createElement("div");
      const head = document.createElement("div");
      head.textContent = name;
      head.style.cssText = "color:#38c0c4;font-weight:bold;border-bottom:1px solid #444;padding-bottom:4px;margin-bottom:5px;";
      cell.appendChild(head);
      for (const [label, value] of rows) {
        if (value) cell.appendChild(detailRow(label, value));
      }
      grid.appendChild(cell);
    }

    const comfy = d.comfy || {};
    const gb = (mb) => (mb / 1024).toFixed(1);
    // The ComfyUI column is the process side, and both halves of it can be turned off from the
    // settings: the reading is still on the bar and in the tooltip, so hiding a row hides no number.
    if (lsGet("showComfy", true)) {
      const rows = [];
      if (lsGet("showProcess", true)) {
        rows.push(["CPU", d.cpu?.procPercent != null ? `${d.cpu.procPercent}%` : ""]);
        rows.push(["RAM", d.proc?.mem != null ? `${d.proc.mem} GB` : ""]);
      }
      rows.push(["VRAM", comfy.vram_reserved_mb ? `${gb(comfy.vram_reserved_mb)} GB` : ""]);
      rows.push(["Models", comfy.models != null ? String(comfy.models) : ""]);
      rows.push(["Device", comfy.device || ""]);
      column("ComfyUI", rows);
    }

    column("System", [
      ["CPU", d.cpu ? `${d.cpu.percent}%` : ""],
      ["RAM", d.ram ? `${d.ram.percent}%  ${d.ram.used}/${d.ram.total} GB` : ""],
      ["GPU", d.gpu ? `${d.gpu.percent}%  ${d.gpu.temp}\u00B0` : ""],
      ["VRAM", d.vram ? `${d.vram.percent}%  ${gb(d.vram.used)}/${gb(d.vram.total)} GB` : ""],
      ["Disk", d.hdd ? `${d.hdd.percent}%  ${d.hdd.used}/${d.hdd.total} TB` : ""],
    ]);

    if (d.gpu?.name) {
      const footer = document.createElement("div");
      footer.textContent = d.gpu.name;
      footer.style.cssText = "color:#777;margin-top:8px;border-top:1px solid #333;padding-top:6px;";
      detail.appendChild(footer);
    }

    // Full width, under both columns: a loaded model can be named anything, and half a column is not
    // enough to read it in.
    if (comfy.loaded?.length) {
      const loaded = document.createElement("div");
      loaded.textContent = comfy.loaded.join("  \u00B7  ");
      loaded.style.cssText = "color:#bbb;margin-top:8px;border-top:1px solid #333;padding-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      loaded.title = comfy.loaded.join("\n");
      detail.appendChild(loaded);
    }
  }

  function closeDetail() {
    if (!detail) return;
    detail.remove();
    detail = null;
    more.style.color = "#888";
  }

  function openDetail() {
    detail = document.createElement("div");
    detail.className = "ld-modal";
    detail.style.cssText =
      "position:fixed;z-index:2147483000;min-width:390px;padding:12px 14px;font-size:12px;";
    const rect = container.getBoundingClientRect();
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 406));
    detail.style.top = (rect.bottom + 6) + "px";
    detail.style.left = Math.round(left) + "px";
    document.body.appendChild(detail);
    more.style.color = ACCENT;
    fillDetail();
  }

  const more = document.createElement("span");
  more.innerHTML = LD_ICONS.chevronDown;
  more.title = "System detail";
  more.style.cssText =
    "color:#888;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;margin-left:auto;transition:color 0.14s ease,background 0.14s ease;";
  more.onmouseenter = () => { more.style.background = "rgba(56,192,196,0.14)"; more.style.color = ACCENT; };
  more.onmouseleave = () => { more.style.background = "transparent"; if (!detail) more.style.color = "#888"; };
  more.onclick = (event) => {
    event.stopPropagation();
    if (detail) closeDetail();
    else openDetail();
  };
  container.appendChild(more);

  document.addEventListener("click", (event) => {
    if (detail && !detail.contains(event.target) && !more.contains(event.target)) closeDetail();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDetail();
  });

  function lsGet(k, def) { try { const v = localStorage.getItem("livedev_" + k); return v != null ? JSON.parse(v) : def; } catch (e) { return def; } }

  let timer = null;
  let stale = false;

  // What is on screen is the last answer the server sent, so a server that stopped answering leaves
  // it lit and looking current. Dimming the bar is the difference between idle and gone.
  function setStale(on) {
    if (stale === on) return;
    stale = on;
    container.style.opacity = on ? "0.4" : "";
    if (on) container.title = "LiveDev: the server is not answering";
  }

  async function poll() {
    try {
      const show = {
        cpu: lsGet("showCPU", true),
        gpu: lsGet("showGPU", true),
        vram: lsGet("showVRAM", true),
        ram: lsGet("showRAM", true),
      };
      cpuRow.style.display = show.cpu ? "" : "none";
      gpuRow.style.display = show.gpu ? "" : "none";
      vramRow.style.display = show.vram ? "" : "none";
      ramRow.style.display = show.ram ? "" : "none";
      const chosenDrive = lsGet("drive", "Automatic");
      const drive = chosenDrive && chosenDrive !== "Automatic" ? chosenDrive : "";
      const res = await api.fetchApi("/livedev/stats" + (drive ? `?hdd_path=${encodeURIComponent(drive)}` : ""));
      const d = await res.json();
      setStale(false);
      latest = d;
      fillDetail();
      // The bar has room for four numbers, so the rest live in the panel and in the tooltip and the
      // bar can stay one line without hiding anything. Split the same way the panel is.
      const comfy = d.comfy || {};
      const reserved = comfy.vram_reserved_mb ? `${(comfy.vram_reserved_mb / 1024).toFixed(1)} GB` : "-";
      container.title =
        `${d.gpu?.name || "GPU"}\n` +
        `ComfyUI   CPU ${d.cpu?.procPercent}%   RAM ${d.proc?.mem} GB   ` +
        `VRAM ${reserved}   ${comfy.models ?? 0} models\n` +
        `System    CPU ${d.cpu?.percent}%   RAM ${d.ram?.percent}%   ` +
        `VRAM ${d.vram?.percent}%   Disk ${d.hdd?.percent}%`;
      if (d.cpu) setPill(cpuRow, d.cpu.percent);
      if (d.gpu) setPill(gpuRow, d.gpu.percent, d.gpu.temp != null ? d.gpu.temp + "\u00B0" : "");
      if (d.vram) setPill(vramRow, d.vram.percent, (d.vram.used / 1024).toFixed(1) + "G");
      if (d.ram) setPill(ramRow, d.ram.percent);
    } catch (e) {
      setStale(true);
    }
    timer = setTimeout(poll, parseInt(lsGet("refreshRate", 2500)));
  }

  // Nothing on this bar is worth a subprocess every couple of seconds while the tab is in the
  // background, and a hidden tab has nobody reading it. It catches up on the first tick back.
  document.addEventListener("visibilitychange", () => {
    clearTimeout(timer);
    if (!document.hidden) poll();
  });

  setTimeout(poll, 2000);
  return container;
}

function makeSnapGuidesBtn() {
  injectPopupTheme();
  const snapBtn = document.createElement("button");
  snapBtn.type = "button";
  snapBtn.id = "livedev-snap-btn";
  snapBtn.innerHTML = LD_ICONS.snapGuides + '<span class="ld-snap-dot"></span>';
  const syncVisual = (on) => {
    const active = Boolean(on);
    snapBtn.classList.toggle("is-active", active);
    snapBtn.setAttribute("aria-pressed", active ? "true" : "false");
    snapBtn.title = active
      ? "Align Snap & Alignment Guides: ON (hold Shift to bypass during drag)"
      : "Align Snap & Alignment Guides: OFF (click to enable; hold Shift to bypass during drag)";
  };
  syncVisual(isAlignSnapEnabled());
  onAlignSnapChange(syncVisual);
  snapBtn.onclick = (e) => {
    e.stopPropagation();
    toggleAlignSnapEnabled({ toast: true });
  };
  return snapBtn;
}

function makeWorkflowGalleryBtn() {
  injectPopupTheme();
  const galleryBtn = document.createElement("button");
  galleryBtn.type = "button";
  galleryBtn.id = "livedev-gallery-btn";
  galleryBtn.innerHTML = LD_ICONS.gallery;
  galleryBtn.title = "Workflow Gallery — Browse all ComfyUI & custom_nodes workflows";
  galleryBtn.onclick = (e) => {
    e.stopPropagation();
    openWorkflowGalleryModal();
  };
  return galleryBtn;
}

function addMenuBtn() {
  const btn = makeMenuBtn();
  const snapBtn = makeSnapGuidesBtn();
  const galleryBtn = makeWorkflowGalleryBtn();
  const stats = createStatsBar();
  // No update check here. It used to run on every page load, so opening ComfyUI at all meant an
  // outbound request nobody asked for; the check now runs when the menu is opened, which is the
  // moment the answer is wanted.
  const target =
    app.menu?.settingsGroup?.element ||
    document.getElementById("comfyui-body-top") ||
    document.querySelector(".comfyui-body-top") ||
    document.querySelector(".comfy-menu-btns");
  if (target) {
    target.before ? target.before(btn) : target.parentNode.insertBefore(btn, target);
    btn.after(snapBtn);
    snapBtn.after(galleryBtn);
    galleryBtn.after(stats);
  } else {
    btn.style.position = "fixed";
    btn.style.top = "8px";
    btn.style.right = "8px";
    btn.style.zIndex = "99999";
    document.body.appendChild(btn);
    snapBtn.style.position = "fixed";
    snapBtn.style.top = "8px";
    snapBtn.style.right = "96px";
    snapBtn.style.zIndex = "99999";
    document.body.appendChild(snapBtn);
    galleryBtn.style.position = "fixed";
    galleryBtn.style.top = "8px";
    galleryBtn.style.right = "132px";
    galleryBtn.style.zIndex = "99999";
    document.body.appendChild(galleryBtn);
    stats.style.position = "fixed";
    stats.style.top = "8px";
    stats.style.right = "170px";
    stats.style.zIndex = "99999";
    document.body.appendChild(stats);
  }
  if (lsGet("barPosition", "Top") === "Bottom") {
    // Moved, not built twice: appendChild takes the element out of the top row and puts it at the
    // bottom of the window, where a full-width strip reads as a status line.
    document.body.appendChild(stats);
    stats.style.position = "fixed";
    stats.style.left = "0";
    stats.style.right = "0";
    stats.style.bottom = "0";
    stats.style.top = "";
    stats.style.zIndex = "99999";
    stats.style.justifyContent = "center";
    stats.style.background = "rgba(20,20,20,0.92)";
  }
}

let retries = 0;
function tryAdd() {
  if (app.menu?.settingsGroup?.element || document.getElementById("comfyui-body-top") || document.querySelector(".comfyui-body-top") || document.querySelector(".comfy-menu-btns") || ++retries > 20) {
    addMenuBtn();
  } else {
    setTimeout(tryAdd, 500);
  }
}
setTimeout(tryAdd, 500);
