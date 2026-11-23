import { app } from "../../scripts/app.js";
import { showToast, getSelectedArr, saveToolbarState, restoreToolbarState } from "./utils.js";
import { doBatchConnect } from "./batch-connect.js";
import { doAddBookmark, doShowBookmarks, doNodeSearch } from "./bookmarks-search.js";
import { doCleanUnused, doFixNodeIds } from "./cleanup.js";
import { doLocalizationScan } from "./localization.js";
import { openConsole } from "./livedev-toolkit.js";
import { doZoomToFit, doWorkflowTemplates, doNodePresets, doNodeTags, doBulkEditor, doWorkflowComplete, doNodeThemes, doWireBundles, doAutoReroute, doStatsDashboard, doVoiceCommands, doNodeSandbox, doSmartAutoLayout } from "./advanced.js";
import { ACCENT, LD_ICONS, createGlassModal } from "./livedev-theme.js";

app.registerExtension({
  name: "LiveDev.Toolbar",
  async setup() {},
});

// ---- Alignment functions ----
function doAlign(axis, edge) {
  const nodes = getSelectedArr(); if (nodes.length < 2) return;
  const c = app.canvas; if (!c) return;
  saveToolbarState();
  c.graph?.beforeChange();
  if (axis === "x") {
    const ref = edge === "L" ? Math.min(...nodes.map(n => n.pos[0]))
              : edge === "R" ? Math.max(...nodes.map(n => n.pos[0] + (n.size?.[0] || 200)))
              : (Math.min(...nodes.map(n => n.pos[0] + (n.size?.[0] || 200) / 2)) + Math.max(...nodes.map(n => n.pos[0] + (n.size?.[0] || 200) / 2))) / 2;
    for (const n of nodes) { const w = n.size?.[0] || 200; n.pos = [edge === "L" ? ref : edge === "R" ? ref - w : ref - w / 2, n._pos[1]]; }
  } else {
    const ref = edge === "T" ? Math.min(...nodes.map(n => n.pos[1]))
              : edge === "B" ? Math.max(...nodes.map(n => n.pos[1] + (n.size?.[1] || 100)))
              : (Math.min(...nodes.map(n => n.pos[1] + (n.size?.[1] || 100) / 2)) + Math.max(...nodes.map(n => n.pos[1] + (n.size?.[1] || 100) / 2))) / 2;
    for (const n of nodes) { const h = n.size?.[1] || 100; n.pos = [n._pos[0], edge === "T" ? ref : edge === "B" ? ref - h : ref - h / 2]; }
  }
  c.graph?.afterChange(); c.setDirty(true, true);
}

function doMatchSize(dim) {
  const nodes = getSelectedArr(); if (nodes.length < 2) return;
  const c = app.canvas; if (!c) return;
  saveToolbarState();
  c.graph?.beforeChange();
  if (dim === "w") { const m = Math.max(...nodes.map(n => n.size?.[0] || 200)); for (const n of nodes) n.size = [m, n.size?.[1] || 100]; }
  else { const m = Math.max(...nodes.map(n => n.size?.[1] || 100)); for (const n of nodes) n.size = [n.size?.[0] || 200, m]; }
  c.graph?.afterChange(); c.setDirty(true, true);
}

function doDistribute(axis) {
  const nodes = getSelectedArr(); if (nodes.length < 3) return;
  const c = app.canvas; if (!c) return;
  saveToolbarState();
  c.graph?.beforeChange();
  if (axis === "x") {
    const s = [...nodes].sort((a, b) => (a.pos[0] + (a.size?.[0] || 200) / 2) - (b.pos[0] + (b.size?.[0] || 200) / 2));
    const r = (s[s.length-1].pos[0] + (s[s.length-1].size?.[0] || 200) / 2) - (s[0].pos[0] + (s[0].size?.[0] || 200) / 2);
    const st = r / (s.length - 1), bs = s[0].pos[0] + (s[0].size?.[0] || 200) / 2;
    for (let i = 0; i < s.length; i++) s[i].pos = [bs + i * st - (s[i].size?.[0] || 200) / 2, s[i]._pos[1]];
  } else {
    const s = [...nodes].sort((a, b) => (a.pos[1] + (a.size?.[1] || 100) / 2) - (b.pos[1] + (b.size?.[1] || 100) / 2));
    const r = (s[s.length-1].pos[1] + (s[s.length-1].size?.[1] || 100) / 2) - (s[0].pos[1] + (s[0].size?.[1] || 100) / 2);
    const st = r / (s.length - 1), bs = s[0].pos[1] + (s[0].size?.[1] || 100) / 2;
    for (let i = 0; i < s.length; i++) s[i].pos = [s[i]._pos[0], bs + i * st - (s[i].size?.[1] || 100) / 2];
  }
  c.graph?.afterChange(); c.setDirty(true, true);
}

function doSmartArrange(axis) {
  const nodes = getSelectedArr(); if (nodes.length < 2) return;
  const sorted = [...nodes].sort((a, b) => {
    const ax = axis === "x" ? a.pos[0] : a.pos[1], ay = axis === "x" ? a.pos[1] : a.pos[0];
    const bx = axis === "x" ? b.pos[0] : b.pos[1], by = axis === "x" ? b.pos[1] : b.pos[0];
    return ay - by || ax - bx;
  });
  const c = app.canvas; if (!c) return;
  saveToolbarState();
  c.graph?.beforeChange();
  const gap = 30;
  if (axis === "x") {
    let cx = sorted[0].pos[0];
    const baseY = sorted[0].pos[1];
    for (const n of sorted) { n.pos = [cx, baseY]; cx += (n.size?.[0] || 200) + gap; }
  } else {
    let cy = sorted[0].pos[1];
    const baseX = sorted[0].pos[0];
    for (const n of sorted) { n.pos = [baseX, cy]; cy += (n.size?.[1] || 100) + gap; }
  }
  c.graph?.afterChange(); c.setDirty(true, true);
}

function doSetColor(color) {
  const nodes = getSelectedArr(); if (!nodes.length) return;
  const c = app.canvas; if (!c) return;
  saveToolbarState();
  c.graph?.beforeChange();
  for (const n of nodes) { n.color = color; }
  c.graph?.afterChange(); c.setDirty(true, true);
}

function doSetBgColor(color) {
  const nodes = getSelectedArr(); if (!nodes.length) return;
  const c = app.canvas; if (!c) return;
  saveToolbarState();
  c.graph?.beforeChange();
  for (const n of nodes) { n.bgcolor = color; }
  c.graph?.afterChange(); c.setDirty(true, true);
}

function doResetColor() {
  const nodes = getSelectedArr(); if (!nodes.length) return;
  const c = app.canvas; if (!c) return;
  saveToolbarState();
  c.graph?.beforeChange();
  for (const n of nodes) { n.color = undefined; n.bgcolor = undefined; }
  c.graph?.afterChange(); c.setDirty(true, true);
}

function doFlipNode() {
  const nodes = getSelectedArr(); if (!nodes.length) return;
  const c = app.canvas; if (!c) return;
  saveToolbarState();
  c.graph?.beforeChange();
  for (const n of nodes) { n.flags.collapsed = !n.flags.collapsed; if (n.flags.collapsed) n.computeSize?.(); }
  c.graph?.afterChange(); c.setDirty(true, true);
}

function _snapshotAllNodes() {
  const g = app.canvas?.graph; if (!g) return {};
  const s = {};
  for (const n of g._nodes) {
    s[n.id] = {
      pos: [...n.pos],
      size: n.size ? [...n.size] : null,
      color: n.color, bgcolor: n.bgcolor, mode: n.mode,
      flags: n.flags ? { ...n.flags } : {},
      title: n.title,
      widgets_values: n.widgets_values ? [...n.widgets_values] : null,
      properties: n.properties ? { ...n.properties } : null,
      inputs: n.inputs ? n.inputs.map(inp => ({ link: inp.link })) : null,
    };
  }
  return s;
}

function doUndo() {
  if (!window._undoStack.length) return;
  const c = app.canvas; if (!c || !c.graph) return;
  window._redoStack.push(_snapshotAllNodes());
  if (window._redoStack.length > 20) window._redoStack.shift();
  restoreToolbarState(window._undoStack.pop());
}

function doRedo() {
  if (!window._redoStack.length) return;
  const c = app.canvas; if (!c || !c.graph) return;
  window._undoStack.push(_snapshotAllNodes());
  if (window._undoStack.length > 20) window._undoStack.shift();
  restoreToolbarState(window._redoStack.pop());
}

function doBypass() {
  const nodes = getSelectedArr(); if (!nodes.length) return;
  const c = app.canvas; if (!c) return;
  saveToolbarState(); c.graph?.beforeChange();
  for (const n of nodes) { n.mode = n.mode === 4 ? 0 : 4; n.trigger?.("property:changed", { property: "mode", value: n.mode }); }
  c.graph?.afterChange(); c.change?.(); c.setDirty(true, true);
}

function doDuplicate() {
  const c = app.canvas; if (!c) return;
  if (typeof c.copyToClipboard === "function" && typeof c.pasteFromClipboard === "function") {
    c.copyToClipboard(); c.pasteFromClipboard();
    c.setDirty(true, true);
  }
}

function doLock() {
  const nodes = getSelectedArr(); if (!nodes.length) return;
  const c = app.canvas; if (!c) return;
  saveToolbarState(); c.graph?.beforeChange();
  for (const n of nodes) { n.flags.pinned = !n.flags.pinned; }
  c.graph?.afterChange(); c.setDirty(true, true);
}

function doGroup() {
  const nodes = getSelectedArr(); if (nodes.length < 2) return;
  const c = app.canvas; if (!c || !c.graph) return;
  saveToolbarState(); c.graph.beforeChange();
  const minX = Math.min(...nodes.map(n => n.pos[0]));
  const minY = Math.min(...nodes.map(n => n.pos[1]));
  const maxX = Math.max(...nodes.map(n => n.pos[0] + (n.size?.[0] || 200)));
  const maxY = Math.max(...nodes.map(n => n.pos[1] + (n.size?.[1] || 100)));
  const g = new LiteGraph.LGraphGroup();
  g.title = "Group";
  g.pos = [minX - 20, minY - 30];
  g.size = [maxX - minX + 40, maxY - minY + 40];
  c.graph._groups.push(g);
  c.graph.afterChange(); c.setDirty(true, true);
}

function doUngroup() {
  const nodes = getSelectedArr(); if (!nodes.length) return;
  const c = app.canvas; if (!c || !c.graph) return;
  saveToolbarState(); c.graph.beforeChange();
  c.graph._groups = c.graph._groups.filter(g => !nodes.some(n => {
    const nx = n.pos[0], ny = n.pos[1];
    const gx = g.pos[0], gy = g.pos[1];
    return nx >= gx && ny >= gy && nx <= gx + g.size[0] && ny <= gy + g.size[1];
  }));
  c.graph.afterChange(); c.setDirty(true, true);
}

function doMute() {
  const nodes = getSelectedArr(); if (!nodes.length) return;
  const c = app.canvas; if (!c) return;
  saveToolbarState(); c.graph?.beforeChange();
  for (const n of nodes) { n.mode = n.mode === 2 ? 0 : 2; n.trigger?.("property:changed", { property: "mode", value: n.mode }); }
  c.graph?.afterChange(); c.change?.(); c.setDirty(true, true);
}

function doAutoSize() {
  const nodes = getSelectedArr(); if (!nodes.length) return;
  const c = app.canvas; if (!c) return;
  saveToolbarState(); c.graph?.beforeChange();
  for (const n of nodes) { if (typeof n.computeSize === "function") { n.size = n.computeSize(); } }
  c.graph?.afterChange(); c.setDirty(true, true);
}

function doAdvancedPopup() {
  const { body, close } = createGlassModal({
    title: "Advanced Features",
    subtitle: "Templates, presets, tagging, themes, voice commands, and graph tools.",
    icon: LD_ICONS.sliders,
    width: "520px",
    maxHeight: "82vh",
    draggable: true,
  });

  const features = [
    { label: "Workflow Templates", icon: LD_ICONS.file, fn: doWorkflowTemplates },
    { label: "Node Presets", icon: LD_ICONS.grid, fn: doNodePresets },
    { label: "Node Tags & Filtering", icon: LD_ICONS.tag, fn: doNodeTags },
    { label: "Bulk Node Editor", icon: LD_ICONS.edit, fn: doBulkEditor },
    { label: "Node Themes", icon: LD_ICONS.palette, fn: doNodeThemes },
    { label: "Stats Dashboard", icon: LD_ICONS.chart, fn: doStatsDashboard },
    { label: "Voice Commands", icon: LD_ICONS.mic, fn: doVoiceCommands },
    { label: "Node Sandbox", icon: LD_ICONS.cube, fn: doNodeSandbox },
  ];

  const grid = document.createElement("div");
  grid.className = "ld-tile-grid";
  for (const f of features) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "ld-tile";
    card.innerHTML = `<span class="ld-tile-ico">${f.icon}</span><span>${f.label}</span>`;
    card.addEventListener("click", () => {
      close();
      setTimeout(f.fn, 40);
    });
    grid.appendChild(card);
  }
  body.appendChild(grid);
}

// Uniform 24x24 monoline SVG icons (1.8px stroke, rendered at 15x15)
const svgWrap = (inner) =>
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  inner +
  "</svg>";

const ICON = {
  grip: svgWrap(
    '<circle cx="9" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.2" fill="currentColor" stroke="none"/>' +
    '<circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none"/>' +
    '<circle cx="9" cy="18" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.2" fill="currentColor" stroke="none"/>'
  ),
  resetColor: svgWrap('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  collapse: svgWrap('<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><path d="M9 15h6"/>'),
  alignLeft: svgWrap('<line x1="4" y1="4" x2="4" y2="20"/><rect x="8" y="6" width="12" height="4" rx="1"/><rect x="8" y="14" width="8" height="4" rx="1"/>'),
  alignCenterH: svgWrap('<line x1="12" y1="3" x2="12" y2="21"/><rect x="5" y="6" width="14" height="4" rx="1"/><rect x="7" y="14" width="10" height="4" rx="1"/>'),
  alignRight: svgWrap('<line x1="20" y1="4" x2="20" y2="20"/><rect x="4" y="6" width="12" height="4" rx="1"/><rect x="8" y="14" width="8" height="4" rx="1"/>'),
  alignTop: svgWrap('<line x1="4" y1="4" x2="20" y2="4"/><rect x="6" y="8" width="4" height="12" rx="1"/><rect x="14" y="8" width="4" height="8" rx="1"/>'),
  alignCenterV: svgWrap('<line x1="3" y1="12" x2="21" y2="12"/><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="7" width="4" height="10" rx="1"/>'),
  alignBottom: svgWrap('<line x1="4" y1="20" x2="20" y2="20"/><rect x="6" y="4" width="4" height="12" rx="1"/><rect x="14" y="8" width="4" height="8" rx="1"/>'),
  matchW: svgWrap('<line x1="3" y1="5" x2="3" y2="19"/><line x1="21" y1="5" x2="21" y2="19"/><path d="M7 12h10"/><path d="M10 9l-3 3 3 3"/><path d="M14 9l3 3-3 3"/>'),
  matchH: svgWrap('<line x1="5" y1="3" x2="19" y2="3"/><line x1="5" y1="21" x2="19" y2="21"/><path d="M12 7v10"/><path d="M9 10l3-3 3 3"/><path d="M9 14l3 3 3-3"/>'),
  autoSize: svgWrap('<path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/><rect x="9" y="9" width="6" height="6" rx="1"/>'),
  distH: svgWrap('<line x1="4" y1="4" x2="4" y2="20"/><line x1="20" y1="4" x2="20" y2="20"/><rect x="9" y="7" width="6" height="10" rx="1"/>'),
  distV: svgWrap('<line x1="4" y1="4" x2="20" y2="4"/><line x1="4" y1="20" x2="20" y2="20"/><rect x="7" y="9" width="10" height="6" rx="1"/>'),
  arrangeH: svgWrap('<rect x="3" y="7" width="4.5" height="10" rx="1"/><rect x="9.75" y="7" width="4.5" height="10" rx="1"/><rect x="16.5" y="7" width="4.5" height="10" rx="1"/>'),
  arrangeV: svgWrap('<rect x="7" y="3" width="10" height="4.5" rx="1"/><rect x="7" y="9.75" width="10" height="4.5" rx="1"/><rect x="7" y="16.5" width="10" height="4.5" rx="1"/>'),
  autoLayout: svgWrap('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><path d="M6.5 13v4a2 2 0 0 0 2 2H11"/><path d="M10 6.5h4"/>'),
  undo: svgWrap('<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-2"/>'),
  redo: svgWrap('<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h2"/>'),
  sun: svgWrap('<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="M4.93 4.93l1.41 1.41"/><path d="M17.66 17.66l1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M6.34 17.66l-1.41 1.41"/><path d="M19.07 4.93l-1.41 1.41"/>'),
  moon: svgWrap('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),
  pinOn: svgWrap('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor"/>'),
  pinOff: svgWrap('<circle cx="12" cy="12" r="8"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>'),
  chevDown: svgWrap('<polyline points="6 9 12 15 18 9"/>'),
  chevUp: svgWrap('<polyline points="18 15 12 9 6 15"/>'),
  home: svgWrap('<path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/>'),
  console: svgWrap('<rect x="3" y="4" width="18" height="16" rx="2"/><polyline points="7 9 10 12 7 15"/><line x1="12" y1="15" x2="17" y2="15"/>'),
  search: svgWrap('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  bookmark: svgWrap('<path d="M6 4h12a1 1 0 0 1 1 1v16l-7-4-7 4V5a1 1 0 0 1 1-1z"/>'),
  bypass: svgWrap('<circle cx="12" cy="12" r="9"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/>'),
  mute: svgWrap('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/>'),
  duplicate: svgWrap('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  lock: svgWrap('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  group: svgWrap('<rect x="3" y="3" width="18" height="18" rx="3" stroke-dasharray="3 2.5"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>'),
  ungroup: svgWrap('<rect x="3" y="3" width="18" height="18" rx="3" stroke-dasharray="3 2.5"/><line x1="8" y1="12" x2="16" y2="12"/>'),
  link: svgWrap('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  bundle: svgWrap('<circle cx="5" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="12" r="2"/><path d="M7 6c4 0 4 6 10 6"/><path d="M7 18c4 0 4-6 10-6"/>'),
  reroute: svgWrap('<circle cx="12" cy="12" r="3"/><path d="M3 12h6"/><path d="M15 12h6"/><circle cx="3" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="21" cy="12" r="1.2" fill="currentColor" stroke="none"/>'),
  clean: svgWrap('<polyline points="3 6 5 6 21 6"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
  fixIds: svgWrap('<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>'),
  globe: svgWrap('<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><line x1="3" y1="12" x2="21" y2="12"/>'),
  advanced: svgWrap('<line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2" fill="var(--tb-bg)"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="16" cy="12" r="2" fill="var(--tb-bg)"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="11" cy="18" r="2" fill="var(--tb-bg)"/>'),
};

function _syncThemeButton(light) {
  const tbBtn = window._themeBtn;
  if (!tbBtn) return;
  tbBtn.innerHTML = light ? ICON.moon : ICON.sun;
  tbBtn.dataset.tip = light ? "Switch to dark toolbar" : "Switch to light toolbar";
  tbBtn.setAttribute("aria-label", tbBtn.dataset.tip);
}

export function setToolbarTheme(mode) {
  const normalized = String(mode || "Auto").toLowerCase();
  try {
    if (normalized === "dark" || normalized === "light") {
      localStorage.setItem("livedev_tbTheme", normalized);
    } else {
      localStorage.removeItem("livedev_tbTheme");
    }
  } catch (e) {}
  _applyToolbarTheme();
}

export function setToolbarExpanded(expanded) {
  const on = Boolean(expanded);
  const r2 = document.getElementById("livedev-align-tb-row2");
  const moreBtn = window._tbMoreBtn;
  if (r2) r2.classList.toggle("is-collapsed", !on);
  if (moreBtn) {
    moreBtn.innerHTML = on ? ICON.chevUp : ICON.chevDown;
    moreBtn.dataset.tip = on ? "Collapse extra tools" : "Expand extra tools";
    moreBtn.setAttribute("aria-label", moreBtn.dataset.tip);
  }
  try { localStorage.setItem("livedev_tbExpanded", on ? "1" : "0"); } catch (e) {}
  requestAnimationFrame(clampToolbarToViewport);
}

function doToggleTheme() {
  let cur = false;
  try { cur = localStorage.getItem("livedev_tbTheme") === "light"; } catch (e) {}
  setToolbarTheme(cur ? "dark" : "light");
}

function _applyToolbarTheme() {
  const tb = window._alignToolbar; if (!tb) return;
  let light = false;
  try {
    const t = localStorage.getItem("livedev_tbTheme");
    if (t === "light") light = true;
    else if (t === "dark") light = false;
    else {
      const s = getComputedStyle(document.documentElement);
      for (const v of ["--bg-color", "--comfy-menu-bg", "--fg-color"]) {
        let bg = s.getPropertyValue(v).trim();
        if (!bg) continue;
        if (v === "--fg-color") { const l2 = (0.299*parseInt(bg.slice(1,3),16)+0.587*parseInt(bg.slice(3,5),16)+0.114*parseInt(bg.slice(5,7),16))/255; light = l2 < 0.6; break; }
        const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m) { const l = (0.299*+m[1]+0.587*+m[2]+0.114*+m[3])/255; light = l > 0.6; break; }
        if (bg.startsWith("#")) { const l = (0.299*parseInt(bg.slice(1,3),16)+0.587*parseInt(bg.slice(3,5),16)+0.114*parseInt(bg.slice(5,7),16))/255; light = l > 0.6; break; }
        if (["white","#fff","#ffffff","#f0f0f0","#f5f5f5"].includes(bg)) { light = true; break; }
        break;
      }
      if (typeof light !== "boolean") {
        const b = getComputedStyle(document.body).backgroundColor;
        const m2 = b.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m2) { const l = (0.299*+m2[1]+0.587*+m2[2]+0.114*+m2[3])/255; light = l > 0.6; }
      }
    }
  } catch (e) { light = false; }
  tb.dataset.theme = light ? "light" : "dark";
  _syncThemeButton(light);
}

function clampToolbarToViewport() {
  const tb = window._alignToolbar;
  if (!tb || tb.style.display === "none") return;
  // Only clamp if positioned explicitly by left/top (user dragged it)
  if (tb.style.bottom !== "auto") return;
  const rect = tb.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const pad = 8;
  const maxX = Math.max(pad, window.innerWidth - rect.width - pad);
  const maxY = Math.max(pad, window.innerHeight - rect.height - pad);
  const x = Math.min(Math.max(rect.left, pad), maxX);
  const y = Math.min(Math.max(rect.top, pad), maxY);
  tb.style.left = Math.round(x) + "px";
  tb.style.top = Math.round(y) + "px";
}

export function resetToolbarPosition() {
  const tb = window._alignToolbar;
  try { localStorage.removeItem("livedev_tbPos"); } catch (e) {}
  if (tb) {
    tb.style.left = "50%";
    tb.style.top = "auto";
    tb.style.bottom = "24px";
    tb.style.transform = "translateX(-50%)";
  }
}

function hideToolbarNow() {
  if (window._alignToolbar) window._alignToolbar.style.display = "none";
  window._tbVisible = false;
}

function showToolbar() {
  if (window._alignToolbar && window._tbVisible) return;
  if (!window._alignToolbar) { buildAlignToolbar(); if (!window._alignToolbar) return; }
  _applyToolbarTheme();
  window._alignToolbar.style.display = "flex";
  window._alignToolbar.style.flexDirection = "column";
  window._tbVisible = true;
  requestAnimationFrame(clampToolbarToViewport);
}

/**
 * Set the auto-show state, from the toolbar's own switch or the LiveDev menu, and remember it.
 *
 * On: always visible. Off: out of the way until two or more nodes are selected, and it goes again
 * when the selection drops below two. Off is persisted across reloads and restarts.
 */
export function setToolbarAutoShow(on) {
  window._tbAutoShow = !!on;
  try {
    localStorage.setItem("livedev_tbAutoShow", window._tbAutoShow ? "on" : "off");
  } catch (e) {
    // Private mode and a full quota both land here.
  }
  const btn = window._tbShowBtn;
  if (btn) {
    btn.innerHTML = window._tbAutoShow ? ICON.pinOn : ICON.pinOff;
    btn.classList.toggle("is-active", window._tbAutoShow);
    btn.dataset.tip = window._tbAutoShow ? "Pinned: Always visible (click for 2+ nodes only)" : "Auto-show: 2+ nodes only (click to pin)";
    btn.setAttribute("aria-label", btn.dataset.tip);
  }
  if (window._tbAutoShow) showToolbar();
  else hideToolbarNow();
}

function injectNeonTheme() {
  const existing = document.getElementById("livedev-neon-theme");
  const st = existing || document.createElement("style");
  st.id = "livedev-neon-theme";
  st.textContent = `
#livedev-align-tb {
  --tb-bg: rgba(16, 18, 22, 0.88);
  --tb-border: rgba(255, 255, 255, 0.10);
  --tb-group-bg: rgba(255, 255, 255, 0.035);
  --tb-group-border: rgba(255, 255, 255, 0.06);
  --tb-text: #d8dee6;
  --tb-dim: #7f8794;
  --icon: #cbd3dc;
  --accent: #38c0c4;
  --accent-dim: #1f6f73;
  --danger: #e57373;
  --hover-bg: rgba(56, 192, 196, 0.14);
  --hover-border: rgba(56, 192, 196, 0.42);
  --active-bg: rgba(56, 192, 196, 0.24);
  --tip-bg: rgba(12, 14, 18, 0.96);
  --tip-border: rgba(56, 192, 196, 0.35);
  --tip-text: #eef3f7;
  --sep-bg: rgba(255, 255, 255, 0.10);
  --shadow: 0 14px 38px rgba(0, 0, 0, 0.58), 0 2px 10px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  position: fixed;
  z-index: 999998;
  max-width: calc(100vw - 20px);
  padding: 6px 9px;
  gap: 5px;
  border-radius: 14px;
  background: var(--tb-bg);
  border: 1px solid var(--tb-border);
  color: var(--tb-text);
  box-shadow: var(--shadow);
  backdrop-filter: blur(16px) saturate(145%);
  -webkit-backdrop-filter: blur(16px) saturate(145%);
  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  font-size: 11px;
  user-select: none;
  box-sizing: border-box;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
#livedev-align-tb::before {
  content: "";
  position: absolute;
  top: -1px;
  left: 16%;
  right: 16%;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(56, 192, 196, 0.6), transparent);
  pointer-events: none;
}
#livedev-align-tb[data-theme="light"] {
  --tb-bg: rgba(247, 249, 252, 0.90);
  --tb-border: rgba(15, 23, 42, 0.12);
  --tb-group-bg: rgba(15, 23, 42, 0.035);
  --tb-group-border: rgba(15, 23, 42, 0.07);
  --tb-text: #1e242b;
  --tb-dim: #66707c;
  --icon: #2c343d;
  --accent: #1f6f73;
  --accent-dim: #38c0c4;
  --hover-bg: rgba(31, 111, 115, 0.11);
  --hover-border: rgba(31, 111, 115, 0.36);
  --active-bg: rgba(31, 111, 115, 0.20);
  --tip-bg: rgba(22, 26, 32, 0.96);
  --tip-border: rgba(31, 111, 115, 0.45);
  --tip-text: #f3f6f9;
  --sep-bg: rgba(15, 23, 42, 0.12);
  --shadow: 0 12px 32px rgba(15, 23, 42, 0.16), 0 2px 8px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.8);
}
#livedev-align-tb .ld-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  flex-wrap: wrap;
}
#livedev-align-tb-row2 {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  flex-wrap: wrap;
  padding-top: 5px;
  border-top: 1px solid var(--tb-group-border);
}
#livedev-align-tb-row2.is-collapsed {
  display: none !important;
}
#livedev-align-tb .ld-group {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 9px;
  background: var(--tb-group-bg);
  border: 1px solid var(--tb-group-border);
}
#livedev-align-tb .ld-grip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 28px;
  color: var(--tb-dim);
  cursor: grab;
  border-radius: 6px;
  transition: color 0.15s ease, background 0.15s ease;
}
#livedev-align-tb .ld-grip:hover {
  color: var(--accent);
  background: var(--hover-bg);
}
#livedev-align-tb .ld-sel-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 22px;
  padding: 0 6px;
  border-radius: 999px;
  font-family: Consolas, monospace;
  font-size: 10.5px;
  font-weight: 700;
  color: var(--tb-dim);
  background: var(--tb-group-bg);
  border: 1px solid var(--tb-group-border);
  letter-spacing: 0.02em;
  transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
}
#livedev-align-tb .ld-sel-badge.has-sel {
  color: var(--accent);
  background: var(--hover-bg);
  border-color: var(--hover-border);
}
#livedev-align-tb button {
  position: relative;
  width: 28px;
  height: 28px;
  padding: 0;
  margin: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--icon);
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease, transform 0.12s ease, box-shadow 0.14s ease;
}
#livedev-align-tb button svg {
  display: block;
  pointer-events: none;
}
#livedev-align-tb button:hover {
  color: var(--accent);
  background: var(--hover-bg);
  border-color: var(--hover-border);
  transform: translateY(-1px);
  box-shadow: 0 3px 10px rgba(56, 192, 196, 0.16);
}
#livedev-align-tb button:active {
  transform: scale(0.92);
  background: var(--active-bg);
}
#livedev-align-tb button.is-active {
  color: var(--accent);
  background: var(--hover-bg);
  border-color: var(--hover-border);
}
#livedev-align-tb button.is-danger:hover {
  color: var(--danger);
  background: rgba(229, 115, 115, 0.14);
  border-color: rgba(229, 115, 115, 0.42);
  box-shadow: 0 3px 10px rgba(229, 115, 115, 0.16);
}
#livedev-align-tb button[data-tip]::after {
  content: attr(data-tip);
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%) translateY(4px);
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--tip-bg);
  border: 1px solid var(--tip-border);
  color: var(--tip-text);
  font-family: 'Segoe UI', system-ui, sans-serif;
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
  transition: opacity 0.14s ease 0.1s, transform 0.14s ease 0.1s;
  z-index: 10;
}
#livedev-align-tb button[data-tip]:hover::after {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
#livedev-align-tb button.livedev-pill {
  width: auto !important;
  height: 28px !important;
  padding: 0 11px !important;
  border-radius: 8px !important;
  font-size: 11.5px !important;
  font-weight: 600 !important;
  color: var(--accent) !important;
  background: var(--hover-bg) !important;
  border: 1px solid var(--hover-border) !important;
  letter-spacing: 0.01em;
}
#livedev-align-tb button.livedev-pill:hover {
  background: var(--active-bg) !important;
  border-color: var(--accent) !important;
  box-shadow: 0 0 14px rgba(56, 192, 196, 0.28) !important;
}
#livedev-align-tb-row2 > span {
  height: 18px !important;
  background: var(--sep-bg) !important;
  margin: 0 2px !important;
}
#livedev-align-tb .ld-swatch {
  width: 20px;
  height: 20px;
  padding: 0;
  margin: 0 2px;
  border-radius: 50%;
  border: 1.5px solid rgba(255, 255, 255, 0.28);
  background: transparent;
  cursor: pointer;
  overflow: hidden;
  transition: transform 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease;
}
#livedev-align-tb[data-theme="light"] .ld-swatch {
  border-color: rgba(15, 23, 42, 0.25);
}
#livedev-align-tb .ld-swatch:hover {
  transform: scale(1.12);
  border-color: var(--accent);
  box-shadow: 0 0 8px rgba(56, 192, 196, 0.35);
}
#livedev-align-tb .ld-swatch::-webkit-color-swatch-wrapper {
  padding: 0;
}
#livedev-align-tb .ld-swatch::-webkit-color-swatch {
  border: none;
  border-radius: 50%;
}
`;
  if (!existing) document.head.appendChild(st);
}

function buildAlignToolbar() {
  if (window._alignToolbar) return;
  const tb = document.createElement("div");
  tb.id = "livedev-align-tb";
  tb.dataset.theme = "dark";
  tb.style.cssText = "bottom:24px;left:50%;transform:translateX(-50%);display:none;";

  function makeIconBtn(iconSvg, tip, fn, extraClass) {
    const el = document.createElement("button");
    el.type = "button";
    el.innerHTML = iconSvg;
    el.dataset.tip = tip;
    el.setAttribute("aria-label", tip);
    if (extraClass) el.className = extraClass;
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      fn();
    });
    return el;
  }

  function makeGroup(items) {
    const g = document.createElement("div");
    g.className = "ld-group";
    for (const item of items) g.appendChild(item);
    return g;
  }

  // ---- Row 1: Primary Alignment & Layout Dock ----
  const row1 = document.createElement("div");
  row1.className = "ld-row";

  // Drag grip (double-click to re-center)
  const grip = document.createElement("div");
  grip.className = "ld-grip";
  grip.innerHTML = ICON.grip;
  grip.title = "Drag to move · Double-click to center";
  grip.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    resetToolbarPosition();
    showToast("LiveDev: toolbar centered");
  });
  row1.appendChild(grip);

  // Live selection count badge
  const selBadge = document.createElement("div");
  selBadge.className = "ld-sel-badge";
  selBadge.textContent = "0";
  selBadge.title = "Selected nodes";
  window._tbSelBadge = selBadge;
  row1.appendChild(selBadge);

  // Color swatches + reset + collapse
  const cInput = document.createElement("input");
  cInput.type = "color";
  cInput.value="#4a90d9";
  cInput.className = "ld-swatch";
  cInput.title = "Node title color";
  cInput.addEventListener("input", () => doSetColor(cInput.value));
  cInput.addEventListener("click", (e) => e.stopPropagation());

  const bInput = document.createElement("input");
  bInput.type = "color";
  bInput.value="#3a3a3a";
  bInput.className = "ld-swatch";
  bInput.title = "Node body color";
  bInput.addEventListener("input", () => doSetBgColor(bInput.value));
  bInput.addEventListener("click", (e) => e.stopPropagation());

  row1.appendChild(makeGroup([
    cInput,
    bInput,
    makeIconBtn(ICON.resetColor, "Reset node colors", doResetColor),
    makeIconBtn(ICON.collapse, "Collapse / Expand nodes", doFlipNode),
  ]));

  // Align Horizontal
  row1.appendChild(makeGroup([
    makeIconBtn(ICON.alignLeft, "Align Left", () => doAlign("x", "L")),
    makeIconBtn(ICON.alignCenterH, "Align Center X", () => doAlign("x", "C")),
    makeIconBtn(ICON.alignRight, "Align Right", () => doAlign("x", "R")),
  ]));

  // Align Vertical
  row1.appendChild(makeGroup([
    makeIconBtn(ICON.alignTop, "Align Top", () => doAlign("y", "T")),
    makeIconBtn(ICON.alignCenterV, "Align Center Y", () => doAlign("y", "C")),
    makeIconBtn(ICON.alignBottom, "Align Bottom", () => doAlign("y", "B")),
  ]));

  // Size & Distribute
  row1.appendChild(makeGroup([
    makeIconBtn(ICON.matchW, "Match Width", () => doMatchSize("w")),
    makeIconBtn(ICON.matchH, "Match Height", () => doMatchSize("h")),
    makeIconBtn(ICON.autoSize, "Auto-size Nodes", doAutoSize),
    makeIconBtn(ICON.distH, "Distribute Horizontally", () => doDistribute("x")),
    makeIconBtn(ICON.distV, "Distribute Vertically", () => doDistribute("y")),
  ]));

  // Smart Arrange & Auto-Layout
  row1.appendChild(makeGroup([
    makeIconBtn(ICON.arrangeH, "Smart Arrange Row", () => doSmartArrange("x")),
    makeIconBtn(ICON.arrangeV, "Smart Arrange Column", () => doSmartArrange("y")),
    makeIconBtn(ICON.autoLayout, "Smart Auto-Layout", doSmartAutoLayout),
  ]));

  // Undo / Redo
  row1.appendChild(makeGroup([
    makeIconBtn(ICON.undo, "Undo layout", doUndo, "is-danger"),
    makeIconBtn(ICON.redo, "Redo layout", doRedo, "is-danger"),
  ]));

  // Dock controls: Expand/Collapse Row 2, Theme, Pin/Auto-show
  let row2Expanded = true;
  try { row2Expanded = localStorage.getItem("livedev_tbExpanded") !== "0"; } catch (e) {}

  const r2 = document.createElement("div");
  r2.id = "livedev-align-tb-row2";
  if (!row2Expanded) r2.classList.add("is-collapsed");

  const moreBtn = makeIconBtn(
    row2Expanded ? ICON.chevUp : ICON.chevDown,
    row2Expanded ? "Collapse extra tools" : "Expand extra tools",
    () => {
      const currentlyExpanded = !r2.classList.contains("is-collapsed");
      setToolbarExpanded(!currentlyExpanded);
    }
  );
  window._tbMoreBtn = moreBtn;

  window._themeBtn = makeIconBtn(ICON.sun, "Switch to light toolbar", doToggleTheme);

  window._tbShowBtn = makeIconBtn(
    ICON.pinOn,
    "Pinned: Always visible (click for 2+ nodes only)",
    () => setToolbarAutoShow(!window._tbAutoShow),
    "is-active"
  );

  row1.appendChild(makeGroup([moreBtn, window._themeBtn, window._tbShowBtn]));
  tb.appendChild(row1);

  // ---- Row 2: Secondary Tools Drawer ----
  // Navigation & Views
  r2.appendChild(makeGroup([
    makeIconBtn(ICON.home, "Fit graph to view", doZoomToFit),
    makeIconBtn(ICON.console, "Live Console", openConsole),
    makeIconBtn(ICON.search, "Node Search", doNodeSearch),
    makeIconBtn(ICON.bookmark, "Bookmarks (click with selection to add)", () => {
      const s = getSelectedArr();
      if (s.length) doAddBookmark();
      else doShowBookmarks();
    }),
  ]));

  // Node State Actions
  r2.appendChild(makeGroup([
    makeIconBtn(ICON.bypass, "Bypass nodes (mode 4)", doBypass),
    makeIconBtn(ICON.mute, "Mute nodes (mode 2)", doMute),
    makeIconBtn(ICON.duplicate, "Duplicate selection", doDuplicate),
    makeIconBtn(ICON.lock, "Pin / Lock toggle", doLock),
  ]));

  // Group & Wiring
  r2.appendChild(makeGroup([
    makeIconBtn(ICON.group, "Group selected nodes", doGroup),
    makeIconBtn(ICON.ungroup, "Ungroup selected", doUngroup),
    makeIconBtn(ICON.link, "Batch Connect", doBatchConnect),
    makeIconBtn(ICON.bundle, "Wire Bundles", doWireBundles),
    makeIconBtn(ICON.reroute, "Auto-Reroute", doAutoReroute),
  ]));

  // Cleanup & Utilities
  r2.appendChild(makeGroup([
    makeIconBtn(ICON.clean, "Clean Orphaned Nodes", doCleanUnused, "is-danger"),
    makeIconBtn(ICON.fixIds, "Fix Duplicate Node IDs", doFixNodeIds),
    makeIconBtn(ICON.globe, "Localization Scanner", doLocalizationScan),
    makeIconBtn(ICON.advanced, "Advanced Features...", doAdvancedPopup),
  ]));

  tb.appendChild(r2);

  // Dragging with viewport safety clamping
  let dragging = false, dOffX = 0, dOffY = 0;
  try {
    const saved = localStorage.getItem("livedev_tbPos");
    if (saved) {
      const p = JSON.parse(saved);
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        tb.style.left = p.x + "px";
        tb.style.top = p.y + "px";
        tb.style.bottom = "auto";
        tb.style.transform = "none";
      }
    }
  } catch (e) {}

  tb.addEventListener("mousedown", (e) => {
    if (e.target.closest?.("button") || e.target.closest?.("input")) return;
    dragging = true;
    const r = tb.getBoundingClientRect();
    tb.style.bottom = "auto";
    tb.style.transform = "none";
    tb.style.left = r.left + "px";
    tb.style.top = r.top + "px";
    dOffX = e.clientX - r.left;
    dOffY = e.clientY - r.top;
    grip.style.cursor = "grabbing";
    e.preventDefault();
  });
  const stopToolbarDrag = () => {
    if (!dragging) return;
    dragging = false;
    grip.style.cursor = "grab";
    const x = parseInt(tb.style.left, 10);
    const y = parseInt(tb.style.top, 10);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      try { localStorage.setItem("livedev_tbPos", JSON.stringify({ x, y })); } catch (e) {}
    }
  };
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    if (e.buttons === 0) {
      stopToolbarDrag();
      return;
    }
    const pad = 8;
    const rect = tb.getBoundingClientRect();
    const maxX = Math.max(pad, window.innerWidth - rect.width - pad);
    const maxY = Math.max(pad, window.innerHeight - rect.height - pad);
    const nx = Math.min(Math.max(e.clientX - dOffX, pad), maxX);
    const ny = Math.min(Math.max(e.clientY - dOffY, pad), maxY);
    tb.style.left = Math.round(nx) + "px";
    tb.style.top = Math.round(ny) + "px";
  }, true);
  window.addEventListener("mouseup", stopToolbarDrag, true);
  window.addEventListener("pointerup", stopToolbarDrag, true);
  window.addEventListener("blur", stopToolbarDrag);
  window.addEventListener("resize", clampToolbarToViewport);

  window._alignToolbar = tb;
  document.body.appendChild(tb);
}

// Init: inject dock theme, build toolbar eagerly (hidden), start monitor
injectNeonTheme();
buildAlignToolbar();
if (window._alignToolbar) window._alignToolbar.style.display = "none";
if (!window._tbMon) {
  window._tbMon = setInterval(() => {
    const n = getSelectedArr();
    const badge = window._tbSelBadge;
    if (badge) {
      const text = n.length > 0 ? `${n.length}` : "0";
      if (badge.textContent !== text) badge.textContent = text;
      badge.classList.toggle("has-sel", n.length > 0);
    }
    if (window._tbAutoShow) showToolbar();
    else if (n.length >= 2) showToolbar();
    else hideToolbarNow();
  }, 300);
}
// Restore the persisted auto-show state. Off survives reloads and restarts; selecting 2+ nodes
// or toggling Toolbar from the LiveDev menu brings it back.
try {
  if (localStorage.getItem("livedev_tbAutoShow") === "off") setToolbarAutoShow(false);
} catch (e) {}
_applyToolbarTheme();