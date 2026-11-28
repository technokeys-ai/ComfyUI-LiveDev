// Parameter Sweep & X/Y Grid Runner for ComfyUI-LiveDev.
//
// Sweeps any 1 or 2 node widgets across user-defined values or numeric ranges without adding
// extra grid nodes to the workflow, locks seeds & control_after_generate for fair comparisons,
// restores original values on completion or abort, and exports a labeled PNG grid.

import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import { esc, showToast } from "./utils.js";
import {
  ACCENT,
  DANGER,
  FONT_MONO,
  FONT_UI,
  LD_ICONS,
  createGlassModal,
  ensureTheme,
} from "./livedev-theme.js";

const MAX_VALUES_PER_AXIS = 20;
const MAX_TOTAL_CELLS = 36;
const SEED_NAMES = new Set(["seed", "noise_seed"]);
const CONTROL_NAMES = new Set(["control_after_generate"]);

function listSweepableNodes() {
  const graph = app.canvas?.graph || app.graph;
  const nodes = graph?._nodes || [];
  const out = [];
  for (const n of nodes) {
    if (!n || n.mode === 2 || n.mode === 4) continue;
    if (!Array.isArray(n.widgets) || !n.widgets.length) continue;
    const widgets = n.widgets.filter((w) => {
      if (!w || !w.name) return false;
      if (w.type === "button" || w.type === "hidden" || w.hidden) return false;
      return (
        typeof w.value === "number" ||
        typeof w.value === "string" ||
        typeof w.value === "boolean"
      );
    });
    if (widgets.length) {
      out.push({
        id: n.id,
        title: String(n.title || n.type || `Node #${n.id}`),
        type: String(n.type || "Unknown"),
        node: n,
        widgets,
      });
    }
  }
  return out;
}

function parseValues(rawText, widget) {
  const text = String(rawText || "").trim();
  if (!text) return [];

  // Range shorthand: start..end or start..end:step
  const rangeMatch = text.match(/^(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)(?:\s*:\s*(-?\d+(?:\.\d+)?))?$/);
  const rawList = [];
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    let step = rangeMatch[3] != null ? Math.abs(Number(rangeMatch[3])) : 1;
    if (!Number.isFinite(step) || step <= 0) step = 1;
    const dir = end >= start ? 1 : -1;
    for (let v = start; dir > 0 ? v <= end + 1e-9 : v >= end - 1e-9; v += dir * step) {
      rawList.push(Number(v.toFixed(6)));
      if (rawList.length >= MAX_VALUES_PER_AXIS) break;
    }
  } else {
    for (const part of text.split(",")) {
      const trimmed = part.trim();
      if (trimmed !== "") rawList.push(trimmed);
      if (rawList.length >= MAX_VALUES_PER_AXIS) break;
    }
  }

  const isNum = typeof widget?.value === "number";
  const isBool = typeof widget?.value === "boolean";
  return rawList.map((v) => {
    if (isNum) {
      const n = Number(v);
      return Number.isFinite(n) ? n : widget.value;
    }
    if (isBool) {
      if (typeof v === "boolean") return v;
      return String(v).toLowerCase() === "true" || String(v) === "1";
    }
    return String(v);
  });
}

function setWidgetValue(node, widget, val) {
  if (!node || !widget) return;
  widget.value = val;
  if (widget.inputEl && "value" in widget.inputEl) {
    widget.inputEl.value = String(val);
  }
  const idx = Array.isArray(node.widgets) ? node.widgets.indexOf(widget) : -1;
  if (idx >= 0 && Array.isArray(node.widgets_values)) {
    node.widgets_values[idx] = val;
  }
  if (typeof widget.callback === "function") {
    try {
      widget.callback(val, app.canvas, node, [0, 0], null);
    } catch (e) {}
  }
}

function snapshotSeedsAndControls(lockSeed) {
  if (!lockSeed) return [];
  const graph = app.canvas?.graph || app.graph;
  const nodes = graph?._nodes || [];
  const saved = [];
  for (const n of nodes) {
    if (!n || !Array.isArray(n.widgets)) continue;
    for (const w of n.widgets) {
      if (!w || !w.name) continue;
      const lower = String(w.name).toLowerCase();
      if (SEED_NAMES.has(lower) || CONTROL_NAMES.has(lower)) {
        saved.push({ node: n, widget: w, savedValue: w.value, isControl: CONTROL_NAMES.has(lower) });
      }
    }
  }
  return saved;
}

function buildImageUrl(img) {
  if (!img || !img.filename) return "";
  const params = new URLSearchParams({
    filename: img.filename,
    subfolder: img.subfolder || "",
    type: img.type || "output",
  });
  return api.apiURL(`/view?${params.toString()}`);
}

function runSinglePromptAndWait(abortSignal) {
  return new Promise((resolve, reject) => {
    let lastImageUrl = "";
    const startedAt = performance.now();
    let settled = false;

    const cleanup = () => {
      api.removeEventListener("executed", onExecuted);
      api.removeEventListener("execution_success", onSuccess);
      api.removeEventListener("execution_error", onError);
      api.removeEventListener("execution_interrupted", onInterrupted);
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
    };

    const done = (err, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(result);
    };

    const onExecuted = (ev) => {
      const imgs = ev?.detail?.output?.images;
      if (Array.isArray(imgs) && imgs.length) {
        const url = buildImageUrl(imgs[imgs.length - 1]);
        if (url) lastImageUrl = url;
      }
    };

    const onSuccess = () => {
      done(null, {
        imageUrl: lastImageUrl,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
    };

    const onError = (ev) => {
      const msg = ev?.detail?.exception_message || "Workflow execution error";
      done(new Error(msg));
    };

    const onInterrupted = () => {
      done(new Error("Sweep interrupted"));
    };

    const onAbort = () => {
      done(new Error("Sweep stopped by user"));
    };

    api.addEventListener("executed", onExecuted);
    api.addEventListener("execution_success", onSuccess);
    api.addEventListener("execution_error", onError);
    api.addEventListener("execution_interrupted", onInterrupted);
    if (abortSignal) abortSignal.addEventListener("abort", onAbort, { once: true });

    Promise.resolve(app.queuePrompt(0, 1)).catch((err) => {
      done(err instanceof Error ? err : new Error(String(err || "Queue failed")));
    });
  });
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = url;
  });
}

async function exportGridPng(gridData) {
  const { xLabel, yLabel, xValues, yValues, cells } = gridData;
  const cols = xValues.length;
  const rows = yValues.length;
  const loaded = new Map();

  let cellW = 384;
  let cellH = 384;

  for (const [key, cell] of cells.entries()) {
    if (!cell?.imageUrl) continue;
    try {
      const img = await loadImage(cell.imageUrl);
      loaded.set(key, img);
      if (loaded.size === 1 && img.naturalWidth > 0 && img.naturalHeight > 0) {
        const maxSide = 512;
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        cellW = Math.max(160, Math.round(img.naturalWidth * scale));
        cellH = Math.max(160, Math.round(img.naturalHeight * scale));
      }
    } catch (e) {}
  }

  if (!loaded.size) {
    showToast("LiveDev: No rendered images available to export");
    return;
  }

  const hasY = Boolean(yLabel);
  const pad = 12;
  const headH = 44;
  const leftW = hasY ? 150 : 0;
  const footerH = 22;

  const canvas = document.createElement("canvas");
  canvas.width = leftW + cols * (cellW + pad) + pad;
  canvas.height = headH + rows * (cellH + footerH + pad) + pad;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#111317";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.font = `600 13px ${FONT_UI}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Column headers
  for (let c = 0; c < cols; c++) {
    const cx = leftW + pad + c * (cellW + pad) + cellW * 0.5;
    ctx.fillStyle = ACCENT;
    ctx.fillText(`${xLabel}: ${xValues[c]}`, cx, headH * 0.5, cellW - 8);
  }

  // Row headers + cells
  for (let r = 0; r < rows; r++) {
    const yTop = headH + pad + r * (cellH + footerH + pad);
    if (hasY) {
      ctx.fillStyle = "#d8dee6";
      ctx.textAlign = "center";
      ctx.fillText(`${yLabel}: ${yValues[r]}`, leftW * 0.5, yTop + cellH * 0.5, leftW - 14);
    }
    for (let c = 0; c < cols; c++) {
      const xLeft = leftW + pad + c * (cellW + pad);
      const key = `${r}:${c}`;
      const img = loaded.get(key);
      const cell = cells.get(key);
      ctx.fillStyle = "#181b21";
      ctx.fillRect(xLeft, yTop, cellW, cellH);
      if (img) {
        ctx.drawImage(img, xLeft, yTop, cellW, cellH);
      }
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 1;
      ctx.strokeRect(xLeft, yTop, cellW, cellH);

      if (cell?.durationMs != null) {
        ctx.fillStyle = "#9aa3b0";
        ctx.font = `500 11px ${FONT_MONO}`;
        ctx.textAlign = "right";
        ctx.fillText(`${(cell.durationMs / 1000).toFixed(2)}s`, xLeft + cellW - 4, yTop + cellH + footerH * 0.55);
        ctx.font = `600 13px ${FONT_UI}`;
      }
    }
  }

  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = `livedev-xy-grid-${Date.now()}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast("LiveDev: Exported labeled X/Y grid PNG");
}

function openImageLightbox(url, caption) {
  const { body } = createGlassModal({
    title: caption || "Sweep Output",
    icon: LD_ICONS.grid,
    width: "760px",
    maxHeight: "90vh",
    draggable: true,
  });
  const img = document.createElement("img");
  img.src = url;
  img.alt = caption || "Sweep output";
  img.style.cssText = "max-width:100%;max-height:74vh;object-fit:contain;border-radius:8px;align-self:center;";
  body.appendChild(img);
}

function injectSweepStyles() {
  if (document.getElementById("livedev-xy-css")) return;
  const st = document.createElement("style");
  st.id = "livedev-xy-css";
  st.textContent = `
.ld-xy-grid-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 10px;
  flex-shrink: 0;
}
.ld-xy-axis {
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.ld-xy-axis-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: ${ACCENT};
}
.ld-xy-table {
  border-collapse: separate;
  border-spacing: 6px;
  width: 100%;
}
.ld-xy-table th {
  font-family: ${FONT_MONO};
  font-size: 11px;
  color: ${ACCENT};
  padding: 5px 8px;
  background: rgba(255, 255, 255, 0.035);
  border-radius: 6px;
  text-align: center;
}
.ld-xy-cell {
  background: rgba(0, 0, 0, 0.32);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 5px;
  text-align: center;
  vertical-align: middle;
  min-width: 120px;
  min-height: 110px;
}
.ld-xy-cell img {
  width: 100%;
  max-height: 180px;
  object-fit: contain;
  border-radius: 6px;
  cursor: zoom-in;
  display: block;
}
`;
  document.head.appendChild(st);
}

export function openXYSweepModal() {
  ensureTheme();
  injectSweepStyles();

  const sweepNodes = listSweepableNodes();
  let running = false;
  let abortCtrl = null;
  let lastGridData = null;

  const { body } = createGlassModal({
    title: "Parameter Sweep & X/Y Grid Runner",
    subtitle: "Sweep any 1 or 2 workflow widgets across values or ranges (e.g. 1..7:2) with automatic seed lock and PNG export.",
    icon: LD_ICONS.grid,
    width: "860px",
    maxHeight: "88vh",
    draggable: true,
    onClose: () => {
      if (abortCtrl) abortCtrl.abort();
    },
  });

  if (!sweepNodes.length) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding:24px;text-align:center;color:#9aa3b0;";
    empty.textContent = "No active nodes with sweepable widgets found in the current workflow.";
    body.appendChild(empty);
    return;
  }

  function buildAxisPanel(title, allowNone) {
    const box = document.createElement("div");
    box.className = "ld-xy-axis";

    const head = document.createElement("div");
    head.className = "ld-xy-axis-title";
    head.textContent = title;

    const nodeSel = document.createElement("select");
    nodeSel.className = "ld-select";
    if (allowNone) {
      const optNone = document.createElement("option");
      optNone.value = "";
      optNone.textContent = "(None — 1D Strip)";
      nodeSel.appendChild(optNone);
    }
    sweepNodes.forEach((n, idx) => {
      const opt = document.createElement("option");
      opt.value = String(idx);
      opt.textContent = `#${n.id} · ${n.title}`;
      nodeSel.appendChild(opt);
    });

    const widgetSel = document.createElement("select");
    widgetSel.className = "ld-select";

    const valInput = document.createElement("input");
    valInput.type = "text";
    valInput.className = "ld-input";
    valInput.placeholder = "Values: e.g. 1.0, 2.5, 4.0 or 1..7:2";

    const hintEl = document.createElement("div");
    hintEl.style.cssText = `font-family:${FONT_MONO};font-size:10.5px;color:#8f98a5;min-height:14px;`;

    function getSelection() {
      if (nodeSel.value === "") return null;
      const entry = sweepNodes[Number(nodeSel.value)];
      if (!entry) return null;
      const widget = entry.widgets[Number(widgetSel.value)] || null;
      if (!widget) return null;
      return { entry, widget };
    }

    function populateWidgets() {
      widgetSel.innerHTML = "";
      if (nodeSel.value === "") {
        widgetSel.disabled = true;
        valInput.disabled = true;
        hintEl.textContent = "Optional second axis for 2D grid.";
        return;
      }
      widgetSel.disabled = false;
      valInput.disabled = false;
      const entry = sweepNodes[Number(nodeSel.value)];
      entry.widgets.forEach((w, idx) => {
        const opt = document.createElement("option");
        opt.value = String(idx);
        opt.textContent = `${w.name} (${String(w.value).slice(0, 22)})`;
        widgetSel.appendChild(opt);
      });
      syncHint();
    }

    function syncHint() {
      const sel = getSelection();
      if (!sel) return;
      const w = sel.widget;
      if (Array.isArray(w.options?.values) && w.options.values.length) {
        const sample = w.options.values.slice(0, 3).join(", ");
        hintEl.textContent = `Combo (${w.options.values.length} opts) · e.g. ${sample}`;
        if (!valInput.value.trim()) valInput.value = sample;
      } else if (typeof w.value === "number") {
        hintEl.textContent = `Current: ${w.value} · supports comma list or start..end:step`;
      } else {
        hintEl.textContent = `Current: ${String(w.value).slice(0, 32)}`;
      }
    }

    nodeSel.onchange = () => {
      valInput.value = "";
      populateWidgets();
    };
    widgetSel.onchange = () => {
      valInput.value = "";
      syncHint();
    };

    box.append(head, nodeSel, widgetSel, valInput, hintEl);
    populateWidgets();
    return { box, getSelection, valInput };
  }

  const formGrid = document.createElement("div");
  formGrid.className = "ld-xy-grid-form";
  const axisX = buildAxisPanel("Axis X (Columns)", false);
  const axisY = buildAxisPanel("Axis Y (Rows — Optional)", true);
  formGrid.append(axisX.box, axisY.box);

  // Controls row
  const ctrlRow = document.createElement("div");
  ctrlRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap;flex-shrink:0;";

  const leftCtrls = document.createElement("div");
  leftCtrls.style.cssText = "display:flex;align-items:center;gap:10px;flex-wrap:wrap;";

  const seedLockLabel = document.createElement("label");
  seedLockLabel.style.cssText = "display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#cfd6df;cursor:pointer;";
  const seedLockCb = document.createElement("input");
  seedLockCb.type = "checkbox";
  seedLockCb.checked = true;
  seedLockLabel.append(seedLockCb, document.createTextNode("Lock seeds during sweep"));

  const statusText = document.createElement("span");
  statusText.style.cssText = `font-family:${FONT_MONO};font-size:11px;color:#9aa3b0;`;
  statusText.textContent = "Ready";

  leftCtrls.append(seedLockLabel, statusText);

  const rightBtns = document.createElement("div");
  rightBtns.style.cssText = "display:flex;align-items:center;gap:6px;";

  const exportBtn = document.createElement("button");
  exportBtn.type = "button";
  exportBtn.className = "ld-btn";
  exportBtn.textContent = "Export PNG";
  exportBtn.disabled = true;

  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "ld-btn ld-btn-danger";
  stopBtn.textContent = "Stop";
  stopBtn.disabled = true;

  const runBtn = document.createElement("button");
  runBtn.type = "button";
  runBtn.className = "ld-btn ld-btn-primary";
  runBtn.textContent = "Run Sweep";

  rightBtns.append(exportBtn, stopBtn, runBtn);
  ctrlRow.append(leftCtrls, rightBtns);

  const gridWrap = document.createElement("div");
  gridWrap.style.cssText = "flex:1;min-height:200px;overflow:auto;padding-right:2px;";

  body.append(formGrid, ctrlRow, gridWrap);

  function renderGridTable(gridData) {
    const { xLabel, yLabel, xValues, yValues, cells, activeKey } = gridData;
    gridWrap.innerHTML = "";
    const table = document.createElement("table");
    table.className = "ld-xy-table";

    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    if (yLabel) {
      const corner = document.createElement("th");
      corner.textContent = `${yLabel} \\ ${xLabel}`;
      htr.appendChild(corner);
    }
    for (const xv of xValues) {
      const th = document.createElement("th");
      th.textContent = `${xLabel}: ${xv}`;
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (let r = 0; r < yValues.length; r++) {
      const tr = document.createElement("tr");
      if (yLabel) {
        const th = document.createElement("th");
        th.textContent = `${yValues[r]}`;
        tr.appendChild(th);
      }
      for (let c = 0; c < xValues.length; c++) {
        const key = `${r}:${c}`;
        const cell = cells.get(key);
        const td = document.createElement("td");
        td.className = "ld-xy-cell";
        if (key === activeKey) {
          td.style.borderColor = ACCENT;
        }
        if (cell?.imageUrl) {
          const img = document.createElement("img");
          img.src = cell.imageUrl;
          img.alt = `${xLabel}=${xValues[c]}`;
          img.onclick = () =>
            openImageLightbox(
              cell.imageUrl,
              yLabel ? `${xLabel}=${xValues[c]} | ${yLabel}=${yValues[r]}` : `${xLabel}=${xValues[c]}`,
            );
          const meta = document.createElement("div");
          meta.style.cssText = `font-family:${FONT_MONO};font-size:10px;color:#9aa3b0;margin-top:4px;`;
          meta.textContent = cell.durationMs != null ? `${(cell.durationMs / 1000).toFixed(2)}s` : "";
          td.append(img, meta);
        } else if (cell?.error) {
          td.style.color = DANGER;
          td.style.fontSize = "11px";
          td.textContent = cell.error;
        } else if (key === activeKey) {
          td.style.color = ACCENT;
          td.style.fontSize = "11px";
          td.textContent = "Running...";
        } else {
          td.style.color = "#6e7782";
          td.style.fontSize = "11px";
          td.textContent = "Queued";
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    gridWrap.appendChild(table);
  }

  exportBtn.onclick = () => {
    if (lastGridData) exportGridPng(lastGridData);
  };

  stopBtn.onclick = async () => {
    if (abortCtrl) abortCtrl.abort();
    try {
      await api.fetchApi("/interrupt", { method: "POST" });
    } catch (e) {}
    showToast("LiveDev: Sweep stopping...");
  };

  runBtn.onclick = async () => {
    if (running) return;
    const selX = axisX.getSelection();
    if (!selX) {
      showToast("LiveDev: Select an X-axis node and widget");
      return;
    }
    const xValues = parseValues(axisX.valInput.value, selX.widget);
    if (!xValues.length) {
      showToast("LiveDev: Enter at least one value for Axis X");
      return;
    }
    const selY = axisY.getSelection();
    let yValues = [""];
    if (selY) {
      yValues = parseValues(axisY.valInput.value, selY.widget);
      if (!yValues.length) {
        showToast("LiveDev: Enter at least one value for Axis Y (or set Y to None)");
        return;
      }
    }

    const total = xValues.length * yValues.length;
    if (total > MAX_TOTAL_CELLS) {
      showToast(`LiveDev: Sweep capped at ${MAX_TOTAL_CELLS} cells (requested ${total})`);
      return;
    }

    const origX = selX.widget.value;
    const origY = selY ? selY.widget.value : null;
    const savedSeeds = snapshotSeedsAndControls(seedLockCb.checked);

    running = true;
    abortCtrl = new AbortController();
    runBtn.disabled = true;
    stopBtn.disabled = false;
    exportBtn.disabled = true;

    const cells = new Map();
    const gridData = {
      xLabel: `${selX.widget.name}`,
      yLabel: selY ? `${selY.widget.name}` : "",
      xValues,
      yValues,
      cells,
      activeKey: "",
    };
    lastGridData = gridData;
    renderGridTable(gridData);

    let completed = 0;
    try {
      // Lock control_after_generate to "fixed" while sweeping
      for (const s of savedSeeds) {
        if (s.isControl) setWidgetValue(s.node, s.widget, "fixed");
      }

      for (let r = 0; r < yValues.length; r++) {
        for (let c = 0; c < xValues.length; c++) {
          if (abortCtrl.signal.aborted) break;
          const key = `${r}:${c}`;
          gridData.activeKey = key;
          statusText.textContent = `Running ${completed + 1}/${total} (${gridData.xLabel}=${xValues[c]}${selY ? `, ${gridData.yLabel}=${yValues[r]}` : ""})`;
          renderGridTable(gridData);

          setWidgetValue(selX.entry.node, selX.widget, xValues[c]);
          if (selY) setWidgetValue(selY.entry.node, selY.widget, yValues[r]);
          for (const s of savedSeeds) {
            if (!s.isControl) setWidgetValue(s.node, s.widget, s.savedValue);
          }
          app.canvas?.setDirty(true, false);

          try {
            const res = await runSinglePromptAndWait(abortCtrl.signal);
            cells.set(key, res);
          } catch (err) {
            cells.set(key, { error: err.message || "Failed" });
            if (abortCtrl.signal.aborted) break;
          }
          completed += 1;
          renderGridTable(gridData);
        }
        if (abortCtrl.signal.aborted) break;
      }

      gridData.activeKey = "";
      renderGridTable(gridData);
      statusText.textContent = abortCtrl.signal.aborted
        ? `Stopped (${completed}/${total} done)`
        : `Completed ${completed}/${total} runs`;
      exportBtn.disabled = cells.size === 0;
      showToast(`LiveDev: X/Y Sweep finished (${completed}/${total})`);
    } finally {
      // Always restore original widget & seed states cleanly
      setWidgetValue(selX.entry.node, selX.widget, origX);
      if (selY) setWidgetValue(selY.entry.node, selY.widget, origY);
      for (const s of savedSeeds) {
        setWidgetValue(s.node, s.widget, s.savedValue);
      }
      app.canvas?.setDirty(true, true);
      running = false;
      abortCtrl = null;
      runBtn.disabled = false;
      stopBtn.disabled = true;
    }
  };
}

app.registerExtension({
  name: "LiveDev.XYSweep",
  async setup() {},
});
