// LiveDev Workflow Gallery for ComfyUI.
//
// Displays every workflow across ComfyUI user folders, blueprints, built-in templates, and
// custom_nodes (including all nested subfolders) with visual thumbnails (real images, custom
// covers, or auto-generated blueprint graph previews), multiple view modes (Grid / Tiles / List),
// and multiple card sizes (S / M / L / XL).

import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import { esc, showToast } from "./utils.js";
import { LD_ICONS, createGlassModal, ensureTheme } from "./livedev-theme.js";

const LS_VIEW = "livedev_wfGalleryView";
const LS_SIZE = "livedev_wfGallerySize";
const LS_SORT = "livedev_wfGallerySort";
const LS_FAVS = "livedev_wfGalleryFavs";
const LS_RECENT = "livedev_wfGalleryRecent";
const LS_SIDEBAR = "livedev_wfGallerySidebar";
const PAGE_BATCH = 80;
const MAX_RECENT = 40;

const SOURCE_LABELS = {
  all: "All",
  favorites: "Favourites",
  recent: "Recent",
  blueprints: "Blueprints",
  comfy: "User",
  custom_nodes: "Custom Nodes",
  templates: "Templates",
  other: "Other",
};

const SOURCE_BADGES = {
  blueprints: "Blueprint",
  comfy: "User",
  custom_nodes: "Custom Node",
  templates: "Template",
  other: "Folder",
};

function _lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw != null ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function _lsSet(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch (e) {}
}

function _formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

function _formatDate(mtime) {
  const ts = Number(mtime) || 0;
  if (!ts) return "-";
  try {
    return new Date(ts * 1000).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch (e) {
    return "-";
  }
}

async function _loadWorkflowIntoCanvas(wfId, fallbackName) {
  try {
    const res = await api.fetchApi(`/livedev/workflows/load/${encodeURIComponent(wfId)}`);
    const data = await res.json();
    if (!data?.ok || !data.workflow) {
      showToast(`LiveDev: ${data?.error || "Failed to load workflow"}`);
      return false;
    }
    const wf = data.workflow;
    const title = data.name || fallbackName || "workflow";
    if (Array.isArray(wf?.nodes)) {
      await app.loadGraphData(wf, true, true, title);
    } else if (typeof app.loadApiJson === "function") {
      await app.loadApiJson(wf, title);
    } else {
      await app.loadGraphData(wf, true, true, title);
    }
    showToast(`LiveDev: Loaded "${title}"`);
    return true;
  } catch (err) {
    console.error("[LiveDev] Workflow load error:", err);
    showToast(`LiveDev: Could not load workflow (${err.message || err})`);
    return false;
  }
}

async function _uploadCustomThumb(wfId, dataUrl, clear = false) {
  const res = await api.fetchApi(`/livedev/workflows/thumb/${encodeURIComponent(wfId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(clear ? { clear: true } : { image: dataUrl }),
  });
  const d = await res.json();
  if (!res.ok || !d?.ok) {
    throw new Error(d?.error || `HTTP ${res.status}`);
  }
  return d;
}

function _captureCanvasDataUrl() {
  const canvasEl = app.canvas?.canvas;
  if (!canvasEl || typeof canvasEl.toDataURL !== "function") return null;
  try {
    // Downscale to a crisp 640px-wide preview so thumbnails stay tiny and fast
    const srcW = canvasEl.width || 640;
    const srcH = canvasEl.height || 400;
    const targetW = Math.min(640, srcW);
    const targetH = Math.max(180, Math.round((srcH / Math.max(1, srcW)) * targetW));
    const tmp = document.createElement("canvas");
    tmp.width = targetW;
    tmp.height = targetH;
    const ctx = tmp.getContext("2d");
    if (!ctx) return canvasEl.toDataURL("image/png");
    ctx.fillStyle = "#101216";
    ctx.fillRect(0, 0, targetW, targetH);
    ctx.drawImage(canvasEl, 0, 0, targetW, targetH);
    const webp = tmp.toDataURL("image/webp", 0.86);
    if (webp && webp.startsWith("data:image/webp")) return webp;
    return tmp.toDataURL("image/png");
  } catch (e) {
    return null;
  }
}

function _readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read selected image"));
    reader.readAsDataURL(file);
  });
}

let _activeGalleryClose = null;

export function openWorkflowGalleryModal() {
  ensureTheme();
  if (typeof _activeGalleryClose === "function") {
    _activeGalleryClose();
    _activeGalleryClose = null;
  }

  let allItems = [];
  let counts = { all: 0, blueprints: 0, comfy: 0, custom_nodes: 0, templates: 0, other: 0 };
  let activeSource = "all";
  // Folder filter object: null | { source, prefix, exact }
  let activeFolderFilter = null;
  let query = "";
  let viewMode = _lsGet(LS_VIEW, "grid");
  if (!["grid", "tiles", "list"].includes(viewMode)) viewMode = "grid";
  let cardSize = _lsGet(LS_SIZE, "m");
  if (!["s", "m", "l", "xl"].includes(cardSize)) cardSize = "m";
  let sortBy = _lsGet(LS_SORT, "name");
  let sidebarOpen = _lsGet(LS_SIDEBAR, true);
  let visibleLimit = PAGE_BATCH;
  const favSet = new Set(Array.isArray(_lsGet(LS_FAVS, [])) ? _lsGet(LS_FAVS, []) : []);
  let recentIds = Array.isArray(_lsGet(LS_RECENT, [])) ? _lsGet(LS_RECENT, []).filter((x) => typeof x === "string") : [];
  const expandedTree = new Set(["section::user"]);
  const thumbVersions = new Map();

  const saveFavs = () => _lsSet(LS_FAVS, [...favSet]);
  const recordRecent = (wfId) => {
    if (!wfId) return;
    recentIds = [wfId, ...recentIds.filter((id) => id !== wfId)].slice(0, MAX_RECENT);
    _lsSet(LS_RECENT, recentIds);
  };
  const thumbUrl = (id) => {
    const v = thumbVersions.get(id);
    return `/livedev/workflows/thumb/${encodeURIComponent(id)}${v ? `?v=${v}` : ""}`;
  };

  const { body, footer, close } = createGlassModal({
    title: "Workflow Gallery",
    subtitle: "Browse all ComfyUI, custom_nodes, blueprint, and template workflows across every subfolder.",
    icon: LD_ICONS.gallery,
    width: "min(1260px, 94vw)",
    maxHeight: "90vh",
    draggable: true,
    onClose: () => {
      _activeGalleryClose = null;
    },
  });
  _activeGalleryClose = close;

  const shell = document.createElement("div");
  shell.className = "ld-wfg-shell";
  body.appendChild(shell);

  // Hidden shared file input for setting custom covers
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/png,image/webp,image/jpeg,image/gif";
  fileInput.style.display = "none";
  shell.appendChild(fileInput);
  let pendingThumbItem = null;
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    const targetItem = pendingThumbItem;
    fileInput.value = "";
    pendingThumbItem = null;
    if (!file || !targetItem) return;
    try {
      const dataUrl = await _readFileAsDataUrl(file);
      await _uploadCustomThumb(targetItem.id, dataUrl, false);
      targetItem.hasCustomThumb = true;
      targetItem.hasPhotoThumb = true;
      thumbVersions.set(targetItem.id, Date.now());
      showToast(`LiveDev: Cover updated for "${targetItem.name}"`);
      renderGrid();
    } catch (err) {
      showToast(`LiveDev: Cover upload failed (${err.message || err})`);
    }
  });

  // Top source tabs row
  const topbar = document.createElement("div");
  topbar.className = "ld-wfg-topbar";
  const tabsWrap = document.createElement("div");
  tabsWrap.className = "ld-wfg-tabs";
  topbar.appendChild(tabsWrap);
  shell.appendChild(topbar);

  // Controls bar: Sidebar toggle, Search, Sort, View Mode, Card Size, Refresh
  const controls = document.createElement("div");
  controls.className = "ld-wfg-controls";

  const sidebarBtn = document.createElement("button");
  sidebarBtn.type = "button";
  sidebarBtn.className = "ld-wfg-seg-btn" + (sidebarOpen ? " is-active" : "");
  sidebarBtn.innerHTML = LD_ICONS.sidebar;
  sidebarBtn.title = "Toggle folders sidebar";
  sidebarBtn.onclick = () => {
    sidebarOpen = !sidebarOpen;
    _lsSet(LS_SIDEBAR, sidebarOpen);
    sidebarBtn.classList.toggle("is-active", sidebarOpen);
    sidebar.classList.toggle("is-hidden", !sidebarOpen);
  };

  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.className = "ld-wfg-search";
  searchInput.placeholder = "Search workflows, folders, or custom node packs...";
  let searchTimer = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      query = searchInput.value.trim().toLowerCase();
      visibleLimit = PAGE_BATCH;
      renderGrid();
    }, 100);
  });

  const sortSelect = document.createElement("select");
  sortSelect.className = "ld-wfg-select";
  sortSelect.title = "Sort workflows";
  for (const [val, label] of [
    ["name", "Sort: Name (A-Z)"],
    ["recent", "Sort: Recently Modified"],
    ["nodes", "Sort: Most Nodes"],
    ["photos", "Sort: Photos First"],
  ]) {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = label;
    if (val === sortBy) o.selected = true;
    sortSelect.appendChild(o);
  }
  sortSelect.addEventListener("change", () => {
    sortBy = sortSelect.value;
    _lsSet(LS_SORT, sortBy);
    visibleLimit = PAGE_BATCH;
    renderGrid();
  });

  // View mode selector: Grid / Tiles / List
  const viewSeg = document.createElement("div");
  viewSeg.className = "ld-wfg-seg";
  const viewButtons = {};
  for (const [mode, icon, tip] of [
    ["grid", LD_ICONS.grid, "Grid cards view"],
    ["tiles", LD_ICONS.tileView, "Visual tiles view"],
    ["list", LD_ICONS.listView, "Detailed list view"],
  ]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ld-wfg-seg-btn" + (viewMode === mode ? " is-active" : "");
    b.innerHTML = icon;
    b.title = tip;
    b.onclick = () => {
      const prev = viewMode;
      viewMode = mode;
      _lsSet(LS_VIEW, mode);
      for (const [k, btnEl] of Object.entries(viewButtons)) {
        btnEl.classList.toggle("is-active", k === viewMode);
      }
      if ((prev === "list") !== (viewMode === "list")) renderGrid();
      else syncGridClasses();
    };
    viewButtons[mode] = b;
    viewSeg.appendChild(b);
  }

  // Size selector: S / M / L / XL
  const sizeSeg = document.createElement("div");
  sizeSeg.className = "ld-wfg-seg";
  const sizeButtons = {};
  for (const [sz, lbl, tip] of [
    ["s", "S", "Small cards"],
    ["m", "M", "Medium cards"],
    ["l", "L", "Large cards"],
    ["xl", "XL", "Extra-large cards"],
  ]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ld-wfg-seg-btn" + (cardSize === sz ? " is-active" : "");
    b.textContent = lbl;
    b.title = tip;
    b.onclick = () => {
      cardSize = sz;
      _lsSet(LS_SIZE, sz);
      for (const [k, btnEl] of Object.entries(sizeButtons)) {
        btnEl.classList.toggle("is-active", k === cardSize);
      }
      syncGridClasses();
    };
    sizeButtons[sz] = b;
    sizeSeg.appendChild(b);
  }

  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "ld-wfg-seg-btn";
  refreshBtn.innerHTML = LD_ICONS.refresh;
  refreshBtn.title = "Rescan all ComfyUI & custom_nodes workflow folders";
  refreshBtn.onclick = () => fetchWorkflows(true);

  controls.append(sidebarBtn, searchInput, sortSelect, viewSeg, sizeSeg, refreshBtn);
  shell.appendChild(controls);

  // Main split: Folder tree sidebar + Scrollable gallery grid
  const main = document.createElement("div");
  main.className = "ld-wfg-main";

  const sidebar = document.createElement("div");
  sidebar.className = "ld-wfg-sidebar" + (sidebarOpen ? "" : " is-hidden");

  const content = document.createElement("div");
  content.className = "ld-wfg-content";

  const gridEl = document.createElement("div");
  content.appendChild(gridEl);

  const moreRow = document.createElement("div");
  moreRow.className = "ld-wfg-more-row";
  moreRow.style.display = "none";
  const moreBtn = document.createElement("button");
  moreBtn.type = "button";
  moreBtn.className = "ld-btn";
  moreBtn.onclick = () => {
    visibleLimit += PAGE_BATCH;
    renderGrid();
  };
  moreRow.appendChild(moreBtn);
  content.appendChild(moreRow);

  main.append(sidebar, content);
  shell.appendChild(main);

  // Footer status line
  footer.style.display = "flex";
  const statusEl = document.createElement("span");
  statusEl.style.cssText = "font-size:11.5px;color:#8b95a5;";
  statusEl.textContent = "Scanning workflow directories...";
  const hintEl = document.createElement("span");
  hintEl.style.cssText = "font-size:11px;color:#7f8998;";
  hintEl.textContent = "Click any card to load · Use camera icon to set a custom cover or capture canvas";
  footer.append(statusEl, hintEl);

  function syncGridClasses() {
    gridEl.className = `ld-wfg-grid view-${viewMode} size-${cardSize}`;
  }
  syncGridClasses();

  function openCoverActions(item) {
    const { body: cBody, close: cClose } = createGlassModal({
      title: "Workflow Cover Image",
      subtitle: item.relPath || item.name,
      icon: LD_ICONS.camera,
      width: "400px",
      draggable: true,
    });
    const stack = document.createElement("div");
    stack.style.cssText = "display:flex;flex-direction:column;gap:8px;";

    const uploadBtn = document.createElement("button");
    uploadBtn.type = "button";
    uploadBtn.className = "ld-btn ld-btn-primary";
    uploadBtn.style.cssText = "justify-content:center;padding:9px 12px;";
    uploadBtn.innerHTML = LD_ICONS.camera + "<span>Choose Image File...</span>";
    uploadBtn.onclick = () => {
      cClose();
      pendingThumbItem = item;
      fileInput.click();
    };

    const snapBtn = document.createElement("button");
    snapBtn.type = "button";
    snapBtn.className = "ld-btn";
    snapBtn.style.cssText = "justify-content:center;padding:9px 12px;";
    snapBtn.innerHTML = LD_ICONS.gallery + "<span>Capture Current Canvas As Cover</span>";
    snapBtn.onclick = async () => {
      const dataUrl = _captureCanvasDataUrl();
      if (!dataUrl) {
        showToast("LiveDev: Could not capture canvas");
        return;
      }
      try {
        await _uploadCustomThumb(item.id, dataUrl, false);
        item.hasCustomThumb = true;
        item.hasPhotoThumb = true;
        thumbVersions.set(item.id, Date.now());
        showToast(`LiveDev: Captured canvas cover for "${item.name}"`);
        cClose();
        renderGrid();
      } catch (err) {
        showToast(`LiveDev: Failed to save cover (${err.message || err})`);
      }
    };

    stack.append(uploadBtn, snapBtn);

    if (item.hasCustomThumb) {
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "ld-btn ld-btn-danger";
      clearBtn.style.cssText = "justify-content:center;padding:8px 12px;";
      clearBtn.innerHTML = LD_ICONS.trash + "<span>Reset To Auto Preview</span>";
      clearBtn.onclick = async () => {
        try {
          await _uploadCustomThumb(item.id, null, true);
          item.hasCustomThumb = false;
          thumbVersions.set(item.id, Date.now());
          showToast(`LiveDev: Reset cover for "${item.name}"`);
          cClose();
          renderGrid();
        } catch (err) {
          showToast(`LiveDev: Failed to reset cover (${err.message || err})`);
        }
      };
      stack.appendChild(clearBtn);
    }

    cBody.appendChild(stack);
  }

  function openPreviewLightbox(item) {
    const { body: pBody, footer: pFoot, close: pClose } = createGlassModal({
      title: item.name,
      subtitle: item.relPath || item.folder,
      icon: LD_ICONS.gallery,
      width: "min(760px, 92vw)",
      maxHeight: "88vh",
      draggable: true,
    });

    const img = document.createElement("img");
    img.className = "ld-wfg-lightbox-img";
    img.src = thumbUrl(item.id);
    img.alt = item.name;
    pBody.appendChild(img);

    const kvGrid = document.createElement("div");
    kvGrid.className = "ld-wfg-lightbox-meta";
    const pairs = [
      ["Source", SOURCE_BADGES[item.source] || item.source],
      ["Folder", item.folder || "Root"],
      ["Nodes / Links", `${item.nodeCount} nodes · ${item.linkCount} links`],
      ["File Size", _formatBytes(item.size)],
      ["Modified", _formatDate(item.mtime)],
      ["Cover", item.hasCustomThumb ? "Custom Cover" : item.hasPhotoThumb ? "Image File" : "Auto Blueprint"],
    ];
    for (const [k, v] of pairs) {
      const cell = document.createElement("div");
      cell.className = "ld-wfg-kv";
      cell.innerHTML = `<div class="ld-wfg-kv-k">${esc(k)}</div><div class="ld-wfg-kv-v">${esc(v)}</div>`;
      kvGrid.appendChild(cell);
    }
    pBody.appendChild(kvGrid);

    pFoot.style.display = "flex";
    const coverBtn = document.createElement("button");
    coverBtn.type = "button";
    coverBtn.className = "ld-btn";
    coverBtn.innerHTML = LD_ICONS.camera + "<span>Set Cover</span>";
    coverBtn.onclick = () => {
      pClose();
      openCoverActions(item);
    };

    const loadBtn = document.createElement("button");
    loadBtn.type = "button";
    loadBtn.className = "ld-btn ld-btn-primary";
    loadBtn.innerHTML = LD_ICONS.bolt + "<span>Load Workflow</span>";
    loadBtn.onclick = async () => {
      const ok = await _loadWorkflowIntoCanvas(item.id, item.name);
      if (ok) {
        recordRecent(item.id);
        pClose();
        close();
      }
    };
    pFoot.append(coverBtn, loadBtn);
  }

  function renderTabs() {
    tabsWrap.innerHTML = "";
    const tabOrder = ["all", "favorites", "recent"];
    if ((counts.blueprints || 0) > 0) tabOrder.push("blueprints");
    tabOrder.push("comfy", "custom_nodes");
    if ((counts.templates || 0) > 0) tabOrder.push("templates");
    if ((counts.other || 0) > 0) tabOrder.push("other");

    const idSet = new Set(allItems.map((it) => it.id));
    for (const key of tabOrder) {
      const cnt = key === "favorites"
        ? allItems.filter((it) => favSet.has(it.id)).length
        : key === "recent"
        ? recentIds.filter((id) => idSet.has(id)).length
        : (counts[key] || 0);
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "ld-wfg-tab" + (activeSource === key ? " is-active" : "");
      tab.innerHTML = `<span>${esc(SOURCE_LABELS[key] || key)}</span><span class="ld-wfg-tab-cnt">${cnt}</span>`;
      tab.onclick = () => {
        activeSource = key;
        activeFolderFilter = null;
        visibleLimit = PAGE_BATCH;
        renderTabs();
        renderSidebar();
        renderGrid();
      };
      tabsWrap.appendChild(tab);
    }
  }

  function _matchesFolderFilter(item, filter) {
    if (!filter) return true;
    if (filter.special === "favorites") return favSet.has(item.id);
    if (filter.special === "recent") return recentIds.includes(item.id);
    if (filter.source && item.source !== filter.source) return false;
    if (!filter.prefix) return true;
    if (filter.exact) return item.folder === filter.prefix;
    return item.folder === filter.prefix || item.folder.startsWith(filter.prefix + "/");
  }

  function _isSameFilter(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return (
      (a.special || "") === (b.special || "") &&
      (a.source || "") === (b.source || "") &&
      (a.prefix || "") === (b.prefix || "") &&
      Boolean(a.exact) === Boolean(b.exact)
    );
  }

  function _buildDirRow({ label, count, filter, treeKey, hasChildren, isParent, title, icon }) {
    const row = document.createElement("div");
    row.className = "ld-wfg-dir-row";

    const chev = document.createElement("button");
    chev.type = "button";
    chev.className = "ld-wfg-dir-chev" + (hasChildren ? "" : " is-spacer");
    chev.textContent = hasChildren ? (expandedTree.has(treeKey) ? "\u25be" : "\u25b8") : "";
    chev.title = hasChildren ? "Expand / collapse subfolders" : "";
    chev.onclick = (e) => {
      e.stopPropagation();
      if (!hasChildren) return;
      if (expandedTree.has(treeKey)) expandedTree.delete(treeKey);
      else expandedTree.add(treeKey);
      renderSidebar();
    };

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "ld-wfg-dir-btn" +
      (isParent ? " is-parent" : "") +
      (_isSameFilter(activeFolderFilter, filter) ? " is-active" : "");
    btn.title = title || label;
    btn.innerHTML =
      `${icon || LD_ICONS.folder}<span class="ld-wfg-dir-name">${esc(label)}</span>` +
      `<span class="ld-wfg-dir-cnt">${count}</span>`;
    btn.onclick = () => {
      activeFolderFilter = filter;
      visibleLimit = PAGE_BATCH;
      renderSidebar();
      renderGrid();
    };

    row.append(chev, btn);
    return row;
  }

  function _scopedItemsForSidebar() {
    if (activeSource === "favorites") return allItems.filter((it) => favSet.has(it.id));
    if (activeSource === "recent") {
      const rSet = new Set(recentIds);
      return allItems.filter((it) => rSet.has(it.id));
    }
    if (activeSource === "all") return allItems;
    return allItems.filter((it) => it.source === activeSource);
  }

  function _renderTreeSection(parentEl, { treeKey, label, source, items, splitByRootSegment = false }) {
    if (!items.length) return;

    // Build folder counts from the scoped items
    const folderMap = new Map();
    for (const it of items) {
      const fld = it.folder || "Root";
      folderMap.set(fld, (folderMap.get(fld) || 0) + 1);
    }

    if (splitByRootSegment) {
      // Group by first path segment (e.g. each custom node pack, or each top-level folder under "other")
      const groups = new Map();
      for (const [fld, cnt] of folderMap.entries()) {
        const seg = fld.split("/")[0] || fld;
        if (!groups.has(seg)) groups.set(seg, { total: 0, subfolders: [] });
        const g = groups.get(seg);
        g.total += cnt;
        g.subfolders.push({ folder: fld, count: cnt });
      }
      const sortedGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));

      if (label) {
        // Parent collapsible node (e.g. Custom Nodes, Templates)
        const hasChildren = sortedGroups.length > 0;
        parentEl.appendChild(
          _buildDirRow({
            label,
            count: items.length,
            filter: { source, prefix: "", exact: false },
            treeKey,
            hasChildren,
            isParent: true,
          })
        );
        if (hasChildren && expandedTree.has(treeKey)) {
          const wrap = document.createElement("div");
          wrap.className = "ld-wfg-dir-children";
          for (const [seg, g] of sortedGroups) {
            const subKey = `${treeKey}::${seg}`;
            const nested = g.subfolders.filter((s) => s.folder !== seg).sort((a, b) => a.folder.localeCompare(b.folder));
            wrap.appendChild(
              _buildDirRow({
                label: seg,
                count: g.total,
                filter: { source, prefix: seg, exact: false },
                treeKey: subKey,
                hasChildren: nested.length > 0,
                isParent: false,
                title: seg,
              })
            );
            if (nested.length > 0 && expandedTree.has(subKey)) {
              const subWrap = document.createElement("div");
              subWrap.className = "ld-wfg-dir-children";
              const directCount = folderMap.get(seg) || 0;
              if (directCount > 0) {
                subWrap.appendChild(
                  _buildDirRow({
                    label: "Root",
                    count: directCount,
                    filter: { source, prefix: seg, exact: true },
                    treeKey: `${subKey}::__root`,
                    hasChildren: false,
                    isParent: false,
                    title: `${seg} (Root)`,
                  })
                );
              }
              for (const sf of nested) {
                const relLabel = sf.folder.slice(seg.length + 1);
                subWrap.appendChild(
                  _buildDirRow({
                    label: relLabel,
                    count: sf.count,
                    filter: { source, prefix: sf.folder, exact: true },
                    treeKey: `${subKey}::${sf.folder}`,
                    hasChildren: false,
                    isParent: false,
                    title: sf.folder,
                  })
                );
              }
              wrap.appendChild(subWrap);
            }
          }
          parentEl.appendChild(wrap);
        }
      } else {
        // Render each top-level folder directly as its own named section (for "other" locations)
        for (const [seg, g] of sortedGroups) {
          const segKey = `${treeKey}::${seg}`;
          const nested = g.subfolders.filter((s) => s.folder !== seg).sort((a, b) => a.folder.localeCompare(b.folder));
          parentEl.appendChild(
            _buildDirRow({
              label: seg,
              count: g.total,
              filter: { source, prefix: seg, exact: false },
              treeKey: segKey,
              hasChildren: nested.length > 0,
              isParent: true,
              title: seg,
            })
          );
          if (nested.length > 0 && expandedTree.has(segKey)) {
            const subWrap = document.createElement("div");
            subWrap.className = "ld-wfg-dir-children";
            const directCount = folderMap.get(seg) || 0;
            if (directCount > 0) {
              subWrap.appendChild(
                _buildDirRow({
                  label: "Root",
                  count: directCount,
                  filter: { source, prefix: seg, exact: true },
                  treeKey: `${segKey}::__root`,
                  hasChildren: false,
                  isParent: false,
                  title: `${seg} (Root)`,
                })
              );
            }
            for (const sf of nested) {
              const relLabel = sf.folder.slice(seg.length + 1);
              subWrap.appendChild(
                _buildDirRow({
                  label: relLabel,
                  count: sf.count,
                  filter: { source, prefix: sf.folder, exact: true },
                  treeKey: `${segKey}::${sf.folder}`,
                  hasChildren: false,
                  isParent: false,
                  title: sf.folder,
                })
              );
            }
            parentEl.appendChild(subWrap);
          }
        }
      }
      return;
    }

    // Flat subfolder list under a single parent (Blueprints, User)
    const entries = [...folderMap.entries()].sort((a, b) => {
      if (a[0] === "Root" || a[0] === label) return -1;
      if (b[0] === "Root" || b[0] === label) return 1;
      return a[0].localeCompare(b[0]);
    });
    const hasRealSubfolders = entries.length > 1 || (entries.length === 1 && entries[0][0] !== "Root" && entries[0][0] !== label);

    parentEl.appendChild(
      _buildDirRow({
        label,
        count: items.length,
        filter: { source, prefix: "", exact: false },
        treeKey,
        hasChildren: hasRealSubfolders,
        isParent: true,
      })
    );

    if (hasRealSubfolders && expandedTree.has(treeKey)) {
      const wrap = document.createElement("div");
      wrap.className = "ld-wfg-dir-children";
      for (const [fld, cnt] of entries) {
        const displayName = fld === label ? "Root" : fld;
        wrap.appendChild(
          _buildDirRow({
            label: displayName,
            count: cnt,
            filter: { source, prefix: fld, exact: true },
            treeKey: `${treeKey}::${fld}`,
            hasChildren: false,
            isParent: false,
            title: fld,
          })
        );
      }
      parentEl.appendChild(wrap);
    }
  }

  function renderSidebar() {
    sidebar.innerHTML = "";
    const scoped = _scopedItemsForSidebar();
    const scopedIds = new Set(scoped.map((it) => it.id));
    const favCount = scoped.filter((it) => favSet.has(it.id)).length;
    const recentCount = recentIds.filter((id) => scopedIds.has(id)).length;

    // 0. All Folders, Favourites, Recent
    sidebar.appendChild(
      _buildDirRow({
        label: "All Folders",
        count: scoped.length,
        filter: null,
        treeKey: "section::all",
        hasChildren: false,
        isParent: true,
      })
    );
    sidebar.appendChild(
      _buildDirRow({
        label: "Favourites",
        count: favCount,
        filter: { special: "favorites" },
        treeKey: "section::favorites",
        hasChildren: false,
        isParent: true,
        icon: LD_ICONS.starFilled,
      })
    );
    sidebar.appendChild(
      _buildDirRow({
        label: "Recent",
        count: recentCount,
        filter: { special: "recent" },
        treeKey: "section::recent",
        hasChildren: false,
        isParent: true,
        icon: LD_ICONS.history,
      })
    );

    const bySource = {
      blueprints: [],
      comfy: [],
      custom_nodes: [],
      templates: [],
      other: [],
    };
    for (const it of scoped) {
      if (bySource[it.source]) bySource[it.source].push(it);
      else bySource.other.push(it);
    }

    // 1. Blueprints
    if (bySource.blueprints.length) {
      _renderTreeSection(sidebar, {
        treeKey: "section::blueprints",
        label: "Blueprints",
        source: "blueprints",
        items: bySource.blueprints,
        splitByRootSegment: false,
      });
    }

    // 2. ComfyUI -> User (user/default/Workflows) + Custom Nodes
    if (bySource.comfy.length || bySource.custom_nodes.length) {
      const heading = document.createElement("div");
      heading.className = "ld-wfg-dir-group";
      heading.textContent = "ComfyUI";
      sidebar.appendChild(heading);

      if (bySource.comfy.length) {
        _renderTreeSection(sidebar, {
          treeKey: "section::user",
          label: "User",
          source: "comfy",
          items: bySource.comfy,
          splitByRootSegment: false,
        });
      }
      if (bySource.custom_nodes.length) {
        _renderTreeSection(sidebar, {
          treeKey: "section::custom_nodes",
          label: "Custom Nodes",
          source: "custom_nodes",
          items: bySource.custom_nodes,
          splitByRootSegment: true,
        });
      }
    }

    // 3. Other workflow locations (Templates + any extra folder discovered under its own folder name)
    if (bySource.templates.length || bySource.other.length) {
      const heading = document.createElement("div");
      heading.className = "ld-wfg-dir-group";
      heading.textContent = "Other Locations";
      sidebar.appendChild(heading);

      if (bySource.templates.length) {
        _renderTreeSection(sidebar, {
          treeKey: "section::templates",
          label: "Templates",
          source: "templates",
          items: bySource.templates,
          splitByRootSegment: true,
        });
      }
      if (bySource.other.length) {
        _renderTreeSection(sidebar, {
          treeKey: "section::other",
          label: "",
          source: "other",
          items: bySource.other,
          splitByRootSegment: true,
        });
      }
    }
  }

  function getFilteredItems() {
    const isRecentView = activeSource === "recent" || activeFolderFilter?.special === "recent";
    let list = allItems.filter((it) => {
      if (activeSource === "favorites" && !favSet.has(it.id)) return false;
      if (activeSource === "recent" && !recentIds.includes(it.id)) return false;
      if (activeSource !== "all" && activeSource !== "favorites" && activeSource !== "recent" && it.source !== activeSource) return false;
      if (!_matchesFolderFilter(it, activeFolderFilter)) return false;
      if (query) {
        const hay = `${it.name} ${it.folder} ${it.pack} ${it.relPath}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });

    if (isRecentView) {
      const rank = new Map(recentIds.map((id, idx) => [id, idx]));
      list = [...list].sort((a, b) => (rank.get(a.id) ?? 9999) - (rank.get(b.id) ?? 9999));
    } else if (sortBy === "recent") {
      list = [...list].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    } else if (sortBy === "nodes") {
      list = [...list].sort((a, b) => (b.nodeCount || 0) - (a.nodeCount || 0) || a.name.localeCompare(b.name));
    } else if (sortBy === "photos") {
      list = [...list].sort((a, b) => Number(b.hasPhotoThumb) - Number(a.hasPhotoThumb) || a.name.localeCompare(b.name));
    } else {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    }
    return list;
  }

  function renderGrid() {
    syncGridClasses();
    const filtered = getFilteredItems();
    statusEl.textContent = `Showing ${Math.min(filtered.length, visibleLimit)} of ${filtered.length} workflows (${allItems.length} total)`;

    gridEl.innerHTML = "";
    if (!filtered.length) {
      moreRow.style.display = "none";
      const empty = document.createElement("div");
      empty.className = "ld-wfg-empty";
      const isFavEmpty = activeSource === "favorites" || activeFolderFilter?.special === "favorites";
      const isRecEmpty = activeSource === "recent" || activeFolderFilter?.special === "recent";
      empty.textContent = query
        ? `No workflows match "${query}".`
        : isFavEmpty
        ? "No favourite workflows yet. Click the star icon on any workflow card to pin it here."
        : isRecEmpty
        ? "No recently opened workflows yet. Open any workflow from the gallery and it will appear here."
        : "No workflows found in this folder.";
      gridEl.appendChild(empty);
      return;
    }

    const slice = filtered.slice(0, visibleLimit);
    const frag = document.createDocumentFragment();

    for (const item of slice) {
      const isFav = favSet.has(item.id);
      const card = document.createElement("div");
      card.className = "ld-wfg-card" + (isFav ? " is-fav" : "");
      card.title = `${item.name}\n${item.relPath}\nClick to load workflow`;
      card.addEventListener("click", async () => {
        const ok = await _loadWorkflowIntoCanvas(item.id, item.name);
        if (ok) {
          recordRecent(item.id);
          close();
        }
      });

      const thumbWrap = document.createElement("div");
      thumbWrap.className = "ld-wfg-thumb-wrap";

      const img = document.createElement("img");
      img.className = "ld-wfg-thumb";
      img.loading = "lazy";
      img.decoding = "async";
      img.src = thumbUrl(item.id);
      img.alt = item.name;
      thumbWrap.appendChild(img);

      const badges = document.createElement("div");
      badges.className = "ld-wfg-badges";
      const srcPill = document.createElement("span");
      srcPill.className = "ld-wfg-pill" + (item.source === "comfy" ? " is-accent" : "");
      srcPill.textContent =
        item.source === "other" && item.pack
          ? item.pack
          : SOURCE_BADGES[item.source] || item.source;
      badges.appendChild(srcPill);
      if (item.hasSubgraphs) {
        const sgPill = document.createElement("span");
        sgPill.className = "ld-wfg-pill is-accent";
        sgPill.textContent = "SG";
        badges.appendChild(sgPill);
      }
      thumbWrap.appendChild(badges);

      const actions = document.createElement("div");
      actions.className = "ld-wfg-actions";

      const favBtn = document.createElement("button");
      favBtn.type = "button";
      favBtn.className = "ld-wfg-act" + (isFav ? " is-fav" : "");
      favBtn.innerHTML = isFav ? LD_ICONS.starFilled : LD_ICONS.star;
      favBtn.title = isFav ? "Remove from Favorites" : "Add to Favorites";
      favBtn.onclick = (e) => {
        e.stopPropagation();
        if (favSet.has(item.id)) favSet.delete(item.id);
        else favSet.add(item.id);
        saveFavs();
        renderTabs();
        renderSidebar();
        renderGrid();
      };

      const coverBtn = document.createElement("button");
      coverBtn.type = "button";
      coverBtn.className = "ld-wfg-act";
      coverBtn.innerHTML = LD_ICONS.camera;
      coverBtn.title = "Set cover image or capture canvas";
      coverBtn.onclick = (e) => {
        e.stopPropagation();
        openCoverActions(item);
      };

      const previewBtn = document.createElement("button");
      previewBtn.type = "button";
      previewBtn.className = "ld-wfg-act";
      previewBtn.innerHTML = LD_ICONS.expand;
      previewBtn.title = "Preview workflow details";
      previewBtn.onclick = (e) => {
        e.stopPropagation();
        openPreviewLightbox(item);
      };

      actions.append(favBtn, coverBtn, previewBtn);

      const meta = document.createElement("div");
      meta.className = "ld-wfg-meta";

      const titleEl = document.createElement("div");
      titleEl.className = "ld-wfg-title";
      titleEl.textContent = item.name;

      const subEl = document.createElement("div");
      subEl.className = "ld-wfg-sub";

      const pathEl = document.createElement("span");
      pathEl.className = "ld-wfg-path";
      pathEl.textContent = item.folder || "Root";

      const statEl = document.createElement("span");
      statEl.className = "ld-wfg-stat";
      statEl.textContent = `${item.nodeCount}n`;

      subEl.append(pathEl, statEl);
      meta.append(titleEl, subEl);

      if (viewMode === "list") {
        card.append(thumbWrap, meta, actions);
      } else {
        thumbWrap.appendChild(actions);
        card.append(thumbWrap, meta);
      }
      frag.appendChild(card);
    }

    gridEl.appendChild(frag);

    if (filtered.length > visibleLimit) {
      moreRow.style.display = "flex";
      moreBtn.textContent = `Load More (${filtered.length - visibleLimit} remaining)`;
    } else {
      moreRow.style.display = "none";
    }
  }

  async function fetchWorkflows(force = false) {
    statusEl.textContent = force ? "Rescanning all workflow directories..." : "Loading workflows...";
    refreshBtn.disabled = true;
    try {
      const res = await api.fetchApi(`/livedev/workflows/list${force ? "?refresh=1" : ""}`);
      const data = await res.json();
      if (!data?.ok) {
        statusEl.textContent = `Scan failed: ${data?.error || "unknown error"}`;
        return;
      }
      allItems = Array.isArray(data.items) ? data.items : [];
      counts = data.counts || { all: allItems.length, blueprints: 0, comfy: 0, custom_nodes: 0, templates: 0, other: 0 };
      renderTabs();
      renderSidebar();
      renderGrid();
    } catch (err) {
      statusEl.textContent = `Failed to load workflows: ${err.message || err}`;
    } finally {
      refreshBtn.disabled = false;
    }
  }

  fetchWorkflows(false);
  setTimeout(() => searchInput.focus(), 60);
}

app.registerExtension({
  name: "LiveDev.WorkflowGallery",
  async setup() {},
});
