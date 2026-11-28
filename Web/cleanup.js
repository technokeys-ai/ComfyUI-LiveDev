import { app } from "../../scripts/app.js";
import { showToast, saveToolbarState } from "./utils.js";
import { ACCENT, FONT_MONO, LD_ICONS, createGlassModal } from "./livedev-theme.js";

app.registerExtension({
  name: "LiveDev.Cleanup",
  async setup() {},
});

// Wireless utility & annotation nodes that are intentionally unconnected and should not be
// treated as orphaned dead nodes during cleanup.
const WIRELESS_KEEP_TYPES = new Set([
  "Note",
  "MarkdownNote",
  "LiveDev_BypassNodes",
  "LiveDev_RunTimer",
  "LiveDev_Terminal",
  "LiveDev_VisualFold",
]);

function _collectAllGraphs() {
  const root = app.graph || app.canvas?.graph;
  const out = [];
  const seen = new Set();
  const walk = (g) => {
    if (!g || seen.has(g)) return;
    seen.add(g);
    out.push(g);
    const subs = g.subgraphs;
    if (subs instanceof Map) {
      for (const sg of subs.values()) walk(sg);
    } else if (subs && typeof subs === "object") {
      for (const sg of Object.values(subs)) walk(sg);
    }
  };
  walk(root);
  if (app.canvas?.graph && !seen.has(app.canvas.graph)) walk(app.canvas.graph);
  return out;
}

function _nodeXY(nd) {
  const pos = nd?.pos;
  if (Array.isArray(pos) && pos.length >= 2) {
    return [Number(pos[0]) || 0, Number(pos[1]) || 0];
  }
  if (pos && typeof pos === "object") {
    return [Number(pos[0] ?? pos["0"]) || 0, Number(pos[1] ?? pos["1"]) || 0];
  }
  return [0, 0];
}

function _computeSmartOrder(nodesData, linksData) {
  const validNodes = (nodesData || []).filter((n) => n && typeof n.id === "number" && n.id > 0);
  const idSet = new Set(validNodes.map((n) => n.id));
  const inEdges = new Map();
  const outEdges = new Map();
  for (const n of validNodes) {
    inEdges.set(n.id, new Set());
    outEdges.set(n.id, new Set());
  }

  for (const lk of linksData || []) {
    let srcId = null;
    let dstId = null;
    if (Array.isArray(lk) && lk.length >= 4) {
      srcId = lk[1];
      dstId = lk[3];
    } else if (lk && typeof lk === "object") {
      srcId = lk.origin_id;
      dstId = lk.target_id;
    }
    if (idSet.has(srcId) && idSet.has(dstId) && srcId !== dstId) {
      inEdges.get(dstId).add(srcId);
      outEdges.get(srcId).add(dstId);
    }
  }

  // Compute topological execution depth via Kahn-style BFS so sources get low IDs and outputs get high IDs.
  const depth = new Map();
  const inDeg = new Map();
  const queue = [];
  for (const n of validNodes) {
    const deg = inEdges.get(n.id).size;
    inDeg.set(n.id, deg);
    depth.set(n.id, 0);
    if (deg === 0) queue.push(n.id);
  }
  while (queue.length) {
    const cur = queue.shift();
    const curDepth = depth.get(cur) || 0;
    for (const nxt of outEdges.get(cur) || []) {
      if ((depth.get(nxt) || 0) < curDepth + 1) {
        depth.set(nxt, curDepth + 1);
      }
      const rem = (inDeg.get(nxt) || 0) - 1;
      inDeg.set(nxt, rem);
      if (rem === 0) queue.push(nxt);
    }
  }

  return [...validNodes].sort((a, b) => {
    const da = depth.get(a.id) || 0;
    const db = depth.get(b.id) || 0;
    if (da !== db) return da - db;
    const [ax, ay] = _nodeXY(a);
    const [bx, by] = _nodeXY(b);
    const colA = Math.round(ax / 180);
    const colB = Math.round(bx / 180);
    if (colA !== colB) return colA - colB;
    if (Math.abs(ay - by) > 12) return ay - by;
    if (ax !== bx) return ax - bx;
    return a.id - b.id;
  });
}

function _remapBypassItems(dataObj, targetSgId, idMap) {
  if (!dataObj || typeof dataObj !== "object") return;
  const remapArr = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const it of arr) {
      if (!it || it.kind === "group") continue;
      if (String(it.sgId || "") !== targetSgId) continue;
      const oldNum = Number(it.id);
      if (Number.isFinite(oldNum) && idMap.has(oldNum)) {
        it.id = idMap.get(oldNum);
      }
    }
  };
  remapArr(dataObj.items);
  if (Array.isArray(dataObj.decks)) {
    for (const d of dataObj.decks) remapArr(d?.items);
  }
}

function _remapFoldData(foldObj, idMap) {
  if (!foldObj || typeof foldObj !== "object") return;
  for (const listKey of ["extIn", "extOut"]) {
    const list = foldObj[listKey];
    if (!Array.isArray(list)) continue;
    for (const rec of list) {
      if (!rec) continue;
      const peer = Number(rec.peerNodeId);
      if (Number.isFinite(peer) && idMap.has(peer)) {
        rec.peerNodeId = idMap.get(peer);
      }
    }
  }
}

function _remapSerializedGraphIds(data, targetSgId) {
  const ordered = _computeSmartOrder(data.nodes, data.links);
  const idMap = new Map();
  const changes = [];
  for (let i = 0; i < ordered.length; i++) {
    const oldId = ordered[i].id;
    const newId = i + 1;
    idMap.set(oldId, newId);
    if (oldId !== newId) {
      changes.push({
        oldId,
        newId,
        title: ordered[i].title || ordered[i].type || `Node #${oldId}`,
      });
    }
  }

  for (const nd of data.nodes || []) {
    if (!nd) continue;
    if (idMap.has(nd.id)) nd.id = idMap.get(nd.id);
    if (nd.properties?.liveDevBypassData) {
      _remapBypassItems(nd.properties.liveDevBypassData, targetSgId, idMap);
    }
    if (nd.properties?.liveDevFoldData) {
      _remapFoldData(nd.properties.liveDevFoldData, idMap);
    }
  }

  for (const lk of data.links || []) {
    if (Array.isArray(lk) && lk.length >= 4) {
      if (idMap.has(lk[1])) lk[1] = idMap.get(lk[1]);
      if (idMap.has(lk[3])) lk[3] = idMap.get(lk[3]);
    } else if (lk && typeof lk === "object") {
      if (idMap.has(lk.origin_id)) lk.origin_id = idMap.get(lk.origin_id);
      if (idMap.has(lk.target_id)) lk.target_id = idMap.get(lk.target_id);
    }
  }

  if (Array.isArray(data.floatingLinks)) {
    for (const fl of data.floatingLinks) {
      if (Array.isArray(fl) && fl.length >= 4) {
        if (idMap.has(fl[1])) fl[1] = idMap.get(fl[1]);
        if (idMap.has(fl[3])) fl[3] = idMap.get(fl[3]);
      } else if (fl && typeof fl === "object") {
        if (idMap.has(fl.origin_id)) fl.origin_id = idMap.get(fl.origin_id);
        if (idMap.has(fl.target_id)) fl.target_id = idMap.get(fl.target_id);
      }
    }
  }

  // Update Bypass LiveDev boards inside embedded subgraph definitions when root IDs change
  const sgDefs = data.definitions?.subgraphs;
  if (Array.isArray(sgDefs)) {
    for (const sg of sgDefs) {
      for (const nd of sg?.nodes || []) {
        if (nd?.properties?.liveDevBypassData) {
          _remapBypassItems(nd.properties.liveDevBypassData, targetSgId, idMap);
        }
      }
    }
  }

  data.last_node_id = ordered.length;
  return { count: ordered.length, idMap, changes };
}

function _needsRenumbering(graph) {
  const nodes = (graph?._nodes || []).filter((n) => n && typeof n.id === "number" && n.id > 0);
  if (!nodes.length) return { needed: false, count: 0, maxId: 0, lastId: 0 };
  let maxId = 0;
  const seen = new Set();
  let hasDup = false;
  for (const n of nodes) {
    if (n.id > maxId) maxId = n.id;
    if (seen.has(n.id)) hasDup = true;
    seen.add(n.id);
  }
  const lastId = Number(graph.last_node_id ?? graph.state?.lastNodeId ?? maxId) || maxId;
  const needed = hasDup || maxId > nodes.length || lastId > nodes.length;
  return { needed, count: nodes.length, maxId, lastId };
}

export function smartRenumberGraph(graph, canvas) {
  const g = graph || app.canvas?.graph || app.graph;
  const c = canvas || app.canvas;
  if (!g || typeof g.serialize !== "function" || typeof g.configure !== "function") {
    return { count: 0, changed: 0 };
  }

  const isSubgraph = Boolean(g !== app.graph && g.id && !g.isRootGraph);
  const targetSgId = isSubgraph ? String(g.id) : "";

  const savedOffset = c?.ds?.offset ? [...c.ds.offset] : null;
  const savedScale = c?.ds?.scale;

  const data = JSON.parse(JSON.stringify(g.serialize()));
  const { count, idMap, changes } = _remapSerializedGraphIds(data, targetSgId);

  g.beforeChange?.();
  g.configure(data);
  if (g.state && typeof g.state === "object") {
    g.state.lastNodeId = count;
  }
  try {
    g.last_node_id = count;
  } catch (e) {}

  // If we renumbered inside a Subgraph, also update any Bypass LiveDev boards in other graphs
  if (isSubgraph && idMap.size) {
    for (const other of _collectAllGraphs()) {
      if (other === g) continue;
      for (const nd of other._nodes || []) {
        if (nd?.properties?.liveDevBypassData) {
          _remapBypassItems(nd.properties.liveDevBypassData, targetSgId, idMap);
        }
      }
    }
  }

  if (c?.ds && savedOffset) {
    c.ds.offset[0] = savedOffset[0];
    c.ds.offset[1] = savedOffset[1];
    if (Number.isFinite(savedScale)) c.ds.scale = savedScale;
  }

  g.afterChange?.();
  g.change?.();
  c?.setDirty(true, true);
  if (typeof c?.draw === "function") c.draw(true, true);

  return { count, changed: changes.length };
}

function _openRenumberOnlyModal(g, c, stats) {
  const previewData = JSON.parse(JSON.stringify(g.serialize()));
  const ordered = _computeSmartOrder(previewData.nodes, previewData.links);
  const lines = ordered.map((nd, idx) => {
    const nextId = idx + 1;
    const mark = nd.id === nextId ? "=" : "\u2192";
    return `#${nd.id} ${mark} #${nextId}   ${nd.title || nd.type || "Node"}`;
  });

  const { body, footer, close } = createGlassModal({
    title: "Smart Renumber Node IDs",
    subtitle: `No orphaned nodes found. Compact ${stats.count} node IDs cleanly to 1..${stats.count} (currently up to #${Math.max(stats.maxId, stats.lastId)}).`,
    icon: LD_ICONS.hash,
    width: "500px",
    maxHeight: "74vh",
  });

  const listBox = document.createElement("div");
  listBox.style.cssText =
    `max-height:240px;overflow-y:auto;padding:10px 12px;border-radius:8px;background:rgba(0,0,0,0.28);` +
    `border:1px solid rgba(255,255,255,0.07);font-family:${FONT_MONO};font-size:11.5px;color:#d8dee6;white-space:pre;line-height:1.55;`;
  listBox.textContent = lines.join("\n");
  body.appendChild(listBox);

  footer.style.display = "flex";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "ld-btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.onclick = close;

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "ld-btn ld-btn-primary";
  confirmBtn.textContent = `Renumber 1..${stats.count}`;
  confirmBtn.onclick = () => {
    saveToolbarState();
    const res = smartRenumberGraph(g, c);
    showToast(`LiveDev: Renumbered ${res.count} nodes cleanly (1..${res.count})`);
    close();
  };

  footer.append(cancelBtn, confirmBtn);
}

export function doCleanUnused() {
  const c = app.canvas;
  if (!c || !c.graph) return;
  const g = c.graph;
  const all = g._nodes || [];
  if (!all.length) {
    showToast("No nodes in workflow");
    return;
  }
  const orphaned = all.filter((n) => {
    if (!n || WIRELESS_KEEP_TYPES.has(n.type)) return false;
    const hasInput = (n.inputs || []).some((i) => i.link != null);
    const hasOutput = (n.outputs || []).some((o) => o.links && o.links.length);
    return !hasInput && !hasOutput;
  });

  if (!orphaned.length) {
    const stats = _needsRenumbering(g);
    if (stats.needed) {
      _openRenumberOnlyModal(g, c, stats);
    } else {
      showToast(`Workflow is clean (${stats.count} nodes, IDs 1..${stats.count})`);
    }
    return;
  }

  const remainingCount = Math.max(0, all.length - orphaned.length);
  const currentMax = Math.max(
    0,
    ...all.map((n) => (typeof n.id === "number" ? n.id : 0)),
    Number(g.last_node_id ?? g.state?.lastNodeId ?? 0) || 0
  );

  const { body, footer, close } = createGlassModal({
    title: `Clean ${orphaned.length} Orphaned Node${orphaned.length > 1 ? "s" : ""}`,
    subtitle: "These nodes have no incoming or outgoing links.",
    icon: LD_ICONS.trash,
    width: "500px",
    maxHeight: "76vh",
  });

  const listBox = document.createElement("div");
  listBox.style.cssText =
    `max-height:210px;overflow-y:auto;padding:10px 12px;border-radius:8px;background:rgba(0,0,0,0.28);` +
    `border:1px solid rgba(255,255,255,0.07);font-family:${FONT_MONO};font-size:12px;color:#d8dee6;white-space:pre-wrap;line-height:1.5;`;
  listBox.textContent = orphaned.map((n) => `#${n.id}  ${n.title || n.type}`).join("\n");
  body.appendChild(listBox);

  // Smart renumber option (checked by default)
  const optRow = document.createElement("label");
  optRow.style.cssText =
    "display:flex;align-items:flex-start;gap:8px;margin-top:10px;padding:8px 10px;border-radius:8px;" +
    "background:rgba(56,192,196,0.08);border:1px solid rgba(56,192,196,0.28);cursor:pointer;font-size:12px;color:#e6ecf4;";
  const renumChk = document.createElement("input");
  renumChk.type = "checkbox";
  renumChk.checked = true;
  renumChk.style.cssText = `margin-top:2px;accent-color:${ACCENT};cursor:pointer;`;
  const optText = document.createElement("div");
  optText.style.cssText = "display:flex;flex-direction:column;gap:2px;";
  const optTitle = document.createElement("span");
  optTitle.style.cssText = "font-weight:600;";
  optTitle.textContent = `Smart renumber remaining IDs (1..${remainingCount}) by workflow flow`;
  const optSub = document.createElement("span");
  optSub.style.cssText = `font-size:11px;color:#9aa4b2;font-family:${FONT_MONO};`;
  optSub.textContent =
    remainingCount > 0
      ? `Compacts max ID #${currentMax} \u2192 #${remainingCount} and resets last_node_id safely`
      : "Resets last_node_id to 0";
  optText.append(optTitle, optSub);
  optRow.append(renumChk, optText);
  body.appendChild(optRow);

  footer.style.display = "flex";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "ld-btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.onclick = close;

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "ld-btn ld-btn-danger";
  const syncBtnLabel = () => {
    confirmBtn.textContent = renumChk.checked ? "Clean & Renumber IDs" : "Delete Nodes";
  };
  syncBtnLabel();
  renumChk.addEventListener("change", syncBtnLabel);

  confirmBtn.onclick = () => {
    saveToolbarState();
    g.beforeChange();
    for (const n of orphaned) g.remove(n);
    g.afterChange();

    if (renumChk.checked) {
      const res = smartRenumberGraph(g, c);
      showToast(
        `Deleted ${orphaned.length} orphaned node${orphaned.length > 1 ? "s" : ""} · Renumbered IDs 1..${res.count}`
      );
    } else {
      c.setDirty(true, true);
      showToast("Deleted " + orphaned.length + " orphaned node" + (orphaned.length > 1 ? "s" : ""));
    }
    close();
  };

  footer.appendChild(cancelBtn);
  footer.appendChild(confirmBtn);
}

export function doFixNodeIds() {
  const c = app.canvas;
  if (!c || !c.graph) return;
  const g = c.graph;
  const nodes = g._nodes || [];
  if (!nodes.length) {
    showToast("No nodes in graph");
    return;
  }
  const seen = {};
  const duplicates = [];
  for (const n of nodes) {
    if (n.id == null) {
      duplicates.push({ node: n, oldId: n.id });
      continue;
    }
    if (seen[n.id] !== undefined) duplicates.push({ node: n, oldId: n.id });
    else seen[n.id] = true;
  }
  if (!duplicates.length) {
    const stats = _needsRenumbering(g);
    if (stats.needed) {
      _openRenumberOnlyModal(g, c, stats);
    } else {
      showToast(`No duplicate IDs · IDs are already clean (1..${stats.count})`);
    }
    return;
  }
  let maxId = 0;
  for (const n of nodes) {
    if (n.id != null && n.id > maxId) maxId = n.id;
  }
  const map = [];
  for (const d of duplicates) {
    maxId++;
    map.push({ node: d.node, oldId: d.oldId, newId: maxId });
  }

  const { body, footer, close } = createGlassModal({
    title: `Fix ${map.length} Duplicate Node ID${map.length > 1 ? "s" : ""}`,
    subtitle: "Reassign unique IDs and compact all node IDs cleanly by workflow flow.",
    icon: LD_ICONS.hash,
    width: "480px",
    maxHeight: "70vh",
  });

  const listBox = document.createElement("div");
  listBox.style.cssText =
    `max-height:220px;overflow-y:auto;padding:10px 12px;border-radius:8px;background:rgba(0,0,0,0.28);` +
    `border:1px solid rgba(255,255,255,0.07);font-family:${FONT_MONO};font-size:12px;color:#d8dee6;white-space:pre;line-height:1.5;`;
  listBox.textContent = map
    .map((m) => `${m.node.title || m.node.type}  (${m.oldId} \u2192 ${m.newId})`)
    .join("\n");
  body.appendChild(listBox);

  footer.style.display = "flex";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "ld-btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.onclick = close;

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "ld-btn ld-btn-primary";
  confirmBtn.textContent = "Fix & Renumber IDs";
  confirmBtn.onclick = () => {
    saveToolbarState();
    g.beforeChange();
    for (const m of map) {
      if (g._links) {
        for (const lid in g._links) {
          const link = g._links[lid];
          if (link.origin_id === m.oldId) link.origin_id = m.newId;
          if (link.target_id === m.oldId) link.target_id = m.newId;
        }
      }
      m.node.id = m.newId;
    }
    g.afterChange();
    const res = smartRenumberGraph(g, c);
    showToast(`Fixed ${map.length} duplicate ID${map.length > 1 ? "s" : ""} · Renumbered 1..${res.count}`);
    close();
  };

  footer.appendChild(cancelBtn);
  footer.appendChild(confirmBtn);
}
