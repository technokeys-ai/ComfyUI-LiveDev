import { app } from "../../scripts/app.js";
import { showToast, getSelectedArr, saveToolbarState, restoreToolbarState, esc } from "./utils.js";
import { LD_ICONS, createGlassModal } from "./livedev-theme.js";

app.registerExtension({ name: "LiveDev.Advanced", async setup() {} });

function lsGet(key, fallback) {
  try {
    const value = localStorage.getItem("livedev_" + key);
    return value != null ? JSON.parse(value) : fallback;
  } catch (e) {
    return fallback;
  }
}

function isNonEnglish(text) {
  if (!text || typeof text !== "string") return false;
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u309F\u30A0-\u30FF\u0400-\u04FF\u0500-\u052F\u0590-\u05FF\uAC00-\uD7AF\u0E00-\u0E7F\u10D0-\u10FF]/.test(text);
}

function _advIconFor(title) {
  const t = String(title || "").toLowerCase();
  if (t.includes("template")) return LD_ICONS.file;
  if (t.includes("preset")) return LD_ICONS.grid;
  if (t.includes("tag")) return LD_ICONS.tag;
  if (t.includes("bulk") || t.includes("edit")) return LD_ICONS.edit;
  if (t.includes("theme")) return LD_ICONS.palette;
  if (t.includes("stat") || t.includes("dash")) return LD_ICONS.chart;
  if (t.includes("voice")) return LD_ICONS.mic;
  if (t.includes("sandbox")) return LD_ICONS.cube;
  return LD_ICONS.sliders;
}

function makePopup(title, contentFn) {
  const { overlay, modal: panel, body } = createGlassModal({
    title,
    icon: _advIconFor(title),
    width: "700px",
    maxHeight: "85vh",
    draggable: true,
  });
  contentFn(body, overlay);
  return { overlay, panel, body };
}

function btn(label, title, color, fn) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "ld-btn";
  el.textContent = label;
  el.title = title;
  if (color) el.style.color = color;
  el.style.margin = "2px";
  el.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
  return el;
}

function smallBtn(label, title, fn) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "ld-btn";
  el.textContent = label;
  el.title = title;
  el.style.cssText = "padding:3px 8px;font-size:11px;margin:1px;";
  el.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
  return el;
}

// === 1. Zoom to Fit Selection (or Entire Graph) ===
let _zoomFitRaf = null;

export function doZoomToFit() {
  const c = app.canvas;
  if (!c || !c.canvas || !c.ds) return;

  // Collect selected nodes (supports Set selectedItems and legacy selected_nodes)
  let selected = getSelectedArr();
  if (!selected.length && c.selectedItems instanceof Set && c.selectedItems.size) {
    selected = [...c.selectedItems].filter((n) => n && (n.pos || n._pos));
  }
  const graph = c.graph || app.graph;
  const allNodes = graph?._nodes || graph?.nodes || [];
  const nodes = selected.length ? selected : allNodes;
  if (!nodes.length) {
    showToast("No nodes in workflow to fit");
    return;
  }

  const defaultTitleH =
    typeof LiteGraph !== "undefined" && Number.isFinite(LiteGraph.NODE_TITLE_HEIGHT)
      ? LiteGraph.NODE_TITLE_HEIGHT
      : 30;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const n of nodes) {
    if (!n) continue;
    const pos = n.pos || n._pos;
    if (!pos || pos.length < 2) continue;

    let x;
    let y;
    let w;
    let h;
    if (typeof n.getBounding === "function") {
      try {
        const out = [0, 0, 0, 0];
        const b = n.getBounding(out) || out;
        if (
          b &&
          b.length >= 4 &&
          Number.isFinite(b[0]) &&
          Number.isFinite(b[1]) &&
          Number.isFinite(b[2]) &&
          Number.isFinite(b[3]) &&
          b[2] > 0 &&
          b[3] > 0
        ) {
          [x, y, w, h] = b;
        }
      } catch (e) {}
    }
    if (x === undefined) {
      const noTitle = n.constructor?.title_mode === 2 || n.title_mode === 2;
      const titleH = noTitle ? 0 : defaultTitleH;
      const collapsed = Boolean(n.flags?.collapsed);
      const size = n.size || n._size;
      x = Number(pos[0]) || 0;
      y = (Number(pos[1]) || 0) - titleH;
      w = collapsed ? (n._collapsed_width || 140) : (Number(size?.[0]) || 200);
      h = collapsed ? (titleH || 30) : (Number(size?.[1]) || 100) + titleH;
    }
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return;

  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);

  let cw = 0;
  let ch = 0;
  if (typeof c.ds.getViewportSize === "function") {
    try {
      const vp = c.ds.getViewportSize();
      if (vp && vp[0] > 0 && vp[1] > 0) {
        cw = vp[0];
        ch = vp[1];
      }
    } catch (e) {}
  }
  if (!(cw > 0 && ch > 0)) {
    const dpr = window.devicePixelRatio || 1;
    const rect = c.canvas.getBoundingClientRect ? c.canvas.getBoundingClientRect() : null;
    cw = rect && rect.width > 0 ? rect.width : (c.canvas.clientWidth || c.canvas.width / dpr);
    ch = rect && rect.height > 0 ? rect.height : (c.canvas.clientHeight || c.canvas.height / dpr);
  }
  if (!(cw > 0 && ch > 0)) return;

  const padX = Math.max(72, cw * 0.12);
  const padY = Math.max(96, ch * 0.16);
  const availW = Math.max(120, cw - padX * 2);
  const availH = Math.max(120, ch - padY * 2);

  const maxScale = nodes.length === 1 ? 1.35 : 1.15;
  const minScale = 0.12;
  const targetScale = Math.max(minScale, Math.min(availW / bw, availH / bh, maxScale));

  const cx = minX + bw * 0.5;
  const cy = minY + bh * 0.5;
  const targetOffX = (cw * 0.5) / targetScale - cx;
  const targetOffY = (ch * 0.5) / targetScale - cy;

  if (_zoomFitRaf) {
    cancelAnimationFrame(_zoomFitRaf);
    _zoomFitRaf = null;
  }

  const startScale = Number(c.ds.scale) || 1;
  const startOffX = Number(c.ds.offset?.[0]) || 0;
  const startOffY = Number(c.ds.offset?.[1]) || 0;
  const duration = 220;
  const t0 = performance.now();

  const applyFrame = (s, ox, oy) => {
    c.ds.scale = s;
    c.ds.offset[0] = ox;
    c.ds.offset[1] = oy;
    if (typeof c.ds.onChanged === "function") c.ds.onChanged(s, c.ds.offset);
    if (typeof c.ds.onredraw === "function") c.ds.onredraw(c.ds);
    c.setDirty(true, true);
  };

  const step = (now) => {
    const t = Math.min(1, (now - t0) / duration);
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    const s = startScale + (targetScale - startScale) * ease;
    const ox = startOffX + (targetOffX - startOffX) * ease;
    const oy = startOffY + (targetOffY - startOffY) * ease;
    applyFrame(s, ox, oy);
    if (t < 1) {
      _zoomFitRaf = requestAnimationFrame(step);
    } else {
      _zoomFitRaf = null;
      applyFrame(targetScale, targetOffX, targetOffY);
    }
  };

  _zoomFitRaf = requestAnimationFrame(step);
}

// === 2. Workflow Templates ===
export function doWorkflowTemplates() {
  const key = "livedev_templates";
  const tpls = JSON.parse(localStorage.getItem(key) || "[]");
  makePopup("Workflow Templates", (body, ov) => {
    body.innerHTML = '<div style="margin-bottom:8px;color:#888;font-size:11px;">Save/Load workflow templates</div>';
    const row = document.createElement("div"); row.style.cssText = "display:flex;gap:4px;margin-bottom:10px;";
    const inp = document.createElement("input"); inp.type = "text"; inp.placeholder = "Template name...";
    inp.style.cssText = "flex:1;padding:4px 8px;border:1px solid #555;border-radius:4px;background:#2a2a2a;color:#ddd;font-size:12px;";
    row.appendChild(inp);
    const saveBtn = btn("\u{1F4BE} Save Current", "", "#38c0c4", () => {
      const name = inp.value.trim();
      if (!name) { showToast("Enter a name"); return; }
      const g = app.canvas?.graph;
      if (!g) return;
      const data = g.serialize();
      tpls.push({ name, data, date: new Date().toISOString() });
      while (tpls.length > 20) tpls.shift();
      localStorage.setItem(key, JSON.stringify(tpls));
      showToast("Saved: " + name);
      ov.remove();
      doWorkflowTemplates();
    });
    row.appendChild(saveBtn);
    body.appendChild(row);
    if (!tpls.length) { const em = document.createElement("div"); em.style.cssText = "color:#888;"; em.textContent = "No templates saved yet"; body.appendChild(em); return; }
    const list = document.createElement("div"); list.style.cssText = "display:flex;flex-direction:column;gap:3px;";
    for (let i = tpls.length - 1; i >= 0; i--) {
      const t = tpls[i];
      const item = document.createElement("div");
      item.style.cssText = "display:flex;align-items:center;gap:4px;padding:4px 6px;border:1px solid #333;border-radius:4px;";
      item.innerHTML = '<span style="flex:1;">' + esc(t.name) + '</span><span style="color:#888;font-size:10px;">' + (t.date ? new Date(t.date).toLocaleDateString() : "") + '</span>';
      item.appendChild(smallBtn("\u{1F4C2} Load", "", () => {
        if (!app.canvas?.graph) return;
        try { app.canvas.graph.load(JSON.parse(JSON.stringify(t.data))); app.canvas.setDirty(true, true); showToast("Loaded: " + t.name); ov.remove(); } catch(e) { showToast("Load failed"); }
      }));
      item.appendChild(smallBtn("\u{1F5D1}", "Delete", () => {
        tpls.splice(i, 1); localStorage.setItem(key, JSON.stringify(tpls)); ov.remove(); doWorkflowTemplates();
      }));
      list.appendChild(item);
    }
    body.appendChild(list);
  });
}

// === 3. Node Presets ===
export function doNodePresets() {
  const key = "livedev_presets";
  const presets = JSON.parse(localStorage.getItem(key) || "[]");
  makePopup("Node Presets", (body) => {
    body.innerHTML = '<div style="margin-bottom:8px;color:#888;font-size:11px;">Save/load presets for selected node type</div>';
    const sel = getSelectedArr();
    const typeInfo = sel.length === 1 ? sel[0].type : "any";
    body.innerHTML += '<div style="margin-bottom:8px;color:#38c0c4;font-size:12px;">' + (sel.length === 1 ? "Selected: " + esc(typeInfo) : "Select a single node to save its preset") + '</div>';
    const row = document.createElement("div"); row.style.cssText = "display:flex;gap:4px;margin-bottom:10px;";
    const inp = document.createElement("input"); inp.type = "text"; inp.placeholder = "Preset name...";
    inp.style.cssText = "flex:1;padding:4px 8px;border:1px solid #555;border-radius:4px;background:#2a2a2a;color:#ddd;font-size:12px;";
    row.appendChild(inp);
    const saveBtn = btn("\u{1F4BE} Save", "", "#38c0c4", () => {
      const name = inp.value.trim();
      if (!name) { showToast("Enter a name"); return; }
      if (sel.length !== 1) { showToast("Select exactly one node"); return; }
      const n = sel[0];
      const preset = { name, type: n.type, title: n.title, color: n.color, bgcolor: n.bgcolor, widgets_values: n.widgets_values ? [...n.widgets_values] : null, properties: n.properties ? { ...n.properties } : null };
      presets.push(preset);
      while (presets.length > 30) presets.shift();
      localStorage.setItem(key, JSON.stringify(presets));
      showToast("Preset saved");
    });
    row.appendChild(saveBtn);
    body.appendChild(row);
    if (!presets.length) { const em = document.createElement("div"); em.style.cssText = "color:#888;"; em.textContent = "No presets saved"; body.appendChild(em); return; }
    const list = document.createElement("div"); list.style.cssText = "display:flex;flex-direction:column;gap:3px;";
    for (let i = presets.length - 1; i >= 0; i--) {
      const p = presets[i];
      const item = document.createElement("div");
      item.style.cssText = "display:flex;align-items:center;gap:4px;padding:4px 6px;border:1px solid #333;border-radius:4px;";
      item.innerHTML = '<span style="flex:1;">' + esc(p.name) + '</span><span style="color:#888;font-size:10px;">' + esc(p.type) + '</span>';
      item.appendChild(smallBtn("\u2714 Apply", "", () => {
        const targets = getSelectedArr().filter(n => n.type === p.type || typeInfo === "any");
        if (!targets.length) { showToast("No matching nodes selected"); return; }
        const g = app.canvas?.graph; if (!g) return; g.beforeChange();
        for (const n of targets) {
          if (p.title) n.title = p.title;
          if (p.color) n.color = p.color;
          if (p.bgcolor) n.bgcolor = p.bgcolor;
          if (p.widgets_values && n.widgets_values) for (let wi = 0; wi < Math.min(p.widgets_values.length, n.widgets_values.length); wi++) n.widgets_values[wi] = p.widgets_values[wi];
          if (p.properties && n.properties) Object.assign(n.properties, p.properties);
        }
        g.afterChange(); app.canvas?.setDirty(true, true); showToast("Applied to " + targets.length + " node(s)");
      }));
      item.appendChild(smallBtn("\u{1F5D1}", "Delete", () => { presets.splice(i, 1); localStorage.setItem(key, JSON.stringify(presets)); ov.remove(); doNodePresets(); }));
      list.appendChild(item);
    }
    body.appendChild(list);
  });
}

// === 4. Node Tags & Filtering ===
export function doNodeTags() {
  const key = "livedev_tags";
  const tags = JSON.parse(localStorage.getItem(key) || "{}");
  makePopup("Node Tags & Filtering", (body) => {
    body.innerHTML = '<div style="margin-bottom:8px;color:#888;font-size:11px;">Tag nodes and filter by tag. Tags persist in localStorage.</div>';
    const sel = getSelectedArr();
    body.innerHTML += '<div style="margin-bottom:6px;color:#888;font-size:12px;">Selected: ' + sel.length + ' node(s)</div>';
    const tagInp = document.createElement("input"); tagInp.type = "text"; tagInp.placeholder = "Tag name...";
    tagInp.style.cssText = "width:150px;padding:4px 8px;border:1px solid #555;border-radius:4px;background:#2a2a2a;color:#ddd;font-size:12px;";
    const addBtn = btn("\u2795 Add", "", "#38c0c4", () => {
      const t = tagInp.value.trim().toLowerCase();
      if (!t) { showToast("Enter tag name"); return; }
      for (const n of sel) {
        const id = n.id;
        if (!tags[id]) tags[id] = [];
        if (!tags[id].includes(t)) tags[id].push(t);
      }
      localStorage.setItem(key, JSON.stringify(tags)); showToast("Tagged " + sel.length + " node(s)");
    });
    const tagRow = document.createElement("div"); tagRow.style.cssText = "display:flex;gap:4px;align-items:center;margin-bottom:10px;";
    tagRow.appendChild(tagInp); tagRow.appendChild(addBtn);
    body.appendChild(tagRow);
    for (const n of sel) {
      const nodeTags = tags[n.id] || [];
      const nodeDiv = document.createElement("div");
      nodeDiv.style.cssText = "padding:3px 6px;border:1px solid #333;border-radius:4px;margin-bottom:3px;font-size:11px;display:flex;align-items:center;gap:4px;";
      nodeDiv.innerHTML = '<span style="flex:1;color:#888;">[' + esc(n.id) + '] ' + esc(n.title || n.type) + '</span>';
      if (nodeTags.length) nodeDiv.innerHTML += nodeTags.map(t => '<span style="background:#1f6f73;color:#fff;padding:1px 5px;border-radius:3px;font-size:10px;">' + esc(t) + '</span>').join(" ");
      else nodeDiv.innerHTML += '<span style="color:#555;">no tags</span>';
      body.appendChild(nodeDiv);
    }
    const sepDiv = document.createElement("div");
    sepDiv.style.cssText = "margin-top:10px;padding-top:8px;border-top:1px solid #333;";
    body.appendChild(sepDiv);
    const filterLabel = document.createElement("div");
    filterLabel.style.cssText = "color:#888;font-size:12px;margin-bottom:6px;";
    filterLabel.textContent = "Filter by tag (select matching nodes):";
    body.appendChild(filterLabel);
    const allTags = [...new Set(Object.values(tags).flat())];
    if (!allTags.length) { const em = document.createElement("span"); em.style.cssText = "color:#888;"; em.textContent = "No tags used yet"; body.appendChild(em); return; }
    const tagFilterRow = document.createElement("div"); tagFilterRow.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;";
    for (const t of allTags) {
      const tb = smallBtn(t, "Select nodes with this tag", () => {
        const ids = Object.entries(tags).filter(([id, ts]) => ts.includes(t)).map(([id]) => parseInt(id));
        const c = app.canvas; if (!c || !c.graph) return;
        c.graph.beforeChange();
        for (const n of c.graph._nodes) n.selected = ids.includes(n.id);
        c.graph.afterChange(); c.setDirty(true, true); showToast("Selected " + ids.length + " node(s) tagged '" + t + "'");
      });
      tb.style.border = "1px solid #38c0c4"; tb.style.color = "#38c0c4";
      tagFilterRow.appendChild(tb);
    }
    body.appendChild(tagFilterRow);
  });
}

// === 5. Bulk Node Editor ===
export function doBulkEditor() {
  const sel = getSelectedArr();
  if (!sel.length) { showToast("Select at least one node"); return; }
  makePopup("Bulk Node Editor (" + sel.length + " nodes)", (body) => {
    body.innerHTML = '<div style="margin-bottom:8px;color:#888;font-size:11px;">Edit properties of all selected nodes at once</div>';
    const fields = [
      { label: "Title (leave empty to keep)", key: "title", type: "text" },
      { label: "Title color (hex)", key: "color", type: "text", placeholder: "#223" },
      { label: "Body color (hex)", key: "bgcolor", type: "text", placeholder: "#335" },
    ];
    for (const f of fields) {
      const row = document.createElement("div"); row.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:6px;";
      row.innerHTML = '<span style="width:160px;color:#aaa;">' + f.label + '</span>';
      const inp = document.createElement("input"); inp.type = f.type; inp.placeholder = f.placeholder || "";
      inp.style.cssText = "flex:1;padding:4px 8px;border:1px solid #555;border-radius:4px;background:#2a2a2a;color:#ddd;font-size:12px;";
      row.appendChild(inp);
      if (f.key === "color" || f.key === "bgcolor") {
        const cp = document.createElement("input"); cp.type = "color";
        cp.style.cssText = "width:32px;height:32px;padding:0;border:1px solid #555;border-radius:4px;cursor:pointer;background:transparent;";
        cp.value = f.key === "color" ? "#222244" : "#333355";
        cp.addEventListener("input", () => { inp.value = cp.value; });
        inp.addEventListener("input", () => { try { cp.value = inp.value; } catch(e) {} });
        row.appendChild(cp);
      }
      const appBtn = smallBtn("Apply", "", () => {
        const v = inp.value.trim();
        if (!v) return;
        const g = app.canvas?.graph; if (!g) return; g.beforeChange();
        for (const n of sel) {
          if (f.key === "title") n.title = v;
          else if (f.key === "color") n.color = v;
          else if (f.key === "bgcolor") n.bgcolor = v;
        }
        g.afterChange(); app.canvas?.setDirty(true, true); showToast("Applied");
      });
      row.appendChild(appBtn);
      body.appendChild(row);
    }
    const wHeader = document.createElement("div");
    wHeader.style.cssText = "margin-top:12px;padding-top:8px;border-top:1px solid #333;color:#888;font-size:12px;margin-bottom:4px;";
    wHeader.textContent = "Widget Values (for nodes sharing same widgets)";
    body.appendChild(wHeader);
    const wRow = document.createElement("div"); wRow.style.cssText = "display:flex;gap:4px;align-items:center;margin-bottom:6px;";
    const wiSel = document.createElement("select"); wiSel.style.cssText = "padding:3px 6px;border:1px solid #555;border-radius:4px;background:#2a2a2a;color:#ddd;font-size:11px;";
    const firstNode = sel[0];
    if (firstNode.widgets) {
      for (let wi = 0; wi < firstNode.widgets.length; wi++) {
        const o = document.createElement("option"); o.value = wi; o.textContent = "widget[" + wi + "] (" + (firstNode.widgets[wi].type || "?") + ")"; wiSel.appendChild(o);
      }
    }
    wRow.appendChild(wiSel);
    const wInp = document.createElement("input"); wInp.type = "text"; wInp.placeholder = "New value...";
    wInp.style.cssText = "flex:1;padding:4px 8px;border:1px solid #555;border-radius:4px;background:#2a2a2a;color:#ddd;font-size:12px;";
    wRow.appendChild(wInp);
    const wAppBtn = smallBtn("Apply to all", "", () => {
      const wi = parseInt(wiSel.value); const v = wInp.value;
      const g = app.canvas?.graph; if (!g) return; g.beforeChange();
      for (const n of sel) {
        if (n.widgets_values && wi < n.widgets_values.length) n.widgets_values[wi] = v;
        if (n.widgets && wi < n.widgets.length) n.widgets[wi].value = v;
      }
      g.afterChange(); app.canvas?.setDirty(true, true); showToast("Applied");
    });
    wRow.appendChild(wAppBtn);
    body.appendChild(wRow);
  });
}

// === 6. Workflow Completion ===
export function doWorkflowComplete() {
  const sel = getSelectedArr();
  if (sel.length < 2) { showToast("Select 2+ nodes to auto-connect"); return; }
  const g = app.canvas?.graph; if (!g) return;
  let count = 0;
  g.beforeChange();
  for (let i = 0; i < sel.length - 1; i++) {
    const src = sel[i], dst = sel[i + 1];
    if (!src.outputs || !dst.inputs) continue;
    const srcOut = src.outputs.find(o => o.links && o.links.some(l => l === null || l === undefined)) || src.outputs[0];
    const dstIn = dst.inputs.find(inp => inp.link === null || inp.link === undefined) || dst.inputs[0];
    if (srcOut && dstIn && srcOut.type === dstIn.type) {
      try { g.connect(src, srcOut.name ? src.findOutputSlot?.(srcOut.name) : 0, dst, dstIn.name ? dst.findInputSlot?.(dstIn.name) : 0); count++; } catch(e) {}
    }
  }
  g.afterChange(); app.canvas?.setDirty(true, true);
  showToast("Created " + count + " connection(s)");
}

// === 7. Node Themes ===
const THEMES = {
  "Default":       { color: undefined, bgcolor: undefined },
  "Blueprint":     { color: "#1a237e", bgcolor: "#283593" },
  "Forest":        { color: "#1b5e20", bgcolor: "#2e7d32" },
  "Sunset":        { color: "#bf360c", bgcolor: "#d84315" },
  "Midnight":      { color: "#1a1a2e", bgcolor: "#16213e" },
  "Cyberpunk":     { color: "#00bcd4", bgcolor: "#1a0033" },
  "Nord":          { color: "#2e3440", bgcolor: "#3b4252" },
  "Dracula":       { color: "#44475a", bgcolor: "#282a36" },
  "Ocean":         { color: "#0d47a1", bgcolor: "#1565c0" },
  "Lavender":      { color: "#4a148c", bgcolor: "#6a1b9a" },
  "Teal":          { color: "#004d40", bgcolor: "#00695c" },
  "Coral":         { color: "#ff5252", bgcolor: "#d32f2f" },
  "Slate":         { color: "#263238", bgcolor: "#37474f" },
  "Amber":         { color: "#e65100", bgcolor: "#ff8f00" },
  "Mint":          { color: "#1b4332", bgcolor: "#2d6a4f" },
  "Plum":          { color: "#3e1f47", bgcolor: "#5a2d6b" },
  "Steel":         { color: "#1a237e", bgcolor: "#3949ab" },
  "Warm":          { color: "#4e342e", bgcolor: "#6d4c41" },
  "Ice":           { color: "#006064", bgcolor: "#00838f" },
  "Peach":         { color: "#e65100", bgcolor: "#ff7043" },
  "Jade":          { color: "#004d40", bgcolor: "#00a86b" },
  "Ruby":          { color: "#7f0000", bgcolor: "#b71c1c" },
  "Sky":           { color: "#01579b", bgcolor: "#0288d1" },
  "Coffee":        { color: "#3e2723", bgcolor: "#5d4037" },
  "Periwinkle":    { color: "#283593", bgcolor: "#5c6bc0" },
  "Sage":          { color: "#33691e", bgcolor: "#558b2f" },
  "Magenta":       { color: "#880e4f", bgcolor: "#c2185b" },
  "Charcoal":      { color: "#212121", bgcolor: "#424242" },
  "Gold":          { color: "#bf360c", bgcolor: "#f9a825" },
  "Olive":         { color: "#3e2723", bgcolor: "#7d7d2f" },
};

export function doNodeThemes() {
  makePopup("Node Themes", (body, ov) => {
    body.innerHTML = '<div style="margin-bottom:8px;color:#888;font-size:11px;">Apply color theme to selected nodes</div>';
    body.innerHTML += '<div style="margin-bottom:8px;color:#888;font-size:12px;">Selected: <span id="lvt-nt-count">' + getSelectedArr().length + '</span> node(s)</div>';
    const grid = document.createElement("div"); grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:6px;";
    for (const [name, theme] of Object.entries(THEMES)) {
      const card = document.createElement("div");
      card.style.cssText = "padding:10px;border:1px solid #444;border-radius:6px;cursor:pointer;text-align:center;transition:all .1s;";
      card.style.background = theme.bgcolor || "#1a1a1a";
      card.style.color = theme.color ? "#fff" : "#ddd";
      card.innerHTML = '<div style="font-weight:bold;font-size:12px;">' + name + '</div><div style="font-size:9px;margin-top:4px;color:rgba(255,255,255,0.6);">' + (theme.color || "") + '</div>';
      card.addEventListener("click", (e) => {
        e.stopPropagation();
        const nodes = getSelectedArr();
        if (!nodes.length) { showToast("No nodes selected"); return; }
        const c = app.canvas; if (!c || !c.graph) return;
        c.graph.beforeChange();
        for (const n of nodes) { n.color = theme.color; n.bgcolor = theme.bgcolor; }
        c.graph.afterChange(); c.change?.(); c.setDirty(true, true); showToast("Applied: " + name);
        ov.remove();
      });
      card.addEventListener("mouseenter", () => card.style.borderColor = "#888");
      card.addEventListener("mouseleave", () => card.style.borderColor = "#444");
      grid.appendChild(card);
    }
    body.appendChild(grid);
    const resetRow = document.createElement("div");
    resetRow.style.cssText = "margin-top:8px;";
    const resetBtn = document.createElement("button");
    resetBtn.textContent = "\u21ba Reset colors";
    resetBtn.style.cssText = "padding:5px 10px;border:1px solid #555;border-radius:5px;cursor:pointer;font-size:12px;font-family:monospace;color:#aaa;background:transparent;margin:2px;";
    resetBtn.addEventListener("mouseenter", () => resetBtn.style.background = "rgba(255,255,255,0.07)");
    resetBtn.addEventListener("mouseleave", () => resetBtn.style.background = "transparent");
    resetBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const nodes = getSelectedArr();
      if (!nodes.length) { showToast("No nodes selected"); return; }
      const c = app.canvas; if (!c || !c.graph) return;
      c.graph.beforeChange();
      for (const n of nodes) { n.color = undefined; n.bgcolor = undefined; }
      c.graph.afterChange(); c.change?.(); c.setDirty(true, true); showToast("Reset");
      ov.remove();
    });
    resetRow.appendChild(resetBtn);
    body.appendChild(resetRow);
  });
}

// === 8. Wire Bundles ===
export function doWireBundles() {
  const sel = getSelectedArr();
  if (sel.length < 2) { showToast("Select 2+ connected nodes"); return; }
  const g = app.canvas?.graph; if (!g) return;
  let count = 0;
  g.beforeChange();
  for (const n of sel) {
    if (!n.inputs) continue;
    for (let si = 0; si < n.inputs.length; si++) {
      const inp = n.inputs[si];
      if (!inp.link) continue;
      const link = g.links?.[inp.link];
      if (!link) continue;
      const srcNode = g._nodes.find(nn => nn.id === link.origin_id);
      if (!srcNode || !sel.includes(srcNode)) continue;
      if (inp.type === "IMAGE" || inp.type === "LATENT" || inp.type === "MODEL" || inp.type === "CONDITIONING" || inp.type === "VAE" || inp.type === "CLIP") {
        if (n.widgets && srcNode.widgets) continue;
        try {
          const rr = LiteGraph.createNode("Reroute");
          rr.pos = [(n.pos[0] + srcNode.pos[0]) / 2, (n.pos[1] + srcNode.pos[1]) / 2];
          g.add(rr);
          g.connect(srcNode, link.origin_slot, rr, 0);
          g.connect(rr, 0, n, si);
          count++;
        } catch(e) {}
      }
    }
  }
  g.afterChange(); app.canvas?.setDirty(true, true);
  showToast("Created " + count + " wire bundle(s)");
}

// === 9. Auto-Reroute ===
export function doAutoReroute() {
  const g = app.canvas?.graph;
  if (!g) return;
  const toReroute = [];
  for (const n of g._nodes) {
    if (n.type === "Reroute") continue;
    if (!n.inputs) continue;
    for (let si = 0; si < n.inputs.length; si++) {
      const inp = n.inputs[si];
      if (!inp.link) continue;
      const link = g.links?.[inp.link];
      if (!link) continue;
      const srcNode = g._nodes.find(nn => nn.id === link.origin_id);
      if (!srcNode || srcNode.type === "Reroute") continue;
      if (!inp.type || inp.type === "*" || inp.type === "STRING") continue;
      const dx = Math.abs(n.pos[0] - srcNode.pos[0]), dy = Math.abs(n.pos[1] - srcNode.pos[1]);
      if (dx > 600 || dy > 300) {
        toReroute.push({ destNode: n, destSlot: si, srcNode, srcSlot: link.origin_slot });
      }
    }
  }
  if (!toReroute.length) { showToast("No long connections found"); return; }
  g.beforeChange();
  let count = 0;
  for (const r of toReroute) {
    try {
      const rr = LiteGraph.createNode("Reroute");
      rr.pos = [(r.destNode.pos[0] + r.srcNode.pos[0]) / 2, (r.destNode.pos[1] + r.srcNode.pos[1]) / 2];
      g.add(rr);
      g.connect(r.srcNode, r.srcSlot, rr, 0);
      g.connect(rr, 0, r.destNode, r.destSlot);
      count++;
    } catch(e) { console.warn("[LiveDev] reroute fail", e); }
  }
  g.afterChange(); app.canvas?.setDirty(true, true);
  showToast("Added " + count + " reroute(s)");
}

// === 10. Node Count / Stats Dashboard ===
export function doStatsDashboard() {
  const g = app.canvas?.graph;
  if (!g) return;
  const nodes = g._nodes || [];
  const groups = g._groups || [];
  const types = {};
  for (const n of nodes) {
    types[n.type] = (types[n.type] || 0) + 1;
  }
  const conns = g._links ? Object.keys(g._links).length : 0;
  makePopup("Stats Dashboard", (body) => {
    body.innerHTML = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">';
    body.innerHTML += '<div style="background:#2a2a2a;padding:10px;border-radius:6px;text-align:center;"><div style="font-size:24px;font-weight:bold;color:#38c0c4;">' + nodes.length + '</div><div style="font-size:11px;color:#888;">Total Nodes</div></div>';
    body.innerHTML += '<div style="background:#2a2a2a;padding:10px;border-radius:6px;text-align:center;"><div style="font-size:24px;font-weight:bold;color:#38c0c4;">' + groups.length + '</div><div style="font-size:11px;color:#888;">Groups</div></div>';
    body.innerHTML += '<div style="background:#2a2a2a;padding:10px;border-radius:6px;text-align:center;"><div style="font-size:24px;font-weight:bold;color:#38c0c4;">' + conns + '</div><div style="font-size:11px;color:#888;">Connections</div></div>';
    body.innerHTML += '<div style="background:#2a2a2a;padding:10px;border-radius:6px;text-align:center;"><div style="font-size:24px;font-weight:bold;color:#38c0c4;">' + Object.keys(types).length + '</div><div style="font-size:11px;color:#888;">Node Types</div></div>';
    body.innerHTML += '</div>';
    body.innerHTML += '<div style="font-size:12px;color:#aaa;margin-bottom:6px;">Node types breakdown:</div>';
    const sorted = Object.entries(types).sort((a, b) => b[1] - a[1]);
    for (const [type, count] of sorted) {
      body.innerHTML += '<div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid #2a2a2a;font-size:11px;"><span style="color:#ddd;">' + esc(type) + '</span><span style="color:#888;">' + count + '</span></div>';
    }
    if (Object.keys(types).length === 0) body.innerHTML += '<div style="color:#888;">No nodes</div>';
  });
}

// === 11. Voice Commands ===
let _voiceActive = false;
let _voiceRecognition = null;

export function doVoiceCommands(onClose) {
  const isOpera = navigator.userAgent.includes("OPR") || navigator.userAgent.includes("Opera");
  const SR = !isOpera && (window.SpeechRecognition || window.webkitSpeechRecognition);
  if (!SR && !isOpera) {
    makePopup("Voice Commands", (body) => {
      body.innerHTML = '<div style="color:#e57373;margin-bottom:10px;font-size:14px;">\u26A0 Not supported in this browser</div>' +
        '<div style="color:#aaa;font-size:12px;margin-bottom:10px;">This feature requires the Web Speech API, available only in Chromium-based browsers:</div>' +
        '<div style="display:flex;flex-direction:column;gap:6px;">' +
        '<a href="https://www.google.com/chrome/" target="_blank" style="color:#38c0c4;">\u{1F310} Google Chrome</a>' +
        '<a href="https://www.microsoft.com/edge/" target="_blank" style="color:#38c0c4;">\u{1F310} Microsoft Edge</a>' +
        '</div>';
    });
    return;
  }
  const secMsg = !window.isSecureContext ? '<div style="color:#e57373;font-size:11px;margin-top:6px;">\u26A0 Page not served over HTTPS/localhost \u2014 speech recognition may be blocked</div>' : '';
  const operaMsg = isOpera ? '<div style="color:#38c0c4;font-size:11px;margin-bottom:6px;">\u26A0 Opera detected \u2014 using audio recording mode (requires <code>pip install SpeechRecognition</code>)</div>' : '';
  const AR = {
    "selectAll": ["تحديد الكل", "اختار الكل", "كلهم", "كل"],
    "selectNone": ["إلغاء التحديد", "لا شيء", "فارغ"],
    "mute": ["كتم", "اخرس", "كاتم", "كتمت"],
    "bypass": ["تجاوز", "تخطي", "تجاوزت", "تخطيت"],
    "alignLeft": ["محاذاة يسار", "يسار", "شمال"],
    "alignRight": ["محاذاة يمين", "يمين", "جنوب"],
    "alignCenter": ["محاذاة وسط", "وسط", "مركز", "منتصف"],
    "alignTop": ["محاذاة أعلى", "فوق", "أعلى"],
    "alignBottom": ["محاذاة أسفل", "تحت", "أسفل"],
    "arrange": ["ترتيب", "رتب", "نظم"],
    "zoom": ["تكبير", "تصغير", "كبّر"],
    "undo": ["تراجع", "رجوع"],
    "redo": ["إعادة", "تقدم"],
    "lock": ["قفل", "اقفل", "مقفول"],
    "collapse": ["طي", "طوي", "تصغير"],
    "help": ["مساعدة", "اوامر", "أوامر"],
    "duplicate": ["نسخ", "ازدواج", "مضاعفة"],
    "group": ["تجميع", "مجموعة", "تجميع"],
    "ungroup": ["فك التجميع", "تفكيك", "فك مجموعة"],
    "delete": ["حذف", "إزالة", "مسح", "احذف", "ازل"],
    "queue": ["تشغيل", "شغل", "تنفيذ"],
    "queueFront": ["تشغيل أمامي", "شغل أول", "أمامي"],
    "stop": ["إيقاف", "وقف", "أوقف"],
    "clear": ["تفريغ", "مسح الكل", "حذف الكل"],
    "refresh": ["تحديث", "إعادة تحميل", "تحميل"],
    "distributeH": ["توزيع أفقي", "أفقي"],
    "distributeV": ["توزيع عمودي", "عمودي"],
    "invert": ["عكس التحديد", "عكس"],
    "fullscreen": ["ملء الشاشة", "شاشة كاملة", "كامل"],
    "resetView": ["إعادة تعيين العرض", "تصغير الكل", "إعادة عرض"],
    "addNode": ["إضافة نود", "نود جديد", "إضافة"],
    "new": ["جديد", "ملف جديد", "مساحة جديدة"],
  };
  let _voiceLang = lsGet("voiceLang", "en");
  makePopup("Voice Commands", (body, ov) => {
    let _voiceRecTimer = null;
    let _voiceMicStream = null;
    let _voiceLiveEl = null;
    let _startFailed = false;
    body.innerHTML =
      '<div style="margin-bottom:8px;color:#aaa;font-size:10px;line-height:1.6">' +
      '<b>EN:</b> select all · select none · delete · mute · bypass · lock · copy · group · ungroup · collapse · <b>queue</b> · <b>queue front</b> · <b>stop</b> · <b>clear</b> · <b>invert</b> · <b>distribute h/v</b> · align · arrange · zoom · undo · redo · <b>fullscreen</b> · <b>reset view</b> · <b>add node</b> · <b>new</b> · <b>refresh</b> · help<br>' +
      '<b>AR:</b> تحديد الكل · إلغاء التحديد · حذف · كتم · تجاوز · قفل · نسخ · تجميع · فك التجميع · طي · <b>تشغيل</b> · <b>تشغيل أمامي</b> · <b>إيقاف</b> · <b>تفريغ</b> · <b>عكس</b> · <b>توزيع أفقي/عمودي</b> · محاذاة · ترتيب · تكبير · تراجع · إعادة · <b>ملء الشاشة</b> · <b>تصغير العرض</b> · <b>إضافة نود</b> · <b>جديد</b> · <b>تحديث</b> · مساعدة' +
      '</div>' + (isOpera ? '' : secMsg) + operaMsg;
    const status = document.createElement("div");
    status.style.cssText = "padding:8px;border:1px solid #333;border-radius:6px;margin-bottom:8px;text-align:center;font-size:13px;background:#2a2a2a;";
    status.textContent = _voiceActive ? "\u{1F3A4} Listening..." : "\u{1F507} Stopped";
    status.style.color = _voiceActive ? "#38c0c4" : "#888";
    body.appendChild(status);
    const liveEl = document.createElement("div");
    liveEl.style.cssText = "padding:4px 8px;border:1px solid #333;border-radius:4px;margin-bottom:6px;text-align:center;font-size:12px;color:#888;background:#1a1a1a;min-height:20px;";
    liveEl.textContent = "\u{1F3A4} Listening...";
    body.appendChild(liveEl);
    _voiceLiveEl = liveEl;
    const log = document.createElement("div");
    log.style.cssText = "max-height:150px;overflow-y:auto;font-size:11px;color:#888;border:1px solid #333;border-radius:4px;padding:4px;margin-bottom:8px;";
    log.innerHTML = '<div style="color:#555;">Voice log...</div>';
    body.appendChild(log);

    function _matchAr(t, cmd) {
      return AR[cmd] && AR[cmd].some(k => t.includes(k));
    }
    function _logEvent(ev) {
      log.innerHTML = '<div style="color:#aaa;font-size:10px;">\u{1F4DD} ' + esc(ev) + '</div>' + log.innerHTML;
      if (log.children.length > 30) log.removeChild(log.lastChild);
    }
    function _voiceWarmMic() {
      if (_voiceMicStream) return Promise.resolve();
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        return navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => { _voiceMicStream = s; }).catch(() => {});
      }
      return Promise.resolve();
    }
    function _voiceStartRec() {
      if (_voiceRecognition) { try { _voiceRecognition.abort(); } catch(e) {} }
      if (!_voiceActive) return;
      _voiceWarmMic();
      _logEvent("Creating SR instance...");
      const r = new SR();
      r.lang = _voiceLang === "ar" ? "ar-SA" : "en-US";
      r.continuous = false;
      r.interimResults = true;
      let _alignBuf = "";
      r.onstart = () => { _logEvent("onstart fired"); _startFailed = false; };
      r.onaudiostart = () => {
        _logEvent("onaudiostart - mic OPEN");
        if (_voiceLiveEl) _voiceLiveEl.textContent = "\u{1F3A4} Say a command...";
      };
      r.onaudioend = () => { _logEvent("onaudioend"); };
      r.onsoundstart = () => { _logEvent("onsoundstart - sound detected"); if (_voiceLiveEl) _voiceLiveEl.textContent = "\u{1F442} Hearing..."; };
      r.onsoundend = () => { _logEvent("onsoundend"); };
      r.onspeechstart = () => { _logEvent("onspeechstart - speech detected"); if (_voiceLiveEl) _voiceLiveEl.textContent = "\u{1F399} Speech..."; };
      r.onspeechend = () => { _logEvent("onspeechend"); };
      r.onresult = (e) => {
        _logEvent("onresult: " + e.results.length + " result(s)");
        let finalText = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) {
            finalText += e.results[i][0].transcript;
          } else {
            const interim = e.results[i][0].transcript;
            if (_voiceLiveEl) _voiceLiveEl.textContent = "\u{1F3A4} \u201C" + interim + "\u201D";
          }
        }
        if (!finalText) return;
        const raw = finalText.toLowerCase().trim();
        if (!raw) return;
        const words = raw.split(/\s+/);
        _logEvent("FINAL: \"" + raw + "\"");
        if (_voiceLiveEl) _voiceLiveEl.textContent = "\u{2705} \u201C" + raw + "\u201D";
        _alignBuf = (_alignBuf + " " + raw).trim();
        if (_alignBuf.length > 100) _alignBuf = raw;
        const t = _alignBuf;
        if (t.includes("select all") || words.includes("all") || _matchAr(t, "selectAll")) { _alignBuf = ""; app.canvas?.graph?.beforeChange(); for (const n of app.canvas?.graph?._nodes || []) n.selected = true; app.canvas?.graph?.afterChange(); app.canvas?.setDirty(true, true); showToast("Selected all"); }
        else if (t.includes("select none") || (words.includes("select") && words.includes("none")) || _matchAr(t, "selectNone")) { _alignBuf = ""; for (const n of app.canvas?.graph?._nodes || []) n.selected = false; app.canvas?.setDirty(true, true); showToast("Deselected all"); }
        else if (t.includes("mute") || t.includes("muted") || _matchAr(t, "mute")) { _alignBuf = ""; _voiceMute(); }
        else if (t.includes("bypass") || t.includes("bypassed") || t.includes("by pass") || _matchAr(t, "bypass")) { _alignBuf = ""; _voiceBypass(); }
        else if (t.includes("align") || t.includes("line") || _matchAr(t, "alignLeft") || _matchAr(t, "alignRight") || _matchAr(t, "alignCenter") || _matchAr(t, "alignTop") || _matchAr(t, "alignBottom")) {
          if (t.includes("left") || _matchAr(t, "alignLeft")) { _alignBuf = ""; _voiceAlign("x", "L"); }
          else if (t.includes("right") || t.includes("write") || t.includes("rate") || _matchAr(t, "alignRight")) { _alignBuf = ""; _voiceAlign("x", "R"); }
          else if (t.includes("center") || t.includes("centre") || t.includes("sent") || _matchAr(t, "alignCenter")) { _alignBuf = ""; _voiceAlign("x", "C"); }
          else if (t.includes("top") || _matchAr(t, "alignTop")) { _alignBuf = ""; _voiceAlign("y", "T"); }
          else if (t.includes("bottom") || _matchAr(t, "alignBottom")) { _alignBuf = ""; _voiceAlign("y", "B"); }
        }
        else if (t.includes("arrange") || t.includes("auto") || t.includes("smart") || t.includes("layout") || _matchAr(t, "arrange")) { _alignBuf = ""; _voiceArrange(); }
        else if (t.includes("zoom") || t.includes("fit") || _matchAr(t, "zoom")) { _alignBuf = ""; doZoomToFit(); }
        else if (t.includes("undo") || _matchAr(t, "undo")) { _alignBuf = ""; _voiceUndo(); }
        else if (t.includes("redo") || _matchAr(t, "redo")) { _alignBuf = ""; _voiceRedo(); }
        else if (t.includes("lock") || t.includes("locked") || _matchAr(t, "lock")) { _alignBuf = ""; _voiceLock(); }
        else if (t.includes("duplicate") || words.includes("copy") || t.includes("dup") || _matchAr(t, "duplicate")) { _alignBuf = ""; _voiceDuplicate(); }
        else if (t.includes("group") || _matchAr(t, "group")) { _alignBuf = ""; _voiceGroup(); }
        else if (t.includes("ungroup") || t.includes("un group") || _matchAr(t, "ungroup")) { _alignBuf = ""; _voiceUngroup(); }
        else if (words.includes("delete") || words.includes("remove") || words.includes("clear") || words.includes("del") || _matchAr(t, "delete")) { _alignBuf = ""; const sel = getSelectedArr(); if (sel.length) { app.canvas?.graph?.beforeChange(); for (const n of sel) app.canvas?.graph?.remove(n); app.canvas?.graph?.afterChange(); app.canvas?.setDirty(true, true); showToast("Deleted"); } }
      };
      r.onerror = (e) => {
        console.warn("[Voice] error:", e.error);
        _logEvent("ERROR: " + e.error);
        let msg = e.error;
        if (e.error === "not-allowed") {
          msg = "Microphone access denied. Check mic permissions and ensure you are using HTTPS or localhost.";
          if (!window.isSecureContext) msg += " (current page is not a secure context)";
        }
        status.textContent = "\u26A0 " + msg;
        status.style.color = "#e57373";
        if (_voiceLiveEl) _voiceLiveEl.textContent = "\u26A0 " + msg;
      };
      r.onend = () => {
        _logEvent("onend fired");
        if (_startFailed) {
          _logEvent("Native SR failed, trying proxy recording...");
          if (_voiceLiveEl) _voiceLiveEl.textContent = "\u{1F3A4} Proxy recording...";
          _voiceWarmMic().then(() => { if (_voiceActive) _voiceStartProxy(); });
          return;
        }
        if (_voiceActive) {
          _voiceRecTimer = setTimeout(() => { if (_voiceActive) _voiceStartRec(); }, 150);
        }
      };
      _voiceRecognition = r;
      _startFailed = true;
      const _startTimer = setTimeout(() => {
        if (_startFailed && _voiceActive) {
          _logEvent("Native SR timeout - switching to proxy...");
          try { r.abort(); } catch(e) {}
          if (_voiceLiveEl) _voiceLiveEl.textContent = "\u{1F3A4} Proxy recording...";
          _voiceWarmMic().then(() => { if (_voiceActive) _voiceStartProxy(); });
        }
      }, 1500);
      r.onstart = () => { _logEvent("onstart fired"); _startFailed = false; clearTimeout(_startTimer); };
      try {
        r.start();
        _logEvent("r.start() called");
        if (_voiceLiveEl) _voiceLiveEl.textContent = "\u{1F3A4} Starting mic...";
      } catch (e) {
        _logEvent("r.start() EXCEPTION: " + e.message);
        status.textContent = "\u26A0 " + e.message;
        status.style.color = "#e57373";
        if (_voiceLiveEl) _voiceLiveEl.textContent = "\u26A0 " + e.message;
        _voiceActive = false;
      }
    }
    let _voiceProxyCtx = null;
    let _voiceProxyTimeout = null;
    let _voiceProxyRunning = false;
    let _voiceProxyMr = null;
    let _voiceProxyMrChunks = null;
    function _voiceProxyProcess(text) {
      if (!_voiceLiveEl) return;
      const raw = text.toLowerCase().trim();
      if (!raw) return;
      const words = raw.split(/\s+/);
      _logEvent('PROXY: "' + raw + '"');
      if (_voiceLiveEl) _voiceLiveEl.textContent = "\u{2705} \u201C" + raw + "\u201D";
      const t = raw;
      if (t.includes("select all") || words.includes("all") || _matchAr(t, "selectAll")) { app.canvas?.graph?.beforeChange(); for (const n of app.canvas?.graph?._nodes || []) n.selected = true; app.canvas?.graph?.afterChange(); app.canvas?.setDirty(true, true); showToast("Selected all"); }
      else if (t.includes("select none") || (words.includes("select") && words.includes("none")) || _matchAr(t, "selectNone")) { for (const n of app.canvas?.graph?._nodes || []) n.selected = false; app.canvas?.setDirty(true, true); showToast("Deselected all"); }
      else if (words.includes("delete") || words.includes("remove") || words.includes("del") || _matchAr(t, "delete")) { const sel = getSelectedArr(); if (sel.length) { app.canvas?.graph?.beforeChange(); for (const n of sel) app.canvas?.graph?.remove(n); app.canvas?.graph?.afterChange(); app.canvas?.setDirty(true, true); showToast("Deleted"); } }
      else if (_matchAr(t, "clear") || t.includes("clear all") || t.includes("clear everything") || t.includes("clear workflow") || t.includes("new canvas")) { const g = app.canvas?.graph; if (g) { g.beforeChange(); for (const n of [...g._nodes]) g.remove(n); g.afterChange(); app.canvas?.setDirty(true, true); showToast("Cleared all nodes"); } }
      else if ((t.includes("new workflow") || t.includes("new canvas") || _matchAr(t, "new")) && !t.includes("add node") && !t.includes("new node") && !t.includes("search")) { if (confirm("Clear canvas and start new workflow?")) { const g = app.canvas?.graph; if (g) { g.beforeChange(); for (const n of [...g._nodes]) g.remove(n); g.afterChange(); app.canvas?.setDirty(true, true); showToast("New workflow"); } } }
      else if (_matchAr(t, "invert") || t.includes("invert selection") || (words.includes("invert") && words.includes("selection"))) { const g = app.canvas?.graph; if (g) { g.beforeChange(); for (const n of g._nodes) n.selected = !n.selected; g.afterChange(); app.canvas?.setDirty(true, true); showToast("Inverted selection"); } }
      else if (_matchAr(t, "queue") || t.includes("queue prompt") || (words.includes("queue") && !words.includes("front")) || t.includes("run workflow") || t.includes("run prompt")) { _voiceQueue(false); }
      else if (_matchAr(t, "queueFront") || t.includes("queue front") || t.includes("queue first") || (words.includes("queue") && words.includes("front"))) { _voiceQueue(true); }
      else if (_matchAr(t, "stop") || t.includes("stop") || t.includes("interrupt") || t.includes("cancel")) { _voiceStopQueue(); }
      else if (_matchAr(t, "refresh") || t.includes("refresh") || t.includes("reload")) { location.reload(); }
      else if (t.includes("mute") || t.includes("muted") || _matchAr(t, "mute")) { _voiceMute(); }
      else if (t.includes("bypass") || t.includes("bypassed") || t.includes("by pass") || _matchAr(t, "bypass")) { _voiceBypass(); }
      else if (t.includes("lock") || t.includes("locked") || _matchAr(t, "lock")) { _voiceLock(); }
      else if (t.includes("duplicate") || words.includes("copy") || t.includes("dup") || _matchAr(t, "duplicate")) { _voiceDuplicate(); }
      else if (t.includes("ungroup") || t.includes("un group") || t.includes("un-group") || _matchAr(t, "ungroup")) { _voiceUngroup(); }
      else if (t.includes("group") || _matchAr(t, "group")) { _voiceGroup(); }
      else if (t.includes("align") || _matchAr(t, "alignLeft") || _matchAr(t, "alignRight") || _matchAr(t, "alignCenter") || _matchAr(t, "alignTop") || _matchAr(t, "alignBottom")) {
        if (t.includes("left") || _matchAr(t, "alignLeft")) { _voiceAlign("x", "L"); }
        else if (t.includes("right") || t.includes("write") || t.includes("rate") || _matchAr(t, "alignRight")) { _voiceAlign("x", "R"); }
        else if (t.includes("center") || t.includes("centre") || t.includes("sent") || _matchAr(t, "alignCenter")) { _voiceAlign("x", "C"); }
        else if (t.includes("top") || _matchAr(t, "alignTop")) { _voiceAlign("y", "T"); }
        else if (t.includes("bottom") || _matchAr(t, "alignBottom")) { _voiceAlign("y", "B"); }
      }
      else if (t.includes("arrange") || t.includes("auto") || t.includes("smart") || t.includes("layout") || _matchAr(t, "arrange")) { _voiceArrange(); }
      else if (_matchAr(t, "distributeH") || t.includes("distribute h") || t.includes("distribute horizontally") || t.includes("space horizontal")) { _voiceDistribute("x"); }
      else if (_matchAr(t, "distributeV") || t.includes("distribute v") || t.includes("distribute vertically") || t.includes("space vertical")) { _voiceDistribute("y"); }
      else if (t.includes("zoom") || t.includes("fit") || _matchAr(t, "zoom")) { doZoomToFit(); }
      else if (t.includes("undo") || _matchAr(t, "undo")) { _voiceUndo(); }
      else if (t.includes("redo") || _matchAr(t, "redo")) { _voiceRedo(); }
      else if (t.includes("collapse") || t.includes("collapsed") || words.includes("fold") || _matchAr(t, "collapse")) { const sel = getSelectedArr(); if (sel.length) { const c = app.canvas; if (c) { c.graph?.beforeChange(); for (const n of sel) n.flags.collapsed = !n.flags.collapsed; c.graph?.afterChange(); c.setDirty(true, true); showToast("Toggled collapse on " + sel.length + " node(s)"); } } else showToast("No nodes selected"); }
      else if (_matchAr(t, "fullscreen") || t.includes("fullscreen") || t.includes("full screen") || (words.includes("full") && words.includes("screen"))) { if (!document.fullscreenElement) document.documentElement.requestFullscreen(); else document.exitFullscreen(); showToast(document.fullscreenElement ? "Fullscreen" : "Windowed"); }
      else if (_matchAr(t, "resetView") || t.includes("reset view") || t.includes("reset zoom") || t.includes("fit all")) { const c = app.canvas; if (c) { c.ds?.offset && (c.ds.offset[0] = 0, c.ds.offset[1] = 0); c.ds?.scale && (c.ds.scale = 1); c.setDirty(true, true); showToast("View reset"); } }
      else if (_matchAr(t, "addNode") || t.includes("add node") || t.includes("new node") || t.includes("search node") || t.includes("insert node")) { const c = app.canvas; if (c && typeof c.showSearchBox === 'function') c.showSearchBox(); else showToast("Node search not available"); }
      else if (t.includes("help") || words.includes("commands") || t.includes("what") || _matchAr(t, "help")) { showToast("Say: select all, delete, mute, bypass, lock, copy, group, ungroup, collapse, align, arrange, zoom, undo, redo, queue, stop, invert, clear, new, fullscreen, help"); }
    }
    function _voiceStartProxy() {
      if (!_voiceMicStream) { _logEvent("No mic stream for proxy"); return; }
      if (_voiceProxyRunning) { _logEvent("Proxy already running, skipping"); return; }
      _voiceProxyRunning = true;
      _logEvent("Starting proxy recording...");
      if (_voiceLiveEl) _voiceLiveEl.textContent = "\u{1F3A4} Recording...";
      const chunks = [];
      const mr = new MediaRecorder(_voiceMicStream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm' });
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      mr.onstop = () => { _voiceFinishProxy(chunks); };
      mr.start();
      _voiceProxyMr = mr;
      _voiceProxyMrChunks = chunks;
      _voiceProxyTimeout = setTimeout(() => {
        if (_voiceActive && mr.state === 'recording') { mr.stop(); }
      }, 5000);
    }
    async function _voiceFinishProxy(chunks) {
      _voiceProxyRunning = false;
      if (_voiceProxyTimeout) { clearTimeout(_voiceProxyTimeout); _voiceProxyTimeout = null; }
      _voiceProxyMr = null; _voiceProxyMrChunks = null;
      if (!_voiceActive) return;
      const blob = new Blob(chunks, { type: chunks.length ? chunks[0].type : 'audio/webm' });
      if (blob.size < 200) { _logEvent("Recording too short (" + blob.size + "B), continuing..."); if (_voiceLiveEl) _voiceLiveEl.textContent = "\u{1F3A4} Proxy recording..."; if (_voiceActive) setTimeout(() => _voiceStartProxy(), 500); return; }
      _logEvent("Sending " + (blob.size / 1024).toFixed(0) + "KB audio to server...");
      if (_voiceLiveEl) _voiceLiveEl.textContent = "\u{1F4E4} Transcribing...";
      try {
        const fd = new FormData();
        fd.append("audio", blob, "voice." + (chunks.length && chunks[0].type.includes('webm') ? 'webm' : 'ogg'));
        fd.append("lang", _voiceLang === "ar" ? "ar-SA" : "en-US");
        const resp = await fetch("/livedev/transcribe", { method: "POST", body: fd });
        const data = await resp.json();
        if (data.text) {
          _voiceProxyProcess(data.text);
        } else if (data.error) {
          _logEvent("Proxy error: " + data.error);
          if (_voiceLiveEl) _voiceLiveEl.textContent = "\u26A0 " + data.error;
        }
      } catch(e) {
        _logEvent("Proxy fetch error: " + e.message);
        if (_voiceLiveEl) _voiceLiveEl.textContent = "\u26A0 " + e.message;
      }
      if (_voiceActive) {
        setTimeout(() => { if (_voiceActive) _voiceStartProxy(); }, 300);
      }
    }
    function _voiceStopProxy() {
      _voiceProxyRunning = false;
      if (_voiceProxyTimeout) { clearTimeout(_voiceProxyTimeout); _voiceProxyTimeout = null; }
      if (_voiceProxyMr && _voiceProxyMr.state === 'recording') { try { _voiceProxyMr.stop(); } catch(e) {} }
      _voiceProxyMr = null; _voiceProxyMrChunks = null;
    }
    async function startListening() {
      _voiceStopProxy();
      if (_voiceRecTimer) clearTimeout(_voiceRecTimer);
      if (_voiceRecognition) { try { _voiceRecognition.abort(); } catch(e) {} }
      _voiceActive = true;
      status.textContent = "\u{1F3A4} Listening..."; status.style.color = "#38c0c4";
      await _voiceWarmMic();
      if (isOpera) {
        if (_voiceLiveEl) _voiceLiveEl.textContent = "\u{1F3A4} Proxy recording...";
        _voiceStartProxy();
      } else {
        _voiceStartRec();
      }
    }
    function stopListening() {
      if (_voiceRecTimer) clearTimeout(_voiceRecTimer);
      if (_voiceRecognition) { try { _voiceRecognition.abort(); } catch(e) {} _voiceRecognition = null; }
      _voiceStopProxy();
      if (_voiceMicStream) { try { _voiceMicStream.getTracks().forEach(t => t.stop()); } catch(e) {} _voiceMicStream = null; }
      _voiceActive = false; status.textContent = "\u{1F507} Stopped"; status.style.color = "#888"; if (_voiceLiveEl) _voiceLiveEl.textContent = "\u{1F507} Stopped";
    }
    const langBtn = document.createElement("button");
    langBtn.textContent = "\u{1F310} EN";
    langBtn.title = "Switch language";
    langBtn.style.cssText = "padding:6px 10px;border:1px solid #aaa;border-radius:5px;cursor:pointer;font-size:12px;font-family:monospace;color:#aaa;background:transparent;margin:2px;";
    langBtn.addEventListener("mouseenter", () => langBtn.style.background = "rgba(255,255,255,0.07)");
    langBtn.addEventListener("mouseleave", () => langBtn.style.background = "transparent");
    langBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      _voiceLang = _voiceLang === "ar" ? "en" : "ar";
      langBtn.textContent = "\u{1F310} " + (_voiceLang === "ar" ? "AR" : "EN");
      if (_voiceActive) { stopListening(); startListening(); }
    });
    const startBtn = document.createElement("button");
    startBtn.textContent = "\u25B6 Start"; startBtn.title = "Start voice recognition";
    startBtn.style.cssText = "padding:6px 14px;border:1px solid #38c0c4;border-radius:5px;cursor:pointer;font-size:13px;font-family:monospace;color:#38c0c4;background:transparent;margin:2px;";
    startBtn.addEventListener("mouseenter", () => startBtn.style.background = "rgba(76,175,80,0.1)");
    startBtn.addEventListener("mouseleave", () => startBtn.style.background = "transparent");
    startBtn.addEventListener("click", (e) => { e.stopPropagation(); startListening(); });
    const stopBtn = document.createElement("button");
    stopBtn.textContent = "\u23F9 Stop"; stopBtn.title = "Stop voice recognition";
    stopBtn.style.cssText = "padding:6px 14px;border:1px solid #e57373;border-radius:5px;cursor:pointer;font-size:13px;font-family:monospace;color:#e57373;background:transparent;margin:2px;";
    stopBtn.addEventListener("mouseenter", () => stopBtn.style.background = "rgba(229,115,115,0.1)");
    stopBtn.addEventListener("mouseleave", () => stopBtn.style.background = "transparent");
    stopBtn.addEventListener("click", (e) => { e.stopPropagation(); stopListening(); });
    const btnRow = document.createElement("div"); btnRow.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;";
    btnRow.appendChild(langBtn); btnRow.appendChild(startBtn); btnRow.appendChild(stopBtn);
    body.appendChild(btnRow);
    const hint = document.createElement("div");
    hint.style.cssText = "margin-top:8px;font-size:10px;color:#555;";
    hint.textContent = "Available: select all/none, mute, bypass, align left/right/center/top/bottom, arrange, zoom, undo, redo, lock, duplicate, group, ungroup, delete";
    body.appendChild(hint);
  });
}

// === 12. Node Sandbox ===
export function doNodeSandbox() {
  makePopup("Node Sandbox", (body) => {
    body.innerHTML = '<div style="margin-bottom:8px;color:#888;font-size:11px;">Test node output in isolation. Enter a node type to create, then run it.</div>';
    const row = document.createElement("div"); row.style.cssText = "display:flex;gap:4px;margin-bottom:8px;";
    const inp = document.createElement("input"); inp.type = "text"; inp.placeholder = "Node type (e.g. CLIPTextEncode)...";
    inp.style.cssText = "flex:1;padding:4px 8px;border:1px solid #555;border-radius:4px;background:#2a2a2a;color:#ddd;font-size:12px;";
    row.appendChild(inp);
    const addBtn = btn("\u2795 Add", "", "#38c0c4", () => {
      const t = inp.value.trim();
      if (!t) { showToast("Enter a node type"); return; }
      if (!app.canvas?.graph) return;
      try {
        const node = LiteGraph.createNode(t);
        if (!node) { showToast("Node type not found: " + t); return; }
        node.pos = [100, 100];
        app.canvas.graph.add(node);
        app.canvas.setDirty(true, true);
        showToast("Added: " + t);
      } catch(e) { showToast("Error: " + e.message); }
    });
    row.appendChild(addBtn);
    body.appendChild(row);
    const hint2 = document.createElement("div");
    hint2.style.cssText = "margin-top:8px;font-size:12px;color:#aaa;";
    hint2.textContent = "Or select a node in the workspace and test it:";
    body.appendChild(hint2);
    const sel = getSelectedArr();
    if (sel.length === 1) {
      const n = sel[0];
      const infoDiv = document.createElement("div");
      infoDiv.style.cssText = "padding:8px;border:1px solid #333;border-radius:4px;margin-top:4px;font-size:11px;";
      infoDiv.innerHTML = '<span style="color:#888;">[' + esc(n.type) + ']</span> ' + esc(n.title || "") + '<br><span style="color:#555;">widgets: ' + (n.widgets?.length || 0) + ', inputs: ' + (n.inputs?.length || 0) + ', outputs: ' + (n.outputs?.length || 0) + '</span>';
      body.appendChild(infoDiv);
      const cloneBtn = document.createElement("button");
      cloneBtn.textContent = "\u{1F3AC} Clone isolated";
      cloneBtn.style.cssText = "padding:5px 10px;border:1px solid #38c0c4;border-radius:5px;cursor:pointer;font-size:12px;font-family:monospace;color:#38c0c4;background:transparent;margin-top:4px;";
      cloneBtn.addEventListener("mouseenter", () => cloneBtn.style.background = "rgba(100,181,246,0.1)");
      cloneBtn.addEventListener("mouseleave", () => cloneBtn.style.background = "transparent");
      cloneBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const g = app.canvas?.graph; if (!g) return;
        const clone = LiteGraph.createNode(n.type);
        if (!clone) { showToast("Cannot clone"); return; }
        clone.pos = [n.pos[0] + 300, n.pos[1]];
        clone.title = n.title + " (sandbox)";
        if (n.widgets_values) clone.widgets_values = [...n.widgets_values];
        if (n.properties) clone.properties = { ...n.properties };
        g.add(clone);
        g.beforeChange(); g.afterChange();
        app.canvas?.setDirty(true, true);
        showToast("Cloned to sandbox");
      });
      body.appendChild(cloneBtn);
    } else {
      const noSel = document.createElement("div");
      noSel.style.cssText = "color:#888;margin-top:4px;";
      noSel.textContent = "Select a single node to sandbox";
      body.appendChild(noSel);
    }
  });
}

// === 13. Smart Auto-Layout ===
export function doSmartAutoLayout() {
  const g = app.canvas?.graph;
  if (!g) return;
  const nodes = g._nodes || [];
  if (nodes.length < 2) { showToast("Need 2+ nodes"); return; }
  saveToolbarState();
  g.beforeChange();

  // Build adjacency
  const inEdges = new Map(), outEdges = new Map();
  for (const n of nodes) { inEdges.set(n.id, []); outEdges.set(n.id, []); }
  for (const n of nodes) {
    if (!n.inputs) continue;
    for (const inp of n.inputs) {
      if (!inp.link) continue;
      const link = g.links?.[inp.link];
      if (!link) continue;
      if (inEdges.has(n.id)) inEdges.get(n.id).push(link.origin_id);
      if (outEdges.has(link.origin_id)) outEdges.get(link.origin_id).push(n.id);
    }
  }

  // Compute depth via BFS from sources
  const depth = new Map();
  for (const n of nodes) depth.set(n.id, 0);
  const queue = [];
  for (const n of nodes) if (inEdges.get(n.id).length === 0) queue.push(n.id);
  if (queue.length === 0) for (const n of nodes) queue.push(n.id);
  const visited = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    for (const targetId of outEdges.get(id)) {
      depth.set(targetId, Math.max(depth.get(targetId), depth.get(id) + 1));
      queue.push(targetId);
    }
  }

  // Find groups and their members
  const groupMembers = new Map(), nodeToGroup = new Map();
  if (g._groups) {
    for (let gi = 0; gi < g._groups.length; gi++) {
      const grp = g._groups[gi];
      const members = [];
      for (const n of nodes) {
        const nx = n.pos[0], ny = n.pos[1];
        if (nx >= grp.pos[0] && ny >= grp.pos[1] && nx <= grp.pos[0] + grp.size[0] && ny <= grp.pos[1] + grp.size[1]) {
          members.push(n.id); nodeToGroup.set(n.id, gi);
        }
      }
      if (members.length > 0) groupMembers.set(gi, members);
    }
  }

  // Build items (node or group block), assign depth
  const used = new Set();
  const items = [];
  for (const n of nodes) {
    if (used.has(n.id)) continue;
    const gi = nodeToGroup.get(n.id);
    if (gi !== undefined && groupMembers.has(gi)) {
      const memberIds = groupMembers.get(gi);
      const groupNodes = memberIds.map(id => nodes.find(nn => nn.id === id)).filter(Boolean);
      for (const id of memberIds) used.add(id);
      const avgDepth = Math.round(groupNodes.reduce((s, nn) => s + (depth.get(nn.id) ?? 0), 0) / groupNodes.length);
      items.push({ isGroup: true, depth: avgDepth, nodes: groupNodes, group: g._groups[gi] });
      groupMembers.delete(gi);
    } else {
      used.add(n.id);
      items.push({ isGroup: false, depth: depth.get(n.id) ?? 0, nodes: [n], w: n.size?.[0] || 250, h: n.size?.[1] || 150 });
    }
  }
  if (items.length < 2) { g.afterChange(); showToast("Cannot determine layout flow"); return; }

  // Group items by depth into columns (left-to-right flow)
  const colMap = new Map();
  for (const item of items) {
    const d = item.depth;
    if (!colMap.has(d)) colMap.set(d, []);
    colMap.get(d).push(item);
  }

  // Sort items within each column by original Y position
  for (const [, col] of colMap) {
    col.sort((a, b) => {
      const ay = a.nodes.reduce((s, nn) => s + (nn.pos[1] || 0), 0) / a.nodes.length;
      const by = b.nodes.reduce((s, nn) => s + (nn.pos[1] || 0), 0) / b.nodes.length;
      return ay - by;
    });
  }

  // Position columns left-to-right by depth
  const gap = 30;
  const margin = 30;
  const sortedDepths = [...colMap.keys()].sort((a, b) => a - b);
  let cx = margin;
  for (const d of sortedDepths) {
    const col = colMap.get(d);
    let maxW = 0, totalH = 0;
    for (const item of col) {
      if (item.isGroup) {
        if (item.group.size[0] > maxW) maxW = item.group.size[0];
        totalH += item.group.size[1] + gap;
      } else {
        if (item.w > maxW) maxW = item.w;
        totalH += item.h + gap;
      }
    }
    totalH -= gap;
    // Center column vertically
    let cy = margin;
    for (const item of col) {
      if (item.isGroup) {
        const grp = item.group;
        const origLeft = grp.pos[0], origTop = grp.pos[1];
        const dx = cx - origLeft, dy = cy - origTop;
        for (const nn of item.nodes) nn.pos = [nn.pos[0] + dx, nn.pos[1] + dy];
        grp.pos = [cx, cy];
        cy += grp.size[1] + gap;
      } else {
        const nn = item.nodes[0];
        nn.pos = [cx + (maxW - (nn.size?.[0] || 250)) / 2, cy];
        cy += (nn.size?.[1] || 150) + gap;
      }
    }
    cx += maxW + gap;
  }
  g.afterChange();
  app.canvas?.setDirty(true, true);
  showToast("Auto-layout complete (" + sortedDepths.length + " columns)");
}

// Voice command helpers (inline to avoid circular imports)
async function _voiceQueue(front) {
  try {
    const prompt = await app.graphToPrompt?.();
    if (!prompt) { 
      const btns = document.querySelectorAll("button");
      for (const b of btns) { if (b.textContent.includes("Queue") && b.textContent.includes("Prompt")) { b.click(); showToast("Queued"); return; } }
      showToast("Queue not available"); return;
    }
    const body = { prompt: prompt.workflow, front: !!front };
    const resp = await fetch("/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (resp.ok) showToast(front ? "Queued (front)" : "Queued"); else showToast("Queue failed: " + (await resp.text()).slice(0, 50));
  } catch(e) { showToast("Queue error: " + e.message); }
}
async function _voiceStopQueue() {
  try { const resp = await fetch("/interrupt", { method: "POST" }); if (resp.ok) showToast("Interrupted"); else showToast("Stop failed"); } catch(e) { showToast("Stop error"); }
}
function _voiceDistribute(axis) {
  const nodes = getSelectedArr(); if (nodes.length < 3) { showToast("Select 3+ nodes to distribute"); return; }
  const c = app.canvas; if (!c) return;
  const defaultTitleH = typeof LiteGraph !== "undefined" && Number.isFinite(LiteGraph.NODE_TITLE_HEIGHT) ? LiteGraph.NODE_TITLE_HEIGHT : 30;
  const getBox = (n) => {
    const isGrp = typeof n.recomputeInsideNodes === "function";
    const titleH = isGrp || n.constructor?.title_mode === 2 || n.title_mode === 2 ? 0 : defaultTitleH;
    const x = Number(n.pos?.[0]) || 0;
    const y = Number(n.pos?.[1]) || 0;
    const w = n.flags?.collapsed ? (Number(n._collapsed_width) || 140) : (Number(n.size?.[0]) || 200);
    const bodyH = n.flags?.collapsed ? 0 : (Number(n.size?.[1]) || 100);
    return { left: x, right: x + w, top: y - titleH, bottom: y + bodyH, w, h: bodyH + titleH, titleH, cx: x + w / 2, cy: y - titleH + (bodyH + titleH) / 2 };
  };
  c.graph?.beforeChange();
  const entries = nodes.map((n) => ({ n, b: getBox(n) })).sort((a, b) =>
    axis === "x" ? (a.b.cx - b.b.cx) || (a.b.left - b.b.left) : (a.b.cy - b.b.cy) || (a.b.top - b.b.top)
  );
  const firstStart = axis === "x" ? entries[0].b.left : entries[0].b.top;
  const lastEnd = axis === "x" ? entries[entries.length - 1].b.right : entries[entries.length - 1].b.bottom;
  const totalSize = entries.reduce((s, e) => s + (axis === "x" ? e.b.w : e.b.h), 0);
  const rawGap = (lastEnd - firstStart - totalSize) / (entries.length - 1);
  const gap = rawGap < 0 ? 20 : rawGap;
  let cursor = firstStart;
  for (let i = 0; i < entries.length; i++) {
    const { n, b } = entries[i];
    if (i > 0) {
      if (axis === "x") n.pos = [Math.round(cursor), n.pos[1]];
      else n.pos = [n.pos[0], Math.round(cursor + b.titleH)];
    }
    cursor += (axis === "x" ? b.w : b.h) + gap;
  }
  c.graph?.afterChange(); c.graph?.change?.(); c.setDirty(true, true);
  if (typeof c.draw === "function") c.draw(true, true);
  showToast("Distributed " + (axis === "x" ? "horizontally" : "vertically"));
}
function _voiceMute() {
  const nodes = getSelectedArr(); if (!nodes.length) { showToast("No nodes selected"); return; }
  const c = app.canvas; if (!c) return;
  c.graph?.beforeChange();
  for (const n of nodes) { n.mode = n.mode === 2 ? 0 : 2; n.trigger?.("property:changed", { property: "mode", value: n.mode }); }
  c.graph?.afterChange(); c.change?.(); c.setDirty(true, true);
  showToast("Toggled mute on " + nodes.length + " node(s)");
}
function _voiceBypass() {
  const nodes = getSelectedArr(); if (!nodes.length) { showToast("No nodes selected"); return; }
  const c = app.canvas; if (!c) return;
  c.graph?.beforeChange();
  for (const n of nodes) { n.mode = n.mode === 4 ? 0 : 4; n.trigger?.("property:changed", { property: "mode", value: n.mode }); }
  c.graph?.afterChange(); c.change?.(); c.setDirty(true, true);
  showToast("Toggled bypass on " + nodes.length + " node(s)");
}
function _voiceLock() {
  const nodes = getSelectedArr(); if (!nodes.length) { showToast("No nodes selected"); return; }
  const c = app.canvas; if (!c) return;
  c.graph?.beforeChange();
  for (const n of nodes) { n.flags.pinned = !n.flags.pinned; }
  c.graph?.afterChange(); c.setDirty(true, true);
  showToast("Toggled lock on " + nodes.length + " node(s)");
}
function _voiceDuplicate() {
  const c = app.canvas; if (!c) return;
  if (typeof c.copyToClipboard === "function" && typeof c.pasteFromClipboard === "function") { c.copyToClipboard(); c.pasteFromClipboard(); c.setDirty(true, true); showToast("Duplicated"); }
}
function _voiceGroup() {
  const nodes = getSelectedArr(); if (nodes.length < 2) { showToast("Select 2+ nodes to group"); return; }
  const c = app.canvas; if (!c || !c.graph) return;
  c.graph.beforeChange();
  const minX = Math.min(...nodes.map(n => n.pos[0])), minY = Math.min(...nodes.map(n => n.pos[1]));
  const maxX = Math.max(...nodes.map(n => n.pos[0] + (n.size?.[0] || 200))), maxY = Math.max(...nodes.map(n => n.pos[1] + (n.size?.[1] || 100)));
  const g = new LiteGraph.LGraphGroup(); g.title = "Group"; g.pos = [minX - 20, minY - 30]; g.size = [maxX - minX + 40, maxY - minY + 40];
  c.graph._groups.push(g); c.graph.afterChange(); c.setDirty(true, true);
  showToast("Group created");
}
function _voiceUngroup() {
  const nodes = getSelectedArr(); if (!nodes.length) { showToast("No nodes selected"); return; }
  const c = app.canvas; if (!c || !c.graph) return;
  c.graph.beforeChange();
  c.graph._groups = c.graph._groups.filter(g => !nodes.some(n => n.pos[0] >= g.pos[0] && n.pos[1] >= g.pos[1] && n.pos[0] <= g.pos[0] + g.size[0] && n.pos[1] <= g.pos[1] + g.size[1]));
  c.graph.afterChange(); c.setDirty(true, true);
  showToast("Groups removed");
}
function _snapshotAll() {
  const g = app.canvas?.graph; if (!g) return {};
  const s = {};
  for (const n of g._nodes) {
    s[n.id] = {
      pos: [...n.pos],
      size: n.size ? [...n.size] : null,
      color: n.color, bgcolor: n.bgcolor, mode: n.mode,
      flags: n.flags ? { ...n.flags } : {},
      title: n.title,
      widgets_values: n.widgets_values ? [...n.widgets_values] : null,
      properties: n.properties ? { ...n.properties } : null,
      inputs: n.inputs ? n.inputs.map(inp => ({ link: inp.link })) : null,
    };
  }
  return s;
}
function _voiceUndo() {
  if (!window._undoStack.length) return;
  const c = app.canvas; if (!c || !c.graph) return;
  window._redoStack.push(_snapshotAll());
  if (window._redoStack.length > 20) window._redoStack.shift();
  restoreToolbarState(window._undoStack.pop());
}
function _voiceRedo() {
  if (!window._redoStack.length) return;
  const c = app.canvas; if (!c || !c.graph) return;
  window._undoStack.push(_snapshotAll());
  if (window._undoStack.length > 20) window._undoStack.shift();
  restoreToolbarState(window._redoStack.pop());
}
function _voiceAlign(axis, edge) {
  const nodes = getSelectedArr(); if (nodes.length < 2) { showToast("Select 2+ nodes to align"); return; }
  const c = app.canvas; if (!c) return;
  c.graph?.beforeChange();
  if (axis === "x") {
    const ref = edge === "L" ? Math.min(...nodes.map(n => n.pos[0])) : edge === "R" ? Math.max(...nodes.map(n => n.pos[0] + (n.size?.[0] || 200))) : (Math.min(...nodes.map(n => n.pos[0] + (n.size?.[0] || 200) / 2)) + Math.max(...nodes.map(n => n.pos[0] + (n.size?.[0] || 200) / 2))) / 2;
    for (const n of nodes) { const w = n.size?.[0] || 200; n.pos = [edge === "L" ? ref : edge === "R" ? ref - w : ref - w / 2, n.pos[1]]; }
  } else {
    const ref = edge === "T" ? Math.min(...nodes.map(n => n.pos[1])) : edge === "B" ? Math.max(...nodes.map(n => n.pos[1] + (n.size?.[1] || 100))) : (Math.min(...nodes.map(n => n.pos[1] + (n.size?.[1] || 100) / 2)) + Math.max(...nodes.map(n => n.pos[1] + (n.size?.[1] || 100) / 2))) / 2;
    for (const n of nodes) { const h = n.size?.[1] || 100; n.pos = [n.pos[0], edge === "T" ? ref : edge === "B" ? ref - h : ref - h / 2]; }
  }
  c.graph?.afterChange(); c.setDirty(true, true);
  showToast("Aligned " + nodes.length + " nodes");
}
function _voiceArrange() {
  const nodes = getSelectedArr(); if (nodes.length < 2) { showToast("Select 2+ nodes to arrange"); return; }
  const c = app.canvas; if (!c) return;
  const sorted = [...nodes].sort((a, b) => a.pos[0] - b.pos[0]);
  c.graph?.beforeChange();
  let cx = sorted[0].pos[0]; const baseY = sorted[0].pos[1];
  for (const n of sorted) { n.pos = [cx, baseY]; cx += (n.size?.[0] || 200) + 30; }
  c.graph?.afterChange(); c.setDirty(true, true);
  showToast("Arranged " + nodes.length + " nodes");
}
