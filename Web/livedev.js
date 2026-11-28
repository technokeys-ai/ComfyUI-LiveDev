import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import { $el } from "../../scripts/ui.js";
import { esc, setStaleNodes, showToast, staleNodes } from "./utils.js";
import { ACCENT, ACCENT_DIM, DANGER, DANGER_DIM, FONT_MONO, FONT_UI, LD_ICONS } from "./livedev-theme.js";
import "./clever-popup.js";
import { setToolbarAutoShow, setToolbarTheme, setToolbarExpanded } from "./align-toolbar.js";
import { setAlignSnapEnabled, setAlignSnapDistance } from "./align-snap-guides.js";
import { openWorkflowGalleryModal } from "./workflow-gallery.js";
import "./batch-connect.js";
import "./bookmarks-search.js";
import "./cleanup.js";
import "./localization.js";
import "./livedev-toolkit.js";
import "./livedev-deps-popup.js";
import {
  WIRE_MODES,
  WIRE_VISUAL_STYLES,
  WIRE_REVEAL_MODES,
  WIRE_SLOT_SHAPES,
  WIRE_SLOT_COLORS,
  WIRE_ANIM_FPS_MODES,
  applyWireSettings,
} from "./livedev-wires.js";
import { openConsoleFilterModal } from "./console-filter.js";
import { openProfilerModal, setProfilerBadges } from "./node-profiler.js";
import { openPreflightModal } from "./preflight-check.js";
import { openSnapshotsModal } from "./workflow-snapshots.js";
import { applyVramGuardSettings } from "./vram-guard.js";
import { openCommandPalette } from "./command-palette.js";
import "./error-autofix.js";
import { openXYSweepModal } from "./xy-sweep.js";
import { openQueueInspectorModal } from "./queue-inspector.js";

function lsGet(key, fallback) {
  try {
    const value = localStorage.getItem("livedev_" + key);
    return value != null ? JSON.parse(value) : fallback;
  } catch (e) {
    return fallback;
  }
}

async function fetchJsonWithTimeout(path, timeoutMs = 3000) {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await api.fetchApi(path, ctrl ? { signal: ctrl.signal } : undefined);
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function getServerSettings() {
  try {
    const data = await fetchJsonWithTimeout("/livedev/get_settings", 3000);
    return data.settings || {};
  } catch (e) {
    return {};
  }
}

async function getDrives() {
  try {
    const data = await fetchJsonWithTimeout("/livedev/drives", 2500);
    if (Array.isArray(data)) return data.map((d) => d.path).filter(Boolean);
  } catch (e) {
    // The list is a convenience; without it the field falls back to Automatic.
  }
  return [];
}

async function saveServerSetting(patch) {
  try {
    await api.fetchApi("/livedev/update_settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  } catch (e) {
    console.warn("[LiveDev] settings not saved:", e);
  }
}

/**
 * Record the nodes whose widget set no longer matches the class they were built from.
 *
 * Nothing is rebuilt here on purpose. Replacing a node takes its id and its selection with it, and a
 * file save is not the moment to make that decision for whoever is working: the nodes are recorded,
 * the LiveDev button carries a marker, and the menu offers the rebuild.
 */
function markStale(type) {
  if (!lsGet("markStale", true)) return;
  const stale = staleNodes();
  for (const node of app.graph.findNodesByType(type)) {
    if (!stale.includes(node)) stale.push(node);
  }
  setStaleNodes(stale);
}

/**
 * One line at the end of a reload, so a save never passes in silence.
 *
 * Two different things have to be told apart and only a message can: a reload that left the canvas
 * behind, and a reload that did not need to touch it. Reporting only the first made "nothing to do"
 * and "the feature did nothing" look identical, which is the same as not having the feature.
 */
function reportReload(module, removed) {
  const count = staleNodes().length;
  const parts = [];
  if (count) parts.push(`${count} node${count === 1 ? " needs" : "s need"} rebuilding`);
  if (removed) parts.push(`${removed} node type${removed === 1 ? "" : "s"} removed`);
  if (!parts.length) parts.push("the canvas is up to date");
  showToast(`LiveDev: ${module} reloaded - ${parts.join(", ")}${count ? " (LiveDev menu)" : ""}`);
}

app.registerExtension({
  name: "LiveDev.Reload",
  async setup() {
    api.removeEventListener("livedev_update", this._handleLiveDev);
    api.addEventListener("livedev_update", async (event) => {
      const message = event.detail;
      const changes = message.changes;
      const nodesToUpdate = [...changes.added, ...changes.updated];
      if (nodesToUpdate.length > 0) {
        try {
          const savedStates = new Map();
          for (const nodeClass of nodesToUpdate) {
            const existingNodes = app.graph.findNodesByType(nodeClass);
            existingNodes.forEach((node) => {
              try {
                const widgetStates = {};
                if (node.widgets) {
                  for (const w of node.widgets) {
                    try {
                      if (w && w.name) {
                        if (w.value === undefined || w.value === null) {
                          widgetStates[w.name] = w.value;
                          continue;
                        }

                        widgetStates[w.name] = w.serializeValue
                          ? typeof w.serializeValue === "function"
                            ? (function () {
                                try {
                                  return w.serializeValue();
                                } catch {
                                  return w.value;
                                }
                              })()
                            : w.value
                          : w.value;
                      }
                    } catch (widgetError) {
                      console.warn(
                        `[LiveDev] Failed to serialize widget ${w?.name}, using original value:`,
                        widgetError,
                      );
                      widgetStates[w.name] = w.value;
                    }
                  }
                }

                savedStates.set(node.id, {
                  id: node.id,
                  pos: [...node.pos],
                  size: [...node.size],
                  widgets: widgetStates,
                  properties: { ...node.properties },
                });
              } catch (nodeError) {
                console.error(
                  `[LiveDev] Failed to save node state:`,
                  nodeError,
                );
              }
            });
          }

          // Update node definitions from server
          for (const nodeClass of nodesToUpdate) {
            try {
              const response = await api.fetchApi(`/object_info/${nodeClass}`);

              if (!response.ok) {
                console.error(
                  `[LiveDev] Failed to get node data: ${nodeClass}, status: ${response.status}`,
                );
                const text = await response.text();
                console.error(`[LiveDev] Error details:`, text);
                continue;
              }

              const nodeData = await response.json();

              if (nodeData && nodeData[nodeClass]) {
                // The input names the class produced before this reload and the ones it produces now.
                // Both sides come from the same registration pipeline, so the inputs the frontend
                // adds itself (`LoadImage` gains `upload`, the 3D nodes gain their previews) cancel
                // out instead of reading as a change on every reload. Comparing the raw definition
                // against the registered one cannot do that.
                const before = Object.keys(
                  LiteGraph.registered_node_types[nodeClass]?.nodeData?.inputs ?? {},
                ).join("\u0000");

                // `registerNodeDef` is async - it awaits the node-registration extensions before it
                // replaces the registered type - so a call without `await` lets everything below run
                // against the old class.
                await app.registerNodeDef(nodeClass, nodeData[nodeClass]);

                const after = Object.keys(
                  LiteGraph.registered_node_types[nodeClass]?.nodeData?.inputs ?? {},
                ).join("\u0000");
                if (before !== after) markStale(nodeClass);

                const existingNodes = app.graph.findNodesByType(nodeClass);
                existingNodes.forEach((node) => {
                  if (node.widgets) {
                    node.widgets.forEach((widget) => {
                      // Optional chaining throughout: a widget that was renamed or removed is not in
                      // the new definition, and reading straight through `required[widget.name][0]`
                      // threw, which aborted this loop and with it the combo refresh.
                      if (widget.type === "combo") {
                        const values = nodeData[nodeClass]?.input?.required?.[widget.name]?.[0];
                        if (Array.isArray(values)) widget.options.values = values;
                      }
                    });
                  }
                  node.refreshComboInNode?.(nodeData);
                });
              } else {
                console.error(`[LiveDev] Node data format error:`, nodeData);
              }
            } catch (error) {
              console.error(
                `[LiveDev] Error processing node update: ${nodeClass}`,
                error,
              );
            }
          }

          // Restore node state without reconnecting links
          for (const state of savedStates.values()) {
            const node = app.graph.getNodeById(state.id);
            if (node) {
              node.pos = state.pos;
              node.size = state.size;
              Object.assign(node.properties, state.properties);
              if (node.widgets) {
                for (const w of node.widgets) {
                  if (state.widgets[w.name] !== undefined) {
                    try {
                      if (w.loadValue) {
                        await w.loadValue(state.widgets[w.name]);
                      } else {
                        const value = state.widgets[w.name];
                        if (value instanceof Promise) {
                          w.value = await value;
                        } else {
                          w.value = value;
                        }
                      }
                    } catch (error) {
                      console.warn(
                        `[LiveDev] Failed to restore widget ${w.name}:`,
                        error,
                      );
                    }
                  }
                }
              }
            }
          }
          // A type the reload removed. The registry entry is dropped so a new node of it cannot be
          // created from the menu; the ones already on the canvas are left alone - a canvas node holds
          // its own class, so they keep working, and removing them is not the reload's decision.
          const removedTypes = changes.removed || [];
          for (const nodeClass of removedTypes) {
            delete LiteGraph.registered_node_types[nodeClass];
          }

          app.graph.setDirtyCanvas(true);
          reportReload(message.module, removedTypes.length);
        } catch (error) {
          console.error("[LiveDev] Failed to update nodes:", error);
          console.error("[LiveDev] Error details:", error.stack);
        }
      }
    });
  },
});

app.registerExtension({
  name: "LiveDev.Config",
  async setup() {
    await app.ui.settings.setup;

    app.ui.settings.addSetting({
      id: "LiveDev.environment",
      category: ["\u{1F503} LiveDev", "Live Reload & Watcher", "00_environment"],
      name: "Environment",
      tooltip: "Live summary of the active LiveDev watcher configuration and ignored modules.",
      type: () => {
        // Read once, when the settings are built. The environment values cannot change while the
        // server runs; the watch line is a snapshot of a switch that can, and it is read here so
        // the panel does not say "watching" when watching starts paused.
        const box = document.createElement("div");
        box.style.cssText =
          "font:11px Consolas,monospace;color:#aaa;white-space:pre-line;line-height:1.5;" +
          "padding:8px 10px;border-radius:8px;background:rgba(255,255,255,0.04);" +
          "border:1px solid rgba(255,255,255,0.08);max-width:420px;";
        box.textContent = "Reading...";
        fetchJsonWithTimeout("/livedev/health", 3000).then((d) => {
          const e = d.environment || {};
          const list = (items, whenEmpty) => (items && items.length ? items.join(", ") : whenEmpty);
          // The module count is what would be watched, not proof that it is: watching starts paused.
          const watch = d.watchPaused ? "paused (starts paused)" : "on";
          box.textContent =
            `watch ${watch}, ${d.watchedModules} modules, debounce ${e.debounceSeconds}s\n` +
            `extensions ${list(e.extensions, "(default)")}\n` +
            `excluded ${list(e.excluded, "(none)")}\n` +
            `observe only ${list(e.observeOnly, "(all)")}\n` +
            `ignore patterns ${list(e.ignorePatterns, "(none)")}\n` +
            `reload dependents ${e.reloadDependents ? "yes" : "no"}\n` +
            `history ${e.historySize}, console ${e.consoleSize}, conflicts ${e.conflictTtl}s\n` +
            `REPL ${e.replEnabled ? "enabled" : "disabled until LIVEDEV_ENABLE_REPL=1"}\n` +
            `terminal watchers ${e.terminalWatchers}`;
        }).catch(() => { box.textContent = "The server did not answer"; });
        return box;
      },
    });

    async function getExcludedModules() {
      try {
        const response = await api.fetchApi("/livedev/get_exclude_modules");
        const data = await response.json();
        return data.exclude_modules || [];
      } catch (error) {
        console.error("[LiveDev] Failed to get exclusion list:", error);
        return [];
      }
    }

    function injectConfigDialogTheme() {
      const existing = document.getElementById("livedev-config-dialog-theme");
      const st = existing || document.createElement("style");
      st.id = "livedev-config-dialog-theme";
      st.textContent = `
#livedev-dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.72);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  z-index: 2147483000;
  pointer-events: auto !important;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  font-family: ${FONT_UI};
}
.livedev-dialog {
  position: relative;
  pointer-events: auto !important;
  width: 680px;
  max-width: 96vw;
  max-height: 84vh;
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  background: rgba(16, 18, 22, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.10);
  box-shadow: 0 20px 56px rgba(0, 0, 0, 0.72), 0 2px 12px rgba(0, 0, 0, 0.40), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(18px) saturate(145%);
  -webkit-backdrop-filter: blur(18px) saturate(145%);
  color: #d8dee6;
  overflow: hidden;
  box-sizing: border-box;
}
.livedev-dialog::before {
  content: "";
  position: absolute;
  top: -1px;
  left: 16%;
  right: 16%;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(56, 192, 196, 0.65), transparent);
  pointer-events: none;
}
.livedev-dialog .ld-cfg-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.025);
  flex-shrink: 0;
}
.livedev-dialog .ld-cfg-title {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: #fff;
}
.livedev-dialog .ld-cfg-title-ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: rgba(56, 192, 196, 0.14);
  border: 1px solid rgba(56, 192, 196, 0.35);
  color: ${ACCENT};
  flex-shrink: 0;
}
.livedev-dialog .ld-cfg-sub {
  margin: 3px 0 0 37px;
  font-size: 11.5px;
  color: #8f98a5;
}
.livedev-dialog .ld-cfg-x {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  border: 1px solid transparent;
  background: transparent;
  color: #9aa3b0;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
}
.livedev-dialog .ld-cfg-x:hover {
  background: rgba(255, 255, 255, 0.07);
  border-color: rgba(255, 255, 255, 0.12);
  color: #fff;
}
.livedev-dialog .ld-cfg-bar {
  padding: 12px 18px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  background: rgba(0, 0, 0, 0.22);
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex-shrink: 0;
}
.livedev-dialog .ld-cfg-search-wrap {
  position: relative;
  display: flex;
  align-items: center;
}
.livedev-dialog .ld-cfg-search-ico {
  position: absolute;
  left: 11px;
  color: #7f8794;
  pointer-events: none;
  display: inline-flex;
}
.livedev-dialog .ld-cfg-input {
  width: 100%;
  padding: 8px 12px 8px 34px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.10);
  background: rgba(255, 255, 255, 0.04);
  color: #e6ecf2;
  font-family: ${FONT_UI};
  font-size: 12.5px;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.14s ease, box-shadow 0.14s ease, background 0.14s ease;
}
.livedev-dialog .ld-cfg-input:focus {
  border-color: ${ACCENT};
  background: rgba(56, 192, 196, 0.06);
  box-shadow: 0 0 0 2px rgba(56, 192, 196, 0.18);
}
.livedev-dialog .ld-cfg-tabs {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.livedev-dialog .ld-cfg-pills {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.07);
}
.livedev-dialog .ld-cfg-pill {
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: #9aa3b0;
  font-family: ${FONT_UI};
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
}
.livedev-dialog .ld-cfg-pill:hover {
  color: #fff;
  background: rgba(255, 255, 255, 0.05);
}
.livedev-dialog .ld-cfg-pill.is-active {
  color: ${ACCENT};
  background: rgba(56, 192, 196, 0.14);
  border-color: rgba(56, 192, 196, 0.36);
}
.livedev-dialog .ld-cfg-pill.is-active-danger {
  color: ${DANGER};
  background: rgba(229, 115, 115, 0.14);
  border-color: rgba(229, 115, 115, 0.38);
}
.livedev-dialog .ld-cfg-list {
  flex: 1;
  min-height: 220px;
  overflow-y: auto;
  padding: 10px 18px;
  display: block;
}
.livedev-dialog .ld-cfg-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 11px;
  margin-bottom: 6px;
  border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(255, 255, 255, 0.03);
  transition: background 0.14s ease, border-color 0.14s ease;
}
.livedev-dialog .ld-cfg-row:hover {
  background: rgba(255, 255, 255, 0.055);
  border-color: rgba(255, 255, 255, 0.12);
}
.livedev-dialog .ld-cfg-row.is-excluded {
  border-color: rgba(229, 115, 115, 0.28);
  background: rgba(229, 115, 115, 0.05);
}
.livedev-dialog .ld-cfg-mod {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.livedev-dialog .ld-cfg-mod-ico {
  color: #8f98a5;
  display: inline-flex;
  flex-shrink: 0;
}
.livedev-dialog .ld-cfg-row.is-excluded .ld-cfg-mod-ico {
  color: ${DANGER};
}
.livedev-dialog .ld-cfg-mod-name {
  font-family: ${FONT_MONO};
  font-size: 12.5px;
  font-weight: 600;
  color: #e6ecf2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.livedev-dialog .ld-cfg-mark {
  background: rgba(56, 192, 196, 0.26);
  color: #fff;
  border-radius: 3px;
  padding: 0 2px;
}
.livedev-dialog .ld-cfg-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.livedev-dialog .ld-cfg-status {
  font-size: 10.5px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  letter-spacing: 0.02em;
}
.livedev-dialog .ld-cfg-status.is-watch {
  color: ${ACCENT};
  background: rgba(56, 192, 196, 0.12);
  border: 1px solid rgba(56, 192, 196, 0.30);
}
.livedev-dialog .ld-cfg-status.is-excl {
  color: ${DANGER};
  background: rgba(229, 115, 115, 0.14);
  border: 1px solid rgba(229, 115, 115, 0.35);
}
.livedev-dialog .ld-cfg-toggle {
  padding: 4px 10px;
  border-radius: 7px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.04);
  color: #d8dee6;
  font-family: ${FONT_UI};
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease;
}
.livedev-dialog .ld-cfg-toggle:hover {
  border-color: ${DANGER};
  background: rgba(229, 115, 115, 0.14);
  color: ${DANGER};
}
.livedev-dialog .ld-cfg-row.is-excluded .ld-cfg-toggle:hover {
  border-color: ${ACCENT};
  background: rgba(56, 192, 196, 0.16);
  color: ${ACCENT};
}
.livedev-dialog .ld-cfg-manual {
  padding: 10px 18px;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
  background: rgba(0, 0, 0, 0.18);
  display: flex;
  gap: 8px;
  align-items: center;
  flex-shrink: 0;
}
.livedev-dialog .ld-cfg-manual .ld-cfg-input {
  padding-left: 12px;
}
.livedev-dialog .ld-cfg-foot {
  padding: 12px 18px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.025);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  flex-shrink: 0;
}
.livedev-dialog .ld-cfg-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 13px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.05);
  color: #d8dee6;
  font-family: ${FONT_UI};
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease, transform 0.12s ease;
}
.livedev-dialog .ld-cfg-btn:hover {
  background: rgba(56, 192, 196, 0.14);
  border-color: rgba(56, 192, 196, 0.45);
  color: #fff;
}
.livedev-dialog .ld-cfg-btn:active {
  transform: scale(0.96);
}
.livedev-dialog .ld-cfg-btn.is-primary {
  background: ${ACCENT_DIM};
  border-color: ${ACCENT};
  color: #fff;
}
.livedev-dialog .ld-cfg-btn.is-primary:hover {
  background: rgba(56, 192, 196, 0.28);
}
.livedev-dialog .ld-cfg-btn.is-danger:hover {
  background: rgba(229, 115, 115, 0.16);
  border-color: ${DANGER};
  color: ${DANGER};
}
`;
      if (!existing) document.head.appendChild(st);
    }

    async function showLiveDevDialog() {
      // Remove any existing dialog cleanly before opening
      const prevOverlay = document.getElementById("livedev-dialog-overlay");
      if (prevOverlay) prevOverlay.remove();

      injectConfigDialogTheme();

      const cfgSvg = (inner) =>
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        inner +
        "</svg>";
      const ICO = {
        sliders: cfgSvg('<line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="16" cy="12" r="2"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="11" cy="18" r="2"/>'),
        search: cfgSvg('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
        folder: cfgSvg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
        eyeOff: cfgSvg('<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>'),
        check: cfgSvg('<polyline points="20 6 9 17 4 12"/>'),
        plus: cfgSvg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
      };

      const excludedList = await getExcludedModules();
      const excludedSet = new Set(excludedList);

      let allAvailableModules = [];
      try {
        const response = await api.fetchApi("/livedev/get_all_modules");
        const data = await response.json();
        allAvailableModules = Array.isArray(data.modules) ? data.modules : [];
      } catch (error) {
        console.error("[LiveDev] Failed to get all modules:", error);
      }

      function getCombinedModules() {
        const merged = new Set([...allAvailableModules, ...excludedSet]);
        return Array.from(merged).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      }

      async function saveExclusions() {
        const payload = Array.from(excludedSet).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        await api.fetchApi("/livedev/update_exclude_modules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ exclude_modules: payload }),
        });
      }

      let activeTab = "all"; // 'all' | 'watched' | 'excluded'
      let query = "";

      const overlay = document.createElement("div");
      overlay.id = "livedev-dialog-overlay";
      overlay.setAttribute("data-dismissable-layer", "");
      // Isolate pointer & focus events from ComfyUI Settings' Reka-UI modal (which sets
      // body pointer-events:none and listens on document for focusin/pointerdown to trap focus).
      for (const evtName of ["pointerdown", "mousedown", "focusin", "focusout"]) {
        overlay.addEventListener(evtName, (e) => e.stopPropagation());
      }

      const dialog = document.createElement("div");
      dialog.className = "livedev-dialog";
      dialog.onclick = (e) => e.stopPropagation();

      const closeDialog = () => {
        document.removeEventListener("keydown", onEsc, true);
        overlay.remove();
      };
      const onEsc = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closeDialog();
        }
      };
      document.addEventListener("keydown", onEsc, true);
      overlay.onclick = (e) => {
        e.stopPropagation();
        if (e.target === overlay) closeDialog();
      };

      // Header
      const head = document.createElement("div");
      head.className = "ld-cfg-head";

      const headLeft = document.createElement("div");
      const title = document.createElement("h2");
      title.className = "ld-cfg-title";
      title.innerHTML = `<span class="ld-cfg-title-ico">${ICO.sliders}</span><span>Live Reload Module Config</span>`;
      const subtitle = document.createElement("div");
      subtitle.className = "ld-cfg-sub";
      subtitle.textContent = "Toggle which custom_nodes packs are watched for live reload or excluded from Reload All.";
      headLeft.appendChild(title);
      headLeft.appendChild(subtitle);

      const xBtn = document.createElement("button");
      xBtn.type = "button";
      xBtn.className = "ld-cfg-x";
      xBtn.textContent = "\u2715";
      xBtn.title = "Close (Esc)";
      xBtn.onclick = closeDialog;

      head.appendChild(headLeft);
      head.appendChild(xBtn);
      dialog.appendChild(head);

      // Search & Filter Bar
      const bar = document.createElement("div");
      bar.className = "ld-cfg-bar";

      const searchWrap = document.createElement("div");
      searchWrap.className = "ld-cfg-search-wrap";
      const searchIco = document.createElement("span");
      searchIco.className = "ld-cfg-search-ico";
      searchIco.innerHTML = ICO.search;
      const searchInput = document.createElement("input");
      searchInput.type = "text";
      searchInput.className = "ld-cfg-input";
      searchInput.placeholder = "Filter custom_nodes modules by name...";
      searchWrap.appendChild(searchIco);
      searchWrap.appendChild(searchInput);

      const tabsRow = document.createElement("div");
      tabsRow.className = "ld-cfg-tabs";
      const pillsWrap = document.createElement("div");
      pillsWrap.className = "ld-cfg-pills";

      const tabAll = document.createElement("button");
      tabAll.type = "button";
      tabAll.className = "ld-cfg-pill";
      tabAll.onclick = () => { activeTab = "all"; renderModuleList(); };

      const tabWatched = document.createElement("button");
      tabWatched.type = "button";
      tabWatched.className = "ld-cfg-pill";
      tabWatched.onclick = () => { activeTab = "watched"; renderModuleList(); };

      const tabExcluded = document.createElement("button");
      tabExcluded.type = "button";
      tabExcluded.className = "ld-cfg-pill";
      tabExcluded.onclick = () => { activeTab = "excluded"; renderModuleList(); };

      pillsWrap.appendChild(tabAll);
      pillsWrap.appendChild(tabWatched);
      pillsWrap.appendChild(tabExcluded);

      const hint = document.createElement("span");
      hint.style.cssText = "font-size:11px;color:#7f8794;";
      hint.textContent = "Changes save automatically";

      tabsRow.appendChild(pillsWrap);
      tabsRow.appendChild(hint);
      bar.appendChild(searchWrap);
      bar.appendChild(tabsRow);
      dialog.appendChild(bar);

      // Module list
      const listContainer = document.createElement("div");
      listContainer.className = "ld-cfg-list";
      dialog.appendChild(listContainer);

      function buildHighlightedName(name, term) {
        const container = document.createElement("span");
        container.className = "ld-cfg-mod-name";
        if (!term) {
          container.textContent = name;
          return container;
        }
        const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const parts = name.split(new RegExp(`(${escapedTerm})`, "gi"));
        for (const part of parts) {
          if (!part) continue;
          const span = document.createElement("span");
          if (part.toLowerCase() === term.toLowerCase()) {
            span.className = "ld-cfg-mark";
          }
          span.textContent = part;
          container.appendChild(span);
        }
        return container;
      }

      function renderModuleList() {
        const combined = getCombinedModules();
        const excludedCount = combined.filter((m) => excludedSet.has(m)).length;
        const watchedCount = combined.length - excludedCount;

        tabAll.textContent = `All (${combined.length})`;
        tabWatched.textContent = `Watching (${watchedCount})`;
        tabExcluded.textContent = `Excluded (${excludedCount})`;

        tabAll.className = "ld-cfg-pill" + (activeTab === "all" ? " is-active" : "");
        tabWatched.className = "ld-cfg-pill" + (activeTab === "watched" ? " is-active" : "");
        tabExcluded.className = "ld-cfg-pill" + (activeTab === "excluded" ? " is-active-danger" : "");

        const filtered = combined.filter((mod) => {
          if (query && !mod.toLowerCase().includes(query.toLowerCase())) return false;
          if (activeTab === "watched") return !excludedSet.has(mod);
          if (activeTab === "excluded") return excludedSet.has(mod);
          return true;
        });

        listContainer.innerHTML = "";
        if (filtered.length === 0) {
          const empty = document.createElement("div");
          empty.style.cssText = "text-align:center;padding:34px 12px;color:#7f8794;font-size:12.5px;";
          empty.textContent = query
            ? `No modules match "${query}".`
            : activeTab === "excluded"
            ? "No excluded modules — all custom nodes are being watched."
            : "No custom node modules found.";
          listContainer.appendChild(empty);
          return;
        }

        filtered.forEach((mod) => {
          const isExcluded = excludedSet.has(mod);
          const row = document.createElement("div");
          row.className = "ld-cfg-row" + (isExcluded ? " is-excluded" : "");

          const left = document.createElement("div");
          left.className = "ld-cfg-mod";
          const ico = document.createElement("span");
          ico.className = "ld-cfg-mod-ico";
          ico.innerHTML = isExcluded ? ICO.eyeOff : ICO.folder;
          left.appendChild(ico);
          left.appendChild(buildHighlightedName(mod, query));

          const right = document.createElement("div");
          right.className = "ld-cfg-right";

          const status = document.createElement("span");
          status.className = "ld-cfg-status " + (isExcluded ? "is-excl" : "is-watch");
          status.textContent = isExcluded ? "Excluded" : "Watching";

          const toggleBtn = document.createElement("button");
          toggleBtn.type = "button";
          toggleBtn.className = "ld-cfg-toggle";
          toggleBtn.textContent = isExcluded ? "Watch" : "Exclude";
          toggleBtn.onclick = async () => {
            toggleBtn.disabled = true;
            if (excludedSet.has(mod)) excludedSet.delete(mod);
            else excludedSet.add(mod);
            try {
              await saveExclusions();
              renderModuleList();
            } catch (err) {
              showToast(`[LiveDev] Failed to save exclusions: ${err.message}`);
              toggleBtn.disabled = false;
            }
          };

          right.appendChild(status);
          right.appendChild(toggleBtn);
          row.appendChild(left);
          row.appendChild(right);
          listContainer.appendChild(row);
        });
      }

      let searchTimer;
      searchInput.addEventListener("input", (e) => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          query = e.target.value.trim();
          renderModuleList();
        }, 120);
      });

      // Manual quick-add exclusion bar
      const manualBar = document.createElement("div");
      manualBar.className = "ld-cfg-manual";
      const manualInput = document.createElement("input");
      manualInput.type = "text";
      manualInput.className = "ld-cfg-input";
      manualInput.placeholder = "Add a custom module name to exclude manually...";
      const manualAddBtn = document.createElement("button");
      manualAddBtn.type = "button";
      manualAddBtn.className = "ld-cfg-btn";
      manualAddBtn.innerHTML = ICO.plus + "<span>Exclude</span>";

      async function addManualExclusion() {
        const modName = manualInput.value.trim();
        if (!modName) return;
        if (!excludedSet.has(modName)) {
          excludedSet.add(modName);
          await saveExclusions();
          showToast(`[LiveDev] Excluded '${modName}'`);
        }
        manualInput.value = "";
        renderModuleList();
      }

      manualAddBtn.onclick = addManualExclusion;
      manualInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          addManualExclusion();
        }
      });
      manualBar.appendChild(manualInput);
      manualBar.appendChild(manualAddBtn);
      dialog.appendChild(manualBar);

      // Footer bulk controls + Done
      const foot = document.createElement("div");
      foot.className = "ld-cfg-foot";

      const bulkLeft = document.createElement("div");
      bulkLeft.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;";

      const excludeAllBtn = document.createElement("button");
      excludeAllBtn.type = "button";
      excludeAllBtn.className = "ld-cfg-btn is-danger";
      excludeAllBtn.innerHTML = ICO.eyeOff + "<span>Exclude All</span>";
      excludeAllBtn.onclick = async () => {
        const all = getCombinedModules();
        for (const m of all) excludedSet.add(m);
        await saveExclusions();
        renderModuleList();
        showToast(`[LiveDev] Excluded all ${all.length} modules`);
      };

      const watchAllBtn = document.createElement("button");
      watchAllBtn.type = "button";
      watchAllBtn.className = "ld-cfg-btn";
      watchAllBtn.innerHTML = ICO.check + "<span>Watch All</span>";
      watchAllBtn.onclick = async () => {
        excludedSet.clear();
        await saveExclusions();
        renderModuleList();
        showToast("[LiveDev] Cleared exclusions - watching all modules");
      };

      bulkLeft.appendChild(excludeAllBtn);
      bulkLeft.appendChild(watchAllBtn);

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "ld-cfg-btn is-primary";
      closeBtn.textContent = "Done";
      closeBtn.onclick = closeDialog;

      foot.appendChild(bulkLeft);
      foot.appendChild(closeBtn);
      dialog.appendChild(foot);

      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      renderModuleList();
      searchInput.focus();
    }

    // Reachable from the toolbar menu too: the settings row is the primary entry, but a menu entry
    // guarantees the dialog can always be opened even if the row does not render in a given build.
    window.showLiveDevDialog = showLiveDevDialog;

    // LiveDev settings (stored in localStorage or server config.json)
    function lsSet(k, v) { try { localStorage.setItem("livedev_" + k, JSON.stringify(v)); } catch (e) {} }
    await app.ui.settings.setup;

    // Fetch server-backed config and drive list in parallel (both have short timeouts so they
    // never stall ComfyUI boot). Guard onChange handlers during initial registration so ComfyUI's
    // automatic addSetting -> onChange hydration does not fire 10+ simultaneous POST requests or
    // 12 redundant canvas redraws on every page refresh.
    const [serverSettings, drivesList] = await Promise.all([
      getServerSettings(),
      getDrives(),
    ]);
    let settingsHydrated = false;
    const saveServerOnChange = (patch) => {
      if (settingsHydrated) saveServerSetting(patch);
    };
    const syncWire = (patch) => {
      applyWireSettings(patch, { silent: !settingsHydrated });
    };

    const TAB_ROOT = "\u{1F503} LiveDev";
    // ComfyUI's settings tree uses the full category path as the node key: [Tab, Section, UniqueLeafKey].
    // Always provide a unique 3rd segment so sibling settings in the same section never overwrite each other.
    const cat = (section, key) => [TAB_ROOT, section, key];
    const SEC_WIRES = "Wires & Connections";
    const SEC_TOOLBAR = "Toolbar & UI";
    const SEC_STATS = "Stats Bar";
    const SEC_WATCHER = "Live Reload & Watcher";
    const SEC_DIAG = "Diagnostics & Buffers";
    const SEC_LANG = "Language & Voice";

    // ------------------------------------------------------------------------
    // 1. Wires & Connections (Quick Connections + All 12 Wire Routing Modes)
    // ------------------------------------------------------------------------
    app.ui.settings.addSetting({
      id: "LiveDev.wireMode",
      category: cat(SEC_WIRES, "01_wireMode"),
      name: "Wire Routing Style",
      tooltip: "Choose how wires are routed between nodes (Smart Wireless Portal, Circuit Board, Rounded Metro, Smart Spline, Bus Highway, Catenary, Chamfer, Nuke Pipes, Manhattan Grid, Overhead Arc, or On Top).",
      type: "combo",
      options: WIRE_MODES,
      defaultValue: lsGet("wireMode", "Smart Wireless Portal"),
      onChange: (v) => {
        lsSet("wireMode", v);
        syncWire({ wireMode: v });
      },
    });
    app.ui.settings.addSetting({
      id: "LiveDev.wireVisualStyle",
      category: cat(SEC_WIRES, "02_wireVisualStyle"),
      name: "Wire Visual Effect",
      tooltip: "Visual finish layered over any routing style: 24 effects including Neon Glow, Fiber Optic, Laser Beam, Gradient Flow, Flowing Energy, Pulse Beads, Pulsation, Color Flow, Jelly Wave, Neon Plasma, Sparkling Electricity, DNA Helix, Dripping Lava, Water Pipe Flow, Tapered Ribbon, Double Rail, Outlined Cable, 3D Glossy Pipe, Glass Tube, Circuit Trace, Dashed Technical, Blueprint Dotted, and Directional Chevrons.",
      type: "combo",
      options: WIRE_VISUAL_STYLES,
      defaultValue: lsGet("wireVisualStyle", "Flowing Energy (Animated)"),
      onChange: (v) => {
        lsSet("wireVisualStyle", v);
        syncWire({ wireVisualStyle: v });
      },
    });
    app.ui.settings.addSetting({
      id: "LiveDev.wireFocusMode",
      category: cat(SEC_WIRES, "03_wireFocusMode"),
      name: "Focus Mode (Dim Unselected Wires)",
      tooltip: "Dim unrelated wires when hovering or selecting nodes so active connections stand out clearly.",
      type: "boolean",
      defaultValue: lsGet("wireFocusMode", false),
      onChange: (v) => {
        lsSet("wireFocusMode", Boolean(v));
        syncWire({ wireFocusMode: Boolean(v) });
      },
    });
    app.ui.settings.addSetting({
      id: "LiveDev.wireJumpBridges",
      category: cat(SEC_WIRES, "04_wireJumpBridges"),
      name: "Jump-Over Bridges (CAD Crossings)",
      tooltip: "Draw clean CAD jump-over arcs where straight/orthogonal wires cross each other.",
      type: "boolean",
      defaultValue: lsGet("wireJumpBridges", false),
      onChange: (v) => {
        lsSet("wireJumpBridges", Boolean(v));
        syncWire({ wireJumpBridges: Boolean(v) });
      },
    });
    app.ui.settings.addSetting({
      id: "LiveDev.wireLivePulse",
      category: cat(SEC_WIRES, "05_wireLivePulse"),
      name: "Live Execution Data Pulse",
      tooltip: "Animate glowing data packets along the currently executing node's wires while generating.",
      type: "boolean",
      defaultValue: lsGet("wireLivePulse", false),
      onChange: (v) => {
        lsSet("wireLivePulse", Boolean(v));
        syncWire({ wireLivePulse: Boolean(v) });
      },
    });
    app.ui.settings.addSetting({
      id: "LiveDev.qcEnabled",
      category: cat(SEC_WIRES, "06_qcEnabled"),
      name: "Quick Connections Enable",
      tooltip: "Show smart slot suggestions beside the cursor when dragging a link to connect nodes rapidly.",
      type: "boolean",
      defaultValue: lsGet("qcEnabled", true),
      onChange: (v) => {
        lsSet("qcEnabled", Boolean(v));
        syncWire({ qcEnabled: Boolean(v) });
      },
    });
    app.ui.settings.addSetting({
      id: "LiveDev.qcDotOnly",
      category: cat(SEC_WIRES, "07_qcDotOnly"),
      name: "Quick Connections Dot Only",
      tooltip: "Require releasing on the colored dot only; disable to allow releasing anywhere on the suggestion row.",
      type: "boolean",
      defaultValue: lsGet("qcDotOnly", false),
      onChange: (v) => {
        lsSet("qcDotOnly", Boolean(v));
        syncWire({ qcDotOnly: Boolean(v) });
      },
    });
    app.ui.settings.addSetting({
      id: "LiveDev.qcMaxSuggestions",
      category: cat(SEC_WIRES, "08_qcMaxSuggestions"),
      name: "Quick Connections Max Suggestions",
      tooltip: "Maximum number of compatible target slots shown in the quick-connect overlay.",
      type: "number",
      defaultValue: Number(lsGet("qcMaxSuggestions", 15)) || 15,
      attrs: { min: 1, max: 30, step: 1 },
      onChange: (v) => {
        const num = Math.max(1, Math.min(30, Number(v) || 15));
        lsSet("qcMaxSuggestions", num);
        syncWire({ qcMaxSuggestions: num });
      },
    });
    app.ui.settings.addSetting({
      id: "LiveDev.wirePrefer90or45",
      category: cat(SEC_WIRES, "09_wirePrefer90or45"),
      name: "Circuit Board Prefer 90/45 Angles",
      tooltip: "Use 45-degree chamfered turns in Circuit Board mode instead of strict 90-degree bends.",
      type: "boolean",
      defaultValue: lsGet("wirePrefer90or45", true),
      onChange: (v) => {
        lsSet("wirePrefer90or45", Boolean(v));
        syncWire({ wirePrefer90or45: Boolean(v) });
      },
    });
    app.ui.settings.addSetting({
      id: "LiveDev.wireLineSpacing",
      category: cat(SEC_WIRES, "10_wireLineSpacing"),
      name: "Wire Lane Spacing (px)",
      tooltip: "Distance between parallel routed wires in Circuit Board, Metro, Bus, and Manhattan modes.",
      type: "number",
      defaultValue: Number(lsGet("wireLineSpacing", 10)) || 10,
      attrs: { min: 4, max: 32, step: 1 },
      onChange: (v) => {
        const num = Math.max(4, Math.min(32, Number(v) || 10));
        lsSet("wireLineSpacing", num);
        syncWire({ wireLineSpacing: num });
      },
    });
    app.ui.settings.addSetting({
      id: "LiveDev.wireNodePadding",
      category: cat(SEC_WIRES, "11_wireNodePadding"),
      name: "Wire Node Clearance (px)",
      tooltip: "Padding margin kept around node edges when routing obstacle-avoiding wires.",
      type: "number",
      defaultValue: Number(lsGet("wireNodePadding", 14)) || 14,
      attrs: { min: 6, max: 48, step: 2 },
      onChange: (v) => {
        const num = Math.max(6, Math.min(48, Number(v) || 14));
        lsSet("wireNodePadding", num);
        syncWire({ wireNodePadding: num });
      },
    });
    app.ui.settings.addSetting({
      id: "LiveDev.wirePortalDistance",
      category: cat(SEC_WIRES, "12_wirePortalDistance"),
      name: "Wireless Portal Threshold (px)",
      tooltip: "Minimum link length before Smart Wireless Portal collapses a long wire into paired badges.",
      type: "number",
      defaultValue: Number(lsGet("wirePortalDistance", 550)) || 550,
      attrs: { min: 200, max: 2500, step: 50 },
      onChange: (v) => {
        const num = Math.max(200, Math.min(2500, Number(v) || 550));
        lsSet("wirePortalDistance", num);
        syncWire({ wirePortalDistance: num });
      },
    });
    app.ui.settings.addSetting({
      id: "LiveDev.wireRevealMode",
      category: cat(SEC_WIRES, "13_wireRevealMode"),
      name: "Hidden Link Reveal Mode",
      tooltip: "Choose when selectively hidden per-node or per-slot wires reappear (on hover, on click/selection, or always hidden).",
      type: "combo",
      options: WIRE_REVEAL_MODES,
      defaultValue: lsGet("wireRevealMode", "Show On Hover (All Links)"),
      onChange: (v) => {
        lsSet("wireRevealMode", v);
        syncWire({ wireRevealMode: v });
      },
    });
    app.ui.settings.addSetting({
      id: "LiveDev.wireSlotShape",
      category: cat(SEC_WIRES, "14_wireSlotShape"),
      name: "Hidden Slot Indicator Shape",
      tooltip: "HUD badge drawn on input and output sockets whose connections are hidden (WiFi Icon, Dashed Circle, Circle, Triangle, or None).",
      type: "combo",
      options: WIRE_SLOT_SHAPES,
      defaultValue: lsGet("wireSlotShape", "WiFi Icon"),
      onChange: (v) => {
        lsSet("wireSlotShape", v);
        syncWire({ wireSlotShape: v });
      },
    });
    app.ui.settings.addSetting({
      id: "LiveDev.wireSlotColor",
      category: cat(SEC_WIRES, "15_wireSlotColor"),
      name: "Hidden Slot Indicator Color",
      tooltip: "Color scheme used for hidden-link slot indicators (Match Slot Color, LiveDev Accent, Pure White, or Neutral Grey).",
      type: "combo",
      options: WIRE_SLOT_COLORS,
      defaultValue: lsGet("wireSlotColor", "Match Slot Color"),
      onChange: (v) => {
        lsSet("wireSlotColor", v);
        syncWire({ wireSlotColor: v });
      },
    });
    app.ui.settings.addSetting({
      id: "LiveDev.wireAnimFps",
      category: cat(SEC_WIRES, "16_wireAnimFps"),
      name: "Wire Animation Frame Rate",
      tooltip: "Balance visual smoothness vs GPU load for animated wires: Power Saver (15 FPS), Balanced (30 FPS), or Smooth (60+ FPS).",
      type: "combo",
      options: WIRE_ANIM_FPS_MODES,
      defaultValue: lsGet("wireAnimFps", "Power Saver (15 FPS)"),
      onChange: (v) => {
        lsSet("wireAnimFps", v);
        syncWire({ wireAnimFps: v });
      },
    });
    app.ui.settings.addSetting({
      id: "LiveDev.wireAnimateOnInteractOnly",
      category: cat(SEC_WIRES, "17_wireAnimateOnInteractOnly"),
      name: "Animate Wires Only On Hover / Selection",
      tooltip: "Play animated wire effects only on hovered, selected, or executing nodes to keep idle GPU usage at zero.",
      type: "boolean",
      defaultValue: lsGet("wireAnimateOnInteractOnly", true),
      onChange: (v) => {
        lsSet("wireAnimateOnInteractOnly", Boolean(v));
        syncWire({ wireAnimateOnInteractOnly: Boolean(v) });
      },
    });
    app.ui.settings.addSetting({
      id: "LiveDev.wireContextMenu",
      category: cat(SEC_WIRES, "18_wireContextMenu"),
      name: "Show Hide / Show Links In Context Menu",
      tooltip: "Show LiveDev Hide/Show Link actions in node, slot, and canvas right-click menus.",
      type: "boolean",
      defaultValue: lsGet("wireContextMenu", true),
      onChange: (v) => {
        lsSet("wireContextMenu", Boolean(v));
        syncWire({ wireContextMenu: Boolean(v) });
      },
    });
    app.ui.settings.addSetting({
      id: "LiveDev.wireSlotPill",
      category: cat(SEC_WIRES, "19_wireSlotPill"),
      name: "Show Slot Quick-Action Pill On Click",
      tooltip: "Click any input or output slot to open a floating pill above the node to hide/show its link, rename the slot, or disconnect it.",
      type: "boolean",
      defaultValue: lsGet("wireSlotPill", true),
      onChange: (v) => {
        lsSet("wireSlotPill", Boolean(v));
        syncWire({ wireSlotPill: Boolean(v) });
      },
    });

    // ------------------------------------------------------------------------
    // 2. Toolbar & UI
    // ------------------------------------------------------------------------
    app.ui.settings.addSetting({
      id: "LiveDev.tbAutoShow",
      category: cat(SEC_TOOLBAR, "01_tbAutoShow"),
      name: "Always Show Alignment Toolbar",
      tooltip: "Keep the floating LiveDev alignment dock always visible; when off, it appears only when 2+ nodes are selected.",
      type: "boolean",
      defaultValue: (function () {
        try { return localStorage.getItem("livedev_tbAutoShow") !== "off"; } catch (e) { return true; }
      })(),
      onChange: (v) => { if (settingsHydrated) setToolbarAutoShow(Boolean(v)); },
    });
    app.ui.settings.addSetting({
      id: "LiveDev.tbTheme",
      category: cat(SEC_TOOLBAR, "02_tbTheme"),
      name: "Alignment Toolbar Theme",
      tooltip: "Choose Auto (match ComfyUI), Dark glass, or Light glass for the alignment dock.",
      type: "combo",
      options: ["Auto", "Dark", "Light"],
      defaultValue: (function () {
        try {
          const t = localStorage.getItem("livedev_tbTheme");
          return t === "dark" ? "Dark" : t === "light" ? "Light" : "Auto";
        } catch (e) { return "Auto"; }
      })(),
      onChange: (v) => { if (settingsHydrated) setToolbarTheme(v); },
    });
    app.ui.settings.addSetting({
      id: "LiveDev.tbExpanded",
      category: cat(SEC_TOOLBAR, "03_tbExpanded"),
      name: "Expand Extra Tools Row",
      tooltip: "Show the secondary row of node and graph tools on the alignment dock.",
      type: "boolean",
      defaultValue: (function () {
        try { return localStorage.getItem("livedev_tbExpanded") !== "0"; } catch (e) { return true; }
      })(),
      onChange: (v) => { if (settingsHydrated) setToolbarExpanded(Boolean(v)); },
    });
    app.ui.settings.addSetting({
      id: "LiveDev.alignSnapGuides",
      category: cat(SEC_TOOLBAR, "04_alignSnapGuides"),
      name: "Align Snap & Alignment Guides",
      tooltip: "Magnetically snap dragged nodes, subgraphs, notes, and groups to sibling edges, centers, and equal gaps with live alignment guides (hold Shift to bypass during drag).",
      type: "boolean",
      defaultValue: lsGet("alignSnapGuides", true),
      onChange: (v) => {
        lsSet("alignSnapGuides", Boolean(v));
        setAlignSnapEnabled(Boolean(v), { fromSetting: true });
      },
    });
    app.ui.settings.addSetting({
      id: "LiveDev.alignSnapDistance",
      category: cat(SEC_TOOLBAR, "05_alignSnapDistance"),
      name: "Align Snap Threshold (px)",
      tooltip: "Screen-space distance in pixels at which dragged nodes magnetically snap to alignment guides.",
      type: "number",
      defaultValue: Number(lsGet("alignSnapDistance", 8)) || 8,
      attrs: { min: 3, max: 24, step: 1 },
      onChange: (v) => {
        const num = Math.max(3, Math.min(24, Number(v) || 8));
        lsSet("alignSnapDistance", num);
        setAlignSnapDistance(num);
      },
    });
    app.ui.settings.addSetting({
      id: "LiveDev.openWorkflowGallery",
      category: cat(SEC_TOOLBAR, "06_openWorkflowGallery"),
      name: "Workflow Gallery",
      tooltip: "Browse all ComfyUI, custom_nodes, blueprint, and template workflows across subfolders with thumbnails and multiple view modes.",
      type: () => {
        const wrap = document.createElement("div");
        wrap.className = "livedev-settings-action";
        wrap.style.cssText = "display:inline-flex;align-items:center;";
        const galleryOpenBtn = document.createElement("button");
        galleryOpenBtn.type = "button";
        galleryOpenBtn.className = "ld-btn ld-btn-primary";
        galleryOpenBtn.style.cssText =
          "padding:6px 14px;font-size:12px;border-radius:8px;gap:7px;" +
          "box-shadow:0 2px 10px rgba(56,192,196,0.16);";
        galleryOpenBtn.innerHTML = LD_ICONS.gallery + "<span>Open Workflow Gallery</span>";
        galleryOpenBtn.onclick = () => openWorkflowGalleryModal();
        wrap.appendChild(galleryOpenBtn);
        return wrap;
      },
    });

    // ------------------------------------------------------------------------
    // 3. Live Reload & Watcher (Server-backed config.json + local confirmations)
    // ------------------------------------------------------------------------
    const serverBooleans = [
      ["startWatching", "Start Watching On Launch", "start_watching", "Watch custom_nodes for real code edits automatically when ComfyUI starts."],
      ["deferWhileGenerating", "Defer Reload While Generating", "defer_while_generating", "Wait silently until active image/video generation finishes before reloading changed custom nodes."],
      ["reloadDependents", "Reload Dependents", "reload_dependents", "Also reload custom nodes that import the modified module."],
    ];
    for (let i = 0; i < serverBooleans.length; i++) {
      const [sid, name, key, tooltip] = serverBooleans[i];
      app.ui.settings.addSetting({
        id: "LiveDev." + sid,
        category: cat(SEC_WATCHER, "0" + (i + 1) + "_" + sid),
        name,
        tooltip,
        type: "boolean",
        defaultValue: serverSettings[key] !== undefined ? Boolean(serverSettings[key]) : sid !== "reloadDependents",
        onChange: (v) => saveServerOnChange({ [key]: v }),
      });
    }
    app.ui.settings.addSetting({
      id: "LiveDev.confirmReloadAll",
      category: cat(SEC_WATCHER, "04_confirmReloadAll"),
      name: "Confirm Before Reload All",
      tooltip: "Ask for confirmation before reloading all watched custom nodes at once.",
      type: "boolean",
      defaultValue: lsGet("confirmReloadAll", true),
      onChange: (v) => lsSet("confirmReloadAll", v),
    });
    app.ui.settings.addSetting({
      id: "LiveDev.debounce",
      category: cat(SEC_WATCHER, "05_debounce"),
      name: "Debounce (Seconds)",
      tooltip: "Quiet wait interval after a file edit before reloading the module.",
      type: "number",
      defaultValue: Number.isFinite(Number(serverSettings.debounce)) ? Number(serverSettings.debounce) : 1,
      attrs: { min: 0.1, max: 30, step: 0.1 },
      onChange: (v) => saveServerOnChange({ debounce: v }),
    });
    const serverLists = [
      ["watchExtensions", "Watch Extensions", "extensions", "Comma-separated file extensions that trigger live reload (default: .py)."],
      ["observeOnly", "Observe Only Modules", "observe_only", "If non-empty, only watch these comma-separated custom node folders."],
      ["ignorePatterns", "Ignore Patterns", "ignore_patterns", "Comma-separated glob patterns ignored by the file watcher (e.g. tests/*, *.log)."],
    ];
    for (let i = 0; i < serverLists.length; i++) {
      const [sid, name, key, tooltip] = serverLists[i];
      const value = serverSettings[key];
      app.ui.settings.addSetting({
        id: "LiveDev." + sid,
        category: cat(SEC_WATCHER, "0" + (i + 6) + "_" + sid),
        name,
        tooltip,
        type: "text",
        defaultValue: Array.isArray(value) ? value.join(", ") : String(value || ""),
        onChange: (v) => saveServerOnChange({ [key]: v }),
      });
    }
    app.ui.settings.addSetting({
      id: "LiveDev.config",
      category: cat(SEC_WATCHER, "09_config"),
      name: "Live Reload Module Config",
      tooltip: "Open the module exclusion manager to choose which custom_nodes packs are ignored by LiveDev.",
      type: () => {
        const wrap = document.createElement("div");
        wrap.className = "livedev-settings-action";
        wrap.style.cssText = "display:inline-flex;align-items:center;";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ld-btn ld-btn-primary";
        button.style.cssText =
          "padding:6px 14px;font-size:12px;border-radius:8px;gap:7px;" +
          "box-shadow:0 2px 10px rgba(56,192,196,0.16);";
        button.innerHTML = LD_ICONS.sliders + "<span>Open Config</span>";
        button.onclick = () => {
          showLiveDevDialog();
        };
        wrap.appendChild(button);
        return wrap;
      },
    });

    // ------------------------------------------------------------------------
    // 4. Diagnostics & Buffers
    // ------------------------------------------------------------------------
    const diagBooleans = [
      ["markStale", "Mark Stale Nodes", "Highlight nodes on the canvas whose schema changed after a live reload."],
      ["keepLastError", "Keep Last Error", "Keep the most recent execution error ready for the Error Report panel."],
    ];
    for (let i = 0; i < diagBooleans.length; i++) {
      const [sid, name, tooltip] = diagBooleans[i];
      app.ui.settings.addSetting({
        id: "LiveDev." + sid,
        category: cat(SEC_DIAG, "0" + (i + 1) + "_" + sid),
        name,
        tooltip,
        type: "boolean",
        defaultValue: lsGet(sid, true),
        onChange: (v) => lsSet(sid, v),
      });
    }
    const diagNumbers = [
      ["historySize", "Reload History Size", "history_size", 200, { min: 10, max: 5000, step: 10 }, "Maximum reload entries retained in reload_history.json."],
      ["consoleSize", "Console Buffer Size", "console_size", 600, { min: 50, max: 20000, step: 50 }, "Maximum log lines kept in the in-memory Live Console buffer."],
      ["conflictTtl", "Module Conflict Cache (Seconds)", "conflict_ttl", 60, { min: 0, max: 3600, step: 5 }, "How long the duplicate-module conflict scan is cached."],
    ];
    for (let i = 0; i < diagNumbers.length; i++) {
      const [sid, name, key, fallback, attrs, tooltip] = diagNumbers[i];
      const value = Number(serverSettings[key]);
      app.ui.settings.addSetting({
        id: "LiveDev." + sid,
        category: cat(SEC_DIAG, "0" + (i + 3) + "_" + sid),
        name,
        tooltip,
        type: "number",
        defaultValue: Number.isFinite(value) ? value : fallback,
        attrs,
        onChange: (v) => saveServerOnChange({ [key]: v }),
      });
    }
    function makeSettingsActionButton(iconSvg, label, onClick) {
      const wrap = document.createElement("div");
      wrap.className = "livedev-settings-action";
      wrap.style.cssText = "display:inline-flex;align-items:center;";
      const actionBtn = document.createElement("button");
      actionBtn.type = "button";
      actionBtn.className = "ld-btn ld-btn-primary";
      actionBtn.style.cssText =
        "padding:6px 14px;font-size:12px;border-radius:8px;gap:7px;" +
        "box-shadow:0 2px 10px rgba(56,192,196,0.16);";
      actionBtn.innerHTML = iconSvg + "<span>" + esc(label) + "</span>";
      actionBtn.onclick = onClick;
      wrap.appendChild(actionBtn);
      return wrap;
    }

    app.ui.settings.addSetting({
      id: "LiveDev.consoleFilter",
      category: cat(SEC_DIAG, "06_consoleFilter"),
      name: "Console Noise Filter",
      tooltip: "Inspect which custom nodes and libraries write to the console and selectively silence noisy output.",
      type: () => makeSettingsActionButton(LD_ICONS.sliders, "Open Console Filter", () => {
        openConsoleFilterModal();
      }),
    });
    app.ui.settings.addSetting({
      id: "LiveDev.profilerBadges",
      category: cat(SEC_DIAG, "07_profilerBadges"),
      name: "Show Node Timing Badges",
      tooltip: "Display compact execution-duration badges above profiled nodes on the canvas after a run.",
      type: "boolean",
      defaultValue: lsGet("profilerBadges", true),
      onChange: (v) => {
        lsSet("profilerBadges", Boolean(v));
        if (settingsHydrated) setProfilerBadges(Boolean(v));
      },
    });
    app.ui.settings.addSetting({
      id: "LiveDev.openProfiler",
      category: cat(SEC_DIAG, "08_openProfiler"),
      name: "Node Execution Profiler",
      tooltip: "Open the ranked per-node timing breakdown and bottleneck heatmap modal.",
      type: () => makeSettingsActionButton(LD_ICONS.chart, "Open Profiler", () => {
        openProfilerModal();
      }),
    });
    app.ui.settings.addSetting({
      id: "LiveDev.openPreflight",
      category: cat(SEC_DIAG, "09_openPreflight"),
      name: "Workflow Pre-Flight Check",
      tooltip: "Scan the active workflow for missing models, unknown nodes, and disconnected required inputs.",
      type: () => makeSettingsActionButton(LD_ICONS.shield, "Run Pre-Flight Check", () => {
        openPreflightModal();
      }),
    });
    app.ui.settings.addSetting({
      id: "LiveDev.openSnapshots",
      category: cat(SEC_DIAG, "10_openSnapshots"),
      name: "Workflow Snapshots",
      tooltip: "Save local workflow checkpoints, inspect structured diffs, and restore prior states.",
      type: () => makeSettingsActionButton(LD_ICONS.history, "Open Snapshots", () => {
        openSnapshotsModal();
      }),
    });
    app.ui.settings.addSetting({
      id: "LiveDev.openPalette",
      category: cat(SEC_DIAG, "11_openPalette"),
      name: "Command Palette",
      tooltip: "Open the keyboard spotlight palette (also accessible via Ctrl+K or Ctrl+Shift+P).",
      type: () => makeSettingsActionButton(LD_ICONS.search, "Open Palette (Ctrl+K)", () => {
        openCommandPalette();
      }),
    });
    app.ui.settings.addSetting({
      id: "LiveDev.openXYSweep",
      category: cat(SEC_DIAG, "12_openXYSweep"),
      name: "Parameter Sweep Grid",
      tooltip: "Sweep 1 or 2 node widgets across values or ranges and export a labeled X/Y PNG comparison sheet.",
      type: () => makeSettingsActionButton(LD_ICONS.grid, "Open X/Y Sweep", () => {
        openXYSweepModal();
      }),
    });
    app.ui.settings.addSetting({
      id: "LiveDev.openQueueInspector",
      category: cat(SEC_DIAG, "13_openQueueInspector"),
      name: "Queue Inspector",
      tooltip: "Monitor active execution, Smart ETA, pending jobs, and 1-click Re-Run with a fresh seed.",
      type: () => makeSettingsActionButton(LD_ICONS.trace, "Open Queue Inspector", () => {
        openQueueInspectorModal();
      }),
    });

    // ------------------------------------------------------------------------
    // 5. Stats Bar
    // ------------------------------------------------------------------------
    const statIds = ["showCPU", "showGPU", "showVRAM", "showRAM"];
    const statNames = ["CPU", "GPU", "VRAM", "RAM"];
    for (let i = 0; i < statIds.length; i++) {
      const sid = statIds[i];
      app.ui.settings.addSetting({
        id: "LiveDev." + sid,
        category: cat(SEC_STATS, "0" + (i + 1) + "_" + sid),
        name: "Show " + statNames[i],
        tooltip: "Display the " + statNames[i] + " utilization pill in the LiveDev stats bar.",
        type: "boolean",
        defaultValue: true,
        onChange: (v) => lsSet(sid, v),
      });
    }
    app.ui.settings.addSetting({
      id: "LiveDev.refreshRate",
      category: cat(SEC_STATS, "05_refreshRate"),
      name: "Refresh Rate (ms)",
      tooltip: "Polling interval in milliseconds for CPU/GPU/VRAM/RAM readings.",
      type: "number",
      defaultValue: 2500,
      attrs: { min: 500, max: 30000, step: 100 },
      onChange: (v) => lsSet("refreshRate", v),
    });
    const barBooleans = [
      ["showProcess", "Show Process Row", "Include ComfyUI process CPU and RAM inside the stats detail popup."],
      ["showComfy", "Show ComfyUI Row", "Show the ComfyUI column (reserved VRAM, loaded models, device) in the detail popup."],
      ["compactBar", "Compact Stats Bar", "Use tighter padding on stats pills for narrower windows."],
    ];
    for (let i = 0; i < barBooleans.length; i++) {
      const [sid, name, tooltip] = barBooleans[i];
      app.ui.settings.addSetting({
        id: "LiveDev." + sid,
        category: cat(SEC_STATS, "0" + (i + 6) + "_" + sid),
        name,
        tooltip,
        type: "boolean",
        defaultValue: lsGet(sid, sid !== "compactBar"),
        onChange: (v) => lsSet(sid, v),
      });
    }
    app.ui.settings.addSetting({
      id: "LiveDev.barPosition",
      category: cat(SEC_STATS, "09_barPosition"),
      name: "Stats Bar Position",
      tooltip: "Dock the system stats bar in the top menu row or along the bottom edge.",
      type: "combo",
      options: ["Top", "Bottom"],
      defaultValue: lsGet("barPosition", "Top"),
      onChange: (v) => lsSet("barPosition", v),
    });
    app.ui.settings.addSetting({
      id: "LiveDev.drive",
      category: cat(SEC_STATS, "10_drive"),
      name: "Disk Root To Measure",
      tooltip: "Filesystem root measured for the Disk usage reading in the stats popup.",
      type: "combo",
      options: ["Automatic", ...drivesList],
      defaultValue: lsGet("drive", "Automatic"),
      onChange: (v) => lsSet("drive", v),
    });
    app.ui.settings.addSetting({
      id: "LiveDev.vramGuardEnabled",
      category: cat(SEC_STATS, "11_vramGuardEnabled"),
      name: "Auto VRAM Guard",
      tooltip: "Automatically unload idle models and clear memory when post-run VRAM exceeds the threshold (never mid-generation).",
      type: "boolean",
      defaultValue: lsGet("vramGuardEnabled", false),
      onChange: (v) => {
        lsSet("vramGuardEnabled", Boolean(v));
        if (settingsHydrated) applyVramGuardSettings({ enabled: Boolean(v) });
      },
    });
    app.ui.settings.addSetting({
      id: "LiveDev.vramGuardThreshold",
      category: cat(SEC_STATS, "12_vramGuardThreshold"),
      name: "Auto VRAM Guard Threshold (%)",
      tooltip: "Idle VRAM usage percentage that triggers Auto VRAM Guard cleanup after a run finishes.",
      type: "number",
      defaultValue: Number(lsGet("vramGuardThreshold", 90)) || 90,
      attrs: { min: 60, max: 98, step: 1 },
      onChange: (v) => {
        const num = Math.max(60, Math.min(98, Number(v) || 90));
        lsSet("vramGuardThreshold", num);
        if (settingsHydrated) applyVramGuardSettings({ threshold: num });
      },
    });
    app.ui.settings.addSetting({
      id: "LiveDev.vramLeakAlert",
      category: cat(SEC_STATS, "13_vramLeakAlert"),
      name: "VRAM Leak Alert",
      tooltip: "Show a subtle toast alert if VRAM stays abnormally elevated after a workflow finishes.",
      type: "boolean",
      defaultValue: lsGet("vramLeakAlert", true),
      onChange: (v) => {
        lsSet("vramLeakAlert", Boolean(v));
        if (settingsHydrated) applyVramGuardSettings({ leakAlert: Boolean(v) });
      },
    });

    // ------------------------------------------------------------------------
    // 6. Language & Voice
    // ------------------------------------------------------------------------
    const languageSettings = [
      ["voiceLang", "Voice Language", "en", ["en", "ar"], "Recognition language for LiveDev Voice Commands."],
      ["translateTarget", "Translate Target Language", "en", null, "Default target language code used by the Localization Scanner."],
    ];
    for (let i = 0; i < languageSettings.length; i++) {
      const [sid, name, fallback, options, tooltip] = languageSettings[i];
      app.ui.settings.addSetting({
        id: "LiveDev." + sid,
        category: cat(SEC_LANG, "0" + (i + 1) + "_" + sid),
        name,
        tooltip,
        type: options ? "combo" : "text",
        ...(options ? { options } : {}),
        defaultValue: lsGet(sid, fallback),
        onChange: (v) => lsSet(sid, v),
      });
    }

    settingsHydrated = true;
    applyWireSettings();

  },
});

