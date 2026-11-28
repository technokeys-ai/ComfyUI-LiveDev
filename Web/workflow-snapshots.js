// Local Workflow Snapshots & Diff (Time-Machine) for ComfyUI-LiveDev.
//
// Saves named local snapshots of the active workflow in localStorage (with safe quota trimming),
// computes structured node/widget/link diffs against the live graph, and restores any snapshot
// with an automatic safety backup beforehand.

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

const SNAPSHOTS_KEY = "livedev_wf_snapshots";
const MAX_SNAPSHOTS = 15;

function loadSnapshots() {
  try {
    const raw = localStorage.getItem(SNAPSHOTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function saveSnapshots(list) {
  let trimmed = list.slice(0, MAX_SNAPSHOTS);
  while (trimmed.length > 0) {
    try {
      localStorage.setItem(SNAPSHOTS_KEY, JSON.stringify(trimmed));
      return true;
    } catch (e) {
      // QuotaExceededError: drop the oldest snapshot and retry.
      trimmed = trimmed.slice(0, trimmed.length - 1);
    }
  }
  try {
    localStorage.setItem(SNAPSHOTS_KEY, "[]");
  } catch (e) {}
  return false;
}

function serializeLiveGraph() {
  const graph = app.canvas?.graph || app.graph;
  if (!graph || typeof graph.serialize !== "function") return null;
  try {
    return JSON.parse(JSON.stringify(graph.serialize()));
  } catch (e) {
    return null;
  }
}

function shortVal(v) {
  if (v === null || v === undefined) return String(v);
  let s = typeof v === "string" ? v : JSON.stringify(v);
  if (s.length > 42) s = s.slice(0, 40) + "...";
  return s;
}

function modeName(mode) {
  const m = Number(mode || 0);
  if (m === 2) return "Muted";
  if (m === 4) return "Bypassed";
  return "Active";
}

function computeWorkflowDiff(snapGraph, liveGraph) {
  const snapNodes = Array.isArray(snapGraph?.nodes) ? snapGraph.nodes : [];
  const liveNodes = Array.isArray(liveGraph?.nodes) ? liveGraph.nodes : [];
  const snapMap = new Map(snapNodes.map((n) => [String(n.id), n]));
  const liveMap = new Map(liveNodes.map((n) => [String(n.id), n]));

  const added = [];
  const removed = [];
  const modified = [];

  for (const [id, cur] of liveMap.entries()) {
    const prev = snapMap.get(id);
    if (!prev) {
      added.push({
        id,
        title: String(cur.title || cur.type || `Node #${id}`),
        type: String(cur.type || "Unknown"),
      });
      continue;
    }
    const changes = [];
    if (String(prev.type || "") !== String(cur.type || "")) {
      changes.push(`type: ${prev.type} -> ${cur.type}`);
    }
    if (String(prev.title || "") !== String(cur.title || "")) {
      changes.push(`title: "${shortVal(prev.title || prev.type)}" -> "${shortVal(cur.title || cur.type)}"`);
    }
    if (Number(prev.mode || 0) !== Number(cur.mode || 0)) {
      changes.push(`mode: ${modeName(prev.mode)} -> ${modeName(cur.mode)}`);
    }
    const prevVals = Array.isArray(prev.widgets_values) ? prev.widgets_values : [];
    const curVals = Array.isArray(cur.widgets_values) ? cur.widgets_values : [];
    const maxLen = Math.max(prevVals.length, curVals.length);
    for (let i = 0; i < maxLen; i++) {
      if (JSON.stringify(prevVals[i]) !== JSON.stringify(curVals[i])) {
        changes.push(`widget[${i}]: ${shortVal(prevVals[i])} -> ${shortVal(curVals[i])}`);
      }
    }
    if (changes.length) {
      modified.push({
        id,
        title: String(cur.title || cur.type || `Node #${id}`),
        type: String(cur.type || "Unknown"),
        changes,
      });
    }
  }

  for (const [id, prev] of snapMap.entries()) {
    if (!liveMap.has(id)) {
      removed.push({
        id,
        title: String(prev.title || prev.type || `Node #${id}`),
        type: String(prev.type || "Unknown"),
      });
    }
  }

  const snapLinks = Array.isArray(snapGraph?.links) ? snapGraph.links.length : 0;
  const liveLinks = Array.isArray(liveGraph?.links) ? liveGraph.links.length : 0;
  return {
    added,
    removed,
    modified,
    linksDelta: liveLinks - snapLinks,
    hasChanges: Boolean(added.length || removed.length || modified.length || liveLinks !== snapLinks),
  };
}

export function captureWorkflowSnapshot(label = "") {
  const graph = serializeLiveGraph();
  if (!graph) {
    showToast("LiveDev: Cannot serialize active workflow");
    return null;
  }
  const nodesCount = Array.isArray(graph.nodes) ? graph.nodes.length : 0;
  const linksCount = Array.isArray(graph.links) ? graph.links.length : 0;
  const entry = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: String(label || "").trim() || `Snapshot ${new Date().toLocaleTimeString()}`,
    createdAt: Date.now(),
    nodesCount,
    linksCount,
    graph,
  };
  const list = loadSnapshots();
  list.unshift(entry);
  const ok = saveSnapshots(list);
  if (!ok) {
    showToast("LiveDev: LocalStorage quota exceeded — snapshot could not be saved");
    return null;
  }
  return entry;
}

function injectSnapshotStyles() {
  if (document.getElementById("livedev-snapshots-css")) return;
  const st = document.createElement("style");
  st.id = "livedev-snapshots-css";
  st.textContent = `
.ld-snap-card {
  padding: 10px 12px;
  margin-bottom: 8px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
}
.ld-snap-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 999px;
  font-family: ${FONT_MONO};
  font-size: 10.5px;
  font-weight: 600;
  background: rgba(255, 255, 255, 0.06);
  color: #aeb7c2;
  border: 1px solid rgba(255, 255, 255, 0.10);
}
.ld-snap-badge.is-accent {
  background: rgba(56, 192, 196, 0.14);
  color: ${ACCENT};
  border-color: rgba(56, 192, 196, 0.34);
}
.ld-snap-badge.is-danger {
  background: rgba(229, 115, 115, 0.14);
  color: ${DANGER};
  border-color: rgba(229, 115, 115, 0.34);
}
.ld-snap-diff {
  margin-top: 9px;
  padding: 9px 10px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.34);
  border: 1px solid rgba(255, 255, 255, 0.07);
  font-family: ${FONT_MONO};
  font-size: 11px;
  line-height: 1.5;
  max-height: 220px;
  overflow-y: auto;
}
`;
  document.head.appendChild(st);
}

export function openSnapshotsModal() {
  ensureTheme();
  injectSnapshotStyles();

  const expandedIds = new Set();

  const { body, close } = createGlassModal({
    title: "Workflow Snapshots & Diff",
    subtitle: "Local workflow time-machine: save checkpoints, inspect exact node/widget diffs, and restore safely.",
    icon: LD_ICONS.history,
    width: "720px",
    maxHeight: "84vh",
    draggable: true,
  });

  const saveBar = document.createElement("div");
  saveBar.style.cssText = "display:flex;gap:8px;margin-bottom:12px;flex-shrink:0;";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "ld-input";
  nameInput.placeholder = "Snapshot label (e.g. Before upscale pass)...";
  nameInput.style.flex = "1";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "ld-btn ld-btn-primary";
  saveBtn.innerHTML = LD_ICONS.save + "<span>Save Snapshot</span>";

  saveBar.append(nameInput, saveBtn);

  const listWrap = document.createElement("div");
  listWrap.style.cssText = "flex:1;min-height:200px;overflow-y:auto;padding-right:2px;";

  body.append(saveBar, listWrap);

  function render() {
    const snapshots = loadSnapshots();
    const liveGraph = serializeLiveGraph();
    listWrap.innerHTML = "";

    if (!snapshots.length) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding:28px 16px;text-align:center;color:#8f98a5;border:1px dashed rgba(255,255,255,0.10);border-radius:10px;";
      empty.textContent = "No workflow snapshots saved yet. Create a snapshot before making major graph edits.";
      listWrap.appendChild(empty);
      return;
    }

    for (const snap of snapshots) {
      const diff = liveGraph ? computeWorkflowDiff(snap.graph, liveGraph) : null;
      const isExpanded = expandedIds.has(snap.id);

      const card = document.createElement("div");
      card.className = "ld-snap-card";

      const headRow = document.createElement("div");
      headRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;";

      const metaCol = document.createElement("div");
      metaCol.style.cssText = "min-width:0;flex:1;";

      const diffBadges = [];
      if (diff) {
        if (!diff.hasChanges) {
          diffBadges.push('<span class="ld-snap-badge">Matches Current</span>');
        } else {
          if (diff.added.length) diffBadges.push(`<span class="ld-snap-badge is-accent">+${diff.added.length} added</span>`);
          if (diff.removed.length) diffBadges.push(`<span class="ld-snap-badge is-danger">-${diff.removed.length} removed</span>`);
          if (diff.modified.length) diffBadges.push(`<span class="ld-snap-badge is-accent">~${diff.modified.length} modified</span>`);
          if (diff.linksDelta !== 0) {
            diffBadges.push(`<span class="ld-snap-badge">${diff.linksDelta > 0 ? "+" : ""}${diff.linksDelta} links</span>`);
          }
        }
      }

      metaCol.innerHTML =
        `<div style="font-weight:600;color:#eef3f7;font-size:13px;word-break:break-word;">${esc(snap.name)}</div>` +
        `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:4px;">` +
        `<span style="font-family:${FONT_MONO};font-size:10.5px;color:#8f98a5;">${esc(new Date(snap.createdAt).toLocaleString())} · ${snap.nodesCount} nodes · ${snap.linksCount} links</span>` +
        diffBadges.join("") +
        `</div>`;

      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;align-items:center;gap:6px;flex-shrink:0;";

      const diffBtn = document.createElement("button");
      diffBtn.type = "button";
      diffBtn.className = isExpanded ? "ld-btn ld-btn-primary" : "ld-btn";
      diffBtn.style.cssText = "padding:4px 9px;font-size:11px;";
      diffBtn.textContent = isExpanded ? "Hide Diff" : "Diff";
      diffBtn.onclick = () => {
        if (expandedIds.has(snap.id)) expandedIds.delete(snap.id);
        else expandedIds.add(snap.id);
        render();
      };

      const restoreBtn = document.createElement("button");
      restoreBtn.type = "button";
      restoreBtn.className = "ld-btn ld-btn-primary";
      restoreBtn.style.cssText = "padding:4px 9px;font-size:11px;";
      restoreBtn.textContent = "Restore";
      restoreBtn.onclick = async () => {
        if (!confirm(`Restore snapshot "${snap.name}"? A safety backup of the current workflow will be saved first.`)) {
          return;
        }
        try {
          if (liveGraph && Array.isArray(liveGraph.nodes) && liveGraph.nodes.length && diff?.hasChanges) {
            captureWorkflowSnapshot("Auto-backup before restore");
          }
          await app.loadGraphData(JSON.parse(JSON.stringify(snap.graph)));
          app.canvas?.setDirty(true, true);
          showToast(`LiveDev: Restored snapshot "${snap.name}"`);
          close();
        } catch (e) {
          showToast(`LiveDev: Restore failed — ${e.message}`);
        }
      };

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "ld-btn ld-btn-danger";
      delBtn.style.cssText = "padding:4px 9px;font-size:11px;";
      delBtn.textContent = "Delete";
      delBtn.onclick = () => {
        const next = loadSnapshots().filter((item) => item.id !== snap.id);
        saveSnapshots(next);
        expandedIds.delete(snap.id);
        render();
      };

      actions.append(diffBtn, restoreBtn, delBtn);
      headRow.append(metaCol, actions);
      card.appendChild(headRow);

      if (isExpanded && diff) {
        const diffBox = document.createElement("div");
        diffBox.className = "ld-snap-diff";
        if (!diff.hasChanges) {
          diffBox.style.color = "#8f98a5";
          diffBox.textContent = "Current workflow is identical to this snapshot.";
        } else {
          const lines = [];
          for (const item of diff.added) {
            lines.push(`<div style="color:${ACCENT};">+ [ID ${esc(item.id)}] ${esc(item.title)} (${esc(item.type)})</div>`);
          }
          for (const item of diff.removed) {
            lines.push(`<div style="color:${DANGER};">- [ID ${esc(item.id)}] ${esc(item.title)} (${esc(item.type)})</div>`);
          }
          for (const item of diff.modified) {
            lines.push(
              `<div style="color:#eef3f7;">~ [ID ${esc(item.id)}] ${esc(item.title)}: ` +
              `<span style="color:#aeb7c2;">${esc(item.changes.join(" | "))}</span></div>`
            );
          }
          if (diff.linksDelta !== 0) {
            lines.push(`<div style="color:#9aa3b0;">Links delta: ${diff.linksDelta > 0 ? "+" : ""}${diff.linksDelta}</div>`);
          }
          diffBox.innerHTML = lines.join("");
        }
        card.appendChild(diffBox);
      }

      listWrap.appendChild(card);
    }
  }

  function doSave() {
    const entry = captureWorkflowSnapshot(nameInput.value);
    if (entry) {
      nameInput.value = "";
      showToast(`LiveDev: Saved snapshot "${entry.name}"`);
      render();
    }
  }

  saveBtn.onclick = doSave;
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doSave();
    }
  });

  render();
}

app.registerExtension({
  name: "LiveDev.Snapshots",
  async setup() {},
});
