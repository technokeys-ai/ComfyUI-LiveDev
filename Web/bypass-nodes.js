// Bypass Nodes LiveDev - glassmorphic remote Bypass/Mute control board.
//
// Controls individual nodes (including inside Subgraphs), custom collapsible decks, and
// ComfyUI canvas groups without wires. Includes 1-click camera jump, per-row Bypass/Mute
// mode switch, compact dashboard lock mode, inline renaming, and smart broken-ID recovery.

import { app } from "../../scripts/app.js";
import { showToast, esc } from "./utils.js";
import {
  ACCENT,
  DANGER,
  FONT_MONO,
  LD_ICONS,
  createGlassModal,
  ensureTheme,
} from "./livedev-theme.js";

const NODE_TYPE = "LiveDev_BypassNodes";
const STATE_PROP = "liveDevBypassData";
const MODE_ACTIVE = 0;
const MODE_MUTE = 2;
const MODE_BYPASS = 4;

const MIN_W = 290;
const DEFAULT_W = 330;

function makeUid() {
  return "g_" + Math.random().toString(36).slice(2, 9);
}

function defaultState() {
  return {
    compact: false,
    items: [], // [{ kind: "node"|"group", id, sgId, label, nodeType, offMode: 4|2 }]
    decks: [], // [{ id, name, collapsed, items: [...] }]
  };
}

function readState(node) {
  const raw = node?.properties?.[STATE_PROP];
  if (!raw || typeof raw !== "object") {
    const fresh = defaultState();
    if (node) {
      node.properties = node.properties || {};
      node.properties[STATE_PROP] = fresh;
    }
    return fresh;
  }
  return {
    compact: Boolean(raw.compact),
    items: Array.isArray(raw.items) ? raw.items : [],
    decks: Array.isArray(raw.decks) ? raw.decks : [],
  };
}

function saveState(node, st) {
  node.properties = node.properties || {};
  node.properties[STATE_PROP] = st;
  const g = node.graph || app.canvas?.graph || app.graph;
  g?.change?.();
}

// ----------------------------------------------------------------------------
// Graph & Subgraph target discovery + resolution
// ----------------------------------------------------------------------------

function collectAllGraphs() {
  const root = app.graph || app.canvas?.graph;
  const graphs = [];
  const seen = new Set();
  const walk = (g, sgId, sgName) => {
    if (!g || seen.has(g)) return;
    seen.add(g);
    graphs.push({ graph: g, sgId: sgId || "", sgName: sgName || "" });
    const subs = g.subgraphs;
    if (subs instanceof Map) {
      for (const [id, sg] of subs.entries()) {
        walk(sg, String(id), String(sg?.name || `Subgraph ${id}`));
      }
    } else if (subs && typeof subs === "object") {
      for (const [id, sg] of Object.entries(subs)) {
        walk(sg, String(id), String(sg?.name || `Subgraph ${id}`));
      }
    }
  };
  walk(root, "", "");
  if (app.canvas?.graph && !seen.has(app.canvas.graph)) {
    walk(app.canvas.graph, String(app.canvas.graph.id || ""), String(app.canvas.graph.name || ""));
  }
  return graphs;
}

function findGraphBySgId(sgId) {
  const all = collectAllGraphs();
  if (!sgId) return all[0]?.graph || app.graph || app.canvas?.graph;
  const match = all.find((entry) => entry.sgId === String(sgId));
  return match ? match.graph : null;
}

function getNodesInCanvasGroup(group, graph) {
  if (!group || !graph) return [];
  const gx = Number(group.pos?.[0] ?? group._pos?.[0] ?? 0);
  const gy = Number(group.pos?.[1] ?? group._pos?.[1] ?? 0);
  const gw = Number(group.size?.[0] ?? group._size?.[0] ?? 0);
  const gh = Number(group.size?.[1] ?? group._size?.[1] ?? 0);
  const out = [];
  for (const n of graph._nodes || []) {
    if (!n || !n.pos || n.type === NODE_TYPE) continue;
    const nw = Number(n.size?.[0]) || 160;
    const nh = Number(n.size?.[1]) || 80;
    const cx = n.pos[0] + nw * 0.5;
    const cy = n.pos[1] + nh * 0.5;
    if (cx >= gx && cx <= gx + gw && cy >= gy && cy <= gy + gh) {
      out.push(n);
    }
  }
  return out;
}

function resolveTarget(item) {
  if (!item) return { found: false, kind: "node", nodes: [], group: null, graph: null };
  const graph = findGraphBySgId(item.sgId);
  if (!graph) return { found: false, kind: item.kind || "node", nodes: [], group: null, graph: null };

  if (item.kind === "group") {
    const groups = graph._groups || [];
    const grp =
      groups.find((g) => g && item.id != null && g.id != null && String(g.id) === String(item.id)) ||
      groups.find((g) => g && String(g.title || "") === String(item.groupTitle || item.label || ""));
    if (!grp) return { found: false, kind: "group", nodes: [], group: null, graph };
    return {
      found: true,
      kind: "group",
      nodes: getNodesInCanvasGroup(grp, graph),
      group: grp,
      graph,
    };
  }

  const numId = Number(item.id);
  const found =
    (Number.isFinite(numId) ? graph.getNodeById?.(numId) : null) ||
    (graph._nodes || []).find((n) => String(n.id) === String(item.id)) ||
    null;
  if (!found) return { found: false, kind: "node", nodes: [], group: null, graph };
  return { found: true, kind: "node", nodes: [found], group: null, graph };
}

function isTargetActive(res) {
  if (!res.found || !res.nodes.length) return false;
  return res.nodes.some((n) => (Number(n.mode) || 0) === MODE_ACTIVE);
}

function setTargetActive(item, active) {
  const res = resolveTarget(item);
  if (!res.found) return false;
  const offMode = item.offMode === MODE_MUTE ? MODE_MUTE : MODE_BYPASS;
  const nextMode = active ? MODE_ACTIVE : offMode;
  for (const n of res.nodes) {
    n.mode = nextMode;
  }
  res.graph?.change?.();
  app.canvas?.setDirty(true, true);
  if (typeof app.canvas?.draw === "function") app.canvas.draw(true, true);
  return true;
}

function jumpToTarget(item) {
  const res = resolveTarget(item);
  const canvas = app.canvas;
  if (!res.found || !canvas) {
    showToast("LiveDev: Target not found on canvas");
    return;
  }
  try {
    if (res.graph && canvas.graph !== res.graph && typeof canvas.setGraph === "function") {
      canvas.setGraph(res.graph);
    }
    if (res.kind === "group" && res.group && canvas.ds && canvas.canvas) {
      const gx = Number(res.group.pos?.[0] ?? res.group._pos?.[0] ?? 0);
      const gy = Number(res.group.pos?.[1] ?? res.group._pos?.[1] ?? 0);
      const gw = Number(res.group.size?.[0] ?? res.group._size?.[0] ?? 300);
      const gh = Number(res.group.size?.[1] ?? res.group._size?.[1] ?? 200);
      const rect = canvas.canvas.getBoundingClientRect();
      const scale = Number(canvas.ds.scale) || 1;
      canvas.ds.offset[0] = -(gx + gw * 0.5) + rect.width / (2 * scale);
      canvas.ds.offset[1] = -(gy + gh * 0.5) + rect.height / (2 * scale);
      canvas.setDirty(true, true);
      showToast(`Jumped to group: ${res.group.title || item.label}`);
      return;
    }
    const targetNode = res.nodes[0];
    if (!targetNode) return;
    canvas.selectNode?.(targetNode, false);
    if (typeof canvas.centerOnNode === "function") {
      canvas.centerOnNode(targetNode);
    } else if (canvas.ds && canvas.canvas) {
      const rect = canvas.canvas.getBoundingClientRect();
      const scale = Number(canvas.ds.scale) || 1;
      canvas.ds.offset[0] = -targetNode.pos[0] + rect.width / (2 * scale) - (targetNode.size?.[0] || 180) * 0.5;
      canvas.ds.offset[1] = -targetNode.pos[1] + rect.height / (2 * scale) - (targetNode.size?.[1] || 80) * 0.5;
    }
    canvas.setDirty(true, true);
    showToast(`Focused #${targetNode.id} · ${targetNode.title || targetNode.type}`);
  } catch (e) {}
}

// ----------------------------------------------------------------------------
// Glassmorphic Modals: Target Picker & Smart Broken-Link Recovery
// ----------------------------------------------------------------------------

function _extractNodeWidgetSearch(n) {
  if (!n || !Array.isArray(n.widgets) || !n.widgets.length) return { text: "", samples: [] };
  const parts = [];
  const samples = [];
  for (const w of n.widgets) {
    if (!w || w.value === undefined || w.value === null) continue;
    const t = typeof w.value;
    if (t === "string" || t === "number" || t === "boolean") {
      const s = String(w.value).trim();
      if (!s) continue;
      const clipped = s.length > 90 ? s.slice(0, 90) : s;
      parts.push(clipped);
      if (w.name) samples.push({ name: String(w.name), value: clipped });
    }
  }
  return { text: parts.join(" "), samples };
}

function openTargetPickerModal(ctrlNode, targetDeckId, onAdded) {
  const { body, close } = createGlassModal({
    title: targetDeckId ? "Add Targets To Deck" : "Add Target Nodes & Groups",
    subtitle: "Filter by type or search by title, node type, ID, Subgraph, or widget value.",
    icon: LD_ICONS.sliders,
    width: "540px",
    maxHeight: "82vh",
    draggable: true,
  });

  const search = document.createElement("input");
  search.type = "text";
  search.className = "ld-input";
  search.placeholder = "Search title, type, #ID, Subgraph, group, or widget value...";
  search.style.cssText = "width:100%;margin-bottom:8px;flex-shrink:0;";
  body.appendChild(search);

  const filterBar = document.createElement("div");
  filterBar.style.cssText = "display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-bottom:10px;flex-shrink:0;";
  body.appendChild(filterBar);

  const list = document.createElement("div");
  list.style.cssText = "flex:1;min-height:180px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;";
  body.appendChild(list);

  const st = readState(ctrlNode);
  const existingKeys = new Set();
  const collectKeys = (arr) => {
    for (const it of arr || []) existingKeys.add(`${it.kind || "node"}|${it.sgId || ""}|${it.id}`);
  };
  collectKeys(st.items);
  for (const d of st.decks) collectKeys(d.items);

  const candidates = [];
  for (const { graph, sgId, sgName } of collectAllGraphs()) {
    for (const grp of graph._groups || []) {
      if (!grp) continue;
      const gKey = grp.id != null ? String(grp.id) : String(grp.title || "Group");
      const count = getNodesInCanvasGroup(grp, graph).length;
      candidates.push({
        kind: "group",
        isSubgraph: Boolean(sgId),
        isSubgraphContainer: false,
        id: gKey,
        sgId,
        sgName,
        groupTitle: String(grp.title || "Group"),
        label: String(grp.title || "Canvas Group"),
        nodeType: `Canvas Group (${count} node${count === 1 ? "" : "s"})`,
        widgetText: "",
        widgetSamples: [],
      });
    }
    for (const n of graph._nodes || []) {
      if (!n || n.id === ctrlNode.id || n.type === NODE_TYPE) continue;
      const isSgNode = Boolean(
        (typeof n.isSubgraphNode === "function" && n.isSubgraphNode()) ||
        n.subgraph
      );
      const wInfo = _extractNodeWidgetSearch(n);
      candidates.push({
        kind: "node",
        isSubgraph: isSgNode || Boolean(sgId),
        isSubgraphContainer: isSgNode,
        id: n.id,
        sgId,
        sgName,
        label: String(n.title || n.type || `Node #${n.id}`),
        nodeType: isSgNode ? "Subgraph Node" : String(n.type || "Node"),
        widgetText: wInfo.text,
        widgetSamples: wInfo.samples,
      });
    }
  }

  let activeFilter = "all"; // "all" | "nodes" | "groups" | "subgraphs"
  const filterCounts = {
    all: candidates.length,
    nodes: candidates.filter((c) => c.kind === "node" && !c.isSubgraph).length,
    groups: candidates.filter((c) => c.kind === "group").length,
    subgraphs: candidates.filter((c) => c.isSubgraph).length,
  };

  const filterDefs = [
    ["all", "All"],
    ["nodes", "Nodes"],
    ["groups", "Groups"],
    ["subgraphs", "Subgraphs"],
  ];

  const renderFilterBar = () => {
    filterBar.innerHTML = "";
    for (const [key, label] of filterDefs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ld-wfg-tab" + (activeFilter === key ? " is-active" : "");
      btn.innerHTML = `<span>${esc(label)}</span><span class="ld-wfg-tab-cnt">${filterCounts[key]}</span>`;
      btn.onclick = () => {
        activeFilter = key;
        renderFilterBar();
        renderList();
      };
      filterBar.appendChild(btn);
    }
  };

  const renderList = () => {
    const q = search.value.trim().toLowerCase();
    list.innerHTML = "";
    const filtered = candidates.filter((c) => {
      if (activeFilter === "nodes" && (c.kind !== "node" || c.isSubgraph)) return false;
      if (activeFilter === "groups" && c.kind !== "group") return false;
      if (activeFilter === "subgraphs" && !c.isSubgraph) return false;
      if (!q) return true;
      const baseHay = `${c.label} ${c.nodeType} ${c.id} ${c.sgName}`.toLowerCase();
      if (baseHay.includes(q)) return true;
      return c.widgetText.toLowerCase().includes(q);
    });
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding:28px;text-align:center;color:#888;font-size:12px;";
      empty.textContent = "No matching nodes, groups, or widget values found.";
      list.appendChild(empty);
      return;
    }

    for (const c of filtered.slice(0, 100)) {
      const key = `${c.kind}|${c.sgId || ""}|${c.id}`;
      const already = existingKeys.has(key);
      const row = document.createElement("div");
      row.className = "ld-row-item";
      row.style.marginBottom = "0";

      const left = document.createElement("div");
      left.style.cssText = "display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;";
      const topLine = document.createElement("div");
      topLine.style.cssText = "display:flex;align-items:center;gap:6px;min-width:0;";
      const badge = document.createElement("span");
      badge.style.cssText =
        `font-family:${FONT_MONO};font-size:10px;padding:1px 6px;border-radius:999px;` +
        `background:rgba(56,192,196,0.14);color:${ACCENT};flex-shrink:0;`;
      badge.textContent = c.kind === "group" ? "GROUP" : c.isSubgraphContainer ? `SG #${c.id}` : `#${c.id}`;
      const nameEl = document.createElement("span");
      nameEl.style.cssText = "font-size:12.5px;font-weight:600;color:#eef3f7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      nameEl.textContent = c.label;
      topLine.append(badge, nameEl);

      let matchedWidgetNote = "";
      if (q && c.widgetSamples.length) {
        const baseHay = `${c.label} ${c.nodeType} ${c.id} ${c.sgName}`.toLowerCase();
        if (!baseHay.includes(q)) {
          const hit = c.widgetSamples.find((ws) => ws.value.toLowerCase().includes(q));
          if (hit) {
            const valShort = hit.value.length > 42 ? hit.value.slice(0, 40) + "..." : hit.value;
            matchedWidgetNote = ` · ${hit.name}: ${valShort}`;
          }
        }
      }

      const sub = document.createElement("div");
      sub.style.cssText = "font-size:11px;color:#8f98a5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      sub.textContent =
        (c.sgName ? `${c.nodeType} · Subgraph: ${c.sgName}` : c.nodeType) + matchedWidgetNote;
      left.append(topLine, sub);

      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = already ? "ld-btn" : "ld-btn ld-btn-primary";
      addBtn.style.cssText = "padding:4px 10px;font-size:11px;flex-shrink:0;";
      addBtn.textContent = already ? "Added" : "Add";
      addBtn.disabled = already;
      addBtn.onclick = (e) => {
        e.stopPropagation();
        const cur = readState(ctrlNode);
        const entry = {
          kind: c.kind,
          id: c.id,
          sgId: c.sgId || "",
          groupTitle: c.groupTitle || "",
          label: c.label,
          nodeType: c.nodeType,
          offMode: MODE_BYPASS,
        };
        if (targetDeckId) {
          const deck = cur.decks.find((d) => d.id === targetDeckId);
          if (deck) deck.items.push(entry);
          else cur.items.push(entry);
        } else {
          cur.items.push(entry);
        }
        saveState(ctrlNode, cur);
        existingKeys.add(key);
        addBtn.disabled = true;
        addBtn.className = "ld-btn";
        addBtn.textContent = "Added";
        onAdded();
      };

      row.append(left, addBtn);
      row.onclick = () => {
        if (!addBtn.disabled) addBtn.click();
      };
      list.appendChild(row);
    }
  };

  search.oninput = renderList;
  renderFilterBar();
  renderList();

  const foot = document.createElement("div");
  foot.style.cssText = "display:flex;justify-content:flex-end;margin-top:10px;";
  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.className = "ld-btn ld-btn-primary";
  doneBtn.textContent = "Done";
  doneBtn.onclick = close;
  foot.appendChild(doneBtn);
  body.appendChild(foot);

  requestAnimationFrame(() => search.focus());
}

function openRecoveryModal(ctrlNode, brokenItem, onFixed) {
  const { body, close } = createGlassModal({
    title: "Smart Target Recovery",
    subtitle: `Original target "${brokenItem.label}" (#${brokenItem.id}) is missing. Pick a replacement below.`,
    icon: LD_ICONS.alert,
    width: "500px",
    maxHeight: "78vh",
    draggable: true,
  });

  const list = document.createElement("div");
  list.style.cssText = "flex:1;min-height:140px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;";
  body.appendChild(list);

  const candidates = [];
  for (const { graph, sgId, sgName } of collectAllGraphs()) {
    if (brokenItem.kind === "group") {
      for (const grp of graph._groups || []) {
        if (!grp) continue;
        const score = String(grp.title || "").toLowerCase() === String(brokenItem.label || "").toLowerCase() ? 10 : 1;
        candidates.push({
          score,
          id: grp.id != null ? String(grp.id) : String(grp.title || "Group"),
          sgId,
          sgName,
          groupTitle: String(grp.title || "Group"),
          label: String(grp.title || "Canvas Group"),
          nodeType: "Canvas Group",
        });
      }
    } else {
      for (const n of graph._nodes || []) {
        if (!n || n.id === ctrlNode.id || n.type === NODE_TYPE) continue;
        let score = 0;
        if (String(n.type || "") === String(brokenItem.nodeType || "")) score += 10;
        if (String(n.title || "").toLowerCase() === String(brokenItem.label || "").toLowerCase()) score += 6;
        candidates.push({
          score,
          id: n.id,
          sgId,
          sgName,
          label: String(n.title || n.type || `Node #${n.id}`),
          nodeType: String(n.type || "Node"),
        });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  if (!candidates.length) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding:24px;text-align:center;color:#888;";
    empty.textContent = "No replacement targets available in this workflow.";
    list.appendChild(empty);
  } else {
    for (const c of candidates.slice(0, 40)) {
      const row = document.createElement("div");
      row.className = "ld-row-item";
      row.style.marginBottom = "0";
      const left = document.createElement("div");
      left.style.cssText = "display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;";
      const nameEl = document.createElement("div");
      nameEl.style.cssText = "font-size:12px;font-weight:600;color:#eef3f7;";
      nameEl.textContent = `${c.label} (${brokenItem.kind === "group" ? "GROUP" : `#${c.id}`})`;
      const meta = document.createElement("div");
      meta.style.cssText = `font-size:10.5px;color:${c.score >= 10 ? ACCENT : "#8f98a5"};`;
      meta.textContent = (c.score >= 10 ? "Recommended match · " : "") + c.nodeType + (c.sgName ? ` · ${c.sgName}` : "");
      left.append(nameEl, meta);

      const pickBtn = document.createElement("button");
      pickBtn.type = "button";
      pickBtn.className = c.score >= 10 ? "ld-btn ld-btn-primary" : "ld-btn";
      pickBtn.style.cssText = "padding:4px 10px;font-size:11px;";
      pickBtn.textContent = "Relink";
      pickBtn.onclick = (e) => {
        e.stopPropagation();
        brokenItem.id = c.id;
        brokenItem.sgId = c.sgId || "";
        brokenItem.nodeType = c.nodeType;
        if (c.groupTitle) brokenItem.groupTitle = c.groupTitle;
        saveState(ctrlNode, readState(ctrlNode));
        showToast(`LiveDev: Relinked to ${c.label}`);
        close();
        onFixed();
      };
      row.append(left, pickBtn);
      list.appendChild(row);
    }
  }
}

function openDeckNameModal(title, initial, onConfirm) {
  const { body, close } = createGlassModal({
    title,
    icon: LD_ICONS.folder,
    width: "360px",
    draggable: true,
  });
  const input = document.createElement("input");
  input.type = "text";
  input.className = "ld-input";
  input.value = initial || "";
  input.placeholder = "Deck name (e.g. Upscaler, ControlNet)";
  input.style.cssText = "width:100%;margin-bottom:12px;";
  body.appendChild(input);

  const commit = () => {
    const val = input.value.trim();
    if (!val) return;
    close();
    onConfirm(val);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
  });

  const foot = document.createElement("div");
  foot.style.cssText = "display:flex;justify-content:flex-end;gap:6px;";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "ld-btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.onclick = close;
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "ld-btn ld-btn-primary";
  saveBtn.textContent = "Save";
  saveBtn.onclick = commit;
  foot.append(cancelBtn, saveBtn);
  body.appendChild(foot);
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

// ----------------------------------------------------------------------------
// Deterministic height calculation & LiveDev DOM Widget builder
// ----------------------------------------------------------------------------

function computeDesiredHeight(st) {
  let h = 54; // padding + top bar
  const hasAny = st.items.length > 0 || st.decks.length > 0;
  if (!hasAny) return 132;
  h += st.items.length * 38;
  for (const deck of st.decks) {
    h += 42; // deck box + header
    if (!deck.collapsed) {
      h += Math.max(1, deck.items.length) * 37;
    }
  }
  return Math.max(120, Math.min(620, h + 12));
}

function attachBypassWidget(node) {
  if (node._ldBypassAttached) return;
  node._ldBypassAttached = true;
  ensureTheme();

  const root = document.createElement("div");
  root.className = "ld-bp-root";
  root.addEventListener("pointerdown", (e) => e.stopPropagation());
  root.addEventListener("mousedown", (e) => e.stopPropagation());

  // Pass mouse wheel zoom through to LiteGraph canvas when list doesn't need scrolling
  root.addEventListener(
    "wheel",
    (e) => {
      const listEl = root.querySelector(".ld-bp-list");
      const canScroll = listEl && listEl.scrollHeight > listEl.clientHeight + 2;
      if (!canScroll) return;
      const atTop = listEl.scrollTop <= 0 && e.deltaY < 0;
      const atBot = listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 1 && e.deltaY > 0;
      if (!atTop && !atBot) e.stopPropagation();
    },
    { passive: true },
  );

  const fitSize = (structural = false) => {
    const st = readState(node);
    const reqH = computeDesiredHeight(st);
    const curW = Math.max(MIN_W, Number(node.size?.[0]) || DEFAULT_W);
    const curH = Number(node.size?.[1]) || reqH;
    const targetH = structural ? reqH : Math.max(curH, reqH);
    const isVue = typeof LiteGraph !== "undefined" && Boolean(LiteGraph.vueNodesMode);
    const finalH = isVue ? targetH : targetH + 26;
    if (typeof node.setSize === "function") {
      node.setSize([curW, finalH]);
    } else {
      node.size = [curW, finalH];
    }
    node.setDirtyCanvas?.(true, true);
  };

  const renderRow = (item, ownerList, idx) => {
    const st = readState(node);
    const res = resolveTarget(item);
    const active = isTargetActive(res);
    const isMuteMode = item.offMode === MODE_MUTE;

    const row = document.createElement("div");
    row.className =
      "ld-bp-row" + (!res.found ? " is-missing" : !active ? " is-off" : "");

    const main = document.createElement("div");
    main.className = "ld-bp-row-main";

    if (!res.found) {
      const warnBtn = document.createElement("button");
      warnBtn.type = "button";
      warnBtn.className = "ld-bp-mini is-danger";
      warnBtn.innerHTML = LD_ICONS.alert;
      warnBtn.title = "Target missing — click to recover connection";
      warnBtn.onclick = () => openRecoveryModal(node, item, () => render(false));
      main.appendChild(warnBtn);
    } else {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className =
        "ld-bp-switch" + (active ? " is-on" : isMuteMode ? " is-mute" : "");
      sw.title = active
        ? `Active — click to ${isMuteMode ? "Mute" : "Bypass"}`
        : `${isMuteMode ? "Muted" : "Bypassed"} — click to Enable`;
      sw.onclick = () => {
        setTargetActive(item, !active);
        render(false);
      };
      main.appendChild(sw);
    }

    const nameEl = document.createElement("span");
    nameEl.className = "ld-bp-name";
    nameEl.textContent = item.label || item.nodeType || `#${item.id}`;
    nameEl.title = res.found
      ? `${item.nodeType || ""} · Click to toggle · Double-click to rename`
      : "Missing target — click warning icon to recover";
    nameEl.onclick = () => {
      if (!res.found) {
        openRecoveryModal(node, item, () => render(false));
        return;
      }
      setTargetActive(item, !active);
      render(false);
    };
    nameEl.ondblclick = (e) => {
      e.stopPropagation();
      openDeckNameModal("Rename Control Row", item.label || "", (newName) => {
        item.label = newName;
        saveState(node, readState(node));
        render(false);
      });
    };

    const idEl = document.createElement("span");
    idEl.className = "ld-bp-id";
    idEl.textContent = item.kind === "group" ? `G·${res.nodes.length}` : `#${item.id}`;

    main.append(nameEl, idEl);

    const acts = document.createElement("div");
    acts.className = "ld-bp-row-acts";

    if (!st.compact) {
      const modeBtn = document.createElement("button");
      modeBtn.type = "button";
      modeBtn.className = "ld-bp-mini " + (isMuteMode ? "is-mute-tag" : "is-byp-tag");
      modeBtn.textContent = isMuteMode ? "M" : "B";
      modeBtn.title = isMuteMode
        ? "Off mode: Mute (click to switch to Bypass)"
        : "Off mode: Bypass (click to switch to Mute)";
      modeBtn.onclick = () => {
        item.offMode = isMuteMode ? MODE_BYPASS : MODE_MUTE;
        if (!active && res.found) setTargetActive(item, false);
        saveState(node, readState(node));
        render(false);
      };
      acts.appendChild(modeBtn);
    }

    const jumpBtn = document.createElement("button");
    jumpBtn.type = "button";
    jumpBtn.className = "ld-bp-mini";
    jumpBtn.innerHTML = LD_ICONS.eye;
    jumpBtn.title = "Jump camera to target";
    jumpBtn.onclick = () => jumpToTarget(item);
    acts.appendChild(jumpBtn);

    if (!st.compact) {
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "ld-bp-mini is-danger";
      delBtn.textContent = "\u2715";
      delBtn.title = "Remove from board";
      delBtn.onclick = () => {
        ownerList.splice(idx, 1);
        saveState(node, readState(node));
        render(true);
      };
      acts.appendChild(delBtn);
    }

    row.append(main, acts);
    return row;
  };

  const render = (structural = false) => {
    const st = readState(node);
    root.innerHTML = "";

    const allItems = [...st.items, ...st.decks.flatMap((d) => d.items || [])];
    let activeCount = 0;
    let missingCount = 0;
    for (const it of allItems) {
      const r = resolveTarget(it);
      if (!r.found) missingCount++;
      else if (isTargetActive(r)) activeCount++;
    }

    // Header bar
    const bar = document.createElement("div");
    bar.className = "ld-bp-bar";

    const status = document.createElement("div");
    status.className = "ld-bp-status";
    const dot = document.createElement("span");
    dot.className =
      "ld-bp-status-dot" +
      (missingCount > 0 ? " is-warn" : activeCount === 0 && allItems.length > 0 ? " is-off" : "");
    const statusTxt = document.createElement("span");
    statusTxt.textContent =
      allItems.length === 0
        ? "No Targets"
        : missingCount > 0
        ? `${activeCount}/${allItems.length} Active · ${missingCount}!`
        : `${activeCount}/${allItems.length} Active`;
    status.append(dot, statusTxt);

    const btns = document.createElement("div");
    btns.className = "ld-bp-bar-btns";

    if (!st.compact) {
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "ld-bp-ico-btn";
      addBtn.innerHTML = LD_ICONS.plus + "<span>Add</span>";
      addBtn.title = "Add target nodes or canvas groups";
      addBtn.onclick = () => openTargetPickerModal(node, null, () => render(true));

      const deckBtn = document.createElement("button");
      deckBtn.type = "button";
      deckBtn.className = "ld-bp-ico-btn";
      deckBtn.innerHTML = LD_ICONS.folder;
      deckBtn.title = "Create collapsible group deck";
      deckBtn.onclick = () => {
        openDeckNameModal("New Control Deck", "Group", (name) => {
          const cur = readState(node);
          cur.decks.push({ id: makeUid(), name, collapsed: false, items: [] });
          saveState(node, cur);
          render(true);
        });
      };
      btns.append(addBtn, deckBtn);
    }

    if (allItems.length > 0) {
      const allOn = activeCount < allItems.length - missingCount;
      const masterBtn = document.createElement("button");
      masterBtn.type = "button";
      masterBtn.className = "ld-bp-ico-btn" + (!allOn ? " is-active" : "");
      masterBtn.innerHTML = LD_ICONS.power;
      masterBtn.title = allOn ? "Enable all targets" : "Bypass/Mute all targets";
      masterBtn.onclick = () => {
        for (const it of allItems) setTargetActive(it, allOn);
        render(false);
      };
      btns.appendChild(masterBtn);
    }

    const compactBtn = document.createElement("button");
    compactBtn.type = "button";
    compactBtn.className = "ld-bp-ico-btn" + (st.compact ? " is-active" : "");
    compactBtn.innerHTML = LD_ICONS.sliders;
    compactBtn.title = st.compact ? "Show edit controls" : "Compact dashboard view (hide edit buttons)";
    compactBtn.onclick = () => {
      const cur = readState(node);
      cur.compact = !cur.compact;
      saveState(node, cur);
      render(false);
    };
    btns.appendChild(compactBtn);

    bar.append(status, btns);
    root.appendChild(bar);

    // Body list
    const list = document.createElement("div");
    list.className = "ld-bp-list";

    if (allItems.length === 0 && st.decks.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ld-bp-empty";
      const msg = document.createElement("div");
      msg.textContent = "Add nodes or ComfyUI groups to toggle Bypass/Mute remotely.";
      const emptyAdd = document.createElement("button");
      emptyAdd.type = "button";
      emptyAdd.className = "ld-btn ld-btn-primary";
      emptyAdd.style.cssText = "padding:4px 12px;font-size:11.5px;";
      emptyAdd.innerHTML = LD_ICONS.plus + "<span>Add Targets</span>";
      emptyAdd.onclick = () => openTargetPickerModal(node, null, () => render(true));
      empty.append(msg, emptyAdd);
      list.appendChild(empty);
    } else {
      // Direct targets
      st.items.forEach((it, idx) => {
        list.appendChild(renderRow(it, st.items, idx));
      });

      // Collapsible decks
      st.decks.forEach((deck, dIdx) => {
        const box = document.createElement("div");
        box.className = "ld-bp-group";

        const head = document.createElement("div");
        head.className = "ld-bp-group-head";

        const left = document.createElement("div");
        left.className = "ld-bp-group-left";
        left.onclick = () => {
          deck.collapsed = !deck.collapsed;
          saveState(node, st);
          render(true);
        };
        const chev = document.createElement("span");
        chev.className = "ld-bp-chev" + (deck.collapsed ? " is-collapsed" : "");
        chev.innerHTML = LD_ICONS.chevronDown;

        const titleEl = document.createElement("span");
        titleEl.className = "ld-bp-group-title";
        titleEl.textContent = deck.name || "Group";
        titleEl.title = "Click to collapse · Double-click to rename";
        titleEl.ondblclick = (e) => {
          e.stopPropagation();
          openDeckNameModal("Rename Deck", deck.name || "", (newName) => {
            deck.name = newName;
            saveState(node, st);
            render(false);
          });
        };

        let dActive = 0;
        for (const it of deck.items || []) {
          if (isTargetActive(resolveTarget(it))) dActive++;
        }
        const countEl = document.createElement("span");
        countEl.className = "ld-bp-count";
        countEl.textContent = `${dActive}/${(deck.items || []).length}`;
        left.append(chev, titleEl, countEl);

        const gActs = document.createElement("div");
        gActs.className = "ld-bp-row-acts";

        if ((deck.items || []).length > 0) {
          const deckActive = dActive > 0;
          const gSw = document.createElement("button");
          gSw.type = "button";
          gSw.className = "ld-bp-switch" + (deckActive ? " is-on" : "");
          gSw.title = deckActive ? "Bypass/Mute entire deck" : "Enable entire deck";
          gSw.onclick = (e) => {
            e.stopPropagation();
            for (const it of deck.items) setTargetActive(it, !deckActive);
            render(false);
          };
          gActs.appendChild(gSw);
        }

        if (!st.compact) {
          const gAdd = document.createElement("button");
          gAdd.type = "button";
          gAdd.className = "ld-bp-mini";
          gAdd.innerHTML = LD_ICONS.plus;
          gAdd.title = "Add targets into this deck";
          gAdd.onclick = (e) => {
            e.stopPropagation();
            openTargetPickerModal(node, deck.id, () => render(true));
          };
          const gDel = document.createElement("button");
          gDel.type = "button";
          gDel.className = "ld-bp-mini is-danger";
          gDel.textContent = "\u2715";
          gDel.title = "Delete deck";
          gDel.onclick = (e) => {
            e.stopPropagation();
            st.decks.splice(dIdx, 1);
            saveState(node, st);
            render(true);
          };
          gActs.append(gAdd, gDel);
        }

        head.append(left, gActs);
        box.appendChild(head);

        if (!deck.collapsed) {
          if (!deck.items || deck.items.length === 0) {
            const hint = document.createElement("div");
            hint.style.cssText = "font-size:11px;color:#7f8894;padding:4px 6px;";
            hint.textContent = "Empty deck — click + to add targets.";
            box.appendChild(hint);
          } else {
            deck.items.forEach((it, idx) => {
              box.appendChild(renderRow(it, deck.items, idx));
            });
          }
        }
        list.appendChild(box);
      });
    }

    root.appendChild(list);
    if (structural) fitSize(true);
  };

  node._ldBypassRender = render;

  if (typeof node.addDOMWidget === "function") {
    const widget = node.addDOMWidget("livedev_bypass_ui", "custom", root, {
      serialize: false,
      hideOnZoom: false,
      getMinHeight: () => computeDesiredHeight(readState(node)),
    });
    // Adaptive canvasOnly for Nodes 2.0 (Vue) zoom compatibility
    try {
      Object.defineProperty(widget, "canvasOnly", {
        configurable: true,
        get: () => !(typeof LiteGraph !== "undefined" && Boolean(LiteGraph.vueNodesMode)),
      });
    } catch (e) {}
  }

  render(true);
}

app.registerExtension({
  name: "LiveDev.BypassNodes",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeData || nodeData.name !== NODE_TYPE) return;

    const origCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = origCreated ? origCreated.apply(this, arguments) : undefined;
      this.size = [DEFAULT_W, 150];
      attachBypassWidget(this);
      return r;
    };

    const origConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = origConfigure ? origConfigure.apply(this, arguments) : undefined;
      attachBypassWidget(this);
      setTimeout(() => this._ldBypassRender?.(true), 60);
      return r;
    };

    const origMenu = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (_canvas, options) {
      if (origMenu) origMenu.apply(this, arguments);
      const st = readState(this);
      const allItems = [...st.items, ...st.decks.flatMap((d) => d.items || [])];
      options.push(
        null,
        {
          content: `<span class="ld-ctx-label">${LD_ICONS.brand}<span>Add Target Nodes / Groups...</span></span>`,
          callback: () => openTargetPickerModal(this, null, () => this._ldBypassRender?.(true)),
        },
        {
          content: `<span class="ld-ctx-label">${LD_ICONS.brand}<span>${st.compact ? "Show Edit Controls" : "Compact Dashboard View"}</span></span>`,
          callback: () => {
            const cur = readState(this);
            cur.compact = !cur.compact;
            saveState(this, cur);
            this._ldBypassRender?.(false);
          },
        },
        {
          content: `<span class="ld-ctx-label">${LD_ICONS.brand}<span>Enable All Targets</span></span>`,
          callback: () => {
            for (const it of allItems) setTargetActive(it, true);
            this._ldBypassRender?.(false);
          },
        },
        {
          content: `<span class="ld-ctx-label">${LD_ICONS.brand}<span>Bypass / Mute All Targets</span></span>`,
          callback: () => {
            for (const it of allItems) setTargetActive(it, false);
            this._ldBypassRender?.(false);
          },
        },
      );
    };
  },
  afterConfigureGraph() {
    const graph = app.canvas?.graph || app.graph;
    for (const n of graph?._nodes || []) {
      if (n && n.type === NODE_TYPE) {
        attachBypassWidget(n);
        n._ldBypassRender?.(false);
      }
    }
  },
});
