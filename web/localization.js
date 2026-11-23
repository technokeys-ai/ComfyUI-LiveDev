import { app } from "../../scripts/app.js";
import { showToast } from "./utils.js";
import { ACCENT, LD_ICONS, createGlassModal } from "./livedev-theme.js";

const TR_MEMORY_KEY = "livedev_tr_memory";
const APPLIED_LEDGER_KEY = "livedev_loc_applied";
const MAX_TR_MEMORY = 600;
const MAX_APPLIED_LEDGER = 1000;

const SKIP_PROP_KEYS = new Set([
  "Node name for S&R",
  "cnr_id",
  "ver",
  "ue_properties",
  "widget_ue_connectable",
]);

const SOURCE_LANGS = [
  ["auto", "Auto detect"],
  ["en", "English (EN)"],
  ["ar", "Arabic (AR)"],
  ["zh-CN", "Chinese (ZH)"],
  ["ru", "Russian (RU)"],
  ["ja", "Japanese (JA)"],
  ["ko", "Korean (KO)"],
  ["fr", "French (FR)"],
  ["de", "German (DE)"],
  ["es", "Spanish (ES)"],
  ["he", "Hebrew (HE)"],
  ["tr", "Turkish (TR)"],
  ["fa", "Persian (FA)"],
];

const TARGET_LANGS = [
  ["en", "English (EN)"],
  ["ar", "Arabic (AR)"],
  ["zh-CN", "Chinese (ZH)"],
  ["ru", "Russian (RU)"],
  ["ja", "Japanese (JA)"],
  ["ko", "Korean (KO)"],
  ["fr", "French (FR)"],
  ["de", "German (DE)"],
  ["es", "Spanish (ES)"],
  ["he", "Hebrew (HE)"],
  ["tr", "Turkish (TR)"],
  ["fa", "Persian (FA)"],
];

function lsGet(key, fallback) {
  try {
    const value = localStorage.getItem("livedev_" + key);
    return value != null ? JSON.parse(value) : fallback;
  } catch (e) {
    return fallback;
  }
}

function lsSet(key, value) {
  try {
    localStorage.setItem("livedev_" + key, JSON.stringify(value));
  } catch (e) {}
}

function loadMap(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    return {};
  }
}

function saveMap(storageKey, mapObj, maxEntries) {
  try {
    const keys = Object.keys(mapObj);
    if (keys.length > maxEntries) {
      const drop = keys.length - maxEntries;
      for (let i = 0; i < drop; i++) delete mapObj[keys[i]];
    }
    localStorage.setItem(storageKey, JSON.stringify(mapObj));
  } catch (e) {}
}

function getCachedTranslation(text, targetLang) {
  const mem = loadMap(TR_MEMORY_KEY);
  return mem[targetLang + "::" + text] || "";
}

function rememberTranslation(text, targetLang, translated) {
  if (!text || !translated) return;
  const mem = loadMap(TR_MEMORY_KEY);
  const k = targetLang + "::" + text;
  // Refresh insertion order for simple LRU trimming
  delete mem[k];
  mem[k] = translated;
  saveMap(TR_MEMORY_KEY, mem, MAX_TR_MEMORY);
}

app.registerExtension({
  name: "LiveDev.Localization",
  async setup() {},
});

function isNonEnglish(text) {
  if (!text || typeof text !== "string") return false;
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u309F\u30A0-\u30FF\u0400-\u04FF\u0500-\u052F\u0590-\u05FF\uAC00-\uD7AF\u0E00-\u0E7F\u10D0-\u10FF]/.test(text);
}

function isFilePath(text) {
  return /\.(png|jpg|jpeg|jfif|gif|bmp|webp|svg|mp3|mp4|wav|flac|ogg|safetensors|bin|pt|pth|ckpt|onnx|gguf|txt|json|yaml|yml|md|csv)$/i.test(text.trim());
}

function isSkippableValue(val) {
  if (!val || typeof val !== "string") return true;
  const trimmed = val.trim();
  if (!trimmed) return true;
  if (
    trimmed === "null" ||
    trimmed === "undefined" ||
    trimmed === "," ||
    trimmed === "true" ||
    trimmed === "false" ||
    trimmed === "[none]" ||
    trimmed === "[false,true]" ||
    !isNaN(Number(trimmed))
  ) {
    return true;
  }
  return isFilePath(trimmed);
}

function normalizeLangCode(code, fallback = "en") {
  if (!code || typeof code !== "string") return fallback;
  const clean = code.trim();
  if (!clean) return fallback;
  if (clean.toLowerCase() === "zh") return "zh-CN";
  return clean;
}

function itemLedgerKey(item) {
  if (item.group) {
    return "g:" + item.groupIndex + ":title";
  }
  const nid = item.node?.id ?? "x";
  const ntype = item.node?.type || "node";
  return "n:" + nid + ":" + ntype + ":" + item.field;
}

function getAppliedRecord(item, graph, ledger) {
  if (item.group) {
    const rec = graph?.extra?._livedev_loc_groups?.[item.groupIndex];
    if (rec && rec.applied === item.text) return rec;
  } else {
    const rec = item.node?.properties?._livedev_loc?.[item.field];
    if (rec && rec.applied === item.text) return rec;
  }
  const ledgerVal = ledger[itemLedgerKey(item)];
  if (ledgerVal && ledgerVal === item.text) {
    return { applied: ledgerVal };
  }
  return null;
}

function recordApplied(item, val, targetLang, graph, ledger) {
  const entry = { orig: item.text, applied: val, target: targetLang, ts: Date.now() };
  if (item.group) {
    if (graph) {
      graph.extra = graph.extra || {};
      graph.extra._livedev_loc_groups = graph.extra._livedev_loc_groups || {};
      graph.extra._livedev_loc_groups[item.groupIndex] = entry;
    }
  } else if (item.node) {
    item.node.properties = item.node.properties || {};
    item.node.properties._livedev_loc = item.node.properties._livedev_loc || {};
    item.node.properties._livedev_loc[item.field] = entry;
  }
  const key = itemLedgerKey(item);
  delete ledger[key];
  ledger[key] = val;
  saveMap(APPLIED_LEDGER_KEY, ledger, MAX_APPLIED_LEDGER);
}

function readWidgetText(node, w, wi) {
  if (w.inputEl && typeof w.inputEl.value === "string") {
    return w.inputEl.value;
  }
  if (w.element) {
    if (w.element.tagName === "TEXTAREA" || w.element.tagName === "INPUT") {
      if (typeof w.element.value === "string") return w.element.value;
    } else if (typeof w.element.querySelector === "function") {
      const nested = w.element.querySelector("textarea, input[type='text'], input:not([type])");
      if (nested && typeof nested.value === "string") return nested.value;
    }
  }
  if (w.value !== undefined && w.value !== null && w.value !== "[none]") {
    if (typeof w.value === "string") return w.value;
    if (typeof w.value === "number" || typeof w.value === "boolean") return "";
    return String(w.value);
  }
  const serVal = Array.isArray(node.widgets_values) && wi < node.widgets_values.length
    ? node.widgets_values[wi]
    : undefined;
  if (typeof serVal === "string") return serVal;
  return "";
}

function writeDomInputValue(el, val) {
  if (!el) return;
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
    el.value = val;
    el.dispatchEvent?.(new Event("input", { bubbles: true }));
    el.dispatchEvent?.(new Event("change", { bubbles: true }));
    return;
  }
  if (typeof el.querySelector === "function") {
    const nested = el.querySelector("textarea, input[type='text'], input:not([type])");
    if (nested) {
      nested.value = val;
      nested.dispatchEvent?.(new Event("input", { bubbles: true }));
      nested.dispatchEvent?.(new Event("change", { bubbles: true }));
    }
  }
}

async function translateViaGoogle(text, source, target) {
  try {
    const sl = source || "auto";
    const res = await fetch(
      "https://translate.googleapis.com/translate_a/single?client=gtx&sl=" +
        encodeURIComponent(sl) +
        "&tl=" +
        encodeURIComponent(target) +
        "&dt=t&q=" +
        encodeURIComponent(text)
    );
    if (!res.ok) return { error: "HTTP " + res.status };
    const data = await res.json();
    const translated = data?.[0]?.filter?.(p => p?.[0])?.map?.(p => p[0])?.join?.("") || "";
    return translated ? { text: translated } : { error: "Empty response" };
  } catch (e) {
    return { error: e.message || "Network error" };
  }
}

function scanGraph(graph, ledger) {
  const nodes = graph._nodes || [];
  const groups = graph._groups || [];
  const pending = [];
  const applied = [];
  const seen = new Set();

  const pushCandidate = (item) => {
    const dedupeKey = itemLedgerKey(item);
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    const rec = getAppliedRecord(item, graph, ledger);
    if (rec) {
      item.applied = true;
      item.appliedRecord = rec;
      applied.push(item);
    } else {
      item.applied = false;
      pending.push(item);
    }
  };

  for (let gi = 0; gi < groups.length; gi++) {
    const grp = groups[gi];
    const gt = grp?.title || "";
    if (gt && isNonEnglish(gt)) {
      pushCandidate({
        group: grp,
        groupIndex: gi,
        field: "group",
        text: gt,
        loc: "Group #" + (gi + 1),
      });
    }
  }

  for (const n of nodes) {
    const nodeLabel = n.title || n.type || ("Node #" + n.id);
    if (n.title && isNonEnglish(n.title)) {
      pushCandidate({ node: n, field: "title", text: n.title, loc: "Title: " + nodeLabel });
    }
    if (Array.isArray(n.inputs)) {
      for (let ii = 0; ii < n.inputs.length; ii++) {
        const inp = n.inputs[ii];
        const lbl = inp?.label || "";
        if (lbl && isNonEnglish(lbl)) {
          pushCandidate({
            node: n,
            field: "inp:" + ii,
            slotIndex: ii,
            text: lbl,
            loc: "Input: " + nodeLabel,
          });
        }
      }
    }
    if (Array.isArray(n.outputs)) {
      for (let oi = 0; oi < n.outputs.length; oi++) {
        const outp = n.outputs[oi];
        const lbl = outp?.label || "";
        if (lbl && isNonEnglish(lbl)) {
          pushCandidate({
            node: n,
            field: "out:" + oi,
            slotIndex: oi,
            text: lbl,
            loc: "Output: " + nodeLabel,
          });
        }
      }
    }
    if (n.properties) {
      for (const [pk, pv] of Object.entries(n.properties)) {
        if (pk.startsWith("_livedev") || SKIP_PROP_KEYS.has(pk)) continue;
        if (typeof pv !== "string" || isSkippableValue(pv)) continue;
        if (isNonEnglish(pv)) {
          pushCandidate({
            node: n,
            field: "prop:" + pk,
            propKey: pk,
            text: pv,
            loc: "Prop (" + pk + "): " + nodeLabel,
          });
        }
      }
    }
    if (!Array.isArray(n.widgets)) continue;
    for (let wi = 0; wi < n.widgets.length; wi++) {
      const w = n.widgets[wi];
      if (!w) continue;
      const actualVal = readWidgetText(n, w, wi);
      if (!isSkippableValue(actualVal) && isNonEnglish(actualVal)) {
        pushCandidate({
          node: n,
          field: "wi:" + wi,
          widgetIndex: wi,
          text: actualVal,
          loc: "Value (" + (w.name || ("#" + wi)) + "): " + nodeLabel,
        });
      }
      const opts = Array.isArray(w.options?.values) ? w.options.values : [];
      for (let oi = 0; oi < opts.length; oi++) {
        const os = typeof opts[oi] === "string" ? opts[oi] : "";
        if (!os || isSkippableValue(os) || !isNonEnglish(os)) continue;
        // Skip duplicating the currently selected value; applying wi:<wi> updates the option too
        if (os === actualVal) continue;
        pushCandidate({
          node: n,
          field: "opt:" + wi + ":" + oi,
          widgetIndex: wi,
          optionIndex: oi,
          text: os,
          loc: "Option (" + (w.name || ("#" + wi)) + "): " + nodeLabel,
        });
      }
    }
  }

  return { pending, applied };
}

function commitGraphChanges(graph, touchedNodes) {
  graph?.afterChange?.();
  graph?.change?.();
  if (touchedNodes) {
    for (const n of touchedNodes) {
      n?.setDirtyCanvas?.(true, true);
    }
  }
  graph?.setDirtyCanvas?.(true, true);
  app.canvas?.setDirty(true, true);
}

export function doLocalizationScan() {
  const c = app.canvas;
  if (!c || !c.graph) return;
  const graph = c.graph;
  const nodes = graph._nodes || [];
  const groups = graph._groups || [];
  if (!nodes.length && !groups.length) {
    showToast("No nodes in graph");
    return;
  }

  const ledger = loadMap(APPLIED_LEDGER_KEY);
  const { pending, applied } = scanGraph(graph, ledger);
  const allItems = [...pending, ...applied];

  if (!allItems.length) {
    showToast("No non-English text found");
    return;
  }

  let sourceLang = "auto";
  let targetLang = normalizeLangCode(lsGet("translateTarget", "en"), "en");
  let showApplied = false;

  const { header, body, close } = createGlassModal({
    title: pending.length
      ? `Localization Scanner (${pending.length} pending)`
      : `Localization Scanner (All ${applied.length} translated)`,
    subtitle: "Smart translation scanner — applied translations are saved on nodes so they are not flagged again.",
    icon: LD_ICONS.globe,
    width: "880px",
    maxHeight: "86vh",
    draggable: true,
  });

  const titleEl = header.querySelector(".ld-modal-title");
  const updateHeaderTitle = () => {
    const rem = allItems.filter(it => !it.applied).length;
    const done = allItems.length - rem;
    if (titleEl) {
      titleEl.textContent = rem
        ? `Localization Scanner (${rem} pending)`
        : `Localization Scanner (All ${done} translated)`;
    }
  };

  // Top Translate bar
  const tBar = document.createElement("div");
  tBar.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap;";

  const fromLbl = document.createElement("span");
  fromLbl.style.cssText = "font-size:11.5px;color:#9aa3b0;font-weight:600;";
  fromLbl.textContent = "From:";

  const srcS = document.createElement("select");
  srcS.className = "ld-select";
  srcS.title = "Source language (Auto detect by default)";
  srcS.style.cssText = "padding:4px 8px;font-size:11.5px;";
  for (const [k, label] of SOURCE_LANGS) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = label;
    if (k === sourceLang) o.selected = true;
    srcS.appendChild(o);
  }
  srcS.onchange = () => {
    sourceLang = srcS.value;
  };

  const toLbl = document.createElement("span");
  toLbl.style.cssText = "font-size:11.5px;color:#9aa3b0;font-weight:600;margin-left:2px;";
  toLbl.textContent = "To:";

  const tgtS = document.createElement("select");
  tgtS.className = "ld-select";
  tgtS.title = "Target language";
  tgtS.style.cssText = "padding:4px 8px;font-size:11.5px;";
  const targetOptions = [...TARGET_LANGS];
  if (!targetOptions.some(([k]) => k === targetLang)) {
    targetOptions.push([targetLang, targetLang.toUpperCase()]);
  }
  for (const [k, label] of targetOptions) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = label;
    if (k === targetLang) o.selected = true;
    tgtS.appendChild(o);
  }

  const autoBtn = document.createElement("button");
  autoBtn.type = "button";
  autoBtn.className = "ld-btn ld-btn-primary";
  autoBtn.style.cssText = "padding:5px 12px;font-size:11.5px;";
  autoBtn.innerHTML = LD_ICONS.globe + "<span>Auto-translate</span>";

  const applyAllBtn = document.createElement("button");
  applyAllBtn.type = "button";
  applyAllBtn.className = "ld-btn";
  applyAllBtn.style.cssText = "padding:5px 12px;font-size:11.5px;";
  applyAllBtn.innerHTML = LD_ICONS.check + "<span>Apply All</span>";

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "ld-btn";
  resetBtn.style.cssText = "padding:5px 12px;font-size:11.5px;";
  resetBtn.innerHTML = LD_ICONS.undo + "<span>Reset Inputs</span>";

  tBar.appendChild(fromLbl);
  tBar.appendChild(srcS);
  tBar.appendChild(toLbl);
  tBar.appendChild(tgtS);
  tBar.appendChild(autoBtn);
  tBar.appendChild(applyAllBtn);
  tBar.appendChild(resetBtn);
  body.appendChild(tBar);

  // Smart status & filter strip
  const statusBar = document.createElement("div");
  statusBar.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;" +
    "padding:6px 10px;border-radius:8px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);flex-wrap:wrap;";

  const statusText = document.createElement("span");
  statusText.style.cssText = "font-size:11.5px;color:#9aa3b0;";

  const statusActions = document.createElement("div");
  statusActions.style.cssText = "display:flex;align-items:center;gap:6px;";

  const toggleAppliedBtn = document.createElement("button");
  toggleAppliedBtn.type = "button";
  toggleAppliedBtn.className = "ld-btn";
  toggleAppliedBtn.style.cssText = "padding:3px 9px;font-size:11px;";

  const clearMemoryBtn = document.createElement("button");
  clearMemoryBtn.type = "button";
  clearMemoryBtn.className = "ld-btn";
  clearMemoryBtn.title = "Clear saved localization markers on this workflow so all non-English text can be scanned again";
  clearMemoryBtn.style.cssText = "padding:3px 9px;font-size:11px;";
  clearMemoryBtn.textContent = "Rescan All";

  statusActions.appendChild(toggleAppliedBtn);
  statusActions.appendChild(clearMemoryBtn);
  statusBar.appendChild(statusText);
  statusBar.appendChild(statusActions);
  body.appendChild(statusBar);

  // Content container (either caught-up banner or table)
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "overflow-y:auto;flex:1;border:1px solid rgba(255,255,255,0.08);border-radius:9px;background:rgba(0,0,0,0.22);";
  body.appendChild(wrap);

  const table = document.createElement("table");
  table.style.cssText = "width:100%;border-collapse:collapse;font-size:12px;";
  table.innerHTML =
    `<thead><tr style="background:rgba(16,18,22,0.95);position:sticky;top:0;z-index:1;">` +
    `<th style="padding:7px 10px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.08);color:#9aa3b0;">#</th>` +
    `<th style="padding:7px 10px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.08);color:#9aa3b0;">Original</th>` +
    `<th style="padding:7px 10px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.08);color:#9aa3b0;">Location</th>` +
    `<th style="padding:7px 10px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.08);color:#9aa3b0;">Replace with</th>` +
    `<th style="padding:7px 10px;text-align:center;border-bottom:1px solid rgba(255,255,255,0.08);color:#9aa3b0;">Copy</th>` +
    `<th style="padding:7px 10px;text-align:center;border-bottom:1px solid rgba(255,255,255,0.08);color:#9aa3b0;">Apply</th>` +
    `</tr></thead>`;
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);

  const caughtUpBox = document.createElement("div");
  caughtUpBox.style.cssText =
    "padding:32px 20px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:10px;";
  const caughtUpTitle = document.createElement("div");
  caughtUpTitle.style.cssText = `font-size:14px;font-weight:700;color:${ACCENT};`;
  caughtUpTitle.textContent = "All localized text is up to date";
  const caughtUpSub = document.createElement("div");
  caughtUpSub.style.cssText = "font-size:12px;color:#9aa3b0;max-width:460px;line-height:1.5;";
  caughtUpSub.textContent =
    "Previously translated nodes and widgets are remembered automatically and will not be flagged again unless their text changes.";
  const reviewBtn = document.createElement("button");
  reviewBtn.type = "button";
  reviewBtn.className = "ld-btn ld-btn-primary";
  reviewBtn.style.cssText = "padding:6px 14px;font-size:12px;margin-top:4px;";
  reviewBtn.textContent = "Show Applied Items";
  caughtUpBox.appendChild(caughtUpTitle);
  caughtUpBox.appendChild(caughtUpSub);
  caughtUpBox.appendChild(reviewBtn);

  // Track active row DOM bindings so Auto-translate and Apply All operate cleanly
  let rowEntries = [];

  function applyItemCore(item, val, tgt) {
    const oldText = item.text;
    if (item.group) {
      item.group.title = val;
    } else if (item.field === "title") {
      item.node.title = val;
    } else if (item.field.startsWith("wi:")) {
      const wi = item.widgetIndex;
      const w = (item.node.widgets || [])[wi];
      if (!w) return false;
      w.value = val;
      writeDomInputValue(w.inputEl, val);
      writeDomInputValue(w.element, val);
      if (Array.isArray(item.node.widgets_values)) {
        if (wi < item.node.widgets_values.length && item.node.widgets_values[wi] === oldText) {
          item.node.widgets_values[wi] = val;
        } else {
          const matchIdx = item.node.widgets_values.indexOf(oldText);
          if (matchIdx !== -1) item.node.widgets_values[matchIdx] = val;
        }
      }
      if (Array.isArray(w.options?.values)) {
        for (let oi = 0; oi < w.options.values.length; oi++) {
          if (w.options.values[oi] === oldText) {
            w.options.values[oi] = val;
            recordApplied(
              { node: item.node, field: "opt:" + wi + ":" + oi, text: oldText },
              val,
              tgt,
              graph,
              ledger
            );
          }
        }
      }
      try {
        w.callback?.(val, app.canvas, item.node, item.node.pos, null);
      } catch (e) {}
      try {
        item.node.onWidgetChanged?.(w.name, val, oldText, w);
      } catch (e) {}
    } else if (item.field.startsWith("opt:")) {
      const w = (item.node.widgets || [])[item.widgetIndex];
      if (!w || !Array.isArray(w.options?.values)) return false;
      w.options.values[item.optionIndex] = val;
      if (w.value === oldText) {
        w.value = val;
        writeDomInputValue(w.inputEl, val);
        writeDomInputValue(w.element, val);
        recordApplied(
          { node: item.node, field: "wi:" + item.widgetIndex, text: oldText },
          val,
          tgt,
          graph,
          ledger
        );
        try {
          w.callback?.(val, app.canvas, item.node, item.node.pos, null);
        } catch (e) {}
      }
    } else if (item.field.startsWith("inp:")) {
      const inp = (item.node.inputs || [])[item.slotIndex];
      if (!inp) return false;
      inp.label = val;
    } else if (item.field.startsWith("out:")) {
      const outp = (item.node.outputs || [])[item.slotIndex];
      if (!outp) return false;
      outp.label = val;
    } else if (item.field.startsWith("prop:")) {
      item.node.properties = item.node.properties || {};
      item.node.properties[item.propKey] = val;
    } else {
      return false;
    }

    rememberTranslation(oldText, tgt, val);
    recordApplied(item, val, tgt, graph, ledger);
    item.text = val;
    item.applied = true;
    item.draft = "";
    return true;
  }

  function applySingleItem(item, val) {
    graph.beforeChange?.();
    const ok = applyItemCore(item, val, tgtS.value);
    if (ok) {
      commitGraphChanges(graph, item.node ? [item.node] : []);
    }
    return ok;
  }

  function updateStatusUi() {
    const rem = allItems.filter(it => !it.applied).length;
    const done = allItems.length - rem;
    statusText.textContent = `${rem} pending \u00b7 ${done} already applied`;
    toggleAppliedBtn.textContent = showApplied
      ? `Hide Applied (${done})`
      : `Show Applied (${done})`;
    toggleAppliedBtn.style.display = done > 0 ? "" : "none";
    clearMemoryBtn.style.display = done > 0 ? "" : "none";
    updateHeaderTitle();
  }

  function renderList() {
    updateStatusUi();
    rowEntries = [];
    tbody.innerHTML = "";
    wrap.innerHTML = "";

    const visible = allItems.filter(it => (showApplied ? true : !it.applied));
    if (!visible.length) {
      const doneCount = allItems.filter(it => it.applied).length;
      reviewBtn.textContent = `Review / Re-translate (${doneCount})`;
      wrap.appendChild(caughtUpBox);
      return;
    }

    visible.forEach((item, idx) => {
      const tr = document.createElement("tr");
      tr.style.cssText =
        "border-bottom:1px solid rgba(255,255,255,0.05);" +
        (item.applied ? "background:rgba(56,192,196,0.05);" : "");

      const nTd = document.createElement("td");
      nTd.style.cssText = "padding:6px 10px;color:#888;";
      nTd.textContent = String(idx + 1);
      tr.appendChild(nTd);

      const oTd = document.createElement("td");
      oTd.style.cssText = "padding:6px 10px;word-break:break-word;max-width:220px;";
      oTd.textContent = item.text;
      tr.appendChild(oTd);

      const lTd = document.createElement("td");
      lTd.style.cssText = "padding:6px 10px;color:#888;font-size:11px;max-width:165px;word-break:break-word;";
      const locSpan = document.createElement("span");
      locSpan.textContent = item.loc;
      lTd.appendChild(locSpan);
      if (item.applied) {
        const badge = document.createElement("span");
        badge.style.cssText =
          `display:inline-block;margin-left:6px;padding:1px 6px;border-radius:999px;font-size:10px;` +
          `background:rgba(56,192,196,0.16);color:${ACCENT};border:1px solid rgba(56,192,196,0.35);`;
        badge.textContent = "Applied";
        lTd.appendChild(badge);
      }
      tr.appendChild(lTd);

      const eTd = document.createElement("td");
      eTd.style.cssText = "padding:6px 10px;";
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "ld-input";
      const cached = !item.applied ? getCachedTranslation(item.text, tgtS.value) : "";
      inp.value = item.draft || cached || "";
      inp.placeholder = cached ? "Cached translation..." : "Translation...";
      inp.style.cssText = "width:100%;padding:4px 8px;font-size:12px;";
      inp.oninput = () => {
        item.draft = inp.value;
      };
      eTd.appendChild(inp);
      tr.appendChild(eTd);

      const cTd = document.createElement("td");
      cTd.style.cssText = "padding:6px 8px;text-align:center;";
      const cBtn = document.createElement("button");
      cBtn.type = "button";
      cBtn.className = "ld-btn";
      cBtn.innerHTML = LD_ICONS.file;
      cBtn.title = "Copy original";
      cBtn.style.cssText = "padding:4px 7px;";
      cBtn.onclick = () => navigator.clipboard.writeText(item.text).then(() => showToast("Copied"));
      cTd.appendChild(cBtn);
      tr.appendChild(cTd);

      const aTd = document.createElement("td");
      aTd.style.cssText = "padding:6px 8px;text-align:center;";
      const aBtn = document.createElement("button");
      aBtn.type = "button";
      aBtn.className = "ld-btn ld-btn-primary";
      aBtn.innerHTML = LD_ICONS.check;
      aBtn.title = "Apply & save";
      aBtn.style.cssText = "padding:4px 7px;";
      aBtn.onclick = () => {
        const v = inp.value.trim();
        if (!v) {
          showToast("Write a replacement first");
          return;
        }
        if (applySingleItem(item, v)) {
          showToast("Applied & saved");
          renderList();
        }
      };
      inp.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          aBtn.click();
        }
      };
      aTd.appendChild(aBtn);
      tr.appendChild(aTd);

      tbody.appendChild(tr);
      rowEntries.push({ item, inp, tr, aBtn });
    });

    wrap.appendChild(table);
  }

  tgtS.onchange = () => {
    targetLang = tgtS.value;
    lsSet("translateTarget", targetLang);
    // Pre-fill any empty pending inputs that already exist in memory for the new target
    for (const entry of rowEntries) {
      if (!entry.item.applied && !entry.inp.value.trim()) {
        const cached = getCachedTranslation(entry.item.text, targetLang);
        if (cached) {
          entry.inp.value = cached;
          entry.item.draft = cached;
        }
      }
    }
  };

  toggleAppliedBtn.onclick = () => {
    showApplied = !showApplied;
    renderList();
  };

  reviewBtn.onclick = () => {
    showApplied = true;
    renderList();
  };

  clearMemoryBtn.onclick = () => {
    for (const n of graph._nodes || []) {
      if (n?.properties?._livedev_loc) delete n.properties._livedev_loc;
    }
    if (graph?.extra?._livedev_loc_groups) {
      delete graph.extra._livedev_loc_groups;
    }
    for (const it of allItems) {
      delete ledger[itemLedgerKey(it)];
      it.applied = false;
      it.appliedRecord = null;
    }
    saveMap(APPLIED_LEDGER_KEY, ledger, MAX_APPLIED_LEDGER);
    showApplied = false;
    renderList();
    showToast("Cleared saved markers — ready to rescan");
  };

  // Auto-translate all empty visible rows (uses local cache first, then Google Translate with sl=auto)
  autoBtn.onclick = async () => {
    const src = srcS.value || "auto";
    const tgt = tgtS.value || "en";
    const targets = rowEntries.filter(e => !e.inp.value.trim());
    if (!targets.length) {
      showToast("All visible fields already have translations");
      return;
    }

    autoBtn.disabled = true;
    let ok = 0;
    let fromCache = 0;
    let err = 0;

    for (let i = 0; i < targets.length; i++) {
      const { item, inp } = targets[i];
      autoBtn.textContent = `Translating ${i + 1}/${targets.length}...`;

      const cached = getCachedTranslation(item.text, tgt);
      if (cached) {
        inp.value = cached;
        item.draft = cached;
        ok++;
        fromCache++;
        continue;
      }

      const result = await translateViaGoogle(item.text, src, tgt);
      if (result.text) {
        inp.value = result.text;
        item.draft = result.text;
        rememberTranslation(item.text, tgt, result.text);
        ok++;
      } else {
        err++;
      }
    }

    autoBtn.disabled = false;
    autoBtn.innerHTML = LD_ICONS.globe + "<span>Auto-translate</span>";
    let msg = ok
      ? `Translated ${ok}${fromCache ? ` (${fromCache} cached)` : ""}`
      : "0 translated";
    if (err) msg += `, ${err} failed`;
    showToast(msg);
  };

  // Apply all filled visible rows atomically
  applyAllBtn.onclick = () => {
    const toApply = rowEntries
      .map(e => ({ item: e.item, val: e.inp.value.trim() }))
      .filter(x => x.val.length > 0);
    if (!toApply.length) {
      showToast("No translations to apply");
      return;
    }

    const tgt = tgtS.value || "en";
    const touchedNodes = new Set();
    let count = 0;

    graph.beforeChange?.();
    for (const { item, val } of toApply) {
      if (applyItemCore(item, val, tgt)) {
        if (item.node) touchedNodes.add(item.node);
        count++;
      }
    }
    commitGraphChanges(graph, touchedNodes);

    const remaining = allItems.filter(it => !it.applied).length;
    showToast("Applied & saved " + count + " change" + (count !== 1 ? "s" : ""));
    if (remaining === 0 && !showApplied) {
      close();
    } else {
      renderList();
    }
  };

  // Reset unsaved input boxes
  resetBtn.onclick = () => {
    for (const entry of rowEntries) {
      entry.inp.value = "";
      entry.item.draft = "";
    }
    showToast("Cleared input fields");
  };

  renderList();
}
