// Interactive Queue Inspector & Smart ETA for ComfyUI-LiveDev.
//
// Displays the active running job and all pending prompts in ComfyUI's execution queue with
// live step progress, Smart ETA calculated from Profiler + Run Timer history, individual job
// cancellation, Clear Pending, Interrupt Current, and 1-click Re-Run with a fresh seed.

import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import { esc, showToast } from "./utils.js";
import {
  ACCENT,
  DANGER,
  FONT_MONO,
  LD_ICONS,
  createGlassModal,
  ensureTheme,
} from "./livedev-theme.js";
import { getProfilerSnapshot } from "./node-profiler.js";

const RUN_HISTORY_KEY = "livedev_run_timer_history";
const SEED_WIDGET_NAMES = new Set(["seed", "noise_seed"]);

const live = {
  isRunning: false,
  runStartedAt: 0,
  activeNodeId: null,
  stepValue: 0,
  stepMax: 0,
  queueRemaining: 0,
  recentDurationsMs: [],
};

let activeRefreshFn = null;

function formatMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1000) return `${Math.round(n)}ms`;
  const sec = Math.round(n / 1000);
  if (sec < 60) return `${sec}s`;
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${mins}m ${rem}s`;
}

function getHistoricalAvgRunMs() {
  const samples = [...live.recentDurationsMs];
  try {
    const raw = localStorage.getItem(RUN_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      for (const item of parsed.slice(0, 10)) {
        const ms = Number(item?.ms);
        if (Number.isFinite(ms) && ms > 200) samples.push(ms);
      }
    }
  } catch (e) {}
  const prof = getProfilerSnapshot();
  if (prof?.totalMs > 200) samples.push(prof.totalMs);

  if (!samples.length) return 0;
  const sum = samples.reduce((a, b) => a + b, 0);
  return Math.round(sum / samples.length);
}

export function getSmartEtaMs(pendingCount = 0) {
  const avg = getHistoricalAvgRunMs();
  let currentRemaining = 0;

  if (live.isRunning) {
    const elapsed = Math.max(0, performance.now() - live.runStartedAt);
    if (live.stepMax > 0 && live.stepValue > 0 && live.stepValue < live.stepMax && elapsed > 400) {
      // Blend step-based estimate with historical workflow average
      const stepFrac = live.stepValue / live.stepMax;
      const stepProjectedTotal = elapsed / stepFrac;
      const blendedTotal = avg > 0 ? stepProjectedTotal * 0.65 + avg * 0.35 : stepProjectedTotal;
      currentRemaining = Math.max(500, blendedTotal - elapsed);
    } else if (avg > 0) {
      currentRemaining = Math.max(500, avg - elapsed);
    }
  }

  const pendingEta = pendingCount > 0 && avg > 0 ? pendingCount * avg : 0;
  return {
    avgRunMs: avg,
    currentRemainingMs: Math.round(currentRemaining),
    totalQueueMs: Math.round(currentRemaining + pendingEta),
  };
}

function nodeTitleById(id) {
  if (id == null) return "";
  const graph = app.canvas?.graph || app.graph;
  const node =
    graph?.getNodeById?.(Number(id)) ||
    graph?._nodes?.find((n) => String(n.id) === String(id));
  if (!node) return `Node #${id}`;
  return `${node.title || node.type || "Node"} (#${node.id})`;
}

async function fetchQueueData() {
  const res = await api.fetchApi("/queue");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return {
    running: Array.isArray(data?.queue_running) ? data.queue_running : [],
    pending: Array.isArray(data?.queue_pending) ? data.queue_pending : [],
  };
}

async function cancelPendingPrompt(promptId) {
  const res = await api.fetchApi("/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delete: [promptId] }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function clearPendingQueue() {
  const res = await api.fetchApi("/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clear: true }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function rerunWithNewSeed() {
  const graph = app.canvas?.graph || app.graph;
  const nodes = graph?._nodes || [];
  let changed = 0;
  for (const n of nodes) {
    if (!n || n.mode === 2 || n.mode === 4 || !Array.isArray(n.widgets)) continue;
    for (const w of n.widgets) {
      if (!w || !SEED_WIDGET_NAMES.has(String(w.name || "").toLowerCase())) continue;
      const newSeed = Math.floor(Math.random() * 1e14) + 1;
      w.value = newSeed;
      if (w.inputEl && "value" in w.inputEl) w.inputEl.value = String(newSeed);
      const idx = n.widgets.indexOf(w);
      if (idx >= 0 && Array.isArray(n.widgets_values)) n.widgets_values[idx] = newSeed;
      changed += 1;
    }
  }
  app.canvas?.setDirty(true, false);
  await app.queuePrompt(0, 1);
  showToast(
    changed
      ? `LiveDev: Queued new run with ${changed} randomized seed${changed === 1 ? "" : "s"}`
      : "LiveDev: Queued new workflow run",
  );
}

function summarizePromptTuple(tuple) {
  const number = tuple?.[0];
  const promptId = String(tuple?.[1] || "");
  const promptObj = tuple?.[2];
  const nodeCount = promptObj && typeof promptObj === "object" ? Object.keys(promptObj).length : 0;
  return { number, promptId, nodeCount };
}

function injectQueueStyles() {
  if (document.getElementById("livedev-queue-css")) return;
  const st = document.createElement("style");
  st.id = "livedev-queue-css";
  st.textContent = `
.ld-q-kpis {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 12px;
  flex-shrink: 0;
}
.ld-q-kpi {
  padding: 9px 11px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.08);
}
.ld-q-kpi-lbl {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #8f98a5;
  margin-bottom: 3px;
}
.ld-q-kpi-val {
  font-family: ${FONT_MONO};
  font-size: 14px;
  font-weight: 700;
  color: #eef3f7;
}
.ld-q-kpi-val.is-accent { color: ${ACCENT}; }
.ld-q-card {
  padding: 10px 12px;
  margin-bottom: 7px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
}
.ld-q-card.is-running {
  border-color: rgba(56, 192, 196, 0.42);
  background: rgba(56, 192, 196, 0.07);
}
.ld-q-bar-bg {
  height: 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
  margin-top: 8px;
}
.ld-q-bar-fill {
  height: 100%;
  border-radius: 999px;
  background: ${ACCENT};
  transition: width 0.2s ease;
}
`;
  document.head.appendChild(st);
}

export async function openQueueInspectorModal() {
  ensureTheme();
  injectQueueStyles();

  let tickTimer = null;
  let lastQueue = { running: [], pending: [] };

  const { body } = createGlassModal({
    title: "Interactive Queue Inspector & Smart ETA",
    subtitle: "Monitor active execution, inspect and cancel pending jobs, or re-run with a fresh seed.",
    icon: LD_ICONS.trace,
    width: "700px",
    maxHeight: "84vh",
    draggable: true,
    onClose: () => {
      activeRefreshFn = null;
      if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
    },
  });

  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap;flex-shrink:0;";

  const leftBtns = document.createElement("div");
  leftBtns.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;";

  const rerunBtn = document.createElement("button");
  rerunBtn.type = "button";
  rerunBtn.className = "ld-btn ld-btn-primary";
  rerunBtn.innerHTML = LD_ICONS.bolt + "<span>Re-Run (New Seed)</span>";

  const clearPendingBtn = document.createElement("button");
  clearPendingBtn.type = "button";
  clearPendingBtn.className = "ld-btn";
  clearPendingBtn.textContent = "Clear Pending";

  const interruptBtn = document.createElement("button");
  interruptBtn.type = "button";
  interruptBtn.className = "ld-btn ld-btn-danger";
  interruptBtn.textContent = "Interrupt Current";

  leftBtns.append(rerunBtn, clearPendingBtn, interruptBtn);

  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "ld-btn";
  refreshBtn.innerHTML = LD_ICONS.refresh + "<span>Refresh</span>";

  bar.append(leftBtns, refreshBtn);

  const kpiWrap = document.createElement("div");
  kpiWrap.className = "ld-q-kpis";

  const contentWrap = document.createElement("div");
  contentWrap.style.cssText = "flex:1;min-height:200px;overflow-y:auto;padding-right:2px;";

  body.append(bar, kpiWrap, contentWrap);

  function renderView() {
    const runningList = lastQueue.running;
    const pendingList = lastQueue.pending;
    const eta = getSmartEtaMs(pendingList.length);
    const isBusy = runningList.length > 0 || live.isRunning;

    interruptBtn.disabled = !isBusy;
    clearPendingBtn.disabled = pendingList.length === 0;

    kpiWrap.innerHTML =
      `<div class="ld-q-kpi"><div class="ld-q-kpi-lbl">Status</div><div class="ld-q-kpi-val ${isBusy ? "is-accent" : ""}">${isBusy ? "RUNNING" : "IDLE"}</div></div>` +
      `<div class="ld-q-kpi"><div class="ld-q-kpi-lbl">Pending Jobs</div><div class="ld-q-kpi-val">${pendingList.length}</div></div>` +
      `<div class="ld-q-kpi"><div class="ld-q-kpi-lbl">Smart Queue ETA</div><div class="ld-q-kpi-val is-accent">${esc(isBusy || pendingList.length ? formatMs(eta.totalQueueMs) : "—")}</div></div>` +
      `<div class="ld-q-kpi"><div class="ld-q-kpi-lbl">Avg Run Time</div><div class="ld-q-kpi-val">${esc(formatMs(eta.avgRunMs))}</div></div>`;

    contentWrap.innerHTML = "";

    // Running section
    const runHead = document.createElement("div");
    runHead.style.cssText = "font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#8f98a5;margin-bottom:6px;";
    runHead.textContent = `Active Job (${runningList.length})`;
    contentWrap.appendChild(runHead);

    if (!runningList.length) {
      const idleBox = document.createElement("div");
      idleBox.style.cssText = "padding:14px;border-radius:10px;border:1px dashed rgba(255,255,255,0.10);color:#8f98a5;font-size:12px;margin-bottom:12px;";
      idleBox.textContent = "Server is idle. No workflow is currently executing.";
      contentWrap.appendChild(idleBox);
    } else {
      for (const tuple of runningList) {
        const meta = summarizePromptTuple(tuple);
        const card = document.createElement("div");
        card.className = "ld-q-card is-running";
        const elapsed = live.runStartedAt > 0 ? Math.max(0, performance.now() - live.runStartedAt) : 0;
        const pct = live.stepMax > 0 ? Math.min(100, Math.round((live.stepValue / live.stepMax) * 100)) : 0;
        const stepInfo = live.stepMax > 0 ? `Step ${live.stepValue}/${live.stepMax} (${pct}%)` : "Executing...";
        const activeLabel = live.activeNodeId != null ? nodeTitleById(live.activeNodeId) : "Initializing...";

        card.innerHTML =
          `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">` +
          `<div style="font-weight:600;color:#eef3f7;">${esc(activeLabel)}</div>` +
          `<span style="font-family:${FONT_MONO};font-size:11px;color:${ACCENT};">${esc(stepInfo)}</span>` +
          `</div>` +
          `<div style="font-family:${FONT_MONO};font-size:10.5px;color:#9aa3b0;margin-top:4px;">` +
          `Prompt ${esc(meta.promptId.slice(0, 12))} · ${meta.nodeCount} nodes · Elapsed ${esc(formatMs(elapsed))}` +
          (eta.currentRemainingMs > 0 ? ` · ETA ~${esc(formatMs(eta.currentRemainingMs))}` : "") +
          `</div>` +
          `<div class="ld-q-bar-bg"><div class="ld-q-bar-fill" style="width:${live.stepMax > 0 ? pct : 18}%;"></div></div>`;
        contentWrap.appendChild(card);
      }
    }

    // Pending section
    const pendHead = document.createElement("div");
    pendHead.style.cssText = "font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#8f98a5;margin:10px 0 6px;";
    pendHead.textContent = `Pending Queue (${pendingList.length})`;
    contentWrap.appendChild(pendHead);

    if (!pendingList.length) {
      const noneBox = document.createElement("div");
      noneBox.style.cssText = "padding:14px;border-radius:10px;border:1px dashed rgba(255,255,255,0.10);color:#8f98a5;font-size:12px;";
      noneBox.textContent = "No pending jobs waiting in the queue.";
      contentWrap.appendChild(noneBox);
    } else {
      pendingList.forEach((tuple, idx) => {
        const meta = summarizePromptTuple(tuple);
        const card = document.createElement("div");
        card.className = "ld-q-card";
        card.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;";

        const left = document.createElement("div");
        left.style.cssText = "min-width:0;flex:1;";
        left.innerHTML =
          `<div style="font-weight:600;color:#eef3f7;">#${idx + 1} · Prompt <span style="font-family:${FONT_MONO};color:${ACCENT};">${esc(meta.promptId.slice(0, 14))}</span></div>` +
          `<div style="font-family:${FONT_MONO};font-size:10.5px;color:#8f98a5;margin-top:3px;">Queue #${esc(meta.number)} · ${meta.nodeCount} nodes</div>`;

        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "ld-btn ld-btn-danger";
        cancelBtn.style.cssText = "padding:4px 10px;font-size:11px;flex-shrink:0;";
        cancelBtn.textContent = "Cancel";
        cancelBtn.onclick = async () => {
          cancelBtn.disabled = true;
          try {
            await cancelPendingPrompt(meta.promptId);
            showToast(`LiveDev: Removed queued job #${idx + 1}`);
            await syncQueue();
          } catch (e) {
            showToast(`LiveDev: Failed to cancel job — ${e.message}`);
            cancelBtn.disabled = false;
          }
        };

        card.append(left, cancelBtn);
        contentWrap.appendChild(card);
      });
    }
  }

  async function syncQueue() {
    try {
      lastQueue = await fetchQueueData();
      renderView();
    } catch (e) {
      contentWrap.innerHTML = `<div style="color:${DANGER};padding:12px;">Failed to load queue: ${esc(e.message)}</div>`;
    }
  }

  rerunBtn.onclick = async () => {
    rerunBtn.disabled = true;
    try {
      await rerunWithNewSeed();
      await syncQueue();
    } catch (e) {
      showToast(`LiveDev: Re-run failed — ${e.message}`);
    } finally {
      rerunBtn.disabled = false;
    }
  };

  clearPendingBtn.onclick = async () => {
    clearPendingBtn.disabled = true;
    try {
      await clearPendingQueue();
      showToast("LiveDev: Cleared all pending jobs");
      await syncQueue();
    } catch (e) {
      showToast(`LiveDev: Clear pending failed — ${e.message}`);
    }
  };

  interruptBtn.onclick = async () => {
    interruptBtn.disabled = true;
    try {
      await api.fetchApi("/interrupt", { method: "POST" });
      showToast("LiveDev: Interrupt requested");
      setTimeout(syncQueue, 350);
    } catch (e) {
      showToast(`LiveDev: Interrupt failed — ${e.message}`);
    }
  };

  refreshBtn.onclick = () => {
    syncQueue();
  };

  activeRefreshFn = () => {
    syncQueue();
  };

  await syncQueue();
  tickTimer = setInterval(renderView, 1000);
}

app.registerExtension({
  name: "LiveDev.QueueInspector",
  async setup() {
    api.addEventListener("status", (e) => {
      const rem = Number(e?.detail?.exec_info?.queue_remaining);
      if (Number.isFinite(rem)) live.queueRemaining = rem;
      if (activeRefreshFn) activeRefreshFn();
    });

    api.addEventListener("execution_start", () => {
      live.isRunning = true;
      live.runStartedAt = performance.now();
      live.stepValue = 0;
      live.stepMax = 0;
      if (activeRefreshFn) activeRefreshFn();
    });

    api.addEventListener("executing", (e) => {
      const detail = e?.detail;
      const nextId = detail && typeof detail === "object" ? (detail.node ?? detail.node_id ?? null) : detail;
      live.activeNodeId = nextId != null && nextId !== "" ? String(nextId) : null;
      if (live.activeNodeId == null) {
        live.isRunning = false;
        live.stepValue = 0;
        live.stepMax = 0;
      } else {
        live.isRunning = true;
        if (!live.runStartedAt) live.runStartedAt = performance.now();
      }
      if (activeRefreshFn) activeRefreshFn();
    });

    api.addEventListener("progress", (e) => {
      const d = e?.detail || {};
      live.stepValue = Number(d.value) || 0;
      live.stepMax = Number(d.max) || 0;
    });

    api.addEventListener("execution_success", () => {
      if (live.runStartedAt > 0) {
        const dur = Math.round(performance.now() - live.runStartedAt);
        if (dur > 200) {
          live.recentDurationsMs.unshift(dur);
          if (live.recentDurationsMs.length > 10) live.recentDurationsMs.pop();
        }
      }
      live.isRunning = false;
      live.activeNodeId = null;
      live.stepValue = 0;
      live.stepMax = 0;
      if (activeRefreshFn) activeRefreshFn();
    });

    const onEnded = () => {
      live.isRunning = false;
      live.activeNodeId = null;
      live.stepValue = 0;
      live.stepMax = 0;
      if (activeRefreshFn) activeRefreshFn();
    };
    api.addEventListener("execution_error", onEnded);
    api.addEventListener("execution_interrupted", onEnded);
  },
});
