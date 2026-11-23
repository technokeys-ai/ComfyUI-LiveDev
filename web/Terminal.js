import { app } from "../../scripts/app.js"
import { api } from "../../scripts/api.js"
import { Util } from "./utils.js"
import { SURFACE_DEEP, TEXT, FONT_MONO } from "./livedev-theme.js"


var TerminalTextVersion = 0
var TerminalLines = new Array()


// Tell the server how many Terminal nodes are on the canvas, so its log tail can idle when there is
// nothing to receive it. The browser is the only side that knows: the node's thread used to read the
// log file every second for the life of the server, whether or not a Terminal had been placed.
async function reportWatchers() {
    const count = (app.graph?._nodes || []).filter((n) => n.type === "LiveDev_Terminal").length
    try {
        await api.fetchApi("/livedev/terminal_watch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ count }),
        })
    } catch (e) {
        console.warn("[LiveDev] could not report the Terminal count:", e)
    }
}

// A page that is closing cannot make an ordinary request; a beacon is the one the browser promises to
// send. Without it the count stays where it was and the tail keeps reading for a canvas that is gone.
window.addEventListener("pagehide", () => {
    try {
        navigator.sendBeacon("/livedev/terminal_watch",
            new Blob([JSON.stringify({ count: 0 })], { type: "application/json" }))
    } catch (e) { /* nothing useful to do while the page is going away */ }
})


app.registerExtension({

    name: 'LiveDev.Terminal',

    async setup() {
        Util.AddMessageListener("/livedev.terminal.log", logTerminal)
        function logTerminal(event) {
            TerminalTextVersion++
            if (event.detail.clear) {
                TerminalLines.length = 0
            }
            let totalText = String(event.detail.text || "")
            TerminalLines.push(...(totalText.split("\n")))
            if (TerminalLines.length > 1024) {
                TerminalLines = TerminalLines.slice(TerminalLines.length - 1024, TerminalLines.length)
            }
            for (let i = 0; i < app.graph._nodes.length; i++) {
                var node = app.graph._nodes[i]
                if (node.type != "LiveDev_Terminal") continue;
                node.onDrawForeground?.apply(node, [app.ctx, app.canvas]);
            }
        }

    },

    async beforeRegisterNodeDef(nodeType, nodeData, app) {

        switch (nodeData.name) {
            case "LiveDev_Terminal":
                Register_Terminal(nodeType)
                break;
        }

        function Register_Terminal(nodeType) {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = async function () {
                const me = onNodeCreated?.apply(this);
                var textArea = Util.AddReadOnlyTextArea(this, "terminal", "");
                // A terminal stays dark in both themes, which is the one place the pack does not
                // follow the interface. `fontColor` is not a CSS property - it is the old HTML
                // attribute - so the colour never applied and the text kept whatever the widget
                // already had; `color` is what the browser reads.
                textArea.element.style.backgroundColor = SURFACE_DEEP
                textArea.element.style.color = TEXT
                textArea.element.style.fontFamily = FONT_MONO
                let clearBtn = Util.AddButtonWidget(this, "Clear", clearButtonCallback)
                clearBtn.width = 128
                this.terminalVersion = -1
                reportWatchers()
                return me;
            }
            const onRemoved = nodeType.prototype.onRemoved;
            nodeType.prototype.onRemoved = function () {
                const out = onRemoved?.apply(this, arguments);
                reportWatchers();
                return out;
            }
            function clearButtonCallback() {
                TerminalLines.length = 0
                TerminalTextVersion++
            }
            const onDrawForeground = nodeType.prototype.onDrawForeground;
            nodeType.prototype.onDrawForeground = function (ctx, graphcanvas) {
                if (this.terminalVersion == TerminalTextVersion) {
                    return onDrawForeground?.apply(this);
                }
                this.terminalVersion = TerminalTextVersion
                for (var i = 0; i < this.widgets.length; i++) {
                    var wid = this.widgets[i];
                    if (wid.name != "terminal") continue;
                    Util.SetTextAreaContent(wid, TerminalLines.join("\n"))
                    Util.SetTextAreaScrollPos(wid, 1.0)
                    break;
                }
                return onDrawForeground?.apply(this);
            }
        }

        return nodeType;
    },

});
