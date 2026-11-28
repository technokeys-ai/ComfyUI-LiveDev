// Workflow Pre-Flight Check (Readiness Inspector) for ComfyUI-LiveDev.
//
// Scans the active workflow before execution and verifies installed model/LoRA/VAE filenames
// against server folder_paths, flags unknown/missing node types, checks disconnected required
// inputs, and summarizes muted or bypassed nodes with 1-click Jump-to-Node navigation.

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

const MODEL_EXT_RE = /\.(safetensors|ckpt|pt|pth|bin|gguf|onnx|sft|torchscript|engine)$/i;
const IGNORE_MODEL_VALUES = new Set(["", "none", "baked vae", "baked", "default", "auto", "disabled"]);
const VIRTUAL_NODE_TYPES = new Set([
  "Note",
  "MarkdownNote",
  "Reroute",
  "PrimitiveNode",
  "Subgraph",
]);

function normalizePath(val) {
  return String(val || "").trim().replace(/\\/g, "/").toLowerCase();
}

function basenameOf(val) {
  const norm = normalizePath(val);
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

function focusNode(node) {
  const canvas = app.canvas;
  if (!node || !canvas) return false;
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

async function fetchInstalledModels() {
  try {
    const res = await api.fetchApi("/livedev/preflight_models");
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.ok) return null;
    const rawFiles = [];
    const seen = new Set();
    if (data.available && typeof data.available === "object") {
      for (const arr of Object.values(data.available)) {
        if (!Array.isArray(arr)) continue;
        for (const f of arr) {
          const s = String(f || "").trim();
          if (s && !seen.has(s)) {
            seen.add(s);
            rawFiles.push(s);
          }
        }
      }
    }
    return {
      allFiles: new Set((data.all_files || []).map((s) => String(s).toLowerCase())),
      allBasenames: new Set((data.all_basenames || []).map((s) => String(s).toLowerCase())),
      rawFiles,
      total: Number(data.total || 0),
      categories: Number(data.categories || 0),
    };
  } catch (e) {
    return null;
  }
}

function stripExt(name) {
  return basenameOf(name).replace(MODEL_EXT_RE, "");
}

function tokenizeModel(name) {
  return stripExt(name)
    .split(/[^a-z0-9]+/i)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2);
}

function bigrams(str) {
  const s = str.toLowerCase();
  const map = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2);
    map.set(bg, (map.get(bg) || 0) + 1);
  }
  return map;
}

function diceSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ma = bigrams(a);
  const mb = bigrams(b);
  let overlap = 0;
  for (const [k, cnt] of ma.entries()) {
    const c2 = mb.get(k) || 0;
    if (c2 > 0) overlap += Math.min(cnt, c2);
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

function fuzzyRankModels(missingVal, candidates, limit = 3) {
  if (!Array.isArray(candidates) || !candidates.length) return [];
  const targetStem = stripExt(missingVal);
  const targetTokens = new Set(tokenizeModel(missingVal));
  const scored = [];
  const seen = new Set();

  for (const raw of candidates) {
    if (typeof raw !== "string") continue;
    const val = raw.trim();
    if (!val || seen.has(val) || IGNORE_MODEL_VALUES.has(val.toLowerCase())) continue;
    seen.add(val);

    const candStem = stripExt(val);
    const dice = diceSimilarity(targetStem, candStem);
    const candTokens = tokenizeModel(val);
    let tokenScore = 0;
    if (targetTokens.size && candTokens.length) {
      let hits = 0;
      for (const t of candTokens) {
        if (targetTokens.has(t)) hits += 1;
      }
      tokenScore = (2 * hits) / (targetTokens.size + candTokens.length);
    }
    const containsBonus =
      candStem.includes(targetStem) || targetStem.includes(candStem) ? 0.16 : 0;
    const score = Math.min(0.99, dice * 0.55 + tokenScore * 0.45 + containsBonus);
    if (score >= 0.28) {
      scored.push({ value: val, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function swapWidgetModelValue(node, widget, newValue) {
  if (!node || !widget) return false;
  try {
    const graph = app.canvas?.graph || app.graph;
    graph?.beforeChange?.();
    widget.value = newValue;
    if (widget.inputEl && "value" in widget.inputEl) {
      widget.inputEl.value = newValue;
    }
    const wIdx = Array.isArray(node.widgets) ? node.widgets.indexOf(widget) : -1;
    if (wIdx >= 0 && Array.isArray(node.widgets_values)) {
      node.widgets_values[wIdx] = newValue;
    }
    if (typeof widget.callback === "function") {
      widget.callback(newValue, app.canvas, node, [0, 0], null);
    }
    graph?.afterChange?.();
    graph?.change?.();
    app.canvas?.setDirty(true, true);
    return true;
  } catch (e) {
    return false;
  }
}

export async function runPreflightScan() {
  const graph = app.canvas?.graph || app.graph;
  const nodes = graph?._nodes ? [...graph._nodes] : [];
  const modelsIndex = await fetchInstalledModels();
  const registered = typeof LiteGraph !== "undefined" ? LiteGraph.registered_node_types || {} : {};

  const issues = [];
  let activeCount = 0;
  let mutedCount = 0;
  let bypassedCount = 0;

  for (const node of nodes) {
    if (!node) continue;
    const nodeType = String(node.type || "");
    const nodeTitle = String(node.title || nodeType || `Node #${node.id}`);
    const mode = Number(node.mode || 0);

    // 1. Muted / Bypassed status
    if (mode === 2) {
      mutedCount += 1;
      issues.push({
        severity: "warning",
        category: "Muted Node",
        node,
        nodeId: node.id,
        nodeTitle,
        nodeType,
        detail: "Node is muted (mode=2) and will not execute.",
      });
      continue;
    }
    if (mode === 4) {
      bypassedCount += 1;
      issues.push({
        severity: "warning",
        category: "Bypassed Node",
        node,
        nodeId: node.id,
        nodeTitle,
        nodeType,
        detail: "Node is bypassed (mode=4) and passes data through without running.",
      });
      continue;
    }
    activeCount += 1;

    // 2. Unknown / Missing Node Type
    const isVirtual = VIRTUAL_NODE_TYPES.has(nodeType) || nodeType.startsWith("workflow/");
    const isMissingClass =
      !isVirtual &&
      ((nodeType && !registered[nodeType]) ||
        nodeType === "MissingNodeType" ||
        Boolean(node.properties?.missing));
    if (isMissingClass) {
      issues.push({
        severity: "error",
        category: "Missing Node",
        node,
        nodeId: node.id,
        nodeTitle,
        nodeType,
        detail: `Node type "${nodeType}" is not registered on this ComfyUI server.`,
      });
    }

    // 3. Disconnected Required Inputs
    const nodeData = node.constructor?.nodeData || registered[nodeType]?.nodeData || null;
    const reqInputs = nodeData?.input?.required || null;
    const optInputs = nodeData?.input?.optional || null;
    if (Array.isArray(node.inputs)) {
      for (const inp of node.inputs) {
        if (!inp || inp.link != null) continue;
        // Skip widget-backed slots (they carry inline values) and optional slots.
        if (inp.widget != null) continue;
        if (optInputs && Object.prototype.hasOwnProperty.call(optInputs, inp.name)) continue;
        if (reqInputs && !Object.prototype.hasOwnProperty.call(reqInputs, inp.name)) continue;
        if (!reqInputs && !inp.type) continue;
        issues.push({
          severity: "error",
          category: "Disconnected Input",
          node,
          nodeId: node.id,
          nodeTitle,
          nodeType,
          detail: `Required input "${inp.name}" (${inp.type || "ANY"}) is not connected.`,
        });
      }
    }

    // 4. Missing Model / LoRA / VAE / ControlNet Files
    if (Array.isArray(node.widgets)) {
      for (const w of node.widgets) {
        if (!w || typeof w.value !== "string") continue;
        const rawVal = w.value.trim();
        if (!rawVal || rawVal.length > 260 || rawVal.includes("\n")) continue;
        const lower = rawVal.toLowerCase();
        if (IGNORE_MODEL_VALUES.has(lower)) continue;
        if (lower.startsWith("http://") || lower.startsWith("https://")) continue;

        const looksLikeModel = MODEL_EXT_RE.test(rawVal);
        if (!looksLikeModel) continue;

        const norm = normalizePath(rawVal);
        const base = basenameOf(rawVal);
        const comboValues = Array.isArray(w.options?.values) ? w.options.values : null;
        const inCombo = comboValues
          ? comboValues.some((v) => {
              const s = normalizePath(v);
              return s === norm || basenameOf(s) === base;
            })
          : false;
        const inServer = modelsIndex
          ? modelsIndex.allFiles.has(norm) || modelsIndex.allBasenames.has(base)
          : false;

        if (!inCombo && !inServer) {
          const pool =
            comboValues && comboValues.length
              ? comboValues
              : modelsIndex?.rawFiles || [];
          const suggestions = fuzzyRankModels(rawVal, pool, 3);
          issues.push({
            severity: "error",
            category: "Missing Model",
            node,
            nodeId: node.id,
            nodeTitle,
            nodeType,
            widget: w,
            missingValue: rawVal,
            suggestions,
            detail: `Widget "${w.name}" references "${rawVal}", which was not found in ComfyUI model folders.`,
          });
        }
      }
    }
  }

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return {
    totalNodes: nodes.length,
    activeCount,
    mutedCount,
    bypassedCount,
    modelsIndexed: modelsIndex ? modelsIndex.total : null,
    issues,
    errors,
    warnings,
  };
}

function injectPreflightStyles() {
  if (document.getElementById("livedev-preflight-css")) return;
  const st = document.createElement("style");
  st.id = "livedev-preflight-css";
  st.textContent = `
.ld-pf-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 11px 14px;
  border-radius: 10px;
  margin-bottom: 11px;
  border: 1px solid rgba(56, 192, 196, 0.35);
  background: rgba(56, 192, 196, 0.10);
  flex-shrink: 0;
}
.ld-pf-banner.has-errors {
  border-color: rgba(229, 115, 115, 0.42);
  background: rgba(229, 115, 115, 0.10);
}
.ld-pf-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  margin-bottom: 6px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.07);
}
.ld-pf-item.is-error {
  border-color: rgba(229, 115, 115, 0.34);
  background: rgba(229, 115, 115, 0.055);
}
.ld-pf-tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 999px;
  font-family: ${FONT_MONO};
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}
.ld-pf-tag.is-error {
  background: rgba(229, 115, 115, 0.18);
  color: ${DANGER};
  border: 1px solid rgba(229, 115, 115, 0.38);
}
.ld-pf-tag.is-warn {
  background: rgba(56, 192, 196, 0.14);
  color: ${ACCENT};
  border: 1px solid rgba(56, 192, 196, 0.32);
}
`;
  document.head.appendChild(st);
}

export async function openPreflightModal() {
  ensureTheme();
  injectPreflightStyles();

  const { body, close } = createGlassModal({
    title: "Workflow Pre-Flight Check",
    subtitle: "Inspect missing models, unknown nodes, disconnected required inputs, and muted/bypassed nodes.",
    icon: LD_ICONS.shield,
    width: "700px",
    maxHeight: "84vh",
    draggable: true,
  });

  const banner = document.createElement("div");
  banner.className = "ld-pf-banner";
  banner.textContent = "Scanning workflow and server model folders...";

  const filterBar = document.createElement("div");
  filterBar.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap;flex-shrink:0;";

  const tabGroup = document.createElement("div");
  tabGroup.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;";

  let activeTab = "all";
  let lastResult = null;

  const tabAll = document.createElement("button");
  tabAll.type = "button";
  tabAll.className = "ld-btn ld-btn-primary";
  tabAll.textContent = "All";

  const tabErr = document.createElement("button");
  tabErr.type = "button";
  tabErr.className = "ld-btn";
  tabErr.textContent = "Errors";

  const tabWarn = document.createElement("button");
  tabWarn.type = "button";
  tabWarn.className = "ld-btn";
  tabWarn.textContent = "Warnings";

  const rescanBtn = document.createElement("button");
  rescanBtn.type = "button";
  rescanBtn.className = "ld-btn";
  rescanBtn.innerHTML = LD_ICONS.refresh + "<span>Re-Scan</span>";

  tabGroup.append(tabAll, tabErr, tabWarn);
  filterBar.append(tabGroup, rescanBtn);

  const listWrap = document.createElement("div");
  listWrap.style.cssText = "flex:1;min-height:180px;overflow-y:auto;padding-right:2px;";

  body.append(banner, filterBar, listWrap);

  function updateTabStyles() {
    tabAll.className = activeTab === "all" ? "ld-btn ld-btn-primary" : "ld-btn";
    tabErr.className = activeTab === "error" ? "ld-btn ld-btn-danger" : "ld-btn";
    tabWarn.className = activeTab === "warning" ? "ld-btn ld-btn-primary" : "ld-btn";
  }

  function renderList() {
    if (!lastResult) return;
    updateTabStyles();
    const { issues, errors, warnings, totalNodes, activeCount, modelsIndexed } = lastResult;

    tabAll.textContent = `All (${issues.length})`;
    tabErr.textContent = `Errors (${errors.length})`;
    tabWarn.textContent = `Warnings (${warnings.length})`;

    banner.className = "ld-pf-banner" + (errors.length ? " has-errors" : "");
    const headline = errors.length
      ? `${errors.length} Blocking Issue${errors.length === 1 ? "" : "s"} Found`
      : "Workflow Ready To Run";
    const subMeta = `${totalNodes} nodes (${activeCount} active)${modelsIndexed != null ? ` · ${modelsIndexed} models indexed` : ""}`;
    banner.innerHTML =
      `<div>` +
      `<div style="font-weight:700;font-size:13.5px;color:${errors.length ? DANGER : ACCENT};">${esc(headline)}</div>` +
      `<div style="font-size:11.5px;color:#aeb7c2;margin-top:2px;">${esc(subMeta)}</div>` +
      `</div>` +
      `<span class="ld-pf-tag ${errors.length ? "is-error" : "is-warn"}">${errors.length ? "Action Needed" : "Pass"}</span>`;

    const filtered = activeTab === "all" ? issues : issues.filter((i) => i.severity === activeTab);
    listWrap.innerHTML = "";

    if (!filtered.length) {
      const okBox = document.createElement("div");
      okBox.style.cssText = "padding:26px 16px;text-align:center;color:#9aa3b0;border:1px dashed rgba(255,255,255,0.10);border-radius:10px;";
      okBox.textContent = activeTab === "all"
        ? "Zero issues detected across the current graph."
        : `No ${activeTab} items in this workflow.`;
      listWrap.appendChild(okBox);
      return;
    }

    for (const item of filtered) {
      const card = document.createElement("div");
      card.className = "ld-pf-item" + (item.severity === "error" ? " is-error" : "");

      const info = document.createElement("div");
      info.style.cssText = "min-width:0;flex:1;";
      info.innerHTML =
        `<div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;">` +
        `<span class="ld-pf-tag ${item.severity === "error" ? "is-error" : "is-warn"}">${esc(item.category)}</span>` +
        `<span style="font-weight:600;color:#eef3f7;">${esc(item.nodeTitle)}</span>` +
        `<span style="font-family:${FONT_MONO};font-size:10.5px;color:#8f98a5;">(ID ${esc(item.nodeId)})</span>` +
        `</div>` +
        `<div style="font-size:11.5px;color:#c2cbd6;margin-top:5px;line-height:1.45;word-break:break-word;">${esc(item.detail)}</div>`;

      // Fuzzy Model Swap suggestions for missing models
      if (item.widget && Array.isArray(item.suggestions) && item.suggestions.length) {
        const swapBox = document.createElement("div");
        swapBox.style.cssText =
          "margin-top:8px;padding:7px 9px;border-radius:8px;background:rgba(56,192,196,0.08);" +
          "border:1px solid rgba(56,192,196,0.28);display:flex;flex-direction:column;gap:5px;";
        const swapHead = document.createElement("div");
        swapHead.style.cssText = `font-size:10.5px;font-weight:700;color:${ACCENT};text-transform:uppercase;letter-spacing:0.04em;`;
        swapHead.textContent = "Fuzzy Model Matches (1-Click Swap)";
        swapBox.appendChild(swapHead);

        for (const cand of item.suggestions) {
          const row = document.createElement("div");
          row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;";
          const label = document.createElement("span");
          label.style.cssText = `font-family:${FONT_MONO};font-size:11px;color:#e4ebf2;word-break:break-all;flex:1;`;
          label.textContent = `${cand.value} (${Math.round(cand.score * 100)}%)`;

          const swapBtn = document.createElement("button");
          swapBtn.type = "button";
          swapBtn.className = "ld-btn ld-btn-primary";
          swapBtn.style.cssText = "padding:3px 9px;font-size:10.5px;flex-shrink:0;";
          swapBtn.textContent = "Swap";
          swapBtn.onclick = () => {
            if (swapWidgetModelValue(item.node, item.widget, cand.value)) {
              showToast(`LiveDev: Swapped "${item.missingValue}" -> "${cand.value}"`);
              doScan();
            } else {
              showToast("LiveDev: Failed to update widget value");
            }
          };
          row.append(label, swapBtn);
          swapBox.appendChild(row);
        }
        info.appendChild(swapBox);
      }

      const jumpBtn = document.createElement("button");
      jumpBtn.type = "button";
      jumpBtn.className = "ld-btn";
      jumpBtn.style.cssText = "padding:5px 10px;font-size:11.5px;flex-shrink:0;";
      jumpBtn.textContent = "Jump";
      jumpBtn.onclick = () => {
        if (focusNode(item.node)) close();
      };

      card.append(info, jumpBtn);
      listWrap.appendChild(card);
    }
  }

  async function doScan() {
    rescanBtn.disabled = true;
    banner.textContent = "Scanning workflow and server model folders...";
    try {
      lastResult = await runPreflightScan();
      renderList();
    } finally {
      rescanBtn.disabled = false;
    }
  }

  tabAll.onclick = () => { activeTab = "all"; renderList(); };
  tabErr.onclick = () => { activeTab = "error"; renderList(); };
  tabWarn.onclick = () => { activeTab = "warning"; renderList(); };
  rescanBtn.onclick = () => { doScan(); };

  await doScan();
}

app.registerExtension({
  name: "LiveDev.PreflightCheck",
  async setup() {},
});
