"""LiveDev Dependency Manager: detect missing libraries, analyze version conflicts, and safely install packages.

This module inspects custom node dependencies (from requirements.txt or pyproject.toml)
and compares them with the active Python environment (sys.executable). It flags version
conflicts—especially with critical ComfyUI packages like torch, torchvision, and numpy—
so users are clearly informed before installing.

Conflict Install Log: before overwriting any package during a conflict install, the
previous version is recorded in conflict_install_log.json so the user can roll back.
"""

import importlib.metadata
import importlib.util
import json
import os
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from packaging.requirements import Requirement
from packaging.specifiers import SpecifierSet
from packaging.version import Version, parse as parse_version

try:
    import tomllib
except ImportError:
    tomllib = None

from . import State

# ---------------------------------------------------------------------------
# Conflict Install Log — persistent snapshot of packages changed during
# conflict-override installs, so the user can roll back to the previous version.
# ---------------------------------------------------------------------------

def _conflict_log_path() -> str:
    """Return path to the conflict install log JSON file."""
    return os.path.join(State.PACK_ROOT, "conflict_install_log.json")


_conflict_log_lock = threading.Lock()


def load_conflict_log() -> dict:
    """Read the conflict install log from disk. Returns {} on missing/invalid."""
    path = _conflict_log_path()
    try:
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    return data
    except Exception as e:
        print(f"\033[93m[LiveDev Deps] Could not read conflict log: {e}\033[0m")
    return {}


def save_conflict_log(log: dict) -> None:
    """Write the conflict install log to disk atomically."""
    path = _conflict_log_path()
    try:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(log, f, indent=2, ensure_ascii=False)
        os.replace(tmp, path)
    except Exception as e:
        print(f"\033[91m[LiveDev Deps] Could not save conflict log: {e}\033[0m")


def record_conflict_install(
    canonical_pkg: str,
    old_version: str | None,
    new_spec: str,
    node_name: str,
    was_conflict: bool = False,
) -> dict:
    """Record a package install/overwrite snapshot so the user can roll back cleanly.

    If the same package already has an active snapshot, the original old_version is
    preserved so rollback always returns to the true pre-change state.
    """
    recorded_old = old_version if old_version else "__none__"
    with _conflict_log_lock:
        log = load_conflict_log()
        if canonical_pkg not in log:
            entry = {
                "canonical_name": canonical_pkg,
                "old_version": recorded_old,
                "new_spec": new_spec,
                "node_name": node_name,
                "was_conflict": bool(was_conflict),
                "installed_at": datetime.now(timezone.utc).isoformat(),
            }
            log[canonical_pkg] = entry
            save_conflict_log(log)
            print(
                f"\033[93m[LiveDev Deps] Rollback snapshot saved: {canonical_pkg} "
                f"({recorded_old} -> {new_spec}) for node '{node_name}'\033[0m"
            )
        else:
            entry = log[canonical_pkg]
            entry["new_spec"] = new_spec
            entry["node_name"] = node_name or entry.get("node_name", "")
            entry["was_conflict"] = bool(entry.get("was_conflict") or was_conflict)
            entry["installed_at"] = datetime.now(timezone.utc).isoformat()
            save_conflict_log(log)
            print(
                f"\033[93m[LiveDev Deps] Rollback snapshot updated: {canonical_pkg} "
                f"(original: {entry['old_version']} -> {new_spec})\033[0m"
            )
        return dict(entry)


def remove_conflict_log_entry(canonical_pkg: str) -> None:
    """Remove a package from the conflict log after a successful rollback."""
    with _conflict_log_lock:
        log = load_conflict_log()
        if canonical_pkg in log:
            del log[canonical_pkg]
            save_conflict_log(log)


def _extract_pkg_name_from_spec(package_spec: str) -> str:
    """Extract canonical package name from a pip requirement string."""
    parsed = parse_requirement_line(package_spec)
    if parsed:
        return parsed[0]
    base = re.split(r"[=<>~!;\[\s@]", package_spec.strip(), maxsplit=1)[0]
    return canonical_name(base)


def rollback_package(canonical_pkg: str) -> dict:
    """Roll back a previously installed/overwritten package to its recorded prior state.

    - If an old version existed: reinstalls that exact version (preventing duplicate installs).
    - If the package did not exist before: uninstalls it cleanly via `pip uninstall -y`.
    """
    c_pkg = canonical_name(canonical_pkg)
    with _conflict_log_lock:
        log = load_conflict_log()

    if c_pkg not in log:
        return {
            "ok": False,
            "error": f"No rollback snapshot found for '{c_pkg}'. Nothing to roll back.",
        }

    entry = log[c_pkg]
    old_version = entry.get("old_version", "")

    if not old_version or old_version == "unknown":
        return {
            "ok": False,
            "error": f"Cannot roll back '{c_pkg}': original state was not recorded.",
        }

    if old_version == "__none__":
        # Package was freshly installed; rollback means clean uninstall
        python_exe = sys.executable
        cmd = [python_exe, "-m", "pip", "uninstall", "-y", c_pkg]
        print(f"\n\033[94m[LiveDev Deps] Rolling back (uninstalling) '{c_pkg}'...\033[0m")
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            encoding="utf-8",
            errors="replace",
        )
        lines: list[str] = []
        try:
            for raw in proc.stdout:
                line = raw.rstrip("\r\n")
                lines.append(line)
                print(f"\033[96m[LiveDev Deps]\033[0m {line}")
        finally:
            proc.wait()
        ok = proc.returncode == 0
        if ok:
            invalidate_installed_cache()
            remove_conflict_log_entry(c_pkg)
            print(f"\033[92m[LiveDev Deps] Rollback complete: uninstalled '{c_pkg}'\033[0m\n")
        return {
            "ok": ok,
            "returncode": proc.returncode,
            "package": c_pkg,
            "old_version": None,
            "action": "uninstalled",
            "message": f"Successfully uninstalled '{c_pkg}'." if ok else None,
            "error": None if ok else f"Uninstall failed (code {proc.returncode}).",
            "log": "\n".join(lines[-40:]),
        }

    rollback_spec = f"{c_pkg}=={old_version}"
    print(f"\033[94m[LiveDev Deps] Rolling back '{c_pkg}' to version {old_version}...\033[0m")

    # Reinstall exact previous version cleanly without rewriting the snapshot
    result = install_package(
        rollback_spec,
        extra_args=["--force-reinstall", "--no-deps"],
        record_snapshot=False,
    )
    if result["ok"]:
        remove_conflict_log_entry(c_pkg)
        result["old_version"] = old_version
        result["action"] = "restored"
        result["message"] = f"Successfully rolled back '{c_pkg}' to {old_version}."
        print(f"\033[92m[LiveDev Deps] Rollback complete: {c_pkg} -> {old_version}\033[0m")
    else:
        print(f"\033[91m[LiveDev Deps] Rollback failed for {c_pkg}: {result.get('error')}\033[0m")

    return result


# Core packages that must not be accidentally modified or downgraded in ComfyUI
CRITICAL_CORE_PACKAGES = {
    "torch",
    "torchvision",
    "torchaudio",
    "xformers",
    "numpy",
    "scipy",
    "cuda",
}

# Sensitive packages that affect model execution, acceleration, or ComfyUI server stability
SENSITIVE_PACKAGES = {
    "transformers",
    "diffusers",
    "accelerate",
    "safetensors",
    "onnxruntime",
    "onnxruntime-gpu",
    "opencv-python",
    "pillow",
    "aiohttp",
    "huggingface-hub",
}

# Mapping for common import names to their distribution package names
COMMON_IMPORT_TO_PKG = {
    "cv2": "opencv-python",
    "PIL": "pillow",
    "yaml": "pyyaml",
    "sklearn": "scikit-learn",
    "fitz": "pymupdf",
    "magic": "python-magic-bin",
    "av": "av",
    "skimage": "scikit-image",
    "serial": "pyserial",
    "git": "gitpython",
    "bs4": "beautifulsoup4",
}

# Reverse mapping: distribution package name -> primary importable module name
COMMON_PKG_TO_IMPORT = {
    "opencv-python": "cv2",
    "opencv-contrib-python": "cv2",
    "opencv-python-headless": "cv2",
    "pillow": "PIL",
    "pyyaml": "yaml",
    "scikit-learn": "sklearn",
    "scikit-image": "skimage",
    "pymupdf": "fitz",
    "python-magic-bin": "magic",
    "beautifulsoup4": "bs4",
    "gitpython": "git",
    "pyserial": "serial",
    "zxing-cpp": "zxingcpp",
}

_INSTALLED_CACHE: dict = {"at": 0.0, "data": {}}
_CACHE_TTL = 10.0  # seconds


def canonical_name(name: str) -> str:
    """Normalize package names according to PEP 503."""
    return re.sub(r"[-_.]+", "-", name).lower().strip()


def invalidate_installed_cache():
    _INSTALLED_CACHE["at"] = 0.0
    _INSTALLED_CACHE["data"] = {}


def get_installed_packages(force_refresh: bool = False) -> dict[str, str]:
    """Return a mapping of canonical_package_name -> installed_version string."""
    now = time.time()
    if not force_refresh and _INSTALLED_CACHE["data"] and (now - _INSTALLED_CACHE["at"] < _CACHE_TTL):
        return _INSTALLED_CACHE["data"]

    installed: dict[str, str] = {}
    try:
        for dist in importlib.metadata.distributions():
            try:
                name = canonical_name(dist.metadata["Name"])
                version = dist.metadata["Version"]
                installed[name] = version
            except Exception:
                continue
    except Exception as e:
        print(f"\033[91m[LiveDev Deps] Failed to list installed distributions: {e}\033[0m")

    _INSTALLED_CACHE["at"] = now
    _INSTALLED_CACHE["data"] = installed
    return installed


def parse_requirement_line(line: str) -> tuple[str, str, str] | None:
    """Parse a single requirement line into (canonical_name, specifier_str, raw_spec)."""
    clean_line = line.strip()
    if not clean_line or clean_line.startswith("#") or clean_line.startswith("-"):
        return None

    # Strip inline comments
    clean_line = re.sub(r"\s+#.*$", "", clean_line).strip()
    if not clean_line:
        return None

    # Check for direct git URL (e.g. git+https://github.com/.../sam2 or git+https://...@tag)
    if clean_line.startswith("git+") or clean_line.startswith("https://") or clean_line.startswith("http://"):
        repo_name_match = re.search(r"/([a-zA-Z0-9_\-]+?)(?:\.git)?(?:@.*)?$", clean_line)
        pkg_name = repo_name_match.group(1) if repo_name_match else "unknown-package"
        return canonical_name(pkg_name), "", clean_line

    try:
        req = Requirement(clean_line)
        # Check environment marker if present (e.g. sys_platform == 'win32')
        if req.marker and not req.marker.evaluate():
            return None
        c_name = canonical_name(req.name)
        spec_str = str(req.specifier) if req.specifier else ""
        return c_name, spec_str, clean_line
    except Exception:
        # Fallback regex if packaging fails on complex line
        match = re.match(r"^([a-zA-Z0-9_\-\.]+)(.*)$", clean_line)
        if match:
            pkg = canonical_name(match.group(1))
            spec = match.group(2).strip()
            return pkg, spec, clean_line

    return None


def extract_node_requirements(node_folder_path: str) -> list[tuple[str, str, str]]:
    """Extract requirements from requirements.txt or pyproject.toml inside a node folder."""
    results: list[tuple[str, str, str]] = []
    seen = set()

    req_path = os.path.join(node_folder_path, "requirements.txt")
    if os.path.isfile(req_path):
        try:
            with open(req_path, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    parsed = parse_requirement_line(line)
                    if parsed and parsed[0] not in seen:
                        seen.add(parsed[0])
                        results.append(parsed)
        except Exception as e:
            print(f"\033[91m[LiveDev Deps] Error reading {req_path}: {e}\033[0m")

    pyproject_path = os.path.join(node_folder_path, "pyproject.toml")
    if os.path.isfile(pyproject_path):
        try:
            with open(pyproject_path, "rb") as f:
                if tomllib:
                    data = tomllib.load(f)
                    deps = data.get("project", {}).get("dependencies", [])
                    for item in deps:
                        if isinstance(item, str):
                            parsed = parse_requirement_line(item)
                            if parsed and parsed[0] not in seen:
                                seen.add(parsed[0])
                                results.append(parsed)
                else:
                    # Fallback text search
                    f.seek(0)
                    content = f.read().decode("utf-8", errors="ignore")
                    dep_match = re.search(r"dependencies\s*=\s*\[(.*?)\]", content, re.DOTALL)
                    if dep_match:
                        for part in dep_match.group(1).split(","):
                            cleaned = part.strip().strip('"').strip("'")
                            parsed = parse_requirement_line(cleaned)
                            if parsed and parsed[0] not in seen:
                                seen.add(parsed[0])
                                results.append(parsed)
        except Exception as e:
            print(f"\033[91m[LiveDev Deps] Error reading {pyproject_path}: {e}\033[0m")

    return results


def check_single_package(pkg_name: str, specifier_str: str = "", raw_spec: str = "") -> dict:
    """Analyze a single package requirement against current environment."""
    installed = get_installed_packages()
    c_name = canonical_name(pkg_name)
    installed_ver = installed.get(c_name)

    # Check for hardware runtime variants (e.g., onnxruntime vs onnxruntime-gpu)
    if c_name == "onnxruntime" and "onnxruntime-gpu" in installed:
        installed_ver = installed["onnxruntime-gpu"] + " (GPU)"
        return {
            "name": pkg_name,
            "canonical_name": c_name,
            "specifier": specifier_str,
            "raw_spec": raw_spec or f"{pkg_name}{specifier_str}",
            "installed_version": installed_ver,
            "status": "satisfied",
            "is_critical": False,
            "conflict_type": None,
            "warning": "onnxruntime-gpu is already installed and provides GPU acceleration.",
        }

    is_critical = c_name in CRITICAL_CORE_PACKAGES
    is_sensitive = c_name in SENSITIVE_PACKAGES

    if not installed_ver:
        # Fallback check: Some binary C-extensions or packages exist in site-packages
        # without dist-info metadata (e.g. zxing-cpp as zxingcpp, or custom builds).
        # Check if the module can be located via find_spec.
        candidates = []
        if c_name in COMMON_PKG_TO_IMPORT:
            candidates.append(COMMON_PKG_TO_IMPORT[c_name])
        candidates.append(c_name.replace("-", "_"))
        candidates.append(c_name.replace("-", "").replace("_", ""))
        candidates.append(c_name)

        for cand in candidates:
            try:
                spec = importlib.util.find_spec(cand)
                if spec is not None and getattr(spec, "origin", None):
                    installed_ver = "installed"
                    try:
                        mod = sys.modules.get(cand) or importlib.import_module(cand)
                        v = getattr(mod, "__version__", None)
                        if v:
                            installed_ver = str(v)
                    except Exception:
                        pass
                    break
            except Exception:
                pass

    if not installed_ver:
        # Missing package
        warning = None
        if is_critical:
            warning = f"Notice: {pkg_name} is a critical ComfyUI core package. Ensure you install a version matching your CUDA setup."
        return {
            "name": pkg_name,
            "canonical_name": c_name,
            "specifier": specifier_str,
            "raw_spec": raw_spec or f"{pkg_name}{specifier_str}",
            "installed_version": None,
            "status": "missing",
            "is_critical": is_critical,
            "conflict_type": None,
            "warning": warning,
        }

    # Package is installed: check version specifier compatibility
    if not specifier_str:
        return {
            "name": pkg_name,
            "canonical_name": c_name,
            "specifier": "",
            "raw_spec": raw_spec or pkg_name,
            "installed_version": installed_ver,
            "status": "satisfied",
            "is_critical": is_critical,
            "conflict_type": None,
            "warning": None,
        }

    try:
        spec = SpecifierSet(specifier_str)
        # Strip local version tag for clean specifier check if needed (e.g. 2.12.0+cu130 -> 2.12.0)
        clean_v_str = installed_ver.split("+")[0]
        v = parse_version(clean_v_str)

        if v in spec:
            return {
                "name": pkg_name,
                "canonical_name": c_name,
                "specifier": specifier_str,
                "raw_spec": raw_spec or f"{pkg_name}{specifier_str}",
                "installed_version": installed_ver,
                "status": "satisfied",
                "is_critical": is_critical,
                "conflict_type": None,
                "warning": None,
            }
        else:
            # Conflict detected!
            if is_critical:
                warning = (
                    f"⚠️ Critical Core Conflict: Project requires {pkg_name}{specifier_str} while ComfyUI currently has {installed_ver}. "
                    f"Replacing or downgrading {pkg_name} may break CUDA acceleration or crash ComfyUI!"
                )
                conflict_type = "critical"
            elif is_sensitive:
                warning = (
                    f"⚠️ Version Conflict: Project requires {pkg_name}{specifier_str} while currently installed is {installed_ver}. "
                    f"Modifying this package may affect other custom nodes relying on the current version."
                )
                conflict_type = "sensitive"
            else:
                warning = (
                    f"⚠️ Version Mismatch: Currently installed version is {installed_ver} while project developer specified {specifier_str}."
                )
                conflict_type = "version_mismatch"

            return {
                "name": pkg_name,
                "canonical_name": c_name,
                "specifier": specifier_str,
                "raw_spec": raw_spec or f"{pkg_name}{specifier_str}",
                "installed_version": installed_ver,
                "status": "conflict",
                "is_critical": is_critical,
                "conflict_type": conflict_type,
                "warning": warning,
            }
    except Exception as e:
        # If parsing specifier fails, report safely
        return {
            "name": pkg_name,
            "canonical_name": c_name,
            "specifier": specifier_str,
            "raw_spec": raw_spec or f"{pkg_name}{specifier_str}",
            "installed_version": installed_ver,
            "status": "conflict",
            "is_critical": is_critical,
            "conflict_type": "unknown",
            "warning": f"Automatic specifier check failed ({e}). Installed: {installed_ver}, Required: {specifier_str}",
        }


def scan_node_dependencies(node_name: str) -> dict:
    """Scan a specific custom node folder for missing or conflicting dependencies."""
    custom_node_root = State.CUSTOM_NODE_ROOT[0]
    node_path = os.path.join(custom_node_root, node_name)

    if not os.path.exists(node_path):
        return {"ok": False, "error": f"Node path not found: {node_path}"}

    reqs = extract_node_requirements(node_path)
    packages: list[dict] = []
    missing_count = 0
    conflict_count = 0

    for c_name, spec_str, raw_spec in reqs:
        info = check_single_package(c_name, spec_str, raw_spec)
        packages.append(info)
        if info["status"] == "missing":
            missing_count += 1
        elif info["status"] == "conflict":
            conflict_count += 1

    return {
        "ok": True,
        "node_name": node_name,
        "node_path": node_path,
        "has_requirements": len(reqs) > 0,
        "total_requirements": len(packages),
        "missing_count": missing_count,
        "conflict_count": conflict_count,
        "packages": packages,
    }


def list_all_custom_node_projects() -> list[dict]:
    """List all custom node project directories with their requirements availability."""
    custom_node_root = State.CUSTOM_NODE_ROOT[0]
    projects = []
    if not os.path.isdir(custom_node_root):
        return projects

    for item in sorted(os.listdir(custom_node_root), key=lambda s: s.lower()):
        item_path = os.path.join(custom_node_root, item)
        if (
            not os.path.isdir(item_path)
            or item.startswith(".")
            or item.startswith("_")
            or item == State.LIVEDEV_SELF_MODULE
            or item in ("__pycache__", ".git")
        ):
            continue

        has_req = os.path.isfile(os.path.join(item_path, "requirements.txt"))
        has_pyproject = os.path.isfile(os.path.join(item_path, "pyproject.toml"))

        req_type = None
        if has_req and has_pyproject:
            req_type = "requirements.txt + pyproject.toml"
        elif has_req:
            req_type = "requirements.txt"
        elif has_pyproject:
            req_type = "pyproject.toml"

        projects.append({
            "name": item,
            "path": item_path,
            "has_requirements": has_req or has_pyproject,
            "req_type": req_type,
        })
    return projects


def scan_all_custom_nodes(include_clean: bool = False) -> list[dict]:
    """Scan all custom nodes and return their dependency reports."""
    results = []
    custom_node_root = State.CUSTOM_NODE_ROOT[0]
    if not os.path.isdir(custom_node_root):
        return results

    for item in sorted(os.listdir(custom_node_root), key=lambda s: s.lower()):
        item_path = os.path.join(custom_node_root, item)
        if (
            not os.path.isdir(item_path)
            or item.startswith(".")
            or item.startswith("_")
            or item == State.LIVEDEV_SELF_MODULE
            or item in ("__pycache__", ".git")
        ):
            continue
        try:
            report = scan_node_dependencies(item)
            if report.get("ok"):
                has_issues = (report.get("missing_count", 0) > 0 or report.get("conflict_count", 0) > 0)
                if include_clean or has_issues:
                    results.append(report)
        except Exception as e:
            print(f"\033[91m[LiveDev Deps] Failed scanning node {item}: {e}\033[0m")

    return results


def install_package(
    package_spec: str,
    extra_args: list[str] = None,
    node_name: str = "",
    record_snapshot: bool = True,
) -> dict:
    """Safely install a single package into the active Python environment.

    Snapshots the pre-existing installed version before running pip so the user can
    roll back to the exact prior version (or uninstall a freshly added package) without
    ever leaving duplicate versions behind.
    """
    c_pkg = _extract_pkg_name_from_spec(package_spec)
    installed_before = get_installed_packages(force_refresh=True)
    old_version = installed_before.get(c_pkg)
    was_conflict = bool(old_version)

    python_exe = sys.executable
    cmd = [python_exe, "-m", "pip", "install", package_spec]
    if extra_args:
        cmd.extend(extra_args)

    label = f"pip install {package_spec}"
    print(f"\n\033[94m[LiveDev Deps] Starting installation: {label}\033[0m")
    print(f"\033[90m[LiveDev Deps] Executable: {python_exe}\033[0m")

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        encoding="utf-8",
        errors="replace",
    )

    lines: list[str] = []
    try:
        for raw in proc.stdout:
            line = raw.rstrip("\r\n")
            lines.append(line)
            print(f"\033[96m[LiveDev Deps]\033[0m {line}")
    finally:
        proc.wait()

    code = proc.returncode
    success = (code == 0)
    snapshot = None

    if success:
        invalidate_installed_cache()
        if record_snapshot and c_pkg:
            snapshot = record_conflict_install(
                c_pkg,
                old_version,
                package_spec,
                node_name,
                was_conflict=was_conflict,
            )
        print(f"\033[92m[LiveDev Deps] Successfully installed: {package_spec}\033[0m\n")
    full_log = "\n".join(lines)
    err_detail = None
    if not success:
        if "winerror 5" in full_log.lower() or "access is denied" in full_log.lower():
            err_detail = (
                "File lock detected (WinError 5: Access is denied): "
                "The library DLL/binary file is currently in-use and locked by the running ComfyUI server. "
                "The library is already installed and functioning. If you need to upgrade it, close ComfyUI temporarily."
            )
            print(f"\033[93m[LiveDev Deps] {err_detail}\033[0m")
        print(f"\033[91m[LiveDev Deps] Installation failed (code {code}): {package_spec}\033[0m\n")

    return {
        "ok": success,
        "returncode": code,
        "package": package_spec,
        "canonical_name": c_pkg,
        "previous_version": old_version,
        "snapshot": snapshot,
        "error": err_detail,
        "log": "\n".join(lines[-40:]),
    }
