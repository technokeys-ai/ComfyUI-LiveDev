// LiveDev Wires & Quick Connections engine.
//
// Combines drag-to-connect quick slot suggestions with 12 wire routing modes, 24 composable
// visual & animated effects (including Neon Glow, Fiber Optic, Laser Beam, Gradient Flow,
// Flowing Energy, Pulse Beads, Pulsation, Color Flow, Jelly Wave, Neon Plasma, Sparkling
// Electricity, DNA Helix, Dripping Lava, Water Pipe Flow, Tapered Ribbon, Double Rail,
// Outlined Cable, 3D Glossy Pipe, Glass Tube, Circuit Trace, Dashed Technical, Blueprint
// Dotted, Directional Chevrons), selective per-node & per-slot wire hiding with HUD slot
// indicators (WiFi, Dashed Circle, Circle, Triangle), dynamic Hover/Click reveal modes,
// Focus Dimming, CAD Jump-Over Bridges, Live Execution Data Pulses, and configurable FPS
// throttling. Every toggle is controlled live from ComfyUI Settings under
// "LiveDev -> Wires & Connections".

import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import { ACCENT, SURFACE, SURFACE_DEEP, TEXT, LD_ICONS, ensureTheme } from "./livedev-theme.js";
import { showToast } from "./utils.js";
import { isSameFoldGroup } from "./visual-fold.js";

function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem("livedev_" + key);
    return raw != null ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

export const WIRE_MODES = [
  "Smart Wireless Portal",
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
  "On Top (Above Nodes)",
];

export const WIRE_VISUAL_STYLES = [
  "Normal",
  // Animated effects
  "Flowing Energy (Animated)",
  "Pulse Beads (Animated)",
  "Pulsation (Animated)",
  "Color Flow (Animated)",
  "Jelly Wave (Animated)",
  "Neon Plasma Flow (Animated)",
  "Sparkling Electricity (Animated)",
  "DNA Helix Spiral (Animated)",
  "Dripping Lava (Animated)",
  "Water Pipe Flow (Animated)",
  // Static effects
  "Neon Glow Tube",
  "Fiber Optic Core",
  "Laser Beam",
  "Gradient Flow (Source -> Target)",
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
  "Pulsation (Animated)",
  "Color Flow (Animated)",
  "Jelly Wave (Animated)",
  "Neon Plasma Flow (Animated)",
  "Sparkling Electricity (Animated)",
  "DNA Helix Spiral (Animated)",
  "Dripping Lava (Animated)",
  "Water Pipe Flow (Animated)",
]);

export const WIRE_REVEAL_MODES = [
  "Show On Hover (All Links)",
  "Show On Hover (Hidden Links)",
  "Show On Click / Selection (All Links)",
  "Show On Click / Selection (Hidden Links)",
  "Hide Always",
];

export const WIRE_SLOT_SHAPES = [
  "WiFi Icon",
  "Dashed Circle",
  "Circle",
  "Triangle",
  "None",
];

export const WIRE_SLOT_COLORS = [
  "Match Slot Color",
  "LiveDev Accent",
  "Pure White",
  "Neutral Grey",
];

export const WIRE_ANIM_FPS_MODES = [
  "Power Saver (15 FPS)",
  "Balanced (30 FPS)",
  "Smooth (60+ FPS)",
];

// Live configuration read directly by both controllers
export const wiresConfig = {
  qcEnabled: lsGet("qcEnabled", true),
  qcDotOnly: lsGet("qcDotOnly", false),
  qcMaxSuggestions: Number(lsGet("qcMaxSuggestions", 15)) || 15,
  wireMode: lsGet("wireMode", "Smart Wireless Portal"),
  wirePrefer90or45: lsGet("wirePrefer90or45", true),
  wireLineSpacing: Number(lsGet("wireLineSpacing", 10)) || 10,
  wireNodePadding: Number(lsGet("wireNodePadding", 14)) || 14,
  wirePortalDistance: Number(lsGet("wirePortalDistance", 550)) || 550,
  wireVisualStyle: lsGet("wireVisualStyle", "Flowing Energy (Animated)"),
  wireFocusMode: lsGet("wireFocusMode", false),
  wireJumpBridges: lsGet("wireJumpBridges", false),
  wireLivePulse: lsGet("wireLivePulse", false),
  wireRevealMode: lsGet("wireRevealMode", "Show On Hover (All Links)"),
  wireSlotShape: lsGet("wireSlotShape", "WiFi Icon"),
  wireSlotColor: lsGet("wireSlotColor", "Match Slot Color"),
  wireAnimFps: lsGet("wireAnimFps", "Power Saver (15 FPS)"),
  wireAnimateOnInteractOnly: lsGet("wireAnimateOnInteractOnly", true),
  wireContextMenu: lsGet("wireContextMenu", true),
  wireSlotPill: lsGet("wireSlotPill", true),
};

let _runningNodeId = null;
let _pulseRaf = null;
let _installed = false;
let _eyeHidden = false;
let _stylePreviewUntil = 0;
let _previewTimer = null;
let _routeCache = { key: "", entries: null, crossingsByEntry: null };

function _syncGraphWireFlags(targetGraph) {
  const onTop = wiresConfig.wireMode === "On Top (Above Nodes)";
  const visited = new Set();
  const applyOne = (g) => {
    if (!g || visited.has(g)) return;
    visited.add(g);
    if (g.config) g.config.links_ontop = onTop;
    const subs = g.subgraphs;
    if (subs instanceof Map) {
      for (const sg of subs.values()) applyOne(sg);
    } else if (subs && typeof subs === "object") {
      for (const sg of Object.values(subs)) applyOne(sg);
    }
  };
  applyOne(targetGraph);
  applyOne(app?.canvas?.graph);
  applyOne(app?.graph);
  applyOne(app?.canvas?.subgraph);
}

export function applyWireSettings(patch, opts = null) {
  const isInteractiveChange = !opts?.silent && patch && typeof patch === "object";
  if (patch && typeof patch === "object") {
    Object.assign(wiresConfig, patch);
  }
  if (isInteractiveChange && ("wireVisualStyle" in patch || "wireAnimFps" in patch)) {
    // Brief live-preview window so switching effects in Settings shows live immediately
    // on the canvas behind the modal even with Animate-Only-On-Hover or Wireless Portal.
    _stylePreviewUntil = performance.now() + 5000;
    if (_previewTimer) clearTimeout(_previewTimer);
    _previewTimer = setTimeout(() => {
      _previewTimer = null;
      _syncPulseLoop();
      if (app?.canvas) {
        app.canvas.setDirty(true, true);
        if (typeof app.canvas.draw === "function") app.canvas.draw(true, true);
      }
    }, 5050);
  } else if (isInteractiveChange && "wireMode" in patch) {
    _stylePreviewUntil = 0;
    if (_previewTimer) {
      clearTimeout(_previewTimer);
      _previewTimer = null;
    }
  }
  _routeCache.key = "";
  const canvas = app?.canvas;
  _syncGraphWireFlags(canvas?.graph || app?.graph);
  _syncPulseLoop();
  if (!opts?.silent && canvas) {
    canvas.setDirty(true, true);
    if (typeof canvas.draw === "function") {
      canvas.draw(true, true);
    }
  }
}

// ============================================================================
// Animation loop (active ONLY while executing with pulse OR using an animated
// wire visual effect; respects FPS throttling and auto-pauses when idle/hidden)
// ============================================================================

function _getAnimIntervalMs() {
  if (wiresConfig.wireAnimFps === "Smooth (60+ FPS)") return 0;
  if (wiresConfig.wireAnimFps === "Power Saver (15 FPS)") return 66;
  return 32;
}

function _getEffectiveRunningNodeId() {
  return _runningNodeId != null ? _runningNodeId : (app?.runningNodeId ?? null);
}

function _matchesRunningNode(node, graph) {
  const runId = _getEffectiveRunningNodeId();
  if (runId == null || !node) return false;
  const raw = String(runId);
  const nid = String(node.id);
  if (nid === raw) return true;
  if (raw.includes(":")) {
    const parts = raw.split(":");
    const isSubgraph = Boolean(graph && graph.inputNode && graph.outputNode);
    if (isSubgraph) {
      return parts[parts.length - 1] === nid || parts.includes(nid);
    }
    return parts[0] === nid;
  }
  return false;
}

function _getHoveredSubgraphIoId(canvas) {
  const graph = canvas?.graph;
  const subgraph = canvas?.subgraph || (graph?.inputNode && graph?.outputNode ? graph : null);
  if (!subgraph) return null;
  const gm = canvas.graph_mouse;
  if (!gm || !Number.isFinite(gm[0]) || !Number.isFinite(gm[1])) return null;
  const mx = gm[0];
  const my = gm[1];
  for (const ioNode of [subgraph.inputNode, subgraph.outputNode]) {
    if (!ioNode) continue;
    const br = ioNode.boundingRect;
    if (br && br.length >= 4) {
      if (mx >= br[0] - 12 && mx <= br[0] + br[2] + 12 && my >= br[1] - 12 && my <= br[1] + br[3] + 12) {
        return ioNode.id;
      }
    }
    if (Array.isArray(ioNode.slots)) {
      for (let i = 0; i < ioNode.slots.length; i++) {
        const p = ioNode.slots[i]?.pos;
        if (p && Math.hypot(mx - p[0], my - p[1]) <= 24) return ioNode.id;
      }
    }
  }
  return null;
}

function _hasActiveInteractionForAnim() {
  const canvas = app?.canvas;
  if (!canvas) return false;
  if (canvas.node_over) return true;
  if (canvas.selectedItems instanceof Set && canvas.selectedItems.size > 0) return true;
  if (canvas.selected_nodes && Object.keys(canvas.selected_nodes).length > 0) return true;
  if (_getHoveredSubgraphIoId(canvas) != null) return true;
  return false;
}

function _needsAnimLoop() {
  const running = _getEffectiveRunningNodeId();
  if (wiresConfig.wireLivePulse && running != null) return true;
  if (!ANIMATED_VISUAL_STYLES.has(wiresConfig.wireVisualStyle)) return false;
  if (performance.now() < _stylePreviewUntil) return true;
  if (!wiresConfig.wireAnimateOnInteractOnly) return true;
  return running != null || _hasActiveInteractionForAnim();
}

function _syncPulseLoop() {
  const shouldRun = _needsAnimLoop();
  if (shouldRun && !_pulseRaf) {
    let lastDraw = 0;
    const tick = (now) => {
      if (!_needsAnimLoop()) {
        _pulseRaf = null;
        if (app?.canvas) {
          // Links draw on LiteGraph's background canvas unless links_ontop is true,
          // so both foreground and background must be marked dirty.
          app.canvas.setDirty(true, true);
          if (typeof app.canvas.draw === "function") app.canvas.draw(true, true);
        }
        return;
      }
      const interval = _getAnimIntervalMs();
      if (!document.hidden && (interval === 0 || now - lastDraw >= interval)) {
        lastDraw = now;
        if (app?.canvas) {
          app.canvas.setDirty(true, true);
          if (now < _stylePreviewUntil && typeof app.canvas.draw === "function") {
            app.canvas.draw(true, true);
          }
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
// Selective Per-Node & Per-Slot Hidden Links (persisted in node.properties)
// ============================================================================

function _getLinkFromGraph(graph, linkId) {
  if (!graph || !graph.links || linkId == null) return null;
  return graph.links instanceof Map ? graph.links.get(linkId) : graph.links[linkId];
}

function _cleanSlotList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const n = Number(item);
    if (Number.isInteger(n) && n >= 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

function _linkEndpoints(link) {
  if (!link) return null;
  return {
    originId: link.origin_id !== undefined ? link.origin_id : link[1],
    originSlot: link.origin_slot !== undefined ? link.origin_slot : link[2],
    targetId: link.target_id !== undefined ? link.target_id : link[3],
    targetSlot: link.target_slot !== undefined ? link.target_slot : link[4],
  };
}

export function isLinkHiddenByUser(link, graph) {
  if (!link || !graph) return false;
  const ep = _linkEndpoints(link);
  if (!ep) return false;

  const originNode = graph.getNodeById?.(ep.originId);
  const targetNode = graph.getNodeById?.(ep.targetId);

  const originHidden = originNode?.properties?.livedev_links_hidden === true;
  const targetHidden = targetNode?.properties?.livedev_links_hidden === true;
  const originShown = originNode?.properties?.livedev_links_hidden === false;
  const targetShown = targetNode?.properties?.livedev_links_hidden === false;

  if (originHidden && targetShown) {
    const oTime = Number(originNode.properties.livedev_links_updated) || 0;
    const tTime = Number(targetNode.properties.livedev_links_updated) || 0;
    if (oTime > tTime) return true;
  } else if (targetHidden && originShown) {
    const oTime = Number(originNode.properties.livedev_links_updated) || 0;
    const tTime = Number(targetNode.properties.livedev_links_updated) || 0;
    if (tTime > oTime) return true;
  } else if (originHidden || targetHidden) {
    return true;
  }

  const oSlot = Number(ep.originSlot);
  if (Number.isInteger(oSlot) && oSlot >= 0 && originNode?.properties?.livedev_hidden_outputs) {
    if (_cleanSlotList(originNode.properties.livedev_hidden_outputs).includes(oSlot)) {
      return true;
    }
  }
  const tSlot = Number(ep.targetSlot);
  if (Number.isInteger(tSlot) && tSlot >= 0 && targetNode?.properties?.livedev_hidden_inputs) {
    if (_cleanSlotList(targetNode.properties.livedev_hidden_inputs).includes(tSlot)) {
      return true;
    }
  }
  return false;
}

function isInputSlotHidden(node, slotIndex, graph) {
  const slot = node?.inputs?.[slotIndex];
  if (!slot || slot.link == null) return false;
  if (_cleanSlotList(node.properties?.livedev_hidden_inputs).includes(slotIndex)) return true;
  const link = _getLinkFromGraph(graph, slot.link);
  return isLinkHiddenByUser(link, graph);
}

function isOutputSlotHidden(node, slotIndex, graph) {
  const slot = node?.outputs?.[slotIndex];
  if (!slot || !Array.isArray(slot.links) || slot.links.length === 0) return false;
  if (_cleanSlotList(node.properties?.livedev_hidden_outputs).includes(slotIndex)) return true;
  for (const linkId of slot.links) {
    const link = _getLinkFromGraph(graph, linkId);
    if (isLinkHiddenByUser(link, graph)) return true;
  }
  return false;
}

function isNodeLinksHidden(node) {
  if (!node?.properties) return false;
  if (node.properties.livedev_links_hidden === true) return true;
  const inCount = Array.isArray(node.inputs) ? node.inputs.length : 0;
  const outCount = Array.isArray(node.outputs) ? node.outputs.length : 0;
  if (!inCount && !outCount) return false;
  const hiddenIn = _cleanSlotList(node.properties.livedev_hidden_inputs).length;
  const hiddenOut = _cleanSlotList(node.properties.livedev_hidden_outputs).length;
  return (!inCount || hiddenIn >= inCount) && (!outCount || hiddenOut >= outCount);
}

function graphHasAnyHiddenLinks(graph) {
  const nodes = graph?._nodes;
  if (!Array.isArray(nodes)) return false;
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i]?.properties;
    if (!p) continue;
    if (p.livedev_links_hidden === true) return true;
    if (Array.isArray(p.livedev_hidden_inputs) && p.livedev_hidden_inputs.length > 0) return true;
    if (Array.isArray(p.livedev_hidden_outputs) && p.livedev_hidden_outputs.length > 0) return true;
  }
  return false;
}

function _clearOppositeEndForSlot(node, isInput, slotIndex, graph) {
  if (!graph) return;
  if (isInput) {
    const linkId = node.inputs?.[slotIndex]?.link;
    const link = _getLinkFromGraph(graph, linkId);
    const ep = _linkEndpoints(link);
    if (!ep) return;
    const originNode = graph.getNodeById?.(ep.originId);
    if (!originNode) return;
    originNode.properties = originNode.properties || {};
    if (originNode.properties.livedev_links_hidden === true) {
      originNode.properties.livedev_links_hidden = false;
      originNode.properties.livedev_links_updated = Date.now();
      originNode.properties.livedev_hidden_inputs = (originNode.inputs || []).map((_, idx) => idx);
      originNode.properties.livedev_hidden_outputs = (originNode.outputs || [])
        .map((_, idx) => idx)
        .filter((idx) => idx !== Number(ep.originSlot));
    } else if (Array.isArray(originNode.properties.livedev_hidden_outputs)) {
      originNode.properties.livedev_hidden_outputs = _cleanSlotList(
        originNode.properties.livedev_hidden_outputs,
      ).filter((idx) => idx !== Number(ep.originSlot));
    }
    return;
  }

  const linkIds = node.outputs?.[slotIndex]?.links;
  if (!Array.isArray(linkIds)) return;
  for (const linkId of linkIds) {
    const link = _getLinkFromGraph(graph, linkId);
    const ep = _linkEndpoints(link);
    if (!ep) continue;
    const targetNode = graph.getNodeById?.(ep.targetId);
    if (!targetNode) continue;
    targetNode.properties = targetNode.properties || {};
    if (targetNode.properties.livedev_links_hidden === true) {
      targetNode.properties.livedev_links_hidden = false;
      targetNode.properties.livedev_links_updated = Date.now();
      targetNode.properties.livedev_hidden_inputs = (targetNode.inputs || [])
        .map((_, idx) => idx)
        .filter((idx) => idx !== Number(ep.targetSlot));
      targetNode.properties.livedev_hidden_outputs = (targetNode.outputs || []).map((_, idx) => idx);
    } else if (Array.isArray(targetNode.properties.livedev_hidden_inputs)) {
      targetNode.properties.livedev_hidden_inputs = _cleanSlotList(
        targetNode.properties.livedev_hidden_inputs,
      ).filter((idx) => idx !== Number(ep.targetSlot));
    }
  }
}

export function toggleNodesLinksHidden(nodes, forceHidden = null) {
  const list = (Array.isArray(nodes) ? nodes : [nodes]).filter(Boolean);
  if (!list.length) return false;
  const graph = app.canvas?.graph || app.graph;
  const nextHidden = forceHidden !== null ? Boolean(forceHidden) : !isNodeLinksHidden(list[0]);
  const now = Date.now();

  for (const n of list) {
    n.properties = n.properties || {};
    n.properties.livedev_links_hidden = nextHidden;
    n.properties.livedev_links_updated = now;
    if (nextHidden) {
      n.properties.livedev_hidden_inputs = (n.inputs || []).map((_, idx) => idx);
      n.properties.livedev_hidden_outputs = (n.outputs || []).map((_, idx) => idx);
    } else {
      n.properties.livedev_hidden_inputs = [];
      n.properties.livedev_hidden_outputs = [];
      if (graph) {
        for (let i = 0; i < (n.inputs || []).length; i++) _clearOppositeEndForSlot(n, true, i, graph);
        for (let i = 0; i < (n.outputs || []).length; i++) _clearOppositeEndForSlot(n, false, i, graph);
      }
    }
  }

  _routeCache.key = "";
  graph?.change?.();
  app.canvas?.setDirty(true, true);
  _syncPulseLoop();
  return nextHidden;
}

export function toggleSlotLinkHidden(node, isInput, slotIndex) {
  if (!node || !Number.isInteger(slotIndex) || slotIndex < 0) return false;
  const graph = app.canvas?.graph || app.graph;
  node.properties = node.properties || {};
  const currentlyHidden = isInput
    ? isInputSlotHidden(node, slotIndex, graph)
    : isOutputSlotHidden(node, slotIndex, graph);

  if (node.properties.livedev_links_hidden === true) {
    node.properties.livedev_links_hidden = false;
    node.properties.livedev_links_updated = Date.now();
    node.properties.livedev_hidden_inputs = (node.inputs || [])
      .map((_, idx) => idx)
      .filter((idx) => !(isInput && idx === slotIndex));
    node.properties.livedev_hidden_outputs = (node.outputs || [])
      .map((_, idx) => idx)
      .filter((idx) => !(!isInput && idx === slotIndex));
  } else {
    const key = isInput ? "livedev_hidden_inputs" : "livedev_hidden_outputs";
    const list = _cleanSlotList(node.properties[key]);
    if (currentlyHidden) {
      node.properties[key] = list.filter((idx) => idx !== slotIndex);
    } else if (!list.includes(slotIndex)) {
      list.push(slotIndex);
      node.properties[key] = list;
    }
  }

  if (currentlyHidden) {
    _clearOppositeEndForSlot(node, isInput, slotIndex, graph);
  }

  _routeCache.key = "";
  graph?.change?.();
  app.canvas?.setDirty(true, true);
  _syncPulseLoop();
  return !currentlyHidden;
}

export function showAllHiddenLinks() {
  const graph = app.canvas?.graph || app.graph;
  const nodes = graph?._nodes || [];
  let changed = 0;
  const now = Date.now();
  for (const n of nodes) {
    const p = n?.properties;
    if (!p) continue;
    const had =
      p.livedev_links_hidden === true ||
      (Array.isArray(p.livedev_hidden_inputs) && p.livedev_hidden_inputs.length > 0) ||
      (Array.isArray(p.livedev_hidden_outputs) && p.livedev_hidden_outputs.length > 0);
    if (had) {
      p.livedev_links_hidden = false;
      p.livedev_links_updated = now;
      p.livedev_hidden_inputs = [];
      p.livedev_hidden_outputs = [];
      changed++;
    }
  }
  _routeCache.key = "";
  if (changed) {
    graph?.change?.();
    app.canvas?.setDirty(true, true);
  }
  _syncPulseLoop();
  return changed;
}

function getSlotIndicatorColor(canvas, node, isInput, slotIndex) {
  const mode = wiresConfig.wireSlotColor || "Match Slot Color";
  if (mode === "LiveDev Accent") return ACCENT;
  if (mode === "Pure White") return "#ffffff";
  if (mode === "Neutral Grey") return "#888888";

  const slot = isInput ? node?.inputs?.[slotIndex] : node?.outputs?.[slotIndex];
  if (!slot) return ACCENT;
  if (slot.color_on) return slot.color_on;
  if (slot.color) return slot.color;
  const type = slot.type;
  const byType =
    canvas?.default_connection_color_byType ||
    (typeof LGraphCanvas !== "undefined" ? LGraphCanvas.link_type_colors : null) ||
    (typeof LiteGraph !== "undefined" ? LiteGraph.LINK_TYPE_COLORS : null);
  if (byType && type && byType[type]) return byType[type];
  return ACCENT;
}

function drawHiddenSlotIndicator(ctx, canvas, node, pos, isInput, slotIndex) {
  const shape = wiresConfig.wireSlotShape || "WiFi Icon";
  if (shape === "None") return;
  const localX = pos[0] - node.pos[0];
  const localY = pos[1] - node.pos[1];
  const slotR = (typeof LiteGraph !== "undefined" && LiteGraph.NODE_SLOT_RADIUS) || 5;
  const color = getSlotIndicatorColor(canvas, node, isInput, slotIndex);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";

  if (shape === "WiFi Icon") {
    ctx.beginPath();
    ctx.arc(localX, localY, 1.5, 0, Math.PI * 2);
    ctx.fill();
    const startAng = isInput ? Math.PI * 0.72 : -Math.PI * 0.28;
    const endAng = isInput ? Math.PI * 1.28 : Math.PI * 0.28;
    ctx.beginPath();
    ctx.arc(localX, localY, slotR + 1.8, startAng, endAng);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(localX, localY, slotR + 5.2, startAng, endAng);
    ctx.stroke();
  } else if (shape === "Dashed Circle" || shape === "Circle") {
    ctx.beginPath();
    ctx.arc(localX, localY, slotR + 4.5, 0, Math.PI * 2);
    ctx.setLineDash(shape === "Dashed Circle" ? [2.2, 2.2] : []);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.42;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(localX, localY, slotR + 2.3, 0, Math.PI * 2);
    ctx.stroke();
  } else if (shape === "Triangle") {
    const r = slotR + 4.5;
    ctx.beginPath();
    if (isInput) {
      ctx.moveTo(localX - r, localY);
      ctx.lineTo(localX + r * 0.5, localY - r * 0.86);
      ctx.lineTo(localX + r * 0.5, localY + r * 0.86);
    } else {
      ctx.moveTo(localX + r, localY);
      ctx.lineTo(localX - r * 0.5, localY - r * 0.86);
      ctx.lineTo(localX - r * 0.5, localY + r * 0.86);
    }
    ctx.closePath();
    ctx.stroke();
  }

  ctx.restore();
}

// ============================================================================
// Floating Slot Quick-Action Pill (appears above node on short slot click)
// ============================================================================

let _slotPillState = null; // { el, hit, rafId, onOutside, onKey }
let _slotClickCandidate = null;

function closeSlotActionPill() {
  if (!_slotPillState) return;
  const st = _slotPillState;
  _slotPillState = null;
  if (st.rafId) cancelAnimationFrame(st.rafId);
  if (st.onOutside) document.removeEventListener("pointerdown", st.onOutside, true);
  if (st.onKey) document.removeEventListener("keydown", st.onKey, true);
  st.el.remove();
}

function getSlotHitMeta(hit, graph) {
  if (!hit) return null;
  if (hit.isSubgraphIo) {
    const slot = hit.ioNode?.slots?.[hit.slotIndex];
    if (!slot) return null;
    const linkIds = Array.isArray(slot.linkIds) ? slot.linkIds : [];
    let hidden = false;
    for (const lid of linkIds) {
      const link = _getLinkFromGraph(graph, lid);
      if (isLinkHiddenByUser(link, graph)) {
        hidden = true;
        break;
      }
    }
    return {
      slot,
      name: String(slot.label || slot.name || (hit.isInput ? "Input" : "Output")),
      hasConnection: linkIds.length > 0,
      hidden,
      color:
        app.canvas?.default_connection_color_byType?.[slot.type] ||
        (typeof LiteGraph !== "undefined" ? LiteGraph.LINK_TYPE_COLORS?.[slot.type] : null) ||
        ACCENT,
    };
  }

  const slot = hit.isInput ? hit.node?.inputs?.[hit.slotIndex] : hit.node?.outputs?.[hit.slotIndex];
  if (!slot) return null;
  const hasConnection = hit.isInput
    ? slot.link != null
    : Array.isArray(slot.links) && slot.links.length > 0;
  const hidden = hasConnection
    ? hit.isInput
      ? isInputSlotHidden(hit.node, hit.slotIndex, graph)
      : isOutputSlotHidden(hit.node, hit.slotIndex, graph)
    : false;
  return {
    slot,
    name: String(slot.label || slot.name || slot.type || "Slot"),
    hasConnection,
    hidden,
    color: getSlotIndicatorColor(app.canvas, hit.node, hit.isInput, hit.slotIndex),
  };
}

function disconnectSlotHit(hit) {
  const graph = app.canvas?.graph || app.graph;
  if (!hit || !graph) return false;
  let removed = false;
  graph.beforeChange?.();
  if (hit.isSubgraphIo) {
    const slot = hit.ioNode?.slots?.[hit.slotIndex];
    const linkIds = Array.isArray(slot?.linkIds) ? [...slot.linkIds] : [];
    for (const lid of linkIds) {
      if (typeof graph.removeLink === "function") {
        graph.removeLink(lid);
        removed = true;
      }
    }
  } else if (hit.isInput) {
    if (hit.node?.inputs?.[hit.slotIndex]?.link != null) {
      if (typeof hit.node.disconnectInput === "function") {
        hit.node.disconnectInput(hit.slotIndex);
        removed = true;
      } else {
        graph.removeLink?.(hit.node.inputs[hit.slotIndex].link);
        removed = true;
      }
    }
  } else {
    const links = hit.node?.outputs?.[hit.slotIndex]?.links;
    if (Array.isArray(links) && links.length > 0) {
      if (typeof hit.node.disconnectOutput === "function") {
        hit.node.disconnectOutput(hit.slotIndex);
        removed = true;
      } else {
        for (const lid of [...links]) graph.removeLink?.(lid);
        removed = true;
      }
    }
  }
  if (removed) {
    _routeCache.key = "";
    graph.afterChange?.();
    graph.change?.();
    app.canvas?.setDirty(true, true);
    if (typeof app.canvas?.draw === "function") app.canvas.draw(true, true);
  }
  return removed;
}

function toggleHideSlotHit(hit) {
  const graph = app.canvas?.graph || app.graph;
  if (!hit || !graph) return false;
  if (!hit.isSubgraphIo) {
    return toggleSlotLinkHidden(hit.node, hit.isInput, hit.slotIndex);
  }
  const slot = hit.ioNode?.slots?.[hit.slotIndex];
  const linkIds = Array.isArray(slot?.linkIds) ? [...slot.linkIds] : [];
  if (!linkIds.length) return false;
  const meta = getSlotHitMeta(hit, graph);
  const nextHidden = !meta?.hidden;
  for (const lid of linkIds) {
    const link = _getLinkFromGraph(graph, lid);
    const ep = _linkEndpoints(link);
    if (!ep) continue;
    // For Subgraph Input slot (origin is IO), toggle on target node's input slot;
    // for Subgraph Output slot (target is IO), toggle on origin node's output slot.
    const peerNode = hit.isSgInput ? graph.getNodeById?.(ep.targetId) : graph.getNodeById?.(ep.originId);
    const peerSlot = Number(hit.isSgInput ? ep.targetSlot : ep.originSlot);
    if (!peerNode || !Number.isInteger(peerSlot) || peerSlot < 0) continue;
    peerNode.properties = peerNode.properties || {};
    const key = hit.isSgInput ? "livedev_hidden_inputs" : "livedev_hidden_outputs";
    const list = _cleanSlotList(peerNode.properties[key]);
    if (nextHidden) {
      if (!list.includes(peerSlot)) list.push(peerSlot);
      peerNode.properties[key] = list;
    } else {
      if (peerNode.properties.livedev_links_hidden === true) {
        peerNode.properties.livedev_links_hidden = false;
        peerNode.properties.livedev_links_updated = Date.now();
        peerNode.properties.livedev_hidden_inputs = (peerNode.inputs || [])
          .map((_, idx) => idx)
          .filter((idx) => !(hit.isSgInput && idx === peerSlot));
        peerNode.properties.livedev_hidden_outputs = (peerNode.outputs || [])
          .map((_, idx) => idx)
          .filter((idx) => !(!hit.isSgInput && idx === peerSlot));
      } else {
        peerNode.properties[key] = list.filter((idx) => idx !== peerSlot);
      }
    }
  }
  _routeCache.key = "";
  graph.change?.();
  app.canvas?.setDirty(true, true);
  if (typeof app.canvas?.draw === "function") app.canvas.draw(true, true);
  _syncPulseLoop();
  return nextHidden;
}

function removeSlotHit(hit) {
  const graph = app.canvas?.graph || app.graph;
  if (!hit || !graph) return false;
  let removed = false;
  graph.beforeChange?.();
  if (hit.isSubgraphIo) {
    const slot = hit.ioNode?.slots?.[hit.slotIndex];
    const subgraph = hit.ioNode?.subgraph || app.canvas?.subgraph || graph;
    if (slot) {
      if (typeof hit.ioNode.removeSlot === "function") {
        hit.ioNode.removeSlot(slot);
        removed = true;
      } else if (hit.isSgInput && typeof subgraph?.removeInput === "function") {
        subgraph.removeInput(slot);
        removed = true;
      } else if (!hit.isSgInput && typeof subgraph?.removeOutput === "function") {
        subgraph.removeOutput(slot);
        removed = true;
      }
    }
  } else if (hit.isInput && hit.node?.inputs?.[hit.slotIndex]?.removable) {
    if (typeof hit.node.removeInput === "function") {
      hit.node.removeInput(hit.slotIndex);
      removed = true;
    }
  } else if (!hit.isInput && hit.node?.outputs?.[hit.slotIndex]?.removable) {
    if (typeof hit.node.removeOutput === "function") {
      hit.node.removeOutput(hit.slotIndex);
      removed = true;
    }
  }
  if (removed) {
    _routeCache.key = "";
    graph.afterChange?.();
    graph.change?.();
    app.canvas?.setDirty(true, true);
    if (typeof app.canvas?.draw === "function") app.canvas.draw(true, true);
  }
  return removed;
}

function renameSlotHit(hit, nextLabel) {
  const graph = app.canvas?.graph || app.graph;
  if (!hit) return false;
  const slot = hit.isSubgraphIo
    ? hit.ioNode?.slots?.[hit.slotIndex]
    : hit.isInput
    ? hit.node?.inputs?.[hit.slotIndex]
    : hit.node?.outputs?.[hit.slotIndex];
  if (!slot) return false;
  const trimmed = String(nextLabel ?? "").trim();
  if (hit.isSubgraphIo && trimmed && typeof hit.ioNode?.renameSlot === "function") {
    hit.ioNode.renameSlot(slot, trimmed);
  } else if (trimmed) {
    slot.label = trimmed;
  } else {
    delete slot.label;
  }
  graph?.change?.();
  app.canvas?.setDirty(true, true);
  if (typeof app.canvas?.draw === "function") app.canvas.draw(true, true);
  return true;
}

function hitTestCanvasSlot(canvas, clientX, clientY) {
  if (!canvas || !canvas.canvas || !canvas.ds || !canvas.graph) return null;
  const rect = canvas.canvas.getBoundingClientRect();
  const scale = Number(canvas.ds.scale) || 1;
  const offset = canvas.ds.offset || [0, 0];
  const gx = (clientX - rect.left) / scale - (Number(offset[0]) || 0);
  const gy = (clientY - rect.top) / scale - (Number(offset[1]) || 0);
  const hitR = Math.max(11, 14 / Math.max(0.45, scale));
  const hitR2 = hitR * hitR;

  const graph = canvas.graph;
  const nodes = graph._nodes || [];
  let best = null;
  let bestDist2 = hitR2;

  for (let ni = nodes.length - 1; ni >= 0; ni--) {
    const n = nodes[ni];
    if (!n || !n.pos || n.flags?.collapsed) continue;
    if (Array.isArray(n.inputs) && typeof n.getInputPos === "function") {
      for (let i = 0; i < n.inputs.length; i++) {
        const p = n.getInputPos(i);
        if (!p) continue;
        const d2 = (gx - p[0]) ** 2 + (gy - p[1]) ** 2;
        if (d2 <= bestDist2) {
          bestDist2 = d2;
          best = { node: n, isInput: true, slotIndex: i, isSubgraphIo: false };
        }
      }
    }
    if (Array.isArray(n.outputs) && typeof n.getOutputPos === "function") {
      for (let i = 0; i < n.outputs.length; i++) {
        const p = n.getOutputPos(i);
        if (!p) continue;
        const d2 = (gx - p[0]) ** 2 + (gy - p[1]) ** 2;
        if (d2 <= bestDist2) {
          bestDist2 = d2;
          best = { node: n, isInput: false, slotIndex: i, isSubgraphIo: false };
        }
      }
    }
  }

  const subgraph = canvas.subgraph || (graph.inputNode && graph.outputNode ? graph : null);
  if (subgraph) {
    for (const [ioNode, isSgInput] of [[subgraph.inputNode, true], [subgraph.outputNode, false]]) {
      if (!ioNode || !Array.isArray(ioNode.slots)) continue;
      for (let i = 0; i < ioNode.slots.length; i++) {
        const p = ioNode.slots[i]?.pos;
        if (!p) continue;
        const d2 = (gx - p[0]) ** 2 + (gy - p[1]) ** 2;
        if (d2 <= bestDist2) {
          bestDist2 = d2;
          best = { ioNode, isInput: !isSgInput, isSgInput, slotIndex: i, isSubgraphIo: true };
        }
      }
    }
  }

  return best;
}

function positionSlotActionPill(st) {
  const canvas = app?.canvas;
  if (!st || !canvas || !canvas.canvas || !canvas.ds) {
    closeSlotActionPill();
    return;
  }
  const graph = canvas.graph || app.graph;
  const hit = st.hit;
  if (!hit.isSubgraphIo && (!hit.node || !hit.node.graph || hit.node.graph !== graph)) {
    closeSlotActionPill();
    return;
  }
  const rect = canvas.canvas.getBoundingClientRect();
  const scale = Number(canvas.ds.scale) || 1;
  const offset = canvas.ds.offset || [0, 0];
  const offX = Number(offset[0]) || 0;
  const offY = Number(offset[1]) || 0;

  let anchorX = 0;
  let anchorTopY = 0;
  if (hit.isSubgraphIo) {
    const slotPos = hit.ioNode?.slots?.[hit.slotIndex]?.pos;
    if (!slotPos) {
      closeSlotActionPill();
      return;
    }
    anchorX = rect.left + (slotPos[0] + offX) * scale;
    anchorTopY = rect.top + (slotPos[1] + offY) * scale - 14;
  } else {
    const node = hit.node;
    const pos = node._pos || node.pos;
    const defaultTitleH =
      typeof LiteGraph !== "undefined" && Number.isFinite(LiteGraph.NODE_TITLE_HEIGHT)
        ? LiteGraph.NODE_TITLE_HEIGHT
        : 30;
    const hasTitle = node.constructor?.title_mode !== 2 && node.title_mode !== 2;
    const titleH = hasTitle ? defaultTitleH : 0;
    const gw = node.flags?.collapsed
      ? (Number(node._collapsed_width) || 140)
      : (Number(node.size?.[0]) || 200);
    anchorX = rect.left + ((Number(pos[0]) || 0) + gw * 0.5 + offX) * scale;
    anchorTopY = rect.top + ((Number(pos[1]) || 0) - titleH + offY) * scale;
  }

  const pillW = st.el.offsetWidth || 160;
  const pillH = st.el.offsetHeight || 38;
  const x = Math.round(Math.max(8, Math.min(anchorX - pillW * 0.5, window.innerWidth - pillW - 8)));
  const y = Math.round(anchorTopY - pillH - 10);

  if (st.lastX !== x) {
    st.el.style.left = x + "px";
    st.lastX = x;
  }
  if (st.lastY !== y) {
    st.el.style.top = y + "px";
    st.lastY = y;
  }
}

function openSlotActionPill(hit) {
  ensureTheme();
  closeSlotActionPill();
  const graph = app.canvas?.graph || app.graph;
  const meta = getSlotHitMeta(hit, graph);
  if (!meta) return;

  const pill = document.createElement("div");
  pill.className = "ld-slot-pill";
  for (const evtName of ["pointerdown", "mousedown", "wheel"]) {
    pill.addEventListener(evtName, (e) => e.stopPropagation());
  }

  const renderActions = () => {
    const cur = getSlotHitMeta(hit, app.canvas?.graph || app.graph);
    if (!cur) {
      closeSlotActionPill();
      return;
    }
    pill.innerHTML = "";

    const tag = document.createElement("span");
    tag.className = "ld-slot-pill-tag";
    tag.title = cur.name;
    const dot = document.createElement("span");
    dot.className = "ld-slot-pill-dot";
    dot.style.background = cur.color;
    const lbl = document.createElement("span");
    lbl.textContent = cur.name;
    lbl.style.overflow = "hidden";
    lbl.style.textOverflow = "ellipsis";
    tag.append(dot, lbl);

    const sep = document.createElement("span");
    sep.className = "ld-slot-pill-sep";

    const hideBtn = document.createElement("button");
    hideBtn.type = "button";
    hideBtn.className = "ld-slot-pill-btn" + (cur.hidden ? " is-active" : "");
    hideBtn.innerHTML = cur.hidden ? LD_ICONS.eye : LD_ICONS.eyeOff;
    hideBtn.title = cur.hidden ? "Show Link" : "Hide Link";
    hideBtn.disabled = !cur.hasConnection;
    hideBtn.onclick = () => {
      const nowHidden = toggleHideSlotHit(hit);
      showToast(nowHidden ? "LiveDev: Slot link hidden" : "LiveDev: Slot link shown");
      renderActions();
    };

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "ld-slot-pill-btn";
    renameBtn.innerHTML = LD_ICONS.edit;
    renameBtn.title = "Rename Slot";
    renameBtn.onclick = () => renderRenameMode(cur.name);

    const canRemoveSlot = Boolean(hit.isSubgraphIo || cur.slot?.removable);
    const tailBtns = [];

    if (canRemoveSlot && cur.hasConnection) {
      const unlinkBtn = document.createElement("button");
      unlinkBtn.type = "button";
      unlinkBtn.className = "ld-slot-pill-btn is-danger";
      unlinkBtn.innerHTML = LD_ICONS.link;
      unlinkBtn.title = "Disconnect Link";
      unlinkBtn.onclick = () => {
        if (disconnectSlotHit(hit)) {
          showToast("LiveDev: Disconnected link");
        }
        renderActions();
      };
      tailBtns.push(unlinkBtn);
    }

    const trashBtn = document.createElement("button");
    trashBtn.type = "button";
    trashBtn.className = "ld-slot-pill-btn is-danger";
    trashBtn.innerHTML = LD_ICONS.trash;
    if (canRemoveSlot) {
      trashBtn.title = hit.isSubgraphIo ? "Delete Subgraph Slot" : "Remove Slot";
      trashBtn.disabled = false;
      trashBtn.onclick = () => {
        if (removeSlotHit(hit)) {
          showToast(hit.isSubgraphIo ? "LiveDev: Deleted Subgraph slot" : "LiveDev: Removed slot");
        }
        closeSlotActionPill();
      };
    } else {
      trashBtn.title = "Disconnect Link";
      trashBtn.disabled = !cur.hasConnection;
      trashBtn.onclick = () => {
        if (disconnectSlotHit(hit)) {
          showToast("LiveDev: Disconnected link");
        }
        closeSlotActionPill();
      };
    }
    tailBtns.push(trashBtn);

    pill.append(tag, sep, hideBtn, renameBtn, ...tailBtns);
  };

  const renderRenameMode = (currentName) => {
    pill.innerHTML = "";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ld-slot-pill-input";
    input.value = currentName;
    input.placeholder = "Slot label (empty = default)";

    const commit = () => {
      renameSlotHit(hit, input.value);
      showToast(input.value.trim() ? `LiveDev: Renamed slot to "${input.value.trim()}"` : "LiveDev: Reset slot label");
      closeSlotActionPill();
    };

    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeSlotActionPill();
      }
    });

    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = "ld-slot-pill-btn is-active";
    okBtn.innerHTML = LD_ICONS.check;
    okBtn.title = "Save Slot Name";
    okBtn.onclick = commit;

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "ld-slot-pill-btn";
    cancelBtn.textContent = "\u2715";
    cancelBtn.title = "Cancel";
    cancelBtn.onclick = () => renderActions();

    pill.append(input, okBtn, cancelBtn);
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  };

  renderActions();
  document.body.appendChild(pill);

  const onOutside = (e) => {
    if (!pill.contains(e.target)) closeSlotActionPill();
  };
  const onKey = (e) => {
    if (e.key === "Escape") closeSlotActionPill();
  };
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey, true);

  const st = { el: pill, hit, rafId: null, onOutside, onKey, lastX: null, lastY: null };
  _slotPillState = st;
  positionSlotActionPill(st);

  const tick = () => {
    if (_slotPillState !== st) return;
    positionSlotActionPill(st);
    st.rafId = requestAnimationFrame(tick);
  };
  st.rafId = requestAnimationFrame(tick);
}

// ============================================================================
// Quick Connections Controller
// ============================================================================

class LiveDevQuickConnections {
  constructor() {
    this.canvas = null;
    this.insideTarget = null;
    this.suggestions = null;
    this.lastHitRows = [];
    this.suppressEmptyMenu = false;
    this.graphMouse = [0, 0];
    this.ignoreWildcard = /^\*$/;
  }

  clearState() {
    this.suggestions = null;
    this.insideTarget = null;
    this.lastHitRows = [];
  }

  getActiveDrag() {
    const c = this.canvas;
    if (!c) return null;
    const rl = c.linkConnector?.renderLinks;
    if (Array.isArray(rl) && rl.length > 0) {
      const link = rl[0];
      const isToOutput = link.toType === "output";
      return {
        node: link.node,
        slot: link.fromSlotIndex,
        input: isToOutput ? link.fromSlot : null,
        output: isToOutput ? null : link.fromSlot,
        pos: link.fromPos,
        isComfy: true,
        renderLinks: rl,
      };
    }
    if (Array.isArray(c.connecting_links) && c.connecting_links.length > 0) {
      const link = c.connecting_links[0];
      return {
        node: link.node,
        slot: link.slot,
        input: link.input,
        output: link.output,
        pos: link.pos,
        isComfy: true,
        renderLinks: null,
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
        renderLinks: null,
      };
    }
    return null;
  }

  eventToGraphPoint(event) {
    if (event && typeof event.canvasX === "number" && typeof event.canvasY === "number") {
      return [event.canvasX, event.canvasY];
    }
    if (event && typeof event.clientX === "number" && typeof event.clientY === "number" && this.canvas?.canvas && this.canvas?.ds) {
      const rect = this.canvas.canvas.getBoundingClientRect();
      const { offset, scale } = this.canvas.ds;
      return [
        (event.clientX - rect.left) / scale - offset[0],
        (event.clientY - rect.top) / scale - offset[1],
      ];
    }
    return [this.graphMouse[0], this.graphMouse[1]];
  }

  resolveTargetAtEvent(event) {
    if (this.lastHitRows.length > 0) {
      const [mx, my] = this.eventToGraphPoint(event);
      for (const row of this.lastHitRows) {
        const r = row.rect;
        if (mx >= r[0] && mx <= r[0] + r[2] && my >= r[1] && my <= r[1] + r[3]) {
          return row.item;
        }
      }
    }
    return this.insideTarget;
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

  tryCommitAtEvent(graph, event) {
    const target = this.resolveTargetAtEvent(event);
    const drag = this.getActiveDrag();
    this.clearState();
    if (!target || !drag) return false;

    const activeGraph = graph || this.canvas?.graph || app?.graph;
    const lc = this.canvas?.linkConnector;
    let connected = false;

    try {
      activeGraph?.beforeChange?.();
      if (Array.isArray(drag.renderLinks) && drag.renderLinks.length > 0 && lc) {
        for (const rl of drag.renderLinks) {
          if (rl.toType === "input" && typeof rl.connectToInput === "function") {
            const res = rl.connectToInput(target.node, target.slot, lc.events);
            if (res !== undefined && res !== null) connected = true;
          } else if (rl.toType === "output" && typeof rl.connectToOutput === "function") {
            const res = rl.connectToOutput(target.node, target.slot, lc.events);
            if (res !== undefined && res !== null) connected = true;
          }
        }
      }

      if (!connected) {
        if (drag.input) {
          if (typeof target.node.connect === "function") {
            const res = target.node.connect(target.slotIndex, drag.node, drag.slot);
            connected = res !== false && res !== null;
          } else if (typeof drag.input.connect === "function") {
            drag.input.connect(target.node.outputs[target.slotIndex], target.node);
            connected = true;
          }
        } else {
          if (typeof drag.node.connect === "function") {
            const res = drag.node.connect(drag.slot, target.node, target.slotIndex);
            connected = res !== false && res !== null;
          } else if (typeof drag.output?.connect === "function") {
            drag.output.connect(target.node.inputs[target.slotIndex], target.node);
            connected = true;
          }
        }
      }

      if (connected) {
        activeGraph?.afterChange?.();
        activeGraph?.change?.();
        this.canvas?.setDirty(true, true);
      }
      return connected;
    } catch (e) {
      return false;
    }
  }

  handleMouseUp(origThis, origFn, args) {
    if (!wiresConfig.qcEnabled || !this.canvas) {
      return origFn.apply(origThis, args);
    }
    const ev = args?.[0];
    const origRelease = LiteGraph.release_link_on_empty_shows_menu;
    const origShowMenu = this.canvas.showConnectionMenu;
    let connected = false;
    try {
      connected = this.tryCommitAtEvent(this.canvas.graph, ev);
      if (connected) {
        this.suppressEmptyMenu = true;
        LiteGraph.release_link_on_empty_shows_menu = false;
        this.canvas.showConnectionMenu = () => {};
        this.canvas.linkConnector?.reset?.(true);
      }
      return origFn.apply(origThis, args);
    } finally {
      if (connected) {
        LiteGraph.release_link_on_empty_shows_menu = origRelease;
        this.canvas.showConnectionMenu = origShowMenu;
        this.canvas.linkConnector?.reset?.(true);
        this.suppressEmptyMenu = false;
      }
    }
  }

  drawOverlay(ctx) {
    if (!wiresConfig.qcEnabled || !this.canvas) return;
    this.insideTarget = null;
    this.lastHitRows = [];

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

    // Check if pointer is within or near the suggestion panel corridor
    const margin = 36 * scale;
    const zoneMinX = Math.min(pos[0], panelX) - margin;
    const zoneMaxX = Math.max(pos[0], panelX + pillW) + margin;
    const zoneMinY = panelY - rowH;
    const zoneMaxY = panelY + panelH + rowH;
    if (mx < zoneMinX || mx > zoneMaxX || my < zoneMinY || my > zoneMaxY) {
      ctx.restore();
      return;
    }

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
        ? [dotX - slotH * 0.5, cy - rowH * 0.48, slotH, rowH * 0.96]
        : [panelX, cy - rowH * 0.48, pillW, rowH * 0.96];
      this.lastHitRows.push({ item, rect: hitRect });

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

    // Intercept modern ComfyUI LinkConnector.dropLinks directly on the live instance.
    // LGraphCanvas binds processMouseUp in its constructor before extensions run, so patching
    // LinkConnector.dropLinks guarantees Quick Connections intercepts release before ComfyUI's
    // dropOnNothing dispatches "dropped-on-canvas" and opens the Add-Node search dialog.
    const lc = canvas.linkConnector;
    if (lc && !lc._livedevQcPatched && typeof lc.dropLinks === "function") {
      lc._livedevQcPatched = true;
      const origDropLinks = lc.dropLinks.bind(lc);
      lc.dropLinks = (graph, event) => {
        if (wiresConfig.qcEnabled && this.tryCommitAtEvent(graph, event)) {
          lc.reset(true);
          this.canvas?.setDirty(true, true);
          return;
        }
        this.clearState();
        return origDropLinks(graph, event);
      };
    }

    if (canvas.canvas) {
      canvas.canvas.addEventListener("litegraph:canvas", (e) => {
        if (this.suppressEmptyMenu && e.detail?.subType === "empty-release") {
          e.stopPropagation();
        }
      });
      canvas.canvas.addEventListener(
        "pointerdown",
        () => {
          this.clearState();
        },
        true,
      );
      canvas.canvas.addEventListener("pointermove", (e) => {
        const [gx, gy] = this.eventToGraphPoint(e);
        this.graphMouse[0] = gx;
        this.graphMouse[1] = gy;
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

// Subdivide a polyline into evenly spaced points with normalized t in [0, 1] and unit normals
// so wave/helix/spark/bulge/lava animations look smooth across ALL 12 routing modes.
function densifyPolyline(pts, maxStep = 14, maxPoints = 64) {
  if (!pts || pts.length < 2) return [];
  let total = 0;
  const segLens = new Array(pts.length - 1);
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    segLens[i] = l;
    total += l;
  }
  if (total < 1) return [];
  const step = Math.max(maxStep, total / maxPoints);
  const raw = [];
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const l = segLens[i];
    const divs = Math.max(1, Math.ceil(l / step));
    for (let d = 0; d < divs; d++) {
      const f = d / divs;
      raw.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, (acc + l * f) / total]);
    }
    acc += l;
  }
  const last = pts[pts.length - 1];
  raw.push([last[0], last[1], 1]);

  const out = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const prev = raw[Math.max(0, i - 1)];
    const next = raw[Math.min(raw.length - 1, i + 1)];
    let tx = next[0] - prev[0];
    let ty = next[1] - prev[1];
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    out[i] = { x: raw[i][0], y: raw[i][1], t: raw[i][2], nx: -ty, ny: tx };
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

function getSelectedNodeIds(canvas) {
  const ids = new Set();
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

function getFocusedNodeIds(canvas) {
  const ids = getSelectedNodeIds(canvas);
  if (canvas?.node_over) ids.add(canvas.node_over.id);
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
      (wiresConfig.wireLivePulse && _runningNodeId != null) ||
      graphHasAnyHiddenLinks(canvas.graph);
    return hasCustomMode || hasCustomEffects;
  }

  _buildCacheKey(graph, nodes, linksIterable, mode, sgIn, sgOut) {
    let sig =
      (graph?.id || "") +
      "|" +
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
    if (sgIn && Array.isArray(sgIn.slots)) {
      sig += "|SGI:";
      for (let i = 0; i < sgIn.slots.length; i++) {
        const p = sgIn.slots[i]?.pos;
        if (p) sig += Math.round(p[0]) + "," + Math.round(p[1]) + ";";
      }
    }
    if (sgOut && Array.isArray(sgOut.slots)) {
      sig += "|SGO:";
      for (let i = 0; i < sgOut.slots.length; i++) {
        const p = sgOut.slots[i]?.pos;
        if (p) sig += Math.round(p[0]) + "," + Math.round(p[1]) + ";";
      }
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
    const subgraph = canvas.subgraph || (graph.inputNode && graph.outputNode ? graph : null);
    const sgIn = subgraph?.inputNode || null;
    const sgOut = subgraph?.outputNode || null;

    const mode = wiresConfig.wireMode;
    const style = wiresConfig.wireVisualStyle;
    const revealMode = wiresConfig.wireRevealMode || "Show On Hover (All Links)";
    const revealOnHover = revealMode.startsWith("Show On Hover");
    const revealOnClick = revealMode.startsWith("Show On Click");
    const revealTargetsHiddenOnly = revealMode.includes("(Hidden Links)");
    const hoveredSgIoId = _getHoveredSubgraphIoId(canvas);
    const hoveredNodeId = canvas.node_over ? canvas.node_over.id : hoveredSgIoId;
    const selectedIds = getSelectedNodeIds(canvas);
    const focusedIds = getFocusedNodeIds(canvas);
    if (hoveredSgIoId != null) focusedIds.add(hoveredSgIoId);
    const focusActive = wiresConfig.wireFocusMode && focusedIds.size > 0;
    const defaultColors = canvas.default_connection_color_byType || {};
    const baseWidth = Math.max(1.5, canvas.connections_width || 3);

    // Reuse cached routes & CAD crossings when nodes, links, and routing settings haven't changed
    const cacheKey = this._buildCacheKey(graph, nodes, linksList, mode, sgIn, sgOut);
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
        const isFromSgIn = Boolean(sgIn && (link.originIsIoNode || link.origin_id === sgIn.id));
        const isToSgOut = Boolean(sgOut && (link.targetIsIoNode || link.target_id === sgOut.id));
        const src = isFromSgIn ? sgIn : nodeById.get(link.origin_id);
        const tgt = isToSgOut ? sgOut : nodeById.get(link.target_id);
        if (!src || !tgt) continue;
        // Skip internal links between two nodes folded inside the same Visual Fold pill
        if (!isFromSgIn && !isToSgOut && isSameFoldGroup(src, tgt)) continue;

        const sgInSlot = isFromSgIn ? sgIn.slots?.[link.origin_slot] : null;
        const sgOutSlot = isToSgOut ? sgOut.slots?.[link.target_slot] : null;

        const a = isFromSgIn
          ? sgInSlot?.pos
          : (typeof src.getOutputPos === "function" ? src.getOutputPos(link.origin_slot) : src.pos);
        const b = isToSgOut
          ? sgOutSlot?.pos
          : (typeof tgt.getInputPos === "function" ? tgt.getInputPos(link.target_slot) : tgt.pos);
        if (!a || !b || !Number.isFinite(a[0]) || !Number.isFinite(a[1]) || !Number.isFinite(b[0]) || !Number.isFinite(b[1])) {
          continue;
        }

        const slotType = link.type || (isFromSgIn ? sgInSlot?.type : src.outputs?.[link.origin_slot]?.type);
        const tgtType = (isToSgOut ? sgOutSlot?.type : tgt.inputs?.[link.target_slot]?.type) || slotType;
        const srcLabel = isFromSgIn
          ? (sgInSlot?.label || sgInSlot?.name || "Input")
          : (src.title || src.type || "Node");
        const tgtLabel = isToSgOut
          ? (sgOutSlot?.label || sgOutSlot?.name || "Output")
          : (tgt.title || tgt.type || "Node");
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
          srcLabel,
          tgtLabel,
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
    const hasRunning = _getEffectiveRunningNodeId() != null;
    const pulsePhase = wiresConfig.wireLivePulse && hasRunning
      ? (nowMs * 0.0012) % 1
      : 0;
    const flowOffset = (nowMs * 0.045) % 24;
    const beadOffset = (nowMs * 0.055) % 80;
    const portalThreshold = wiresConfig.wirePortalDistance || 550;

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const isFocused = focusedIds.has(e.src.id) || focusedIds.has(e.tgt.id);
      const isHovered = hoveredNodeId != null && (hoveredNodeId === e.src.id || hoveredNodeId === e.tgt.id);
      const isSelected = selectedIds.has(e.src.id) || selectedIds.has(e.tgt.id);
      const isExecuting =
        hasRunning && (_matchesRunningNode(e.src, graph) || _matchesRunningNode(e.tgt, graph));

      const isUserHidden = isLinkHiddenByUser(e.link, graph);
      const isRevealed =
        (wiresConfig.wireLivePulse && isExecuting) ||
        (revealOnHover && isHovered) ||
        (revealOnClick && isSelected);

      // Selectively hidden per-node / per-slot links stay invisible until revealed
      if (isUserHidden && !isRevealed) {
        continue;
      }

      const isStylePreview = nowMs < _stylePreviewUntil;
      const isPortalCollapsed =
        mode === "Smart Wireless Portal" &&
        e.span > portalThreshold &&
        !isFocused &&
        !isExecuting &&
        !isStylePreview;

      const alpha = focusActive ? (isFocused || isExecuting ? 1.0 : 0.14) : 0.94;
      ctx.globalAlpha = alpha;

      if (isPortalCollapsed) {
        const tgtLabel = (e.tgtLabel || e.tgt.title || e.tgt.type || "Node").slice(0, 14);
        const srcLabel = (e.srcLabel || e.src.title || e.src.type || "Node").slice(0, 14);
        drawPortalBadge(ctx, e.a[0], e.a[1], `\u2192 ${tgtLabel}`, e.color, true);
        drawPortalBadge(ctx, e.b[0], e.b[1], `${srcLabel} \u2192`, e.color, false);
        continue;
      }

      const lw = isFocused && focusActive ? baseWidth * 1.25 : baseWidth;
      const segCrossings = crossingsByEntry.get(i) || null;
      const effRadius = segCrossings ? 0 : e.cornerRadius;

      // Optional interaction-only scoping for animated wire styles (bypassed during brief
      // live-preview right after choosing a new effect in Settings so the change is visible)
      let effStyle = style;
      if (ANIMATED_VISUAL_STYLES.has(style) && wiresConfig.wireAnimateOnInteractOnly && !isStylePreview) {
        const eligible = revealTargetsHiddenOnly
          ? (isUserHidden && isRevealed) || isExecuting
          : isRevealed || isFocused || isExecuting;
        if (!eligible) effStyle = "Normal";
      }

      if (effStyle === "Tapered Ribbon") {
        drawTaperedRibbon(ctx, e.pts, e.color, lw * 2.1, Math.max(1.2, lw * 0.55));
      } else if (effStyle === "Double Rail (Twin Track)") {
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
      } else if (effStyle === "Jelly Wave (Animated)") {
        const dense = densifyPolyline(e.pts, 12, 64);
        if (dense.length >= 2) {
          const wavePts = new Array(dense.length);
          const t1 = nowMs * 0.008;
          const t2 = nowMs * 0.012;
          for (let k = 0; k < dense.length; k++) {
            const p = dense[k];
            const fade = Math.sin(p.t * Math.PI);
            const amp = (Math.sin(p.t * 10 - t1) * 5.0 + Math.cos(p.t * 5 - t2) * 2.5) * fade;
            wavePts[k] = [p.x + p.nx * amp, p.y + p.ny * amp];
          }
          ctx.setLineDash([]);
          tracePolyline(ctx, wavePts, 0, null);
          ctx.strokeStyle = e.color;
          ctx.globalAlpha = alpha * 0.24;
          ctx.lineWidth = lw * 2.2;
          ctx.stroke();
          ctx.globalAlpha = alpha;
          ctx.lineWidth = lw;
          ctx.stroke();
        }
      } else if (effStyle === "DNA Helix Spiral (Animated)") {
        const dense = densifyPolyline(e.pts, 11, 70);
        if (dense.length >= 2) {
          const freq = 28;
          const amp = Math.max(3.2, lw * 1.25);
          const phase = nowMs * 0.006;
          const strandA = new Array(dense.length);
          const strandB = new Array(dense.length);
          for (let k = 0; k < dense.length; k++) {
            const p = dense[k];
            const fade = Math.min(1, Math.sin(p.t * Math.PI) * 3.5);
            const offA = Math.sin(p.t * freq - phase) * amp * fade;
            const offB = Math.sin(p.t * freq - phase + Math.PI) * amp * fade;
            strandA[k] = [p.x + p.nx * offA, p.y + p.ny * offA];
            strandB[k] = [p.x + p.nx * offB, p.y + p.ny * offB];
          }
          ctx.setLineDash([]);
          // Dual-color base-pair rungs
          ctx.lineWidth = Math.max(1.0, lw * 0.42);
          for (let k = 1; k < dense.length - 1; k += 2) {
            const mx = (strandA[k][0] + strandB[k][0]) * 0.5;
            const my = (strandA[k][1] + strandB[k][1]) * 0.5;
            ctx.globalAlpha = alpha * 0.65;
            ctx.strokeStyle = e.color;
            ctx.beginPath();
            ctx.moveTo(strandA[k][0], strandA[k][1]);
            ctx.lineTo(mx, my);
            ctx.stroke();
            ctx.strokeStyle = "rgba(255, 255, 255, 0.72)";
            ctx.beginPath();
            ctx.moveTo(mx, my);
            ctx.lineTo(strandB[k][0], strandB[k][1]);
            ctx.stroke();
          }
          // Primary strand
          tracePolyline(ctx, strandA, 0, null);
          ctx.globalAlpha = alpha * 0.25;
          ctx.strokeStyle = e.color;
          ctx.lineWidth = lw * 1.5;
          ctx.stroke();
          ctx.globalAlpha = alpha;
          ctx.lineWidth = Math.max(1.4, lw * 0.68);
          ctx.stroke();
          // Complementary white strand
          tracePolyline(ctx, strandB, 0, null);
          ctx.globalAlpha = alpha * 0.22;
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = lw * 1.3;
          ctx.stroke();
          ctx.globalAlpha = alpha * 0.92;
          ctx.lineWidth = Math.max(1.2, lw * 0.58);
          ctx.stroke();
        }
      } else if (effStyle === "Sparkling Electricity (Animated)") {
        const dense = densifyPolyline(e.pts, 10, 72);
        ctx.setLineDash([]);
        tracePolyline(ctx, e.pts, effRadius, segCrossings);
        ctx.globalAlpha = alpha * 0.36;
        ctx.strokeStyle = e.color;
        ctx.lineWidth = Math.max(1.2, lw * 0.6);
        ctx.stroke();

        if (dense.length >= 2) {
          const timeSeed = nowMs * 0.0012;
          const arcLen = 0.16;
          for (let sIdx = 0; sIdx < 2; sIdx++) {
            const startT = ((timeSeed + sIdx * 0.5) % 1.18) - 0.12;
            const sparkPts = [];
            for (let k = 0; k < dense.length; k++) {
              const p = dense[k];
              if (p.t >= startT && p.t <= startT + arcLen) {
                const jitter = Math.sin(p.t * 140 + nowMs * 0.045 + sIdx * 4.1) * (lw * 1.15);
                sparkPts.push([p.x + p.nx * jitter, p.y + p.ny * jitter]);
              }
            }
            if (sparkPts.length >= 2) {
              tracePolyline(ctx, sparkPts, 0, null);
              ctx.globalAlpha = alpha * 0.32;
              ctx.strokeStyle = ACCENT;
              ctx.lineWidth = lw * 2.1;
              ctx.stroke();
              ctx.globalAlpha = alpha;
              ctx.strokeStyle = "#ffffff";
              ctx.lineWidth = Math.max(1.2, lw * 0.72);
              ctx.stroke();
            }
          }
        }
      } else if (effStyle === "Dripping Lava (Animated)") {
        const dense = densifyPolyline(e.pts, 14, 56);
        ctx.setLineDash([]);
        tracePolyline(ctx, e.pts, effRadius, segCrossings);
        // Obsidian outer crust
        ctx.globalAlpha = alpha * 0.94;
        ctx.strokeStyle = "rgba(22, 11, 8, 0.96)";
        ctx.lineWidth = lw * 1.75;
        ctx.stroke();
        // Molten glow underlay
        ctx.globalAlpha = alpha * 0.30;
        ctx.strokeStyle = "rgba(255, 76, 16, 1)";
        ctx.lineWidth = lw * 2.4;
        ctx.stroke();
        // Flowing molten lava core
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = "rgba(255, 68, 12, 1)";
        ctx.lineWidth = Math.max(1.6, lw * 0.95);
        ctx.stroke();
        // Hot golden magma streaks drifting slowly
        ctx.strokeStyle = "rgba(255, 214, 64, 0.92)";
        ctx.lineWidth = Math.max(0.9, lw * 0.38);
        ctx.setLineDash([5, 17]);
        ctx.lineDashOffset = -(nowMs * 0.018) % 22;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;

        // Viscous hanging & detaching lava droplets
        if (dense.length >= 3) {
          const numDrops = 3;
          for (let d = 0; d < numDrops; d++) {
            const tPos = ((d * 0.31 + nowMs * 0.000018) % 0.7) + 0.15;
            const p = dense[Math.min(dense.length - 1, Math.floor(tPos * (dense.length - 1)))];
            const cycle = (nowMs * 0.014 + d * 3.3) % 10;
            if (cycle < 6) {
              const prog = cycle / 6;
              if (prog < 0.35) {
                const stretchY = prog * 15;
                ctx.globalAlpha = alpha;
                ctx.fillStyle = "rgba(255, 68, 12, 0.95)";
                ctx.beginPath();
                ctx.moveTo(p.x - 1.6, p.y);
                ctx.quadraticCurveTo(p.x - 2.1, p.y + stretchY, p.x, p.y + stretchY + 1.6);
                ctx.quadraticCurveTo(p.x + 2.1, p.y + stretchY, p.x + 1.6, p.y);
                ctx.closePath();
                ctx.fill();
              } else {
                const fall = (prog - 0.35) / 0.65;
                const dropY = p.y + 5.25 + fall * fall * 22;
                const rad = 2.3 * (1 - fall * 0.48);
                ctx.globalAlpha = alpha * (1 - fall * 0.35);
                ctx.strokeStyle = "rgba(255, 68, 12, 0.35)";
                ctx.lineWidth = Math.max(0.6, rad * 0.4);
                ctx.beginPath();
                ctx.moveTo(p.x, p.y + 3);
                ctx.lineTo(p.x, dropY - 1.5);
                ctx.stroke();
                ctx.fillStyle = "rgba(255, 102, 16, 1)";
                ctx.beginPath();
                ctx.arc(p.x, dropY, rad, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = "rgba(255, 214, 64, 1)";
                ctx.beginPath();
                ctx.arc(p.x, dropY, rad * 0.48, 0, Math.PI * 2);
                ctx.fill();
              }
            }
          }
        }
      } else if (effStyle === "Water Pipe Flow (Animated)") {
        const dense = densifyPolyline(e.pts, 12, 56);
        ctx.setLineDash([]);
        tracePolyline(ctx, e.pts, effRadius, segCrossings);
        ctx.globalAlpha = alpha * 0.36;
        ctx.strokeStyle = e.color;
        ctx.lineWidth = Math.max(1.3, lw * 0.62);
        ctx.stroke();

        if (dense.length >= 2) {
          const cycle = (nowMs * 0.00035) % 1;
          const numBulges = 3;
          const halfSpan = 0.085;
          ctx.strokeStyle = e.color;
          ctx.globalAlpha = alpha * 0.92;
          for (let k = 0; k < dense.length - 1; k++) {
            const p = dense[k];
            const nxt = dense[k + 1];
            let boost = 0;
            for (let b = 0; b < numBulges; b++) {
              const centerT = (cycle + b / numBulges) % 1;
              let dist = Math.abs(p.t - centerT);
              if (dist > 0.5) dist = 1 - dist;
              if (dist < halfSpan) {
                const f = Math.cos((dist / halfSpan) * Math.PI * 0.5);
                if (f > boost) boost = f;
              }
            }
            if (boost > 0.04) {
              ctx.lineWidth = lw * (0.62 + boost * 1.45);
              ctx.beginPath();
              ctx.moveTo(p.x, p.y);
              ctx.lineTo(nxt.x, nxt.y);
              ctx.stroke();
            }
          }
        }
      } else {
        tracePolyline(ctx, e.pts, effRadius, segCrossings);

        if (effStyle === "Neon Glow Tube") {
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
        } else if (effStyle === "Fiber Optic Core") {
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
        } else if (effStyle === "Laser Beam") {
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
        } else if (effStyle === "Gradient Flow (Source -> Target)") {
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
        } else if (effStyle === "Pulsation (Animated)") {
          ctx.setLineDash([]);
          const wave = Math.sin(nowMs * 0.0075);
          const pulseW = Math.max(1.2, lw + wave * (lw * 0.48));
          ctx.strokeStyle = e.color;
          ctx.globalAlpha = alpha * (0.24 + (wave + 1) * 0.12);
          ctx.lineWidth = pulseW + lw * 1.5;
          ctx.stroke();
          ctx.globalAlpha = alpha;
          ctx.lineWidth = pulseW;
          ctx.stroke();
        } else if (effStyle === "Color Flow (Animated)") {
          ctx.setLineDash([]);
          const flowPos = (Math.sin(nowMs * 0.0032) + 1) * 0.5;
          const grad = ctx.createLinearGradient(e.a[0], e.a[1], e.b[0], e.b[1]);
          grad.addColorStop(0, e.color);
          grad.addColorStop(Math.max(0, flowPos - 0.16), e.color);
          grad.addColorStop(flowPos, "#ffffff");
          grad.addColorStop(Math.min(1, flowPos + 0.16), e.color);
          grad.addColorStop(1, e.color);
          ctx.globalAlpha = alpha * 0.26;
          ctx.strokeStyle = grad;
          ctx.lineWidth = lw * 2.25;
          ctx.stroke();
          ctx.globalAlpha = alpha;
          ctx.lineWidth = lw;
          ctx.stroke();
        } else if (effStyle === "Neon Plasma Flow (Animated)") {
          ctx.setLineDash([]);
          const grad = ctx.createLinearGradient(e.a[0], e.a[1], e.b[0], e.b[1]);
          const timeOffset = nowMs * 0.14;
          for (let s = 0; s <= 5; s++) {
            const stop = s / 5;
            const hue = ((timeOffset - stop * 360) % 360 + 360) % 360;
            grad.addColorStop(stop, `hsl(${hue}, 95%, 60%)`);
          }
          ctx.globalAlpha = alpha * 0.26;
          ctx.strokeStyle = grad;
          ctx.lineWidth = lw * 2.5;
          ctx.stroke();
          ctx.globalAlpha = alpha;
          ctx.lineWidth = lw * 1.05;
          ctx.stroke();
          ctx.globalAlpha = alpha * 0.55;
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = Math.max(0.8, lw * 0.28);
          ctx.stroke();
        } else if (effStyle === "Flowing Energy (Animated)") {
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
        } else if (effStyle === "Pulse Beads (Animated)") {
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
        } else if (effStyle === "Outlined Cable (High Contrast)") {
          ctx.setLineDash([]);
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = "#0b0b0b";
          ctx.lineWidth = lw + 3.0;
          ctx.stroke();
          ctx.strokeStyle = e.color;
          ctx.lineWidth = lw;
          ctx.stroke();
        } else if (effStyle === "3D Glossy Pipe") {
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
        } else if (effStyle === "Glass Tube") {
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
        } else if (effStyle === "Circuit Trace (Solder Pads)") {
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
        } else if (effStyle === "Dashed Technical") {
          ctx.strokeStyle = e.color;
          ctx.lineWidth = lw;
          ctx.setLineDash([8, 5]);
          ctx.stroke();
          ctx.setLineDash([]);
        } else if (effStyle === "Blueprint Dotted") {
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
        } else if (effStyle === "Directional Chevrons") {
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

  // Wire routing & styling hook (prototype-level)
  const origDrawConnections = LGraphCanvas.prototype.drawConnections;
  if (!origDrawConnections?._livedevWrapped) {
    const wrappedProtoDraw = function (ctx) {
      try {
        if (renderer.shouldIntercept(this)) {
          if (renderer.drawAllLinks(this, ctx)) return;
        }
      } catch (e) {
        // Fall back safely to native ComfyUI link rendering
      }
      return origDrawConnections.apply(this, arguments);
    };
    wrappedProtoDraw._livedevWrapped = true;
    LGraphCanvas.prototype.drawConnections = wrappedProtoDraw;
  }

  // Re-apply global LiveDev wire config whenever switching workflows, tabs, or Subgraphs
  const origSetGraph = LGraphCanvas.prototype.setGraph;
  if (typeof origSetGraph === "function" && !origSetGraph._livedevWrapped) {
    const wrappedSetGraph = function (graph) {
      const res = origSetGraph.apply(this, arguments);
      try {
        closeSlotActionPill();
        _routeCache.key = "";
        _syncGraphWireFlags(graph || this.graph);
        _syncPulseLoop();
        this.setDirty?.(true, true);
      } catch (e) {
        // Keep graph switch resilient
      }
      return res;
    };
    wrappedSetGraph._livedevWrapped = true;
    LGraphCanvas.prototype.setGraph = wrappedSetGraph;
  }

  // Draw HUD slot indicators on slots whose links are hidden
  const origDrawNode = LGraphCanvas.prototype.drawNode;
  LGraphCanvas.prototype.drawNode = function (node, ctx) {
    const res = origDrawNode.apply(this, arguments);
    try {
      if (!node || node.flags?.collapsed || wiresConfig.wireSlotShape === "None") return res;
      const graph = this.graph || app.graph;
      if (!graph || typeof node.getConnectionPos !== "function") return res;
      if (Array.isArray(node.inputs)) {
        for (let i = 0; i < node.inputs.length; i++) {
          if (isInputSlotHidden(node, i, graph)) {
            const pos = node.getConnectionPos(true, i);
            if (pos) drawHiddenSlotIndicator(ctx, this, node, pos, true, i);
          }
        }
      }
      if (Array.isArray(node.outputs)) {
        for (let i = 0; i < node.outputs.length; i++) {
          if (isOutputSlotHidden(node, i, graph)) {
            const pos = node.getConnectionPos(false, i);
            if (pos) drawHiddenSlotIndicator(ctx, this, node, pos, false, i);
          }
        }
      }
    } catch (e) {
      // Keep node rendering resilient
    }
    return res;
  };

  // Per-slot right-click menu: Hide / Show Link for a single input or output slot
  if (typeof LGraphNode !== "undefined" && !LGraphNode.prototype._livedevSlotMenuPatched) {
    LGraphNode.prototype._livedevSlotMenuPatched = true;
    const origGetSlotMenuOptions = LGraphNode.prototype.getSlotMenuOptions;
    LGraphNode.prototype.getSlotMenuOptions = function (slot) {
      let options = [];
      let customFn = null;
      let proto = Object.getPrototypeOf(this);
      while (proto && proto !== Object.prototype) {
        if (
          Object.prototype.hasOwnProperty.call(proto, "getSlotMenuOptions") &&
          proto.getSlotMenuOptions !== LGraphNode.prototype.getSlotMenuOptions
        ) {
          customFn = proto.getSlotMenuOptions;
          break;
        }
        proto = Object.getPrototypeOf(proto);
      }
      if (customFn) {
        options = customFn.apply(this, arguments) || [];
      } else if (origGetSlotMenuOptions && origGetSlotMenuOptions !== LGraphNode.prototype.getSlotMenuOptions) {
        options = origGetSlotMenuOptions.apply(this, arguments) || [];
      }

      if (!wiresConfig.wireContextMenu) return options;

      let slotIndex = -1;
      let isInput = false;
      if (slot && typeof slot === "object") {
        if ("slot" in slot && Number.isInteger(Number(slot.slot))) {
          slotIndex = Number(slot.slot);
          isInput = Boolean(slot.input);
        } else {
          if (Array.isArray(this.inputs)) {
            slotIndex = this.inputs.findIndex((s) => s === slot || (s.name === slot.name && s.type === slot.type));
            if (slotIndex !== -1) isInput = true;
          }
          if (slotIndex === -1 && Array.isArray(this.outputs)) {
            slotIndex = this.outputs.findIndex((s) => s === slot || (s.name === slot.name && s.type === slot.type));
            if (slotIndex !== -1) isInput = false;
          }
        }
      }

      if (slotIndex < 0) return options;
      const slotObj = isInput ? this.inputs?.[slotIndex] : this.outputs?.[slotIndex];
      const hasConnection = isInput
        ? slotObj?.link != null
        : Array.isArray(slotObj?.links) && slotObj.links.length > 0;
      if (!hasConnection) return options;

      const graph = app.canvas?.graph || app.graph;
      const hidden = isInput
        ? isInputSlotHidden(this, slotIndex, graph)
        : isOutputSlotHidden(this, slotIndex, graph);

      ensureTheme();
      options.push({
        content: `<span class="ld-ctx-label">${LD_ICONS.brand}<span>${hidden ? "LiveDev: Show Link" : "LiveDev: Hide Link"}</span></span>`,
        callback: () => {
          const nowHidden = toggleSlotLinkHidden(this, isInput, slotIndex);
          showToast(nowHidden ? "LiveDev: Slot link hidden" : "LiveDev: Slot link shown");
        },
      });
      return options;
    };
  }

  // Track active node execution for Live Data Pulses (supports both root IDs and Subgraph "sg:inner" IDs)
  api.addEventListener("executing", (ev) => {
    const d = ev?.detail;
    const rawId = d && typeof d === "object" ? (d.display_node ?? d.node ?? d.node_id ?? null) : (d ?? null);
    _runningNodeId = rawId != null && rawId !== "" ? rawId : null;
    _syncPulseLoop();
  });
  api.addEventListener("execution_error", () => {
    _runningNodeId = null;
    _syncPulseLoop();
  });
  api.addEventListener("execution_interrupted", () => {
    _runningNodeId = null;
    _syncPulseLoop();
  });

  watchEyeButton();
}

function getMenuTargetNodes(node) {
  const canvas = app?.canvas;
  const selected = [];
  if (canvas?.selectedItems instanceof Set) {
    for (const item of canvas.selectedItems) {
      if (item && typeof item.id !== "undefined" && item.pos) selected.push(item);
    }
  } else if (canvas?.selected_nodes) {
    for (const n of Object.values(canvas.selected_nodes)) {
      if (n && typeof n.id !== "undefined") selected.push(n);
    }
  }
  if (selected.length > 1 && (!node || selected.includes(node))) return selected;
  return node ? [node] : selected;
}

function ensureInstanceDrawConnectionsHook(canvas) {
  if (!canvas) return;
  // If another custom node assigned an own-property canvas.drawConnections before us,
  // it would shadow LGraphCanvas.prototype.drawConnections. Wrap it cleanly without double-drawing.
  if (
    Object.prototype.hasOwnProperty.call(canvas, "drawConnections") &&
    typeof canvas.drawConnections === "function" &&
    !canvas.drawConnections._livedevInstanceWrapped
  ) {
    const ownOrig = canvas.drawConnections;
    const wrapped = function (ctx) {
      try {
        if (renderer.shouldIntercept(this)) {
          if (renderer.drawAllLinks(this, ctx)) return;
        }
      } catch (e) {
        // Fall back safely to chained drawConnections
      }
      return ownOrig.apply(this, arguments);
    };
    wrapped._livedevInstanceWrapped = true;
    wrapped._livedevWrapped = true;
    canvas.drawConnections = wrapped;
  }
}

app.registerExtension({
  name: "LiveDev.Wires",
  async setup() {
    installHooks();
    let attempts = 0;
    const bindCanvas = () => {
      if (app?.canvas) {
        qc.attach(app.canvas);
        ensureInstanceDrawConnectionsHook(app.canvas);
        // Re-check once after late-loading packs finish setup()
        setTimeout(() => ensureInstanceDrawConnectionsHook(app?.canvas), 1500);
        const canvasEl = app.canvas.canvas;
        if (canvasEl && !canvasEl._livedevWireAnimWake) {
          canvasEl._livedevWireAnimWake = true;
          const wake = () => {
            if (wiresConfig.wireAnimateOnInteractOnly && ANIMATED_VISUAL_STYLES.has(wiresConfig.wireVisualStyle)) {
              _syncPulseLoop();
            }
          };
          canvasEl.addEventListener("pointermove", wake);
          canvasEl.addEventListener("pointerdown", wake);
          canvasEl.addEventListener("pointerup", wake);
          canvasEl.addEventListener("pointerdown", (e) => {
            _slotClickCandidate = null;
            if (!wiresConfig.wireSlotPill || e.button !== 0 || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) {
              return;
            }
            const hit = hitTestCanvasSlot(app.canvas, e.clientX, e.clientY);
            if (hit) {
              _slotClickCandidate = {
                hit,
                startX: e.clientX,
                startY: e.clientY,
                time: performance.now(),
              };
            }
          }, true);
          window.addEventListener("pointerup", (e) => {
            const cand = _slotClickCandidate;
            _slotClickCandidate = null;
            if (!cand || !wiresConfig.wireSlotPill || e.button !== 0) return;
            const moved = Math.hypot(e.clientX - cand.startX, e.clientY - cand.startY);
            const dt = performance.now() - cand.time;
            if (moved < 6 && dt < 450) {
              setTimeout(() => openSlotActionPill(cand.hit), 0);
            }
          }, true);
        }
        applyWireSettings();
      } else if (++attempts < 40) {
        setTimeout(bindCanvas, 300);
      }
    };
    bindCanvas();
  },
  afterConfigureGraph() {
    closeSlotActionPill();
    _routeCache.key = "";
    ensureInstanceDrawConnectionsHook(app?.canvas);
    _syncGraphWireFlags(app?.canvas?.graph || app?.graph);
    _syncPulseLoop();
    if (app?.canvas) {
      app.canvas.setDirty(true, true);
      if (typeof app.canvas.draw === "function") app.canvas.draw(true, true);
    }
  },
  getNodeMenuItems(node) {
    if (!wiresConfig.wireContextMenu || !node) return [];
    ensureTheme();
    const targets = getMenuTargetNodes(node);
    const hidden = isNodeLinksHidden(node);
    const suffix = targets.length > 1 ? ` (${targets.length})` : "";
    const items = [
      {
        content: `<span class="ld-ctx-label">${LD_ICONS.brand}<span>${hidden ? `LiveDev: Show Links${suffix}` : `LiveDev: Hide Links${suffix}`}</span></span>`,
        callback: () => {
          const nowHidden = toggleNodesLinksHidden(targets, !hidden);
          showToast(
            nowHidden
              ? `LiveDev: Hid links on ${targets.length} node${targets.length === 1 ? "" : "s"}`
              : `LiveDev: Restored links on ${targets.length} node${targets.length === 1 ? "" : "s"}`,
          );
        },
      },
    ];
    const graph = app.canvas?.graph || app.graph;
    if (graphHasAnyHiddenLinks(graph)) {
      items.push({
        content: `<span class="ld-ctx-label">${LD_ICONS.brand}<span>LiveDev: Show All Hidden Links</span></span>`,
        callback: () => {
          const count = showAllHiddenLinks();
          showToast(`LiveDev: Restored hidden links on ${count} node${count === 1 ? "" : "s"}`);
        },
      });
    }
    return items;
  },
  getCanvasMenuItems() {
    if (!wiresConfig.wireContextMenu) return [];
    const graph = app.canvas?.graph || app.graph;
    if (!graphHasAnyHiddenLinks(graph)) return [];
    ensureTheme();
    return [
      {
        content: `<span class="ld-ctx-label">${LD_ICONS.brand}<span>LiveDev: Show All Hidden Links</span></span>`,
        callback: () => {
          const count = showAllHiddenLinks();
          showToast(`LiveDev: Restored hidden links on ${count} node${count === 1 ? "" : "s"}`);
        },
      },
    ];
  },
});
