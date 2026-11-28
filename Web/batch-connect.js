import { app } from "../../scripts/app.js";
import { showToast, getSelectedArr, esc } from "./utils.js";
import { ACCENT, FONT_MONO, LD_ICONS, createGlassModal } from "./livedev-theme.js";

app.registerExtension({
  name: "LiveDev.BatchConnect",
  async setup() {},
});

export function doBatchConnect() {
  const nodes = getSelectedArr();
  if (nodes.length < 2) {
    showToast("Select at least 2 nodes");
    return;
  }
  const c = app.canvas;
  if (!c || !c.graph) return;
  const autoConnections = [];
  const groups = [];
  for (let si = 0; si < nodes.length; si++) {
    const src = nodes[si];
    for (let ti = 0; ti < nodes.length; ti++) {
      if (si === ti) continue;
      const tgt = nodes[ti];
      for (let ti2 = 0; ti2 < (tgt.inputs || []).length; ti2++) {
        const inp = tgt.inputs[ti2];
        if (!inp || (inp.link != null && inp.link >= 0)) continue;
        const srcMatches = [];
        for (let so = 0; so < (src.outputs || []).length; so++) {
          const o = src.outputs[so];
          if (!o || o.links?.length > 0) continue;
          if (o.type === inp.type || inp.type === "*") {
            srcMatches.push({ so, name: o.label || o.name || ("Out " + so) });
          }
        }
        if (srcMatches.length === 1) {
          autoConnections.push({ src, so: srcMatches[0].so, tgt, ti: ti2 });
        } else if (srcMatches.length > 1) {
          groups.push({ src, tgt, ti: ti2, tgtName: inp.label || inp.name || ("In " + ti2), srcMatches });
        }
      }
    }
  }
  if (autoConnections.length) {
    c.graph.beforeChange();
    for (const ac of autoConnections) {
      try {
        ac.src.connect(ac.so, ac.tgt, ac.ti);
      } catch (e) {
        console.error(e);
      }
    }
    c.graph.afterChange();
  }
  if (!groups.length) {
    c.setDirty(true, true);
    showToast("Batch connected");
    return;
  }

  const { body, footer, close } = createGlassModal({
    title: "Batch Connect",
    subtitle: "Multiple compatible outputs found — pick which slot to connect.",
    icon: LD_ICONS.link,
    width: "440px",
    maxHeight: "75vh",
  });

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const heading = document.createElement("div");
    heading.style.cssText = "margin:8px 0 5px;font-size:12px;color:#aaa;";
    heading.innerHTML =
      `<strong>${esc(g.src.title || g.src.type)}</strong> \u2192 ` +
      `<span style="color:${ACCENT};font-weight:600;">${esc(g.tgt.title || g.tgt.type)}</span> ` +
      `<span style="color:#888;">(${esc(g.tgtName)})</span>`;
    body.appendChild(heading);

    for (const m of g.srcMatches) {
      const row = document.createElement("div");
      row.className = "ld-row-item";
      row.innerHTML =
        `<span style="font-family:${FONT_MONO};color:#fff;">${esc(m.name)}</span>` +
        `<span style="font-size:11px;color:${ACCENT};">Connect</span>`;
      row.onclick = () => {
        c.graph.beforeChange();
        try {
          g.src.connect(m.so, g.tgt, g.ti);
        } catch (e) {
          console.error(e);
        }
        c.graph.afterChange();
        c.setDirty(true, true);
        row.style.opacity = "0.4";
        row.style.pointerEvents = "none";
      };
      body.appendChild(row);
    }
  }

  footer.style.display = "flex";
  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.className = "ld-btn ld-btn-primary";
  doneBtn.textContent = "Done";
  doneBtn.onclick = () => {
    close();
    c.setDirty(true, true);
    showToast("Batch connected");
  };
  footer.appendChild(doneBtn);
}
