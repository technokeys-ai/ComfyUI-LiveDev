// LiveDev Visual Fold - collapse selected nodes or ComfyUI groups into a compact
// glassmorphic pill without converting them into a Subgraph (preserves Get/Set, node IDs,
// and exact workflow execution semantics).

import { app } from "../../scripts/app.js";
import { showToast } from "./utils.js";
import {
  ACCENT_DIM,
  LD_ICONS,
  createGlassModal,
  ensureTheme,
} from "./livedev-theme.js";

const EXTENSION_NAME = "LiveDev.VisualFold";
const META_KEY = "__livedevVisualFold";
const DOM_HIDDEN_KEY = "__livedevFoldDomHidden";
const CHIP_W = 168;
const CHIP_MAX_W = 264;
const CHIP_H = 28;
const HIDDEN_W = 2;
const HIDDEN_H = 2;
const HIDDEN_TITLE = "\u200b";
const LABEL_MAX_LEN = 34;
const HOVER_MAX_ITEMS = 12;

const CMD = Object.freeze({
  fold: "livedev.visualFold.fold",
  foldGroup: "livedev.visualFold.foldGroup",
  unfold: "livedev.visualFold.unfold",
  rename: "livedev.visualFold.rename",
});

let _tipEl = null;
let _lastHoverAnchorId = null;

function activeGraph() {
  return app.canvas?.graph || app.graph || null;
}

function graphNodes() {
  return activeGraph()?._nodes || [];
}

function graphGroups() {
  const g = activeGraph();
  const list = g?._groups || g?.groups || [];
  return Array.isArray(list) ? list : [];
}

function markDirty() {
  activeGraph()?.setDirtyCanvas?.(true, true);
  app.canvas?.setDirty?.(true, true);
  if (typeof app.canvas?.draw === "function") app.canvas.draw(true, true);
}

export function foldMeta(node) {
  return node?.properties?.[META_KEY] || null;
}

export function isSameFoldGroup(srcNode, tgtNode) {
  const m1 = foldMeta(srcNode);
  const m2 = foldMeta(tgtNode);
  return Boolean(m1 && m2 && m1.groupId && m1.groupId === m2.groupId);
}

function isHiddenMember(node) {
  const m = foldMeta(node);
  return Boolean(m && m.index !== 0);
}

function normalizeLabel(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, LABEL_MAX_LEN);
}

function displayLabel(meta) {
  return normalizeLabel(meta?.label) || "Folded";
}

function chipWidthFor(meta) {
  const lbl = displayLabel(meta);
  const est = 86 + lbl.length * 7.8 + String(meta?.count ?? "").length * 8;
  return Math.min(CHIP_MAX_W, Math.max(CHIP_W, Math.round(est)));
}

function storeOwn(owner, key) {
  return {
    has: Object.prototype.hasOwnProperty.call(owner, key),
    value: owner[key],
  };
}

function restoreOwn(owner, key, saved) {
  if (!saved) return;
  if (saved.has) owner[key] = saved.value;
  else delete owner[key];
}

function nodeSize(node) {
  return [
    Math.max(1, Number(node?.size?.[0] || 160)),
    Math.max(1, Number(node?.size?.[1] || 80)),
  ];
}

function groupBounds(group) {
  if (!group) return null;
  const raw = group.boundingRect || group._bounding || group.bounding || group.getBounding?.();
  if (raw && raw.length >= 4) {
    return {
      x: Number(raw[0] || 0),
      y: Number(raw[1] || 0),
      w: Number(raw[2] || 0),
      h: Number(raw[3] || 0),
    };
  }
  const pos = group.pos || group._pos;
  const size = group.size || group._size;
  if (pos && size) {
    return {
      x: Number(pos[0] || 0),
      y: Number(pos[1] || 0),
      w: Number(size[0] || 0),
      h: Number(size[1] || 0),
    };
  }
  return null;
}

function setGroupBounds(group, x, y, w, h) {
  if (!group) return;
  const raw = group.boundingRect || group._bounding || group.bounding || group.getBounding?.();
  if (raw && raw.length >= 4) {
    if (Number.isFinite(x)) raw[0] = x;
    if (Number.isFinite(y)) raw[1] = y;
    if (Number.isFinite(w)) raw[2] = Math.max(1, w);
    if (Number.isFinite(h)) raw[3] = Math.max(1, h);
    return;
  }
  if (group.pos) {
    if (Number.isFinite(x)) group.pos[0] = x;
    if (Number.isFinite(y)) group.pos[1] = y;
  }
  if (group.size) {
    if (Number.isFinite(w)) group.size[0] = Math.max(1, w);
    if (Number.isFinite(h)) group.size[1] = Math.max(1, h);
  }
}

function nodesInGroup(group) {
  const box = groupBounds(group);
  if (!box) return [];
  return graphNodes().filter((n) => {
    if (!n || !n.pos || foldMeta(n)) return false;
    const [w, h] = nodeSize(n);
    const cx = Number(n.pos[0] || 0) + w * 0.5;
    const cy = Number(n.pos[1] || 0) + h * 0.5;
    return cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h;
  });
}

function groupSnapshot(group) {
  const box = groupBounds(group);
  if (!box) return null;
  return {
    id: group.id,
    title: group.title,
    bounding: [box.x, box.y, box.w, box.h],
    color: storeOwn(group, "color"),
    fontSize: storeOwn(group, "font_size"),
    flags: { ...(group.flags || {}) },
  };
}

function findGroupBySnapshot(snap) {
  if (!snap) return null;
  const groups = graphGroups();
  return (
    groups.find((g) => g && snap.id != null && String(g.id) === String(snap.id)) ||
    groups.find((g) => g && g.title === snap.title) ||
    null
  );
}

function restoreGroupSnapshot(snap, dx = 0, dy = 0) {
  const grp = findGroupBySnapshot(snap);
  if (!grp || !Array.isArray(snap?.bounding)) return null;
  setGroupBounds(
    grp,
    Number(snap.bounding[0] || 0) + dx,
    Number(snap.bounding[1] || 0) + dy,
    Number(snap.bounding[2] || 0),
    Number(snap.bounding[3] || 0),
  );
  grp.title = snap.title;
  grp.flags = { ...(snap.flags || {}) };
  restoreOwn(grp, "color", snap.color);
  restoreOwn(grp, "font_size", snap.fontSize);
  return grp;
}

function collapseGroupToChip(group, anchor) {
  const meta = foldMeta(anchor);
  if (!group || !anchor || !meta) return;
  const pos = anchor.pos || meta.basePos || [0, 0];
  const w = chipWidthFor(meta);
  setGroupBounds(group, Number(pos[0] || 0) - 6, Number(pos[1] || 0) - 6, w + 12, CHIP_H + 12);
  group.title = "";
  group.color = "rgba(0,0,0,0)";
  group.flags = { ...(group.flags || {}), livedevVisualFoldCollapsed: true };
  group.selected = false;
}

// ----------------------------------------------------------------------------
// DOM widget hiding & fold look styling
// ----------------------------------------------------------------------------

function widgetDomElements(node) {
  const out = [];
  const push = (el) => {
    if (typeof Element !== "undefined" && el instanceof Element && !out.includes(el)) {
      out.push(el);
    }
  };
  const keys = ["element", "el", "inputEl", "input", "textarea", "root", "container", "domElement", "htmlElement"];
  for (const w of node?.widgets || []) {
    for (const k of keys) push(w?.[k]);
    for (const nk of ["options", "domWidget", "widget", "props"]) {
      const sub = w?.[nk];
      if (sub && typeof sub === "object") {
        for (const k of keys) push(sub[k]);
      }
    }
  }
  push(node?.domElement);
  push(node?.htmlElement);
  return out;
}

function setDomWidgetsHidden(node, hidden) {
  for (const el of widgetDomElements(node)) {
    if (hidden) {
      if (!el[DOM_HIDDEN_KEY]) {
        el[DOM_HIDDEN_KEY] = {
          display: el.style.display,
          visibility: el.style.visibility,
          pointerEvents: el.style.pointerEvents,
        };
      }
      el.style.display = "none";
      el.style.visibility = "hidden";
      el.style.pointerEvents = "none";
    } else if (el[DOM_HIDDEN_KEY]) {
      const saved = el[DOM_HIDDEN_KEY];
      el.style.display = saved.display;
      el.style.visibility = saved.visibility;
      el.style.pointerEvents = saved.pointerEvents;
      delete el[DOM_HIDDEN_KEY];
    }
  }
}

function applyFoldLook(node, meta, visualBasePos = null, preserveAnchorPos = false) {
  node.flags = node.flags || {};
  node.flags.collapsed = true;
  setDomWidgetsHidden(node, true);
  const basePos = visualBasePos || meta.basePos || [0, 0];
  const chipW = chipWidthFor(meta);

  if (meta.index === 0) {
    node.size = [chipW, CHIP_H];
    if (!preserveAnchorPos) node.pos = [...basePos];
    node.title = `${displayLabel(meta)} \u00b7 ${meta.count}  \u203a`;
    node.color = ACCENT_DIM;
    node.bgcolor = "#101216";
    node._collapsed_width = chipW;
    return;
  }

  node.size = [HIDDEN_W, HIDDEN_H];
  node.pos = [...basePos];
  node.title = HIDDEN_TITLE;
  node.color = "#101216";
  node.bgcolor = "#101216";
  node._collapsed_width = chipW;
}

// ----------------------------------------------------------------------------
// Selection helpers
// ----------------------------------------------------------------------------

function getSelectedNodes(fallback = null) {
  const nodes = graphNodes();
  const res = [];
  const push = (n) => {
    if (n && nodes.includes(n) && !res.includes(n)) res.push(n);
  };
  const selItems = app.canvas?.selectedItems;
  if (selItems instanceof Set) {
    for (const item of selItems) push(item);
  } else if (app.canvas?.selected_nodes) {
    for (const n of Object.values(app.canvas.selected_nodes)) push(n);
  }
  if (fallback) push(fallback);
  return res;
}

function getSelectedGroups(fallback = null) {
  const groups = graphGroups();
  const res = [];
  const push = (g) => {
    if (g && groups.includes(g) && !res.includes(g)) res.push(g);
  };
  const selItems = app.canvas?.selectedItems;
  if (selItems instanceof Set) {
    for (const item of selItems) push(item);
  } else {
    push(app.canvas?.selected_group);
    push(app.canvas?.selectedGroup);
    for (const g of groups) {
      if (g?.selected) push(g);
    }
  }
  if (fallback) push(fallback);
  return res;
}

function replaceSelection(items) {
  const canvas = app.canvas;
  const clean = Array.from(new Set((items || []).filter(Boolean)));
  if (!canvas || !clean.length) return false;
  if (typeof canvas.selectItems === "function") {
    canvas.selectItems(clean, false);
    return true;
  }
  canvas.deselectAll?.();
  canvas.selected_nodes = {};
  const nodes = graphNodes();
  for (const n of nodes) {
    const sel = clean.includes(n);
    n.selected = sel;
    if (sel) canvas.selected_nodes[n.id] = n;
  }
  const groups = graphGroups();
  for (const g of groups) g.selected = clean.includes(g);
  canvas.selectedItems?.clear?.();
  for (const item of clean) canvas.selectedItems?.add?.(item);
  canvas.onSelectionChange?.(canvas.selected_nodes);
  canvas.setDirty?.(true, true);
  return true;
}

// ----------------------------------------------------------------------------
// Core Fold / Unfold / Rename / Sync operations
// ----------------------------------------------------------------------------

function membersOf(node) {
  const m = foldMeta(node);
  if (!m?.groupId) return [];
  return graphNodes().filter((n) => foldMeta(n)?.groupId === m.groupId);
}

function installRemovalGuard(node) {
  if (!node || node.__livedevFoldRemovePatched) return;
  node.__livedevFoldRemovePatched = true;
  const orig = node.onRemoved;
  node.onRemoved = function (...args) {
    if (foldMeta(this)?.index === 0 && (!this.graph || this.graph === activeGraph())) {
      const rest = membersOf(this).filter((n) => n !== this);
      if (rest.length) restoreFoldGroup(rest, { anchor: this, select: false });
    }
    return orig?.apply(this, args);
  };
}

export function foldNodes(nodes, opts = {}) {
  const clean = (nodes || []).filter((n) => n && !foldMeta(n));
  if (clean.length < 1) return null;

  const allNodes = graphNodes();
  const sorted = [...clean].sort((a, b) => allNodes.indexOf(a) - allNodes.indexOf(b));
  const anchor = sorted[sorted.length - 1] || clean[0];
  const ordered = [anchor, ...clean.filter((n) => n !== anchor)];

  let minX = Infinity;
  let minY = Infinity;
  for (const n of clean) {
    minX = Math.min(minX, Number(n.pos?.[0] || 0));
    minY = Math.min(minY, Number(n.pos?.[1] || 0));
  }
  const baseX = Number(opts.basePos?.[0] ?? (Number.isFinite(minX) ? minX : 0));
  const baseY = Number(opts.basePos?.[1] ?? (Number.isFinite(minY) ? minY : 0));
  const groupId = `ld-fold-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

  ordered.forEach((node, index) => {
    installRemovalGuard(node);
    node.properties = node.properties || {};
    const meta = {
      version: 1,
      groupId,
      label: normalizeLabel(opts.label),
      sourceGroup: opts.sourceGroup || null,
      index,
      count: ordered.length,
      anchorId: anchor.id,
      basePos: [baseX, baseY],
      pos: [...(node.pos || [0, 0])],
      size: [...(node.size || [CHIP_W, CHIP_H])],
      title: node.title,
      collapsed: Boolean(node.flags?.collapsed),
      color: storeOwn(node, "color"),
      bgcolor: storeOwn(node, "bgcolor"),
      collapsedWidth: storeOwn(node, "_collapsed_width"),
    };
    node.properties[META_KEY] = meta;
    applyFoldLook(node, meta);
  });

  replaceSelection([anchor]);
  activeGraph()?.change?.();
  markDirty();
  showToast(`LiveDev: Folded ${ordered.length} node${ordered.length === 1 ? "" : "s"}`);
  return anchor;
}

export function foldCanvasGroup(group) {
  const snap = groupSnapshot(group);
  if (!snap) return null;
  group.recomputeInsideNodes?.();
  const inside = nodesInGroup(group);
  if (!inside.length) {
    showToast("LiveDev: Selected group has no foldable nodes");
    return null;
  }
  const box = groupBounds(group);
  const titleH = Number(group.titleHeight || (group.font_size || 24) * 1.4 || 30);
  const basePos = box
    ? [box.x + 8, box.y + Math.min(titleH + 8, Math.max(8, box.h - CHIP_H - 8))]
    : null;
  const anchor = foldNodes(inside, {
    label: normalizeLabel(group.title || "Group"),
    sourceGroup: snap,
    basePos,
  });
  if (anchor) collapseGroupToChip(group, anchor);
  markDirty();
  return anchor;
}

function restoreFoldGroup(group, { anchor = null, select = true } = {}) {
  if (!group || !group.length) return;
  hideTooltip();

  const anchorNode =
    anchor ||
    group.find((n) => foldMeta(n)?.index === 0) ||
    group[0];
  const anchorMeta = foldMeta(anchorNode) || foldMeta(group[0]);
  const dx = Number(anchorNode?.pos?.[0] || 0) - Number(anchorMeta?.basePos?.[0] || 0);
  const dy = Number(anchorNode?.pos?.[1] || 0) - Number(anchorMeta?.basePos?.[1] || 0);
  const sourceGroup = anchorMeta?.sourceGroup || null;

  for (const item of group) {
    const meta = foldMeta(item);
    if (!meta) continue;
    item.pos = [
      Number(meta.pos?.[0] || 0) + dx,
      Number(meta.pos?.[1] || 0) + dy,
    ];
    item.size = [...(meta.size || item.size || [160, 80])];
    item.title = meta.title;
    item.flags = item.flags || {};
    item.flags.collapsed = Boolean(meta.collapsed);
    restoreOwn(item, "color", meta.color);
    restoreOwn(item, "bgcolor", meta.bgcolor);
    restoreOwn(item, "_collapsed_width", meta.collapsedWidth);
    setDomWidgetsHidden(item, false);
    delete item.properties[META_KEY];
  }

  const restoredGroup = restoreGroupSnapshot(sourceGroup, dx, dy);
  if (select) {
    replaceSelection(restoredGroup ? [restoredGroup] : group);
  }
  activeGraph()?.change?.();
  markDirty();
}

export function unfoldGroup(node) {
  const members = membersOf(node);
  if (!members.length) return false;
  restoreFoldGroup(members);
  showToast(`LiveDev: Unfolded ${members.length} node${members.length === 1 ? "" : "s"}`);
  return true;
}

export function doUnfoldAll() {
  const groups = new Map();
  for (const n of graphNodes()) {
    const m = foldMeta(n);
    if (!m?.groupId) continue;
    if (!groups.has(m.groupId)) groups.set(m.groupId, []);
    groups.get(m.groupId).push(n);
  }
  if (!groups.size) {
    showToast("LiveDev: No folded groups in this workflow");
    return 0;
  }
  for (const members of groups.values()) {
    restoreFoldGroup(members, { select: false });
  }
  showToast(`LiveDev: Unfolded ${groups.size} group${groups.size === 1 ? "" : "s"}`);
  return groups.size;
}

export function doFoldToggle(fallbackNode = null) {
  const selNodes = getSelectedNodes(fallbackNode);
  const folded = selNodes.find((n) => foldMeta(n));
  if (folded) {
    unfoldGroup(folded);
    return;
  }
  const clean = selNodes.filter((n) => !foldMeta(n));
  if (clean.length >= 2) {
    foldNodes(clean);
    return;
  }
  const selGroups = getSelectedGroups();
  if (selGroups.length === 1 && nodesInGroup(selGroups[0]).length > 0) {
    foldCanvasGroup(selGroups[0]);
    return;
  }
  if (clean.length === 1) {
    foldNodes(clean);
    return;
  }
  showToast("LiveDev: Select 2+ nodes (or a ComfyUI group) to fold");
}

function renameFoldGroup(node) {
  const members = membersOf(node);
  if (!members.length) return;
  const anchor = members.find((n) => foldMeta(n)?.index === 0) || node;
  const cur = displayLabel(foldMeta(anchor));
  const initial = cur === "Folded" ? "" : cur;

  const { body, close } = createGlassModal({
    title: "Rename Folded Group",
    subtitle: "Use a short label for this folded pill. Leave empty to show \"Folded\".",
    icon: LD_ICONS.fold,
    width: "380px",
    draggable: true,
  });

  const input = document.createElement("input");
  input.type = "text";
  input.className = "ld-input";
  input.maxLength = LABEL_MAX_LEN;
  input.value = initial;
  input.placeholder = "e.g. Upscaler, ControlNet, Sampler";
  input.style.cssText = "width:100%;margin-bottom:12px;";
  body.appendChild(input);

  const commit = () => {
    const label = normalizeLabel(input.value);
    for (const item of members) {
      const m = foldMeta(item);
      if (m) m.label = label;
    }
    refreshFoldedLooks();
    activeGraph()?.change?.();
    markDirty();
    close();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
  });

  const foot = document.createElement("div");
  foot.style.cssText = "display:flex;justify-content:flex-end;gap:6px;";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "ld-btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.onclick = close;
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "ld-btn ld-btn-primary";
  saveBtn.textContent = "Save";
  saveBtn.onclick = commit;
  foot.append(cancelBtn, saveBtn);
  body.appendChild(foot);

  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function refreshFoldedLooks() {
  const groups = new Map();
  for (const n of graphNodes()) {
    const m = foldMeta(n);
    if (!m?.groupId) continue;
    installRemovalGuard(n);
    if (!groups.has(m.groupId)) groups.set(m.groupId, []);
    groups.get(m.groupId).push(n);
  }
  for (const members of groups.values()) {
    const anchor = members.find((n) => foldMeta(n)?.index === 0);
    if (!anchor) {
      restoreFoldGroup(members, { select: false });
      continue;
    }
    const anchorMeta = foldMeta(anchor);
    const visPos = [...(anchor.pos || anchorMeta.basePos || [0, 0])];
    applyFoldLook(anchor, anchorMeta, visPos, true);
    for (const item of members) {
      const m = foldMeta(item);
      if (!m || m.index === 0) continue;
      applyFoldLook(item, m, visPos, false);
    }
    if (anchorMeta.sourceGroup) {
      const grp = findGroupBySnapshot(anchorMeta.sourceGroup);
      if (grp) collapseGroupToChip(grp, anchor);
    }
  }
}

function syncFoldedMotion() {
  const groups = new Map();
  for (const n of graphNodes()) {
    const m = foldMeta(n);
    if (!m?.groupId) continue;
    if (!groups.has(m.groupId)) groups.set(m.groupId, []);
    groups.get(m.groupId).push(n);
  }
  for (const members of groups.values()) {
    const anchor = members.find((n) => foldMeta(n)?.index === 0);
    if (!anchor || !anchor.pos) continue;
    const ax = Number(anchor.pos[0] || 0);
    const ay = Number(anchor.pos[1] || 0);
    for (const item of members) {
      if (item === anchor || !item.pos) continue;
      item.pos[0] = ax;
      item.pos[1] = ay;
    }
    const meta = foldMeta(anchor);
    if (meta?.sourceGroup) {
      const grp = findGroupBySnapshot(meta.sourceGroup);
      if (grp) collapseGroupToChip(grp, anchor);
    }
  }
}

// ----------------------------------------------------------------------------
// Glassmorphic Hover Preview Tooltip for Folded Pills
// ----------------------------------------------------------------------------

function hideTooltip() {
  _lastHoverAnchorId = null;
  if (_tipEl) _tipEl.style.display = "none";
}

function showTooltipForAnchor(anchor, clientX, clientY) {
  ensureTheme();
  const meta = foldMeta(anchor);
  if (!meta) {
    hideTooltip();
    return;
  }
  if (!_tipEl) {
    _tipEl = document.createElement("div");
    _tipEl.className = "ld-fold-tip";
    document.body.appendChild(_tipEl);
  }
  if (_lastHoverAnchorId !== anchor.id) {
    _lastHoverAnchorId = anchor.id;
    _tipEl.innerHTML = "";
    const members = membersOf(anchor);

    const head = document.createElement("div");
    head.className = "ld-fold-tip-head";
    const titleSpan = document.createElement("span");
    titleSpan.textContent = displayLabel(meta);
    const badge = document.createElement("span");
    badge.className = "ld-fold-tip-badge";
    badge.textContent = `${members.length} node${members.length === 1 ? "" : "s"}`;
    head.append(titleSpan, badge);
    _tipEl.appendChild(head);

    for (const item of members.slice(0, HOVER_MAX_ITEMS)) {
      const m = foldMeta(item);
      const row = document.createElement("div");
      row.className = "ld-fold-tip-item";
      const idEl = document.createElement("span");
      idEl.className = "ld-fold-tip-id";
      idEl.textContent = `#${item.id}`;
      const nameEl = document.createElement("span");
      nameEl.textContent = String(m?.title || item.type || "Node");
      row.append(idEl, nameEl);
      _tipEl.appendChild(row);
    }
    if (members.length > HOVER_MAX_ITEMS) {
      const more = document.createElement("div");
      more.className = "ld-fold-tip-item";
      more.textContent = `+${members.length - HOVER_MAX_ITEMS} more...`;
      _tipEl.appendChild(more);
    }

    const foot = document.createElement("div");
    foot.className = "ld-fold-tip-foot";
    foot.textContent = "Double-click to unfold · Drag to move group";
    _tipEl.appendChild(foot);
  }

  _tipEl.style.display = "block";
  const w = _tipEl.offsetWidth || 210;
  const h = _tipEl.offsetHeight || 120;
  const left = Math.max(8, Math.min(clientX + 16, window.innerWidth - w - 8));
  const top = Math.max(8, Math.min(clientY + 14, window.innerHeight - h - 8));
  _tipEl.style.left = Math.round(left) + "px";
  _tipEl.style.top = Math.round(top) + "px";
}

// ----------------------------------------------------------------------------
// Selection Toolbox Commands & Canvas Hooks
// ----------------------------------------------------------------------------

function deriveToolboxCommands() {
  const selNodes = getSelectedNodes();
  const selGroups = getSelectedGroups();
  const folded = selNodes.find((n) => foldMeta(n));
  if (folded) return [CMD.unfold, CMD.rename];
  const clean = selNodes.filter((n) => !foldMeta(n));
  if (clean.length === 0 && selGroups.length === 1 && nodesInGroup(selGroups[0]).length > 0) {
    return [CMD.foldGroup];
  }
  if (clean.length >= 2) return [CMD.fold];
  return [];
}

function runCommand(cmdId) {
  const selNodes = getSelectedNodes();
  const selGroups = getSelectedGroups();
  const folded = selNodes.find((n) => foldMeta(n));
  if (cmdId === CMD.unfold && folded) {
    unfoldGroup(folded);
  } else if (cmdId === CMD.rename && folded) {
    renameFoldGroup(folded);
  } else if (cmdId === CMD.foldGroup && selGroups.length === 1) {
    foldCanvasGroup(selGroups[0]);
  } else if (cmdId === CMD.fold) {
    const clean = selNodes.filter((n) => !foldMeta(n));
    if (clean.length >= 2) foldNodes(clean);
  }
}

function installCanvasPatches() {
  if (typeof LGraphCanvas === "undefined" || !LGraphCanvas.prototype) return false;
  const proto = LGraphCanvas.prototype;

  if (!proto._livedevVisualFoldDrawPatched && typeof proto.drawNode === "function") {
    proto._livedevVisualFoldDrawPatched = true;
    const origDrawNode = proto.drawNode;
    proto.drawNode = function (node) {
      if (isHiddenMember(node)) return;
      return origDrawNode.apply(this, arguments);
    };
  }

  if (!proto._livedevVisualFoldMotionPatched) {
    proto._livedevVisualFoldMotionPatched = true;
    for (const method of ["processMouseDown", "processMouseMove", "processMouseUp"]) {
      const orig = proto[method];
      if (typeof orig !== "function") continue;
      proto[method] = function () {
        const res = orig.apply(this, arguments);
        syncFoldedMotion();
        return res;
      };
    }
  }

  return true;
}

function bindCanvasEvents(canvas) {
  const el = canvas?.canvas;
  if (!el || el._livedevFoldEventsBound) return;
  el._livedevFoldEventsBound = true;

  el.addEventListener("pointermove", (e) => {
    const over = app.canvas?.node_over;
    if (over && foldMeta(over)?.index === 0) {
      showTooltipForAnchor(over, e.clientX, e.clientY);
    } else if (_lastHoverAnchorId != null) {
      hideTooltip();
    }
  });
  el.addEventListener("pointerleave", hideTooltip);
  el.addEventListener("pointerdown", hideTooltip);

  // Double-click a folded pill to unfold it cleanly
  el.addEventListener("dblclick", (e) => {
    const over = app.canvas?.node_over;
    if (over && foldMeta(over)?.index === 0) {
      e.preventDefault();
      e.stopPropagation();
      unfoldGroup(over);
    }
  });
}

function patchGroupMenus() {
  for (const grp of graphGroups()) {
    if (!grp || grp.__livedevFoldGroupMenu || typeof grp.getMenuOptions !== "function") continue;
    grp.__livedevFoldGroupMenu = true;
    const orig = grp.getMenuOptions;
    grp.getMenuOptions = function () {
      const opts = orig?.apply(this, arguments) || [];
      if (Array.isArray(opts) && nodesInGroup(this).length > 0) {
        ensureTheme();
        opts.unshift({
          content: `<span class="ld-ctx-label">${LD_ICONS.brand}<span>LiveDev: Fold Group</span></span>`,
          callback: () => foldCanvasGroup(this),
        });
      }
      return opts;
    };
  }
}

app.registerExtension({
  name: "LiveDev.VisualFold",
  commands: [
    {
      id: CMD.fold,
      label: "LiveDev: Fold Selected Nodes",
      tooltip: "Collapse selected nodes into a compact visual pill (without Subgraph)",
      icon: "ld-vf-cmd-fold",
      function: () => runCommand(CMD.fold),
    },
    {
      id: CMD.foldGroup,
      label: "LiveDev: Fold Selected Group",
      tooltip: "Collapse this group's nodes into a compact visual pill",
      icon: "ld-vf-cmd-fold-group",
      function: () => runCommand(CMD.foldGroup),
    },
    {
      id: CMD.unfold,
      label: "LiveDev: Unfold Group",
      tooltip: "Restore all folded nodes to their original layout",
      icon: "ld-vf-cmd-unfold",
      function: () => runCommand(CMD.unfold),
    },
    {
      id: CMD.rename,
      label: "LiveDev: Rename Folded Group",
      tooltip: "Set a custom label on this folded pill",
      icon: "ld-vf-cmd-rename",
      function: () => runCommand(CMD.rename),
    },
  ],
  setup() {
    ensureTheme();
    installCanvasPatches();
    let tries = 0;
    const init = () => {
      installCanvasPatches();
      if (app?.canvas) {
        bindCanvasEvents(app.canvas);
        patchGroupMenus();
        refreshFoldedLooks();
      } else if (++tries < 40) {
        setTimeout(init, 250);
      }
    };
    init();
  },
  getSelectionToolboxCommands() {
    ensureTheme();
    return deriveToolboxCommands();
  },
  getNodeMenuItems(node) {
    if (!node) return [];
    ensureTheme();
    const meta = foldMeta(node);
    if (meta) {
      return [
        {
          content: `<span class="ld-ctx-label">${LD_ICONS.brand}<span>LiveDev: Unfold Group</span></span>`,
          callback: () => unfoldGroup(node),
        },
        {
          content: `<span class="ld-ctx-label">${LD_ICONS.brand}<span>LiveDev: Rename Folded Group</span></span>`,
          callback: () => renameFoldGroup(node),
        },
      ];
    }
    const sel = getSelectedNodes(node).filter((n) => !foldMeta(n));
    if (sel.length >= 2) {
      return [
        {
          content: `<span class="ld-ctx-label">${LD_ICONS.brand}<span>LiveDev: Fold Selected (${sel.length})</span></span>`,
          callback: () => foldNodes(sel),
        },
      ];
    }
    return [];
  },
  getCanvasMenuItems() {
    const hasFolded = graphNodes().some((n) => foldMeta(n));
    const selGroups = getSelectedGroups();
    const items = [];
    ensureTheme();
    if (selGroups.length === 1 && nodesInGroup(selGroups[0]).length > 0) {
      items.push({
        content: `<span class="ld-ctx-label">${LD_ICONS.brand}<span>LiveDev: Fold Group</span></span>`,
        callback: () => foldCanvasGroup(selGroups[0]),
      });
    }
    if (hasFolded) {
      items.push({
        content: `<span class="ld-ctx-label">${LD_ICONS.brand}<span>LiveDev: Unfold All Groups</span></span>`,
        callback: () => doUnfoldAll(),
      });
    }
    return items;
  },
  afterConfigureGraph() {
    installCanvasPatches();
    patchGroupMenus();
    refreshFoldedLooks();
  },
});
