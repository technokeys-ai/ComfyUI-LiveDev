import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { getSelectedArr, setStaleNodes, showToast, staleNodes } from "./utils.js";
import { FONT_MONO, LD_ICONS, createGlassModal, ensureTheme } from "./livedev-theme.js";

// Node tools that belong next to the existing LiveDev entries: give a node an exact size, and
// drive the server from the same menu. The server routes already exist in Core/Routes.py, so the
// three server actions here only call them — nothing is reimplemented.

// Copying nodes fills TWO clipboards:
//   1. localStorage["litegrapheditor_clipboard"] - read by canvas.pasteFromClipboard()
//   2. the OS clipboard as text/html carrying data-metadata="<base64 node json>",
//      which pasteClipboardItems() decodes before falling back to localStorage.
// Restarting the server clears neither, so both have to be emptied here. It lives in this file
// rather than one of its own because the LiveDev submenu below is its only caller.
const CLIPBOARD_KEY = "litegrapheditor_clipboard";

async function clearNodeClipboard() {
  localStorage.removeItem(CLIPBOARD_KEY);
  try {
    // writeText replaces the whole clipboard, dropping the text/html payload.
    await navigator.clipboard.writeText("");
    showToast("Node clipboard cleared");
  } catch (e) {
    console.warn("[LiveDev] Could not empty the system clipboard:", e);
    showToast("Stored nodes cleared, browser refused the system clipboard");
  }
}

function currentTarget(fallback) {
    if (fallback && fallback.pos) return [fallback];
    return getSelectedArr();
}

function openDialog(title, fields, onApply) {
    const { body, footer, close } = createGlassModal({
        title,
        icon: LD_ICONS.sliders,
        width: "360px",
        draggable: true,
    });

    const inputs = {};
    const apply = () => {
        const values = {};
        for (const [key, input] of Object.entries(inputs)) values[key] = Number(input.value);
        close();
        onApply(values);
    };

    const form = document.createElement("div");
    form.style.cssText = "display:flex;flex-direction:column;gap:10px;";

    for (const field of fields) {
        const row = document.createElement("label");
        row.style.cssText = "display:flex;align-items:center;gap:12px;justify-content:space-between;font-size:12.5px;color:#d8dee6;";
        row.append(Object.assign(document.createElement("span"), { textContent: field.label }));

        const input = document.createElement("input");
        input.type = "text";
        input.inputMode = "decimal";
        input.className = "ld-input";
        input.value = field.value;
        input.style.cssText = `width:140px;font-family:${FONT_MONO};`;
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                apply();
            }
        });
        row.append(input);
        inputs[field.key] = input;
        form.append(row);
    }
    body.append(form);

    footer.style.display = "flex";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ld-btn";
    cancel.textContent = "Cancel";
    cancel.onclick = close;

    const applyButton = document.createElement("button");
    applyButton.type = "button";
    applyButton.className = "ld-btn ld-btn-primary";
    applyButton.textContent = "Apply";
    applyButton.onclick = apply;

    footer.append(cancel, applyButton);
    inputs[fields[0].key].focus();
    inputs[fields[0].key].select();
}

function resizeNode(fallback) {
    const nodes = currentTarget(fallback);
    if (!nodes.length) {
        showToast("Select a node first");
        return;
    }

    const first = nodes[0];
    openDialog(
        nodes.length === 1 ? "Resize Node" : `Resize ${nodes.length} Nodes`,
        [
            { key: "width", label: "Width", value: Math.round(first.size[0]), min: 1 },
            { key: "height", label: "Height", value: Math.round(first.size[1]), min: 1 },
        ],
        (values) => {
            const width = Math.max(1, Math.round(values.width));
            const height = Math.max(1, Math.round(values.height));
            for (const node of nodes) node.setSize([width, height]);
            app.canvas.setDirty(true, true);
            showToast(`Resized to ${width} x ${height}`);
        }
    );
}

async function serverAction(path, confirmText, busyText) {
    if (confirmText && !window.confirm(confirmText)) return;
    try {
        if (busyText) showToast(busyText);
        await api.fetchApi(path, { method: "POST" });
    } catch (error) {
        console.warn(`[LiveDev] ${path} failed:`, error);
        showToast("The server did not answer");
    }
}

// Rebuild a node from its own class, the way adding it again would.
//
// A reloaded pack can change a node's widgets or its sockets, and the node already on the canvas is
// still the one the previous class built. Rebuilding replaces the instance so the canvas matches the
// class again.
//
// The values travel through the same `serialize` / `configure` pair a workflow save and load use, so
// what a repaired node ends up with is what loading it would have produced. The frontend's own
// `recreateWidget` would be less work, but it is not general: it belongs to the widget-as-input
// feature and only exists on nodes that have such a widget.
function snapshotForRepair(node) {
    const graph = node.graph;
    const snapshot = node.serialize();

    // The class defines the sockets. The snapshot's own lists describe the instance being replaced
    // and would put the old socket set back instead of the new one, so they are dropped and the
    // links are carried separately, by slot NAME.
    delete snapshot.inputs;
    delete snapshot.outputs;
    // Letting the old id through would hand the new node an id the graph has already handed out
    // again; the links below follow the real id change instead.
    delete snapshot.id;

    const inputs = [];
    for (const input of node.inputs || []) {
        const link = input.link != null ? graph.links[input.link] : null;
        if (link) inputs.push({ name: input.name, node: link.origin_id, slot: link.origin_slot });
    }
    const outputs = [];
    for (const output of node.outputs || []) {
        for (const id of output.links || []) {
            const link = graph.links[id];
            if (link) outputs.push({ name: output.name, node: link.target_id, slot: link.target_slot });
        }
    }
    return { snapshot, inputs, outputs, at: [...node.pos] };
}

/**
 * Rebuild the given nodes from their own classes.
 *
 * Exported because the LiveDev menu rebuilds the nodes a reload left stale, and the node submenu
 * rebuilds whatever is selected or right-clicked. One implementation, so "Fix Node" and the stale
 * rebuild cannot drift apart.
 */
export function rebuildNodes(nodes, keepValues) {
    if (!nodes || !nodes.length) return;
    const graph = app.canvas?.graph;
    if (!graph) return;

    graph.beforeChange?.();
    const rebuilt = [];
    const remap = new Map();  // old id -> new id, so a chain of repaired nodes still reconnects
    let refused = 0;

    for (const node of nodes) {
        const { snapshot, inputs, outputs, at } = snapshotForRepair(node);
        const fresh = LiteGraph.createNode(node.type);
        if (!fresh) {
            refused++;
            continue;  // the class is gone: the pack that defined it was removed
        }
        // Read the values by widget NAME before the rebuild. `configure` puts a saved workflow's
        // values back by position; a class that gained or moved a widget is the reason to repair at
        // all, so the values are put back by name on top of it below.
        const keptValues = keepValues
            ? new Map((node.widgets || []).map((w) => [w.name, w.value]))
            : null;
        const keptNames = (node.widgets || []).map((w) => w.name).join("\u0000");
        if (!keepValues) {
            // Everything a fresh node decides for itself: widget values (both the positional array
            // and the named copy the frontend also writes), title, colours, size, mode, flags, the
            // Advanced toggle, and `properties`. Position is kept either way, or the node would jump
            // across the canvas.
            //
            // `properties` is the one that is easy to miss and the one that makes a reset look
            // broken: a pack may keep its own copy of a value there and put it back when the node is
            // configured - ProStudio's slider rows write `prostudio_sliders` and restore from it -
            // so leaving it in brings the old values straight back.
            for (const field of ["widgets_values", "widgets_values_named", "title", "color",
                                 "bgcolor", "size", "mode", "flags", "order", "showAdvanced",
                                 "properties"]) {
                delete snapshot[field];
            }
        }
        const oldId = node.id;
        graph.remove(node);
        graph.add(fresh);
        fresh.pos = at;
        fresh.configure(snapshot);

        if (keptValues) {
            for (const widget of fresh.widgets || []) {
                if (keptValues.has(widget.name)) widget.value = keptValues.get(widget.name);
            }
            // The saved array is positional. When the widget list is the same one it already agrees
            // with what is on screen, and it is left exactly as `configure` produced it, so a node
            // whose class did not change is untouched. When the list changed, the array is rebuilt
            // from the widgets so that saving writes the values that are actually shown.
            if ((fresh.widgets || []).map((w) => w.name).join("\u0000") !== keptNames) {
                fresh.widgets_values = (fresh.widgets || []).map((w) => w.value);
            }
        }

        remap.set(oldId, fresh.id);
        rebuilt.push({ fresh, inputs, outputs });
    }

    // Reconnect by slot NAME: a class that changed can reorder its slots, and an index would land a
    // wire on the wrong socket. A slot the new class does not have has nowhere to go, and dropping
    // that link is better than inventing a socket for it.
    let dropped = 0;
    for (const { fresh, inputs, outputs } of rebuilt) {
        for (const link of inputs) {
            const slot = (fresh.inputs || []).findIndex((i) => i.name === link.name);
            const origin = graph.getNodeById(remap.get(link.node) ?? link.node);
            if (origin && slot >= 0) origin.connect(link.slot, fresh, slot);
            else dropped++;
        }
        for (const link of outputs) {
            const slot = (fresh.outputs || []).findIndex((o) => o.name === link.name);
            const target = graph.getNodeById(remap.get(link.node) ?? link.node);
            if (target && slot >= 0) fresh.connect(slot, target, link.slot);
            else dropped++;
        }
    }

    graph.afterChange?.();
    app.canvas?.setDirty(true, true);

    if (!rebuilt.length) {
        showToast(refused === 1
            ? "That node has no class to rebuild from"
            : `${refused} nodes have no class to rebuild from`);
        return;
    }
    const outcome = keepValues ? "values kept" : "values reset";
    const lost = dropped ? `, ${dropped} link${dropped === 1 ? "" : "s"} dropped` : "";
    showToast(`${rebuilt.length} node${rebuilt.length === 1 ? "" : "s"} repaired (${outcome}${lost})`);
}

function repairSelected(fallback, keepValues) {
    const nodes = currentTarget(fallback);
    if (!nodes.length) {
        showToast("Select a node first");
        return;
    }
    rebuildNodes(nodes, keepValues);
}

/**
 * Rebuild whatever a reload left behind, from either menu.
 *
 * The two menus and the LiveDev popup all offer this, so it is written once: read the list, tell the
 * user when there is nothing in it, and hand the nodes to the same rebuild the node submenu uses.
 */
export function rebuildStaleNodes() {
    const stale = staleNodes();
    if (!stale.length) {
        showToast("LiveDev: nothing to rebuild - the canvas matches every node's class");
        return;
    }
    setStaleNodes([]);
    rebuildNodes(stale, true);
}

function runTool(value, node) {
    // The label leads with the emoji its cell carries in the LiveDev menu, so the name is read from
    // after it: comparing the whole string stopped matching the moment "Fix Node" became
    // "🔧 Fix Node", and a menu entry that silently does nothing is worse than a missing one.
    const name = value.replace(/^[^\p{L}]+/u, "");
    if (name === "Fix Node") return repairSelected(node, false);
    if (name === "Fix Node (Keep Values)") return repairSelected(node, true);
    if (name.startsWith("Rebuild")) return rebuildStaleNodes();
    if (name === "Resize Node...") return resizeNode(node);
    if (name === "Clear Console") return serverAction("/livedev/clear_console");
    if (name === "Clear Node Clipboard") return clearNodeClipboard();
    if (name === "Restart Server") {
        return serverAction("/livedev/restart", "Restart the ComfyUI server?", "Restarting server...");
    }
    if (name === "Shutdown Server") {
        return serverAction("/livedev/shutdown", "Shut the ComfyUI server down?");
    }
}

// Grouped by what the entry acts on, with `null` between the groups so a destructive server action is
// never the item next to a harmless one. Every entry leads with the emoji its cell carries in the
// LiveDev menu, so the two menus read as one thing.
//
// Built per call rather than kept in a constant: the Rebuild count is whatever the last reload left
// behind, and a menu built once would keep showing the number it had when the page loaded.
function toolItems(withResize) {
    const stale = staleNodes().length;
    return [
        "\u{1F527} Fix Node",
        "\u267B Fix Node (Keep Values)",
        `\u{1F9F1} Rebuild (${stale})`,
        ...(withResize ? ["\u{1F4D0} Resize Node..."] : []),
        null,
        "\u{1F9F9} Clear Console",
        "\u{1F4CB} Clear Node Clipboard",
        null,
        "\u{1F504} Restart Server",
        "\u{1F6D1} Shutdown Server",
    ];
}

// has_submenu + submenu.options is how a nested menu is built here: rgthree-comfy and
// RedNodeStudio both do it exactly this way.
function liveDevSubmenu(node, options) {
    ensureTheme();
    return {
        content: `<span class="ld-ctx-label">${LD_ICONS.brand}<span>LiveDev</span></span>`,
        has_submenu: true,
        submenu: {
            options,
            callback: (value) => runTool(value, node),
        },
    };
}

app.registerExtension({
    name: "LiveDev.NodeTools",
    // The context-menu hook this frontend reads. The older commands/menuCommands pair silently
    // produced nothing, which is why nothing showed up before. null is a separator.
    getNodeMenuItems(node) {
        return [null, liveDevSubmenu(node, toolItems(true))];
    },

    // Right-clicking the empty canvas: the node tools act on the selection instead of a right-clicked
    // node, which is why Resize is not offered here and why repairing needs a selection.
    getCanvasMenuItems() {
        return [null, liveDevSubmenu(null, toolItems(false))];
    },
});
