// LiveDev Wires & Quick Connections engine.
//
// Combines drag-to-connect quick slot suggestions with 12 wire routing modes and 16 composable
// visual effects (Neon Glow, Fiber Optic, Laser Beam, Gradient Flow, Flowing Energy, Pulse Beads,
// Tapered Ribbon, Double Rail, Outlined Cable, 3D Glossy Pipe, Glass Tube, Circuit Trace,
// Dashed Technical, Blueprint Dotted, Directional Chevrons) plus Focus Dimming, CAD Jump-Over
// Bridges, and Live Execution Data Pulses. Every toggle is controlled live from ComfyUI Settings
// under "LiveDev -> Wires & Connections".

import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import { ACCENT, SURFACE, SURFACE_DEEP, TEXT } from "./livedev-theme.js";

function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem("livedev_" + key);
    return raw != null ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

export const WIRE_MODES = [
  "Default (ComfyUI)",
  "Circuit Board (PCB 90/45)",
  "Rounded Metro (90 Smooth)",
  "Smart-Avoid Spline",
  "Bus / Highway Bundling",
  "Catenary (Hanging Cable)",
  "Stepped Chamfer (Sci-Fi 45)",
  "Nuke / Fusion Pipes",
  "Manhattan Grid (90 Strict)",
  "Overhead Arc",
  "Smart Wireless Portal",
  "On Top (Above Nodes)",
];

export const WIRE_VISUAL_STYLES = [
  "Normal",
  "Neon Glow Tube",
  "Fiber Optic Core",
  "Laser Beam",
  "Gradient Flow (Source -> Target)",
  "Flowing Energy (Animated)",
  "Pulse Beads (Animated)",
  "Tapered Ribbon",
  "Double Rail (Twin Track)",
  "Outlined Cable (High Contrast)",
  "3D Glossy Pipe",
  "Glass Tube",
  "Circuit Trace (Solder Pads)",
  "Dashed Technical",
  "Blueprint Dotted",
  "Directional Chevrons",
];

const ANIMATED_VISUAL_STYLES = new Set([
  "Flowing Energy (Animated)",
  "Pulse Beads (Animated)",
]);

// Live configuration read directly by both controllers
export const wiresConfig = {
  qcEnabled: lsGet("qcEnabled", true),
  qcDotOnly: lsGet("qcDotOnly", false),
  qcMaxSuggestions: Number(lsGet("qcMaxSuggestions", 15)) || 15,
  wireMode: lsGet("wireMode", "Default (ComfyUI)"),
  wirePrefer90or45: lsGet("wirePrefer90or45", true),
  wireLineSpacing: Number(lsGet("wireLineSpacing", 10)) || 10,
  wireNodePadding: Number(lsGet("wireNodePadding", 14)) || 14,
  wirePortalDistance: Number(lsGet("wirePortalDistance", 550)) || 550,
  wireVisualStyle: lsGet("wireVisualStyle", "Normal"),
  wireFocusMode: lsGet("wireFocusMode", false),
  wireJumpBridges: lsGet("wireJumpBridges", false),
  wireLivePulse: lsGet("wireLivePulse", false),
};

let _runningNodeId = null;
let _pulseRaf = null;
let _installed = false;
let _eyeHidden = false;
let _routeCache = { key: "", entries: null, crossingsByEntry: null };

export function applyWireSettings(patch, opts = null) {
  if (patch && typeof patch === "object") {
    Object.assign(wiresConfig, patch);
  }
  _routeCache.key = "";
  const canvas = app?.canvas;
  const graph = canvas?.graph || app?.graph;
  const onTop = wiresConfig.wireMode === "On Top (Above Nodes)";
  if (graph?.config) graph.config.links_ontop = onTop;
  if (app?.graph?.config) app.graph.config.links_ontop = onTop;
  _syncPulseLoop();
  if (!opts?.silent && canvas) {
    canvas.setDirty(true, true);
  }
}

// ============================================================================
// Animation loop (active ONLY while executing with pulse OR using an animated
// wire visual effect; auto-pauses when the browser tab is hidden)
// ============================================================================

function _needsAnimLoop() {
  return (
    (wiresConfig.wireLivePulse && _runningNodeId != null) ||
    ANIMATED_VISUAL_STYLES.has(wiresConfig.wireVisualStyle)
  );
}

function _syncPulseLoop() {
  const shouldRun = _needsAnimLoop();
  if (shouldRun && !_pulseRaf) {
    let lastDraw = 0;
    const tick = (now) => {
      if (!_needsAnimLoop()) {
        _pulseRaf = null;
        return;
      }
      if (!document.hidden && now - lastDraw >= 32) {
        lastDraw = now;
        if (app?.canvas) {
          app.canvas.setDirty(true, false);
        }
      }
      _pulseRaf = requestAnimationFrame(tick);
    };
    _pulseRaf = requestAnimationFrame(tick);
  } else if (!shouldRun && _pulseRaf) {
    cancelAnimationFrame(_pulseRaf);
    _pulseRaf = null;
  }
}

// ============================================================================
// Quick Connections Controller
// ============================================================================

class LiveDevQuickConnections {
  constructor() {
    this.canvas = null;
    this.insideTarget = null;
    this.suggestions = null;
    this.suppressEmptyMenu = false;
    this.graphMouse = [0, 0];
    this.ignoreWildcard = /^\*$/;
  }

  getActiveDrag() {
    const c = this.canvas;
    if (!c) return null;
    if (Array.isArray(c.connecting_links) && c.connecting_links.length > 0) {
      const link = c.connecting_links[0];
      return {
        node: link.node,
        slot: link.slot,
        input: link.input,
        output: link.output,
        pos: link.pos,
        isComfy: true,
      };
    }
    if (c.connecting_node) {
      return {
        node: c.connecting_node,
        slot: c.connecting_slot,
        input: c.connecting_input,
        output: c.connecting_output,
        pos: null,
        isComfy: false,
      };
    }
    return null;
  }

  getSlotPos(node, slotIndex, isInput, fallbackPos) {
    if (!node) return fallbackPos || [0, 0];
    if (LiteGraph.vueNodesMode && typeof node.getSlotPosition === "function") {
      return node.getSlotPosition(slotIndex, isInput);
    }
    if (isInput && typeof node.getInputPos === "function") {
      return node.getInputPos(slotIndex);
    }
    if (!isInput && typeof node.getOutputPos === "function") {
      return node.getOutputPos(slotIndex);
    }
    return fallbackPos || [node.pos?.[0] || 0, node.pos?.[1] || 0];
  }

  findSuggestions(fromSlot, fromNode, wantInput, originPos) {
    const list = [];
    if (!fromSlot || this.ignoreWildcard.test(String(fromSlot.type || ""))) return list;
    const graphNodes = this.canvas?.subgraph?._nodes || this.canvas?.graph?._nodes || [];
    for (const node of graphNodes) {
      if (!node || node.id === fromNode.id || node.mode === 4) continue;
      const slots = wantInput ? node.inputs : node.outputs;
      if (!Array.isArray(slots)) continue;
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        if (!s || (wantInput && s.link != null)) continue;
        if (this.ignoreWildcard.test(String(s.type || ""))) continue;
        if (LiteGraph.isValidConnection(s.type, fromSlot.type)) {
          const dx = (node.pos?.[0] || 0) - originPos[0];
          const dy = (node.pos?.[1] || 0) - originPos[1];
          list.push({
            node,
            slot: s,
            slotIndex: i,
            dist: Math.hypot(dx, dy),
          });
        }
      }
    }
    // Sort closest compatible nodes first for fast visual scanning
    list.sort((a, b) => a.dist - b.dist);
    const limit = Math.max(1, Math.min(30, wiresConfig.qcMaxSuggestions || 15));
    return list.slice(0, limit);
  }

  commitHoverConnection() {
    const target = this.insideTarget;
    const drag = this.getActiveDrag();
    this.suggestions = null;
    this.insideTarget = null;
    if (!target || !drag) return false;

    try {
      if (drag.input) {
        if (typeof target.node.connect === "function" && typeof drag.node.connect === "function") {
          target.node.connect(target.slotIndex, drag.node, drag.slot);
        } else if (typeof drag.input.connect === "function") {
          drag.input.connect(target.node.outputs[target.slotIndex], target.node);
        }
      } else {
        if (typeof drag.node.connect === "function") {
          drag.node.connect(drag.slot, target.node, target.slotIndex);
        } else if (typeof drag.output?.connect === "function") {
          drag.output.connect(target.node.inputs[target.slotIndex], target.node);
        }
      }
      this.canvas?.setDirty(true, true);
      return true;
    } catch (e) {
      return false;
    }
  }

  handleMouseUp(origThis, origFn, args) {
    if (!wiresConfig.qcEnabled || !this.canvas) {
      return origFn.apply(origThis, args);
    }
    const origRelease = LiteGraph.release_link_on_empty_shows_menu;
    const origShowMenu = this.canvas.showConnectionMenu;
    let connected = false;
    try {
      connected = this.commitHoverConnection();
      if (connected) {
        this.suppressEmptyMenu = true;
        LiteGraph.release_link_on_empty_shows_menu = false;
        this.canvas.showConnectionMenu = () => {};
      }
      return origFn.apply(origThis, args);
    } finally {
      if (connected) {
        LiteGraph.release_link_on_empty_shows_menu = origRelease;
        this.canvas.showConnectionMenu = origShowMenu;
        this.canvas.linkConnector?.reset?.();
        this.suppressEmptyMenu = false;
      }
    }
  }

  drawOverlay(ctx) {
    if (!wiresConfig.qcEnabled || !this.canvas) return;
    this.insideTarget = null;

    const drag = this.getActiveDrag();
    if (!drag || (!drag.input && !drag.output)) {
      this.suggestions = null;
      return;
    }

    const isInput = Boolean(drag.input);
    const slotObj = isInput ? drag.input : drag.output;
    const pos = this.getSlotPos(drag.node, drag.slot, isInput, drag.pos);

    if (!this.suggestions) {
      this.suggestions = this.findSuggestions(slotObj, drag.node, !isInput, pos);
    }
    if (!this.suggestions.length) return;

    const scale = Math.max(1.0, 1 / (this.canvas.ds?.scale || 1));
    const slotH = (LiteGraph.NODE_SLOT_HEIGHT || 20) * scale;
    const rowH = slotH * 1.12;
    const baseX = pos[0] + (isInput ? -30 : 30) * scale;
    const baseY = pos[1];

    const mx = this.graphMouse[0];
    const my = this.graphMouse[1];

    // Check if pointer is in the suggestion corridor near the origin slot
    const zoneW = 240 * scale;
    const zoneX = isInput ? baseX - zoneW : baseX - 24 * scale;
    const zoneY = baseY - rowH;
    const zoneH = rowH * (this.suggestions.length + 2);
    if (mx < zoneX || mx > zoneX + zoneW + 24 * scale || my < zoneY || my > zoneY + zoneH) {
      return;
    }

    ctx.save();
    this.canvas.ds?.toCanvasContext(ctx);
    const fontSize = Math.round(11.5 * scale);
    ctx.font = `600 ${fontSize}px 'Segoe UI', system-ui, sans-serif`;
    ctx.textBaseline = "middle";

    // Pre-measure panel bounds
    let maxTextW = 0;
    const labels = this.suggestions.map((item) => {
      const title = item.node.title || item.node.type || "Node";
      const sName = item.slot.name || item.slot.type || "slot";
      const text = `${sName}  @${title}`;
      const w = ctx.measureText(text).width;
      if (w > maxTextW) maxTextW = w;
      return text;
    });

    const padX = 10 * scale;
    const dotR = 4.5 * scale;
    const pillW = maxTextW + padX * 2 + dotR * 2 + 12 * scale;
    const panelX = isInput ? baseX - pillW + 8 * scale : baseX - 8 * scale;
    const panelY = baseY - rowH * 0.55;
    const panelH = rowH * this.suggestions.length + 8 * scale;

    // Glass panel container
    ctx.fillStyle = "rgba(16, 18, 22, 0.90)";
    ctx.strokeStyle = "rgba(56, 192, 196, 0.38)";
    ctx.lineWidth = 1.2 * scale;
    ctx.beginPath();
    ctx.roundRect(panelX, panelY, pillW, panelH, 8 * scale);
    ctx.fill();
    ctx.stroke();

    const defaultColors = this.canvas.default_connection_color_byType || {};
    const fallbackColor = this.canvas.default_connection_color?.input_on || ACCENT;

    for (let i = 0; i < this.suggestions.length; i++) {
      const item = this.suggestions[i];
      const cy = baseY + i * rowH;
      const dotX = baseX;
      const hitRect = wiresConfig.qcDotOnly
        ? [dotX - slotH * 0.5, cy - rowH * 0.45, slotH, rowH * 0.9]
        : [panelX, cy - rowH * 0.45, pillW, rowH * 0.9];

      const hovered =
        !this.insideTarget &&
        mx >= hitRect[0] &&
        mx <= hitRect[0] + hitRect[2] &&
        my >= hitRect[1] &&
        my <= hitRect[1] + hitRect[3];

      const slotColor = defaultColors[item.slot.type] || fallbackColor;

      if (hovered) {
        this.insideTarget = item;
        // Highlight row pill
        ctx.fillStyle = "rgba(56, 192, 196, 0.22)";
        ctx.beginPath();
        ctx.roundRect(panelX + 3 * scale, cy - rowH * 0.44, pillW - 6 * scale, rowH * 0.88, 5 * scale);
        ctx.fill();

        // Dashed preview line to real target slot
        const destPos = this.getSlotPos(item.node, item.slotIndex, !isInput, item.node.pos);
        ctx.save();
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 2.5 * scale;
        ctx.setLineDash([6 * scale, 5 * scale]);
        ctx.beginPath();
        ctx.moveTo(pos[0], pos[1]);
        ctx.lineTo(destPos[0], destPos[1]);
        ctx.stroke();
        ctx.restore();
      }

      // Slot dot
      ctx.fillStyle = hovered ? ACCENT : slotColor;
      ctx.beginPath();
      ctx.arc(dotX, cy, hovered ? dotR * 1.25 : dotR, 0, Math.PI * 2);
      ctx.fill();

      // Label text
      ctx.fillStyle = hovered ? "#ffffff" : TEXT;
      ctx.textAlign = isInput ? "right" : "left";
      const tx = isInput ? dotX - 11 * scale : dotX + 11 * scale;
      ctx.fillText(labels[i], tx, cy);
    }

    ctx.restore();
  }

  attach(canvas) {
    if (!canvas || this.canvas === canvas) return;
    this.canvas = canvas;

    if (canvas.canvas) {
      canvas.canvas.addEventListener("litegraph:canvas", (e) => {
        if (this.suppressEmptyMenu && e.detail?.subType === "empty-release") {
          e.stopPropagation();
        }
      });
      canvas.canvas.addEventListener("pointermove", (e) => {
        if (typeof e.canvasX === "number" && typeof e.canvasY === "number") {
          this.graphMouse[0] = e.canvasX;
          this.graphMouse[1] = e.canvasY;
        } else if (this.canvas?.ds) {
          const rect = canvas.canvas.getBoundingClientRect();
          const { offset, scale } = this.canvas.ds;
          this.graphMouse[0] = (e.clientX - rect.x) / scale - offset[0];
          this.graphMouse[1] = (e.clientY - rect.y) / scale - offset[1];
        }
      });
    }

    const origDrawOverlay = canvas.onDrawOverlay;
    canvas.onDrawOverlay = (...args) => {
      if (origDrawOverlay) origDrawOverlay.apply(canvas, args);
      try {
        this.drawOverlay(args[0]);
      } catch (e) {
        // Keep canvas rendering resilient
      }
    };
  }
}

// ============================================================================
// Wire Routing & Visual Styling Engine
// ============================================================================

function getNodeBounds(nodes, pad) {
  const boxes = [];
  for (const n of nodes) {
    if (!n || !n.pos) continue;
    const x = n.pos[0];
    const y = n.pos[1] - (LiteGraph.NODE_TITLE_HEIGHT || 30);
    const w = n.flags?.collapsed ? (n._collapsed_width || 140) : (n.size?.[0] || 200);
    const h = n.flags?.collapsed ? (LiteGraph.NODE_TITLE_HEIGHT || 30) : (n.size?.[1] || 80) + (LiteGraph.NODE_TITLE_HEIGHT || 30);
    boxes.push({
      id: n.id,
      x1: x - pad,
      y1: y - pad,
      x2: x + w + pad,
      y2: y + h + pad,
    });
  }
  return boxes;
}

function segmentHitsBox(ax, ay, bx, by, box) {
  const minX = Math.min(ax, bx);
  const maxX = Math.max(ax, bx);
  const minY = Math.min(ay, by);
  const maxY = Math.max(ay, by);
  if (maxX < box.x1 || minX > box.x2 || maxY < box.y1 || minY > box.y2) return false;
  // Quick AABB-plus-midpoint check for fast real-time routing
  const mx = (ax + bx) * 0.5;
  const my = (ay + by) * 0.5;
  return (
    (mx >= box.x1 && mx <= box.x2 && my >= box.y1 && my <= box.y2) ||
    (minX <= box.x2 && maxX >= box.x1 && minY <= box.y2 && maxY >= box.y1)
  );
}

function findBlockingYClearance(ax, ay, bx, by, boxes, ignoreA, ignoreB, laneOffset) {
  let blocked = false;
  let topClear = Math.min(ay, by);
  let botClear = Math.max(ay, by);
  const minX = Math.min(ax, bx);
  const maxX = Math.max(ax, bx);

  for (const b of boxes) {
    if (b.id === ignoreA || b.id === ignoreB) continue;
    if (b.x2 < minX || b.x1 > maxX) continue;
    if (segmentHitsBox(ax, ay, bx, by, b)) {
      blocked = true;
      topClear = Math.min(topClear, b.y1);
      botClear = Math.max(botClear, b.y2);
    }
  }
  if (!blocked) return null;
  const midY = (ay + by) * 0.5;
  const distTop = Math.abs(midY - topClear);
  const distBot = Math.abs(botClear - midY);
  return distTop <= distBot ? topClear - 16 - laneOffset : botClear + 16 + laneOffset;
}

function buildRoutePoints(mode, ax, ay, bx, by, boxes, srcId, tgtId, laneIndex, busX) {
  const sp = Math.max(4, wiresConfig.wireLineSpacing || 10);
  const pad = Math.max(6, wiresConfig.wireNodePadding || 14);
  const lane = (laneIndex % 12) * sp;
  const stub = Math.max(18, pad + 8 + (laneIndex % 6) * (sp * 0.6));
  const dx = bx - ax;
  const dy = by - ay;

  if (mode === "Manhattan Grid (90 Strict)") {
    const grid = Math.max(10, sp * 2);
    const snap = (v) => Math.round(v / grid) * grid;
    const x1 = snap(ax + stub);
    const x2 = snap(bx - stub);
    if (x2 >= x1) {
      const midX = snap((x1 + x2) * 0.5 + (laneIndex % 5 - 2) * grid * 0.5);
      return [[ax, ay], [midX, ay], [midX, by], [bx, by]];
    }
    const midY = snap((ay + by) * 0.5 + (laneIndex % 5 - 2) * grid);
    return [[ax, ay], [x1, ay], [x1, midY], [x2, midY], [x2, by], [bx, by]];
  }

  if (mode === "Stepped Chamfer (Sci-Fi 45)") {
    const outX = ax + Math.max(20, stub * 0.8);
    const inX = bx - Math.max(20, stub * 0.8);
    if (inX > outX) {
      const avail = inX - outX;
      const diag = Math.min(Math.abs(dy), avail);
      const midStart = outX + (avail - diag) * 0.5;
      const midEnd = midStart + diag;
      return [[ax, ay], [midStart, ay], [midEnd, by], [bx, by]];
    }
    const detourY = findBlockingYClearance(ax, ay, bx, by, boxes, srcId, tgtId, lane) ?? ((ay + by) * 0.5 + (dy >= 0 ? 40 : -40));
    const c = Math.min(18, Math.abs(detourY - ay) * 0.4);
    return [
      [ax, ay],
      [outX, ay],
      [outX + c, ay + Math.sign(detourY - ay) * c],
      [outX + c, detourY],
      [inX - c, detourY],
      [inX - c, by - Math.sign(by - detourY) * c],
      [inX, by],
      [bx, by],
    ];
  }

  if (mode === "Nuke / Fusion Pipes") {
    const midX = dx > 40 ? ax + dx * 0.5 : ax + stub;
    if (dx > 40) {
      return [[ax, ay], [midX, ay], [midX, by], [bx, by]];
    }
    const clearY = findBlockingYClearance(ax, ay, bx, by, boxes, srcId, tgtId, lane) ?? ((ay + by) * 0.5 + 48);
    return [[ax, ay], [ax + stub, ay], [ax + stub, clearY], [bx - stub, clearY], [bx - stub, by], [bx, by]];
  }

  if (mode === "Bus / Highway Bundling") {
    const trunkX = busX != null ? busX : ax + Math.max(36, Math.min(dx * 0.35, 120));
    const laneX = trunkX + ((laneIndex % 8) - 4) * (sp * 0.75);
    if (dx > 40) {
      return [[ax, ay], [laneX, ay], [laneX, by], [bx, by]];
    }
    const clearY = findBlockingYClearance(ax, ay, bx, by, boxes, srcId, tgtId, lane) ?? (Math.min(ay, by) - 48 - lane);
    return [[ax, ay], [ax + stub, ay], [ax + stub, clearY], [bx - stub, clearY], [bx - stub, by], [bx, by]];
  }

  if (mode === "Circuit Board (PCB 90/45)" || mode === "Rounded Metro (90 Smooth)") {
    const outX = ax + stub;
    const inX = bx - stub;
    const clearY = findBlockingYClearance(outX, ay, inX, by, boxes, srcId, tgtId, lane);
    const isPcb = mode === "Circuit Board (PCB 90/45)";

    if (inX > outX && clearY == null) {
      if (isPcb && wiresConfig.wirePrefer90or45) {
        const span = inX - outX;
        const diag = Math.min(Math.abs(dy), span * 0.85);
        const turnX = outX + (span - diag) * 0.5 + ((laneIndex % 5) - 2) * (sp * 0.5);
        const clampedTurn = Math.max(outX, Math.min(inX - diag, turnX));
        return [[ax, ay], [clampedTurn, ay], [clampedTurn + diag, by], [bx, by]];
      }
      const midX = outX + (inX - outX) * 0.5 + ((laneIndex % 7) - 3) * (sp * 0.7);
      return [[ax, ay], [midX, ay], [midX, by], [bx, by]];
    }

    const routeY = clearY != null ? clearY : ((ay + by) * 0.5 + (ay <= by ? -45 - lane : 45 + lane));
    if (isPcb && wiresConfig.wirePrefer90or45) {
      const c1 = Math.min(14, Math.abs(routeY - ay) * 0.45);
      const c2 = Math.min(14, Math.abs(by - routeY) * 0.45);
      const dir1 = Math.sign(routeY - ay) || 1;
      const dir2 = Math.sign(by - routeY) || 1;
      return [
        [ax, ay],
        [outX, ay],
        [outX + c1, ay + dir1 * c1],
        [outX + c1, routeY - dir1 * c1],
        [outX, routeY],
        [inX, routeY],
        [inX - c2, routeY + dir2 * c2],
        [inX - c2, by - dir2 * c2],
        [inX, by],
        [bx, by],
      ];
    }
    return [[ax, ay], [outX, ay], [outX, routeY], [inX, routeY], [inX, by], [bx, by]];
  }

  return null;
}

// Compute intersection between two orthogonal/straight segments (for CAD Jump-Over Bridges)
function segmentIntersection(p1, p2, p3, p4) {
  const x1 = p1[0], y1 = p1[1], x2 = p2[0], y2 = p2[1];
  const x3 = p3[0], y3 = p3[1], x4 = p4[0], y4 = p4[1];
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 1e-3) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
  if (t > 0.04 && t < 0.96 && u > 0.04 && u < 0.96) {
    return { t, x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
  }
  return null;
}

function tracePolyline(ctx, pts, cornerRadius, crossingsPerSeg) {
  if (!pts || pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);

  if (crossingsPerSeg && crossingsPerSeg.size > 0) {
    // Trace segment by segment inserting clean CAD jump-over arcs at crossing points
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const hits = crossingsPerSeg.get(i);
      if (!hits || !hits.length) {
        ctx.lineTo(b[0], b[1]);
        continue;
      }
      hits.sort((u, v) => u.t - v.t);
      const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (segLen < 16) {
        ctx.lineTo(b[0], b[1]);
        continue;
      }
      const ux = (b[0] - a[0]) / segLen;
      const uy = (b[1] - a[1]) / segLen;
      const r = 6;
      const ang = Math.atan2(uy, ux);
      for (const h of hits) {
        const sx = h.x - ux * r;
        const sy = h.y - uy * r;
        ctx.lineTo(sx, sy);
        ctx.arc(h.x, h.y, r, ang + Math.PI, ang, false);
      }
      ctx.lineTo(b[0], b[1]);
    }
    return;
  }

  if (cornerRadius <= 0 || pts.length === 2) {
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    return;
  }

  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1];
    const curr = pts[i];
    const next = pts[i + 1];
    const d1 = Math.hypot(curr[0] - prev[0], curr[1] - prev[1]);
    const d2 = Math.hypot(next[0] - curr[0], next[1] - curr[1]);
    const r = Math.min(cornerRadius, d1 * 0.45, d2 * 0.45);
    if (r < 1) {
      ctx.lineTo(curr[0], curr[1]);
      continue;
    }
    const p1x = curr[0] - ((curr[0] - prev[0]) / d1) * r;
    const p1y = curr[1] - ((curr[1] - prev[1]) / d1) * r;
    const p2x = curr[0] + ((next[0] - curr[0]) / d2) * r;
    const p2y = curr[1] + ((next[1] - curr[1]) / d2) * r;
    ctx.lineTo(p1x, p1y);
    ctx.quadraticCurveTo(curr[0], curr[1], p2x, p2y);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0], last[1]);
}

function sampleCurvePoints(mode, ax, ay, bx, by, boxes, srcId, tgtId, laneIndex) {
  const dx = bx - ax;
  const dy = by - ay;
  const dist = Math.hypot(dx, dy);
  const steps = 22;
  const out = [];

  if (mode === "Catenary (Hanging Cable)") {
    const sag = Math.min(220, Math.max(24, dist * 0.24));
    const ctrlX = (ax + bx) * 0.5;
    const ctrlY = Math.max(ay, by) + sag;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const mt = 1 - t;
      out.push([
        mt * mt * ax + 2 * mt * t * ctrlX + t * t * bx,
        mt * mt * ay + 2 * mt * t * ctrlY + t * t * by,
      ]);
    }
    return out;
  }

  if (mode === "Overhead Arc") {
    const arch = Math.min(200, Math.max(30, dist * 0.22));
    const ctrlX = (ax + bx) * 0.5;
    const ctrlY = Math.min(ay, by) - arch;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const mt = 1 - t;
      out.push([
        mt * mt * ax + 2 * mt * t * ctrlX + t * t * bx,
        mt * mt * ay + 2 * mt * t * ctrlY + t * t * by,
      ]);
    }
    return out;
  }

  if (mode === "Smart-Avoid Spline") {
    const clearY = findBlockingYClearance(ax, ay, bx, by, boxes, srcId, tgtId, (laneIndex % 8) * 10);
    const bend = Math.max(60, Math.abs(dx) * 0.45);
    const cp1x = ax + bend;
    const cp2x = bx - bend;
    const cp1y = clearY != null ? clearY : ay;
    const cp2y = clearY != null ? clearY : by;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const mt = 1 - t;
      out.push([
        mt * mt * mt * ax + 3 * mt * mt * t * cp1x + 3 * mt * t * t * cp2x + t * t * t * bx,
        mt * mt * mt * ay + 3 * mt * mt * t * cp1y + 3 * mt * t * t * cp2y + t * t * t * by,
      ]);
    }
    return out;
  }

  // Default smooth ComfyUI Bezier spline
  const bend = Math.max(40, Math.min(Math.abs(dx) * 0.5, 240));
  const cp1x = ax + bend;
  const cp2x = bx - bend;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    out.push([
      mt * mt * mt * ax + 3 * mt * mt * t * cp1x + 3 * mt * t * t * cp2x + t * t * t * bx,
      mt * mt * mt * ay + 3 * mt * mt * t * ay + 3 * mt * t * t * by + t * t * t * by,
    ]);
  }
  return out;
}

function drawTaperedRibbon(ctx, pts, color, startW, endW) {
  if (!pts || pts.length < 2) return;
  const left = [];
  const right = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(n - 1, i + 1)];
    let tx = next[0] - prev[0];
    let ty = next[1] - prev[1];
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    const nx = -ty;
    const ny = tx;
    const frac = i / (n - 1);
    const halfW = (startW * (1 - frac) + endW * frac) * 0.5;
    left.push([pts[i][0] + nx * halfW, pts[i][1] + ny * halfW]);
    right.push([pts[i][0] - nx * halfW, pts[i][1] - ny * halfW]);
  }
  ctx.beginPath();
  ctx.moveTo(left[0][0], left[0][1]);
  for (let i = 1; i < n; i++) ctx.lineTo(left[i][0], left[i][1]);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function pointAlongPolyline(pts, frac) {
  if (!pts || pts.length < 2) return null;
  let total = 0;
  const lens = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    lens.push(l);
    total += l;
  }
  if (total < 1) return null;
  let target = total * frac;
  for (let i = 0; i < lens.length; i++) {
    if (target <= lens[i] || i === lens.length - 1) {
      const t = lens[i] > 0 ? target / lens[i] : 0;
      const x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t;
      const y = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
      const ang = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
      return { x, y, ang };
    }
    target -= lens[i];
  }
  return null;
}

function offsetPolyline(pts, offset) {
  if (!pts || pts.length < 2) return pts;
  const n = pts.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(n - 1, i + 1)];
    let tx = next[0] - prev[0];
    let ty = next[1] - prev[1];
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    out[i] = [pts[i][0] - ty * offset, pts[i][1] + tx * offset];
  }
  return out;
}

function samplePointsAlongPolyline(pts, spacingPx, phaseOffsetPx = 0, maxSamples = 24) {
  const res = [];
  if (!pts || pts.length < 2 || spacingPx <= 4) return res;
  let total = 0;
  const lens = new Array(pts.length - 1);
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    lens[i] = l;
    total += l;
  }
  if (total < spacingPx * 0.6) return res;
  const step = Math.max(spacingPx, total / maxSamples);
  let target = ((phaseOffsetPx % step) + step) % step;
  if (target < 14) target += step * 0.5;
  let segIdx = 0;
  let segStart = 0;
  while (target < total - 12 && res.length < maxSamples) {
    while (segIdx < lens.length - 1 && segStart + lens[segIdx] < target) {
      segStart += lens[segIdx];
      segIdx++;
    }
    const segLen = lens[segIdx];
    if (segLen > 0.5) {
      const t = Math.min(1, Math.max(0, (target - segStart) / segLen));
      const a = pts[segIdx];
      const b = pts[segIdx + 1];
      res.push({
        x: a[0] + (b[0] - a[0]) * t,
        y: a[1] + (b[1] - a[1]) * t,
        ang: Math.atan2(b[1] - a[1], b[0] - a[0]),
      });
    }
    target += step;
  }
  return res;
}

function drawChevronAt(ctx, x, y, ang, size, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, size * 0.34);
  ctx.beginPath();
  ctx.moveTo(-size * 0.55, -size * 0.72);
  ctx.lineTo(size * 0.55, 0);
  ctx.lineTo(-size * 0.55, size * 0.72);
  ctx.stroke();
  ctx.restore();
}

function drawSolderPad(ctx, x, y, r, color) {
  ctx.fillStyle = "#111111";
  ctx.beginPath();
  ctx.arc(x, y, r + 1.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#141414";
  ctx.beginPath();
  ctx.arc(x, y, Math.max(1.2, r * 0.45), 0, Math.PI * 2);
  ctx.fill();
}

function drawEndpointFlare(ctx, x, y, r, color, alpha) {
  ctx.globalAlpha = alpha * 0.28;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r * 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(x, y, r * 0.85, 0, Math.PI * 2);
  ctx.fill();
}

function drawDirectionArrow(ctx, pts, color) {
  const mid = pointAlongPolyline(pts, 0.5);
  if (!mid) return;
  ctx.save();
  ctx.translate(mid.x, mid.y);
  ctx.rotate(mid.ang);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(7, 0);
  ctx.lineTo(-5, -4.5);
  ctx.lineTo(-2.5, 0);
  ctx.lineTo(-5, 4.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawPortalBadge(ctx, x, y, label, color, isOrigin) {
  ctx.save();
  ctx.font = "600 10px 'Segoe UI', system-ui, sans-serif";
  ctx.textBaseline = "middle";
  const textW = ctx.measureText(label).width;
  const w = textW + 18;
  const h = 18;
  const rx = isOrigin ? x + 8 : x - w - 8;
  const ry = y - h * 0.5;

  // Short leader stem
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(isOrigin ? rx : rx + w, y);
  ctx.stroke();

  // Pill background
  ctx.fillStyle = "rgba(16, 18, 22, 0.90)";
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.roundRect(rx, ry, w, h, 9);
  ctx.fill();
  ctx.stroke();

  // Indicator dot
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(rx + 7, y, 2.8, 0, Math.PI * 2);
  ctx.fill();

  // Label
  ctx.fillStyle = TEXT;
  ctx.textAlign = "left";
  ctx.fillText(label, rx + 13, y + 0.5);
  ctx.restore();
}

function getFocusedNodeIds(canvas) {
  const ids = new Set();
  if (canvas?.node_over) ids.add(canvas.node_over.id);
  if (canvas?.selectedItems instanceof Set) {
    for (const item of canvas.selectedItems) {
      if (item && item.id != null) ids.add(item.id);
    }
  } else if (canvas?.selected_nodes) {
    for (const k of Object.keys(canvas.selected_nodes)) {
      const n = canvas.selected_nodes[k];
      if (n && n.id != null) ids.add(n.id);
    }
  }
  return ids;
}

class LiveDevWireRenderer {
  shouldIntercept(canvas) {
    if (!canvas || !canvas.graph) return false;
    if (_eyeHidden || canvas.links_render_mode < 0) return false;
    const mode = wiresConfig.wireMode;
    const hasCustomMode = mode !== "Default (ComfyUI)" && mode !== "On Top (Above Nodes)";
    const hasCustomEffects =
      wiresConfig.wireVisualStyle !== "Normal" ||
      wiresConfig.wireFocusMode ||
      wiresConfig.wireJumpBridges ||
      (wiresConfig.wireLivePulse && _runningNodeId != null);
    return hasCustomMode || hasCustomEffects;
  }

  _buildCacheKey(nodes, linksIterable, mode) {
    let sig =
      mode +
      "|" +
      (wiresConfig.wireLineSpacing || 10) +
      "|" +
      (wiresConfig.wireNodePadding || 14) +
      "|" +
      (wiresConfig.wirePrefer90or45 ? 1 : 0) +
      "|" +
      (wiresConfig.wireJumpBridges ? 1 : 0) +
      "|" +
      nodes.length +
      ":";
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n || !n.pos) continue;
      sig +=
        n.id +
        "," +
        Math.round(n.pos[0]) +
        "," +
        Math.round(n.pos[1]) +
        "," +
        Math.round(n.size?.[0] || 0) +
        "," +
        Math.round(n.size?.[1] || 0) +
        "," +
        (n.flags?.collapsed ? 1 : 0) +
        ";";
    }
    sig += "|L:";
    for (const link of linksIterable) {
      if (!link) continue;
      sig += link.id + "," + link.origin_id + "," + link.origin_slot + "," + link.target_id + "," + link.target_slot + ";";
    }
    return sig;
  }

  drawAllLinks(canvas, ctx) {
    const graph = canvas.graph;
    if (!graph || !graph.links) return false;
    const nodes = graph._nodes || [];
    const linksList = graph.links instanceof Map ? Array.from(graph.links.values()) : Object.values(graph.links);

    const mode = wiresConfig.wireMode;
    const style = wiresConfig.wireVisualStyle;
    const focusedIds = getFocusedNodeIds(canvas);
    const focusActive = wiresConfig.wireFocusMode && focusedIds.size > 0;
    const defaultColors = canvas.default_connection_color_byType || {};
    const baseWidth = Math.max(1.5, canvas.connections_width || 3);

    // Reuse cached routes & CAD crossings when nodes, links, and routing settings haven't changed
    const cacheKey = this._buildCacheKey(nodes, linksList, mode);
    let entries = _routeCache.entries;
    let crossingsByEntry = _routeCache.crossingsByEntry;

    if (_routeCache.key !== cacheKey || !entries || !crossingsByEntry) {
      const nodeById = new Map();
      for (const n of nodes) nodeById.set(n.id, n);

      const pad = Math.max(6, wiresConfig.wireNodePadding || 14);
      const boxes = getNodeBounds(nodes, pad);

      // Precompute bus channels per source node for Bus / Highway Bundling
      const busChannelX = new Map();
      if (mode === "Bus / Highway Bundling") {
        for (const n of nodes) {
          const nx = (n.pos?.[0] || 0) + (n.size?.[0] || 200) + 46;
          busChannelX.set(n.id, nx);
        }
      }

      entries = [];
      let idx = 0;
      for (const link of linksList) {
        if (!link) continue;
        const src = nodeById.get(link.origin_id);
        const tgt = nodeById.get(link.target_id);
        if (!src || !tgt) continue;

        const a = typeof src.getOutputPos === "function" ? src.getOutputPos(link.origin_slot) : src.pos;
        const b = typeof tgt.getInputPos === "function" ? tgt.getInputPos(link.target_slot) : tgt.pos;
        if (!a || !b || !Number.isFinite(a[0]) || !Number.isFinite(a[1]) || !Number.isFinite(b[0]) || !Number.isFinite(b[1])) {
          continue;
        }

        const slotType = link.type || src.outputs?.[link.origin_slot]?.type;
        const tgtType = tgt.inputs?.[link.target_slot]?.type || slotType;
        const color = link.color || defaultColors[slotType] || ACCENT;
        const targetColor = defaultColors[tgtType] || color;
        const span = Math.hypot(b[0] - a[0], b[1] - a[1]);

        let pts = null;
        let isPolyline = false;
        let cornerRadius = 0;

        const poly = buildRoutePoints(
          mode,
          a[0],
          a[1],
          b[0],
          b[1],
          boxes,
          src.id,
          tgt.id,
          idx,
          busChannelX.get(src.id)
        );
        if (poly) {
          pts = poly;
          isPolyline = true;
          cornerRadius =
            mode === "Rounded Metro (90 Smooth)" || mode === "Bus / Highway Bundling"
              ? 12
              : mode === "Nuke / Fusion Pipes"
              ? 6
              : mode === "Circuit Board (PCB 90/45)"
              ? 5
              : 0;
        } else {
          pts = sampleCurvePoints(mode, a[0], a[1], b[0], b[1], boxes, src.id, tgt.id, idx);
        }

        entries.push({
          link,
          src,
          tgt,
          a: [a[0], a[1]],
          b: [b[0], b[1]],
          span,
          color,
          targetColor,
          pts,
          isPolyline,
          cornerRadius,
        });
        idx++;
      }

      // Optional CAD Jump-Over Bridges for polyline crossings (cached + fast AABB rejection)
      crossingsByEntry = new Map();
      if (wiresConfig.wireJumpBridges && entries.length <= 120) {
        let totalCrossings = 0;
        const MAX_CROSSINGS = 250;
        outer: for (let i = 0; i < entries.length; i++) {
          const e1 = entries[i];
          if (!e1.pts || !e1.isPolyline) continue;
          for (let j = 0; j < i; j++) {
            const e2 = entries[j];
            if (!e2.pts || !e2.isPolyline) continue;
            if (e1.src.id === e2.src.id && e1.link.origin_slot === e2.link.origin_slot) continue;
            for (let s1 = 0; s1 < e1.pts.length - 1; s1++) {
              const p1 = e1.pts[s1], p2 = e1.pts[s1 + 1];
              const minX1 = p1[0] < p2[0] ? p1[0] : p2[0];
              const maxX1 = p1[0] > p2[0] ? p1[0] : p2[0];
              const minY1 = p1[1] < p2[1] ? p1[1] : p2[1];
              const maxY1 = p1[1] > p2[1] ? p1[1] : p2[1];
              for (let s2 = 0; s2 < e2.pts.length - 1; s2++) {
                const p3 = e2.pts[s2], p4 = e2.pts[s2 + 1];
                if (
                  (p3[0] < minX1 && p4[0] < minX1) ||
                  (p3[0] > maxX1 && p4[0] > maxX1) ||
                  (p3[1] < minY1 && p4[1] < minY1) ||
                  (p3[1] > maxY1 && p4[1] > maxY1)
                ) {
                  continue;
                }
                const hit = segmentIntersection(p1, p2, p3, p4);
                if (hit) {
                  let map = crossingsByEntry.get(i);
                  if (!map) {
                    map = new Map();
                    crossingsByEntry.set(i, map);
                  }
                  let arr = map.get(s1);
                  if (!arr) {
                    arr = [];
                    map.set(s1, arr);
                  }
                  arr.push(hit);
                  if (++totalCrossings >= MAX_CROSSINGS) break outer;
                }
              }
            }
          }
        }
      }

      _routeCache = { key: cacheKey, entries, crossingsByEntry };
    }

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const nowMs = performance.now();
    const pulsePhase = wiresConfig.wireLivePulse && _runningNodeId != null
      ? (nowMs * 0.0012) % 1
      : 0;
    const flowOffset = (nowMs * 0.045) % 24;
    const beadOffset = (nowMs * 0.055) % 80;
    const portalThreshold = wiresConfig.wirePortalDistance || 550;

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const isFocused = focusedIds.has(e.src.id) || focusedIds.has(e.tgt.id);
      const isExecuting =
        _runningNodeId != null &&
        (String(e.src.id) === String(_runningNodeId) || String(e.tgt.id) === String(_runningNodeId));
      const isPortalCollapsed =
        mode === "Smart Wireless Portal" &&
        e.span > portalThreshold &&
        !isFocused &&
        !isExecuting;

      const alpha = focusActive ? (isFocused || isExecuting ? 1.0 : 0.14) : 0.94;
      ctx.globalAlpha = alpha;

      if (isPortalCollapsed) {
        const tgtLabel = (e.tgt.title || e.tgt.type || "Node").slice(0, 14);
        const srcLabel = (e.src.title || e.src.type || "Node").slice(0, 14);
        drawPortalBadge(ctx, e.a[0], e.a[1], `\u2192 ${tgtLabel}`, e.color, true);
        drawPortalBadge(ctx, e.b[0], e.b[1], `${srcLabel} \u2192`, e.color, false);
        continue;
      }

      const lw = isFocused && focusActive ? baseWidth * 1.25 : baseWidth;
      const segCrossings = crossingsByEntry.get(i) || null;
      const effRadius = segCrossings ? 0 : e.cornerRadius;

      if (style === "Tapered Ribbon") {
        drawTaperedRibbon(ctx, e.pts, e.color, lw * 2.1, Math.max(1.2, lw * 0.55));
      } else if (style === "Double Rail (Twin Track)") {
        const railGap = Math.max(2.1, lw * 0.72);
        const railW = Math.max(1.2, lw * 0.52);
        const leftRail = offsetPolyline(e.pts, railGap);
        const rightRail = offsetPolyline(e.pts, -railGap);
        ctx.setLineDash([]);
        // Soft center web
        tracePolyline(ctx, e.pts, effRadius, segCrossings);
        ctx.globalAlpha = alpha * 0.16;
        ctx.strokeStyle = e.color;
        ctx.lineWidth = railGap * 1.6;
        ctx.stroke();
        // Twin parallel rails
        ctx.globalAlpha = alpha;
        ctx.lineWidth = railW;
        tracePolyline(ctx, leftRail, effRadius, null);
        ctx.stroke();
        tracePolyline(ctx, rightRail, effRadius, null);
        ctx.stroke();
      } else {
        tracePolyline(ctx, e.pts, effRadius, segCrossings);

        if (style === "Neon Glow Tube") {
          ctx.setLineDash([]);
          ctx.strokeStyle = e.color;
          ctx.globalAlpha = alpha * 0.20;
          ctx.lineWidth = lw * 3.2;
          ctx.stroke();
          ctx.globalAlpha = alpha * 0.50;
          ctx.lineWidth = lw * 1.8;
          ctx.stroke();
          ctx.globalAlpha = alpha;
          ctx.lineWidth = lw;
          ctx.stroke();
          ctx.strokeStyle = "rgba(255, 255, 255, 0.76)";
          ctx.lineWidth = Math.max(1, lw * 0.34);
          ctx.stroke();
        } else if (style === "Fiber Optic Core") {
          ctx.setLineDash([]);
          ctx.globalAlpha = alpha * 0.72;
          ctx.strokeStyle = "rgba(12, 14, 18, 0.92)";
          ctx.lineWidth = lw * 2.15;
          ctx.stroke();
          ctx.globalAlpha = alpha * 0.45;
          ctx.strokeStyle = e.color;
          ctx.lineWidth = lw * 1.25;
          ctx.stroke();
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = e.color;
          ctx.lineWidth = Math.max(1.2, lw * 0.62);
          ctx.stroke();
          ctx.strokeStyle = "rgba(255, 255, 255, 0.88)";
          ctx.lineWidth = Math.max(0.8, lw * 0.24);
          ctx.stroke();
        } else if (style === "Laser Beam") {
          ctx.setLineDash([]);
          ctx.strokeStyle = e.color;
          ctx.globalAlpha = alpha * 0.24;
          ctx.lineWidth = lw * 2.5;
          ctx.stroke();
          ctx.globalAlpha = alpha;
          ctx.lineWidth = Math.max(1.3, lw * 0.68);
          ctx.stroke();
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = Math.max(0.9, lw * 0.32);
          ctx.stroke();
          drawEndpointFlare(ctx, e.a[0], e.a[1], Math.max(2.2, lw * 0.85), e.color, alpha);
          drawEndpointFlare(ctx, e.b[0], e.b[1], Math.max(2.2, lw * 0.85), e.targetColor || e.color, alpha);
        } else if (style === "Gradient Flow (Source -> Target)") {
          ctx.setLineDash([]);
          const grad = ctx.createLinearGradient(e.a[0], e.a[1], e.b[0], e.b[1]);
          grad.addColorStop(0, e.color);
          if (e.targetColor && e.targetColor !== e.color) {
            grad.addColorStop(0.5, ACCENT);
            grad.addColorStop(1, e.targetColor);
          } else {
            grad.addColorStop(0.5, "#ffffff");
            grad.addColorStop(1, e.color);
          }
          ctx.globalAlpha = alpha * 0.24;
          ctx.strokeStyle = grad;
          ctx.lineWidth = lw * 2.1;
          ctx.stroke();
          ctx.globalAlpha = alpha;
          ctx.lineWidth = lw * 1.05;
          ctx.stroke();
        } else if (style === "Flowing Energy (Animated)") {
          ctx.setLineDash([]);
          ctx.globalAlpha = alpha * 0.30;
          ctx.strokeStyle = e.color;
          ctx.lineWidth = lw * 1.15;
          ctx.stroke();
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = e.color;
          ctx.lineWidth = lw;
          ctx.setLineDash([12, 12]);
          ctx.lineDashOffset = -flowOffset;
          ctx.stroke();
          ctx.strokeStyle = "rgba(255, 255, 255, 0.72)";
          ctx.lineWidth = Math.max(0.9, lw * 0.35);
          ctx.setLineDash([5, 19]);
          ctx.lineDashOffset = -flowOffset;
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.lineDashOffset = 0;
        } else if (style === "Pulse Beads (Animated)") {
          ctx.setLineDash([]);
          ctx.globalAlpha = alpha * 0.36;
          ctx.strokeStyle = e.color;
          ctx.lineWidth = Math.max(1.2, lw * 0.75);
          ctx.stroke();
          const beads = samplePointsAlongPolyline(e.pts, 80, beadOffset, 18);
          for (let bIdx = 0; bIdx < beads.length; bIdx++) {
            const p = beads[bIdx];
            ctx.globalAlpha = alpha * 0.28;
            ctx.fillStyle = e.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, lw * 1.9, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = alpha;
            ctx.fillStyle = "#ffffff";
            ctx.beginPath();
            ctx.arc(p.x, p.y, Math.max(1.4, lw * 0.78), 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (style === "Outlined Cable (High Contrast)") {
          ctx.setLineDash([]);
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = "#0b0b0b";
          ctx.lineWidth = lw + 3.0;
          ctx.stroke();
          ctx.strokeStyle = e.color;
          ctx.lineWidth = lw;
          ctx.stroke();
        } else if (style === "3D Glossy Pipe") {
          ctx.setLineDash([]);
          // Soft drop shadow beneath cable
          const shadowPts = e.pts.map((pt) => [pt[0], pt[1] + lw * 0.65]);
          tracePolyline(ctx, shadowPts, effRadius, null);
          ctx.globalAlpha = alpha * 0.38;
          ctx.strokeStyle = "#000000";
          ctx.lineWidth = lw * 1.7;
          ctx.stroke();
          // Main pipe body with dark rim
          tracePolyline(ctx, e.pts, effRadius, segCrossings);
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = "#111111";
          ctx.lineWidth = lw * 1.65;
          ctx.stroke();
          ctx.strokeStyle = e.color;
          ctx.lineWidth = lw * 1.3;
          ctx.stroke();
          // Specular glossy highlight shifted slightly upward
          const glossPts = e.pts.map((pt) => [pt[0], pt[1] - lw * 0.26]);
          tracePolyline(ctx, glossPts, effRadius, null);
          ctx.globalAlpha = alpha * 0.55;
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = Math.max(0.9, lw * 0.32);
          ctx.stroke();
        } else if (style === "Glass Tube") {
          ctx.setLineDash([]);
          // Outer frosted glass shell
          ctx.globalAlpha = alpha * 0.18;
          ctx.strokeStyle = e.color;
          ctx.lineWidth = lw * 2.55;
          ctx.stroke();
          // Crisp outer edge outline
          ctx.globalAlpha = alpha * 0.55;
          ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
          ctx.lineWidth = lw * 1.85;
          ctx.stroke();
          // Hollow dark tinted glass interior
          ctx.globalAlpha = alpha * 0.72;
          ctx.strokeStyle = "rgba(16, 18, 22, 0.82)";
          ctx.lineWidth = lw * 1.35;
          ctx.stroke();
          // Inner tinted energy tint + top reflection
          ctx.globalAlpha = alpha * 0.78;
          ctx.strokeStyle = e.color;
          ctx.lineWidth = Math.max(1.2, lw * 0.55);
          ctx.stroke();
          const rimPts = e.pts.map((pt) => [pt[0], pt[1] - lw * 0.42]);
          tracePolyline(ctx, rimPts, effRadius, null);
          ctx.globalAlpha = alpha * 0.42;
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = Math.max(0.8, lw * 0.22);
          ctx.stroke();
        } else if (style === "Circuit Trace (Solder Pads)") {
          ctx.setLineDash([]);
          // PCB solder-mask outline + trace
          ctx.globalAlpha = alpha * 0.85;
          ctx.strokeStyle = "#0e0e0e";
          ctx.lineWidth = lw + 2.4;
          ctx.stroke();
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = e.color;
          ctx.lineWidth = Math.max(1.5, lw * 0.88);
          ctx.stroke();
          const padR = Math.max(3.2, lw * 1.15);
          drawSolderPad(ctx, e.a[0], e.a[1], padR, e.color);
          drawSolderPad(ctx, e.b[0], e.b[1], padR, e.targetColor || e.color);
          // Add copper via pads at sharp bends on polyline routes
          if (e.isPolyline && e.pts.length > 2) {
            for (let k = 1; k < e.pts.length - 1; k++) {
              drawSolderPad(ctx, e.pts[k][0], e.pts[k][1], Math.max(2.4, lw * 0.82), e.color);
            }
          }
        } else if (style === "Dashed Technical") {
          ctx.strokeStyle = e.color;
          ctx.lineWidth = lw;
          ctx.setLineDash([8, 5]);
          ctx.stroke();
          ctx.setLineDash([]);
        } else if (style === "Blueprint Dotted") {
          ctx.setLineDash([]);
          ctx.globalAlpha = alpha * 0.20;
          ctx.strokeStyle = e.color;
          ctx.lineWidth = Math.max(1, lw * 0.45);
          ctx.stroke();
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = e.color;
          ctx.lineWidth = Math.max(2, lw * 0.95);
          ctx.setLineDash([1.2, 8.5]);
          ctx.stroke();
          ctx.setLineDash([]);
        } else if (style === "Directional Chevrons") {
          ctx.setLineDash([]);
          ctx.globalAlpha = alpha * 0.55;
          ctx.strokeStyle = e.color;
          ctx.lineWidth = Math.max(1.4, lw * 0.78);
          ctx.stroke();
          ctx.globalAlpha = alpha;
          const chevrons = samplePointsAlongPolyline(e.pts, 46, 23, 22);
          const chSize = Math.max(4.5, lw * 1.65);
          for (let cIdx = 0; cIdx < chevrons.length; cIdx++) {
            const p = chevrons[cIdx];
            drawChevronAt(ctx, p.x, p.y, p.ang, chSize, e.color);
          }
        } else {
          ctx.strokeStyle = e.color;
          ctx.lineWidth = lw;
          ctx.setLineDash([]);
          ctx.stroke();
        }
      }

      // Nuke / Fusion pipes always draw a crisp centered directional arrow
      if (mode === "Nuke / Fusion Pipes") {
        ctx.globalAlpha = alpha;
        drawDirectionArrow(ctx, e.pts, e.color);
      }

      // Live Execution Data Pulses along active node links (halo ring + bright core, no shadowBlur stall)
      if (wiresConfig.wireLivePulse && isExecuting) {
        for (let k = 0; k < 2; k++) {
          const p = pointAlongPolyline(e.pts, (pulsePhase + k * 0.5) % 1);
          if (!p) continue;
          ctx.globalAlpha = 0.32;
          ctx.fillStyle = e.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, lw * 2.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1.0;
          ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          ctx.arc(p.x, p.y, lw * 1.15, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    ctx.restore();
    return true;
  }
}

// ============================================================================
// Extension Installation & ComfyUI Hooks
// ============================================================================

const qc = new LiveDevQuickConnections();
const renderer = new LiveDevWireRenderer();

function watchEyeButton() {
  const check = () => {
    const eye = document.querySelector(".pi-eye, .pi-eye-slash");
    if (!eye) return false;
    const update = () => { _eyeHidden = eye.classList.contains("pi-eye-slash"); };
    update();
    const host = eye.parentNode || eye;
    if (!host._livedevEyeBound) {
      host._livedevEyeBound = true;
      host.addEventListener("click", () => setTimeout(update, 0));
      host.addEventListener("keyup", () => setTimeout(update, 0));
    }
    return true;
  };
  if (!check()) setTimeout(watchEyeButton, 1500);
}

function installHooks() {
  if (_installed) return;
  _installed = true;

  // Quick Connections mouse hooks
  const origMouseDown = LGraphCanvas.prototype.processMouseDown;
  LGraphCanvas.prototype.processMouseDown = function (...args) {
    qc.suggestions = null;
    return origMouseDown.apply(this, args);
  };

  const origMouseUp = LGraphCanvas.prototype.processMouseUp;
  LGraphCanvas.prototype.processMouseUp = function (...args) {
    return qc.handleMouseUp(this, origMouseUp, args);
  };

  // Wire routing & styling hook
  const origDrawConnections = LGraphCanvas.prototype.drawConnections;
  LGraphCanvas.prototype.drawConnections = function (ctx) {
    try {
      if (renderer.shouldIntercept(this)) {
        if (renderer.drawAllLinks(this, ctx)) return;
      }
    } catch (e) {
      // Fall back safely to native ComfyUI link rendering
    }
    return origDrawConnections.apply(this, arguments);
  };

  // Track active node execution for Live Data Pulses
  api.addEventListener("executing", (ev) => {
    const id = ev?.detail ?? null;
    _runningNodeId = id != null && id !== "" ? id : null;
    _syncPulseLoop();
  });
  api.addEventListener("execution_error", () => {
    _runningNodeId = null;
    _syncPulseLoop();
  });

  watchEyeButton();
}

app.registerExtension({
  name: "LiveDev.Wires",
  async setup() {
    installHooks();
    let attempts = 0;
    const bindCanvas = () => {
      if (app?.canvas) {
        qc.attach(app.canvas);
        applyWireSettings();
      } else if (++attempts < 40) {
        setTimeout(bindCanvas, 300);
      }
    };
    bindCanvas();
  },
});
