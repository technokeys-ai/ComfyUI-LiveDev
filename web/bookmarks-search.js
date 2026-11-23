import { app } from "../../scripts/app.js";
import { showToast, getSelectedArr, esc } from "./utils.js";
import { ACCENT, DANGER, FONT_MONO, LD_ICONS, createGlassModal } from "./livedev-theme.js";

app.registerExtension({
  name: "LiveDev.Bookmarks",
  async setup() {},
});

export function doAddBookmark() {
  const nodes = getSelectedArr();
  if (!nodes.length) return;
  let bm = [];
  try {
    const d = localStorage.getItem("livedev_bookmarks");
    if (d) bm = JSON.parse(d);
  } catch (e) {}
  const ids = new Set(nodes.map((n) => n.id));
  bm = bm.filter((b) => !ids.has(b.id));
  for (const n of nodes) {
    bm.push({
      id: n.id,
      title: n.title || n.type || "Node",
      type: n.type,
      pos: [n._pos[0], n._pos[1]],
    });
  }
  localStorage.setItem("livedev_bookmarks", JSON.stringify(bm));
  showToast("Bookmark added");
}

export function doShowBookmarks() {
  let bm = [];
  try {
    const d = localStorage.getItem("livedev_bookmarks");
    if (d) bm = JSON.parse(d);
  } catch (e) {}

  const { body, footer, close } = createGlassModal({
    title: "Node Bookmarks",
    subtitle: "Jump directly to saved nodes on the canvas.",
    icon: LD_ICONS.bookmark,
    width: "420px",
    maxHeight: "70vh",
  });

  if (!bm.length) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding:24px;color:#888;text-align:center;";
    empty.textContent = "No bookmarks saved yet. Select nodes and click Bookmarks to add.";
    body.appendChild(empty);
  } else {
    for (let bi = 0; bi < bm.length; bi++) {
      const b = bm[bi];
      const row = document.createElement("div");
      row.className = "ld-row-item";
      row.innerHTML =
        `<span style="flex:1;font-family:${FONT_MONO};font-weight:600;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(b.title)}</span>` +
        `<span style="color:#888;font-size:11px;margin-right:6px;">${esc(b.type)}</span>`;

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "ld-modal-close";
      delBtn.style.cssText = `width:22px;height:22px;font-size:12px;color:${DANGER};`;
      delBtn.textContent = "\u2715";
      delBtn.title = "Remove bookmark";
      delBtn.onclick = (e) => {
        e.stopPropagation();
        bm.splice(bi, 1);
        localStorage.setItem("livedev_bookmarks", JSON.stringify(bm));
        close();
        doShowBookmarks();
      };
      row.appendChild(delBtn);

      row.onclick = () => {
        const n = app.canvas?.graph?.getNodeById(b.id);
        if (n) {
          app.canvas?.centerOnNode(n);
          app.canvas?.setDirty(true, true);
        } else {
          showToast("Node not found in current graph");
        }
        close();
      };
      body.appendChild(row);
    }
  }

  footer.style.display = "flex";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ld-btn ld-btn-primary";
  closeBtn.textContent = "Done";
  closeBtn.onclick = close;
  footer.appendChild(closeBtn);
}

export function doNodeSearch() {
  const { body, footer, close } = createGlassModal({
    title: "Node Search",
    subtitle: "Filter and center any node in the current graph.",
    icon: LD_ICONS.search,
    width: "440px",
    maxHeight: "72vh",
  });

  const inp = document.createElement("input");
  inp.type = "text";
  inp.className = "ld-input";
  inp.placeholder = "Type node title or class name...";
  inp.style.width = "100%";

  const list = document.createElement("div");
  list.style.cssText = "margin-top:10px;max-height:320px;overflow-y:auto;";

  function filter() {
    const q = inp.value.trim().toLowerCase();
    const nodes = app.canvas?.graph?._nodes || [];
    list.innerHTML = "";
    let matched = 0;
    for (const n of nodes) {
      const title = n.title || n.type || "Node";
      const type = n.type || "";
      if (!q || title.toLowerCase().includes(q) || type.toLowerCase().includes(q)) {
        matched++;
        const el = document.createElement("div");
        el.className = "ld-row-item";
        el.innerHTML =
          `<span style="font-family:${FONT_MONO};font-weight:600;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(title)}</span>` +
          `<span style="font-size:11px;color:${ACCENT};flex-shrink:0;">#${esc(n.id)}</span>`;
        el.onclick = () => {
          app.canvas?.centerOnNode(n);
          app.canvas?.setDirty(true, true);
          close();
        };
        list.appendChild(el);
      }
    }
    if (!matched) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding:18px;color:#888;text-align:center;";
      empty.textContent = "No matching nodes found.";
      list.appendChild(empty);
    }
  }

  inp.oninput = filter;
  body.appendChild(inp);
  body.appendChild(list);

  footer.style.display = "flex";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ld-btn";
  closeBtn.textContent = "Close";
  closeBtn.onclick = close;
  footer.appendChild(closeBtn);

  setTimeout(() => inp.focus(), 40);
  filter();
}
