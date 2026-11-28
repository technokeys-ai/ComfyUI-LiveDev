// Per-Node Execution Profiler & Bottleneck Heatmap for ComfyUI-LiveDev.
//
// Tracks execution duration and approximate VRAM delta per node during workflow runs, draws
// optional sleek glass timing badges above profiled nodes on the canvas, and opens a ranked
// Bottleneck Breakdown modal with 1-click Jump-to-Node navigation.

import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import { esc, showToast } from "./utils.js";
import {
  ACCENT,
  ACCENT_DIM,
  DANGER,
  DANGER_DIM,
  FONT_MONO,
  FONT_UI,
  LD_ICONS,
  createGlassModal,
  ensureTheme,
} from "./livedev-theme.js";

const BADGE_SETTING_KEY = "livedev_profilerBadges";
const BOTTLENECK_SHARE = 0.35;
const VRAM_SAMPLE_COOLDOWN_MS = 450;

let badgesEnabled = true;
try {
  const stored = localStorage.getItem(BADGE_SETTING_KEY);
  if (stored !== null) badgesEnabled = JSON.parse(stored) !== false;
} catch (e) {
  badgesEnabled = true;
}

const state = {
  runStatus: "idle", // idle | running | done | error | interrupted
  runStartedAt: 0,
  runFinishedAt: 0,
  runTotalMs: 0,
  activeNodeId: null,
  activeNodeStart: 0,
  activeNodeStartVramMb: null,
  lastVramMb: null,
  peakVramMb: 0,
  lastVramFetchTs: 0,
  records: new Map(), // String(nodeId) -> { id, durationMs, runs, cached, vramDeltaMb, peakVramMb, title, type }
};

let activeModalRender = null;
let canvasPatched = false;

function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "0ms";
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(n < 10000 ? 2 : 1)}s`;
  const totalSec = Math.floor(n / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}m ${secs}s`;
}

function findGraphNode(id) {
  const graph = app.canvas?.graph || app.graph;
  if (!graph) return null;
  const num = Number(id);
  if (Number.isFinite(num) && typeof graph.getNodeById === "function") {
    const direct = graph.getNodeById(num);
    if (direct) return direct;
  }
  const nodes = graph._nodes || [];
  return nodes.find((n) => String(n.id) === String(id)) || null;
}

function snapshotNodeMeta(id) {
  const node = findGraphNode(id);
  return {
    title: node ? String(node.title || node.type || `Node #${id}`) : `Node #${id}`,
    type: node ? String(node.type || "Unknown") : "Unknown",
  };
}

async function sampleVramMb(force = false) {
  const now = performance.now();
  if (!force && now - state.lastVramFetchTs < VRAM_SAMPLE_COOLDOWN_MS) {
    return state.lastVramMb;
  }
  state.lastVramFetchTs = now;
  try {
    const res = await api.fetchApi("/livedev/stats");
    if (!res.ok) return state.lastVramMb;
    const data = await res.json();
    const used = Number(data?.vram?.used);
    if (Number.isFinite(used) && used >= 0) {
      state.lastVramMb = used;
      if (used > state.peakVramMb) state.peakVramMb = used;
      return used;
    }
  } catch (e) {
    // Non-fatal: timing still works even if stats endpoint is unavailable.
  }
  return state.lastVramMb;
}

function finalizeActiveNode(nowTs) {
  if (state.activeNodeId == null) return;
  const key = String(state.activeNodeId);
  const elapsed = Math.max(0, nowTs - state.activeNodeStart);
  const meta = snapshotNodeMeta(key);
  const prev = state.records.get(key) || {
    id: key,
    durationMs: 0,
    runs: 0,
    cached: false,
    vramDeltaMb: 0,
    peakVramMb: 0,
    title: meta.title,
    type: meta.type,
  };
  prev.durationMs += elapsed;
  prev.runs += 1;
  prev.cached = false;
  prev.title = meta.title;
  prev.type = meta.type;
  const startVram = state.activeNodeStartVramMb;
  state.records.set(key, prev);

  state.activeNodeId = null;
  state.activeNodeStart = 0;
  state.activeNodeStartVramMb = null;

  // Non-blocking VRAM delta sample for non-trivial nodes (>= 150ms).
  if (elapsed >= 150) {
    sampleVramMb(false).then((vramNow) => {
      if (vramNow != null && startVram != null) {
        const delta = Math.round(vramNow - startVram);
        const rec = state.records.get(key);
        if (rec) {
          if (Math.abs(delta) > Math.abs(rec.vramDeltaMb)) rec.vramDeltaMb = delta;
          if (vramNow > rec.peakVramMb) rec.peakVramMb = vramNow;
          if (activeModalRender) activeModalRender();
        }
      }
    });
  }
}

function totalExecutedMs() {
  let sum = 0;
  for (const rec of state.records.values()) {
    if (!rec.cached) sum += rec.durationMs;
  }
  return sum;
}

function redrawCanvas() {
  try {
    app.canvas?.setDirty(true, false);
  } catch (e) {}
}

function handleExecutionStart() {
  state.runStatus = "running";
  state.runStartedAt = performance.now();
  state.runFinishedAt = 0;
  state.runTotalMs = 0;
  state.activeNodeId = null;
  state.activeNodeStart = 0;
  state.activeNodeStartVramMb = null;
  state.peakVramMb = 0;
  state.records.clear();

  sampleVramMb(true).then((vram) => {
    if (vram != null && state.activeNodeId != null && state.activeNodeStartVramMb == null) {
      state.activeNodeStartVramMb = vram;
    }
    if (activeModalRender) activeModalRender();
  });
  redrawCanvas();
  if (activeModalRender) activeModalRender();
}

function handleExecutionCached(event) {
  const detail = event?.detail;
  const ids = Array.isArray(detail?.nodes) ? detail.nodes : Array.isArray(detail) ? detail : [];
  for (const rawId of ids) {
    if (rawId == null) continue;
    const key = String(rawId);
    if (!state.records.has(key)) {
      const meta = snapshotNodeMeta(key);
      state.records.set(key, {
        id: key,
        durationMs: 0,
        runs: 0,
        cached: true,
        vramDeltaMb: 0,
        peakVramMb: 0,
        title: meta.title,
        type: meta.type,
      });
    }
  }
  redrawCanvas();
  if (activeModalRender) activeModalRender();
}

function handleExecuting(event) {
  const now = performance.now();
  const detail = event?.detail;
  const nextId = detail && typeof detail === "object" ? (detail.node ?? detail.node_id ?? null) : detail;

  finalizeActiveNode(now);

  if (nextId == null || nextId === "") {
    if (state.runStatus === "running") {
      state.runStatus = "done";
      state.runFinishedAt = now;
      state.runTotalMs = Math.max(0, now - state.runStartedAt);
    }
    redrawCanvas();
    if (activeModalRender) activeModalRender();
    return;
  }

  if (state.runStatus !== "running") {
    state.runStatus = "running";
    state.runStartedAt = now;
  }
  state.activeNodeId = String(nextId);
  state.activeNodeStart = now;
  state.activeNodeStartVramMb = state.lastVramMb;
  redrawCanvas();
  if (activeModalRender) activeModalRender();
}

function finishRun(status) {
  const now = performance.now();
  finalizeActiveNode(now);
  state.runStatus = status;
  state.runFinishedAt = now;
  if (state.runStartedAt > 0) {
    state.runTotalMs = Math.max(0, now - state.runStartedAt);
  }
  sampleVramMb(true).then(() => {
    if (activeModalRender) activeModalRender();
  });
  redrawCanvas();
  if (activeModalRender) activeModalRender();
}

function drawRoundedPill(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

function drawNodeTimingBadge(node, ctx) {
  if (!badgesEnabled || !node || !ctx || state.records.size === 0) return;
  if (node.flags && node.flags.collapsed) return;
  const key = String(node.id);
  const rec = state.records.get(key);
  const isRunning = state.activeNodeId === key;
  if (!rec && !isRunning) return;

  const totalMs = totalExecutedMs();
  const isCached = Boolean(rec && rec.cached && !isRunning);
  const ms = isRunning ? Math.max(0, performance.now() - state.activeNodeStart) + (rec ? rec.durationMs : 0) : (rec ? rec.durationMs : 0);
  const share = totalMs > 0 ? ms / totalMs : 0;
  const isBottleneck = !isCached && !isRunning && ((share >= BOTTLENECK_SHARE && ms >= 250) || ms >= 5000);

  const label = isRunning ? `Running ${formatDuration(ms)}` : isCached ? "Cached" : formatDuration(ms);
  const accentColor = isBottleneck ? DANGER : isCached ? "#9aa3b0" : ACCENT;

  const titleH = typeof LiteGraph !== "undefined" && LiteGraph.NODE_TITLE_HEIGHT ? LiteGraph.NODE_TITLE_HEIGHT : 30;
  const hasTitle = node.constructor?.title_mode !== 2 && node.title_mode !== 2;
  const pillH = 18;
  const y = (hasTitle ? -titleH : 0) - pillH - 4;

  ctx.save();
  ctx.font = `600 10.5px ${FONT_MONO}`;
  const textW = ctx.measureText(label).width;
  const dotW = 10;
  const padX = 7;
  const pillW = Math.ceil(textW + dotW + padX * 2);
  const x = 0;

  drawRoundedPill(ctx, x, y, pillW, pillH, 9);
  ctx.fillStyle = "rgba(16, 18, 22, 0.90)";
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = isBottleneck
    ? "rgba(229, 115, 115, 0.65)"
    : isCached
      ? "rgba(255, 255, 255, 0.14)"
      : "rgba(56, 192, 196, 0.55)";
  ctx.stroke();

  // Status dot
  ctx.beginPath();
  ctx.arc(x + padX + 3, y + pillH * 0.5, 2.7, 0, Math.PI * 2);
  ctx.fillStyle = accentColor;
  ctx.fill();

  // Label text
  ctx.fillStyle = isBottleneck ? DANGER : isCached ? "#b4bcc7" : "#eef3f7";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + padX + dotW, y + pillH * 0.5 + 0.5);
  ctx.restore();
}

function patchCanvasForBadges() {
  if (canvasPatched) return;
  const proto = typeof LGraphCanvas !== "undefined" ? LGraphCanvas.prototype : app.canvas?.constructor?.prototype;
  if (!proto || typeof proto.drawNode !== "function") return;
  if (proto.__livedevProfilerPatched) {
    canvasPatched = true;
    return;
  }
  const origDrawNode = proto.drawNode;
  proto.drawNode = function (node, ctx) {
    const res = origDrawNode.apply(this, arguments);
    try {
      // LiteGraph's drawNodes() already translates ctx to (node.pos[0], node.pos[1])
      // before calling drawNode(node, ctx), so draw directly in node-local coordinates.
      if (badgesEnabled && node && ctx && state.records.size > 0) {
        ctx.save();
        drawNodeTimingBadge(node, ctx);
        ctx.restore();
      }
    } catch (e) {
      // Never interfere with ComfyUI canvas rendering.
    }
    return res;
  };
  proto.__livedevProfilerPatched = true;
  canvasPatched = true;
}

export function setProfilerBadges(enabled) {
  badgesEnabled = Boolean(enabled);
  try {
    localStorage.setItem(BADGE_SETTING_KEY, JSON.stringify(badgesEnabled));
  } catch (e) {}
  redrawCanvas();
}

export function clearProfilerData() {
  state.records.clear();
  state.runStatus = "idle";
  state.runStartedAt = 0;
  state.runFinishedAt = 0;
  state.runTotalMs = 0;
  state.activeNodeId = null;
  state.peakVramMb = 0;
  redrawCanvas();
  if (activeModalRender) activeModalRender();
}

export function getProfilerSnapshot() {
  const list = [...state.records.values()];
  const executed = list.filter((r) => !r.cached).sort((a, b) => b.durationMs - a.durationMs);
  const cached = list.filter((r) => r.cached);
  const sumMs = executed.reduce((acc, r) => acc + r.durationMs, 0);
  return {
    status: state.runStatus,
    totalMs: state.runTotalMs || sumMs,
    sumMs,
    executed,
    cached,
    peakVramMb: state.peakVramMb,
    badgesEnabled,
  };
}

function jumpToNode(nodeId) {
  const node = findGraphNode(nodeId);
  const canvas = app.canvas;
  if (!node || !canvas) {
    showToast("LiveDev: Node not found on the active canvas");
    return false;
  }
  try {
    canvas.selectNode(node, false);
    if (typeof canvas.centerOnNode === "function") {
      canvas.centerOnNode(node);
    } else if (canvas.ds && canvas.canvas) {
      const w = canvas.canvas.width / (window.devicePixelRatio || 1);
      const h = canvas.canvas.height / (window.devicePixelRatio || 1);
      canvas.ds.offset[0] = -node.pos[0] + w / (2 * canvas.ds.scale) - (node.size?.[0] || 160) * 0.5;
      canvas.ds.offset[1] = -node.pos[1] + h / (2 * canvas.ds.scale) - (node.size?.[1] || 80) * 0.5;
    }
    canvas.setDirty(true, true);
    showToast(`Focused #${node.id} · ${node.title || node.type}`);
    return true;
  } catch (e) {
    return false;
  }
}

function injectProfilerStyles() {
  if (document.getElementById("livedev-profiler-css")) return;
  const st = document.createElement("style");
  st.id = "livedev-profiler-css";
  st.textContent = `
.ld-prof-kpis {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 12px;
  flex-shrink: 0;
}
.ld-prof-kpi {
  padding: 9px 11px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.08);
}
.ld-prof-kpi-lbl {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #8f98a5;
  margin-bottom: 3px;
}
.ld-prof-kpi-val {
  font-family: ${FONT_MONO};
  font-size: 14px;
  font-weight: 700;
  color: #eef3f7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ld-prof-kpi-val.is-accent { color: ${ACCENT}; }
.ld-prof-kpi-val.is-danger { color: ${DANGER}; }
.ld-prof-bar-wrap {
  height: 5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.07);
  overflow: hidden;
  margin-top: 6px;
}
.ld-prof-bar {
  height: 100%;
  border-radius: 999px;
  background: ${ACCENT};
  transition: width 0.2s ease;
}
.ld-prof-bar.is-hot {
  background: ${DANGER};
}
.ld-prof-card {
  padding: 9px 12px;
  margin-bottom: 6px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.07);
}
.ld-prof-card.is-hot {
  border-color: rgba(229, 115, 115, 0.40);
  background: rgba(229, 115, 115, 0.06);
}
.ld-prof-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 999px;
  font-family: ${FONT_MONO};
  font-size: 11px;
  font-weight: 600;
  background: rgba(56, 192, 196, 0.14);
  color: ${ACCENT};
  border: 1px solid rgba(56, 192, 196, 0.30);
}
.ld-prof-pill.is-hot {
  background: rgba(229, 115, 115, 0.14);
  color: ${DANGER};
  border-color: rgba(229, 115, 115, 0.35);
}
.ld-prof-pill.is-muted {
  background: rgba(255, 255, 255, 0.06);
  color: #9aa3b0;
  border-color: rgba(255, 255, 255, 0.10);
}
`;
  document.head.appendChild(st);
}

export function openProfilerModal() {
  ensureTheme();
  injectProfilerStyles();

  const { body, close } = createGlassModal({
    title: "Node Execution Profiler",
    subtitle: "Per-node timing breakdown, bottleneck heatmap badges, and VRAM impact from the latest run.",
    icon: LD_ICONS.chart,
    width: "700px",
    maxHeight: "84vh",
    draggable: true,
    onClose: () => {
      activeModalRender = null;
    },
  });

  const toolbar = document.createElement("div");
  toolbar.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap;flex-shrink:0;";

  const leftBtns = document.createElement("div");
  leftBtns.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;";

  const badgeToggleBtn = document.createElement("button");
  badgeToggleBtn.type = "button";
  badgeToggleBtn.className = badgesEnabled ? "ld-btn ld-btn-primary" : "ld-btn";
  badgeToggleBtn.textContent = badgesEnabled ? "Canvas Badges: ON" : "Canvas Badges: OFF";
  badgeToggleBtn.onclick = () => {
    setProfilerBadges(!badgesEnabled);
    badgeToggleBtn.className = badgesEnabled ? "ld-btn ld-btn-primary" : "ld-btn";
    badgeToggleBtn.textContent = badgesEnabled ? "Canvas Badges: ON" : "Canvas Badges: OFF";
    showToast(`LiveDev: Node timing badges ${badgesEnabled ? "enabled" : "hidden"}`);
  };

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "ld-btn ld-btn-danger";
  clearBtn.textContent = "Clear Run Data";
  clearBtn.onclick = () => {
    clearProfilerData();
    showToast("LiveDev: Profiler run data cleared");
  };

  leftBtns.append(badgeToggleBtn, clearBtn);

  const statusTag = document.createElement("span");
  statusTag.style.cssText = `font-family:${FONT_MONO};font-size:11px;color:#9aa3b0;`;
  toolbar.append(leftBtns, statusTag);

  const kpiWrap = document.createElement("div");
  kpiWrap.className = "ld-prof-kpis";

  const listWrap = document.createElement("div");
  listWrap.style.cssText = "flex:1;min-height:180px;overflow-y:auto;padding-right:2px;";

  body.append(toolbar, kpiWrap, listWrap);

  function render() {
    const snap = getProfilerSnapshot();
    statusTag.textContent = `Status: ${snap.status.toUpperCase()}`;

    const slowest = snap.executed[0] || null;
    kpiWrap.innerHTML =
      `<div class="ld-prof-kpi"><div class="ld-prof-kpi-lbl">Total Run</div><div class="ld-prof-kpi-val is-accent">${esc(formatDuration(snap.totalMs))}</div></div>` +
      `<div class="ld-prof-kpi"><div class="ld-prof-kpi-lbl">Nodes (Exec / Cache)</div><div class="ld-prof-kpi-val">${snap.executed.length} / ${snap.cached.length}</div></div>` +
      `<div class="ld-prof-kpi"><div class="ld-prof-kpi-lbl">Top Bottleneck</div><div class="ld-prof-kpi-val ${slowest ? "is-danger" : ""}" title="${esc(slowest ? slowest.title : "None")}">${esc(slowest ? slowest.title : "—")}</div></div>` +
      `<div class="ld-prof-kpi"><div class="ld-prof-kpi-lbl">Peak VRAM</div><div class="ld-prof-kpi-val">${snap.peakVramMb > 0 ? esc(`${(snap.peakVramMb / 1024).toFixed(2)} GB`) : "—"}</div></div>`;

    listWrap.innerHTML = "";
    if (!snap.executed.length && !snap.cached.length) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding:28px 16px;text-align:center;color:#8f98a5;border:1px dashed rgba(255,255,255,0.10);border-radius:10px;";
      empty.textContent = "No profiled execution data yet. Queue a workflow run and reopen this panel to inspect bottlenecks.";
      listWrap.appendChild(empty);
      return;
    }

    const totalForShare = snap.sumMs || 1;
    snap.executed.forEach((rec, idx) => {
      const share = Math.min(1, rec.durationMs / totalForShare);
      const pct = (share * 100).toFixed(1);
      const isHot = (share >= BOTTLENECK_SHARE && rec.durationMs >= 250) || rec.durationMs >= 5000;

      const card = document.createElement("div");
      card.className = "ld-prof-card" + (isHot ? " is-hot" : "");

      const topRow = document.createElement("div");
      topRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;";

      const titleCol = document.createElement("div");
      titleCol.style.cssText = "min-width:0;flex:1;";
      titleCol.innerHTML =
        `<div style="display:flex;align-items:center;gap:6px;min-width:0;">` +
        `<span style="font-family:${FONT_MONO};font-size:11px;color:#8f98a5;">#${idx + 1}</span>` +
        `<span style="font-weight:600;color:#eef3f7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(rec.title)}</span>` +
        `<span style="font-family:${FONT_MONO};font-size:10.5px;color:#8f98a5;">(ID ${esc(rec.id)})</span>` +
        `</div>` +
        `<div style="font-size:11px;color:#8f98a5;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(rec.type)}${rec.runs > 1 ? ` · ${rec.runs}x` : ""}${rec.vramDeltaMb ? ` · VRAM ${rec.vramDeltaMb > 0 ? "+" : ""}${rec.vramDeltaMb} MB` : ""}</div>`;

      const rightCol = document.createElement("div");
      rightCol.style.cssText = "display:flex;align-items:center;gap:6px;flex-shrink:0;";

      const durPill = document.createElement("span");
      durPill.className = "ld-prof-pill" + (isHot ? " is-hot" : "");
      durPill.textContent = `${formatDuration(rec.durationMs)} · ${pct}%`;

      const jumpBtn = document.createElement("button");
      jumpBtn.type = "button";
      jumpBtn.className = "ld-btn";
      jumpBtn.style.cssText = "padding:4px 9px;font-size:11px;";
      jumpBtn.textContent = "Jump";
      jumpBtn.onclick = () => {
        if (jumpToNode(rec.id)) close();
      };

      rightCol.append(durPill, jumpBtn);
      topRow.append(titleCol, rightCol);

      const barWrap = document.createElement("div");
      barWrap.className = "ld-prof-bar-wrap";
      const bar = document.createElement("div");
      bar.className = "ld-prof-bar" + (isHot ? " is-hot" : "");
      bar.style.width = `${Math.max(2, Math.round(share * 100))}%`;
      barWrap.appendChild(bar);

      card.append(topRow, barWrap);
      listWrap.appendChild(card);
    });

    if (snap.cached.length) {
      const cacheHead = document.createElement("div");
      cacheHead.style.cssText = "margin:12px 0 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#8f98a5;";
      cacheHead.textContent = `Cached Nodes (${snap.cached.length})`;
      listWrap.appendChild(cacheHead);

      for (const rec of snap.cached) {
        const row = document.createElement("div");
        row.className = "ld-row-item";
        row.style.cursor = "default";

        const info = document.createElement("div");
        info.style.cssText = "min-width:0;flex:1;";
        info.innerHTML =
          `<div style="font-weight:500;color:#cfd6df;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(rec.title)} <span style="font-family:${FONT_MONO};font-size:10.5px;color:#8f98a5;">(ID ${esc(rec.id)})</span></div>` +
          `<div style="font-size:10.5px;color:#8f98a5;">${esc(rec.type)}</div>`;

        const right = document.createElement("div");
        right.style.cssText = "display:flex;align-items:center;gap:6px;flex-shrink:0;";
        const pill = document.createElement("span");
        pill.className = "ld-prof-pill is-muted";
        pill.textContent = "Cached";
        const jumpBtn = document.createElement("button");
        jumpBtn.type = "button";
        jumpBtn.className = "ld-btn";
        jumpBtn.style.cssText = "padding:4px 9px;font-size:11px;";
        jumpBtn.textContent = "Jump";
        jumpBtn.onclick = () => {
          if (jumpToNode(rec.id)) close();
        };

        right.append(pill, jumpBtn);
        row.append(info, right);
        listWrap.appendChild(row);
      }
    }
  }

  activeModalRender = render;
  render();
}

app.registerExtension({
  name: "LiveDev.NodeProfiler",
  async setup() {
    api.addEventListener("execution_start", handleExecutionStart);
    api.addEventListener("execution_cached", handleExecutionCached);
    api.addEventListener("executing", handleExecuting);
    api.addEventListener("execution_success", () => finishRun("done"));
    api.addEventListener("execution_error", () => finishRun("error"));
    api.addEventListener("execution_interrupted", () => finishRun("interrupted"));

    patchCanvasForBadges();
    if (!canvasPatched) {
      setTimeout(patchCanvasForBadges, 500);
      setTimeout(patchCanvasForBadges, 1500);
    }
  },
});
