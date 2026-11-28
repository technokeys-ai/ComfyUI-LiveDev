"""Discovery, metadata extraction, and thumbnail serving for the LiveDev Workflow Gallery.

Scans ComfyUI user workflow directories, blueprints, custom_nodes workflow folders (and nested
subfolders), and installed comfyui_workflow_templates packages. Every discovered workflow is
addressed by an opaque 16-hex SHA1 ID so browser requests never pass raw filesystem paths.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import threading
import time
from typing import Any

import folder_paths

from . import State

_LOCK = threading.Lock()
_CACHE_TTL = 300.0
_CACHE: dict[str, Any] = {"at": 0.0, "entries": {}, "items": [], "counts": {}, "folders": []}
_SVG_CACHE: dict[tuple[str, float], str] = {}
_SVG_CACHE_MAX = 400
_INDEX_CACHE_PATH = os.path.join(State.PACK_ROOT, "workflow_gallery_index.json")

_ID_RE = re.compile(r"^[a-f0-9]{16}$")
_NODE_TYPE_RE = re.compile(r'"type"\s*:\s*"[^"]+"')
_CLASS_TYPE_RE = re.compile(r'"class_type"\s*:\s*"[^"]+"')
_FAST_PARSE_LIMIT = 192 * 1024
_IMAGE_EXTS = (".png", ".webp", ".jpg", ".jpeg", ".gif")
_IMAGE_SUBDIRS = ("images", "previews", "thumbnails", "thumbs", "assets", "media", "preview")
_SKIP_DIRS = frozenset({
    ".git",
    ".github",
    ".venv",
    "venv",
    "__pycache__",
    "node_modules",
    "dist",
    "build",
    "locales",
    "i18n",
    "translations",
    "models",
    "weights",
    "checkpoints",
    ".disabled",
    ".mypy_cache",
    ".pytest_cache",
    "tests",
    "tests-unit",
    "test",
})
_SKIP_JSON_NAMES = frozenset({
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "jsconfig.json",
    "manifest.json",
    "config.json",
    "settings.json",
    "comfy.settings.json",
    "reload_history.json",
    "pyproject.json",
    "composer.json",
    "extension-node-map.json",
    "custom-node-list.json",
    "model-list.json",
    "index.json",
})
_MAX_WORKFLOW_BYTES = 25 * 1024 * 1024
_MAX_CUSTOM_THUMB_BYTES = 5 * 1024 * 1024
_THUMBS_DIR = os.path.join(State.PACK_ROOT, "workflow_thumbs")


def _comfy_root() -> str:
    base = getattr(folder_paths, "base_path", None)
    if base and os.path.isdir(base):
        return os.path.abspath(base)
    return os.path.abspath(os.path.join(State.CUSTOM_NODE_ROOT[0], os.pardir))


def _make_id(key: str) -> str:
    return hashlib.sha1(key.encode("utf-8", errors="ignore")).hexdigest()[:16]


def is_valid_workflow_id(wf_id: str) -> bool:
    return isinstance(wf_id, str) and bool(_ID_RE.match(wf_id))


def _is_workflow_dict(data: Any) -> tuple[bool, int, int, int, bool]:
    """Return (is_workflow, node_count, link_count, group_count, has_subgraphs)."""
    if not isinstance(data, dict):
        return False, 0, 0, 0, False

    nodes_val = data.get("nodes")
    if isinstance(nodes_val, list):
        # Standard LiteGraph / ComfyUI workflow JSON
        has_graph_markers = (
            "last_node_id" in data
            or "links" in data
            or "version" in data
            or "definitions" in data
            or (len(nodes_val) > 0 and isinstance(nodes_val[0], dict) and ("type" in nodes_val[0] or "id" in nodes_val[0]))
        )
        if not has_graph_markers:
            return False, 0, 0, 0, False
        links_val = data.get("links")
        groups_val = data.get("groups")
        defs_val = data.get("definitions")
        subgraphs = defs_val.get("subgraphs") if isinstance(defs_val, dict) else None
        return (
            True,
            len(nodes_val),
            len(links_val) if isinstance(links_val, list) else 0,
            len(groups_val) if isinstance(groups_val, list) else 0,
            bool(isinstance(subgraphs, list) and len(subgraphs) > 0),
        )

    # API prompt format: {"1": {"class_type": "...", "inputs": {...}}, ...}
    if data:
        sample = list(data.values())[:5]
        if sample and all(isinstance(v, dict) and isinstance(v.get("class_type"), str) for v in sample):
            return True, len(data), 0, 0, False

    return False, 0, 0, 0, False


def _load_disk_index() -> dict[str, list[Any]]:
    try:
        if not os.path.isfile(_INDEX_CACHE_PATH):
            return {}
        with open(_INDEX_CACHE_PATH, "r", encoding="utf-8", errors="ignore") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_disk_index(index: dict[str, list[Any]]):
    try:
        tmp = _INDEX_CACHE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(index, fh, separators=(",", ":"))
        os.replace(tmp, _INDEX_CACHE_PATH)
    except Exception:
        pass


def _inspect_workflow_file(
    file_path: str,
    mtime: float,
    fsize: int,
    disk_index: dict[str, list[Any]],
    new_index: dict[str, list[Any]],
) -> tuple[bool, int, int, int, bool]:
    key = os.path.normcase(os.path.abspath(file_path))
    cached = disk_index.get(key)
    if (
        isinstance(cached, list)
        and len(cached) == 7
        and abs(float(cached[0]) - mtime) < 0.01
        and int(cached[1]) == fsize
    ):
        new_index[key] = cached
        return bool(cached[2]), int(cached[3]), int(cached[4]), int(cached[5]), bool(cached[6])

    try:
        if fsize <= 2 or fsize > _MAX_WORKFLOW_BYTES:
            return False, 0, 0, 0, False
        if fsize <= _FAST_PARSE_LIMIT:
            with open(file_path, "r", encoding="utf-8", errors="ignore") as fh:
                data = json.load(fh)
            res = _is_workflow_dict(data)
        else:
            # Fast header sniff for large workflow JSONs so cold scans stay sub-2-second.
            with open(file_path, "r", encoding="utf-8", errors="ignore") as fh:
                head = fh.read(32768)
            has_nodes = '"nodes"' in head and ('"last_node_id"' in head or '"links"' in head or '"version"' in head or '"definitions"' in head)
            if has_nodes:
                with open(file_path, "r", encoding="utf-8", errors="ignore") as fh:
                    text = fh.read()
                n_cnt = len(_NODE_TYPE_RE.findall(text))
                has_sg = '"subgraphs"' in text
                res = (True, n_cnt, 0, 0, has_sg)
            elif '"class_type"' in head:
                with open(file_path, "r", encoding="utf-8", errors="ignore") as fh:
                    text = fh.read()
                n_cnt = len(_CLASS_TYPE_RE.findall(text))
                res = (n_cnt > 0, n_cnt, 0, 0, False)
            else:
                res = (False, 0, 0, 0, False)

        new_index[key] = [round(mtime, 3), fsize, int(res[0]), int(res[1]), int(res[2]), int(res[3]), int(res[4])]
        return res
    except Exception:
        return False, 0, 0, 0, False


def _find_custom_thumb(wf_id: str) -> str | None:
    if not is_valid_workflow_id(wf_id) or not os.path.isdir(_THUMBS_DIR):
        return None
    for ext in _IMAGE_EXTS:
        candidate = os.path.join(_THUMBS_DIR, wf_id + ext)
        if os.path.isfile(candidate):
            return candidate
    return None


def _find_sibling_thumb(json_path: str, json_count_in_dir: int) -> str | None:
    folder = os.path.dirname(json_path)
    stem = os.path.splitext(os.path.basename(json_path))[0]
    stem_low = stem.lower()
    norm_stem = re.sub(r"[^a-z0-9]+", "", stem_low)

    def _scan_dir(d: str, allow_sole_fallback: bool) -> str | None:
        try:
            names = os.listdir(d)
        except Exception:
            return None
        imgs = [n for n in names if os.path.splitext(n)[1].lower() in _IMAGE_EXTS]
        if not imgs:
            return None
        # 1. Exact stem match
        for name in imgs:
            base = os.path.splitext(name)[0].lower()
            if base == stem_low:
                return os.path.join(d, name)
        # 2. Prefix / suffix match (e.g. foo_preview.png, foo-1.webp, foo_thumb.jpg)
        for name in imgs:
            base = os.path.splitext(name)[0].lower()
            if base.startswith(stem_low + "_") or base.startswith(stem_low + "-") or base.startswith(stem_low + " "):
                return os.path.join(d, name)
            if norm_stem and len(norm_stem) >= 4:
                nb = re.sub(r"[^a-z0-9]+", "", base)
                if nb == norm_stem or nb.startswith(norm_stem):
                    return os.path.join(d, name)
        # 3. Sole workflow + sole image in directory
        if allow_sole_fallback and json_count_in_dir == 1 and len(imgs) == 1:
            return os.path.join(d, imgs[0])
        return None

    direct = _scan_dir(folder, allow_sole_fallback=True)
    if direct:
        return direct

    for sub in _IMAGE_SUBDIRS:
        sub_dir = os.path.join(folder, sub)
        if os.path.isdir(sub_dir):
            found = _scan_dir(sub_dir, allow_sole_fallback=False)
            if found:
                return found

    return None


_COMFY_SYSTEM_DIRS = frozenset({
    "custom_nodes",
    "user",
    "blueprints",
    "models",
    "output",
    "input",
    "temp",
    "web",
    "comfy",
    "comfy_api",
    "comfy_api_nodes",
    "comfy_config",
    "comfy_execution",
    "comfy_extras",
    "api_server",
    "app",
    "middleware",
    "utils",
    "alembic_db",
    "tests",
    "tests-unit",
})
_USER_SKIP_DIRS = frozenset({
    "__manager",
    "__bv_nodepack",
    "orion4d_cache",
})


def _discover_user_workflow_roots() -> list[tuple[str, str, str, str]]:
    """Return list of (source_key, pack_name, label_prefix, abs_dir) for ComfyUI workflow roots."""
    roots: list[tuple[str, str, str, str]] = []
    seen: set[str] = set()

    def _add(source: str, pack_name: str, prefix: str, path: str):
        if not path or not os.path.isdir(path):
            return
        norm = os.path.normcase(os.path.abspath(path))
        if norm in seen:
            return
        seen.add(norm)
        roots.append((source, pack_name, prefix, os.path.abspath(path)))

    comfy_root = _comfy_root()

    # 1. ComfyUI official blueprints folder
    bp_dir = os.path.join(comfy_root, "blueprints")
    if os.path.isdir(bp_dir):
        _add("blueprints", "Blueprints", "", bp_dir)

    # 2. ComfyUI user/default/Workflows -> "User" (source="comfy")
    user_dir = None
    try:
        user_dir = folder_paths.get_user_directory()
    except Exception:
        user_dir = os.path.join(comfy_root, "user")

    if user_dir and os.path.isdir(user_dir):
        try:
            for profile in sorted(os.listdir(user_dir)):
                profile_dir = os.path.join(user_dir, profile)
                if not os.path.isdir(profile_dir) or profile.startswith("."):
                    continue
                low_prof = profile.lower()
                if low_prof == "default":
                    for child in os.listdir(profile_dir):
                        if child.lower() == "workflows":
                            wf_dir = os.path.join(profile_dir, child)
                            if os.path.isdir(wf_dir):
                                _add("comfy", "User", "", wf_dir)
                elif low_prof not in _USER_SKIP_DIRS:
                    # Other folders under ComfyUI/user/<folder> go under "other" with their real folder name
                    _add("other", profile, profile, profile_dir)
        except Exception:
            pass

    # 3. Any other top-level folders inside ComfyUI/ that hold workflow JSONs (e.g. script_examples, workflows)
    if os.path.isdir(comfy_root):
        try:
            for child in sorted(os.listdir(comfy_root)):
                low = child.lower()
                if child.startswith(".") or low in _COMFY_SYSTEM_DIRS or low in _SKIP_DIRS:
                    continue
                child_dir = os.path.join(comfy_root, child)
                if os.path.isdir(child_dir):
                    _add("other", child, child, child_dir)
        except Exception:
            pass

    return roots


def _walk_directory_workflows(
    source: str,
    pack_name: str,
    base_dir: str,
    folder_prefix: str,
    entries: dict[str, dict[str, Any]],
    disk_index: dict[str, list[Any]],
    new_index: dict[str, list[Any]],
):
    for root, dirnames, filenames in os.walk(base_dir):
        dirnames[:] = sorted(
            d for d in dirnames
            if d.lower() not in _SKIP_DIRS and not d.startswith(".")
        )
        json_files = [
            f for f in sorted(filenames)
            if f.lower().endswith(".json") and f.lower() not in _SKIP_JSON_NAMES and not f.startswith(".")
        ]
        if not json_files:
            continue

        rel_dir = os.path.relpath(root, base_dir).replace("\\", "/")
        if rel_dir == ".":
            rel_dir = ""
        display_folder = "/".join(p for p in (folder_prefix, rel_dir) if p)

        for fname in json_files:
            full_path = os.path.join(root, fname)
            try:
                st = os.stat(full_path)
                mtime = float(st.st_mtime)
                fsize = int(st.st_size)
            except Exception:
                continue

            ok, node_count, link_count, group_count, has_subgraphs = _inspect_workflow_file(
                full_path, mtime, fsize, disk_index, new_index
            )
            if not ok:
                continue

            wf_id = _make_id(os.path.normcase(os.path.abspath(full_path)))
            custom_thumb = _find_custom_thumb(wf_id)
            sibling_thumb = None if custom_thumb else _find_sibling_thumb(full_path, len(json_files))
            rel_path = "/".join(p for p in (display_folder, fname) if p)

            entries[wf_id] = {
                "id": wf_id,
                "name": os.path.splitext(fname)[0],
                "filename": fname,
                "source": source,
                "pack": pack_name,
                "folder": display_folder or (pack_name if pack_name else "Root"),
                "relPath": rel_path,
                "nodeCount": node_count,
                "linkCount": link_count,
                "groupCount": group_count,
                "hasSubgraphs": has_subgraphs,
                "mtime": mtime,
                "size": fsize,
                "hasCustomThumb": bool(custom_thumb),
                "hasPhotoThumb": bool(custom_thumb or sibling_thumb),
                "_path": full_path,
                "_thumb": custom_thumb or sibling_thumb,
            }


def _scan_builtin_templates(
    entries: dict[str, dict[str, Any]],
    disk_index: dict[str, list[Any]],
    new_index: dict[str, list[Any]],
):
    """Discover ComfyUI's built-in workflow templates package if installed."""
    try:
        import comfyui_workflow_templates as cwt  # type: ignore
    except Exception:
        return

    try:
        iterator = getattr(cwt, "iter_templates", None)
        get_asset = getattr(cwt, "get_asset_path", None)
        if not callable(iterator) or not callable(get_asset):
            return
        for entry in iterator():
            tpl_id = getattr(entry, "template_id", None) or (entry.get("template_id") if isinstance(entry, dict) else None)
            if not tpl_id:
                continue
            assets = getattr(entry, "assets", None) or (entry.get("assets") if isinstance(entry, dict) else None) or []
            json_asset = None
            img_asset = None
            for a in assets:
                fn = getattr(a, "filename", None) or (a.get("filename") if isinstance(a, dict) else str(a))
                if not fn:
                    continue
                low = fn.lower()
                if low.endswith(".json") and json_asset is None:
                    json_asset = fn
                elif os.path.splitext(low)[1] in _IMAGE_EXTS and img_asset is None:
                    img_asset = fn
            if not json_asset:
                continue
            try:
                json_path = str(get_asset(tpl_id, json_asset))
            except Exception:
                continue
            if not os.path.isfile(json_path):
                continue

            try:
                st = os.stat(json_path)
                mtime = float(st.st_mtime)
                fsize = int(st.st_size)
            except Exception:
                continue

            ok, node_count, link_count, group_count, has_subgraphs = _inspect_workflow_file(
                json_path, mtime, fsize, disk_index, new_index
            )
            if not ok:
                continue

            thumb_path = None
            if img_asset:
                try:
                    cand = str(get_asset(tpl_id, img_asset))
                    if os.path.isfile(cand):
                        thumb_path = cand
                except Exception:
                    thumb_path = None

            wf_id = _make_id("template::" + os.path.normcase(os.path.abspath(json_path)))
            custom_thumb = _find_custom_thumb(wf_id)

            bundle = getattr(entry, "bundle", None) or (entry.get("bundle") if isinstance(entry, dict) else "") or "Templates"
            pretty_name = os.path.splitext(os.path.basename(json_asset))[0].replace("_", " ").replace("-", " ")
            entries[wf_id] = {
                "id": wf_id,
                "name": pretty_name,
                "filename": os.path.basename(json_asset),
                "source": "templates",
                "pack": str(bundle),
                "folder": str(bundle),
                "relPath": f"{bundle}/{os.path.basename(json_asset)}",
                "nodeCount": node_count,
                "linkCount": link_count,
                "groupCount": group_count,
                "hasSubgraphs": has_subgraphs,
                "mtime": mtime,
                "size": fsize,
                "hasCustomThumb": bool(custom_thumb),
                "hasPhotoThumb": bool(custom_thumb or thumb_path),
                "_path": json_path,
                "_thumb": custom_thumb or thumb_path,
            }
    except Exception:
        return


def scan_workflows(force: bool = False) -> dict[str, Any]:
    now = time.time()
    with _LOCK:
        if not force and _CACHE["items"] and (now - _CACHE["at"] < _CACHE_TTL):
            return {
                "ok": True,
                "total": len(_CACHE["items"]),
                "counts": dict(_CACHE["counts"]),
                "folders": list(_CACHE["folders"]),
                "items": list(_CACHE["items"]),
            }

    disk_index = _load_disk_index()
    new_index: dict[str, list[Any]] = {}
    entries: dict[str, dict[str, Any]] = {}

    # 1. ComfyUI blueprints, User workflows, and any other ComfyUI folders
    for source, pack_name, prefix, root_dir in _discover_user_workflow_roots():
        _walk_directory_workflows(source, pack_name, root_dir, prefix, entries, disk_index, new_index)

    # 2. Custom nodes workflows (all packs & all subfolders)
    for cn_root in State.CUSTOM_NODE_ROOT:
        if not cn_root or not os.path.isdir(cn_root):
            continue
        try:
            packs = sorted(os.listdir(cn_root))
        except Exception:
            continue
        for pack in packs:
            if pack.startswith(".") or pack.lower() in _SKIP_DIRS:
                continue
            pack_dir = os.path.join(cn_root, pack)
            if not os.path.isdir(pack_dir):
                continue
            _walk_directory_workflows("custom_nodes", pack, pack_dir, pack, entries, disk_index, new_index)

    # 3. ComfyUI built-in templates (optional package)
    _scan_builtin_templates(entries, disk_index, new_index)

    _save_disk_index(new_index)

    public_items = []
    counts = {"all": 0, "blueprints": 0, "comfy": 0, "custom_nodes": 0, "templates": 0, "other": 0}
    folder_counts: dict[tuple[str, str], int] = {}

    source_order = {"blueprints": 0, "comfy": 1, "custom_nodes": 2, "templates": 3, "other": 4}
    for rec in sorted(
        entries.values(),
        key=lambda r: (source_order.get(r["source"], 9), r["folder"].lower(), r["name"].lower()),
    ):
        pub = {k: v for k, v in rec.items() if not k.startswith("_")}
        public_items.append(pub)
        counts["all"] += 1
        src = rec["source"]
        if src in counts:
            counts[src] += 1
        fkey = (src, rec["folder"])
        folder_counts[fkey] = folder_counts.get(fkey, 0) + 1

    folders = [
        {"source": src, "folder": fld, "count": cnt}
        for (src, fld), cnt in sorted(
            folder_counts.items(),
            key=lambda kv: (source_order.get(kv[0][0], 9), kv[0][1].lower()),
        )
    ]

    with _LOCK:
        _CACHE["at"] = time.time()
        _CACHE["entries"] = entries
        _CACHE["items"] = public_items
        _CACHE["counts"] = counts
        _CACHE["folders"] = folders

    return {
        "ok": True,
        "total": len(public_items),
        "counts": counts,
        "folders": folders,
        "items": public_items,
    }


def get_workflow_entry(wf_id: str) -> dict[str, Any] | None:
    if not is_valid_workflow_id(wf_id):
        return None
    with _LOCK:
        entry = _CACHE["entries"].get(wf_id)
    if entry is None:
        scan_workflows(force=False)
        with _LOCK:
            entry = _CACHE["entries"].get(wf_id)
    return entry


def load_workflow_json(wf_id: str) -> tuple[dict[str, Any] | None, Any]:
    entry = get_workflow_entry(wf_id)
    if not entry:
        return None, None
    path = entry.get("_path")
    if not path or not os.path.isfile(path):
        return entry, None
    with open(path, "r", encoding="utf-8", errors="ignore") as fh:
        return entry, json.load(fh)


def save_custom_thumbnail(wf_id: str, data_url: str | None = None, clear: bool = False) -> tuple[bool, str]:
    entry = get_workflow_entry(wf_id)
    if not entry:
        return False, "workflow not found"

    os.makedirs(_THUMBS_DIR, exist_ok=True)
    # Remove any prior custom cover for this workflow ID
    for ext in _IMAGE_EXTS:
        old = os.path.join(_THUMBS_DIR, wf_id + ext)
        if os.path.isfile(old):
            try:
                os.remove(old)
            except Exception:
                pass

    if clear:
        sibling = _find_sibling_thumb(entry["_path"], 2)
        with _LOCK:
            entry["hasCustomThumb"] = False
            entry["hasPhotoThumb"] = bool(sibling)
            entry["_thumb"] = sibling
            for pub in _CACHE["items"]:
                if pub["id"] == wf_id:
                    pub["hasCustomThumb"] = False
                    pub["hasPhotoThumb"] = bool(sibling)
                    break
        return True, "cleared"

    if not isinstance(data_url, str) or "," not in data_url:
        return False, "invalid image payload"

    header, b64_part = data_url.split(",", 1)
    header_low = header.lower()
    if "image/webp" in header_low:
        ext = ".webp"
    elif "image/jpeg" in header_low or "image/jpg" in header_low:
        ext = ".jpg"
    elif "image/gif" in header_low:
        ext = ".gif"
    elif "image/png" in header_low:
        ext = ".png"
    else:
        return False, "unsupported image format"

    try:
        raw = base64.b64decode(b64_part, validate=True)
    except Exception:
        return False, "invalid base64 image"

    if not raw or len(raw) > _MAX_CUSTOM_THUMB_BYTES:
        return False, "image too large (max 5 MB)"

    out_path = os.path.join(_THUMBS_DIR, wf_id + ext)
    with open(out_path, "wb") as fh:
        fh.write(raw)

    with _LOCK:
        entry["hasCustomThumb"] = True
        entry["hasPhotoThumb"] = True
        entry["_thumb"] = out_path
        for pub in _CACHE["items"]:
            if pub["id"] == wf_id:
                pub["hasCustomThumb"] = True
                pub["hasPhotoThumb"] = True
                break

    return True, "saved"


def _xml_escape(text: str) -> str:
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def render_blueprint_svg(wf_id: str) -> str:
    """Render a crisp dark blueprint mini-graph SVG preview from the workflow JSON layout."""
    entry = get_workflow_entry(wf_id)
    cache_key = (wf_id, float(entry.get("mtime", 0.0))) if entry else None
    if cache_key and cache_key in _SVG_CACHE:
        return _SVG_CACHE[cache_key]
    entry, data = load_workflow_json(wf_id)
    W, H = 480, 300
    pad = 26

    svg_parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
        "<defs>",
        '<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">',
        '<stop offset="0%" stop-color="#0d1117"/>',
        '<stop offset="100%" stop-color="#131922"/>',
        "</linearGradient>",
        '<pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">',
        '<circle cx="12" cy="12" r="0.9" fill="#38c0c4" fill-opacity="0.14"/>',
        "</pattern>",
        "</defs>",
        f'<rect width="{W}" height="{H}" fill="url(#bg)"/>',
        f'<rect width="{W}" height="{H}" fill="url(#grid)"/>',
    ]

    nodes_raw = data.get("nodes") if isinstance(data, dict) and isinstance(data.get("nodes"), list) else []
    groups_raw = data.get("groups") if isinstance(data, dict) and isinstance(data.get("groups"), list) else []
    links_raw = data.get("links") if isinstance(data, dict) and isinstance(data.get("links"), list) else []

    node_boxes: dict[Any, tuple[float, float, float, float, str]] = {}
    min_x, min_y = float("inf"), float("inf")
    max_x, max_y = float("-inf"), float("-inf")

    for nd in nodes_raw:
        if not isinstance(nd, dict):
            continue
        pos = nd.get("pos")
        size = nd.get("size")
        if isinstance(pos, dict):
            x, y = float(pos.get("0", 0)), float(pos.get("1", 0))
        elif isinstance(pos, (list, tuple)) and len(pos) >= 2:
            x, y = float(pos[0]), float(pos[1])
        else:
            continue
        if isinstance(size, dict):
            w, h = float(size.get("0", 210)), float(size.get("1", 110))
        elif isinstance(size, (list, tuple)) and len(size) >= 2:
            w, h = float(size[0]), float(size[1])
        else:
            w, h = 210.0, 110.0
        w = max(80.0, min(w, 1600.0))
        h = max(40.0, min(h, 1600.0))
        color = nd.get("color") if isinstance(nd.get("color"), str) and nd.get("color").startswith("#") else "#1f6f73"
        node_boxes[nd.get("id")] = (x, y, w, h, color)
        if x < min_x:
            min_x = x
        if y < min_y:
            min_y = y
        if x + w > max_x:
            max_x = x + w
        if y + h > max_y:
            max_y = y + h

    group_boxes: list[tuple[float, float, float, float]] = []
    for grp in groups_raw:
        if not isinstance(grp, dict):
            continue
        b = grp.get("bounding")
        if isinstance(b, (list, tuple)) and len(b) >= 4:
            gx, gy, gw, gh = float(b[0]), float(b[1]), float(b[2]), float(b[3])
            if gw > 10 and gh > 10:
                group_boxes.append((gx, gy, gw, gh))
                min_x = min(min_x, gx)
                min_y = min(min_y, gy)
                max_x = max(max_x, gx + gw)
                max_y = max(max_y, gy + gh)

    if node_boxes and max_x > min_x and max_y > min_y:
        span_x = max(1.0, max_x - min_x)
        span_y = max(1.0, max_y - min_y)
        scale = min((W - pad * 2) / span_x, (H - pad * 2) / span_y)
        off_x = (W - span_x * scale) * 0.5 - min_x * scale
        off_y = (H - span_y * scale) * 0.5 - min_y * scale

        # Draw groups softly behind nodes
        for gx, gy, gw, gh in group_boxes[:40]:
            rx = gx * scale + off_x
            ry = gy * scale + off_y
            rw = max(6.0, gw * scale)
            rh = max(6.0, gh * scale)
            svg_parts.append(
                f'<rect x="{rx:.1f}" y="{ry:.1f}" width="{rw:.1f}" height="{rh:.1f}" rx="4" '
                'fill="#38c0c4" fill-opacity="0.06" stroke="#38c0c4" stroke-opacity="0.22" stroke-width="1"/>'
            )

        # Draw wires
        drawn_links = 0
        for lk in links_raw:
            if drawn_links >= 260:
                break
            if not isinstance(lk, (list, tuple)) or len(lk) < 4:
                continue
            src = node_boxes.get(lk[1])
            dst = node_boxes.get(lk[3])
            if not src or not dst:
                continue
            x1 = (src[0] + src[2]) * scale + off_x
            y1 = (src[1] + src[3] * 0.35) * scale + off_y
            x2 = dst[0] * scale + off_x
            y2 = (dst[1] + dst[3] * 0.35) * scale + off_y
            dx = max(12.0, abs(x2 - x1) * 0.45)
            svg_parts.append(
                f'<path d="M{x1:.1f},{y1:.1f} C{x1 + dx:.1f},{y1:.1f} {x2 - dx:.1f},{y2:.1f} {x2:.1f},{y2:.1f}" '
                'fill="none" stroke="#38c0c4" stroke-opacity="0.45" stroke-width="1.35"/>'
            )
            drawn_links += 1

        # Draw nodes
        for _nid, (x, y, w, h, color) in list(node_boxes.items())[:220]:
            rx = x * scale + off_x
            ry = y * scale + off_y
            rw = max(5.0, w * scale)
            rh = max(4.0, h * scale)
            hdr_h = min(rh * 0.38, max(2.2, 5.5))
            svg_parts.append(
                f'<rect x="{rx:.1f}" y="{ry:.1f}" width="{rw:.1f}" height="{rh:.1f}" rx="2.5" '
                'fill="#1b222c" stroke="#38c0c4" stroke-opacity="0.32" stroke-width="0.8"/>'
            )
            svg_parts.append(
                f'<rect x="{rx:.1f}" y="{ry:.1f}" width="{rw:.1f}" height="{hdr_h:.1f}" rx="2" '
                f'fill="{_xml_escape(color)}" fill-opacity="0.72"/>'
            )
    else:
        # API-only prompt workflow (no x/y layout) -> draw clean procedural pipeline diagram
        n_count = entry.get("nodeCount", 0) if entry else 0
        cols = min(5, max(2, n_count or 3))
        gap = (W - 90) / max(1, cols - 1)
        for i in range(cols):
            cx = 45 + i * gap
            cy = H * 0.5 + ((i % 2) * 26 - 13)
            if i > 0:
                px = 45 + (i - 1) * gap
                py = H * 0.5 + (((i - 1) % 2) * 26 - 13)
                svg_parts.append(
                    f'<path d="M{px + 28:.1f},{py:.1f} C{px + 54:.1f},{py:.1f} {cx - 54:.1f},{cy:.1f} {cx - 28:.1f},{cy:.1f}" '
                    'fill="none" stroke="#38c0c4" stroke-opacity="0.55" stroke-width="1.6"/>'
                )
            svg_parts.append(
                f'<rect x="{cx - 28:.1f}" y="{cy - 18:.1f}" width="56" height="36" rx="5" '
                'fill="#1b222c" stroke="#38c0c4" stroke-opacity="0.45" stroke-width="1"/>'
            )
            svg_parts.append(
                f'<rect x="{cx - 28:.1f}" y="{cy - 18:.1f}" width="56" height="9" rx="4" fill="#1f6f73"/>'
            )

    badge_txt = f"{entry.get('nodeCount', 0)} nodes" if entry else "Workflow"
    svg_parts.append(
        '<g opacity="0.85">'
        '<rect x="12" y="12" width="76" height="20" rx="6" fill="#0b0e13" fill-opacity="0.82" '
        'stroke="#38c0c4" stroke-opacity="0.35" stroke-width="1"/>'
        f'<text x="50" y="25.5" text-anchor="middle" fill="#38c0c4" font-family="Consolas,monospace" '
        f'font-size="10" font-weight="600">{_xml_escape(badge_txt)}</text>'
        "</g>"
    )
    svg_parts.append("</svg>")
    out = "".join(svg_parts)
    if cache_key:
        if len(_SVG_CACHE) >= _SVG_CACHE_MAX:
            _SVG_CACHE.clear()
        _SVG_CACHE[cache_key] = out
    return out
