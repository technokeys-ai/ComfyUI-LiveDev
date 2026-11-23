// The pack's unified visual identity and shared glassmorphic UI primitives.
//
// ComfyUI's own theme is a set of CSS variables on :root, while floating panels and dialogs sit in
// fixed overlays above the canvas. This module is the single source of truth for the pack's palette,
// monoline SVG icons, glass modal chrome, buttons, inputs, badges, and Reka-UI focus isolation.

import { app } from "../../scripts/app.js";

export const ACCENT = "#38c0c4";
export const ACCENT_DIM = "#1f6f73";
export const DANGER = "#e57373";
export const DANGER_DIM = "#6a3a3a";

// Surfaces run deep -> raised, so a panel inside a dialog is lighter than the dialog it sits in.
export const SURFACE_DEEP = "#0f0f0f";
export const SURFACE = "#1a1a1a";
export const SURFACE_RAISED = "#2a2a2a";
export const BORDER = "#444";
export const BORDER_SOFT = "#333";

export const TEXT = "#ddd";
export const TEXT_DIM = "#aaa";
export const TEXT_FAINT = "#888";

export const FONT_UI = "'Segoe UI',system-ui,-apple-system,sans-serif";
export const FONT_MONO = "Consolas,monospace";

// Shared inline style maps (used by modules that build DOM with Object.assign)
export const PANEL = {
  background: "rgba(16, 18, 22, 0.93)",
  border: "1px solid rgba(255, 255, 255, 0.10)",
  borderRadius: "14px",
  color: "#d8dee6",
  fontFamily: FONT_UI,
  fontSize: "12.5px",
  backdropFilter: "blur(18px) saturate(145%)",
  boxShadow: "0 20px 56px rgba(0, 0, 0, 0.70), 0 2px 10px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.08)",
};

export const BUTTON = {
  cursor: "pointer",
  background: "rgba(255, 255, 255, 0.05)",
  border: "1px solid rgba(255, 255, 255, 0.12)",
  color: "#d8dee6",
  borderRadius: "8px",
  padding: "6px 12px",
  fontSize: "12px",
  fontWeight: "600",
  fontFamily: FONT_UI,
};
export const BUTTON_ACCENT = {
  ...BUTTON,
  background: "rgba(56, 192, 196, 0.16)",
  border: `1px solid ${ACCENT}`,
  color: ACCENT,
};
export const BUTTON_DANGER = {
  ...BUTTON,
  background: "rgba(229, 115, 115, 0.14)",
  border: `1px solid ${DANGER_DIM}`,
  color: DANGER,
};

// Minimal geometric 24x24 monoline SVG helper (1.85px round stroke)
export function svgIcon(shapes, size = 15) {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    shapes +
    "</svg>"
  );
}

// Unified monoline geometric icon set shared across every LiveDev panel, toolbar, and popup
export const LD_ICONS = {
  bolt: svgIcon('<polygon points="13 2 4 14 11 14 10 22 20 10 13 10 13 2"/>'),
  sliders: svgIcon('<line x1="4" y1="7" x2="20" y2="7"/><circle cx="9" cy="7" r="2.2"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2.2"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="11" cy="17" r="2.2"/>'),
  search: svgIcon('<circle cx="10.5" cy="10.5" r="6.5"/><line x1="15.5" y1="15.5" x2="20.5" y2="20.5"/>'),
  folder: svgIcon('<path d="M3 6h6l2 2h10v10H3z"/>'),
  box: svgIcon('<polygon points="12 3 21 7.5 21 16.5 12 21 3 16.5 3 7.5"/><line x1="3" y1="7.5" x2="12" y2="12"/><line x1="21" y1="7.5" x2="12" y2="12"/><line x1="12" y1="12" x2="12" y2="21"/>'),
  history: svgIcon('<circle cx="12" cy="12" r="8.5"/><polyline points="12 7.5 12 12 15.5 14"/>'),
  terminal: svgIcon('<rect x="3" y="4" width="18" height="16" rx="2.5"/><polyline points="7 9 10 12 7 15"/><line x1="12.5" y1="15" x2="17" y2="15"/>'),
  code: svgIcon('<polyline points="8 7 3 12 8 17"/><polyline points="16 7 21 12 16 17"/><line x1="13.5" y1="5" x2="10.5" y2="19"/>'),
  trace: svgIcon('<polyline points="3 12 7 12 10 5 14 19 17 12 21 12"/>'),
  file: svgIcon('<polygon points="6 3 14 3 19 8 19 21 6 21"/><polyline points="14 3 14 8 19 8"/><line x1="9" y1="13" x2="16" y2="13"/><line x1="9" y1="17" x2="14" y2="17"/>'),
  shield: svgIcon('<polygon points="12 3 20 6 19 14 12 21 5 14 4 6"/><polyline points="9 12 11 14 15.5 9.5"/>'),
  save: svgIcon('<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="8" y="4" width="8" height="5"/><rect x="7" y="13" width="10" height="7"/>'),
  grid: svgIcon('<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>'),
  palette: svgIcon('<circle cx="12" cy="12" r="8.5"/><circle cx="9" cy="9.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="14.5" cy="9" r="1.3" fill="currentColor" stroke="none"/><circle cx="15.5" cy="14" r="1.3" fill="currentColor" stroke="none"/><circle cx="9.5" cy="14.5" r="1.3" fill="currentColor" stroke="none"/>'),
  tag: svgIcon('<polygon points="4 4 12 4 20 12 12 20 4 12"/><circle cx="8.5" cy="8.5" r="1.4" fill="currentColor" stroke="none"/>'),
  edit: svgIcon('<polygon points="4 20 8 19 19 8 16 5 5 16"/><line x1="13.5" y1="7.5" x2="16.5" y2="10.5"/>'),
  chart: svgIcon('<line x1="4" y1="20" x2="20" y2="20"/><rect x="5.5" y="12" width="3" height="8"/><rect x="10.5" y="7" width="3" height="13"/><rect x="15.5" y="10" width="3" height="10"/>'),
  mic: svgIcon('<rect x="9" y="3.5" width="6" height="10" rx="3"/><path d="M6 11a6 6 0 0 0 12 0"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="9" y1="21" x2="15" y2="21"/>'),
  cube: svgIcon('<rect x="4" y="4" width="16" height="16" rx="2.5"/><circle cx="9" cy="9" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="15" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1.2" fill="currentColor" stroke="none"/>'),
  bookmark: svgIcon('<polygon points="6 3.5 18 3.5 18 20.5 12 16 6 20.5"/>'),
  link: svgIcon('<rect x="3" y="8.5" width="8.5" height="7" rx="3.5"/><rect x="12.5" y="8.5" width="8.5" height="7" rx="3.5"/><line x1="9" y1="12" x2="15" y2="12"/>'),
  trash: svgIcon('<line x1="4" y1="6.5" x2="20" y2="6.5"/><rect x="9" y="3.5" width="6" height="3"/><polygon points="6 6.5 18 6.5 17 20.5 7 20.5"/>'),
  hash: svgIcon('<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="9.5" y1="4" x2="8" y2="20"/><line x1="16" y1="4" x2="14.5" y2="20"/>'),
  globe: svgIcon('<circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="4" ry="8.5"/><line x1="3.5" y1="12" x2="20.5" y2="12"/>'),
  bug: svgIcon('<rect x="8" y="8" width="8" height="11" rx="4"/><line x1="4" y1="11" x2="8" y2="11"/><line x1="16" y1="11" x2="20" y2="11"/><line x1="4" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="20" y2="16"/><line x1="9" y1="5" x2="10.5" y2="8"/><line x1="15" y1="5" x2="13.5" y2="8"/>'),
  refresh: svgIcon('<path d="M20 12a8 8 0 1 1-2.5-5.8"/><polyline points="20 4 20 9 15 9"/>'),
  undo: svgIcon('<polyline points="8 6 4 10 8 14"/><path d="M4 10h11a5 5 0 0 1 0 10h-3"/>'),
  check: svgIcon('<polyline points="5 12.5 10 17.5 19.5 7.5"/>'),
  chevronDown: svgIcon('<polyline points="6 9 12 15 18 9"/>', 13),
};

const CSS = `
:root {
  --livedev-accent: ${ACCENT};
  --livedev-accent-dim: ${ACCENT_DIM};
  --livedev-danger: ${DANGER};
  --livedev-danger-dim: ${DANGER_DIM};
  --livedev-surface: ${SURFACE};
  --livedev-surface-raised: ${SURFACE_RAISED};
  --livedev-border: ${BORDER};
  --livedev-text: ${TEXT};
  --livedev-text-dim: ${TEXT_DIM};
}
.ld-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.72);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  z-index: 2147483000;
  pointer-events: auto !important;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  font-family: ${FONT_UI};
  box-sizing: border-box;
}
.ld-modal {
  position: relative;
  pointer-events: auto !important;
  display: flex;
  flex-direction: column;
  max-width: 96vw;
  max-height: 88vh;
  border-radius: 14px;
  background: rgba(16, 18, 22, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.10);
  box-shadow: 0 22px 60px rgba(0, 0, 0, 0.72), 0 2px 12px rgba(0, 0, 0, 0.40), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(18px) saturate(145%);
  -webkit-backdrop-filter: blur(18px) saturate(145%);
  color: #d8dee6;
  overflow: hidden;
  box-sizing: border-box;
  font-family: ${FONT_UI};
  font-size: 12.5px;
}
.ld-modal::before {
  content: "";
  position: absolute;
  top: -1px;
  left: 16%;
  right: 16%;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(56, 192, 196, 0.65), transparent);
  pointer-events: none;
}
.ld-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 13px 18px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.025);
  flex-shrink: 0;
  user-select: none;
}
.ld-modal-head.is-draggable {
  cursor: grab;
}
.ld-modal-title-wrap {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.ld-modal-title {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0;
  font-size: 14.5px;
  font-weight: 600;
  color: #fff;
}
.ld-modal-title-ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: rgba(56, 192, 196, 0.14);
  border: 1px solid rgba(56, 192, 196, 0.35);
  color: ${ACCENT};
  flex-shrink: 0;
}
.ld-modal-sub {
  margin: 3px 0 0 35px;
  font-size: 11.5px;
  color: #8f98a5;
}
.ld-modal-close {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  border: 1px solid transparent;
  background: transparent;
  color: #9aa3b0;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  flex-shrink: 0;
  transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
}
.ld-modal-close:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.14);
  color: #fff;
}
.ld-modal-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 18px;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}
.ld-modal-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 11px 18px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.025);
  flex-shrink: 0;
}
.ld-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 13px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.05);
  color: #d8dee6;
  font-family: ${FONT_UI};
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease, transform 0.12s ease, box-shadow 0.14s ease;
}
.ld-btn:hover {
  background: rgba(56, 192, 196, 0.14);
  border-color: rgba(56, 192, 196, 0.45);
  color: #fff;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(56, 192, 196, 0.15);
}
.ld-btn:active {
  transform: scale(0.96);
}
.ld-btn:disabled {
  opacity: 0.55;
  cursor: default;
  transform: none;
  box-shadow: none;
}
.ld-btn-primary {
  background: ${ACCENT_DIM};
  border-color: ${ACCENT};
  color: #fff;
}
.ld-btn-primary:hover {
  background: rgba(56, 192, 196, 0.28);
  border-color: ${ACCENT};
}
.ld-btn-danger {
  background: rgba(229, 115, 115, 0.14);
  border-color: ${DANGER_DIM};
  color: ${DANGER};
}
.ld-btn-danger:hover {
  background: rgba(229, 115, 115, 0.24);
  border-color: ${DANGER};
  color: #fff;
  box-shadow: 0 4px 12px rgba(229, 115, 115, 0.20);
}
.ld-input,
.ld-select {
  padding: 7px 11px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.11);
  background: rgba(255, 255, 255, 0.045);
  color: #e6ecf2;
  font-family: ${FONT_UI};
  font-size: 12.5px;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.14s ease, box-shadow 0.14s ease, background 0.14s ease;
}
.ld-input:focus,
.ld-select:focus {
  border-color: ${ACCENT};
  background: rgba(56, 192, 196, 0.06);
  box-shadow: 0 0 0 2px rgba(56, 192, 196, 0.18);
}
.ld-select option {
  background: #16181c;
  color: #e6ecf2;
}
.ld-tile-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(150px, 1fr));
  gap: 8px;
}
.ld-tile {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.035);
  color: #d8dee6;
  cursor: pointer;
  font-family: ${FONT_UI};
  font-size: 12.5px;
  font-weight: 500;
  text-align: left;
  transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease, transform 0.12s ease, box-shadow 0.14s ease;
}
.ld-tile .ld-tile-ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  color: ${ACCENT};
  flex-shrink: 0;
  transition: background 0.14s ease;
}
.ld-tile:hover {
  background: rgba(56, 192, 196, 0.14);
  border-color: rgba(56, 192, 196, 0.45);
  color: #fff;
  transform: translateY(-1px);
  box-shadow: 0 5px 14px rgba(56, 192, 196, 0.16);
}
.ld-tile:hover .ld-tile-ico {
  background: rgba(56, 192, 196, 0.22);
}
.ld-row-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 11px;
  margin-bottom: 5px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(255, 255, 255, 0.03);
  cursor: pointer;
  transition: background 0.14s ease, border-color 0.14s ease;
}
.ld-row-item:hover {
  background: rgba(56, 192, 196, 0.12);
  border-color: rgba(56, 192, 196, 0.36);
}
.ld-toast {
  position: fixed;
  top: 64px;
  left: 50%;
  transform: translateX(-50%) translateY(-6px);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 16px;
  border-radius: 999px;
  background: rgba(16, 18, 22, 0.94);
  border: 1px solid rgba(56, 192, 196, 0.42);
  color: #eef3f7;
  font-family: ${FONT_UI};
  font-size: 12.5px;
  font-weight: 500;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55), 0 0 14px rgba(56, 192, 196, 0.16);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  z-index: 2147483001;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.ld-toast.is-visible {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
.ld-toast-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: ${ACCENT};
  box-shadow: 0 0 8px ${ACCENT};
  flex-shrink: 0;
}
`;

export function ensureTheme() {
  if (typeof document === "undefined" || !document.head) return;
  const existing = document.getElementById("livedev-theme");
  const style = existing || document.createElement("style");
  style.id = "livedev-theme";
  style.textContent = CSS;
  if (!existing) document.head.appendChild(style);
}

/**
 * Isolate a LiveDev overlay from ComfyUI Settings' Reka-UI focus trap and pointer-events lock.
 * Deliberately leaves mouseup/pointerup unblocked so window drag handlers always release cleanly.
 */
export function isolateModalEvents(overlay) {
  if (!overlay) return;
  overlay.setAttribute("data-dismissable-layer", "");
  for (const evtName of ["pointerdown", "mousedown", "focusin", "focusout"]) {
    overlay.addEventListener(evtName, (e) => e.stopPropagation());
  }
}

/**
 * Create a unified LiveDev glassmorphic modal dialog.
 */
export function createGlassModal({
  title,
  subtitle = "",
  icon = LD_ICONS.sliders,
  width = "560px",
  maxHeight = "85vh",
  draggable = true,
  onClose = null,
} = {}) {
  ensureTheme();
  const overlay = document.createElement("div");
  overlay.className = "ld-overlay";
  isolateModalEvents(overlay);

  const modal = document.createElement("div");
  modal.className = "ld-modal";
  modal.style.width = width;
  modal.style.maxHeight = maxHeight;
  modal.onclick = (e) => e.stopPropagation();

  let dragCleanup = null;
  const close = () => {
    document.removeEventListener("keydown", onEsc, true);
    if (dragCleanup) dragCleanup();
    overlay.remove();
    if (onClose) onClose();
  };
  const onEsc = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onEsc, true);
  overlay.onclick = (e) => {
    e.stopPropagation();
    if (e.target === overlay) close();
  };

  // Header
  const header = document.createElement("div");
  header.className = "ld-modal-head" + (draggable ? " is-draggable" : "");
  const titleWrap = document.createElement("div");
  titleWrap.className = "ld-modal-title-wrap";

  const titleEl = document.createElement("h3");
  titleEl.className = "ld-modal-title";
  const icoSpan = document.createElement("span");
  icoSpan.className = "ld-modal-title-ico";
  icoSpan.innerHTML = icon;
  const textSpan = document.createElement("span");
  textSpan.textContent = title || "LiveDev";
  titleEl.appendChild(icoSpan);
  titleEl.appendChild(textSpan);
  titleWrap.appendChild(titleEl);

  if (subtitle) {
    const subEl = document.createElement("div");
    subEl.className = "ld-modal-sub";
    subEl.textContent = subtitle;
    titleWrap.appendChild(subEl);
  }

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ld-modal-close";
  closeBtn.textContent = "\u2715";
  closeBtn.title = "Close (Esc)";
  closeBtn.onclick = close;

  header.appendChild(titleWrap);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  // Body
  const body = document.createElement("div");
  body.className = "ld-modal-body";
  modal.appendChild(body);

  // Optional footer (caller can populate or hide)
  const footer = document.createElement("div");
  footer.className = "ld-modal-foot";
  footer.style.display = "none";
  modal.appendChild(footer);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  if (draggable) {
    let dragging = false;
    let offX = 0;
    let offY = 0;
    const stopDrag = () => {
      if (!dragging) return;
      dragging = false;
      header.style.cursor = "grab";
    };
    const onMove = (e) => {
      if (!dragging) return;
      if (e.buttons === 0) {
        stopDrag();
        return;
      }
      const x = Math.max(8, Math.min(e.clientX - offX, window.innerWidth - 80));
      const y = Math.max(8, Math.min(e.clientY - offY, window.innerHeight - 40));
      modal.style.left = Math.round(x) + "px";
      modal.style.top = Math.round(y) + "px";
    };
    header.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.target.closest("button")) return;
      dragging = true;
      const r = modal.getBoundingClientRect();
      modal.style.position = "fixed";
      modal.style.left = r.left + "px";
      modal.style.top = r.top + "px";
      modal.style.margin = "0";
      offX = e.clientX - r.left;
      offY = e.clientY - r.top;
      header.style.cursor = "grabbing";
      e.preventDefault();
    });
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", stopDrag, true);
    window.addEventListener("pointerup", stopDrag, true);
    window.addEventListener("blur", stopDrag);
    dragCleanup = () => {
      stopDrag();
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", stopDrag, true);
      window.removeEventListener("pointerup", stopDrag, true);
      window.removeEventListener("blur", stopDrag);
    };
  }

  return { overlay, modal, header, body, footer, close };
}

app.registerExtension({
  name: "LiveDev.Theme",
  setup() {
    ensureTheme();
  },
});

ensureTheme();
