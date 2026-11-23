/**
 * LiveDev error report - stage 1: sanitising.
 *
 * The goal of the whole feature is two things at once: help fix the code, and produce a report that
 * can be pasted into a chat without leaking anything. This file is the second half's foundation.
 *
 * A raw ComfyUI error is not safe to paste anywhere. Measured on a real machine, one execution_error
 * carried:
 *
 *   - the full install path, which contains the Windows user name
 *   - a traceback whose useful part is the last three frames, not the first thirty
 *   - a widget value that was an API key, sitting in widgets_values with nothing marking it
 *   - a prompt_id, a node id, and a 900-character message, all unbounded
 *
 * So three rules are applied to every string that leaves this module:
 *
 *   1. Collapse whitespace, then truncate. A traceback pasted as one line is still readable; a
 *      traceback pasted as forty lines drowns the report.
 *   2. Redact anything shaped like a credential. Named patterns only - a generic "long string with
 *      digits" rule would eat the SHA-256 hashes that appear in model file names, and those are
 *      useful.
 *   3. Replace the identity-bearing parts of a path with a placeholder, keeping the structure. The
 *      rules are generic rather than hard-coded to D:\ComfyUI, because the same report should
 *      read sensibly from someone else's install.
 *
 * Lists are truncated from the END, not the start. That is not a detail: a Python traceback ends at
 * the frame that raised, so the last items are the ones worth reading.
 *
 * This module registers an extension only so that ComfyUI loads it and so the self-test runs at
 * startup and says so in the console. It draws nothing yet; the card and the report come next.
 */

import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import {
    BTN,
    BTN_GREEN,
    ERROR_CARD_HOOKS,
    ERROR_LIFECYCLE,
    clearErrorOverlay,
    h,
    makePanel,
    showErrorOverlay,
} from "./livedev-toolkit.js";
import { showToast } from "./utils.js";

// ---------------------------------------------------------------------------------------- limits

const MAX_TEXT = 900;
const MAX_LIST = 40;
const MAX_TRACEBACK_LINES = 16;

// --------------------------------------------------------------------------------------- secrets

// Named patterns only. Each one is a real credential format, so a match is almost certainly a
// credential and a miss costs nothing - unlike a broad heuristic, which would redact hashes.
const SECRET_RULES = [
    [/\bhf_[A-Za-z0-9]{20,}/g, "hf_***"],
    [/\bsk-[A-Za-z0-9_-]{20,}/g, "sk-***"],
    [/\bghp_[A-Za-z0-9]{20,}/g, "ghp_***"],
    [/\bgho_[A-Za-z0-9]{20,}/g, "gho_***"],
    [/\bghs_[A-Za-z0-9]{20,}/g, "ghs_***"],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "github_pat_***"],
    [/\bAIza[A-Za-z0-9_-]{30,}/g, "AIza***"],
    [/\bxox[baprs]-[A-Za-z0-9-]{20,}/g, "xox***"],
    [/\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}/g, "<jwt>"],
    [/\b(?:Bearer|bearer)\s+[A-Za-z0-9._-]{16,}/g, "Bearer ***"],
];

// A widget whose name says what it holds. The value is replaced without being looked at, which is
// the only reliable way to catch a key that happens to be short or oddly shaped.
const SENSITIVE_WIDGET = /(?:^|[_\-\s])(?:api[_\-\s]?key|apikey|token|secret|password|passwd|auth|credential|access[_\-\s]?key|bearer)(?:$|[_\-\s])/i;

// ----------------------------------------------------------------------------------------- paths

// Generic, not tied to this machine. The lookahead keeps the useful part of the path and drops only
// the prefix that identifies who and where.
const PATH_RULES = [
    // C:\Users\Name\...            -> <HOME>\...
    [/\b[A-Za-z]:\\Users\\[^\\\s"']+/g, "<HOME>"],
    // /home/name/... and /Users/name/...
    [/\/(?:home|Users)\/[^/\s"']+/g, "<HOME>"],
    // Anything before \custom_nodes\ -> <COMFY>\custom_nodes\...
    [/\b[A-Za-z]:\\(?:[^\\\s"']+\\)*?(?=custom_nodes\\)/g, "<COMFY>\\"],
    // Anything before /custom_nodes/ -> <COMFY>/custom_nodes/...
    [/\/[^\s"']*?(?=\/custom_nodes\/)/g, "<COMFY>"],
    // Anything before \site-packages\ -> <SITE>\...
    // The anchor is consumed here, unlike custom_nodes below: <SITE>\site-packages\torch reads
    // redundantly, while <COMFY>\custom_nodes\Pack is more informative than <COMFY>\Pack because it
    // says the file belongs to a pack rather than to ComfyUI itself.
    [/\b[A-Za-z]:\\(?:[^\\\s"']+\\)*?site-packages\\/g, "<SITE>\\"],
    [/\/[^\s"']*?site-packages\//g, "<SITE>/"],
    // Anything before \models\ -> <COMFY>\models\...
    [/\b[A-Za-z]:\\(?:[^\\\s"']+\\)*?(?=models\\)/g, "<COMFY>\\"],
    // A bare interpreter path, for the case where site-packages is not in the string.
    [/\b[A-Za-z]:\\(?:[^\\\s"']+\\)*?(?=python_embeded\\)/g, "<PYTHON>\\"],
];

// ------------------------------------------------------------------------------------------ core

// Colour codes and carriage returns. The console buffer is full of them - LiveDev's own log lines
// and ComfyUI's are both coloured - and pasted into a report they are unreadable noise. The carriage
// return matters separately: a progress bar rewrites one line, and without stripping it the report
// keeps every intermediate state of that line.
const ANSI = /\u001b\[[0-9;]*[A-Za-z]|\u001b\][^\u0007]*\u0007|[\r\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

function stripAnsi(value) {
    return String(value ?? "").replace(ANSI, "");
}

function collapse(value) {
    return stripAnsi(value).replace(/\s+/g, " ").trim();
}

function redactSecrets(text) {
    let out = String(text ?? "");
    for (const [pattern, replacement] of SECRET_RULES) {
        out = out.replace(pattern, replacement);
    }
    return out;
}

// The install root, learned from the first path that contains custom_nodes.
//
// It cannot be hard-coded, and it cannot be inferred from a bare path like
// D:\ComfyUI\ComfyUI\execution.py - nothing in that string says which part is the root. But every
// report contains at least one custom_nodes path, and the prefix before it is the same root, so it
// is learned and then applied to the paths that do not carry their own anchor.
//
// Without this the traceback came out half shortened: the frames inside a custom node read
// <COMFY>\custom_nodes\Pack\file.py while ComfyUI's own frames read D:\ComfyUI\ComfyUI\execution.py.
let _comfyRoot = "";

function learnRoot(text) {
    const match = /([A-Za-z]:\\(?:[^\\\s"']+\\)*?)custom_nodes\\/.exec(String(text ?? ""));
    if (match && match[1].length > _comfyRoot.length) _comfyRoot = match[1];
}

// Walks the payload and learns from every string in it.
//
// Not JSON.stringify: that escapes every backslash, so the string a regex sees is
// "D:\\ComfyUI\\..." rather than "D:\ComfyUI\...", and the pattern - which is written for real
// paths - never matches. Walking the raw values keeps them as the operating system wrote them.
export function learnRootDeep(value, depth = 0) {
    if (depth > 8) return;
    if (typeof value === "string") {
        if (value.includes("custom_nodes")) learnRoot(value);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) learnRootDeep(item, depth + 1);
        return;
    }
    if (value && typeof value === "object") {
        for (const item of Object.values(value)) learnRootDeep(item, depth + 1);
    }
}

export function resetLearnedRoot() {
    _comfyRoot = "";
}

function shortenPaths(text) {
    let out = String(text ?? "");
    if (_comfyRoot && out.includes(_comfyRoot)) {
        out = out.split(_comfyRoot).join("<COMFY>\\");
    }
    for (const [pattern, replacement] of PATH_RULES) {
        out = out.replace(pattern, replacement);
    }
    return out;
}

/**
 * One string, ready to leave the browser: whitespace collapsed, credentials gone, paths reduced,
 * length bounded. This is the only function that should touch a raw value.
 */
export function safeScalar(value, maxLength = MAX_TEXT) {
    if (!["string", "number", "boolean"].includes(typeof value)) return "";
    const text = shortenPaths(redactSecrets(collapse(value)));
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}...`;
}

/**
 * A list, trimmed from the end.
 *
 * The end is the right end: a traceback's last frames are the ones that raised, and history's last
 * entries are the run that failed. Taking the first N would keep the noise.
 */
export function safeList(value, maxItems = MAX_LIST) {
    const items = Array.isArray(value) ? value : [value];
    return items
        .slice(-maxItems)
        .map((item) => safeScalar(item))
        .filter(Boolean);
}

/**
 * A traceback, reduced to the frames that matter.
 *
 * Each Python frame is a `File "..."` line followed by the source line, so the tail is what counts.
 * When frames are dropped the count is stated, because a report that silently hides half a traceback
 * sends the reader looking for a frame that is not there.
 */
export function compactTraceback(value, maxLines = MAX_TRACEBACK_LINES) {
    const raw = Array.isArray(value) ? value : String(value ?? "").split("\n");
    // safeScalar, not collapse: a traceback frame is a path, and the first version of this used
    // collapse alone, so every frame carried the full install path into the report.
    const lines = raw.map((line) => safeScalar(line)).filter(Boolean);
    if (lines.length <= maxLines) return lines;
    const dropped = lines.length - maxLines;
    return [`... ${dropped} earlier line(s) ...`, ...lines.slice(-maxLines)];
}

/**
 * The error itself, in the shape the report wants.
 *
 * Both paths are covered: `node_errors` is what /prompt rejects with before anything runs, and the
 * execution_error event is what arrives after. The first is the more common one on this machine -
 * an un-downloaded model or a widget left empty never reaches execution at all.
 */
export function sanitizeError(detail) {
    // The lifecycle stores `{ id, detail }` so the menu can find a failure again after its card has
    // gone, and the sanitizer wants the detail itself. Unwrapping here rather than at every caller is
    // what the "Error" section was missing: it read `node_id` and `exception_message` off the wrapper,
    // found neither, and printed a section with no error in it for every real failure.
    if (detail && typeof detail === "object" && detail.id !== undefined && detail.detail) {
        detail = detail.detail;
    }
    const data = detail && typeof detail === "object" ? detail : {};
    // Two passes over the payload: the first teaches the module where ComfyUI is installed, the
    // second shortens every path with that knowledge. Doing it in one pass left the frames that
    // arrive before a custom_nodes path unshortened.
    learnRootDeep(data);
    const nodeError = firstNodeError(data.node_errors);

    const result = {
        where: nodeError.node_type || safeScalar(data.node_type) || "unknown",
        node_id: safeScalar(nodeError.node_id || data.node_id || data.node),
        exception_type: safeScalar(
            nodeError.exception_type || data.exception_type || data.type || "Error"
        ),
        message: safeScalar(
            nodeError.exception_message || data.exception_message || data.message || ""
        ),
    };

    // The input that failed, when the failure was a validation one. This is the field that turns
    // "value not in list" into something actionable.
    const inputName = safeScalar(nodeError.input_name || data.input_name);
    if (inputName) result.input_name = inputName;

    const traceback = compactTraceback(data.traceback);
    if (traceback.length) result.traceback = traceback;

    const executed = safeList(data.executed, 20);
    if (executed.length) result.executed = executed;

    return result;
}

/**
 * The first node error out of a node_errors object.
 *
 * The shape is `{ "<node id>": { class_type, errors: [ { type, message, extra_info } ] } }`. Only the
 * first error of the first node is taken: a validation failure usually cascades, and the first one
 * is the cause.
 */
function firstNodeError(nodeErrors) {
    if (!nodeErrors || typeof nodeErrors !== "object" || Array.isArray(nodeErrors)) return {};
    for (const [nodeId, info] of Object.entries(nodeErrors)) {
        if (!info || typeof info !== "object") continue;
        const first = Array.isArray(info.errors) ? info.errors[0] : null;
        if (!first || typeof first !== "object") continue;
        return {
            node_id: nodeId,
            node_type: info.class_type,
            exception_type: first.type,
            exception_message: first.message,
            input_name: first?.extra_info?.input_name,
        };
    }
    return {};
}

/**
 * A widget list, with anything whose name says it holds a credential replaced.
 *
 * widgets_values is a positional array, so the names come from a parallel list. Both are needed:
 * without the names there is no way to know that the string in slot 9 is an API key rather than a
 * prompt.
 */
export function sanitizeWidgetValues(values, names) {
    if (!Array.isArray(values)) return [];
    return values.map((value, index) => {
        const name = Array.isArray(names) ? names[index] : "";
        if (name && SENSITIVE_WIDGET.test(String(name))) return "***";
        if (typeof value === "string" && value.length > MAX_TEXT) return safeScalar(value);
        return value;
    });
}

export function isSensitiveWidgetName(name) {
    return SENSITIVE_WIDGET.test(String(name || ""));
}

/**
 * A widget value, keeping its type where the type carries meaning.
 *
 * safeScalar turns everything into a string, which would print a token limit as "2048" and a
 * boolean as "true". For a report read by a person or a model that is a small lie worth avoiding, so
 * numbers and booleans pass through and only strings are cleaned.
 */
export function safeValue(value, maxLength = 200) {
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) return `<${value.length} item(s)>`;
    if (typeof value === "object") return "<object>";
    return safeScalar(value, maxLength);
}

// ---------------------------------------------------------------------------------------- report

// Everything below gathers. Each source is optional and each failure is silent, because a report
// that throws while being built is worse than one that is missing a section: the user is already
// looking at a broken run and should not be handed a second error.
async function fetchOptional(url, options = {}) {
    try {
        const response = await api.fetchApi(url, options);
        if (!response.ok) return null;
        return await response.json();
    } catch (error) {
        return null;
    }
}

function roundGb(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value)) return null;
    return Math.round((value / 1024 ** 3) * 10) / 10;
}

/**
 * The machine. Taken from ComfyUI's own /system_stats rather than measured here, so the numbers are
 * the ones the server is working with.
 *
 * The three VRAM fields are kept separate on purpose. `vram_free` is what the card has, and
 * `torch_vram_free` is what is left inside PyTorch's allocator - on the machine this was built for
 * they read 7.3 GB and 0.12 GB at the same moment, and reporting only the second one makes a healthy
 * card look full.
 */
export function compactSystem(stats) {
    if (!stats || typeof stats !== "object") return null;
    const system = stats.system || {};
    const devices = Array.isArray(stats.devices) ? stats.devices : [];
    return {
        comfyui: safeScalar(system.comfyui_version),
        python: safeScalar(system.python_version),
        pytorch: safeScalar(system.pytorch_version),
        os: safeScalar(system.os),
        ram_total_gb: roundGb(system.ram_total),
        ram_free_gb: roundGb(system.ram_free),
        devices: devices.map((device) => ({
            name: safeScalar(device?.name),
            type: safeScalar(device?.type),
            vram_total_gb: roundGb(device?.vram_total),
            vram_free_gb: roundGb(device?.vram_free),
            torch_vram_free_gb: roundGb(device?.torch_vram_free),
        })),
    };
}

function compactQueue(queue) {
    if (!queue || typeof queue !== "object") return null;
    const running = queue.running_count ?? (Array.isArray(queue.running) ? queue.running.length : 0);
    const pending = queue.pending_count ?? (Array.isArray(queue.pending) ? queue.pending.length : 0);
    return { running: Number(running) || 0, pending: Number(pending) || 0 };
}

/**
 * The errors out of the last few runs, newest last.
 *
 * /history keeps everything a run produced, which is megabytes, and the only part worth reporting is
 * the execution_error entries inside status.messages. Those are `[name, payload]` pairs, so the walk
 * is over that shape rather than over the outputs.
 */
export function compactHistoryErrors(history, maxRuns = 6) {
    if (!history || typeof history !== "object") return [];
    const found = [];
    for (const [promptId, run] of Object.entries(history)) {
        const messages = Array.isArray(run?.status?.messages) ? run.status.messages : [];
        for (const entry of messages) {
            const name = Array.isArray(entry) ? entry[0] : "";
            const payload = Array.isArray(entry) ? entry[1] : null;
            if (name !== "execution_error" || !payload) continue;
            found.push({ prompt_id: safeScalar(promptId, 40), ...sanitizeError(payload) });
        }
    }
    return found.slice(-maxRuns);
}

/**
 * The tail of the console.
 *
 * This is the section that usually explains the failure. Every diagnosis of the model downloader was
 * solved by reading the [ProStudio] lines in the console, and the browser never saw them - LiveDev
 * already tees server stdout into a 600-line buffer, so they are one fetch away.
 */
export function compactConsole(lines, maxLines = 140) {
    // LiveDev's buffer holds chunks that already end with a newline, but a list of bare lines is just
    // as reasonable a thing to pass. Joining with "" merged the second shape into one enormous line,
    // so every entry is terminated before the join.
    const text = Array.isArray(lines)
        ? lines.map((line) => {
            const value = String(line ?? "");
            return value.endsWith("\n") ? value : value + "\n";
        }).join("")
        : String(lines ?? "");
    // safeScalar per line, not stripAnsi alone. The first version only removed colour codes, which
    // left every path in the console fully qualified - and the console is the section most likely to
    // carry one, because that is where the loader and the pack print where they are working.
    const all = text.split("\n").map((line) => safeScalar(line)).filter(Boolean);
    if (all.length <= maxLines) return all;
    return [`... ${all.length - maxLines} earlier line(s) ...`, ...all.slice(-maxLines)];
}

/**
 * What LiveDev itself has been doing, which matters because half of all errors on this machine were
 * caused by a reload that did not finish.
 */
function compactReloads(reloadHistory, health) {
    const result = {};
    const history = Array.isArray(reloadHistory) ? reloadHistory
        : Array.isArray(reloadHistory?.history) ? reloadHistory.history : [];
    if (history.length) result.recent = safeList(history.slice(-5), 5);
    if (health && typeof health === "object") {
        result.watched_modules = Number(health.watchedModules) || 0;
        result.routes = Number(health.routes) || 0;
        result.sys_modules = Number(health.sysModules) || 0;
        result.watch_paused = Boolean(health.watchPaused);
        result.memory_mb = Number(health.memMb) || 0;
        result.cache_keys = Number(health.cacheKeys) || 0;
        if (health.lastReloads) result.last_reloads = safeList(health.lastReloads.slice(-5), 5);
    }
    return Object.keys(result).length ? result : null;
}

export function compactGpu(stats) {
    if (!stats || typeof stats !== "object") return null;
    return {
        cpu_percent: Number(stats.cpu_percent) || 0,
        gpu_percent: Number(stats.gpu_percent) || 0,
        gpu_temp_c: Number(stats.gpu_temp) || 0,
        vram_used_mb: Number(stats.vram_used) || 0,
        vram_total_mb: Number(stats.vram_total) || 0,
    };
}

/**
 * Python module names that more than one installed pack defines.
 *
 * A duplicate is not cosmetic. A pack that puts its folder on sys.path makes its files importable by
 * bare name, so whichever pack was imported last wins - and a caller in one pack can end up running
 * another pack's function with a different signature. The result is a TypeError naming a pack that
 * was never at fault. loaded_from is the field that answers it.
 */
export function compactConflicts(payload) {
    const conflicts = payload?.conflicts;
    if (!conflicts || typeof conflicts !== "object") return null;
    const entries = Object.entries(conflicts);
    if (!entries.length) return null;
    return entries
        .sort((a, b) => (b[1]?.defined_in?.length || 0) - (a[1]?.defined_in?.length || 0))
        .slice(0, 40)
        .map(([name, info]) => ({
            module: safeScalar(name, 120),
            defined_in: (info?.defined_in || []).map((path) => safeScalar(path, 200)),
            loaded_from: safeScalar(info?.loaded_from, 200) || null,
        }));
}

/**
 * A node's widgets as name/value pairs rather than the positional array.
 *
 * ComfyUI stores widgets_values as a list, and the names live beside it. A report that shows
 * `["", "", "ComfyUI", "all", "auto"]` makes the reader count positions; `{provider: "ComfyUI",
 * family: "all"}` does not. Anything whose name says it holds a credential is replaced without
 * looking at the value, which is the only way to catch a key that is short or oddly shaped.
 */
function readWidgets(node) {
    const out = {};
    for (const widget of node?.widgets || []) {
        if (widget?.serialize === false) continue;
        const name = String(widget?.name || "");
        if (!name) continue;
        out[name] = isSensitiveWidgetName(name) ? "***" : safeValue(widget.value);
    }
    return out;
}

/**
 * The graph, in the shape a report can use.
 *
 * Every node is listed, because knowing which nodes were muted or bypassed is often the whole answer
 * - a bypassed node silently does nothing. Only the failing node carries its widgets: the full set
 * for every node would be the largest part of the report and the least useful.
 */
function compactWorkflow(failingNodeId) {
    const graph = app.canvas?.graph || app.graph;
    const nodes = Array.isArray(graph?._nodes) ? graph._nodes : null;
    if (!nodes) return null;

    const wanted = String(failingNodeId ?? "");
    return {
        nodes: nodes.map((node) => {
            const entry = {
                id: node?.id,
                type: safeScalar(node?.type, 80),
                mode: Number(node?.mode) || 0,
            };
            const title = safeScalar(node?.title, 80);
            if (title && title !== entry.type) entry.title = title;
            if (wanted && String(node?.id) === wanted) entry.widgets = readWidgets(node);
            return entry;
        }),
        links: Object.keys(graph?.links || {}).length,
    };
}

/**
 * The whole report.
 *
 * The fetches run together rather than in sequence, and a failure in any one of them costs only that
 * section.
 */
export async function buildReport({ error = null, extra = null } = {}) {
    const [systemStats, queue, history, consoleLines, reloadHistory, health, stats, moduleConflicts] =
        await Promise.all([
            fetchOptional("/system_stats"),
            fetchOptional("/queue"),
            fetchOptional("/history?max_items=10"),
            fetchOptional("/livedev/console"),
            fetchOptional("/livedev/reload_history"),
            fetchOptional("/livedev/health"),
            fetchOptional("/livedev/stats"),
            fetchOptional("/livedev/module_conflicts"),
        ]);

    const cleaned = error ? sanitizeError(error) : null;

    // Learn the install root from the whole payload before anything is shortened.
    //
    // sanitizeError only sees the error, and an error alone frequently has no custom_nodes path in it
    // - "File D:\ComfyUI\ComfyUI\execution.py" names no pack, so there is nothing to learn from and
    // the path survives. The console and the workflow almost always name one, so they are searched
    // too, and then every section is shortened with the same knowledge.
    resetLearnedRoot();
    learnRootDeep(error);
    learnRootDeep(consoleLines);
    learnRootDeep(history);
    learnRootDeep(reloadHistory);
    learnRootDeep(health);
    learnRootDeep(moduleConflicts);

    return {
        generated_at: new Date().toISOString(),
        error: cleaned ? sanitizeError(error) : null,
        system: compactSystem(systemStats),
        load: compactGpu(stats),
        queue: compactQueue(queue),
        history_errors: compactHistoryErrors(history),
        console: compactConsole(consoleLines?.lines),
        livedev: compactReloads(reloadHistory, health),
        conflicts: compactConflicts(moduleConflicts),
        workflow: compactWorkflow(cleaned?.node_id),
        frontend: {
            origin: safeScalar(window.location?.origin, 60),
            language: safeScalar(navigator?.language, 20),
        },
        extra: extra ? safeScalar(extra, 400) : null,
    };
}

/**
 * The report as Markdown, which is what an assistant reads best.
 *
 * The console and the workflow go inside <details> so the report stays scannable when it is long,
 * and every section is dropped when it is empty rather than printed as "null".
 */
/**
 * The failure in the few lines that explain it.
 *
 * The panel used to open on the whole report - console output, the workflow, the system figures - and
 * the one question a reader has is what broke, where, and which pack. Those three answer it; everything
 * else is evidence and is one click below. The same lines lead the Markdown, because the assistant
 * that reads the report has the same question.
 */
export function reportSummary(report) {
    if (!report) return ["No report could be built."];
    const lines = [];
    const err = report.error;
    if (!err) {
        lines.push("Nothing has failed in this session.");
    } else {
        const detail = String(err.message || "").split("\n")[0].trim().slice(0, 180);
        lines.push(`What: ${err.exception_type || "error"}${detail ? " - " + detail : ""}`);
        const where = [err.node_id ? `node ${err.node_id}` : "",
                       err.input_name ? `input "${err.input_name}"` : ""].filter(Boolean).join(", ");
        if (where) lines.push(`Where: ${where}`);
    }
    const packs = [...failingPacks(report)];
    lines.push(`Packs: ${packs.length ? packs.join(", ") : "none named in the traceback"}`);
    return lines;
}

export function formatReportMarkdown(report) {
    if (!report || typeof report !== "object") return "";
    const out = ["# ComfyUI error report", ""];

    // The reason first. Everything below it is evidence, and it used to bury the answer.
    out.push("## Summary", "");
    out.push(...reportSummary(report).map((line) => `- ${line}`));
    out.push("");

    const error = report.error;
    if (error) {
        out.push("## Error", "");
        out.push(`- **where**: \`${error.where}\``);
        if (error.node_id) out.push(`- **node id**: \`${error.node_id}\``);
        out.push(`- **type**: \`${error.exception_type}\``);
        if (error.input_name) out.push(`- **input**: \`${error.input_name}\``);
        out.push("");
        out.push("```");
        out.push(error.message || "(no message)");
        out.push("```");
        if (Array.isArray(error.traceback) && error.traceback.length) {
            out.push("");
            out.push("<details><summary>traceback</summary>");
            out.push("");
            out.push("```");
            out.push(...error.traceback);
            out.push("```");
            out.push("");
            out.push("</details>");
        }
        out.push("");
    }

    const system = report.system;
    if (system) {
        out.push("## Environment", "");
        out.push("| | |");
        out.push("|---|---|");
        for (const [label, value] of [
            ["ComfyUI", system.comfyui], ["Python", system.python],
            ["PyTorch", system.pytorch], ["OS", system.os],
            ["RAM", `${system.ram_free_gb} GB free of ${system.ram_total_gb} GB`],
        ]) {
            if (value) out.push(`| ${label} | ${value} |`);
        }
        for (const device of system.devices || []) {
            out.push(`| GPU | ${device.name} |`);
            out.push(`| VRAM | ${device.vram_free_gb} GB free of ${device.vram_total_gb} GB` +
                     ` (torch sees ${device.torch_vram_free_gb} GB free) |`);
        }
        out.push("");
    }

    if (report.load) {
        const load = report.load;
        out.push("## Load at the time", "");
        out.push(`CPU ${load.cpu_percent}% · GPU ${load.gpu_percent}% · ` +
                 `${load.gpu_temp_c}°C · VRAM ${load.vram_used_mb}/${load.vram_total_mb} MB`);
        out.push("");
    }

    if (report.queue) {
        out.push(`**Queue**: ${report.queue.running} running, ${report.queue.pending} pending`);
        out.push("");
    }

    if (Array.isArray(report.history_errors) && report.history_errors.length) {
        out.push("## Earlier errors in this session", "");
        for (const item of report.history_errors) {
            out.push(`- \`${item.exception_type}\` in \`${item.where}\`: ${item.message}`);
        }
        out.push("");
    }

    if (report.livedev) {
        const l = report.livedev;
        out.push("## LiveDev", "");
        out.push(`watched ${l.watched_modules} modules · ${l.routes} routes · ` +
                 `${l.sys_modules} sys.modules · ${l.memory_mb} MB · watch ` +
                 `${l.watch_paused ? "paused" : "on"}`);
        if (Array.isArray(l.recent) && l.recent.length) {
            out.push("");
            out.push("```");
            out.push(...l.recent);
            out.push("```");
        }
        out.push("");
    }

    if (Array.isArray(report.conflicts) && report.conflicts.length) {
        out.push("## Module name conflicts", "");
        out.push(`${report.conflicts.length} Python module names are defined by more than one ` +
                 `installed pack. Whichever was imported last wins, so a caller in one pack can run ` +
                 `another pack's function.`);
        out.push("");
        for (const c of report.conflicts) {
            out.push(`- \`${c.module}\` — ${c.defined_in.length} packs` +
                     (c.loaded_from ? ` · loaded: \`${c.loaded_from}\`` : " · not loaded"));
            for (const path of c.defined_in) out.push(`    - ${path}`);
        }
        out.push("");
    }

    if (Array.isArray(report.console) && report.console.length) {
        out.push("## Console (tail)", "");
        out.push("<details><summary>show</summary>");
        out.push("");
        out.push("```");
        out.push(...report.console);
        out.push("```");
        out.push("");
        out.push("</details>");
        out.push("");
    }

    if (report.workflow) {
        out.push("## Workflow", "");
        // The counts are printed rather than a legend of what each mode number means. A legend reads
        // as a count - "2 muted, 4 bypassed" was understood as "two nodes are muted" when it only
        // said which number means muted - and the number a reader wants is how many there are.
        const counts = { active: 0, muted: 0, bypassed: 0, other: 0 };
        for (const node of report.workflow.nodes) {
            if (node.mode === 2) counts.muted += 1;
            else if (node.mode === 4) counts.bypassed += 1;
            else if (node.mode === 0) counts.active += 1;
            else counts.other += 1;
        }
        out.push(`${report.workflow.nodes.length} nodes, ${report.workflow.links} links. ` +
                 `${counts.active} active, ${counts.muted} muted, ${counts.bypassed} bypassed` +
                 (counts.other ? `, ${counts.other} in another mode` : "") + ".");
        out.push("");
        out.push("```");
        for (const node of report.workflow.nodes) {
            const name = node.title ? `${node.type} "${node.title}"` : node.type;
            out.push(`#${node.id} ${name} (mode ${node.mode})`);
            for (const [key, value] of Object.entries(node.widgets || {})) {
                out.push(`    ${key}: ${value}`);
            }
        }
        out.push("```");
        out.push("");
    }

    if (report.frontend?.origin) {
        out.push(`_Generated ${report.generated_at} from ${report.frontend.origin} ` +
                 `(${report.frontend.language})_`);
        out.push("");
    }

    return out.join("\n");
}

// ------------------------------------------------------------------------------------------- ui

/**
 * Copies text, trying three ways in order.
 *
 * ComfyUI is served from localhost, which is a secure context, so the modern clipboard API is
 * normally available and is tried first. It still fails when the document is not focused or when the
 * permission is denied, so the deprecated command is tried next, and when both fail the caller is
 * told - there is no point pretending the text is on the clipboard when it is not. The manual route
 * is a textarea with the text already selected, which is what makes Ctrl+C work.
 */
export async function copyText(text) {
    const value = String(text ?? "");

    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
            return "clipboard";
        }
    } catch (error) {
        // Denied, unfocused, or an older browser. Try the next way.
    }

    try {
        const area = document.createElement("textarea");
        area.value = value;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.top = "-1000px";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        area.setSelectionRange(0, value.length);
        const ok = document.execCommand ? document.execCommand("copy") === true : false;
        area.remove();
        if (ok) return "execCommand";
    } catch (error) {
        // Fall through to the manual route.
    }

    return null;
}

export function downloadText(text, filename) {
    const blob = new Blob([String(text ?? "")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function stamp() {
    return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/**
 * The fallback when both clipboard routes are refused: the text, selected, in a box.
 *
 * Selected rather than merely shown, because the whole point is that Ctrl+C should work. A Save
 * button sits beside it for the case where even that is awkward.
 */
function showManualCopy(body, text, filename) {
    body.querySelector(".livedev-report-manual")?.remove();

    const wrap = h("div", { class: "livedev-report-manual", style: { marginTop: "8px", flexShrink: "0" } });
    wrap.append(h("div", { style: { color: "#e57373", marginBottom: "4px" } },
        "The clipboard was refused. The text below is selected - press Ctrl+C, or save it."));

    const area = h("textarea", {
        style: {
            width: "100%", height: "150px", background: "#0d0d0d", color: "#ddd",
            border: "1px solid #444", borderRadius: "6px", padding: "6px",
            fontFamily: "monospace", fontSize: "1em", whiteSpace: "pre", overflow: "auto",
        },
    });
    area.value = text;

    const save = h("button", { style: BTN, html: "Save .md" });
    save.onclick = () => downloadText(text, filename);

    wrap.append(area, save);
    body.appendChild(wrap);
    area.focus();
    area.select();
}

/**
 * The report panel.
 *
 * Two flavours, because the two jobs need different things. "Copy for AI" is the Markdown, which
 * reads well and is already sanitised; "Copy raw JSON" is everything, for someone debugging the
 * report itself. The preview shows exactly what will be copied rather than a summary of it, so
 * nothing leaves without being seen first.
 */
// The cyan ProStudio uses for its own name, applied here to the pack names a report turns up. Two
// shapes carry one: the folder after custom_nodes in a path, which is what a traceback, the console
// and the error location all produce, and the first segment of a conflict's relative path, which is
// what /livedev/module_conflicts reports. Colouring them is what makes a long traceback scannable.
const CYAN = "#38c0c4";
const RED = "#e57373";
const PACK_IN_PATH = /(custom_nodes[\\/])([^\\/\s"'()[\],;]+)/g;
const PACK_IN_LIST = /^(\s*-\s+)([A-Za-z0-9_.-]+)([\\/])/;

function packRanges(line) {
    const ranges = [];
    PACK_IN_PATH.lastIndex = 0;
    let match;
    while ((match = PACK_IN_PATH.exec(line))) {
        const start = match.index + match[1].length;
        ranges.push([start, start + match[2].length]);
    }
    const listed = PACK_IN_LIST.exec(line);
    if (listed && !ranges.length) {
        const start = listed[1].length;
        ranges.push([start, start + listed[2].length]);
    }
    return ranges;
}

/**
 * The packs the report says are broken.
 *
 * Three places name one. The current error carries the failing pack in its location and its
 * traceback. A history error is the same thing for a run that has already finished. And the console
 * carries the packs that never loaded at all: ComfyUI prints the traceback for an import failure and
 * then carries on, so a frame line naming a pack is the only trace an unloaded pack leaves.
 *
 * A frame line is what makes this reliable - an ordinary log line may mention a path, but only a
 * traceback prints `  File "..."`.
 */
function failingPacks(report) {
    const found = new Set();
    // Walks the raw values, not `JSON.stringify`: that escapes every backslash, so the string the
    // pattern sees is `custom_nodes\\Pack\\file.py` and the pattern - which is written for real paths -
    // never matches. `learnRootDeep` above says the same thing for the same reason; this function was
    // the one place that still stringified, which is why it always answered "no pack named".
    const scan = (value, depth = 0) => {
        if (depth > 8) return;
        if (typeof value === "string") {
            const re = new RegExp(PACK_IN_PATH.source, "g");
            let match;
            while ((match = re.exec(value))) found.add(match[2]);
            return;
        }
        if (Array.isArray(value)) {
            for (const item of value) scan(item, depth + 1);
            return;
        }
        if (value && typeof value === "object") {
            for (const item of Object.values(value)) scan(item, depth + 1);
        }
    };
    scan(report?.error);
    scan(report?.history_errors);
    for (const line of report?.console || []) {
        if (/^\s*File "/.test(line)) scan(line);
    }
    return found;
}

function appendLine(parent, line, failing) {
    let at = 0;
    for (const [start, end] of packRanges(line)) {
        if (start > at) parent.appendChild(document.createTextNode(line.slice(at, start)));
        const name = line.slice(start, end);
        parent.appendChild(h("span", {
            style: { color: failing.has(name) ? RED : CYAN, fontWeight: "bold" },
        }, name));
        at = end;
    }
    parent.appendChild(document.createTextNode(line.slice(at)));
}

export async function openReportPanel(error = null) {
    // Called with nothing - from the menu, where there is no error in hand - it falls back to the
    // last failure, so the entry still opens the report that was actually generated.
    if (!error) error = _lastError;
    let markdown = "";
    let json = "";
    let report = null;

    try {
        report = await buildReport({ error });
        markdown = formatReportMarkdown(report);
        json = JSON.stringify(report, null, 2);
    } catch (buildError) {
        markdown = `# ComfyUI error report\n\nBuilding the report failed: ${buildError}`;
        json = markdown;
    }

    const filename = `comfyui-error-${stamp()}.md`;

    makePanel("Error Report", (body) => {
        // One place sets the size for everything inside. The buttons carry their own font size in the
        // shared BTN style, so they are overridden where they are built rather than here.
        body.style.fontSize = "15px";
        const bar = h("div", {
            style: { display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "6px", flexShrink: "0" },
        });

        const copyMd = h("button", { style: { ...BTN_GREEN, fontSize: "1em" }, html: "Copy for AI" });
        copyMd.onclick = async () => {
            const how = await copyText(markdown);
            if (how) showToast(`[LiveDev] report copied (${how})`);
            else showManualCopy(body, markdown, filename);
        };

        const copyJson = h("button", { style: { ...BTN, fontSize: "1em" }, html: "Copy raw JSON" });
        copyJson.onclick = async () => {
            const how = await copyText(json);
            if (how) showToast(`[LiveDev] raw report copied (${how})`);
            else showManualCopy(body, json, filename.replace(/\.md$/, ".json"));
        };

        const save = h("button", { style: { ...BTN, fontSize: "1em" }, html: "Save .md" });
        save.onclick = () => {
            downloadText(markdown, filename);
            showToast("[LiveDev] report saved");
        };

        bar.append(copyMd, copyJson, save);
        body.appendChild(bar);

        body.appendChild(h("div", {
            style: { color: "#8a8a8a", fontSize: "0.85em", marginBottom: "8px", flexShrink: "0" },
        }, "Tokens and keys are replaced, and paths are shortened to <COMFY>, <HOME> and <SITE>. " +
           "A pack in cyan loaded; a pack in red failed, or never loaded at all."));

        // The three lines that answer "what broke", before anything else. The full report is evidence
        // for that answer, so it sits behind a fold rather than in front of it.
        const summary = h("div", {
            style: {
                flexShrink: "0", marginBottom: "8px", padding: "8px 10px", background: "#141414",
                border: "1px solid #333", borderRadius: "6px", fontFamily: "monospace",
                fontSize: "0.85em", lineHeight: "1.5", whiteSpace: "pre-wrap", wordBreak: "break-word",
            },
        });
        for (const line of reportSummary(report)) {
            const row = h("div");
            row.appendChild(document.createTextNode(line));
            summary.appendChild(row);
        }
        body.appendChild(summary);

        const detail = h("details", {
            style: { flex: "1", display: "flex", flexDirection: "column", minHeight: "0" },
        });
        detail.appendChild(h("summary", {
            style: { cursor: "pointer", color: "#aaa", fontSize: "0.85em", marginBottom: "6px", flexShrink: "0" },
        }, "Full report"));

        const preview = h("div", {
            style: {
                flex: "1", overflow: "auto", background: "#0d0d0d", border: "1px solid #333",
                borderRadius: "6px", padding: "8px", whiteSpace: "pre-wrap", wordBreak: "break-word",
                minHeight: "240px", lineHeight: "1.5",
            },
        });
        const failing = failingPacks(report);
        // One element per line, so the headings can be coloured and found while scrolling a long
        // report. Each line is a text node and never innerHTML: the report quotes server output and
        // stack traces, and either can contain angle brackets.
        for (const line of markdown.split("\n")) {
            const heading = /^#{1,6} /.test(line);
            const row = h("div", {
                style: heading ? { color: "#38c0c4", fontWeight: "bold" } : null,
            });
            if (heading || !line) row.appendChild(document.createTextNode(line || "\u00a0"));
            else appendLine(row, line, failing);
            preview.appendChild(row);
        }
        detail.appendChild(preview);
        body.appendChild(detail);
    }, () => {});
}

// ------------------------------------------------------------------------------------- lifecycle

// How long a card is guaranteed to stay up. A retry that succeeds in 300 ms would otherwise make the
// card appear and vanish faster than it can be read, which looks like a glitch rather than a report.
const STICKY_MS = 8000;

// The last failure, kept after its card comes down. A card is a notification and is meant to
// disappear, but the menu entry is a way back to the failure, so it cannot depend on the card still
// being on screen. Every error arrives through one place - the lifecycle's raise - so one assignment
// there is enough to catch all of them.
function lsGet(key, fallback) {
    try {
        const value = localStorage.getItem("livedev_" + key);
        return value != null ? JSON.parse(value) : fallback;
    } catch (e) {
        return fallback;
    }
}

let _lastError = null;

export function lastError() {
    return _lastError;
}

/**
 * When an error is shown and when it comes down.
 *
 * Five states, and the transitions are where the difficulty is:
 *
 *   IDLE            nothing is shown
 *   RAISED          a card is up
 *   STICKY          a card is up and will not come down yet
 *   RUNNING_AFTER   a run started after the error; its result decides
 *   DISMISSED       the user closed it, and the same failure must not reopen it
 *
 * Two traps make the obvious version wrong, and both are guarded here:
 *
 *   1. A run that was already queued when the error happened finishes afterwards. Its success says
 *      nothing about the failure, so it must not clear the card - only a run whose prompt_id was
 *      seen in execution_start *after* the error counts. Clearing on any success was the bug that
 *      made the card disappear while the failure was still on screen.
 *   2. A success inside the sticky window is remembered rather than acted on, and the card comes
 *      down when the window closes. Acting at once is what makes it flicker.
 *
 * A generation counter guards the timer: a newer error bumps it, and the older timer sees the change
 * and does nothing rather than clearing a card that belongs to a different failure.
 */
export function createErrorLifecycle({ show, hide, stickyMs = STICKY_MS }) {
    let state = "IDLE";
    let generation = 0;
    let current = null;
    let startedPromptId = "";
    let stickyTimer = null;
    let stickyUntil = 0;
    let pendingClear = false;
    const dismissed = new Set();

    function signatureOf(id, detail) {
        const type = detail?.exception_type || detail?.type || "Error";
        const message = String(detail?.exception_message || detail?.message || "").slice(0, 80);
        return `${id}|${type}|${message}`;
    }

    function stopTimer() {
        if (stickyTimer) clearTimeout(stickyTimer);
        stickyTimer = null;
    }

    function reset() {
        generation += 1;
        stopTimer();
        pendingClear = false;
        const gone = current;
        // Cleared before the hide is asked for, so the dismiss callback that fires on the way out
        // sees no current error and treats it as its own.
        current = null;
        startedPromptId = "";
        stickyUntil = 0;
        state = "IDLE";
        if (gone) hide(gone.id);
    }

    function raise(id, detail) {
        const signature = signatureOf(id, detail);

        // Closed by hand and the same failure again: leave it closed. A different failure opens.
        if (state === "DISMISSED" && dismissed.has(signature)) return;

        if (current && String(current.id) !== String(id)) hide(current.id);

        current = { id, detail, signature };
        // "Keep Last Error" off means the Report panel has nothing to open after the card is gone.
        if (lsGet("keepLastError", true)) _lastError = { id, detail };
        dismissed.delete(signature);
        startedPromptId = "";
        pendingClear = false;
        stickyUntil = Date.now() + stickyMs;
        state = "STICKY";
        show(id, detail);

        const mine = ++generation;
        stopTimer();
        stickyTimer = setTimeout(() => {
            if (generation !== mine) return;   // a newer error took over
            state = "RAISED";
            if (pendingClear) reset();
        }, stickyMs);
    }

    return {
        get state() { return state; },
        get current() { return current; },
        get dismissed() { return dismissed; },

        raise,
        reset,

        started(detail) {
            if (!current) return;
            const promptId = String(detail?.prompt_id ?? "");
            if (!promptId) return;
            startedPromptId = promptId;
            state = "RUNNING_AFTER";
        },

        succeeded(detail) {
            if (!current) return;
            const promptId = String(detail?.prompt_id ?? "");
            if (!startedPromptId || promptId !== startedPromptId) return;   // trap 1
            if (Date.now() < stickyUntil) {                                 // trap 2
                // The outcome is decided; only the window is left. Saying so in the state matters,
                // because a later failure must not be read as "the run that was going to clear it
                // failed" when the clear is already pending.
                pendingClear = true;
                state = "STICKY";
                return;
            }
            reset();
        },

        failed() {
            if (state === "RUNNING_AFTER") state = "RAISED";
        },

        reconnecting() {
            // The server is going away. The card stays: the reason for it has not changed.
        },

        reconnected() {
            // The server restarted, so whatever the card described is gone with it.
            reset();
        },

        dismiss(id) {
            if (!current || String(current.id) !== String(id)) return;
            dismissed.add(current.signature);
            generation += 1;
            stopTimer();
            current = null;
            startedPromptId = "";
            pendingClear = false;
            state = "DISMISSED";
        },
    };
}

/**
 * Catches the errors that never reach execution.
 *
 * A prompt that fails validation is rejected by /prompt before anything runs, and the reply carries
 * node_errors. Nothing on that path raises execution_error, so the card never appeared for it - which
 * is the wrong way round, because an un-downloaded model or a widget left empty is far more common
 * than a crash inside a node.
 *
 * api.queuePrompt throws PromptExecutionError with the parsed body on .response, so the body is read
 * from there. The re-throw is deliberate: this only observes, and swallowing would leave the caller
 * believing the prompt was queued.
 */
export function watchPromptValidation(onFailure) {
    if (typeof api?.queuePrompt !== "function") return false;
    if (api.queuePrompt.__livedevWatched) return true;

    const original = api.queuePrompt.bind(api);
    api.queuePrompt = async function (...args) {
        try {
            return await original(...args);
        } catch (error) {
            try {
                const body = error?.response || error?.detail || null;
                if (body && (body.node_errors || body.error)) onFailure(body);
            } catch (readError) {
                console.warn("[LiveDev] could not read a prompt failure:", readError);
            }
            throw error;
        }
    };
    api.queuePrompt.__livedevWatched = true;
    return true;
}

/**
 * The lifecycle, which cannot be checked synchronously: the sticky window is a timer, and the point
 * of it is what happens while it is running.
 */
export async function lifecycleTest() {
    const failures = [];
    const check = (label, actual, expected) => {
        if (String(actual) !== String(expected)) {
            failures.push(`${label}\n      expected: ${expected}\n      actual:   ${actual}`);
        }
    };

    const shown = [];
    const hidden = [];
    const build = (stickyMs) => createErrorLifecycle({
        show: (id) => shown.push(id),
        hide: (id) => hidden.push(id),
        stickyMs,
    });

    const fail = (id) => ({ node_id: id, exception_type: "TypeError", message: "boom" });

    // An error that a run already in the queue finishes after must survive that run's success.
    {
        const life = build(0);
        life.raise("5", fail("5"));
        life.succeeded({ prompt_id: "old-run" });
        check("a success with no matching start does not clear", life.state, "STICKY");
    }

    // A run that started after the error does clear it, once the sticky window has passed.
    {
        const life = build(0);
        life.raise("5", fail("5"));
        life.started({ prompt_id: "new-run" });
        life.succeeded({ prompt_id: "new-run" });
        check("a success from the run after the error clears", life.state, "IDLE");
        check("and the card was taken down", hidden.join(","), "5");
    }

    // Inside the sticky window the clear is remembered, not acted on, and happens when it closes.
    {
        const life = build(40);
        life.raise("5", fail("5"));
        life.started({ prompt_id: "new-run" });
        life.succeeded({ prompt_id: "new-run" });
        check("a fast success is deferred", life.state, "STICKY");
        await new Promise((resolve) => setTimeout(resolve, 90));
        check("and then applied", life.state, "IDLE");
    }

    // Closing the card by hand, then the same failure again: it stays closed.
    {
        const life = build(0);
        life.raise("5", fail("5"));
        life.dismiss("5");
        shown.length = 0;
        life.raise("5", fail("5"));
        check("a dismissed failure does not reopen", shown.length, 0);
        check("and the state says so", life.state, "DISMISSED");
    }

    // A different failure opens again, which is the whole point of tracking the signature.
    {
        const life = build(0);
        life.raise("5", fail("5"));
        life.dismiss("5");
        shown.length = 0;
        life.raise("5", { node_id: "5", exception_type: "ValueError", message: "other" });
        check("a different failure does reopen", shown.length, 1);
    }

    // A restarted server takes the card with it.
    {
        const life = build(0);
        life.raise("5", fail("5"));
        life.reconnected();
        check("a reconnect clears", life.state, "IDLE");
    }

    return { total: 7, failed: failures.length, failures };
}

// ------------------------------------------------------------------------------------- self-test

/**
 * Runs at load. A sanitiser that silently stops matching is worse than none, because the report
 * looks clean while carrying the user name - so the check is automatic rather than something to
 * remember to run.
 */
export function selfTest() {
    resetLearnedRoot();

    // Learn-then-shorten: the frame that arrives before the custom_nodes path must be shortened too,
    // which is the whole reason the root is learned rather than matched per string.
    const learned = sanitizeError({
        traceback: [
            'File "D:\\ComfyUI\\ComfyUI\\execution.py", line 1, in a',
            'File "D:\\ComfyUI\\ComfyUI\\custom_nodes\\Pack\\x.py", line 2, in b',
        ],
    }).traceback[0];
    resetLearnedRoot();

    const cases = [
        ["collapse runs of whitespace",
            safeScalar("  a\n\n\t b  "), "a b"],
        ["truncate at the limit",
            safeScalar("x".repeat(1200)).length, MAX_TEXT + 3],
        ["keep the end of a list",
            safeList([1, 2, 3, 4, 5], 3).join(","), "3,4,5"],
        ["redact a huggingface token",
            safeScalar("token is hf_abcdefghijklmnopqrstuvwxyz here"), "token is hf_*** here"],
        ["redact a bearer header",
            safeScalar("Authorization: Bearer abcdefghijklmnopqrst"), "Authorization: Bearer ***"],
        ["redact an openai key",
            safeScalar("sk-abcdefghijklmnopqrstuvwx"), "sk-***"],
        ["redact a jwt",
            safeScalar("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij"), "<jwt>"],
        ["shorten the windows profile",
            shortenPaths("C:\\Users\\Alice\\.cache\\huggingface"), "<HOME>\\.cache\\huggingface"],
        ["shorten a custom node path",
            shortenPaths("D:\\ComfyUI\\ComfyUI\\custom_nodes\\ComfyUI-LiveDev\\web\\a.js"),
            "<COMFY>\\custom_nodes\\ComfyUI-LiveDev\\web\\a.js"],
        ["shorten a site-packages path",
            shortenPaths("D:\\ComfyUI\\python_embeded\\Lib\\site-packages\\torch\\nn\\a.py"),
            "<SITE>\\torch\\nn\\a.py"],
        ["shorten a model path",
            shortenPaths("D:\\ComfyUI\\ComfyUI\\models\\Gemma\\gemma-4-E2B-it"),
            "<COMFY>\\models\\Gemma\\gemma-4-E2B-it"],
        ["keep the end of a traceback",
            compactTraceback(["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9",
                              "f10", "f11", "f12", "f13", "f14", "f15", "f16", "f17", "f18"], 4)
                .slice(-1)[0], "f18"],
        ["name a validation failure",
            sanitizeError({ node_errors: { "198": { class_type: "ProStudioLocalLLM",
                errors: [{ type: "value_not_in_list", message: "Value not in list: model",
                           extra_info: { input_name: "model" } }] } } }).input_name, "model"],
        ["hide a key by widget name",
            sanitizeWidgetValues(["hello", "hf_abcdefghijklmnopqrstuvwxyz"],
                                 ["prompt", "api_key"]).join(","), "hello,***"],
        ["learn the install root and use it everywhere",
            learned, 'File "<COMFY>\\execution.py", line 1, in a'],

        // The error alone names no pack, so the root can only come from another section. This is the
        // order buildReport relies on, and without it a traceback of ComfyUI's own frames stayed
        // fully qualified while the frames inside a pack were shortened.
        ["learn the root from a different section",
            (() => {
                resetLearnedRoot();
                learnRootDeep(["watching D:\\ComfyUI\\ComfyUI\\custom_nodes\\Pack"]);
                const value = sanitizeError({
                    traceback: ['File "D:\\ComfyUI\\ComfyUI\\execution.py", line 1, in a'],
                }).traceback[0];
                resetLearnedRoot();
                return value;
            })(), 'File "<COMFY>\\execution.py", line 1, in a'],

        // --- report side ---
        ["strip colour codes from the console",
            compactConsole(["\u001b[91m[LiveDev] boom\u001b[0m\r\n"]).join("|"), "[LiveDev] boom"],
        ["shorten paths in the console too",
            (() => {
                resetLearnedRoot();
                learnRootDeep(["D:\\ComfyUI\\ComfyUI\\custom_nodes\\Pack"]);
                const value = compactConsole(
                    ["working in D:\\ComfyUI\\ComfyUI\\custom_nodes\\Pack\\x.py"]
                )[0];
                resetLearnedRoot();
                return value;
            })(), "working in <COMFY>\\custom_nodes\\Pack\\x.py"],
        ["keep the tail of a long console",
            compactConsole(Array.from({ length: 300 }, (_, i) => `line ${i}`), 10).slice(-1)[0],
            "line 299"],
        ["name the earlier errors",
            compactHistoryErrors({ abc: { status: { messages: [
                ["execution_start", {}],
                ["execution_error", { node_id: "5", exception_type: "ValueError",
                                      exception_message: "nope" }],
            ] } } })[0].exception_type, "ValueError"],
        ["keep the three vram numbers apart",
            compactSystem({ system: { comfyui_version: "0.37.1" },
                devices: [{ name: "RTX", vram_free: 8589934592,
                            torch_vram_free: 123191296 }] }).devices[0].torch_vram_free_gb, "0.1"],
        ["keep a widget number a number",
            safeValue(2048), 2048],
        ["markdown names the failing input",
            formatReportMarkdown({ error: { where: "X", node_id: "1", exception_type: "E",
                message: "m", input_name: "model" } }).includes("**input**: `model`"), true],
        ["markdown survives an empty report",
            formatReportMarkdown({}).startsWith("# ComfyUI error report"), true],
        ["a module conflict names the pack that won",
            compactConflicts({ conflicts: { a: { defined_in: ["p/a.py", "q/a.py", "r/a.py"],
                loaded_from: "q/a.py" } } })[0].loaded_from, "q/a.py"],
        ["module conflicts sort by how many packs share the name",
            compactConflicts({ conflicts: {
                a: { defined_in: ["p/a.py", "q/a.py"] },
                b: { defined_in: ["p/b.py", "q/b.py", "r/b.py"] } } })[0].module, "b"],
        ["a conflict nobody imported reports no winner",
            compactConflicts({ conflicts: { a: { defined_in: ["p/a.py", "q/a.py"] } } })[0].loaded_from, null],
        ["no conflicts compacts to nothing",
            compactConflicts({ conflicts: {} }), null],
        ["the conflict section is written when there are conflicts",
            formatReportMarkdown({ conflicts: [{ module: "a", defined_in: ["p/a.py", "q/a.py"],
                loaded_from: "q/a.py" }] }).includes("## Module name conflicts"), true],
        ["the pack behind the error is a failing pack",
            [...failingPacks({ error: { where: "<COMFY>/custom_nodes/Broken/B.py" } })],
            ["Broken"]],
        ["a pack named by a console traceback frame never loaded",
            [...failingPacks({ console: ['  File "<COMFY>/custom_nodes/Unloaded/U.py", line 3'] })],
            ["Unloaded"]],
        ["a pack merely mentioned in the console is not failing",
            [...failingPacks({ console: ["Loading <COMFY>/custom_nodes/Fine/F.py"] })], []],
        ["the workflow line counts modes instead of listing what they mean",
            formatReportMarkdown({ workflow: { links: 3, nodes: [
                { id: 1, type: "A", mode: 0 }, { id: 2, type: "B", mode: 0 },
                { id: 3, type: "C", mode: 4 }, { id: 4, type: "D", mode: 4 },
                { id: 5, type: "E", mode: 4 }] } }).includes("2 active, 0 muted, 3 bypassed."),
            true],
    ];

    const failures = [];
    for (const [label, actual, expected] of cases) {
        if (String(actual) !== String(expected)) {
            failures.push(`${label}\n      expected: ${expected}\n      actual:   ${actual}`);
        }
    }
    resetLearnedRoot();
    return { total: cases.length, failed: failures.length, failures };
}

app.registerExtension({
    name: "LiveDev.ErrorReport",
    async setup() {
        const result = selfTest();
        if (result.failed) {
            // Only a failure is announced: a quiet console is the normal state, and the report
            // button is where a user looks for this.
            console.warn(
                `[LiveDev] error report sanitiser: ${result.failed}/${result.total} checks FAILED`
            );
            for (const line of result.failures) console.warn("[LiveDev]   " + line);
        }

        const checks = await lifecycleTest();
        if (checks.failed) {
            console.warn(`[LiveDev] error lifecycle: ${checks.failed}/${checks.total} FAILED`);
            for (const line of checks.failures) console.warn("[LiveDev]   " + line);
        }

        // A debug hook, and the only thing this file puts on window.
        window.livedevErrorReport = {
            build: buildReport,
            markdown: async (options) => formatReportMarkdown(await buildReport(options)),
            sanitize: sanitizeError,
            open: openReportPanel,
            lastError,
            selfTest,
            lifecycleTest,
        };

        // The card in livedev-toolkit.js knows nothing about reports; it calls whatever is in this
        // list once it has assembled its own buttons, which is how the Report button gets in without
        // that file importing this one.
        ERROR_CARD_HOOKS.push((node, detail, buttons) => {
            const button = h("button", { style: BTN, html: "Report" });
            button.onclick = () => openReportPanel(detail);
            buttons.appendChild(button);
        });

        // The lifecycle replaces the toolkit's own "clear on any success" rule with one that tracks
        // which run the error belonged to.
        const lifecycle = createErrorLifecycle({
            show: (id, detail) => showErrorOverlay(id, detail),
            hide: (id) => clearErrorOverlay(id),
        });
        ERROR_LIFECYCLE.controller = lifecycle;

        // Validation failures never reach execution_error, so they are caught on the way out of
        // /prompt instead. One with no node to attach to has nowhere to put a card, so it is
        // toasted with the message rather than dropped.
        const watching = watchPromptValidation((body) => {
            const cleaned = sanitizeError(body);
            if (cleaned.node_id) {
                lifecycle.raise(cleaned.node_id, cleaned);
            } else {
                showToast(`[LiveDev] prompt rejected: ${cleaned.message}`);
            }
        });
        if (!watching) console.warn("[LiveDev] api.queuePrompt was not found; validation errors " +
                                    "will not be reported");
    },
});
