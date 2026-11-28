// Smart Console Noise & Log Filter for ComfyUI-LiveDev.
//
// Unifies BOTH Python server logs (custom_nodes, ComfyUI Core, site-packages libraries) AND
// browser DevTools console logs (JS extensions & ComfyUI Frontend deprecation warnings) inside one
// glassmorphic collapsible-accordion manager. Rules persist in config.json and mirror into
// localStorage so noisy browser startup warnings can be silenced from millisecond zero on reload.

import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import { showToast } from "./utils.js";
import {
  ACCENT,
  DANGER,
  DANGER_DIM,
  FONT_MONO,
  LD_ICONS,
  createGlassModal,
  svgIcon,
} from "./livedev-theme.js";

const FILTER_CACHE_KEY = "livedev_console_filter_cache";
const MAX_BROWSER_SAMPLES = 25;

const FILTER_ICON = svgIcon(
  '<polygon points="3 5 21 5 14 13 14 19 10 21 10 13 3 5"/>'
);

const KIND_LABELS = {
  custom_node: "Custom Node",
  core: "ComfyUI Core",
  library: "Python Library",
  browser_ext: "Browser Extension",
  browser_core: "Browser Frontend",
  tag: "Log Tag",
  rule: "Saved Rule",
  system: "System",
};

// ----------------------------------------------------------------------------
// Early Browser Console Interceptor (catches frontend warnings from F5 onward)
// ----------------------------------------------------------------------------

function loadCachedConfig() {
  try {
    const raw = localStorage.getItem(FILTER_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") {
      return {
        sources: parsed.sources && typeof parsed.sources === "object" ? parsed.sources : {},
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
        scope: parsed.scope || "both",
        keep_errors: parsed.keep_errors !== false,
      };
    }
  } catch (e) {}
  return { sources: {}, keywords: [], scope: "both", keep_errors: true };
}

function cacheConfigLocally(cfg) {
  if (!cfg || typeof cfg !== "object") return;
  _activeConfig = {
    sources: cfg.sources && typeof cfg.sources === "object" ? { ...cfg.sources } : {},
    keywords: Array.isArray(cfg.keywords) ? [...cfg.keywords] : [],
    scope: cfg.scope || "both",
    keep_errors: cfg.keep_errors !== false,
  };
  try {
    localStorage.setItem(FILTER_CACHE_KEY, JSON.stringify(_activeConfig));
  } catch (e) {}
}

let _activeConfig = loadCachedConfig();
const _browserStats = new Map();
let _browserTotalLines = 0;
let _browserTotalMuted = 0;
let _browserHookInstalled = false;
let _browserHookBusy = false;

function isPlainObject(val) {
  if (!val || typeof val !== "object") return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

// Safely stringify console arguments without EVER invoking `.toJSON()` or getters on live
// class instances (e.g. LiteGraph LGraph/Subgraph/LGraphNode). Calling `JSON.stringify(obj)`
// on a Subgraph triggers `Subgraph.toJSON()` -> `serialize()` -> `asSerialisable()`, which
// mutates ComfyUI's `graphMetadata` store and corrupts subgraph IDs across tab switches.
function safeFormatArg(a, depth = 0) {
  if (a === null) return "null";
  if (a === undefined) return "undefined";
  const t = typeof a;
  if (t === "string") return a;
  if (t === "number" || t === "boolean" || t === "bigint" || t === "symbol") return String(a);
  if (t === "function") return `[Function ${a.name || "anonymous"}]`;
  if (a instanceof Error) return a.message || String(a);
  if (typeof Node !== "undefined" && a instanceof Node) {
    return `[${a.nodeName || "DOMNode"}]`;
  }
  if (depth >= 2) {
    return Array.isArray(a) ? `[Array(${a.length})]` : `[${a.constructor?.name || "Object"}]`;
  }
  if (Array.isArray(a)) {
    const items = [];
    const cap = Math.min(a.length, 8);
    for (let i = 0; i < cap; i++) items.push(safeFormatArg(a[i], depth + 1));
    if (a.length > cap) items.push(`+${a.length - cap}`);
    return `[${items.join(", ")}]`;
  }
  if (!isPlainObject(a) || typeof a.toJSON === "function") {
    const ctor = a.constructor?.name || "Object";
    return `[${ctor}]`;
  }
  const keys = Object.keys(a);
  const out = [];
  const cap = Math.min(keys.length, 10);
  for (let i = 0; i < cap; i++) {
    const k = keys[i];
    try {
      const desc = Object.getOwnPropertyDescriptor(a, k);
      if (desc && typeof desc.get === "function") {
        out.push(`${k}:[Getter]`);
      } else {
        out.push(`${k}:${safeFormatArg(a[k], depth + 1)}`);
      }
    } catch {
      out.push(`${k}:[?]`);
    }
  }
  if (keys.length > cap) out.push(`+${keys.length - cap}`);
  return `{${out.join(", ")}}`;
}

function formatConsoleArgs(args) {
  const parts = [];
  for (let i = 0; i < args.length; i++) {
    try {
      parts.push(safeFormatArg(args[i], 0));
    } catch {
      parts.push("[Object]");
    }
  }
  return parts.join(" ").replace(/%[csdifoO]/g, "").trim();
}

function classifyBrowserStack(stackStr, text) {
  const lines = String(stackStr || "").split("\n");
  for (let i = 1; i < lines.length && i < 14; i++) {
    const ln = lines[i];
    if (!ln || ln.includes("console-filter.js")) continue;
    const extMatch = ln.match(/\/extensions\/([^/?#]+)\//i);
    if (extMatch && extMatch[1]) {
      return { name: "JS: " + decodeURIComponent(extMatch[1]), kind: "browser_ext" };
    }
    if (ln.includes("/assets/") || ln.includes("/scripts/") || ln.includes("comfyui_frontend")) {
      return { name: "JS: ComfyUI Frontend", kind: "browser_core" };
    }
  }
  if (/DEPRECATION WARNING|legacy API/i.test(text)) {
    return { name: "JS: ComfyUI Frontend", kind: "browser_core" };
  }
  return { name: "JS: Browser", kind: "browser_core" };
}

function shouldMuteBrowser(sourceName, text, level) {
  const cfg = _activeConfig;
  if (!cfg || cfg.scope === "terminal") return false;
  const mode = cfg.sources?.[sourceName] || "allow";
  const isError = level === "error";

  if (mode === "mute_all") return true;
  if (mode === "mute_info") return !isError;

  const kws = cfg.keywords || [];
  if (kws.length) {
    const low = text.toLowerCase();
    for (let i = 0; i < kws.length; i++) {
      if (low.includes(String(kws[i]).toLowerCase())) {
        if (cfg.keep_errors && isError) return false;
        return true;
      }
    }
  }
  return false;
}

function recordBrowserSample(sourceName, kind, text, wasMuted) {
  if (!text) return;
  const snippet = text.length > 260 ? text.slice(0, 257) + "..." : text;
  const nowSec = Date.now() / 1000;
  _browserTotalLines++;
  if (wasMuted) _browserTotalMuted++;

  let st = _browserStats.get(sourceName);
  if (!st) {
    st = {
      name: sourceName,
      kind,
      lines: 0,
      muted: 0,
      last_seen: nowSec,
      samples: [],
    };
    _browserStats.set(sourceName, st);
  }
  st.lines++;
  if (wasMuted) st.muted++;
  st.last_seen = nowSec;
  st.samples.push({ text: snippet, muted: wasMuted, ts: nowSec });
  if (st.samples.length > MAX_BROWSER_SAMPLES) {
    st.samples.shift();
  }
}

function installBrowserConsoleHook() {
  if (_browserHookInstalled || typeof console === "undefined") return;
  _browserHookInstalled = true;

  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const orig = console[level];
    if (typeof orig !== "function") continue;
    console[level] = function (...args) {
      if (_browserHookBusy) {
        return orig.apply(console, args);
      }
      _browserHookBusy = true;
      try {
        const text = formatConsoleArgs(args);
        if (text) {
          const stack = new Error().stack || "";
          const { name, kind } = classifyBrowserStack(stack, text);
          const muted = shouldMuteBrowser(name, text, level);
          recordBrowserSample(name, kind, text, muted);
          if (muted) return;
        }
      } catch (e) {
        // Never break native browser logging
      } finally {
        _browserHookBusy = false;
      }
      return orig.apply(console, args);
    };
  }
}

installBrowserConsoleHook();

// ----------------------------------------------------------------------------
// Helpers for modal UI
// ----------------------------------------------------------------------------

function formatTimeShort(ts) {
  if (!ts) return "Not printed yet";
  try {
    return new Date(ts * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch (e) {
    return "";
  }
}

function deriveQuickKeyword(lineText) {
  const clean = String(lineText || "")
    .replace(/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*/, "")
    .trim();
  return clean.length > 72 ? clean.slice(0, 72).trim() : clean;
}

export async function openConsoleFilterModal() {
  const { body, close } = createGlassModal({
    title: "Console Noise & Log Filter",
    subtitle: "Inspect Python custom nodes, site-packages libraries, and browser JS extensions writing to the console.",
    icon: FILTER_ICON,
    width: "860px",
    maxHeight: "86vh",
    draggable: true,
  });

  let serverSnapshot = {
    config: _activeConfig,
    sources: [],
    total_lines: 0,
    total_muted: 0,
  };
  let activeTab = "all"; // 'all' | 'custom_nodes' | 'libraries' | 'muted' | 'keywords'
  let searchQuery = "";
  const expandedCards = new Set();

  async function fetchSnapshot() {
    try {
      const res = await api.fetchApi("/livedev/console_filter");
      const data = await res.json();
      if (data && data.ok) {
        serverSnapshot = data;
        cacheConfigLocally(data.config);
      }
    } catch (e) {
      showToast("Failed to load console filter state");
    }
  }

  async function savePatch(patch, toastMsg = "") {
    try {
      const res = await api.fetchApi("/livedev/console_filter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (data && data.ok) {
        serverSnapshot = data;
        cacheConfigLocally(data.config);
        render();
        if (toastMsg) showToast(toastMsg);
      }
    } catch (e) {
      showToast("Failed to save console filter");
    }
  }

  function getMergedSources() {
    const cfgSources = serverSnapshot.config?.sources || {};
    const merged = new Map();

    for (const s of serverSnapshot.sources || []) {
      merged.set(s.name, { ...s, mode: cfgSources[s.name] || s.mode || "allow" });
    }
    for (const [name, bs] of _browserStats.entries()) {
      const existing = merged.get(name);
      if (existing) {
        existing.lines += bs.lines;
        existing.muted += bs.muted;
        existing.last_seen = Math.max(existing.last_seen || 0, bs.last_seen || 0);
        existing.samples = [...(existing.samples || []), ...bs.samples].slice(-MAX_BROWSER_SAMPLES);
      } else {
        merged.set(name, {
          name: bs.name,
          kind: bs.kind,
          lines: bs.lines,
          muted: bs.muted,
          last_seen: bs.last_seen,
          mode: cfgSources[name] || "allow",
          samples: [...bs.samples],
        });
      }
    }

    const list = Array.from(merged.values());
    list.sort((a, b) => {
      const am = a.mode !== "allow" ? 0 : 1;
      const bm = b.mode !== "allow" ? 0 : 1;
      if (am !== bm) return am - bm;
      if (b.lines !== a.lines) return b.lines - a.lines;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    return list;
  }

  // Top controls strip
  const topBar = document.createElement("div");
  topBar.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;" +
    "padding:8px 10px;margin-bottom:10px;border-radius:10px;" +
    "background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);";

  const leftCtrls = document.createElement("div");
  leftCtrls.style.cssText = "display:flex;align-items:center;gap:10px;flex-wrap:wrap;";

  const scopeLbl = document.createElement("span");
  scopeLbl.style.cssText = "font-size:11.5px;color:#9aa3b0;font-weight:600;";
  scopeLbl.textContent = "Silence in:";

  const scopeSel = document.createElement("select");
  scopeSel.className = "ld-select";
  scopeSel.style.cssText = "padding:4px 8px;font-size:11.5px;";
  for (const [val, txt] of [
    ["both", "Terminal + Browser & Live Console"],
    ["browser", "Browser & Live Console Only"],
    ["terminal", "Server Terminal Only"],
  ]) {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = txt;
    scopeSel.appendChild(o);
  }
  scopeSel.onchange = () => savePatch({ scope: scopeSel.value }, "Updated silence scope");

  const keepErrWrap = document.createElement("label");
  keepErrWrap.style.cssText =
    "display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:#c8cfd8;cursor:pointer;";
  const keepErrChk = document.createElement("input");
  keepErrChk.type = "checkbox";
  keepErrChk.style.cssText = `width:14px;height:14px;accent-color:${ACCENT};cursor:pointer;`;
  keepErrChk.onchange = () =>
    savePatch(
      { keep_errors: keepErrChk.checked },
      keepErrChk.checked ? "Tracebacks preserved" : "Errors also filtered by keywords"
    );
  const keepErrTxt = document.createElement("span");
  keepErrTxt.textContent = "Keep Errors on Keyword Mute";
  keepErrWrap.appendChild(keepErrChk);
  keepErrWrap.appendChild(keepErrTxt);

  leftCtrls.appendChild(scopeLbl);
  leftCtrls.appendChild(scopeSel);
  leftCtrls.appendChild(keepErrWrap);

  const rightCtrls = document.createElement("div");
  rightCtrls.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;";

  const expandAllBtn = document.createElement("button");
  expandAllBtn.type = "button";
  expandAllBtn.className = "ld-btn";
  expandAllBtn.style.cssText = "padding:4px 9px;font-size:11.5px;";
  expandAllBtn.textContent = "Expand All";
  expandAllBtn.onclick = () => {
    const visible = getFilteredSources();
    const allOpen = visible.length > 0 && visible.every((s) => expandedCards.has(s.name));
    if (allOpen) {
      expandedCards.clear();
    } else {
      for (const s of visible) expandedCards.add(s.name);
    }
    renderList();
  };

  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "ld-btn";
  refreshBtn.style.cssText = "padding:4px 9px;font-size:11.5px;";
  refreshBtn.innerHTML = LD_ICONS.refresh + "<span>Refresh</span>";
  refreshBtn.onclick = async () => {
    await fetchSnapshot();
    render();
    showToast("Refreshed console writers");
  };

  const resetStatsBtn = document.createElement("button");
  resetStatsBtn.type = "button";
  resetStatsBtn.className = "ld-btn";
  resetStatsBtn.style.cssText = "padding:4px 9px;font-size:11.5px;";
  resetStatsBtn.textContent = "Reset Counters";
  resetStatsBtn.onclick = async () => {
    _browserStats.clear();
    _browserTotalLines = 0;
    _browserTotalMuted = 0;
    expandedCards.clear();
    try {
      const res = await api.fetchApi("/livedev/console_filter/reset_stats", { method: "POST" });
      const data = await res.json();
      if (data && data.ok) {
        serverSnapshot = data;
      }
    } catch (e) {}
    render();
    showToast("Console counters cleared");
  };

  rightCtrls.appendChild(expandAllBtn);
  rightCtrls.appendChild(refreshBtn);
  rightCtrls.appendChild(resetStatsBtn);
  topBar.appendChild(leftCtrls);
  topBar.appendChild(rightCtrls);
  body.appendChild(topBar);

  // Tabs + Search row
  const navRow = document.createElement("div");
  navRow.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:10px;";

  const tabsWrap = document.createElement("div");
  tabsWrap.style.cssText = "display:flex;align-items:center;gap:5px;flex-wrap:wrap;";

  const tabAllBtn = document.createElement("button");
  tabAllBtn.type = "button";
  tabAllBtn.className = "ld-btn";
  tabAllBtn.style.cssText = "padding:4px 10px;font-size:11.5px;";
  tabAllBtn.onclick = () => { activeTab = "all"; render(); };

  const tabNodesBtn = document.createElement("button");
  tabNodesBtn.type = "button";
  tabNodesBtn.className = "ld-btn";
  tabNodesBtn.style.cssText = "padding:4px 10px;font-size:11.5px;";
  tabNodesBtn.onclick = () => { activeTab = "custom_nodes"; render(); };

  const tabLibsBtn = document.createElement("button");
  tabLibsBtn.type = "button";
  tabLibsBtn.className = "ld-btn";
  tabLibsBtn.style.cssText = "padding:4px 10px;font-size:11.5px;";
  tabLibsBtn.onclick = () => { activeTab = "libraries"; render(); };

  const tabMutedBtn = document.createElement("button");
  tabMutedBtn.type = "button";
  tabMutedBtn.className = "ld-btn";
  tabMutedBtn.style.cssText = "padding:4px 10px;font-size:11.5px;";
  tabMutedBtn.onclick = () => { activeTab = "muted"; render(); };

  const tabKwBtn = document.createElement("button");
  tabKwBtn.type = "button";
  tabKwBtn.className = "ld-btn";
  tabKwBtn.style.cssText = "padding:4px 10px;font-size:11.5px;";
  tabKwBtn.onclick = () => { activeTab = "keywords"; render(); };

  tabsWrap.appendChild(tabAllBtn);
  tabsWrap.appendChild(tabNodesBtn);
  tabsWrap.appendChild(tabLibsBtn);
  tabsWrap.appendChild(tabMutedBtn);
  tabsWrap.appendChild(tabKwBtn);

  const searchInp = document.createElement("input");
  searchInp.type = "text";
  searchInp.className = "ld-input";
  searchInp.placeholder = "Search projects, libraries, or JS...";
  searchInp.style.cssText = "min-width:200px;flex:1;max-width:250px;padding:5px 10px;font-size:12px;";
  searchInp.oninput = () => {
    searchQuery = searchInp.value.trim().toLowerCase();
    renderList();
  };

  navRow.appendChild(tabsWrap);
  navRow.appendChild(searchInp);
  body.appendChild(navRow);

  // Main scrollable accordion list
  const listWrap = document.createElement("div");
  listWrap.style.cssText =
    "overflow-y:auto;flex:1;min-height:240px;max-height:48vh;padding:8px;" +
    "border:1px solid rgba(255,255,255,0.08);border-radius:10px;background:rgba(0,0,0,0.22);";
  body.appendChild(listWrap);

  // Manual mute bar
  const addRow = document.createElement("div");
  addRow.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap;";

  const packListId = "livedev-cf-packs-" + Date.now();
  const dataList = document.createElement("datalist");
  dataList.id = packListId;
  body.appendChild(dataList);

  const manualInp = document.createElement("input");
  manualInp.type = "text";
  manualInp.className = "ld-input";
  manualInp.setAttribute("list", packListId);
  manualInp.placeholder = "Mute a custom_node, Lib: <pkg>, or JS: <ext> by name...";
  manualInp.style.cssText = "flex:1;min-width:220px;padding:6px 10px;font-size:12px;";

  const manualModeSel = document.createElement("select");
  manualModeSel.className = "ld-select";
  manualModeSel.style.cssText = "padding:6px 8px;font-size:11.5px;";
  for (const [val, txt] of [
    ["mute_info", "Mute Info (Keep Errors)"],
    ["mute_all", "Mute All"],
  ]) {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = txt;
    manualModeSel.appendChild(o);
  }

  const manualAddBtn = document.createElement("button");
  manualAddBtn.type = "button";
  manualAddBtn.className = "ld-btn ld-btn-primary";
  manualAddBtn.style.cssText = "padding:6px 12px;font-size:12px;";
  manualAddBtn.textContent = "+ Add Rule";
  manualAddBtn.onclick = () => {
    const target = manualInp.value.trim();
    if (!target) {
      showToast("Enter a project or library name first");
      return;
    }
    manualInp.value = "";
    savePatch({ sources: { [target]: manualModeSel.value } }, "Added console rule for " + target);
  };
  manualInp.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      manualAddBtn.click();
    }
  };

  addRow.appendChild(manualInp);
  addRow.appendChild(manualModeSel);
  addRow.appendChild(manualAddBtn);
  body.appendChild(addRow);

  // Footer
  const foot = document.createElement("div");
  foot.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px;flex-wrap:wrap;";

  const summaryEl = document.createElement("span");
  summaryEl.style.cssText = "font-size:11.5px;color:#888;";

  const footBtns = document.createElement("div");
  footBtns.style.cssText = "display:flex;align-items:center;gap:8px;";

  const unmuteAllBtn = document.createElement("button");
  unmuteAllBtn.type = "button";
  unmuteAllBtn.className = "ld-btn ld-btn-danger";
  unmuteAllBtn.style.cssText = "padding:5px 12px;font-size:11.5px;";
  unmuteAllBtn.textContent = "Unmute All";
  unmuteAllBtn.onclick = () => {
    savePatch({ replace_sources: {}, keywords: [] }, "Unmuted all console sources");
  };

  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.className = "ld-btn ld-btn-primary";
  doneBtn.style.cssText = "padding:5px 14px;font-size:12px;";
  doneBtn.textContent = "Done";
  doneBtn.onclick = close;

  footBtns.appendChild(unmuteAllBtn);
  footBtns.appendChild(doneBtn);
  foot.appendChild(summaryEl);
  foot.appendChild(footBtns);
  body.appendChild(foot);

  function getFilteredSources() {
    return getMergedSources().filter((r) => {
      if (activeTab === "custom_nodes" && r.kind !== "custom_node" && r.kind !== "browser_ext") return false;
      if (activeTab === "libraries" && r.kind !== "library" && r.kind !== "browser_core" && r.kind !== "core") return false;
      if (activeTab === "muted" && r.mode === "allow") return false;
      if (searchQuery && !r.name.toLowerCase().includes(searchQuery)) return false;
      return true;
    });
  }

  function renderKeywordsTab() {
    listWrap.innerHTML = "";
    const kws = serverSnapshot.config?.keywords || [];

    const kwAddRow = document.createElement("div");
    kwAddRow.style.cssText = "display:flex;gap:8px;margin-bottom:12px;";
    const kwInp = document.createElement("input");
    kwInp.type = "text";
    kwInp.className = "ld-input";
    kwInp.placeholder = "Enter noisy text to mute (e.g. DEPRECATION WARNING, Discovered 1 local GGUF)...";
    kwInp.style.cssText = "flex:1;padding:6px 10px;font-size:12px;";
    const kwAddBtn = document.createElement("button");
    kwAddBtn.type = "button";
    kwAddBtn.className = "ld-btn ld-btn-primary";
    kwAddBtn.style.cssText = "padding:6px 12px;font-size:12px;";
    kwAddBtn.textContent = "+ Mute Keyword";
    kwAddBtn.onclick = () => {
      const val = kwInp.value.trim();
      if (!val) {
        showToast("Enter text to mute first");
        return;
      }
      savePatch({ keywords: [...kws, val] }, "Muted keyword: " + val);
    };
    kwInp.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        kwAddBtn.click();
      }
    };
    kwAddRow.appendChild(kwInp);
    kwAddRow.appendChild(kwAddBtn);
    listWrap.appendChild(kwAddRow);

    if (!kws.length) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding:26px;text-align:center;color:#888;font-size:12px;";
      empty.textContent =
        "No keyword rules yet. Add any repeating phrase (like DEPRECATION WARNING) or click Mute Line inside an expanded card.";
      listWrap.appendChild(empty);
      return;
    }

    for (const kw of kws) {
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;align-items:center;justify-content:space-between;gap:10px;" +
        "padding:8px 10px;margin-bottom:6px;border-radius:8px;" +
        "background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);";

      const txt = document.createElement("span");
      txt.style.cssText = `font-family:${FONT_MONO};font-size:12px;color:#e6e9ef;word-break:break-word;`;
      txt.textContent = kw;

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "ld-btn ld-btn-danger";
      delBtn.style.cssText = "padding:3px 9px;font-size:11px;";
      delBtn.textContent = "Remove";
      delBtn.onclick = () => {
        savePatch({ keywords: kws.filter((k) => k !== kw) }, "Removed keyword rule");
      };

      row.appendChild(txt);
      row.appendChild(delBtn);
      listWrap.appendChild(row);
    }
  }

  function renderList() {
    if (activeTab === "keywords") {
      addRow.style.display = "none";
      searchInp.style.display = "none";
      expandAllBtn.style.display = "none";
      renderKeywordsTab();
      return;
    }
    addRow.style.display = "flex";
    searchInp.style.display = "";
    expandAllBtn.style.display = "";
    listWrap.innerHTML = "";

    const rows = getFilteredSources();
    const allOpen = rows.length > 0 && rows.every((s) => expandedCards.has(s.name));
    expandAllBtn.textContent = allOpen ? "Collapse All" : "Expand All";

    if (!rows.length) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding:32px 16px;text-align:center;color:#888;font-size:12px;";
      empty.textContent =
        activeTab === "muted"
          ? "No sources are muted yet."
          : "No matching console writers recorded yet. Run a workflow or add a name below.";
      listWrap.appendChild(empty);
      return;
    }

    const currentKeywords = serverSnapshot.config?.keywords || [];

    for (const src of rows) {
      const isMuted = src.mode !== "allow";
      const isExp = expandedCards.has(src.name);
      const samples = src.samples || [];

      const card = document.createElement("div");
      card.style.cssText =
        "display:block;padding:10px 12px;margin-bottom:8px;border-radius:10px;" +
        `background:${isMuted ? "rgba(56,192,196,0.06)" : "rgba(255,255,255,0.03)"};` +
        `border:1px solid ${isMuted ? "rgba(56,192,196,0.28)" : "rgba(255,255,255,0.07)"};`;

      const top = document.createElement("div");
      top.style.cssText =
        "display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;";

      const info = document.createElement("div");
      info.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;";

      const nameEl = document.createElement("span");
      nameEl.style.cssText = "font-size:12.5px;font-weight:700;color:#e6e9ef;word-break:break-word;";
      nameEl.textContent = src.name;

      const kindBadge = document.createElement("span");
      kindBadge.style.cssText =
        "font-size:10px;padding:1px 7px;border-radius:999px;" +
        `background:${src.kind === "library" || src.kind === "browser_core" ? "rgba(56,192,196,0.12)" : "rgba(255,255,255,0.06)"};` +
        `color:${src.kind === "library" || src.kind === "browser_core" ? ACCENT : "#9aa3b0"};` +
        "border:1px solid rgba(255,255,255,0.09);";
      kindBadge.textContent = KIND_LABELS[src.kind] || src.kind || "Source";

      const statsBadge = document.createElement("span");
      statsBadge.style.cssText = `font-family:${FONT_MONO};font-size:11px;color:#888;`;
      statsBadge.textContent =
        src.lines + " lines" + (src.muted ? " \u00b7 " + src.muted + " muted" : "");

      info.appendChild(nameEl);
      info.appendChild(kindBadge);
      info.appendChild(statsBadge);

      const controls = document.createElement("div");
      controls.style.cssText = "display:flex;align-items:center;gap:5px;flex-wrap:wrap;";

      const previewBtn = document.createElement("button");
      previewBtn.type = "button";
      previewBtn.className = "ld-btn";
      previewBtn.style.cssText = "padding:3px 8px;font-size:11px;";
      previewBtn.textContent = isExp ? "Hide Logs" : `Logs (${samples.length})`;
      previewBtn.disabled = !samples.length;
      previewBtn.onclick = () => {
        if (expandedCards.has(src.name)) expandedCards.delete(src.name);
        else expandedCards.add(src.name);
        renderList();
      };
      controls.appendChild(previewBtn);

      // 3-state segmented control: Allow | Mute Info | Mute All
      const seg = document.createElement("div");
      seg.style.cssText =
        "display:inline-flex;border-radius:7px;overflow:hidden;border:1px solid rgba(255,255,255,0.12);";

      for (const [mVal, mLabel] of [
        ["allow", "Allow"],
        ["mute_info", "Mute Info"],
        ["mute_all", "Mute All"],
      ]) {
        const mb = document.createElement("button");
        mb.type = "button";
        const active = src.mode === mVal;
        let bg = "rgba(255,255,255,0.03)";
        let fg = "#9aa3b0";
        if (active && mVal === "allow") {
          bg = "rgba(255,255,255,0.14)";
          fg = "#ffffff";
        } else if (active && mVal === "mute_info") {
          bg = "rgba(56,192,196,0.22)";
          fg = ACCENT;
        } else if (active && mVal === "mute_all") {
          bg = "rgba(229,115,115,0.22)";
          fg = DANGER;
        }
        mb.style.cssText =
          `border:none;cursor:pointer;padding:4px 9px;font-size:11px;font-weight:600;` +
          `background:${bg};color:${fg};border-right:1px solid rgba(255,255,255,0.08);`;
        mb.textContent = mLabel;
        mb.onclick = () => {
          if (src.mode === mVal) return;
          savePatch({ sources: { [src.name]: mVal } }, `${src.name}: ${mLabel}`);
        };
        seg.appendChild(mb);
      }

      controls.appendChild(seg);
      top.appendChild(info);
      top.appendChild(controls);
      card.appendChild(top);

      // Latest line snippet when collapsed
      const lastSample = samples.length ? samples[samples.length - 1] : null;
      if (lastSample && !isExp) {
        const snip = document.createElement("div");
        snip.style.cssText =
          `margin-top:6px;font-family:${FONT_MONO};font-size:11px;color:#8a92a0;` +
          "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
        snip.textContent = `[${formatTimeShort(lastSample.ts)}] ${lastSample.text}`;
        card.appendChild(snip);
      }

      // Expanded recent logs drawer with 1-click Mute Line
      if (isExp && samples.length) {
        const drawer = document.createElement("div");
        drawer.style.cssText =
          "margin-top:8px;padding:8px 10px;border-radius:8px;background:rgba(10,12,16,0.85);" +
          `border:1px solid rgba(255,255,255,0.08);font-family:${FONT_MONO};font-size:11px;` +
          "max-height:190px;overflow-y:auto;line-height:1.45;";

        for (const smp of samples) {
          const lRow = document.createElement("div");
          lRow.style.cssText =
            "display:flex;align-items:flex-start;justify-content:space-between;gap:8px;" +
            "padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.04);";

          const lTxt = document.createElement("span");
          lTxt.style.cssText =
            `word-break:break-word;flex:1;color:${smp.muted ? DANGER_DIM : "#c8cfd8"};`;
          lTxt.textContent =
            `[${formatTimeShort(smp.ts)}]${smp.muted ? " [MUTED]" : ""} ${smp.text}`;

          const muteLineBtn = document.createElement("button");
          muteLineBtn.type = "button";
          muteLineBtn.className = "ld-btn";
          muteLineBtn.title = "Add this phrase to Keyword Mute rules";
          muteLineBtn.style.cssText = "padding:1px 7px;font-size:10px;flex-shrink:0;";
          muteLineBtn.textContent = "Mute Line";
          muteLineBtn.onclick = () => {
            const phrase = deriveQuickKeyword(smp.text);
            if (!phrase) return;
            savePatch(
              { keywords: [...currentKeywords, phrase] },
              "Muted phrase: " + phrase.slice(0, 42)
            );
          };

          lRow.appendChild(lTxt);
          lRow.appendChild(muteLineBtn);
          drawer.appendChild(lRow);
        }

        card.appendChild(drawer);
      }

      listWrap.appendChild(card);
    }
  }

  function render() {
    const cfg = serverSnapshot.config || {};
    scopeSel.value = cfg.scope || "both";
    keepErrChk.checked = cfg.keep_errors !== false;

    const all = getMergedSources();
    const allCount = all.length;
    const nodesCount = all.filter((s) => s.kind === "custom_node" || s.kind === "browser_ext").length;
    const libsCount = all.filter((s) => s.kind === "library" || s.kind === "browser_core" || s.kind === "core").length;
    const mutedCount = all.filter((s) => s.mode !== "allow").length;
    const kwCount = (cfg.keywords || []).length;

    tabAllBtn.textContent = `All (${allCount})`;
    tabNodesBtn.textContent = `Nodes (${nodesCount})`;
    tabLibsBtn.textContent = `Libraries & JS (${libsCount})`;
    tabMutedBtn.textContent = `Muted (${mutedCount})`;
    tabKwBtn.textContent = `Keywords (${kwCount})`;

    tabAllBtn.className = activeTab === "all" ? "ld-btn ld-btn-primary" : "ld-btn";
    tabNodesBtn.className = activeTab === "custom_nodes" ? "ld-btn ld-btn-primary" : "ld-btn";
    tabLibsBtn.className = activeTab === "libraries" ? "ld-btn ld-btn-primary" : "ld-btn";
    tabMutedBtn.className = activeTab === "muted" ? "ld-btn ld-btn-primary" : "ld-btn";
    tabKwBtn.className = activeTab === "keywords" ? "ld-btn ld-btn-primary" : "ld-btn";

    const totalLines = (serverSnapshot.total_lines || 0) + _browserTotalLines;
    const totalMuted = (serverSnapshot.total_muted || 0) + _browserTotalMuted;
    summaryEl.textContent =
      `${allCount} writers detected \u00b7 ${totalLines} lines captured \u00b7 ${totalMuted} muted`;
    unmuteAllBtn.disabled = mutedCount === 0 && kwCount === 0;
    renderList();
  }

  await fetchSnapshot();
  render();
  api.fetchApi("/livedev/get_all_modules")
    .then((r) => r.json())
    .then((d) => {
      const mods = Array.isArray(d?.modules) ? d.modules : [];
      dataList.innerHTML = "";
      for (const extra of ["JS: ComfyUI Frontend", "Lib: comfyui_frontend_package", "ComfyUI Core"]) {
        const o = document.createElement("option");
        o.value = extra;
        dataList.appendChild(o);
      }
      for (const mod of mods) {
        const o = document.createElement("option");
        o.value = mod;
        dataList.appendChild(o);
      }
    })
    .catch(() => {});
}

window.openLiveDevConsoleFilter = openConsoleFilterModal;

app.registerExtension({
  name: "LiveDev.ConsoleFilter",
  setup() {
    // Non-blocking background sync into localStorage cache so F5 silences browser warnings from ms 0
    api.fetchApi("/livedev/console_filter")
      .then((res) => res.json())
      .then((data) => {
        if (data && data.ok && data.config) cacheConfigLocally(data.config);
      })
      .catch(() => {});
  },
});
