// Auto VRAM Guard & Leak Alert for ComfyUI-LiveDev.
//
// Monitors VRAM utilization strictly between runs (never mid-generation or while queued).
// When idle VRAM crosses the configured threshold, Auto VRAM Guard automatically triggers
// /livedev/free_memory; Leak Alert warns when VRAM stays abnormally elevated after a run.

import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import { showToast } from "./utils.js";

const KEY_ENABLED = "livedev_vramGuardEnabled";
const KEY_THRESHOLD = "livedev_vramGuardThreshold";
const KEY_LEAK_ALERT = "livedev_vramLeakAlert";
const SETTLE_DELAY_MS = 1400;
const GUARD_COOLDOWN_MS = 15000;
const LEAK_DELTA_PCT = 18;
const LEAK_MIN_PCT = 75;

function lsRead(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function lsWrite(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {}
}

const config = {
  enabled: Boolean(lsRead(KEY_ENABLED, false)),
  threshold: Math.max(60, Math.min(98, Number(lsRead(KEY_THRESHOLD, 90)) || 90)),
  leakAlert: lsRead(KEY_LEAK_ALERT, true) !== false,
};

let isExecuting = false;
let queueRemaining = 0;
let baselineVramPct = null;
let settleTimer = null;
let lastGuardTs = 0;
let lastLeakAlertTs = 0;

export function getVramGuardSettings() {
  return { ...config };
}

export function applyVramGuardSettings(patch = {}) {
  if (patch.enabled !== undefined) {
    config.enabled = Boolean(patch.enabled);
    lsWrite(KEY_ENABLED, config.enabled);
  }
  if (patch.threshold !== undefined) {
    const num = Number(patch.threshold);
    if (Number.isFinite(num)) {
      config.threshold = Math.max(60, Math.min(98, Math.round(num)));
      lsWrite(KEY_THRESHOLD, config.threshold);
    }
  }
  if (patch.leakAlert !== undefined) {
    config.leakAlert = Boolean(patch.leakAlert);
    lsWrite(KEY_LEAK_ALERT, config.leakAlert);
  }
}

async function fetchVramStats() {
  try {
    const res = await api.fetchApi("/livedev/stats");
    if (!res.ok) return null;
    const data = await res.json();
    const pct = Number(data?.vram?.percent);
    const used = Number(data?.vram?.used);
    const total = Number(data?.vram?.total);
    if (!Number.isFinite(pct) || !Number.isFinite(total) || total <= 0) return null;
    return { pct, used, total };
  } catch (e) {
    return null;
  }
}

async function runIdleVramCheck() {
  settleTimer = null;
  if (isExecuting || queueRemaining > 0) return;
  if (!config.enabled && !config.leakAlert) return;

  const stats = await fetchVramStats();
  if (!stats) return;
  if (isExecuting || queueRemaining > 0) return;

  const now = Date.now();

  if (config.enabled && stats.pct >= config.threshold && now - lastGuardTs >= GUARD_COOLDOWN_MS) {
    lastGuardTs = now;
    try {
      const res = await api.fetchApi("/livedev/free_memory", { method: "POST" });
      const data = await res.json();
      if (data?.ok) {
        const freedMb = Math.max(0, (data.before?.vram_mb || 0) - (data.after?.vram_mb || 0));
        const freedLabel = freedMb >= 1024 ? `${(freedMb / 1024).toFixed(2)} GB` : `${freedMb} MB`;
        showToast(
          `VRAM Guard: Cleared memory at ${Math.round(stats.pct)}% (freed ${freedLabel} VRAM)`,
          4200,
        );
      }
    } catch (e) {
      // Non-fatal
    }
    return;
  }

  if (
    config.leakAlert &&
    baselineVramPct != null &&
    stats.pct >= LEAK_MIN_PCT &&
    stats.pct - baselineVramPct >= LEAK_DELTA_PCT &&
    now - lastLeakAlertTs >= GUARD_COOLDOWN_MS
  ) {
    lastLeakAlertTs = now;
    const delta = Math.round(stats.pct - baselineVramPct);
    showToast(
      `VRAM Leak Alert: VRAM remained at ${Math.round(stats.pct)}% (+${delta}%) after run — use LiveDev -> Memory to clear`,
      5000,
    );
  }
}

function scheduleIdleCheck() {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(runIdleVramCheck, SETTLE_DELAY_MS);
}

app.registerExtension({
  name: "LiveDev.VramGuard",
  async setup() {
    api.addEventListener("status", (e) => {
      const remaining = Number(e?.detail?.exec_info?.queue_remaining);
      if (Number.isFinite(remaining)) {
        queueRemaining = remaining;
      }
    });

    api.addEventListener("execution_start", () => {
      isExecuting = true;
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      fetchVramStats().then((stats) => {
        if (stats) baselineVramPct = stats.pct;
      });
    });

    api.addEventListener("executing", (e) => {
      const detail = e?.detail;
      const nextId = detail && typeof detail === "object" ? (detail.node ?? detail.node_id ?? null) : detail;
      if (nextId == null || nextId === "") {
        isExecuting = false;
        scheduleIdleCheck();
      } else {
        isExecuting = true;
      }
    });

    const onRunEnded = () => {
      isExecuting = false;
      scheduleIdleCheck();
    };
    api.addEventListener("execution_success", onRunEnded);
    api.addEventListener("execution_error", onRunEnded);
    api.addEventListener("execution_interrupted", onRunEnded);
  },
});
