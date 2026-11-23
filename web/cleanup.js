import { app } from "../../scripts/app.js";
import { showToast } from "./utils.js";
import { FONT_MONO, LD_ICONS, createGlassModal } from "./livedev-theme.js";

app.registerExtension({
  name: "LiveDev.Cleanup",
  async setup() {},
});

export function doCleanUnused() {
  const c = app.canvas;
  if (!c || !c.graph) return;
  const g = c.graph;
  const all = g._nodes || [];
  if (!all.length) return;
  const orphaned = all.filter((n) => {
    const hasInput = (n.inputs || []).some((i) => i.link != null);
    const hasOutput = (n.outputs || []).some((o) => o.links && o.links.length);
    return !hasInput && !hasOutput;
  });
  if (!orphaned.length) {
    showToast("No orphaned nodes found");
    return;
  }

  const { body, footer, close } = createGlassModal({
    title: `Clean ${orphaned.length} Orphaned Node${orphaned.length > 1 ? "s" : ""}`,
    subtitle: "These nodes have no incoming or outgoing links.",
    icon: LD_ICONS.trash,
    width: "480px",
    maxHeight: "70vh",
  });

  const listBox = document.createElement("div");
  listBox.style.cssText =
    `max-height:220px;overflow-y:auto;padding:10px 12px;border-radius:8px;background:rgba(0,0,0,0.28);` +
    `border:1px solid rgba(255,255,255,0.07);font-family:${FONT_MONO};font-size:12px;color:#d8dee6;white-space:pre-wrap;line-height:1.5;`;
  listBox.textContent = orphaned.map((n) => n.title || n.type).join("\n");
  body.appendChild(listBox);

  footer.style.display = "flex";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "ld-btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.onclick = close;

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "ld-btn ld-btn-danger";
  confirmBtn.textContent = "Delete Nodes";
  confirmBtn.onclick = () => {
    g.beforeChange();
    for (const n of orphaned) g.remove(n);
    g.afterChange();
    c.setDirty(true, true);
    showToast("Deleted " + orphaned.length + " orphaned node" + (orphaned.length > 1 ? "s" : ""));
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
    showToast("No duplicate node IDs found");
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
    subtitle: "Reassign unique IDs and update link references safely.",
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
  confirmBtn.textContent = "Fix IDs";
  confirmBtn.onclick = () => {
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
    c.setDirty(true, true);
    showToast("Fixed " + map.length + " duplicate ID" + (map.length > 1 ? "s" : ""));
    close();
  };

  footer.appendChild(cancelBtn);
  footer.appendChild(confirmBtn);
}
