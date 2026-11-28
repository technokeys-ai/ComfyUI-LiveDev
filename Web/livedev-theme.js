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
  brand:
    `<svg width="16" height="16" viewBox="0 0 64 64" fill="none" aria-hidden="true">` +
    `<path d="M42.9,18.6c8.59,6.02,10.68,17.87,4.66,26.46-6.02,8.59-17.87,10.68-26.46,4.66-8.59-6.02-10.68-17.87-4.66-26.46,1.27-1.81,2.85-3.39,4.66-4.66" ` +
    `fill="none" stroke="${ACCENT}" stroke-linecap="round" stroke-width="7"/>` +
    `<path d="M33.61,10.83l4.65,14.76,10.64-11.97-15.29-2.79Z" fill="${ACCENT}"/>` +
    "</svg>",
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
  eye: svgIcon('<path d="M2 12s3.8-6.5 10-6.5S22 12 22 12s-3.8 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>'),
  eyeOff: svgIcon('<path d="M17.94 17.94A10.9 10.9 0 0 1 12 19.5c-6.2 0-10-7.5-10-7.5a18.6 18.6 0 0 1 4.18-5.12"/><path d="M9.88 5.24A10.7 10.7 0 0 1 12 4.5c6.2 0 10 7.5 10 7.5a18.5 18.5 0 0 1-2.55 3.63"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="3" y1="3" x2="21" y2="21"/>'),
  plus: svgIcon('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  alert: svgIcon('<polygon points="12 3 21.5 19.5 2.5 19.5"/><line x1="12" y1="10" x2="12" y2="14"/><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none"/>'),
  power: svgIcon('<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2.5" x2="12" y2="12"/>'),
  fold: svgIcon('<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>'),
  snapGuides: svgIcon('<line x1="4" y1="4" x2="4" y2="20"/><line x1="4" y1="12" x2="20" y2="12" stroke-dasharray="2.5 2.5"/><rect x="8.5" y="5" width="7" height="4.5" rx="1"/><rect x="8.5" y="14.5" width="11" height="4.5" rx="1"/>'),
  gallery: svgIcon('<rect x="3" y="3" width="8" height="8" rx="1.8"/><rect x="13" y="3" width="8" height="8" rx="1.8"/><rect x="3" y="13" width="8" height="8" rx="1.8"/><rect x="13" y="13" width="8" height="8" rx="1.8"/><circle cx="6.2" cy="6.2" r="0.9" fill="currentColor" stroke="none"/><path d="M13.8 18.5l2.2-2.2 1.8 1.5 2.4-2.8"/>'),
  star: svgIcon('<polygon points="12 3 14.9 8.9 21.4 9.8 16.7 14.4 17.8 20.9 12 17.8 6.2 20.9 7.3 14.4 2.6 9.8 9.1 8.9"/>', 14),
  starFilled: svgIcon('<polygon points="12 3 14.9 8.9 21.4 9.8 16.7 14.4 17.8 20.9 12 17.8 6.2 20.9 7.3 14.4 2.6 9.8 9.1 8.9" fill="currentColor"/>', 14),
  camera: svgIcon('<path d="M4 8h3l1.5-2h7L17 8h3a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 20 20H4a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 4 8z"/><circle cx="12" cy="13.5" r="3.2"/>', 14),
  listView: svgIcon('<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><rect x="3.5" y="4.5" width="3" height="3" rx="0.6"/><rect x="3.5" y="10.5" width="3" height="3" rx="0.6"/><rect x="3.5" y="16.5" width="3" height="3" rx="0.6"/>', 14),
  tileView: svgIcon('<rect x="3" y="4" width="11" height="7" rx="1.4"/><rect x="16" y="4" width="5" height="7" rx="1.4"/><rect x="3" y="13" width="5" height="7" rx="1.4"/><rect x="10" y="13" width="11" height="7" rx="1.4"/>', 14),
  expand: svgIcon('<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>', 14),
  sidebar: svgIcon('<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/>', 14),
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
  top: 104px;
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
  pointer-events: auto;
  cursor: pointer;
  user-select: none;
  opacity: 0;
  transition: opacity 0.18s ease, transform 0.18s ease, border-color 0.15s ease;
}
.ld-toast:hover {
  border-color: ${ACCENT};
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
.ld-err-card {
  position: fixed;
  z-index: 95000;
  width: 344px;
  min-width: 344px;
  max-width: 344px;
  box-sizing: border-box;
  border-radius: 14px;
  background: rgba(16, 18, 22, 0.94);
  border: 1px solid rgba(229, 115, 115, 0.30);
  box-shadow: 0 20px 52px rgba(0, 0, 0, 0.72), 0 2px 12px rgba(0, 0, 0, 0.40), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(18px) saturate(145%);
  -webkit-backdrop-filter: blur(18px) saturate(145%);
  color: #d8dee6;
  font-family: ${FONT_UI};
  font-size: 12px;
  transform: none;
  zoom: 1;
  overflow: visible;
  pointer-events: auto;
}
.ld-err-card::before {
  content: "";
  position: absolute;
  top: -1px;
  left: 16%;
  right: 16%;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(229, 115, 115, 0.80), transparent);
  pointer-events: none;
  z-index: 2;
}
.ld-err-caret {
  position: absolute;
  bottom: -6px;
  left: var(--ld-caret-x, 50%);
  width: 10px;
  height: 10px;
  margin-left: -5px;
  transform: rotate(45deg);
  background: rgba(16, 18, 22, 0.96);
  border-right: 1px solid rgba(229, 115, 115, 0.30);
  border-bottom: 1px solid rgba(229, 115, 115, 0.30);
  pointer-events: none;
  z-index: 1;
}
.ld-err-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: linear-gradient(180deg, rgba(229, 115, 115, 0.08), rgba(255, 255, 255, 0.015));
  border-radius: 13px 13px 0 0;
}
.ld-err-title-wrap {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  flex: 1;
}
.ld-err-ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: rgba(229, 115, 115, 0.14);
  border: 1px solid rgba(229, 115, 115, 0.36);
  color: ${DANGER};
  flex-shrink: 0;
}
.ld-err-title-col {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}
.ld-err-title {
  font-size: 12.5px;
  font-weight: 600;
  color: #fff;
  line-height: 1.25;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ld-err-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  color: #8f98a5;
  line-height: 1.2;
}
.ld-err-type {
  font-family: ${FONT_MONO};
  font-size: 10px;
  font-weight: 600;
  color: ${DANGER};
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ld-err-body {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ld-err-msg {
  padding: 7px 10px;
  border-radius: 8px;
  background: rgba(229, 115, 115, 0.08);
  border: 1px solid rgba(229, 115, 115, 0.22);
  color: #eef3f7;
  font-family: ${FONT_MONO};
  font-size: 11px;
  line-height: 1.45;
  word-break: break-word;
  max-height: 68px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
}
.ld-err-tb {
  background: rgba(8, 10, 13, 0.84);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 9px;
  padding: 8px 10px;
  margin: 0;
  max-height: 112px;
  overflow: auto;
  color: #b9c3d0;
  font-family: ${FONT_MONO};
  font-size: 10.5px;
  line-height: 1.48;
  white-space: pre-wrap;
  word-break: break-word;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
}
.ld-err-msg::-webkit-scrollbar,
.ld-err-tb::-webkit-scrollbar {
  width: 5px;
  height: 5px;
}
.ld-err-msg::-webkit-scrollbar-track,
.ld-err-tb::-webkit-scrollbar-track {
  background: transparent;
}
.ld-err-msg::-webkit-scrollbar-thumb,
.ld-err-tb::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.18);
  border-radius: 999px;
}
.ld-err-msg::-webkit-scrollbar-thumb:hover,
.ld-err-tb::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.30);
}
.ld-err-fix {
  padding: 8px 10px;
  border-radius: 9px;
  background: rgba(56, 192, 196, 0.09);
  border: 1px solid rgba(56, 192, 196, 0.32);
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.ld-err-fix-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 700;
  color: ${ACCENT};
}
.ld-err-fix-head svg {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
}
.ld-err-fix-desc {
  font-size: 11px;
  color: #cfd6df;
  line-height: 1.4;
}
.ld-err-fix-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 2px;
}
.ld-err-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 8px 12px 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.025);
  border-radius: 0 0 13px 13px;
  position: relative;
  z-index: 2;
}
.ld-err-btn {
  flex: 1 1 auto;
  padding: 5px 9px;
  font-size: 11.5px;
  border-radius: 8px;
  gap: 5px;
}
.ld-err-btn svg {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
}
.litemenu-entry .ld-ctx-label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  vertical-align: middle;
}
.litemenu-entry .ld-ctx-label svg {
  width: 16px;
  height: 16px;
  display: block;
  flex-shrink: 0;
}
.ld-slot-pill {
  position: fixed;
  z-index: 96000;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 7px;
  border-radius: 12px;
  background: rgba(16, 18, 22, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.65), 0 2px 8px rgba(0, 0, 0, 0.36), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(16px) saturate(145%);
  -webkit-backdrop-filter: blur(16px) saturate(145%);
  color: #d8dee6;
  font-family: ${FONT_UI};
  font-size: 11.5px;
  box-sizing: border-box;
  pointer-events: auto;
  user-select: none;
}
.ld-slot-pill::before {
  content: "";
  position: absolute;
  top: -1px;
  left: 18%;
  right: 18%;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(56, 192, 196, 0.65), transparent);
  pointer-events: none;
}
.ld-slot-pill-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 6px 0 4px;
  max-width: 118px;
  color: #9aa3b0;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ld-slot-pill-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.ld-slot-pill-sep {
  width: 1px;
  height: 18px;
  background: rgba(255, 255, 255, 0.10);
  margin: 0 2px;
  flex-shrink: 0;
}
.ld-slot-pill-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 28px;
  padding: 0;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: #d8dee6;
  cursor: pointer;
  transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease, transform 0.10s ease;
}
.ld-slot-pill-btn svg {
  width: 15px;
  height: 15px;
  display: block;
}
.ld-slot-pill-btn:hover {
  background: rgba(56, 192, 196, 0.16);
  border-color: rgba(56, 192, 196, 0.42);
  color: #fff;
}
.ld-slot-pill-btn:active {
  transform: scale(0.94);
}
.ld-slot-pill-btn.is-active {
  background: rgba(56, 192, 196, 0.18);
  border-color: rgba(56, 192, 196, 0.48);
  color: ${ACCENT};
}
.ld-slot-pill-btn.is-danger:hover {
  background: rgba(229, 115, 115, 0.18);
  border-color: rgba(229, 115, 115, 0.50);
  color: ${DANGER};
}
.ld-slot-pill-btn:disabled {
  opacity: 0.34;
  cursor: default;
  pointer-events: none;
}
.ld-slot-pill-input {
  width: 136px;
  height: 26px;
  padding: 0 8px;
  border-radius: 7px;
  border: 1px solid ${ACCENT};
  background: rgba(8, 10, 13, 0.85);
  color: #eef3f7;
  font-family: ${FONT_UI};
  font-size: 11.5px;
  outline: none;
  box-sizing: border-box;
}
.ld-bp-root {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border-radius: 10px;
  background: linear-gradient(180deg, rgba(20, 23, 29, 0.96), rgba(13, 15, 20, 0.97));
  border: 1px solid rgba(255, 255, 255, 0.09);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
  color: #d8dee6;
  font-family: ${FONT_UI};
  font-size: 12px;
  box-sizing: border-box;
  overflow: hidden;
  user-select: none;
}
.ld-bp-root::before {
  content: "";
  position: absolute;
  top: 0;
  left: 16%;
  right: 16%;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(56, 192, 196, 0.65), transparent);
  pointer-events: none;
}
.ld-bp-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  flex-shrink: 0;
}
.ld-bp-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: #9aa3b0;
  min-width: 0;
  white-space: nowrap;
}
.ld-bp-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: ${ACCENT};
  box-shadow: 0 0 8px rgba(56, 192, 196, 0.65);
  flex-shrink: 0;
}
.ld-bp-status-dot.is-warn {
  background: ${DANGER};
  box-shadow: 0 0 8px rgba(229, 115, 115, 0.65);
}
.ld-bp-status-dot.is-off {
  background: rgba(255, 255, 255, 0.25);
  box-shadow: none;
}
.ld-bp-bar-btns {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.ld-bp-ico-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 24px;
  min-width: 24px;
  padding: 0 6px;
  border-radius: 7px;
  border: 1px solid rgba(255, 255, 255, 0.10);
  background: rgba(255, 255, 255, 0.04);
  color: #cbd3dc;
  font-family: ${FONT_UI};
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease;
}
.ld-bp-ico-btn svg {
  width: 13px;
  height: 13px;
  display: block;
  flex-shrink: 0;
}
.ld-bp-ico-btn:hover {
  background: rgba(56, 192, 196, 0.16);
  border-color: rgba(56, 192, 196, 0.45);
  color: #fff;
}
.ld-bp-ico-btn.is-active {
  background: rgba(56, 192, 196, 0.18);
  border-color: rgba(56, 192, 196, 0.50);
  color: ${ACCENT};
}
.ld-bp-ico-btn.is-danger:hover {
  background: rgba(229, 115, 115, 0.18);
  border-color: rgba(229, 115, 115, 0.50);
  color: ${DANGER};
}
.ld-bp-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 5px;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.16) transparent;
}
.ld-bp-list::-webkit-scrollbar {
  width: 4px;
}
.ld-bp-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.16);
  border-radius: 999px;
}
.ld-bp-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 18px 10px;
  border-radius: 9px;
  border: 1px dashed rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.02);
  color: #8f98a5;
  font-size: 11.5px;
  text-align: center;
}
.ld-bp-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  background: rgba(255, 255, 255, 0.024);
}
.ld-bp-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-height: 24px;
}
.ld-bp-group-left {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  flex: 1;
  cursor: pointer;
}
.ld-bp-chev {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #8f98a5;
  transition: transform 0.14s ease;
  flex-shrink: 0;
}
.ld-bp-chev.is-collapsed {
  transform: rotate(-90deg);
}
.ld-bp-group-title {
  font-size: 11.5px;
  font-weight: 700;
  color: #eef3f7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ld-bp-count {
  font-family: ${FONT_MONO};
  font-size: 10px;
  color: #8f98a5;
  padding: 1px 5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}
.ld-bp-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 7px;
  padding: 5px 7px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(255, 255, 255, 0.032);
  transition: background 0.14s ease, border-color 0.14s ease, opacity 0.14s ease;
}
.ld-bp-row:hover {
  background: rgba(56, 192, 196, 0.08);
  border-color: rgba(56, 192, 196, 0.28);
}
.ld-bp-row.is-off {
  opacity: 0.68;
  background: rgba(255, 255, 255, 0.018);
}
.ld-bp-row.is-missing {
  border-color: rgba(229, 115, 115, 0.42);
  background: rgba(229, 115, 115, 0.09);
}
.ld-bp-row-main {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  flex: 1;
}
.ld-bp-switch {
  position: relative;
  width: 30px;
  height: 16px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.08);
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.ld-bp-switch::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #9aa3b0;
  transition: transform 0.15s ease, background 0.15s ease;
}
.ld-bp-switch.is-on {
  background: rgba(56, 192, 196, 0.26);
  border-color: ${ACCENT};
}
.ld-bp-switch.is-on::after {
  transform: translateX(14px);
  background: ${ACCENT};
  box-shadow: 0 0 6px rgba(56, 192, 196, 0.75);
}
.ld-bp-switch.is-mute {
  background: rgba(229, 115, 115, 0.16);
  border-color: rgba(229, 115, 115, 0.48);
}
.ld-bp-switch.is-mute::after {
  background: ${DANGER};
}
.ld-bp-name {
  font-size: 11.5px;
  font-weight: 500;
  color: #e6ecf2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1;
  cursor: pointer;
}
.ld-bp-id {
  font-family: ${FONT_MONO};
  font-size: 10px;
  color: #8f98a5;
  flex-shrink: 0;
}
.ld-bp-row-acts {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
}
.ld-bp-mini {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 22px;
  min-width: 22px;
  padding: 0 5px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: #9aa3b0;
  font-family: ${FONT_MONO};
  font-size: 10px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.13s ease, border-color 0.13s ease, color 0.13s ease;
}
.ld-bp-mini svg {
  width: 13px;
  height: 13px;
  display: block;
}
.ld-bp-mini:hover {
  background: rgba(56, 192, 196, 0.16);
  border-color: rgba(56, 192, 196, 0.40);
  color: #fff;
}
.ld-bp-mini.is-danger {
  color: ${DANGER};
}
.ld-bp-mini.is-danger:hover {
  background: rgba(229, 115, 115, 0.18);
  border-color: rgba(229, 115, 115, 0.48);
  color: ${DANGER};
}
.ld-bp-mini.is-mute-tag {
  color: ${DANGER};
  border-color: rgba(229, 115, 115, 0.30);
  background: rgba(229, 115, 115, 0.10);
}
.ld-bp-mini.is-byp-tag {
  color: ${ACCENT};
  border-color: rgba(56, 192, 196, 0.25);
  background: rgba(56, 192, 196, 0.08);
}
.ld-vf-cmd-fold,
.ld-vf-cmd-fold-group,
.ld-vf-cmd-unfold,
.ld-vf-cmd-rename {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  height: 22px;
  box-sizing: border-box;
  padding: 0 9px;
  border: 1px solid rgba(56, 192, 196, 0.72);
  border-radius: 999px;
  background: rgba(16, 18, 22, 0.94);
  color: ${ACCENT};
  font: 700 11.5px/1 ${FONT_UI};
  font-style: normal;
  white-space: nowrap;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
}
.ld-vf-cmd-fold::before { content: "Fold"; }
.ld-vf-cmd-fold-group::before { content: "Fold Group"; }
.ld-vf-cmd-unfold::before { content: "Unfold"; }
.ld-vf-cmd-rename::before { content: "Rename"; }
.ld-fold-tip {
  position: fixed;
  z-index: 95500;
  min-width: 196px;
  max-width: 280px;
  padding: 9px 11px;
  border-radius: 12px;
  background: rgba(16, 18, 22, 0.94);
  border: 1px solid rgba(56, 192, 196, 0.36);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.68), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(16px) saturate(145%);
  -webkit-backdrop-filter: blur(16px) saturate(145%);
  color: #d8dee6;
  font-family: ${FONT_UI};
  font-size: 11.5px;
  pointer-events: none;
  box-sizing: border-box;
}
.ld-fold-tip::before {
  content: "";
  position: absolute;
  top: -1px;
  left: 18%;
  right: 18%;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(56, 192, 196, 0.75), transparent);
}
.ld-fold-tip-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 6px;
  margin-bottom: 6px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  font-weight: 700;
  color: #fff;
}
.ld-fold-tip-badge {
  font-family: ${FONT_MONO};
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(56, 192, 196, 0.16);
  border: 1px solid rgba(56, 192, 196, 0.40);
  color: ${ACCENT};
}
.ld-fold-tip-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  color: #cfd6df;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ld-fold-tip-id {
  font-family: ${FONT_MONO};
  font-size: 10px;
  color: #8f98a5;
  flex-shrink: 0;
}
.ld-fold-tip-foot {
  margin-top: 6px;
  padding-top: 5px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 10px;
  color: #8f98a5;
}
/* ---- Workflow Gallery ---- */
.ld-wfg-shell {
  display: flex;
  flex-direction: column;
  height: 76vh;
  min-height: 440px;
  gap: 10px;
}
.ld-wfg-topbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ld-wfg-tabs {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.ld-wfg-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  background: rgba(255, 255, 255, 0.03);
  color: #aeb7c4;
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease;
}
.ld-wfg-tab:hover {
  border-color: rgba(56, 192, 196, 0.42);
  color: #fff;
}
.ld-wfg-tab.is-active {
  background: rgba(56, 192, 196, 0.16);
  border-color: ${ACCENT};
  color: ${ACCENT};
}
.ld-wfg-tab-cnt {
  font-family: ${FONT_MONO};
  font-size: 10px;
  opacity: 0.78;
}
.ld-wfg-controls {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  padding: 7px 10px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.025);
  border: 1px solid rgba(255, 255, 255, 0.07);
}
.ld-wfg-search {
  flex: 1 1 200px;
  min-width: 150px;
  height: 30px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.10);
  background: rgba(8, 10, 14, 0.72);
  color: #eef3f7;
  font-size: 12px;
  outline: none;
  box-sizing: border-box;
}
.ld-wfg-search:focus {
  border-color: ${ACCENT};
}
.ld-wfg-select {
  height: 30px;
  padding: 0 8px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.10);
  background: rgba(8, 10, 14, 0.78);
  color: #d8dee6;
  font-size: 11.5px;
  outline: none;
  cursor: pointer;
}
.ld-wfg-seg {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: rgba(8, 10, 14, 0.64);
  border: 1px solid rgba(255, 255, 255, 0.08);
}
.ld-wfg-seg-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  height: 24px;
  padding: 0 7px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: #9ba5b4;
  font-size: 11px;
  font-weight: 700;
  font-family: ${FONT_MONO};
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
}
.ld-wfg-seg-btn:hover {
  color: #fff;
  background: rgba(255, 255, 255, 0.06);
}
.ld-wfg-seg-btn.is-active {
  color: ${ACCENT};
  background: rgba(56, 192, 196, 0.18);
  border-color: rgba(56, 192, 196, 0.45);
}
.ld-wfg-main {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  gap: 10px;
}
.ld-wfg-sidebar {
  width: 235px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px;
  border-radius: 10px;
  background: rgba(10, 12, 16, 0.65);
  border: 1px solid rgba(255, 255, 255, 0.07);
  overflow-y: auto;
}
.ld-wfg-sidebar.is-hidden {
  display: none;
}
.ld-wfg-dir-group {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: ${ACCENT};
  padding: 9px 6px 3px;
  opacity: 0.85;
}
.ld-wfg-dir-row {
  display: flex;
  align-items: center;
  gap: 2px;
}
.ld-wfg-dir-chev {
  width: 18px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: #8b95a5;
  font-size: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: color 0.12s ease, background 0.12s ease;
}
.ld-wfg-dir-chev:hover {
  color: ${ACCENT};
  background: rgba(255, 255, 255, 0.06);
}
.ld-wfg-dir-chev.is-spacer {
  visibility: hidden;
  pointer-events: none;
}
.ld-wfg-dir-children {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-left: 14px;
  padding-left: 6px;
  border-left: 1px solid rgba(255, 255, 255, 0.07);
}
.ld-wfg-dir-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 5px 8px;
  border-radius: 7px;
  border: 1px solid transparent;
  background: transparent;
  color: #c5cdd8;
  font-size: 11.5px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
}
.ld-wfg-dir-btn.is-parent {
  font-weight: 600;
  color: #e6ecf4;
}
.ld-wfg-dir-btn:hover {
  background: rgba(255, 255, 255, 0.05);
  color: #fff;
}
.ld-wfg-dir-btn.is-active {
  background: rgba(56, 192, 196, 0.15);
  border-color: rgba(56, 192, 196, 0.40);
  color: ${ACCENT};
}
.ld-wfg-dir-name {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ld-wfg-dir-cnt {
  font-family: ${FONT_MONO};
  font-size: 10px;
  color: #828c9a;
  flex-shrink: 0;
}
.ld-wfg-content {
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
  padding-right: 4px;
}
.ld-wfg-grid {
  display: grid;
  gap: 10px;
  align-content: start;
}
.ld-wfg-grid.view-grid.size-s { grid-template-columns: repeat(auto-fill, minmax(158px, 1fr)); }
.ld-wfg-grid.view-grid.size-m { grid-template-columns: repeat(auto-fill, minmax(226px, 1fr)); }
.ld-wfg-grid.view-grid.size-l { grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); }
.ld-wfg-grid.view-grid.size-xl { grid-template-columns: repeat(auto-fill, minmax(410px, 1fr)); }
.ld-wfg-grid.view-tiles.size-s { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.ld-wfg-grid.view-tiles.size-m { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 9px; }
.ld-wfg-grid.view-tiles.size-l { grid-template-columns: repeat(auto-fill, minmax(315px, 1fr)); gap: 10px; }
.ld-wfg-grid.view-tiles.size-xl { grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 12px; }
.ld-wfg-grid.view-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ld-wfg-card {
  position: relative;
  display: flex;
  flex-direction: column;
  border-radius: 11px;
  overflow: hidden;
  background: rgba(18, 22, 28, 0.86);
  border: 1px solid rgba(255, 255, 255, 0.08);
  cursor: pointer;
  transition: transform 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease;
}
.ld-wfg-card:hover {
  transform: translateY(-2px);
  border-color: rgba(56, 192, 196, 0.55);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(56, 192, 196, 0.18);
}
.ld-wfg-thumb-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 10;
  background: #0d1117;
  overflow: hidden;
}
.ld-wfg-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.25s ease;
}
.ld-wfg-card:hover .ld-wfg-thumb {
  transform: scale(1.03);
}
.ld-wfg-badges {
  position: absolute;
  top: 7px;
  left: 7px;
  display: flex;
  gap: 4px;
  pointer-events: none;
}
.ld-wfg-pill {
  padding: 2px 6px;
  border-radius: 6px;
  background: rgba(12, 14, 18, 0.84);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #d8dee6;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  backdrop-filter: blur(6px);
}
.ld-wfg-pill.is-accent {
  border-color: rgba(56, 192, 196, 0.45);
  color: ${ACCENT};
}
.ld-wfg-actions {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.14s ease;
}
.ld-wfg-card:hover .ld-wfg-actions,
.ld-wfg-card.is-fav .ld-wfg-actions {
  opacity: 1;
}
.ld-wfg-act {
  width: 26px;
  height: 26px;
  padding: 0;
  border-radius: 7px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(12, 14, 18, 0.86);
  color: #cfd6df;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  backdrop-filter: blur(8px);
  transition: border-color 0.12s ease, color 0.12s ease, background 0.12s ease;
}
.ld-wfg-act:hover {
  border-color: ${ACCENT};
  color: ${ACCENT};
  background: rgba(56, 192, 196, 0.22);
}
.ld-wfg-act.is-fav {
  color: ${ACCENT};
  border-color: rgba(56, 192, 196, 0.55);
}
.ld-wfg-meta {
  padding: 8px 10px 9px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.ld-wfg-title {
  font-size: 12px;
  font-weight: 600;
  color: #edf2f7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ld-wfg-sub {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 10.5px;
  color: #8b95a5;
}
.ld-wfg-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 auto;
}
.ld-wfg-stat {
  font-family: ${FONT_MONO};
  font-size: 10px;
  color: ${ACCENT};
  flex-shrink: 0;
}
/* Tile showcase mode */
.ld-wfg-grid.view-tiles .ld-wfg-meta {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 18px 10px 8px;
  background: linear-gradient(180deg, transparent, rgba(10, 12, 16, 0.92) 55%);
}
.ld-wfg-grid.view-tiles .ld-wfg-thumb-wrap {
  aspect-ratio: 4 / 3;
}
/* Detailed list mode */
.ld-wfg-grid.view-list .ld-wfg-card {
  flex-direction: row;
  align-items: center;
  gap: 12px;
  padding: 6px 10px 6px 6px;
}
.ld-wfg-grid.view-list .ld-wfg-card:hover {
  transform: none;
}
.ld-wfg-grid.view-list.size-s .ld-wfg-thumb-wrap { width: 68px; height: 42px; aspect-ratio: auto; border-radius: 6px; flex-shrink: 0; }
.ld-wfg-grid.view-list.size-m .ld-wfg-thumb-wrap { width: 96px; height: 60px; aspect-ratio: auto; border-radius: 7px; flex-shrink: 0; }
.ld-wfg-grid.view-list.size-l .ld-wfg-thumb-wrap { width: 136px; height: 84px; aspect-ratio: auto; border-radius: 8px; flex-shrink: 0; }
.ld-wfg-grid.view-list.size-xl .ld-wfg-thumb-wrap { width: 184px; height: 112px; aspect-ratio: auto; border-radius: 9px; flex-shrink: 0; }
.ld-wfg-grid.view-list .ld-wfg-badges { display: none; }
.ld-wfg-grid.view-list .ld-wfg-meta {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0;
}
.ld-wfg-grid.view-list .ld-wfg-actions {
  position: static;
  opacity: 1;
  flex-shrink: 0;
}
.ld-wfg-empty {
  text-align: center;
  padding: 54px 16px;
  color: #8892a0;
  font-size: 13px;
}
.ld-wfg-more-row {
  display: flex;
  justify-content: center;
  padding: 12px 0 6px;
}
.ld-wfg-lightbox-img {
  width: 100%;
  max-height: 54vh;
  object-fit: contain;
  border-radius: 10px;
  background: #0b0e13;
  border: 1px solid rgba(255, 255, 255, 0.08);
}
.ld-wfg-lightbox-meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 8px;
  margin-top: 10px;
}
.ld-wfg-kv {
  padding: 7px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.07);
}
.ld-wfg-kv-k {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #8892a0;
}
.ld-wfg-kv-v {
  margin-top: 2px;
  font-size: 12px;
  color: #e6ecf4;
  font-family: ${FONT_MONO};
  word-break: break-all;
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
