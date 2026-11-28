import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ACCENT, ensureTheme } from "./livedev-theme.js";

// Node widgets the Terminal node builds. Small enough to live here rather than in a file of their
// own: `utils.js` is the module the other frontend files already import.
export class Util {
  static AddMessageListener(messagePath, handlerFunc) {
    api.addEventListener(messagePath, handlerFunc);
  }

  static SetTextAreaContent(widget, text) {
    widget.element.textContent = text;
  }

  static SetTextAreaScrollPos(widget, pos01) {
    widget.element.scroll(0, widget.element.scrollHeight * pos01);
  }

  static AddReadOnlyTextArea(node, name, text, placeholder = "") {
    const inputEl = document.createElement("textarea");
    inputEl.className = "comfy-multiline-input";
    inputEl.placeholder = placeholder;
    inputEl.spellcheck = false;
    inputEl.readOnly = true;
    inputEl.textContent = text;
    return node.addDOMWidget(name, "", inputEl, { serialize: false });
  }

  static AddButtonWidget(node, label, callback, value = null) {
    return node.addWidget("button", label, value, callback);
  }
}

// Shared state for cross-module communication
window._alignToolbar = null;
window._undoStack = [];
window._redoStack = [];
window._themeBtn = null;
window._tbAutoShow = true;
window._tbVisible = false;
window._tbMon = null;
window._tbShowBtn = null;

// Nodes whose class changed since they were built: a module reload can add, remove or rename a
// widget, and the node already on the canvas keeps the set the previous class built. LiveDev records
// them here rather than rebuilding them, and whoever offers the rebuild goes through these three
// functions - so the state has one owner and the badge cannot disagree with the list.
window._livedevStale = [];
const _staleWatchers = [];

export function staleNodes() {
  return (window._livedevStale || []).filter((node) => node && node.graph);
}

export function setStaleNodes(nodes) {
  window._livedevStale = nodes || [];
  for (const watch of _staleWatchers) watch(window._livedevStale.length);
}

export function onStaleCountChange(watch) {
  _staleWatchers.push(watch);
}

// Asked once per node per frame by the canvas marker, so it must not build anything: the raw list is
// consulted and the answer is a boolean.
export function isStaleNode(node) {
  return (window._livedevStale || []).includes(node);
}

// A value that came from somewhere other than this pack - a workflow's node title, a saved preset
// name, a tag the user typed - is text, never markup. Every string built with `innerHTML` puts such
// a value through this first.
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

export function showToast(msg, durationMs = 3000) {
  ensureTheme();
  const prev = document.querySelector(".ld-toast");
  if (prev) prev.remove();

  const t = document.createElement("div");
  t.className = "ld-toast";
  t.title = "Click to dismiss";

  // Place cleanly below the ComfyUI top menu bar / LiveDev stats bar so it never overlaps controls
  let topPx = 104;
  try {
    const anchor =
      document.getElementById("livedev-btn") ||
      document.querySelector(".comfyui-menu, .comfyui-menu-bar");
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      if (r.bottom > 0 && r.bottom < 220) {
        topPx = Math.max(104, Math.round(r.bottom + 16));
      }
    }
  } catch (e) {}
  t.style.top = topPx + "px";

  const dot = document.createElement("span");
  dot.className = "ld-toast-dot";
  const txt = document.createElement("span");
  txt.textContent = msg;
  t.append(dot, txt);
  document.body.appendChild(t);

  let closed = false;
  let timer = null;
  const dismiss = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    t.classList.remove("is-visible");
    setTimeout(() => t.remove(), 200);
  };
  const armTimer = (ms) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(dismiss, ms);
  };

  t.onclick = dismiss;
  t.onmouseenter = () => { if (timer) clearTimeout(timer); };
  t.onmouseleave = () => { if (!closed) armTimer(1200); };

  requestAnimationFrame(() => t.classList.add("is-visible"));
  armTimer(durationMs);
}

export function getSelectedArr() {
  const c = window.app?.canvas;
  if (!c) return [];
  const graph = c.graph || window.app?.graph;
  const isCanvasItem = (n) => {
    if (!n) return false;
    if (graph && (n === graph.inputNode || n === graph.outputNode)) return false;
    const pos = n.pos || n._pos;
    const size = n.size || n._size;
    return Boolean(pos && pos.length >= 2 && size && size.length >= 2);
  };
  if (c.selectedItems instanceof Set) {
    return [...c.selectedItems].filter(isCanvasItem);
  }
  if (c.selected_nodes) {
    const arr = [];
    for (const k of Object.keys(c.selected_nodes)) {
      const n = c.selected_nodes[k];
      if (isCanvasItem(n)) arr.push(n);
    }
    return arr;
  }
  return [];
}

export function saveToolbarState() {
  const c = window.app?.canvas; if (!c || !c.graph) return;
  const g = c.graph;
  const state = {};
  for (const n of g._nodes || []) {
    const pos = n.pos || n._pos;
    const size = n.size || n._size;
    state[n.id] = {
      pos: pos ? [pos[0], pos[1]] : [0, 0],
      size: size ? [size[0], size[1]] : null,
      color: n.color,
      bgcolor: n.bgcolor,
      mode: n.mode,
      flags: n.flags ? { ...n.flags } : {},
      title: n.title,
      widgets_values: n.widgets_values ? [...n.widgets_values] : null,
      properties: n.properties ? { ...n.properties } : null,
      inputs: n.inputs ? n.inputs.map(inp => ({ link: inp.link })) : null,
    };
  }
  if (Array.isArray(g._groups) && g._groups.length) {
    state.__groups = g._groups.map((grp, idx) => {
      const pos = grp.pos || grp._pos;
      const size = grp.size || grp._size;
      return {
        id: grp.id ?? idx,
        pos: pos ? [pos[0], pos[1]] : [0, 0],
        size: size ? [size[0], size[1]] : null,
        color: grp.color,
        title: grp.title,
      };
    });
  }
  window._undoStack.push(state);
  if (window._undoStack.length > 20) window._undoStack.shift();
  window._redoStack.length = 0;
}

export function restoreToolbarState(state) {
  const c = window.app?.canvas; if (!c || !c.graph) return;
  const g = c.graph;
  g.beforeChange();
  for (const n of g._nodes || []) {
    const s = state[n.id];
    if (s) {
      n.pos = [...s.pos];
      if (s.size) {
        if (typeof n.setSize === "function") n.setSize([...s.size]);
        else n.size = [...s.size];
      }
      if (s.color !== undefined) n.color = s.color;
      if (s.bgcolor !== undefined) n.bgcolor = s.bgcolor;
      if (s.mode !== undefined) n.mode = s.mode;
      if (s.flags && n.flags) Object.assign(n.flags, s.flags);
      if (s.title !== undefined) n.title = s.title;
      if (s.widgets_values && n.widgets_values) {
        for (let wi = 0; wi < Math.min(s.widgets_values.length, n.widgets_values.length); wi++) {
          if (s.widgets_values[wi] !== undefined) n.widgets_values[wi] = s.widgets_values[wi];
        }
      }
      if (s.properties && n.properties) Object.assign(n.properties, s.properties);
      if (s.inputs && n.inputs) {
        for (let si = 0; si < Math.min(s.inputs.length, n.inputs.length); si++) {
          n.inputs[si].link = s.inputs[si].link;
        }
      }
    }
  }
  if (Array.isArray(state.__groups) && Array.isArray(g._groups)) {
    for (let i = 0; i < g._groups.length; i++) {
      const grp = g._groups[i];
      const gs = state.__groups.find((entry) => entry.id === (grp.id ?? i)) || state.__groups[i];
      if (!gs) continue;
      grp.pos = [...gs.pos];
      if (gs.size) grp.size = [...gs.size];
      if (gs.color !== undefined) grp.color = gs.color;
      if (gs.title !== undefined) grp.title = gs.title;
    }
  }
  g.afterChange();
  g.change?.();
  c.setDirty(true, true);
  if (typeof c.draw === "function") c.draw(true, true);
}

export function sep() {
  const s = document.createElement("span");
  s.style.cssText = "display:inline-block;width:1px;height:20px;background:rgba(255,255,255,0.08);margin:0 4px;flex-shrink:0;";
  return s;
}

export function makeBtn(text, title, color, onClick) {
  const b = document.createElement("button");
  b.textContent = text;
  b.title = title;
  b.style.cssText = "background:transparent;border:1px solid rgba(255,255,255,0.12);border-radius:4px;color:"+color+";cursor:pointer;font-size:15px;line-height:1;padding:4px 6px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;transition:background 0.15s,color 0.15s,opacity 0.15s;";
  b.onmouseenter = () => b.style.background = "rgba(255,255,255,0.08)";
  b.onmouseleave = () => b.style.background = "transparent";
  b.onclick = (e) => { e.stopPropagation(); onClick?.(); };
  return b;
}

// ComfyUI loads every `.js` under WEB_DIRECTORY as an extension, so this file is loaded as one.
// It registers nothing beyond itself and has nothing to install at startup: its content is the
// helpers and the shared state the other frontend files import. The registration is here so that
// reading the folder gives no file that looks like an extension and is not one.
app.registerExtension({ name: "LiveDev.Shared", setup() {} });
