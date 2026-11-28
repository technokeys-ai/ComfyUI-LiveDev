// Run Timer LiveDev - a sleek glassmorphic workflow stopwatch for ComfyUI.
//
// Frontend-driven node: listens to ComfyUI execution events (execution_start, execution_success,
// execution_cached, execution_error, execution_interrupted, executing), counts up with zero-waste
// foreground-only repaints, scales cleanly when resized, keeps persistent run history with stats,
// and synthesizes 5 optional Web Audio finish chimes with zero external audio asset dependencies.

import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import { showToast, esc } from "./utils.js";
import {
  ACCENT,
  ACCENT_DIM,
  DANGER,
  FONT_MONO,
  FONT_UI,
  LD_ICONS,
  createGlassModal,
} from "./livedev-theme.js";

const NODE_TYPE = "LiveDev_RunTimer";
const STATE_PROP = "liveDevRunTimerState";
const LAST_MS_PROP = "liveDevRunTimerLastMs";
const HISTORY_KEY = "livedev_run_timer_history";
const MUTE_KEY = "livedev_run_timer_muted";
const HISTORY_MAX = 25;
const MAX_RESTORE_MS = 7 * 24 * 60 * 60 * 1000;

const BASE_H = 54;
const MIN_W = 148;
const MIN_SCALE = 0.65;
const MAX_SCALE = 6.0;

// Clock typography metrics at scale 1.0
const M = {
  num: 28,
  frac: 17,
  unit: 12,
  ls: 1,
  gap: 6,
  colonW: 8,
  unitDx: 2,
  padX: 28,
  dotR: 3.6,
  dotGap: 11,
  radius: 10,
};

const DIGIT_TONES = [
  { id: "accent", label: "LiveDev Teal", color: ACCENT },
  { id: "white", label: "Pure White", color: "#e8edf2" },
  { id: "coral", label: "Warm Coral", color: DANGER },
];

const CHIME_PRESETS = [
  { id: "soft_chime", label: "Soft Chime" },
  { id: "crystal_bell", label: "Crystal Bell" },
  { id: "warm_chord", label: "Warm Chord" },
  { id: "sonar_ping", label: "Sonar Ping" },
  { id: "digital_beep", label: "Digital Beep" },
];

const DEFAULT_STATE = {
  tone: "accent",
  decimals: 0,
  chime: false,
  sound: "soft_chime",
  volume: 65,
};

// ----------------------------------------------------------------------------
// State & persistent storage helpers
// ----------------------------------------------------------------------------

function readState(node) {
  const raw = node?.properties?.[STATE_PROP];
  return { ...DEFAULT_STATE, ...(raw && typeof raw === "object" ? raw : {}) };
}

function writeState(node, patch) {
  const next = { ...readState(node), ...patch };
  node.properties = node.properties || {};
  node.properties[STATE_PROP] = next;
  return next;
}

function toneColor(toneId) {
  const found = DIGIT_TONES.find((t) => t.id === toneId);
  return found ? found.color : ACCENT;
}

function isMasterMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch (e) {
    return false;
  }
}

function setMasterMuted(muted) {
  try {
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch (e) {}
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return [];
    return arr.filter((e) => e && typeof e === "object" && Number.isFinite(Number(e.ms)));
  } catch (e) {
    return [];
  }
}

function saveHistory(arr) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(arr.slice(0, HISTORY_MAX)));
  } catch (e) {}
}

function activeWorkflowName() {
  try {
    const wf =
      app.extensionManager?.workflow?.activeWorkflow ||
      app.workflowManager?.activeWorkflow;
    let raw = (wf && (wf.filename || wf.key || wf.path || wf.name)) || "";
    raw = String(raw).split(/[\\/]/).pop().replace(/\.json$/i, "").trim();
    if (raw) return raw;
  } catch (e) {}
  return "Unsaved Workflow";
}

function recordRun(ms, name, status = "ok") {
  const dur = Number(ms);
  if (!Number.isFinite(dur) || dur < 0) return;
  const entry = {
    ms: Math.round(dur),
    name: name || activeWorkflowName(),
    status,
    at: Date.now(),
  };
  saveHistory([entry, ...loadHistory()].slice(0, HISTORY_MAX));
}

// ----------------------------------------------------------------------------
// Built-in Web Audio synthesized chimes (zero external audio files needed)
// ----------------------------------------------------------------------------

let _audioCtx = null;

function getAudioCtx() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!_audioCtx) _audioCtx = new Ctx();
  if (_audioCtx.state === "suspended") {
    _audioCtx.resume().catch(() => {});
  }
  return _audioCtx;
}

function playSynthChime(presetId, volumePct = 65) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const gainScale = Math.max(0.02, Math.min(1, (Number(volumePct) || 65) / 100)) * 0.28;
  const now = ctx.currentTime;

  const tone = (freq, startOff, dur, type = "sine", peak = 1.0) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now + startOff);
    gain.gain.setValueAtTime(0.0001, now + startOff);
    gain.gain.exponentialRampToValueAtTime(gainScale * peak, now + startOff + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + startOff + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + startOff);
    osc.stop(now + startOff + dur + 0.02);
  };

  if (presetId === "crystal_bell") {
    tone(1046.5, 0.0, 0.55, "sine", 0.9);
    tone(1567.98, 0.09, 0.72, "sine", 0.75);
    tone(2093.0, 0.09, 0.45, "triangle", 0.25);
  } else if (presetId === "warm_chord") {
    tone(523.25, 0.0, 0.85, "sine", 0.65);
    tone(659.25, 0.04, 0.85, "sine", 0.55);
    tone(783.99, 0.08, 0.90, "triangle", 0.40);
  } else if (presetId === "sonar_ping") {
    tone(880.0, 0.0, 0.65, "sine", 0.95);
    tone(1320.0, 0.0, 0.35, "sine", 0.30);
  } else if (presetId === "digital_beep") {
    tone(987.77, 0.0, 0.12, "triangle", 0.85);
    tone(1318.51, 0.14, 0.24, "triangle", 0.9);
  } else {
    // soft_chime (default)
    tone(659.25, 0.0, 0.42, "sine", 0.85);
    tone(880.0, 0.11, 0.62, "sine", 0.9);
  }
}

// ----------------------------------------------------------------------------
// Time formatting & measurement (shared by width sizing and canvas renderer)
// ----------------------------------------------------------------------------

function pad(n, len) {
  let s = String(n);
  while (s.length < len) s = "0" + s;
  return s;
}

function clockParts(ms, decimals) {
  const safe = Math.max(0, Number(ms) || 0);
  if (safe >= 3600000) {
    const h = Math.floor(safe / 3600000);
    const m = Math.floor((safe % 3600000) / 60000);
    const s = Math.floor((safe % 60000) / 1000);
    return {
      groups: [
        { num: String(h), unit: "h" },
        { num: pad(m, 2), unit: "m" },
        { num: pad(s, 2), unit: "s" },
      ],
      frac: "",
    };
  }
  const mm = Math.floor(safe / 60000);
  const ss = Math.floor((safe % 60000) / 1000);
  let frac = "";
  if (decimals === 3) frac = "." + pad(Math.floor(safe % 1000), 3);
  else if (decimals === 2) frac = "." + pad(Math.floor((safe % 1000) / 10), 2);
  return {
    groups: [
      { num: pad(mm, 2), unit: "m" },
      { num: pad(ss, 2), unit: "s" },
    ],
    frac,
  };
}

function formatPlainTime(ms, decimals = 2) {
  const safe = Math.max(0, Number(ms) || 0);
  if (safe >= 3600000) {
    const h = Math.floor(safe / 3600000);
    const m = Math.floor((safe % 3600000) / 60000);
    const s = Math.floor((safe % 60000) / 1000);
    return `${h}:${pad(m, 2)}:${pad(s, 2)}`;
  }
  const mm = Math.floor(safe / 60000);
  const ss = Math.floor((safe % 60000) / 1000);
  let frac = "";
  if (decimals === 3) frac = "." + pad(Math.floor(safe % 1000), 3);
  else if (decimals === 2) frac = "." + pad(Math.floor((safe % 1000) / 10), 2);
  return `${pad(mm, 2)}:${pad(ss, 2)}${frac}`;
}

function readoutSig(parts) {
  return parts.groups.map((g) => g.num + g.unit).join(":") + parts.frac;
}

function formatClockAgo(ts) {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return diffSec + "s ago";
  if (diffSec < 3600) return Math.floor(diffSec / 60) + "m ago";
  if (diffSec < 86400) return Math.floor(diffSec / 3600) + "h ago";
  return new Date(ts).toLocaleDateString();
}

let _measCanvas = null;
function measureCtx() {
  if (!_measCanvas) _measCanvas = document.createElement("canvas");
  return _measCanvas.getContext("2d");
}

function clockFonts(s) {
  return {
    num: `700 ${M.num * s}px ${FONT_MONO}`,
    frac: `600 ${M.frac * s}px ${FONT_MONO}`,
    unit: `600 ${M.unit * s}px ${FONT_UI}`,
  };
}

function digitCell(ctx, s) {
  let w = 0;
  for (let i = 0; i < 10; i++) {
    w = Math.max(w, ctx.measureText(String(i)).width);
  }
  return w + M.ls * s;
}

function numRunWidth(ctx, str, cell, dotW) {
  let w = 0;
  for (const ch of str) w += ch === "." ? dotW : cell;
  return w;
}

function measureDigitMetrics(ctx) {
  const prevBase = ctx.textBaseline;
  ctx.textBaseline = "alphabetic";
  const dm = ctx.measureText("0");
  ctx.textBaseline = prevBase;
  const ascent = dm && dm.actualBoundingBoxAscent != null ? dm.actualBoundingBoxAscent : 0;
  const descent = dm && dm.actualBoundingBoxDescent != null ? dm.actualBoundingBoxDescent : 0;
  return { ascent, descent, hasBox: ascent > 0 };
}

function drawNumRun(ctx, str, x, baselineY, cell, dotW) {
  const prevBase = ctx.textBaseline;
  ctx.textBaseline = "alphabetic";
  for (const ch of str) {
    const c = ch === "." ? dotW : cell;
    ctx.fillText(ch, x + (c - ctx.measureText(ch).width) / 2, baselineY);
    x += c;
  }
  ctx.textBaseline = prevBase;
  return x;
}

function clockLayout(ctx, node, s) {
  const st = readState(node);
  const parts = clockParts(node._ldRtMs || 0, st.decimals);
  const f = clockFonts(s);
  ctx.font = f.num;
  const numCell = digitCell(ctx, s);
  const numDot = ctx.measureText(".").width;
  const numMetrics = measureDigitMetrics(ctx);
  const colonW = M.colonW * s;
  ctx.font = f.frac;
  const fracCell = digitCell(ctx, s);
  const fracDot = ctx.measureText(".").width;

  const segs = parts.groups.map((g, i) => {
    ctx.font = f.num;
    const numW = numRunWidth(ctx, g.num, numCell, numDot);
    let fracW = 0;
    if (parts.frac && i === parts.groups.length - 1) {
      ctx.font = f.frac;
      fracW = numRunWidth(ctx, parts.frac, fracCell, fracDot);
    }
    ctx.font = f.unit;
    const unitW = ctx.measureText(g.unit).width;
    return { g, numW, fracW, unitW };
  });

  let total = 0;
  segs.forEach((sg, i) => {
    if (i > 0) total += M.gap * 2 * s + colonW;
    total += sg.numW + sg.fracW + M.unitDx * s + sg.unitW;
  });

  return { parts, f, segs, total, colonW, numCell, numDot, numMetrics, fracCell, fracDot };
}

function shapeSig(node) {
  const st = readState(node);
  const parts = clockParts(node._ldRtMs || 0, st.decimals);
  return parts.groups.map((g) => g.num.length).join(",") + "|" + (parts.frac ? parts.frac.length : 0);
}

function unitWidth(node) {
  const sig = shapeSig(node);
  if (node._ldRtUnitSig === sig && node._ldRtUnitW > 0) return node._ldRtUnitW;
  const innerW = M.dotR * 2 + M.dotGap + clockLayout(measureCtx(), node, 1).total;
  const w = Math.max(MIN_W, Math.round(innerW + M.padX * 2));
  node._ldRtUnitSig = sig;
  node._ldRtUnitW = w;
  return w;
}

function fitNodeToScale(node, scale) {
  const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number(scale) || 1));
  node._ldRtScale = s;
  const w = Math.round(unitWidth(node) * s);
  const h = Math.round(BASE_H * s);
  node._ldRtShapeFitted = shapeSig(node);
  if (typeof node.setSize === "function") {
    node.setSize([w, h]);
  } else {
    node.size = [w, h];
  }
  node.setDirtyCanvas?.(true, false);
}

function ensureShapeFit(node) {
  const sig = shapeSig(node);
  if (node._ldRtShapeFitted === sig) return;
  const s = node._ldRtScale || Math.max(1, Math.min(MAX_SCALE, (node.size?.[1] || BASE_H) / BASE_H));
  fitNodeToScale(node, s);
}

// ----------------------------------------------------------------------------
// Glassmorphic Canvas Painter
// ----------------------------------------------------------------------------

function drawGlassClock(node, ctx) {
  if (!ctx || node.flags?.collapsed) return;
  const bw = node.size?.[0] || MIN_W;
  const bh = node.size?.[1] || BASE_H;
  const uw = unitWidth(node);
  const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min(bw / uw, bh / BASE_H)));

  const st = readState(node);
  const status = node._ldRtStatus || "idle"; // 'idle' | 'run' | 'done' | 'error'
  const digitCol = status === "error" ? DANGER : toneColor(st.tone);
  const rad = Math.min(M.radius * s, bh * 0.42);

  ctx.save();

  // Glassmorphic dark body (covers LiteGraph's default rounded outline cleanly)
  ctx.beginPath();
  ctx.roundRect(-1, -1, bw + 2, bh + 2, rad);
  const grad = ctx.createLinearGradient(0, 0, 0, bh);
  grad.addColorStop(0, "rgba(22, 26, 33, 0.97)");
  grad.addColorStop(1, "rgba(13, 15, 20, 0.97)");
  ctx.fillStyle = grad;
  ctx.fill();

  // Subtle top glass sheen
  ctx.save();
  ctx.clip();
  const sheen = ctx.createLinearGradient(0, 0, 0, bh * 0.48);
  sheen.addColorStop(0, "rgba(255, 255, 255, 0.06)");
  sheen.addColorStop(1, "rgba(255, 255, 255, 0.0)");
  ctx.fillStyle = sheen;
  ctx.fillRect(-1, -1, bw + 2, bh * 0.48);
  ctx.restore();

  // Border glow by state
  ctx.beginPath();
  ctx.roundRect(-0.5, -0.5, bw + 1, bh + 1, rad);
  ctx.lineWidth = Math.max(1.1, 1.3 * Math.min(s, 1.8));
  if (status === "run") {
    ctx.strokeStyle = ACCENT;
  } else if (status === "error") {
    ctx.strokeStyle = DANGER;
  } else if (status === "done") {
    ctx.strokeStyle = "rgba(56, 192, 196, 0.55)";
  } else {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
  }
  ctx.stroke();

  // Center the ENTIRE unit (status dot + digits + colons + units) horizontally AND vertically
  const layout = clockLayout(ctx, node, s);
  const dotR = M.dotR * s;
  const dotGap = M.dotGap * s;
  const groupW = dotR * 2 + dotGap + layout.total;
  const startX = (bw - groupW) * 0.5;
  const midY = bh * 0.5;

  // True alphabetic baseline computed from real digit cap height so digits are mathematically centered
  const capH = layout.numMetrics.hasBox ? layout.numMetrics.ascent : M.num * s * 0.72;
  const baselineY = midY + (capH - layout.numMetrics.descent) * 0.5;

  // Status dot (dead-centered vertically with the digits)
  const dotX = startX + dotR;
  const isOddTick = status === "run" && Math.floor((node._ldRtMs || 0) / 1000) % 2 === 1;

  if (status === "run" && !isOddTick) {
    ctx.beginPath();
    ctx.arc(dotX, midY, dotR * 2.1, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(56, 192, 196, 0.24)";
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(dotX, midY, dotR, 0, Math.PI * 2);
  if (status === "run") {
    ctx.fillStyle = isOddTick ? ACCENT_DIM : ACCENT;
  } else if (status === "done") {
    ctx.fillStyle = ACCENT;
  } else if (status === "error") {
    ctx.fillStyle = DANGER;
  } else {
    ctx.fillStyle = "rgba(255, 255, 255, 0.28)";
  }
  ctx.fill();

  let x = startX + dotR * 2 + dotGap;
  ctx.textAlign = "left";

  layout.segs.forEach((sg, i) => {
    if (i > 0) {
      // Geometric double-dot colon — perfectly centered around midY at every scale
      x += M.gap * s;
      const cx = x + layout.colonW * 0.5;
      const cr = Math.max(1.4, 2.0 * s);
      const cyOff = capH * 0.23;
      ctx.fillStyle = "rgba(255, 255, 255, 0.42)";
      ctx.beginPath();
      ctx.arc(cx, midY - cyOff, cr, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, midY + cyOff, cr, 0, Math.PI * 2);
      ctx.fill();
      x += layout.colonW + M.gap * s;
    }

    ctx.font = layout.f.num;
    ctx.fillStyle = digitCol;
    x = drawNumRun(ctx, sg.g.num, x, baselineY, layout.numCell, layout.numDot);

    if (sg.fracW > 0) {
      ctx.font = layout.f.frac;
      ctx.fillStyle = digitCol;
      ctx.globalAlpha = 0.80;
      x = drawNumRun(ctx, layout.parts.frac, x, baselineY, layout.fracCell, layout.fracDot);
      ctx.globalAlpha = 1;
    }

    x += M.unitDx * s;
    ctx.font = layout.f.unit;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
    ctx.fillText(sg.g.unit, x, baselineY);
    x += sg.unitW;
  });

  // Subtle corner resize grip dots
  ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
  const gx = bw - 6;
  const gy = bh - 6;
  ctx.fillRect(gx, gy, 2, 2);
  ctx.fillRect(gx - 3.5, gy, 2, 2);
  ctx.fillRect(gx, gy - 3.5, 2, 2);

  ctx.restore();

  // Stamp what is currently visible so the RAF loop skips redundant repaints
  node._ldRtShownSig = readoutSig(layout.parts);
  node._ldRtShownAt = performance.now();
}

// ----------------------------------------------------------------------------
// Glassmorphic Settings Modal & Run History Modal
// ----------------------------------------------------------------------------

function openTimerSettings(node) {
  const st = readState(node);
  const { body, close } = createGlassModal({
    title: "Run Timer Settings",
    subtitle: "Configure precision, appearance, clock scale, and finish chime.",
    icon: LD_ICONS.history,
    width: "440px",
    maxHeight: "82vh",
    draggable: true,
  });

  const makeRow = (label, hint, controlEl) => {
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;gap:12px;" +
      "padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.03);" +
      "border:1px solid rgba(255,255,255,0.07);margin-bottom:8px;";
    const left = document.createElement("div");
    left.style.cssText = "display:flex;flex-direction:column;gap:2px;";
    const lbl = document.createElement("span");
    lbl.style.cssText = "font-size:12.5px;font-weight:600;color:#e6e9ef;";
    lbl.textContent = label;
    left.appendChild(lbl);
    if (hint) {
      const sub = document.createElement("span");
      sub.style.cssText = "font-size:11px;color:#888;";
      sub.textContent = hint;
      left.appendChild(sub);
    }
    row.appendChild(left);
    row.appendChild(controlEl);
    body.appendChild(row);
  };

  // 1. Precision
  const decSel = document.createElement("select");
  decSel.className = "ld-select";
  decSel.style.cssText = "padding:5px 9px;font-size:12px;";
  for (const [val, txt] of [
    ["0", "Seconds (00m:12s)"],
    ["2", "Hundredths (00m:12.34s)"],
    ["3", "Milliseconds (00m:12.345s)"],
  ]) {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = txt;
    if (Number(val) === st.decimals) o.selected = true;
    decSel.appendChild(o);
  }
  decSel.onchange = () => {
    writeState(node, { decimals: Number(decSel.value) || 0 });
    node._ldRtUnitSig = null;
    ensureShapeFit(node);
    node.setDirtyCanvas?.(true, false);
  };
  makeRow("Display Precision", "Decimal places shown on the stopwatch", decSel);

  // 2. Digit Tone
  const toneWrap = document.createElement("div");
  toneWrap.style.cssText = "display:flex;gap:6px;";
  const toneBtns = [];
  for (const t of DIGIT_TONES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ld-btn";
    b.title = t.label;
    b.style.cssText =
      `padding:4px 9px;font-size:11px;border-color:${st.tone === t.id ? ACCENT : "rgba(255,255,255,0.12)"};` +
      `color:${t.color};`;
    b.textContent = t.label.split(" ")[1] || t.label;
    b.onclick = () => {
      writeState(node, { tone: t.id });
      for (const tb of toneBtns) {
        tb.el.style.borderColor = tb.id === t.id ? ACCENT : "rgba(255,255,255,0.12)";
      }
      node.setDirtyCanvas?.(true, false);
    };
    toneBtns.push({ id: t.id, el: b });
    toneWrap.appendChild(b);
  }
  makeRow("Digit Color", "Palette tone for the clock numerals", toneWrap);

  // 3. Clock Scale Presets
  const scaleWrap = document.createElement("div");
  scaleWrap.style.cssText = "display:flex;gap:5px;";
  for (const sc of [1, 1.5, 2, 3]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ld-btn";
    b.style.cssText = "padding:4px 8px;font-size:11px;";
    b.textContent = sc + "x";
    b.onclick = () => {
      fitNodeToScale(node, sc);
      showToast("Clock scaled to " + sc + "x");
    };
    scaleWrap.appendChild(b);
  }
  makeRow("Clock Size", "Quick scale presets (or drag node corner)", scaleWrap);

  // 4. Finish Chime toggle
  const chimeChk = document.createElement("input");
  chimeChk.type = "checkbox";
  chimeChk.checked = Boolean(st.chime);
  chimeChk.style.cssText = `width:16px;height:16px;accent-color:${ACCENT};cursor:pointer;`;
  chimeChk.onchange = () => {
    writeState(node, { chime: chimeChk.checked });
  };
  makeRow("Finish Chime", "Play a soft synthesized sound when a run completes", chimeChk);

  // 5. Sound preset + Preview
  const soundCtrl = document.createElement("div");
  soundCtrl.style.cssText = "display:flex;align-items:center;gap:6px;";
  const soundSel = document.createElement("select");
  soundSel.className = "ld-select";
  soundSel.style.cssText = "padding:5px 8px;font-size:12px;";
  for (const p of CHIME_PRESETS) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.label;
    if (p.id === st.sound) o.selected = true;
    soundSel.appendChild(o);
  }
  soundSel.onchange = () => {
    writeState(node, { sound: soundSel.value });
  };
  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "ld-btn ld-btn-primary";
  prevBtn.style.cssText = "padding:4px 10px;font-size:11.5px;";
  prevBtn.textContent = "Preview";
  prevBtn.onclick = () => {
    const cur = readState(node);
    playSynthChime(cur.sound, cur.volume);
  };
  soundCtrl.appendChild(soundSel);
  soundCtrl.appendChild(prevBtn);
  makeRow("Chime Sound", "Built-in Web Audio chime presets", soundCtrl);

  // 6. Volume slider
  const volWrap = document.createElement("div");
  volWrap.style.cssText = "display:flex;align-items:center;gap:8px;";
  const volRange = document.createElement("input");
  volRange.type = "range";
  volRange.min = "5";
  volRange.max = "100";
  volRange.step = "5";
  volRange.value = String(st.volume ?? 65);
  volRange.style.cssText = `width:110px;accent-color:${ACCENT};cursor:pointer;`;
  const volVal = document.createElement("span");
  volVal.style.cssText = `font-family:${FONT_MONO};font-size:11.5px;color:#aaa;min-width:34px;text-align:right;`;
  volVal.textContent = volRange.value + "%";
  volRange.oninput = () => {
    volVal.textContent = volRange.value + "%";
    writeState(node, { volume: Number(volRange.value) || 65 });
  };
  volWrap.appendChild(volRange);
  volWrap.appendChild(volVal);
  makeRow("Chime Volume", "Output volume for this timer", volWrap);

  // 7. Global Master Mute
  const muteChk = document.createElement("input");
  muteChk.type = "checkbox";
  muteChk.checked = isMasterMuted();
  muteChk.style.cssText = `width:16px;height:16px;accent-color:${DANGER};cursor:pointer;`;
  muteChk.onchange = () => {
    setMasterMuted(muteChk.checked);
    showToast(muteChk.checked ? "All Run Timer chimes muted" : "Run Timer chimes unmuted");
  };
  makeRow("Mute All Timers (Global)", "Silence finish chimes across every workflow", muteChk);

  // Footer actions
  const foot = document.createElement("div");
  foot.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-top:10px;";
  const histBtn = document.createElement("button");
  histBtn.type = "button";
  histBtn.className = "ld-btn";
  histBtn.innerHTML = LD_ICONS.history + "<span>Run History</span>";
  histBtn.onclick = () => {
    close();
    openRunHistoryModal();
  };
  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.className = "ld-btn ld-btn-primary";
  doneBtn.textContent = "Done";
  doneBtn.onclick = close;
  foot.appendChild(histBtn);
  foot.appendChild(doneBtn);
  body.appendChild(foot);
}

function openRunHistoryModal() {
  const { body, close } = createGlassModal({
    title: "Run Time History",
    subtitle: "Recent workflow execution durations recorded by LiveDev Run Timer.",
    icon: LD_ICONS.history,
    width: "540px",
    maxHeight: "82vh",
    draggable: true,
  });

  const statsRow = document.createElement("div");
  statsRow.style.cssText = "display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px;";
  body.appendChild(statsRow);

  const listWrap = document.createElement("div");
  listWrap.style.cssText =
    "overflow-y:auto;flex:1;min-height:140px;max-height:46vh;border:1px solid rgba(255,255,255,0.08);" +
    "border-radius:10px;background:rgba(0,0,0,0.22);";
  body.appendChild(listWrap);

  const render = () => {
    const entries = loadHistory();
    const okTimes = entries.filter((e) => e.status !== "error").map((e) => Number(e.ms));
    const avg = okTimes.length ? okTimes.reduce((a, b) => a + b, 0) / okTimes.length : 0;
    const min = okTimes.length ? Math.min(...okTimes) : 0;
    const max = okTimes.length ? Math.max(...okTimes) : 0;

    statsRow.innerHTML = "";
    for (const [title, val] of [
      ["Average", okTimes.length ? formatPlainTime(avg, 2) : "--:--"],
      ["Fastest", okTimes.length ? formatPlainTime(min, 2) : "--:--"],
      ["Slowest", okTimes.length ? formatPlainTime(max, 2) : "--:--"],
    ]) {
      const card = document.createElement("div");
      card.style.cssText =
        "padding:8px 10px;border-radius:9px;background:rgba(255,255,255,0.035);" +
        "border:1px solid rgba(255,255,255,0.07);text-align:center;";
      card.innerHTML =
        `<div style="font-size:10.5px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">${esc(title)}</div>` +
        `<div style="font-family:${FONT_MONO};font-size:14px;font-weight:700;color:${ACCENT};margin-top:3px;">${esc(val)}</div>`;
      statsRow.appendChild(card);
    }

    listWrap.innerHTML = "";
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding:32px;text-align:center;color:#888;font-size:12px;";
      empty.textContent = "No completed runs recorded yet. Press Run to start timing.";
      listWrap.appendChild(empty);
      return;
    }

    entries.forEach((entry, idx) => {
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;align-items:center;justify-content:space-between;gap:10px;" +
        "padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.05);";

      const left = document.createElement("div");
      left.style.cssText = "display:flex;align-items:center;gap:8px;min-width:0;";
      const numEl = document.createElement("span");
      numEl.style.cssText = `font-family:${FONT_MONO};font-size:11px;color:#777;min-width:20px;`;
      numEl.textContent = "#" + (idx + 1);
      const nameEl = document.createElement("span");
      nameEl.style.cssText = "font-size:12px;color:#ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:210px;";
      nameEl.textContent = entry.name || "Unsaved Workflow";
      const agoEl = document.createElement("span");
      agoEl.style.cssText = "font-size:10.5px;color:#777;white-space:nowrap;";
      agoEl.textContent = formatClockAgo(entry.at || Date.now());
      left.appendChild(numEl);
      left.appendChild(nameEl);
      left.appendChild(agoEl);

      const right = document.createElement("div");
      right.style.cssText = "display:flex;align-items:center;gap:8px;";
      const durText = formatPlainTime(entry.ms, 2);
      const durEl = document.createElement("span");
      durEl.style.cssText =
        `font-family:${FONT_MONO};font-size:12.5px;font-weight:700;` +
        `color:${entry.status === "error" ? DANGER : ACCENT};`;
      durEl.textContent = durText;

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "ld-btn";
      copyBtn.style.cssText = "padding:3px 7px;font-size:11px;";
      copyBtn.title = "Copy duration";
      copyBtn.innerHTML = LD_ICONS.file;
      copyBtn.onclick = () => {
        navigator.clipboard?.writeText(durText).then(() => showToast("Copied " + durText));
      };

      right.appendChild(durEl);
      right.appendChild(copyBtn);
      row.appendChild(left);
      row.appendChild(right);
      listWrap.appendChild(row);
    });
  };

  const foot = document.createElement("div");
  foot.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-top:12px;";
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "ld-btn ld-btn-danger";
  clearBtn.textContent = "Clear History";
  clearBtn.onclick = () => {
    saveHistory([]);
    render();
    showToast("Run history cleared");
  };
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ld-btn ld-btn-primary";
  closeBtn.textContent = "Close";
  closeBtn.onclick = close;
  foot.appendChild(clearBtn);
  foot.appendChild(closeBtn);
  body.appendChild(foot);

  render();
}

// ----------------------------------------------------------------------------
// Global run lifecycle & zero-waste RAF loop
// ----------------------------------------------------------------------------

const _timers = new Set();
let _runActive = false;
let _runStartTs = 0;
let _runWorkflowName = "";
let _rafId = null;

function collectLiveTimers() {
  const nodes = app?.graph?._nodes || [];
  for (const n of nodes) {
    if (n && n.type === NODE_TYPE) _timers.add(n);
  }
  for (const n of Array.from(_timers)) {
    if (!n || !n.graph) _timers.delete(n);
  }
  return _timers;
}

function tickLoop() {
  if (!_runActive) {
    _rafId = null;
    return;
  }
  const now = performance.now();
  const elapsed = Math.max(0, now - _runStartTs);
  const timers = collectLiveTimers();

  for (const node of timers) {
    node._ldRtMs = elapsed;
    node._ldRtStatus = "run";
    const st = readState(node);
    const parts = clockParts(elapsed, st.decimals);
    const sig = readoutSig(parts);
    const minGap = st.decimals > 0 ? 66 : 0; // cap fractional repaints to ~15fps
    const elapsedSincePaint = now - (node._ldRtShownAt || 0);
    if (sig !== node._ldRtShownSig && elapsedSincePaint >= minGap) {
      ensureShapeFit(node);
      node.setDirtyCanvas?.(true, false);
    }
  }

  _rafId = requestAnimationFrame(tickLoop);
}

function handleRunStart() {
  _runActive = true;
  _runStartTs = performance.now();
  _runWorkflowName = activeWorkflowName();
  const timers = collectLiveTimers();
  for (const node of timers) {
    node._ldRtMs = 0;
    node._ldRtStatus = "run";
    node._ldRtShownSig = "";
    ensureShapeFit(node);
    node.setDirtyCanvas?.(true, false);
  }
  if (!_rafId) _rafId = requestAnimationFrame(tickLoop);
}

function handleRunFinish(status = "ok") {
  if (!_runActive) return;
  _runActive = false;
  if (_rafId) {
    cancelAnimationFrame(_rafId);
    _rafId = null;
  }
  const totalMs = Math.max(0, performance.now() - _runStartTs);
  const timers = collectLiveTimers();
  let chimePlayed = false;

  for (const node of timers) {
    node._ldRtMs = totalMs;
    node._ldRtStatus = status === "ok" ? "done" : "error";
    node.properties = node.properties || {};
    node.properties[LAST_MS_PROP] = Math.round(totalMs);
    ensureShapeFit(node);
    node.setDirtyCanvas?.(true, false);

    if (status === "ok" && !chimePlayed && !isMasterMuted()) {
      const st = readState(node);
      if (st.chime) {
        chimePlayed = true;
        playSynthChime(st.sound, st.volume);
      }
    }
  }

  recordRun(totalMs, _runWorkflowName, status);
}

function attachRunTimerNode(node) {
  _timers.add(node);
  node.resizable = true;
  node.color = "transparent";
  node.bgcolor = "transparent";
  node.boxcolor = "transparent";
  node.flags = node.flags || {};

  // Restore last recorded duration cleanly
  const savedMs = node.properties?.[LAST_MS_PROP];
  if (typeof savedMs === "number" && Number.isFinite(savedMs) && savedMs >= 0 && savedMs <= MAX_RESTORE_MS) {
    node._ldRtMs = savedMs;
    node._ldRtStatus = savedMs > 0 ? "done" : "idle";
  } else {
    node._ldRtMs = 0;
    node._ldRtStatus = "idle";
  }

  // Adopt live run if added while a prompt is already executing
  if (_runActive) {
    node._ldRtMs = Math.max(0, performance.now() - _runStartTs);
    node._ldRtStatus = "run";
  }

  const h = node.size?.[1] || BASE_H;
  node._ldRtScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, h / BASE_H));
  if (!node.size || node.size[0] < MIN_W || node.size[1] < 32) {
    fitNodeToScale(node, 1);
  } else {
    node._ldRtShapeFitted = shapeSig(node);
  }
}

// ----------------------------------------------------------------------------
// Extension Registration
// ----------------------------------------------------------------------------

app.registerExtension({
  name: "LiveDev.RunTimer",
  async setup() {
    api.addEventListener("execution_start", () => handleRunStart());
    api.addEventListener("execution_success", () => handleRunFinish("ok"));
    api.addEventListener("execution_error", () => handleRunFinish("error"));
    api.addEventListener("execution_interrupted", () => handleRunFinish("error"));
    api.addEventListener("executing", (ev) => {
      if (ev?.detail === null && _runActive) {
        handleRunFinish("ok");
      }
    });
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    // Title-less sleek clock chassis (same pattern as standalone canvas stopwatches)
    if (typeof LiteGraph !== "undefined" && LiteGraph.NO_TITLE != null) {
      nodeType.title_mode = LiteGraph.NO_TITLE;
    }

    const origCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = origCreated?.apply(this, arguments);
      attachRunTimerNode(this);
      return r;
    };

    const origConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = origConfigure?.apply(this, arguments);
      attachRunTimerNode(this);
      return r;
    };

    const origRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      _timers.delete(this);
      return origRemoved?.apply(this, arguments);
    };

    const origResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function (size) {
      const r = origResize?.apply(this, arguments);
      if (size && size.length >= 2) {
        const uw = unitWidth(this);
        const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.max(size[0] / uw, size[1] / BASE_H)));
        this._ldRtScale = s;
        size[0] = Math.round(uw * s);
        size[1] = Math.round(BASE_H * s);
      }
      return r;
    };

    nodeType.prototype.onDrawBackground = function (ctx) {
      drawGlassClock(this, ctx);
    };

    nodeType.prototype.onDrawForeground = function () {
      // Drawn cleanly in onDrawBackground so selection ring stays crisp on top
    };

    const origDblClick = nodeType.prototype.onDblClick;
    nodeType.prototype.onDblClick = function () {
      openTimerSettings(this);
      return origDblClick?.apply(this, arguments) ?? true;
    };

    const origMenu = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      origMenu?.apply(this, arguments);
      options.unshift(
        {
          content: "Run Timer Settings...",
          callback: () => openTimerSettings(this),
        },
        {
          content: "Run Time History...",
          callback: () => openRunHistoryModal(),
        },
        {
          content: "Copy Elapsed Time",
          callback: () => {
            const st = readState(this);
            const txt = formatPlainTime(this._ldRtMs || 0, st.decimals);
            navigator.clipboard?.writeText(txt).then(() => showToast("Copied " + txt));
          },
        },
        {
          content: "Reset Timer",
          callback: () => {
            this._ldRtMs = 0;
            this._ldRtStatus = "idle";
            if (this.properties) this.properties[LAST_MS_PROP] = 0;
            ensureShapeFit(this);
            this.setDirtyCanvas?.(true, false);
            showToast("Timer reset");
          },
        },
        null
      );
    };
  },
});
