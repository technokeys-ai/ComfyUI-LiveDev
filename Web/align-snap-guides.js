// LiveDev Align Snap & Alignment Guides for ComfyUI.
//
// Magnetically snaps dragged nodes, SubgraphNodes, Notes, MarkdownNotes, and Groups to sibling
// edges, centers, and equal-spacing gaps while drawing crisp LiveDev-styled alignment guides.
// Hold Shift during drag to temporarily bypass snapping and guides.

import { app } from "../../scripts/app.js";
import { showToast } from "./utils.js";
import { ACCENT } from "./livedev-theme.js";

const LS_ENABLED_KEY = "livedev_alignSnapGuides";
const LS_DIST_KEY = "livedev_alignSnapDistance";
const SETTING_ENABLED_ID = "LiveDev.alignSnapGuides";

const DEFAULT_ENABLED = true;
const DEFAULT_SNAP_PX = 8;

let _enabled = _readBool(LS_ENABLED_KEY, DEFAULT_ENABLED);
let _snapPx = _readNum(LS_DIST_KEY, DEFAULT_SNAP_PX, 3, 24);
let _shiftDown = false;
let _hooksInstalled = false;
const _listeners = new Set();

// Active drag tracking (unsnapped virtual offsets prevent sticky/jittery snapping)
let _dragState = null;
// Guides rendered in onDrawForeground: { vLines: [...], hLines: [...], gaps: [...] }
let _activeGuides = null;

function _readBool(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw);
    return typeof parsed === "boolean" ? parsed : fallback;
  } catch (e) {
    return fallback;
  }
}

function _readNum(key, fallback, min, max) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const num = Number(JSON.parse(raw));
    if (!Number.isFinite(num)) return fallback;
    return Math.max(min, Math.min(max, num));
  } catch (e) {
    return fallback;
  }
}

function _writeLs(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {}
}

function _notifyState() {
  for (const fn of _listeners) {
    try {
      fn(_enabled);
    } catch (e) {}
  }
}

export function isAlignSnapEnabled() {
  return _enabled;
}

export function onAlignSnapChange(listener) {
  if (typeof listener === "function") {
    _listeners.add(listener);
    listener(_enabled);
  }
  return () => _listeners.delete(listener);
}

export function setAlignSnapEnabled(next, opts = {}) {
  const on = Boolean(next);
  const changed = _enabled !== on;
  _enabled = on;
  _writeLs(LS_ENABLED_KEY, on);
  if (!on) {
    _activeGuides = null;
    app.canvas?.setDirty(true, true);
  }
  if (!opts.fromSetting) {
    try {
      const settings = app.ui?.settings;
      if (settings && typeof settings.setSettingValue === "function") {
        const cur = settings.getSettingValue?.(SETTING_ENABLED_ID);
        if (Boolean(cur) !== on) {
          settings.setSettingValue(SETTING_ENABLED_ID, on);
        }
      }
    } catch (e) {}
  }
  if (changed || opts.forceNotify) _notifyState();
  if (opts.toast) {
    showToast(
      on
        ? "LiveDev: Align Snap & Guides ON (hold Shift to bypass)"
        : "LiveDev: Align Snap & Guides OFF"
    );
  }
  return _enabled;
}

export function toggleAlignSnapEnabled(opts = {}) {
  return setAlignSnapEnabled(!_enabled, { toast: true, ...opts });
}

export function setAlignSnapDistance(px) {
  const num = Number(px);
  if (!Number.isFinite(num)) return _snapPx;
  _snapPx = Math.max(3, Math.min(24, Math.round(num)));
  _writeLs(LS_DIST_KEY, _snapPx);
  return _snapPx;
}

// ---- Geometry helpers (matching align-toolbar.js visual bounds) ----

function _isGroupItem(item) {
  return Boolean(item && typeof item.recomputeInsideNodes === "function");
}

function _getItemPos(item) {
  const p = item?.pos || item?._pos;
  return [Number(p?.[0]) || 0, Number(p?.[1]) || 0];
}

function _getItemSize(item) {
  if (item?.flags?.collapsed) {
    if (Array.isArray(item.renderingSize) && item.renderingSize.length >= 2) {
      return [
        Number(item.renderingSize[0]) || Number(item._collapsed_width) || 140,
        Number(item.renderingSize[1]) || 0,
      ];
    }
    return [Number(item._collapsed_width) || 140, 0];
  }
  const s = item?.size || item?._size;
  return [Number(s?.[0]) || 200, Number(s?.[1]) || 100];
}

function _getItemTitleH(item) {
  if (_isGroupItem(item)) return 0;
  if (item?.constructor?.title_mode === 2 || item?.title_mode === 2) return 0;
  if (typeof item?.title_height === "number" && Number.isFinite(item.title_height)) {
    return item.title_height;
  }
  return typeof LiteGraph !== "undefined" && Number.isFinite(LiteGraph.NODE_TITLE_HEIGHT)
    ? LiteGraph.NODE_TITLE_HEIGHT
    : 30;
}

function _getItemBoundsAt(item, x, y) {
  const [w, bodyH] = _getItemSize(item);
  const titleH = _getItemTitleH(item);
  const top = y - titleH;
  const h = bodyH + titleH;
  return {
    left: x,
    right: x + w,
    top,
    bottom: top + h,
    w,
    h,
    titleH,
    cx: x + w / 2,
    cy: top + h / 2,
  };
}

function _getItemBounds(item) {
  const [x, y] = _getItemPos(item);
  return _getItemBoundsAt(item, x, y);
}

function _isMovableCanvasItem(item, graph) {
  if (!item) return false;
  if (graph && (item === graph.inputNode || item === graph.outputNode)) return false;
  const pos = item.pos || item._pos;
  const size = item.size || item._size;
  return Boolean(pos && pos.length >= 2 && size && size.length >= 2);
}

function _collectDraggedItems(canvas, evt) {
  const graph = canvas?.graph;
  if (!graph) return [];
  const raw = [];
  if (canvas.selectedItems instanceof Set) {
    for (const item of canvas.selectedItems) {
      if (_isMovableCanvasItem(item, graph) && !item.flags?.pinned) raw.push(item);
    }
  } else if (canvas.selected_nodes) {
    for (const k of Object.keys(canvas.selected_nodes)) {
      const item = canvas.selected_nodes[k];
      if (_isMovableCanvasItem(item, graph) && !item.flags?.pinned) raw.push(item);
    }
  }
  if (!raw.length) return [];

  // When a group is dragged without Ctrl/Meta, ComfyUI also moves its children.
  const detachGroup = Boolean(evt && (evt.ctrlKey || evt.metaKey));
  const out = new Set();
  const addWithChildren = (item) => {
    if (!item || out.has(item) || item.flags?.pinned) return;
    out.add(item);
    if (!detachGroup && _isGroupItem(item) && item._children) {
      for (const ch of item._children) {
        if (_isMovableCanvasItem(ch, graph)) addWithChildren(ch);
      }
    }
  };
  for (const item of raw) addWithChildren(item);
  return [...out];
}

function _collectTargets(canvas, draggedSet) {
  const graph = canvas?.graph;
  if (!graph) return [];
  const vis = canvas.visible_area;
  const pad = 420;
  const hasVis = vis && vis.length >= 4 && Number.isFinite(vis[0]) && Number.isFinite(vis[2]);
  const vx0 = hasVis ? vis[0] - pad : -Infinity;
  const vy0 = hasVis ? vis[1] - pad : -Infinity;
  const vx1 = hasVis ? vis[0] + vis[2] + pad : Infinity;
  const vy1 = hasVis ? vis[1] + vis[3] + pad : Infinity;

  const targets = [];
  const pushIfVisible = (item) => {
    if (!item || draggedSet.has(item) || !_isMovableCanvasItem(item, graph)) return;
    const b = _getItemBounds(item);
    if (b.right < vx0 || b.left > vx1 || b.bottom < vy0 || b.top > vy1) return;
    targets.push({ item, b });
  };

  for (const n of graph._nodes || []) pushIfVisible(n);
  for (const g of graph._groups || []) pushIfVisible(g);
  return targets;
}

function _combinedBounds(items, startPositions, dx, dy) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const item of items) {
    const sp = startPositions.get(item);
    if (!sp) continue;
    const b = _getItemBoundsAt(item, sp[0] + dx, sp[1] + dy);
    if (b.left < left) left = b.left;
    if (b.top < top) top = b.top;
    if (b.right > right) right = b.right;
    if (b.bottom > bottom) bottom = b.bottom;
  }
  const w = right - left;
  const h = bottom - top;
  return {
    left,
    top,
    right,
    bottom,
    w,
    h,
    cx: left + w / 2,
    cy: top + h / 2,
  };
}

function _rangesOverlap(a0, a1, b0, b1, margin = 0) {
  return a1 + margin >= b0 && b1 + margin >= a0;
}

// ---- Snap solver (edges, centers, and equal-spacing gaps) ----

function _computeSnapAndGuides(dragBox, targets, threshold) {
  let bestDx = 0;
  let bestAbsX = threshold + 0.001;
  let bestDy = 0;
  let bestAbsY = threshold + 0.001;

  const dragXPoints = [
    { val: dragBox.left, kind: "edge" },
    { val: dragBox.right, kind: "edge" },
    { val: dragBox.cx, kind: "center" },
  ];
  const dragYPoints = [
    { val: dragBox.top, kind: "edge" },
    { val: dragBox.bottom, kind: "edge" },
    { val: dragBox.cy, kind: "center" },
  ];

  // 1. Edge & Center alignment candidates
  for (const { b } of targets) {
    const tX = [
      { val: b.left, kind: "edge" },
      { val: b.right, kind: "edge" },
      { val: b.cx, kind: "center" },
    ];
    for (const dp of dragXPoints) {
      for (const tp of tX) {
        const d = tp.val - dp.val;
        const ad = Math.abs(d);
        if (ad < bestAbsX) {
          bestAbsX = ad;
          bestDx = d;
        }
      }
    }

    const tY = [
      { val: b.top, kind: "edge" },
      { val: b.bottom, kind: "edge" },
      { val: b.cy, kind: "center" },
    ];
    for (const dp of dragYPoints) {
      for (const tp of tY) {
        const d = tp.val - dp.val;
        const ad = Math.abs(d);
        if (ad < bestAbsY) {
          bestAbsY = ad;
          bestDy = d;
        }
      }
    }
  }

  // 2. Equal-spacing (gap) snap candidates along X (between two neighbors, or matching neighbor pair gap)
  const hNeighbors = targets
    .filter(({ b }) => _rangesOverlap(dragBox.top, dragBox.bottom, b.top, b.bottom, 60))
    .map(({ b }) => b);
  let leftNeighbor = null;
  let rightNeighbor = null;
  for (const b of hNeighbors) {
    if (b.right <= dragBox.left + threshold) {
      if (!leftNeighbor || b.right > leftNeighbor.right) leftNeighbor = b;
    } else if (b.left >= dragBox.right - threshold) {
      if (!rightNeighbor || b.left < rightNeighbor.left) rightNeighbor = b;
    }
  }
  if (leftNeighbor && rightNeighbor) {
    const span = rightNeighbor.left - leftNeighbor.right - dragBox.w;
    if (span >= 8) {
      const targetLeft = leftNeighbor.right + span / 2;
      const d = targetLeft - dragBox.left;
      const ad = Math.abs(d);
      if (ad < bestAbsX) {
        bestAbsX = ad;
        bestDx = d;
      }
    }
  }
  // Check matching existing horizontal gap from adjacent row pairs
  if (hNeighbors.length >= 2) {
    const sortedH = [...hNeighbors].sort((a, b) => a.left - b.left);
    for (let i = 0; i < sortedH.length - 1; i++) {
      const a = sortedH[i];
      const b = sortedH[i + 1];
      const existingGap = b.left - a.right;
      if (existingGap < 6 || existingGap > 600) continue;
      // Candidate to the right of b
      if (dragBox.left >= b.right - threshold) {
        const dRight = (b.right + existingGap) - dragBox.left;
        if (Math.abs(dRight) < bestAbsX) {
          bestAbsX = Math.abs(dRight);
          bestDx = dRight;
        }
      }
      // Candidate to the left of a
      if (dragBox.right <= a.left + threshold) {
        const dLeft = (a.left - existingGap - dragBox.w) - dragBox.left;
        if (Math.abs(dLeft) < bestAbsX) {
          bestAbsX = Math.abs(dLeft);
          bestDx = dLeft;
        }
      }
    }
  }

  // 3. Equal-spacing (gap) snap candidates along Y
  const vNeighbors = targets
    .filter(({ b }) => _rangesOverlap(dragBox.left, dragBox.right, b.left, b.right, 60))
    .map(({ b }) => b);
  let topNeighbor = null;
  let bottomNeighbor = null;
  for (const b of vNeighbors) {
    if (b.bottom <= dragBox.top + threshold) {
      if (!topNeighbor || b.bottom > topNeighbor.bottom) topNeighbor = b;
    } else if (b.top >= dragBox.bottom - threshold) {
      if (!bottomNeighbor || b.top < bottomNeighbor.top) bottomNeighbor = b;
    }
  }
  if (topNeighbor && bottomNeighbor) {
    const span = bottomNeighbor.top - topNeighbor.bottom - dragBox.h;
    if (span >= 8) {
      const targetTop = topNeighbor.bottom + span / 2;
      const d = targetTop - dragBox.top;
      const ad = Math.abs(d);
      if (ad < bestAbsY) {
        bestAbsY = ad;
        bestDy = d;
      }
    }
  }
  if (vNeighbors.length >= 2) {
    const sortedV = [...vNeighbors].sort((a, b) => a.top - b.top);
    for (let i = 0; i < sortedV.length - 1; i++) {
      const a = sortedV[i];
      const b = sortedV[i + 1];
      const existingGap = b.top - a.bottom;
      if (existingGap < 6 || existingGap > 600) continue;
      if (dragBox.top >= b.bottom - threshold) {
        const dDown = (b.bottom + existingGap) - dragBox.top;
        if (Math.abs(dDown) < bestAbsY) {
          bestAbsY = Math.abs(dDown);
          bestDy = dDown;
        }
      }
      if (dragBox.bottom <= a.top + threshold) {
        const dUp = (a.top - existingGap - dragBox.h) - dragBox.top;
        if (Math.abs(dUp) < bestAbsY) {
          bestAbsY = Math.abs(dUp);
          bestDy = dUp;
        }
      }
    }
  }

  const snapDx = bestAbsX <= threshold ? bestDx : 0;
  const snapDy = bestAbsY <= threshold ? bestDy : 0;

  // Build final snapped dragBox to collect ALL matching guides
  const finalBox = {
    left: dragBox.left + snapDx,
    right: dragBox.right + snapDx,
    top: dragBox.top + snapDy,
    bottom: dragBox.bottom + snapDy,
    w: dragBox.w,
    h: dragBox.h,
    cx: dragBox.cx + snapDx,
    cy: dragBox.cy + snapDy,
  };

  const eps = 0.75;
  const vLinesMap = new Map();
  const hLinesMap = new Map();

  const addVLine = (x, yMin, yMax, isCenter) => {
    const key = Math.round(x * 2);
    const prev = vLinesMap.get(key);
    if (prev) {
      prev.y1 = Math.min(prev.y1, yMin);
      prev.y2 = Math.max(prev.y2, yMax);
      prev.isCenter = prev.isCenter && isCenter;
    } else {
      vLinesMap.set(key, { x, y1: yMin, y2: yMax, isCenter });
    }
  };
  const addHLine = (y, xMin, xMax, isCenter) => {
    const key = Math.round(y * 2);
    const prev = hLinesMap.get(key);
    if (prev) {
      prev.x1 = Math.min(prev.x1, xMin);
      prev.x2 = Math.max(prev.x2, xMax);
      prev.isCenter = prev.isCenter && isCenter;
    } else {
      hLinesMap.set(key, { y, x1: xMin, x2: xMax, isCenter });
    }
  };

  const finalXChecks = [
    [finalBox.left, false],
    [finalBox.right, false],
    [finalBox.cx, true],
  ];
  const finalYChecks = [
    [finalBox.top, false],
    [finalBox.bottom, false],
    [finalBox.cy, true],
  ];

  for (const { b } of targets) {
    const tX = [
      [b.left, false],
      [b.right, false],
      [b.cx, true],
    ];
    for (const [fx, fCenter] of finalXChecks) {
      for (const [tx, tCenter] of tX) {
        if (Math.abs(fx - tx) <= eps) {
          addVLine(tx, Math.min(finalBox.top, b.top), Math.max(finalBox.bottom, b.bottom), fCenter || tCenter);
        }
      }
    }

    const tY = [
      [b.top, false],
      [b.bottom, false],
      [b.cy, true],
    ];
    for (const [fy, fCenter] of finalYChecks) {
      for (const [ty, tCenter] of tY) {
        if (Math.abs(fy - ty) <= eps) {
          addHLine(ty, Math.min(finalBox.left, b.left), Math.max(finalBox.right, b.right), fCenter || tCenter);
        }
      }
    }
  }

  // Collect matching equal-spacing gap indicators
  const gaps = [];
  if (leftNeighbor && rightNeighbor) {
    const gL = finalBox.left - leftNeighbor.right;
    const gR = rightNeighbor.left - finalBox.right;
    if (gL >= 4 && Math.abs(gL - gR) <= 1.2) {
      const yMid = Math.max(finalBox.top, Math.min(finalBox.bottom, finalBox.cy));
      gaps.push({ axis: "x", a: leftNeighbor.right, b: finalBox.left, cross: yMid, dist: Math.round(gL) });
      gaps.push({ axis: "x", a: finalBox.right, b: rightNeighbor.left, cross: yMid, dist: Math.round(gR) });
    }
  } else if (hNeighbors.length >= 2) {
    const sortedH = [...hNeighbors].sort((a, b) => a.left - b.left);
    for (let i = 0; i < sortedH.length - 1; i++) {
      const a = sortedH[i];
      const b = sortedH[i + 1];
      const existingGap = b.left - a.right;
      if (existingGap < 6 || existingGap > 600) continue;
      if (Math.abs((finalBox.left - b.right) - existingGap) <= 1.2) {
        const yMid = finalBox.cy;
        gaps.push({ axis: "x", a: a.right, b: b.left, cross: (a.cy + b.cy) / 2, dist: Math.round(existingGap) });
        gaps.push({ axis: "x", a: b.right, b: finalBox.left, cross: yMid, dist: Math.round(existingGap) });
        break;
      }
      if (Math.abs((a.left - finalBox.right) - existingGap) <= 1.2) {
        const yMid = finalBox.cy;
        gaps.push({ axis: "x", a: finalBox.right, b: a.left, cross: yMid, dist: Math.round(existingGap) });
        gaps.push({ axis: "x", a: a.right, b: b.left, cross: (a.cy + b.cy) / 2, dist: Math.round(existingGap) });
        break;
      }
    }
  }

  if (topNeighbor && bottomNeighbor) {
    const gT = finalBox.top - topNeighbor.bottom;
    const gB = bottomNeighbor.top - finalBox.bottom;
    if (gT >= 4 && Math.abs(gT - gB) <= 1.2) {
      const xMid = finalBox.cx;
      gaps.push({ axis: "y", a: topNeighbor.bottom, b: finalBox.top, cross: xMid, dist: Math.round(gT) });
      gaps.push({ axis: "y", a: finalBox.bottom, b: bottomNeighbor.top, cross: xMid, dist: Math.round(gB) });
    }
  } else if (vNeighbors.length >= 2) {
    const sortedV = [...vNeighbors].sort((a, b) => a.top - b.top);
    for (let i = 0; i < sortedV.length - 1; i++) {
      const a = sortedV[i];
      const b = sortedV[i + 1];
      const existingGap = b.top - a.bottom;
      if (existingGap < 6 || existingGap > 600) continue;
      if (Math.abs((finalBox.top - b.bottom) - existingGap) <= 1.2) {
        const xMid = finalBox.cx;
        gaps.push({ axis: "y", a: a.bottom, b: b.top, cross: (a.cx + b.cx) / 2, dist: Math.round(existingGap) });
        gaps.push({ axis: "y", a: b.bottom, b: finalBox.top, cross: xMid, dist: Math.round(existingGap) });
        break;
      }
      if (Math.abs((a.top - finalBox.bottom) - existingGap) <= 1.2) {
        const xMid = finalBox.cx;
        gaps.push({ axis: "y", a: finalBox.bottom, b: a.top, cross: xMid, dist: Math.round(existingGap) });
        gaps.push({ axis: "y", a: a.bottom, b: b.top, cross: (a.cx + b.cx) / 2, dist: Math.round(existingGap) });
        break;
      }
    }
  }

  const vLines = [...vLinesMap.values()];
  const hLines = [...hLinesMap.values()];
  const guides = vLines.length || hLines.length || gaps.length ? { vLines, hLines, gaps } : null;
  return { snapDx, snapDy, guides };
}

function _applyDraggedOffset(canvas, state, dx, dy) {
  for (const item of state.items) {
    const sp = state.startPositions.get(item);
    if (!sp) continue;
    const nx = sp[0] + dx;
    const ny = sp[1] + dy;
    const [cx, cy] = _getItemPos(item);
    if (Math.abs(cx - nx) > 0.001 || Math.abs(cy - ny) > 0.001) {
      item.pos = [nx, ny];
    }
  }
  canvas.setDirty(true, true);
}

function _clientToGraph(canvas, clientX, clientY) {
  const rect = canvas.canvas.getBoundingClientRect();
  const scale = Number(canvas.ds?.scale) || 1;
  const off = canvas.ds?.offset || [0, 0];
  return [
    (clientX - rect.left) / scale - (Number(off[0]) || 0),
    (clientY - rect.top) / scale - (Number(off[1]) || 0),
  ];
}

function _recomputeActiveDrag(canvas, shiftHeld) {
  if (!_dragState || !canvas || !canvas.isDragging) return;
  const st = _dragState;
  const bypass = !_enabled || Boolean(shiftHeld);
  if (bypass) {
    _activeGuides = null;
    _applyDraggedOffset(canvas, st, st.rawDx, st.rawDy);
    return;
  }
  const scale = Number(canvas.ds?.scale) || 1;
  const threshold = Math.max(4, Math.min(28, _snapPx / Math.max(0.3, scale)));
  const unsnappedBox = _combinedBounds(st.items, st.startPositions, st.rawDx, st.rawDy);
  const targets = _collectTargets(canvas, st.itemSet);
  const { snapDx, snapDy, guides } = _computeSnapAndGuides(unsnappedBox, targets, threshold);
  _activeGuides = guides;
  _applyDraggedOffset(canvas, st, st.rawDx + snapDx, st.rawDy + snapDy);
}

function _clearDragState(canvas) {
  const hadGuides = Boolean(_activeGuides);
  _dragState = null;
  _activeGuides = null;
  if (hadGuides && canvas) {
    canvas.setDirty(true, true);
  }
}

// ---- Foreground Canvas Rendering ----

function _drawGapBadge(ctx, cx, cy, text, scale) {
  const inv = 1 / Math.max(0.25, scale);
  const fontSize = 10 * inv;
  ctx.save();
  ctx.font = `600 ${fontSize}px Consolas, monospace`;
  const tw = ctx.measureText(text).width;
  const padX = 5 * inv;
  const padY = 2.5 * inv;
  const bw = tw + padX * 2;
  const bh = fontSize + padY * 2;
  const bx = cx - bw / 2;
  const by = cy - bh / 2;
  const r = 4 * inv;

  ctx.fillStyle = "rgba(16, 18, 22, 0.92)";
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1 * inv;
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(bx, by, bw, bh, r);
  } else {
    ctx.rect(bx, by, bw, bh);
  }
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = ACCENT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx, cy + 0.5 * inv);
  ctx.restore();
}

function _drawGuides(ctx, canvas) {
  if (!_activeGuides || !_enabled) return;
  const scale = Number(canvas?.ds?.scale) || 1;
  const inv = 1 / Math.max(0.25, scale);
  const overhang = 16 * inv;
  const tick = 4 * inv;

  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.25 * inv;
  ctx.shadowColor = "rgba(56, 192, 196, 0.45)";
  ctx.shadowBlur = 4 * inv;

  // Vertical alignment lines
  for (const line of _activeGuides.vLines) {
    ctx.save();
    if (line.isCenter) ctx.setLineDash([4 * inv, 3 * inv]);
    ctx.beginPath();
    ctx.moveTo(line.x, line.y1 - overhang);
    ctx.lineTo(line.x, line.y2 + overhang);
    ctx.stroke();

    // Small endpoint crosshairs
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(line.x - tick, line.y1);
    ctx.lineTo(line.x + tick, line.y1);
    ctx.moveTo(line.x - tick, line.y2);
    ctx.lineTo(line.x + tick, line.y2);
    ctx.stroke();
    ctx.restore();
  }

  // Horizontal alignment lines
  for (const line of _activeGuides.hLines) {
    ctx.save();
    if (line.isCenter) ctx.setLineDash([4 * inv, 3 * inv]);
    ctx.beginPath();
    ctx.moveTo(line.x1 - overhang, line.y);
    ctx.lineTo(line.x2 + overhang, line.y);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(line.x1, line.y - tick);
    ctx.lineTo(line.x1, line.y + tick);
    ctx.moveTo(line.x2, line.y - tick);
    ctx.lineTo(line.x2, line.y + tick);
    ctx.stroke();
    ctx.restore();
  }

  // Equal-spacing dimension brackets & pixel pills
  const cap = 5 * inv;
  for (const g of _activeGuides.gaps) {
    ctx.save();
    ctx.setLineDash([]);
    ctx.beginPath();
    if (g.axis === "x") {
      ctx.moveTo(g.a, g.cross);
      ctx.lineTo(g.b, g.cross);
      ctx.moveTo(g.a, g.cross - cap);
      ctx.lineTo(g.a, g.cross + cap);
      ctx.moveTo(g.b, g.cross - cap);
      ctx.lineTo(g.b, g.cross + cap);
      ctx.stroke();
      ctx.restore();
      _drawGapBadge(ctx, (g.a + g.b) / 2, g.cross - 11 * inv, `${g.dist}px`, scale);
    } else {
      ctx.moveTo(g.cross, g.a);
      ctx.lineTo(g.cross, g.b);
      ctx.moveTo(g.cross - cap, g.a);
      ctx.lineTo(g.cross + cap, g.a);
      ctx.moveTo(g.cross - cap, g.b);
      ctx.lineTo(g.cross + cap, g.b);
      ctx.stroke();
      ctx.restore();
      _drawGapBadge(ctx, g.cross + 22 * inv, (g.a + g.b) / 2, `${g.dist}px`, scale);
    }
  }

  ctx.restore();
}

// ---- Canvas Hook Installation ----

function _attachForegroundHook(canvas) {
  if (!canvas || canvas.onDrawForeground?._ldSnapWrapped) return;
  const origFg = canvas.onDrawForeground;
  const wrappedFg = function (ctx, visibleArea) {
    if (typeof origFg === "function") origFg.apply(this, arguments);
    _drawGuides(ctx, this);
  };
  wrappedFg._ldSnapWrapped = true;
  canvas.onDrawForeground = wrappedFg;
}

function _attachCanvasDomHooks(canvas) {
  if (!canvas || !canvas.canvas) return;
  _attachForegroundHook(canvas);

  const el = canvas.canvas;
  if (el._ldSnapDomBound) return;
  el._ldSnapDomBound = true;

  // ComfyUI binds its own pointermove handler inside LGraphCanvas.bindEvents() before extensions
  // run, so a bubble-phase listener registered here runs reliably right AFTER LiteGraph moves
  // the dragged items for the current pointer frame.
  el.addEventListener("pointermove", (e) => {
    _attachForegroundHook(canvas);

    if (!canvas.isDragging) {
      if (_dragState && _dragState.canvas === canvas) {
        _clearDragState(canvas);
      }
      return;
    }

    const shiftHeld = Boolean(e.shiftKey || _shiftDown);
    const draggedItems = _collectDraggedItems(canvas, e);
    if (!draggedItems.length) {
      _clearDragState(canvas);
      return;
    }

    const curGraphPos = _clientToGraph(canvas, e.clientX, e.clientY);

    if (
      !_dragState ||
      _dragState.canvas !== canvas ||
      _dragState.graph !== canvas.graph ||
      _dragState.items.length !== draggedItems.length ||
      _dragState.items[0] !== draggedItems[0]
    ) {
      const startPositions = new Map();
      for (const item of draggedItems) {
        startPositions.set(item, _getItemPos(item));
      }
      _dragState = {
        canvas,
        graph: canvas.graph,
        items: draggedItems,
        itemSet: new Set(draggedItems),
        startPositions,
        startGraphPos: curGraphPos,
        rawDx: 0,
        rawDy: 0,
      };
    } else {
      _dragState.rawDx = curGraphPos[0] - _dragState.startGraphPos[0];
      _dragState.rawDy = curGraphPos[1] - _dragState.startGraphPos[1];
    }

    _recomputeActiveDrag(canvas, shiftHeld);
  });

  el.addEventListener("litegraph:dragging-items-changed", (e) => {
    if (!e?.detail?.dragging) {
      _clearDragState(canvas);
    }
  });
}

function _installHooks() {
  if (app.canvas) _attachCanvasDomHooks(app.canvas);
  if (_hooksInstalled) return;
  _hooksInstalled = true;

  // Respond immediately if Shift is pressed or released mid-drag
  window.addEventListener("keydown", (e) => {
    if (e.key === "Shift" && !_shiftDown) {
      _shiftDown = true;
      if (_dragState && _dragState.canvas?.isDragging) {
        _recomputeActiveDrag(_dragState.canvas, true);
        _dragState.canvas.setDirty(true, true);
      }
    }
  }, true);

  window.addEventListener("keyup", (e) => {
    if (e.key === "Shift" && _shiftDown) {
      _shiftDown = false;
      if (_dragState && _dragState.canvas?.isDragging) {
        _recomputeActiveDrag(_dragState.canvas, false);
        _dragState.canvas.setDirty(true, true);
      }
    }
  }, true);

  window.addEventListener("pointerup", () => {
    if (_dragState) _clearDragState(_dragState.canvas);
  }, true);

  window.addEventListener("blur", () => {
    _shiftDown = false;
    if (_dragState) _clearDragState(_dragState.canvas);
  });
}

app.registerExtension({
  name: "LiveDev.AlignSnapGuides",
  async setup() {
    _installHooks();
    if (!app.canvas?.canvas) {
      let tries = 0;
      const poll = setInterval(() => {
        _installHooks();
        if (app.canvas?.canvas) {
          _attachCanvasDomHooks(app.canvas);
          clearInterval(poll);
        } else if (++tries > 40) {
          clearInterval(poll);
        }
      }, 250);
    }
  },
});
