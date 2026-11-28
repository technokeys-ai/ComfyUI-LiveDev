// LiveDev Command Palette (Ctrl+K / Ctrl+Shift+P) for ComfyUI-LiveDev.
//
// Raycast / VS Code style glassmorphic spotlight palette to trigger any LiveDev tool, switch
// Wire Routing Modes and Wire Visual Effects live, or jump straight to any node on the canvas.

import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import { esc, showToast } from "./utils.js";
import {
  ACCENT,
  FONT_MONO,
  LD_ICONS,
  createGlassModal,
  ensureTheme,
} from "./livedev-theme.js";
import { openConsole } from "./livedev-toolkit.js";
import { openConsoleFilterModal } from "./console-filter.js";
import { openDependenciesHub } from "./livedev-deps-popup.js";
import { openReportPanel, lastError } from "./livedev-error-report.js";
import { openProfilerModal } from "./node-profiler.js";
import { openPreflightModal } from "./preflight-check.js";
import { openSnapshotsModal, captureWorkflowSnapshot } from "./workflow-snapshots.js";
import { openXYSweepModal } from "./xy-sweep.js";
import { openQueueInspectorModal } from "./queue-inspector.js";
import { doLocalizationScan } from "./localization.js";
import { doCleanUnused, doFixNodeIds } from "./cleanup.js";
import { doShowBookmarks, doNodeSearch } from "./bookmarks-search.js";
import { doSmartAutoLayout, doZoomToFit } from "./advanced.js";
import { rebuildStaleNodes } from "./node-tools.js";
import { resetToolbarPosition } from "./align-toolbar.js";
import { isAlignSnapEnabled, toggleAlignSnapEnabled } from "./align-snap-guides.js";
import { openWorkflowGalleryModal } from "./workflow-gallery.js";
import {
  WIRE_MODES,
  WIRE_VISUAL_STYLES,
  applyWireSettings,
  toggleNodesLinksHidden,
  showAllHiddenLinks,
} from "./livedev-wires.js";
import { doFoldToggle, doUnfoldAll } from "./visual-fold.js";

let activePaletteClose = null;

function focusCanvasNode(node) {
  const canvas = app.canvas;
  if (!node || !canvas) return;
  try {
    canvas.selectNode(node, false);
    if (typeof canvas.centerOnNode === "function") {
      canvas.centerOnNode(node);
    } else if (canvas.ds && canvas.canvas) {
      const w = canvas.canvas.width / (window.devicePixelRatio || 1);
      const h = canvas.canvas.height / (window.devicePixelRatio || 1);
      canvas.ds.offset[0] = -node.pos[0] + w / (2 * canvas.ds.scale) - (node.size?.[0] || 160) * 0.5;
      canvas.ds.offset[1] = -node.pos[1] + h / (2 * canvas.ds.scale) - (node.size?.[1] || 80) * 0.5;
    }
    canvas.setDirty(true, true);
    showToast(`Focused #${node.id} · ${node.title || node.type}`);
  } catch (e) {}
}

async function runFreeMemory() {
  try {
    const res = await api.fetchApi("/livedev/free_memory", { method: "POST" });
    const d = await res.json();
    if (!d.ok) {
      showToast("[LiveDev] " + (d.error || "cleanup failed"));
      return;
    }
    const ram = Math.max(0, (d.before?.ram_mb || 0) - (d.after?.ram_mb || 0));
    const vram = Math.max(0, (d.before?.vram_mb || 0) - (d.after?.vram_mb || 0));
    if (!d.unloaded && !ram && !vram) {
      showToast("[LiveDev] Nothing to free — no models are loaded");
      return;
    }
    const models = d.unloaded ? `, ${d.unloaded} model${d.unloaded === 1 ? "" : "s"} unloaded` : "";
    showToast(`[LiveDev] Freed ${ram} MB RAM, ${vram} MB VRAM${models}`);
  } catch (e) {
    showToast("[LiveDev] Memory cleanup failed");
  }
}

function buildCommands() {
  const actions = [
    {
      group: "Actions",
      label: "Node Execution Profiler",
      hint: "Timing breakdown & bottleneck heatmap",
      icon: LD_ICONS.chart,
      keywords: "profiler timing bottleneck heatmap slow vram",
      run: () => openProfilerModal(),
    },
    {
      group: "Actions",
      label: "Workflow Pre-Flight Check",
      hint: "Verify missing models, nodes, and inputs",
      icon: LD_ICONS.shield,
      keywords: "preflight readiness check missing model lora vae validate",
      run: () => openPreflightModal(),
    },
    {
      group: "Actions",
      label: "Workflow Snapshots & Diff",
      hint: "Save, compare, and restore local snapshots",
      icon: LD_ICONS.history,
      keywords: "snapshot diff timemachine restore backup history",
      run: () => openSnapshotsModal(),
    },
    {
      group: "Actions",
      label: "Parameter Sweep / X-Y Grid Runner",
      hint: "Sweep 1 or 2 widgets and export a labeled PNG grid",
      icon: LD_ICONS.grid,
      keywords: "xy sweep grid matrix compare parameter cfg sampler lora",
      run: () => openXYSweepModal(),
    },
    {
      group: "Actions",
      label: "Interactive Queue Inspector & Smart ETA",
      hint: "Monitor active job, ETA, cancel pending, or re-run with new seed",
      icon: LD_ICONS.trace,
      keywords: "queue inspector eta pending cancel interrupt rerun seed",
      run: () => openQueueInspectorModal(),
    },
    {
      group: "Actions",
      label: "Save Quick Workflow Snapshot",
      hint: "Capture the current graph immediately",
      icon: LD_ICONS.save,
      keywords: "quick save snapshot checkpoint backup",
      run: () => {
        const entry = captureWorkflowSnapshot("");
        if (entry) showToast(`LiveDev: Saved "${entry.name}"`);
      },
    },
    {
      group: "Actions",
      label: "Console Noise & Log Filter",
      hint: "Mute noisy custom nodes and libraries",
      icon: LD_ICONS.sliders,
      keywords: "console filter silence mute noise logs warnings",
      run: () => openConsoleFilterModal(),
    },
    {
      group: "Actions",
      label: "Live Console",
      hint: "Open real-time server terminal stream",
      icon: LD_ICONS.terminal,
      keywords: "console terminal logs stdout",
      run: () => openConsole(),
    },
    {
      group: "Actions",
      label: "Live Reload Config",
      hint: "Configure watched and excluded custom_nodes",
      icon: LD_ICONS.sliders,
      keywords: "config exclude watch reload modules",
      run: () => {
        if (typeof window.showLiveDevDialog === "function") window.showLiveDevDialog();
        else showToast("LiveDev: Config dialog not ready");
      },
    },
    {
      group: "Actions",
      label: "Dependencies Hub",
      hint: "Inspect Python requirements and conflicts",
      icon: LD_ICONS.box,
      keywords: "deps packages pip requirements install conflict",
      run: () => openDependenciesHub(),
    },
    {
      group: "Actions",
      label: "Error Report",
      hint: "Inspect captured traceback and diagnostics",
      icon: LD_ICONS.bug,
      keywords: "error report bug traceback diagnostics",
      run: () => openReportPanel(lastError()),
    },
    {
      group: "Actions",
      label: "Free Memory (RAM / VRAM)",
      hint: "Unload models and reclaim GPU/system memory",
      icon: LD_ICONS.bolt,
      keywords: "memory vram ram clear free unload gpu",
      run: () => runFreeMemory(),
    },
    {
      group: "Actions",
      label: "Localization Scanner",
      hint: "Scan and translate non-target workflow strings",
      icon: LD_ICONS.globe,
      keywords: "translate localization language chinese arabic english",
      run: () => doLocalizationScan(),
    },
    {
      group: "Actions",
      label: "Smart Auto-Layout",
      hint: "Organize nodes into clean layered columns",
      icon: LD_ICONS.grid,
      keywords: "layout organize arrange tidy graph",
      run: () => doSmartAutoLayout(),
    },
    {
      group: "Actions",
      label: "Zoom To Fit",
      hint: "Frame the entire workflow in the viewport",
      icon: LD_ICONS.search,
      keywords: "zoom fit frame viewport center",
      run: () => doZoomToFit(),
    },
    {
      group: "Actions",
      label: "Rebuild Stale Nodes",
      hint: "Refresh canvas nodes whose schema changed",
      icon: LD_ICONS.refresh,
      keywords: "rebuild stale refresh schema reload",
      run: () => rebuildStaleNodes(),
    },
    {
      group: "Actions",
      label: "Node Search & Jump",
      hint: "Search nodes by title, type, or widget value",
      icon: LD_ICONS.search,
      keywords: "search find node jump",
      run: () => doNodeSearch(),
    },
    {
      group: "Actions",
      label: "Canvas Bookmarks",
      hint: "Jump to saved viewport locations",
      icon: LD_ICONS.bookmark,
      keywords: "bookmarks camera view",
      run: () => doShowBookmarks(),
    },
    {
      group: "Actions",
      label: "Clean Orphaned Nodes",
      hint: "Review and remove disconnected unused nodes",
      icon: LD_ICONS.trash,
      keywords: "clean unused orphan delete nodes",
      run: () => doCleanUnused(),
    },
    {
      group: "Actions",
      label: "Fix Duplicate Node IDs",
      hint: "Repair colliding node identifiers in graph",
      icon: LD_ICONS.hash,
      keywords: "fix duplicate ids repair",
      run: () => doFixNodeIds(),
    },
    {
      group: "Actions",
      label: "Workflow Gallery",
      hint: "Browse all ComfyUI & custom_nodes workflows with thumbnails and multiple views",
      icon: LD_ICONS.gallery,
      keywords: "workflow gallery browse templates custom nodes subfolders thumbnails grid list",
      run: () => openWorkflowGalleryModal(),
    },
    {
      group: "Actions",
      label: "Toggle Align Snap & Alignment Guides",
      hint: isAlignSnapEnabled()
        ? "Currently ON — hold Shift to bypass during drag"
        : "Currently OFF — enable magnetic snap & live guides",
      icon: LD_ICONS.snapGuides,
      keywords: "snap align guides magnetic drag shift ruler spacing",
      run: () => toggleAlignSnapEnabled({ toast: true }),
    },
    {
      group: "Actions",
      label: "Visual Fold / Unfold Selection",
      hint: "Collapse selected nodes or group into a compact pill without a Subgraph",
      icon: LD_ICONS.fold,
      keywords: "fold unfold collapse visual group compact pill",
      run: () => doFoldToggle(),
    },
    {
      group: "Actions",
      label: "Unfold All Visual Fold Groups",
      hint: "Restore every visually folded group in this workflow",
      icon: LD_ICONS.fold,
      keywords: "unfold all restore visual fold groups",
      run: () => doUnfoldAll(),
    },
    {
      group: "Actions",
      label: "Toggle Hide Links (Selected Nodes)",
      hint: "Hide or restore connection wires on selected nodes (saved in workflow)",
      icon: LD_ICONS.link,
      keywords: "hide show links wires selected nodes wireless",
      run: () => {
        const canvas = app.canvas;
        const selected = canvas?.selectedItems instanceof Set
          ? Array.from(canvas.selectedItems).filter((n) => n && n.pos)
          : Object.values(canvas?.selected_nodes || {});
        if (!selected.length) {
          showToast("LiveDev: Select one or more nodes first");
          return;
        }
        const nowHidden = toggleNodesLinksHidden(selected);
        showToast(
          nowHidden
            ? `LiveDev: Hid links on ${selected.length} node${selected.length === 1 ? "" : "s"}`
            : `LiveDev: Restored links on ${selected.length} node${selected.length === 1 ? "" : "s"}`,
        );
      },
    },
    {
      group: "Actions",
      label: "Show All Hidden Links",
      hint: "Unhide every selectively hidden wire across the workflow",
      icon: LD_ICONS.link,
      keywords: "show unhide restore all hidden links wires",
      run: () => {
        const count = showAllHiddenLinks();
        showToast(
          count
            ? `LiveDev: Restored hidden links on ${count} node${count === 1 ? "" : "s"}`
            : "LiveDev: No hidden links in this workflow",
        );
      },
    },
    {
      group: "Actions",
      label: "Reset Alignment Toolbar Position",
      hint: "Re-center the floating LiveDev alignment dock",
      icon: LD_ICONS.undo,
      keywords: "reset toolbar dock position center",
      run: () => {
        resetToolbarPosition();
        showToast("LiveDev: Alignment toolbar position reset");
      },
    },
  ];

  const wireModes = (WIRE_MODES || []).map((mode) => ({
    group: "Wire Routing",
    label: `Wire Route: ${mode}`,
    hint: "Switch canvas link routing geometry",
    icon: LD_ICONS.link,
    keywords: `wire route routing mode ${mode}`,
    run: () => {
      try { localStorage.setItem("livedev_wireMode", JSON.stringify(mode)); } catch (e) {}
      try { app.ui?.settings?.setSettingValue?.("LiveDev.wireMode", mode); } catch (e) {}
      applyWireSettings({ wireMode: mode });
      showToast(`Wire Routing: ${mode}`);
    },
  }));

  const wireStyles = (WIRE_VISUAL_STYLES || []).map((style) => ({
    group: "Wire Visual Effects",
    label: `Wire Effect: ${style}`,
    hint: "Switch visual wire rendering style",
    icon: LD_ICONS.palette,
    keywords: `wire effect visual style neon glow ${style}`,
    run: () => {
      try { localStorage.setItem("livedev_wireVisualStyle", JSON.stringify(style)); } catch (e) {}
      try { app.ui?.settings?.setSettingValue?.("LiveDev.wireVisualStyle", style); } catch (e) {}
      applyWireSettings({ wireVisualStyle: style });
      showToast(`Wire Effect: ${style}`);
    },
  }));

  const graph = app.canvas?.graph || app.graph;
  const canvasNodes = (graph?._nodes || []).map((node) => {
    const title = String(node.title || node.type || `Node #${node.id}`);
    const type = String(node.type || "Unknown");
    return {
      group: "Canvas Nodes",
      label: `#${node.id} · ${title}`,
      hint: type,
      icon: LD_ICONS.cube,
      keywords: `node jump ${node.id} ${title} ${type}`,
      run: () => focusCanvasNode(node),
    };
  });

  return [...actions, ...wireModes, ...wireStyles, ...canvasNodes];
}

function injectPaletteStyles() {
  if (document.getElementById("livedev-palette-css")) return;
  const st = document.createElement("style");
  st.id = "livedev-palette-css";
  st.textContent = `
.ld-cmd-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 11px;
  border-radius: 9px;
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  margin-bottom: 3px;
  transition: background 0.1s ease, border-color 0.1s ease;
}
.ld-cmd-item.is-selected {
  background: rgba(56, 192, 196, 0.16);
  border-color: rgba(56, 192, 196, 0.45);
}
.ld-cmd-ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.05);
  color: ${ACCENT};
  flex-shrink: 0;
}
.ld-cmd-grp {
  font-family: ${FONT_MONO};
  font-size: 10px;
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.05);
  color: #9aa3b0;
  border: 1px solid rgba(255, 255, 255, 0.08);
  white-space: nowrap;
  flex-shrink: 0;
}
.ld-cmd-kbd {
  font-family: ${FONT_MONO};
  font-size: 10.5px;
  padding: 2px 6px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #aeb7c2;
}
`;
  document.head.appendChild(st);
}

export function openCommandPalette() {
  if (activePaletteClose) {
    activePaletteClose();
    return;
  }
  ensureTheme();
  injectPaletteStyles();

  const allCommands = buildCommands();
  let filtered = allCommands.slice(0, 60);
  let selectedIdx = 0;

  const { body, footer, close } = createGlassModal({
    title: "LiveDev Command Palette",
    subtitle: "Search actions, wire styles, visual effects, or jump to any node on the canvas.",
    icon: LD_ICONS.search,
    width: "620px",
    maxHeight: "78vh",
    draggable: true,
    onClose: () => {
      activePaletteClose = null;
    },
  });
  activePaletteClose = close;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "ld-input";
  input.placeholder = "Type a command, wire style, or node name...";
  input.style.cssText = "width:100%;padding:10px 13px;font-size:13.5px;margin-bottom:10px;flex-shrink:0;";

  const listWrap = document.createElement("div");
  listWrap.style.cssText = "flex:1;min-height:240px;max-height:46vh;overflow-y:auto;padding-right:2px;";

  body.append(input, listWrap);

  footer.style.display = "flex";
  footer.style.justifyContent = "space-between";
  footer.innerHTML =
    `<div style="display:flex;align-items:center;gap:8px;font-size:11px;color:#8f98a5;">` +
    `<span class="ld-cmd-kbd">↑↓</span><span>Navigate</span>` +
    `<span class="ld-cmd-kbd">Enter</span><span>Run</span>` +
    `<span class="ld-cmd-kbd">Esc</span><span>Close</span>` +
    `</div>` +
    `<div style="font-family:${FONT_MONO};font-size:11px;color:#8f98a5;">Ctrl+K / Ctrl+Shift+P</div>`;

  function runSelected() {
    const item = filtered[selectedIdx];
    if (!item) return;
    close();
    try {
      item.run();
    } catch (e) {
      showToast(`LiveDev: ${e.message}`);
    }
  }

  function renderList() {
    listWrap.innerHTML = "";
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding:24px;text-align:center;color:#8f98a5;";
      empty.textContent = "No matching commands or canvas nodes.";
      listWrap.appendChild(empty);
      return;
    }
    selectedIdx = Math.max(0, Math.min(selectedIdx, filtered.length - 1));

    filtered.forEach((cmd, idx) => {
      const row = document.createElement("div");
      row.className = "ld-cmd-item" + (idx === selectedIdx ? " is-selected" : "");
      row.innerHTML =
        `<div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1;">` +
        `<span class="ld-cmd-ico">${cmd.icon}</span>` +
        `<div style="min-width:0;flex:1;">` +
        `<div style="font-weight:600;color:#eef3f7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(cmd.label)}</div>` +
        `<div style="font-size:11px;color:#8f98a5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(cmd.hint)}</div>` +
        `</div>` +
        `</div>` +
        `<span class="ld-cmd-grp">${esc(cmd.group)}</span>`;

      row.onmouseenter = () => {
        if (selectedIdx === idx) return;
        const prev = listWrap.children[selectedIdx];
        if (prev) prev.classList.remove("is-selected");
        selectedIdx = idx;
        row.classList.add("is-selected");
      };
      row.onclick = () => {
        selectedIdx = idx;
        runSelected();
      };
      listWrap.appendChild(row);
    });
  }

  function applyFilter() {
    const q = input.value.trim().toLowerCase();
    if (!q) {
      filtered = allCommands.slice(0, 60);
    } else {
      const tokens = q.split(/\s+/).filter(Boolean);
      filtered = allCommands
        .filter((cmd) => {
          const hay = `${cmd.label} ${cmd.hint} ${cmd.group} ${cmd.keywords}`.toLowerCase();
          return tokens.every((t) => hay.includes(t));
        })
        .slice(0, 80);
    }
    selectedIdx = 0;
    renderList();
  }

  input.addEventListener("input", applyFilter);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!filtered.length) return;
      selectedIdx = (selectedIdx + 1) % filtered.length;
      renderList();
      listWrap.children[selectedIdx]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!filtered.length) return;
      selectedIdx = (selectedIdx - 1 + filtered.length) % filtered.length;
      renderList();
      listWrap.children[selectedIdx]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      runSelected();
    }
  });

  renderList();
  setTimeout(() => input.focus(), 20);
}

function isEditableTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || Boolean(el.isContentEditable);
}

app.registerExtension({
  name: "LiveDev.CommandPalette",
  async setup() {
    window.addEventListener(
      "keydown",
      (e) => {
        const key = String(e.key || "").toLowerCase();
        const mod = e.ctrlKey || e.metaKey;
        if (!mod) return;
        const isCtrlShiftP = e.shiftKey && !e.altKey && key === "p";
        const isCtrlK = !e.shiftKey && !e.altKey && key === "k" && !isEditableTarget(e.target);
        if (isCtrlShiftP || isCtrlK) {
          e.preventDefault();
          e.stopPropagation();
          openCommandPalette();
        }
      },
      true,
    );
  },
});
