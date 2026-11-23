import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import { getSelectedArr, showToast, esc, isStaleNode } from "./utils.js";
import { BUTTON, BUTTON_ACCENT, BUTTON_DANGER, PANEL, SURFACE_DEEP, BORDER_SOFT, TEXT, TEXT_DIM, FONT_MONO, ACCENT, ACCENT_DIM, LD_ICONS, createGlassModal } from "./livedev-theme.js";

// ---------------------------------------------------------------------------
// LiveDev Toolkit: Reload History, Live Console, Python REPL, Execution Trace,
// Node Error Inspector, Node Source Viewer, Session Manager,
// Health & Self-Test.
// ---------------------------------------------------------------------------

// ---------------- DOM helpers ----------------

export function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null) continue;
    if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "class") el.className = v;
    // Markup, by contract: `html` is for a template this pack wrote, and any value placed inside it
    // goes through `esc` at the call site. Anything else belongs in `children`, which becomes text.
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function")
      el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v);
  }
  for (const c of [].concat(children || [])) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

// The palette lives in livedev-theme.js; these names stay because other modules import them, but
// the values now come from that one place.
export const BTN = BUTTON;
export const BTN_GREEN = BUTTON_ACCENT;
export const BTN_RED = BUTTON_DANGER;

// A place for other modules to add buttons to the error card.
//
// The card is built here, so a module that wants a button in it has nowhere to put one - and the
// alternative, looking the card up in the DOM afterwards, breaks silently the first time this file
// changes. Each hook is called with (node, detail, buttons, card) once the card is assembled, and a
// hook that throws is reported and ignored so one bad extension cannot take the error card down.
export const ERROR_CARD_HOOKS = [];

// A place for another module to take over when an error is shown and when it is cleared.
//
// The three listeners below are all the logic this file has: show on execution_error, clear on
// execution_start and execution_success. That is enough for a single run and wrong for everything
// else - a run that was already in the queue when the error happened clears it on success, and a
// retry that finishes in under a second makes the card flicker. Deciding properly needs state that
// belongs with the report, not here, so a controller may be installed and this file falls back to
// its own behaviour when none is.
export const ERROR_LIFECYCLE = { controller: null };

function _panelIconFor(title) {
  const t = String(title || "").toLowerCase();
  if (t.includes("history")) return LD_ICONS.history;
  if (t.includes("console")) return LD_ICONS.terminal;
  if (t.includes("repl")) return LD_ICONS.code;
  if (t.includes("trace")) return LD_ICONS.trace;
  if (t.includes("source")) return LD_ICONS.file;
  if (t.includes("health")) return LD_ICONS.shield;
  if (t.includes("session") || t.includes("restore")) return LD_ICONS.save;
  if (t.includes("error") || t.includes("report")) return LD_ICONS.bug;
  return LD_ICONS.bolt;
}

export function makePanel(title, buildFn, onClose) {
  const { overlay, body, close } = createGlassModal({
    title,
    icon: _panelIconFor(title),
    width: "700px",
    maxHeight: "84vh",
    draggable: true,
    onClose,
  });
  buildFn(body, overlay);
  return { overlay, body, close };
}

async function fetchJSON(url, opts) {
  const r = await api.fetchApi(url, opts);
  let data = {};
  try { data = await r.json(); } catch { /* ignore */ }
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}

// ---------------- Reload History ----------------

async function renderReloadHistory(body) {
  let data;
  try {
    data = await fetchJSON("/livedev/reload_history");
  } catch (e) {
    body.innerHTML = `<div style="color:#e57373">${esc(e.message)}</div>`;
    return;
  }
  body.innerHTML = "";
  const history = data.history || [];

  const controls = h("div", { style: { display: "flex", gap: "6px", marginBottom: "8px", flexWrap: "wrap", flexShrink: "0" } });
  const pauseBtn = h("button", { style: BTN, html: "Pause/Resume watching" });
  // Watching starts paused, so the label is read once instead of starting ambiguous: the button
  // should say what pressing it will do.
  fetchJSON("/livedev/health").then((health) => {
    pauseBtn.textContent = health.watchPaused ? "Resume watching" : "Pause watching";
  }).catch(() => {});
  pauseBtn.onclick = async () => {
    try {
      const d = await fetchJSON("/livedev/toggle_watch", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      pauseBtn.textContent = d.paused ? "Resume watching" : "Pause watching";
    } catch (e) { showToast("[LiveDev] " + e.message); }
  };
  const refreshBtn = h("button", { style: BTN, html: "Refresh" });
  refreshBtn.onclick = () => renderReloadHistory(body);
  controls.append(pauseBtn, refreshBtn);
  body.appendChild(controls);

  if (!history.length) {
    body.appendChild(h("div", { style: { color: "#888" } }, "No reloads recorded yet."));
    return;
  }

  const list = h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } });
  for (const item of [...history].reverse()) {
    const color = item.status === "success" ? "#38c0c4" : item.status === "failed" ? "#e57373" : "#38c0c4";
    const row = h("div", {
      style: { background: "#1a1a1a", border: "1px solid #333", borderRadius: "6px", padding: "6px 8px", flexShrink: "0" },
    }, [
      h("div", { style: { display: "flex", justifyContent: "space-between", gap: "8px", alignItems: "center" } }, [
        h("span", { style: { color, fontWeight: "bold", wordBreak: "break-all" } }, item.module),
        h("span", { style: { color: "#888", fontSize: "11px", whiteSpace: "nowrap" } },
          new Date(item.time * 1000).toLocaleTimeString() + (item.durationMs ? ` · ${item.durationMs}ms` : "")),
      ]),
      h("div", { style: { color: "#bbb", fontSize: "11px", marginTop: "2px", wordBreak: "break-all" } },
        `${item.status}${item.details ? " — " + item.details : ""}`),
      ...(item.warnings && item.warnings.length
        ? [h("div", { style: { color: "#38c0c4", fontSize: "11px", marginTop: "2px", wordBreak: "break-all" } }, "⚠ " + item.warnings.join("; "))]
        : []),
      h("div", { style: { display: "flex", gap: "6px", marginTop: "6px" } }, [
        h("button", { style: BTN_GREEN, onclick: () => reloadNow(item.module, body) }, "Reload now"),
        h("button", { style: BTN, onclick: () => rollbackModule(item.module, body) }, "Restore backup"),
      ]),
    ]);
    list.appendChild(row);
  }
  body.appendChild(list);
}

async function reloadNow(module, body) {
  try {
    const d = await fetchJSON("/livedev/reload_now", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ module }),
    });
    showToast("[LiveDev] " + (d.result || d.error || "OK"));
  } catch (e) { showToast("[LiveDev] " + e.message); }
  if (body) renderReloadHistory(body);
}

async function rollbackModule(module, body) {
  if (!confirm(`Restore the last backed-up version of '${module}' and reload it?`)) return;
  try {
    const d = await fetchJSON("/livedev/rollback", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ module }),
    });
    showToast("[LiveDev] Restored: " + d.restored);
  } catch (e) { showToast("[LiveDev] " + e.message); }
  if (body) renderReloadHistory(body);
}

function openReloadHistory() {
  const { body } = makePanel("Reload History", (b) => {
    b.appendChild(h("div", { style: { color: "#888" } }, "Loading…"));
  }, () => openMenu());
  renderReloadHistory(body);
}

// ---------------- Live Console ----------------

let _consoleEl = null;
let _consoleFollowing = true;

// How much of the log the panel keeps, dropped from the front in whole chunks - which is why the
// count is tracked here instead of being asked of the element.
const CONSOLE_LIMIT = 200000;

// Following the tail is one scroll per frame, not one per message. Reading `scrollHeight` forces the
// browser to lay the panel out again, and the panel holds a couple of hundred thousand characters:
// measured at ~12 ms per chunk, which is where the stutter during a reload's output burst came from.
// The append below was never the expensive half.
let _consoleScrollPending = false;

function followConsole() {
  if (_consoleScrollPending || !_consoleEl || !_consoleFollowing) return;
  _consoleScrollPending = true;
  requestAnimationFrame(() => {
    _consoleScrollPending = false;
    if (_consoleEl && _consoleFollowing) _consoleEl.scrollTop = _consoleEl.scrollHeight;
  });
}

function onConsoleEvent(e) {
  if (!_consoleEl) return;
  const line = e?.detail?.line ?? "";
  if (!line) return;
  // A text node per chunk, not `textContent +=`. Reading and rewriting the whole buffer for every
  // message is O(n) per chunk, and a reload prints several chunks a second. Appending is O(1), and the
  // trim removes whole nodes from the front.
  if (_consoleEl.__chars === undefined) _consoleEl.__chars = _consoleEl.textContent.length;
  const node = document.createTextNode(line);
  _consoleEl.appendChild(node);
  _consoleEl.__chars += line.length;
  while (_consoleEl.__chars > CONSOLE_LIMIT && _consoleEl.firstChild) {
    const first = _consoleEl.firstChild;
    _consoleEl.__chars -= first.length ?? first.textContent.length;
    _consoleEl.removeChild(first);
  }
  followConsole();
}

export function openConsole() {
  makePanel("Live Console", (body) => {
    const bar = h("div", { style: { display: "flex", gap: "6px", marginBottom: "6px", flexShrink: "0" } });
    const followBtn = h("button", { style: BTN, html: "Follow: ON" });
    followBtn.onclick = () => {
      _consoleFollowing = !_consoleFollowing;
      followBtn.innerHTML = "Follow: " + (_consoleFollowing ? "ON" : "OFF");
    };
    const clearBtn = h("button", { style: BTN, html: "Clear" });
    const out = h("div", {
      style: {
        flex: "1", overflow: "auto", background: SURFACE_DEEP, border: `1px solid ${BORDER_SOFT}`,
        borderRadius: "6px", padding: "8px", whiteSpace: "pre-wrap", wordBreak: "break-all",
        minHeight: "320px", color: TEXT, fontFamily: FONT_MONO, fontSize: "12px",
      },
    });
    _consoleEl = out;
    fetchJSON("/livedev/console")
      .then((d) => {
        const text = (d.lines || []).join("");
        out.textContent = text;
        out.__chars = text.length;
        out.scrollTop = out.scrollHeight;
      })
      .catch(() => {});

    // Wired at last: the button was drawn and never given a handler, so it did nothing at all. It
    // empties this panel's own view - the server's buffer is the menu's Console entry - and it resets
    // the running character count, without which the trim would keep discarding newly arrived lines
    // until the count caught up with an empty panel.
    clearBtn.onclick = () => {
      out.textContent = "";
      out.__chars = 0;
    };
    bar.append(followBtn, clearBtn);
    body.appendChild(bar);
    body.appendChild(out);
  }, () => { _consoleEl = null; openMenu(); });
}

// ---------------- Python REPL ----------------

function openRepl() {
  makePanel("Python REPL (runs in the ComfyUI server process)", (body) => {
    const warn = h("div", {
      style: { color: "#38c0c4", marginBottom: "6px", fontSize: "12px", flexShrink: "0" },
    }, "Code executes inside the server with full process access. Use carefully.");
    const ack = h("label", {
      style: { fontSize: "12px", color: "#bbb", display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px", flexShrink: "0" },
    }, [
      h("input", { type: "checkbox" }),
      " I understand this runs code on the server",
    ]);
    const ta = h("textarea", {
      style: {
        width: "100%", height: "130px", background: SURFACE_DEEP, color: TEXT,
        border: `1px solid ${BORDER_SOFT}`, borderRadius: "6px", padding: "8px",
        fontFamily: FONT_MONO, fontSize: "12px", resize: "vertical",
        boxSizing: "border-box", flexShrink: "0",
      },
    });
    const runBtn = h("button", { style: BTN_GREEN, html: "Run (Ctrl+Enter)", disabled: "" });
    const out = h("div", {
      style: {
        flex: "1", overflow: "auto", background: SURFACE_DEEP, border: `1px solid ${BORDER_SOFT}`,
        borderRadius: "6px", padding: "8px", whiteSpace: "pre-wrap", wordBreak: "break-all",
        minHeight: "120px", color: TEXT, fontFamily: FONT_MONO, fontSize: "12px", marginTop: "8px",
      },
    });
    ack.querySelector("input").addEventListener("change", (e) => {
      runBtn.disabled = !e.target.checked;
    });
    async function run() {
      out.textContent = "Running…";
      try {
        const d = await fetchJSON("/livedev/repl", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: ta.value }),
        });
        let txt = "";
        if (d.stdout) txt += d.stdout;
        if (d.result !== undefined && d.result !== "") txt += ">>> " + d.result + "\n";
        if (!d.ok && d.error) txt += "ERROR: " + d.error + "\n" + (d.traceback || "");
        out.textContent = txt || "(no output)";
      } catch (e) { out.textContent = "ERROR: " + e.message; }
    }
    ta.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run();
    });
    runBtn.onclick = run;
    body.append(warn, ack, ta, h("div", { style: { marginTop: "6px", flexShrink: "0" } }, runBtn), out);
  }, () => openMenu());
}

// ---------------- Execution Trace ----------------

const TRACES = new Map();

function summarizeOutputs(message) {
  try {
    const out = message?.outputs;
    if (out == null) return "";
    const s = JSON.stringify(out);
    return s && s.length > 240 ? s.slice(0, 240) + "…" : (s || "");
  } catch { return ""; }
}

function openTracePanel() {
  makePanel("Execution Trace (last run)", (body) => {
    if (!TRACES.size) {
      body.appendChild(h("div", { style: { color: "#888" } },
        "No executions recorded yet. Run your workflow, then reopen this panel."));
      return;
    }
    const list = h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } });
    for (const [id, rec] of [...TRACES.entries()].reverse()) {
      const node = app.graph?._nodes?.find((n) => n.id === id);
      const label = node ? `${node.type} (${id})` : `node ${id}`;
      list.appendChild(h("div", {
        style: { background: "#1a1a1a", border: "1px solid #333", borderRadius: "6px", padding: "6px 8px", flexShrink: "0" },
      }, [
        h("div", { style: { display: "flex", justifyContent: "space-between", gap: "8px" } }, [
          h("span", { style: { color: "#38c0c4", wordBreak: "break-all" } }, label),
          h("span", { style: { color: "#888", fontSize: "11px", whiteSpace: "nowrap" } },
            rec.ms != null ? `${rec.ms} ms` : "…"),
        ]),
        rec.outputs
          ? h("div", { style: { color: "#bbb", fontSize: "11px", marginTop: "2px", wordBreak: "break-all" } }, rec.outputs)
          : null,
      ]));
    }
    body.appendChild(list);
  }, () => openMenu());
}

// ---------------- Node Error Inspector ----------------

const ERRORS = new Map();

// ---------------- Node Source Viewer ----------------

function openSourceForNode(node) {
  if (!node || !node.type) {
    showToast("[LiveDev] Select a node first");
    return;
  }
  makePanel("Node Source: " + node.type, (body) => {
    body.appendChild(h("div", { style: { color: "#888" } }, "Loading…"));
    fetchJSON("/livedev/node_source", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node_type: node.type }),
    }).then((d) => {
      body.innerHTML = "";
      body.appendChild(h("div", {
        style: { color: "#888", marginBottom: "6px", fontSize: "11px", wordBreak: "break-all", flexShrink: "0" },
      }, d.path));
      const pre = h("pre", {
        style: {
          flex: "1", overflow: "auto", background: "#0d0d0d", border: "1px solid #333",
          borderRadius: "6px", padding: "8px", whiteSpace: "pre", fontSize: "12px",
          lineHeight: "1.5", color: "#ddd", minHeight: "300px", margin: "0",
        },
      });
      pre.textContent = d.source;
      body.appendChild(pre);
    }).catch((e) => {
      body.innerHTML = `<div style="color:#e57373">${esc(e.message)}</div>`;
    });
  }, () => openMenu());
}

async function openSource() {
  openSourceForNode(getSelectedArr()[0]);
}

// ---------------- Live Error Overlay ----------------

const _errorOverlays = new Map(); // nodeId -> { el, node }
let _overlayLoopRunning = false;

  export function clearErrorOverlay(id) {
    const o = _errorOverlays.get(id);
    if (o) {
      o.el.remove();
      _errorOverlays.delete(id);
    }
    // The one place a card goes away, so the one place a controller can learn that it did. It knows
    // the difference between a card it closed itself and one the user closed, because it clears its
    // own reference before asking for the hide.
    if (ERROR_LIFECYCLE.controller) ERROR_LIFECYCLE.controller.dismiss(id);
  }

export function clearAllErrorOverlays() {
  for (const id of [..._errorOverlays.keys()]) clearErrorOverlay(id);
}

function positionErrorOverlays() {
  for (const [id, o] of _errorOverlays) {
    const node = o.node;
    if (!node || !node.pos || !node.size || !app.canvas || !app.canvas.ds) {
      clearErrorOverlay(id);
      continue;
    }
    let rect = { left: 0, top: 0 };
    try { rect = app.canvas.canvas.getBoundingClientRect(); } catch { /* ignore */ }
    const ds = app.canvas.ds;
    const pos = node._pos || node.pos;
    const scale = Number(ds.scale) || 1;
    const offset = ds.offset || [0, 0];
    const nodeLeft = rect.left + offset[0] + pos[0] * scale;
    const nodeTop = rect.top + offset[1] + pos[1] * scale;
    const nodeWidth = (node.size?.[0] || 200) * scale;
    const gap = 8;
    const rightX = nodeLeft + nodeWidth + gap;
    const leftX = nodeLeft - o.el.offsetWidth - gap;
    const x = rightX + o.el.offsetWidth <= window.innerWidth - 6
      ? rightX
      : Math.max(6, leftX);
    const y = Math.max(6, Math.min(nodeTop, window.innerHeight - o.el.offsetHeight - 6));
    o.el.style.left = x + "px";
    o.el.style.top = y + "px";
    // Keep the error card in screen pixels; canvas zoom must only change its
    // anchor position, never its size or typography.
    o.el.style.transform = "none";
    o.el.style.zoom = "1";
    o.el.style.display = "block";
  }
}

function startOverlayLoop() {
  if (_overlayLoopRunning) return;
  _overlayLoopRunning = true;
  const tick = () => {
    if (_errorOverlays.size === 0) { _overlayLoopRunning = false; return; }
    positionErrorOverlays();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function rollbackNodeModule(nodeType) {
  try {
    const d = await fetchJSON("/livedev/node_module", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node_type: nodeType }),
    });
    if (!d.module) {
      showToast("[LiveDev] Built-in node - no backup to restore");
      return;
    }
    await fetchJSON("/livedev/rollback", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ module: d.module }),
    });
    showToast("[LiveDev] Restored module '" + d.module + "' and reloaded");
  } catch (e) { showToast("[LiveDev] " + e.message); }
}

export function showErrorOverlay(id, detail) {
  clearErrorOverlay(id);
  const graph = app.canvas?.graph || app.graph;
  const numericId = Number(id);
  const node = graph?.getNodeById?.(numericId) || graph?._nodes?.find((n) => String(n.id) === String(id));
  if (!node || !node.type) return;
  const typeName = node.type;
  const msg = detail.exception_message || detail.message || "Execution error";
  const rawTb = detail.traceback;
  const tbLines = (Array.isArray(rawTb) ? rawTb : rawTb ? String(rawTb).split("\n") : [])
    .map((l) => l.trimEnd()).filter((l) => l.trim());

  const card = h("div", {
    style: {
      position: "fixed", zIndex: "95000", width: "310px", minWidth: "310px", maxWidth: "310px",
      boxSizing: "border-box", transform: "none", zoom: "1", contain: "layout paint style",
      background: "rgba(26, 15, 18, 0.94)", border: "1px solid rgba(229, 115, 115, 0.45)",
      borderLeft: "3px solid #e57373", borderRadius: "11px", padding: "10px 12px",
      backdropFilter: "blur(14px)", fontFamily: "monospace", fontSize: "11px",
      color: "#d8dee6", boxShadow: "0 12px 32px rgba(0,0,0,0.65)", display: "block",
    },
  });
  card.addEventListener("mousedown", (e) => e.stopPropagation());
  card.addEventListener("mousemove", (e) => e.stopPropagation());
  card.addEventListener("wheel", (e) => e.stopPropagation());

  const header = h("div", {
    style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", marginBottom: "6px" },
  }, [
    h("span", {
      style: { display: "inline-flex", alignItems: "center", gap: "6px", color: "#e57373", fontWeight: "bold", wordBreak: "break-all" },
      html: LD_ICONS.bug + "<span>" + esc(typeName) + "</span>",
    }),
    h("button", {
      class: "ld-modal-close",
      style: { width: "22px", height: "22px", fontSize: "12px" },
      onclick: () => clearErrorOverlay(id),
    }, "\u2715"),
  ]);
  const msgEl = h("div", {
    style: {
      color: "#e57373", fontSize: "11px", wordBreak: "break-word", maxHeight: "60px",
      overflow: "hidden", marginBottom: "4px",
    },
  }, msg);
  const buttons = h("div", { style: { display: "flex", gap: "4px", flexWrap: "wrap" } }, [
    h("button", { style: BTN_GREEN, html: "Rollback" }),
    h("button", { style: BTN, html: "Source" }),
    h("button", { style: BTN, html: "Console" }),
  ]);
  const rollbackBtn = buttons.children[0];
  const sourceBtn = buttons.children[1];
  const consoleBtn = buttons.children[2];
  rollbackBtn.onclick = async () => {
    rollbackBtn.disabled = true;
    await rollbackNodeModule(typeName);
    rollbackBtn.disabled = false;
  };
  sourceBtn.onclick = () => { clearErrorOverlay(id); openSourceForNode(node); };
  consoleBtn.onclick = () => { clearErrorOverlay(id); openConsole(); };

  card.append(header, msgEl);
  if (tbLines.length) {
    const pre = h("pre", {
      style: {
        background: "#1a0d0d", border: "1px solid #3a2222", borderRadius: "6px",
        padding: "6px", margin: "0 0 6px 0", maxHeight: "110px", overflow: "auto",
        color: "#e57373", fontSize: "10px", whiteSpace: "pre-wrap", wordBreak: "break-all",
      },
    });
    pre.textContent = tbLines.slice(0, 6).join("\n");
    card.appendChild(pre);
  }
    card.appendChild(buttons);
    for (const hook of ERROR_CARD_HOOKS) {
      try {
        hook(node, detail, buttons, card);
      } catch (error) {
        console.warn("[LiveDev] error card hook failed:", error);
      }
    }
    document.body.appendChild(card);
  _errorOverlays.set(id, { el: card, node });
  positionErrorOverlays();
  startOverlayLoop();
}

// ---------------- Health & Self-Test ----------------

function openHealth() {
  makePanel("Health & Self-Test", (body) => {
    const bar = h("div", { style: { display: "flex", gap: "6px", marginBottom: "6px", flexShrink: "0" } });
    const refreshBtn = h("button", { style: BTN, html: "Refresh health" });
    const testBtn = h("button", { style: BTN_RED, html: "Run self-test" });
    const out = h("pre", {
      style: {
        flex: "1", overflow: "auto", background: "#0d0d0d", border: "1px solid #333",
        borderRadius: "6px", padding: "8px", minHeight: "220px", color: "#ddd",
        fontSize: "12px", whiteSpace: "pre-wrap", wordBreak: "break-all", margin: "0",
      },
    });
    const loadHealth = async () => {
      try {
        const d = await fetchJSON("/livedev/health");
        out.textContent = JSON.stringify(d, null, 2);
      } catch (e) { out.textContent = "ERROR: " + e.message; }
    };
    refreshBtn.onclick = loadHealth;
    testBtn.onclick = async () => {
      testBtn.disabled = true;
      out.textContent = "Running self-test…";
      try {
        const d = await fetchJSON("/livedev/self_test", { method: "POST" });
        out.textContent = JSON.stringify(d, null, 2);
      } catch (e) { out.textContent = "ERROR: " + e.message; }
      testBtn.disabled = false;
    };
    bar.append(refreshBtn, testBtn);
    body.append(bar, out);
    loadHealth();
  }, () => openMenu());
}

// ---------------- Session Manager ----------------

const SESSION_KEY = "livedev_autosave";
const SESSIONS_KEY = "livedev_sessions";

function getSessions() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSIONS_KEY) || "{}");
    return s && typeof s === "object" && !Array.isArray(s) ? s : {};
  } catch (e) { return {}; }
}
function saveSessionsMap(map) {
  try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(map)); } catch (e) { /* ignore */ }
}

async function restoreWorkflow(wf) {
  if (!wf) throw new Error("empty workflow");
  await app.loadGraphData(wf);
}

async function restoreSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) { showToast("[LiveDev] No saved session"); return; }
    const d = JSON.parse(raw);
    if (!d.wf) { showToast("[LiveDev] No saved session"); return; }
    await restoreWorkflow(d.wf);
    showToast("[LiveDev] Session restored");
  } catch (e) { showToast("[LiveDev] Restore failed: " + e.message); }
}

function sessionSave(name) {
  const g = app.graph;
  if (!g || !g._nodes || !g._nodes.length) {
    showToast("[LiveDev] Empty graph - nothing to save");
    return false;
  }
  const sessions = getSessions();
  sessions[name] = { t: Date.now(), wf: g.serialize() };
  saveSessionsMap(sessions);
  return true;
}

function sessionLoad(name) {
  const s = getSessions()[name];
  if (!s || !s.wf) { showToast("[LiveDev] Session '" + name + "' not found"); return; }
  restoreWorkflow(s.wf)
    .then(() => showToast("[LiveDev] Session '" + name + "' loaded"))
    .catch((e) => showToast("[LiveDev] Load failed: " + e.message));
}

function sessionDelete(name) {
  const sessions = getSessions();
  delete sessions[name];
  saveSessionsMap(sessions);
}

function sessionRename(oldName, newName) {
  newName = (newName || "").trim();
  if (!newName || newName === oldName) return;
  const sessions = getSessions();
  if (sessions[newName]) {
    showToast("[LiveDev] A session named '" + newName + "' already exists");
    return;
  }
  sessions[newName] = sessions[oldName];
  delete sessions[oldName];
  saveSessionsMap(sessions);
}

function openSessionManager() {
  const { overlay } = makePanel("Session Manager", (body) => {
    const nameIn = h("input", {
      type: "text", placeholder: "Session name",
      style: {
        flex: "1", background: "#0d0d0d", color: "#ddd", border: "1px solid #333",
        borderRadius: "6px", padding: "6px 8px", fontFamily: "monospace", fontSize: "12px",
      },
    });
    const saveBtn = h("button", { style: BTN_GREEN, html: "Save current graph" });
    const listWrap = h("div", {
      style: {
        flex: "1", overflow: "auto", display: "flex", flexDirection: "column",
        gap: "6px", marginTop: "10px",
      },
    });
    const autoLbl = h("span", { style: { flex: "1", color: "#888", fontSize: "11px" } });
    const autoRestore = h("button", { style: BTN, html: "Restore autosave" });
    const autoClear = h("button", { style: BTN_RED, html: "Clear autosave" });
    const autoRow = h("div", {
      style: { display: "flex", gap: "6px", alignItems: "center", flexShrink: "0", marginTop: "10px" },
    });

    saveBtn.onclick = () => {
      const name = nameIn.value.trim();
      if (!name) { showToast("[LiveDev] Enter a session name"); return; }
      if (sessionSave(name)) {
        showToast("[LiveDev] Session '" + name + "' saved");
        nameIn.value = "";
        render();
      }
    };
    autoRestore.onclick = () => { overlay.remove(); restoreSession(); };
    autoClear.onclick = () => {
      localStorage.removeItem(SESSION_KEY);
      showToast("[LiveDev] Autosave cleared");
      render();
    };

    function render() {
      listWrap.innerHTML = "";
      autoLbl.textContent = localStorage.getItem(SESSION_KEY)
        ? "Autosave exists (before F5)"
        : "No autosave";
      const sessions = getSessions();
      const names = Object.keys(sessions).sort();
      if (!names.length) {
        listWrap.appendChild(h("div", { style: { color: "#888", fontSize: "12px" } },
          "No named sessions yet. Save the current graph above."));
        return;
      }
      for (const nm of names) {
        const s = sessions[nm];
        const lbl = h("span", { style: { flex: "1", color: "#ddd", wordBreak: "break-all" } }, nm);
        const time = h("span", {
          style: { color: "#888", fontSize: "10px", whiteSpace: "nowrap" },
        }, new Date(s.t).toLocaleString());
        const loadBtn = h("button", { style: BTN, html: "Load" });
        const renBtn = h("button", { style: BTN, html: "Rename" });
        const delBtn = h("button", { style: BTN_RED, html: "Delete" });
        const row = h("div", {
          style: {
            display: "flex", alignItems: "center", gap: "6px",
            border: "1px solid #333", borderRadius: "8px", padding: "6px 8px",
          },
        });
        loadBtn.onclick = () => { overlay.remove(); sessionLoad(nm); };
        delBtn.onclick = () => {
          sessionDelete(nm);
          showToast("[LiveDev] Session '" + nm + "' deleted");
          render();
        };
        renBtn.onclick = () => {
          const inp = h("input", {
            type: "text", value: nm,
            style: {
              flex: "1", background: "#0d0d0d", color: "#ddd", border: "1px solid #333",
              borderRadius: "6px", padding: "4px 6px", fontFamily: "monospace", fontSize: "12px",
            },
          });
          const ok = h("button", { style: BTN_GREEN, html: "OK" });
          const cancel = h("button", { style: BTN, html: "Cancel" });
          lbl.replaceWith(inp);
          loadBtn.remove(); renBtn.remove(); time.remove();
          ok.onclick = () => { sessionRename(nm, inp.value.trim()); render(); };
          cancel.onclick = render;
          row.insertBefore(ok, delBtn);
          row.insertBefore(cancel, delBtn);
          inp.focus();
          inp.select();
        };
        row.append(lbl, time, loadBtn, renBtn, delBtn);
        listWrap.appendChild(row);
      }
    }

    autoRow.append(autoLbl, autoRestore, autoClear);
    body.append(
      h("div", { style: { display: "flex", gap: "6px", flexShrink: "0" } }, [nameIn, saveBtn]),
      listWrap,
      autoRow,
    );
    render();
  }, () => openMenu());
}

function initSessionRestore() {
  window.addEventListener("beforeunload", () => {
    try {
      const g = app.graph;
      if (g && g._nodes && g._nodes.length > 0) {
        localStorage.setItem(SESSION_KEY, JSON.stringify({ t: Date.now(), wf: g.serialize() }));
      }
    } catch { /* ignore */ }
  });
  setTimeout(() => {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (!d.wf || !d.t) return;
      if (Date.now() - d.t > 6 * 3600 * 1000) return;
      if (app.graph && app.graph._nodes && app.graph._nodes.length > 0) return;
      const { close } = makePanel("Restore session?", (body) => {
        const info = h("div", {
          style: { color: "#bbb", marginBottom: "10px", fontSize: "12px", flexShrink: "0" },
        }, "An autosave from " + new Date(d.t).toLocaleString() + " was found. Restore it?");
        const restore = h("button", { style: BTN_GREEN, html: "Restore" });
        const dismiss = h("button", { style: BTN, html: "Dismiss" });
        restore.onclick = async () => { close(); await restoreSession(); };
        dismiss.onclick = close;
        body.append(info, h("div", { style: { display: "flex", gap: "6px", flexShrink: "0" } }, [restore, dismiss]));
      });
    } catch { /* ignore */ }
  }, 1500);
}

// ---------------- Toolkit entry ----------------

let _toolkitInit = false;

function addToolkitButtonToToolbar() {
  const tb = document.getElementById("livedev-align-tb");
  if (!tb) return false;
  const row = document.getElementById("livedev-align-tb-row2") || tb;
  const gap = h("span", { style: { display: "inline-block", width: "1px", height: "18px", background: "rgba(255,255,255,0.10)", margin: "0 3px" } });
  const btn = h("button", {
    class: "livedev-pill",
    html: LD_ICONS.bolt + '<span style="margin-left:5px;">LiveDev Toolkit</span>',
    title: "Open the LiveDev Toolkit (reload history, console, REPL, trace, health, sessions)",
    style: {
      padding: "0 11px", border: `1px solid ${ACCENT_DIM}`, borderRadius: "8px",
      cursor: "pointer", fontSize: "11.5px", fontFamily: FONT_MONO,
      fontWeight: "600", color: ACCENT, background: "transparent",
      display: "inline-flex", alignItems: "center",
    },
  });
  btn.addEventListener("click", (e) => { e.stopPropagation(); openMenu(); });
  row.appendChild(gap);
  row.appendChild(btn);
  return true;
}

function initToolkit() {
  if (_toolkitInit) return;
  _toolkitInit = true;

  api.addEventListener("livedev_console", onConsoleEvent);

  if (!addToolkitButtonToToolbar()) {
    // Fallback: toolbar not ready yet, try again shortly.
    setTimeout(() => addToolkitButtonToToolbar(), 300);
  }

  initSessionRestore();
}

function openMenu() {
  const items = [
    ["Reload History", LD_ICONS.history, openReloadHistory],
    ["Live Console", LD_ICONS.terminal, openConsole],
    ["Python REPL", LD_ICONS.code, openRepl],
    ["Execution Trace", LD_ICONS.trace, openTracePanel],
    ["View Node Source", LD_ICONS.file, openSource],
    ["Health & Self-Test", LD_ICONS.shield, openHealth],
    ["Session Manager", LD_ICONS.save, openSessionManager],
  ];
  const { body, close } = createGlassModal({
    title: "LiveDev Toolkit",
    subtitle: "Developer diagnostics, live logs, source inspection, and session tools.",
    icon: LD_ICONS.bolt,
    width: "460px",
    draggable: true,
  });
  const grid = h("div", { class: "ld-tile-grid" });
  for (const [label, iconSvg, fn] of items) {
    const tile = h("button", {
      type: "button",
      class: "ld-tile",
      html: `<span class="ld-tile-ico">${iconSvg}</span><span>${esc(label)}</span>`,
    });
    tile.onclick = () => { close(); fn(); };
    grid.appendChild(tile);
  }
  body.appendChild(grid);
}

// ---------------- Extensions ----------------

app.registerExtension({
  name: "LiveDev.Toolkit",
  async setup() { initToolkit(); },
});

app.registerExtension({
  name: "LiveDev.Trace",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    // Pack-wide on purpose: the trace records whichever node ran, so there is no name to stop at.
    // The check below is a real one - a registration with no name is not a node, and there would be
    // nothing to attach the hook to.
    if (!nodeData || typeof nodeData.name !== "string") return;
    const orig = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      try {
        const rec = TRACES.get(this.id) || {};
        const ms = rec._start ? Math.round(performance.now() - rec._start) : null;
        TRACES.set(this.id, { ms, outputs: summarizeOutputs(message), at: Date.now() });
      } catch { /* ignore */ }
      if (orig) return orig.apply(this, arguments);
    };
  },
  async setup() {
    api.addEventListener("executing", (e) => {
      const id = e?.detail;
      if (typeof id === "number") {
        const prev = TRACES.get(id) || {};
        prev._start = performance.now();
        TRACES.set(id, prev);
      }
    });
  },
});

app.registerExtension({
  name: "LiveDev.Errors",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    // Pack-wide for the same reason as the trace above: the border marks whichever node failed.
    if (!nodeData || typeof nodeData.name !== "string") return;
    const origFG = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      if (origFG) origFG.apply(this, arguments);
      const err = ERRORS.get(this.id);
      if (err) {
        ctx.save();
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = "#e57373";
        ctx.lineWidth = 3;
        ctx.strokeRect(1, 1, this.size[0] - 2, this.size[1] - 2);
        ctx.restore();
        this.flags = this.flags || {};
        this.flags.error = err;
      } else if (this.flags) {
        delete this.flags.error;
      }
      // A node a reload left behind, marked in the pack's accent rather than the failure red: it is
      // not an error, it is out of date. Seeing which ones they are is the point - a count in the menu
      // says how many without saying which, and an undrawn node hides the one that matters.
      if (isStaleNode(this)) {
        ctx.save();
        ctx.setLineDash([2, 6]);
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 2;
        ctx.strokeRect(2, 2, this.size[0] - 4, this.size[1] - 4);
        ctx.restore();
      }
    };
  },
    async setup() {
      api.addEventListener("execution_error", (e) => {
        const m = e?.detail || {};
        const id = m?.node_id ?? m?.node;
        if (id != null) {
          const graph = app.canvas?.graph || app.graph;
          const numericId = Number(id);
          const node = graph?.getNodeById?.(numericId) || graph?._nodes?.find((n) => String(n.id) === String(id));
          const actualId = node?.id ?? id;
          ERRORS.set(actualId, m?.exception_message || m?.message || "Execution error");
          // The controller decides whether this is shown now or held back; without one, show it.
          if (ERROR_LIFECYCLE.controller) {
            ERROR_LIFECYCLE.controller.raise(actualId, m, node);
          } else {
            showErrorOverlay(actualId, m);
          }
        }
      });
      api.addEventListener("execution_start", (e) => {
        if (ERROR_LIFECYCLE.controller) {
          ERROR_LIFECYCLE.controller.started(e?.detail || {});
          return;
        }
        ERRORS.clear();
        clearAllErrorOverlays();
      });
      api.addEventListener("execution_success", (e) => {
        if (ERROR_LIFECYCLE.controller) {
          ERROR_LIFECYCLE.controller.succeeded(e?.detail || {});
          return;
        }
        clearAllErrorOverlays();
      });
      api.addEventListener("reconnecting", () => {
        if (ERROR_LIFECYCLE.controller) ERROR_LIFECYCLE.controller.reconnecting();
      });
      api.addEventListener("reconnected", () => {
        if (ERROR_LIFECYCLE.controller) ERROR_LIFECYCLE.controller.reconnected();
      });
    },
});
