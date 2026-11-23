"""The one line of output a user sees at startup.

Kept apart from the rest so that removing it, or changing what it reports, cannot touch anything
that runs.
"""

import os

from . import State


def display_livedev_banner(node_count: int):
    """One short report at startup: what loaded, and what is watching.

    The colour is the pack's accent, written as a 24-bit ANSI escape so it does not depend on the
    terminal's palette. Nothing here touches the network - the update check is a separate, explicit
    action - and every probe is wrapped, because a banner that raises would be worse than none.
    """
    import importlib.metadata as metadata

    accent = "\033[38;2;56;192;196m"
    reset = "\033[0m"
    bold = "\033[1;37m"
    dim = "\033[2m"

    version = None
    try:
        import tomllib
        with open(os.path.join(State.PACK_ROOT, "pyproject.toml"), "rb") as handle:
            version = tomllib.load(handle)["project"]["version"]
    except Exception:
        version = "dev"

    frontend = "unknown"
    try:
        frontend = metadata.version("comfyui_frontend_package") or "unknown"
    except Exception:
        pass

    # The frontend the browser is served is not always the installed package: ComfyUI keeps
    # per-version builds under web_custom_versions and serves one of those when a node asks for it,
    # so the newest one on disk is reported when it exists.
    try:
        custom_root = os.path.join(State.COMFY_ROOT, "web_custom_versions")
        custom = []
        for organisation in os.listdir(custom_root):
            folder = os.path.join(custom_root, organisation)
            if os.path.isdir(folder):
                custom.extend(entry for entry in os.listdir(folder)
                              if os.path.isdir(os.path.join(folder, entry)))
        if custom:
            frontend = f"{sorted(custom)[-1]} (custom)"
    except Exception:
        pass

    bar = accent + "\u2501" * 62 + reset
    watched = len(State.list_custom_node_modules())
    state = "paused" if State.WATCH_PAUSED else "watching"
    lines = [
        bar,
        # The reload arrow, not a lightning bolt: the bolt is ComfyUI-ProStudio's mark, and two packs
        # in one install sharing a mark is what makes a log entry unreadable at a glance.
        f"  {accent}{bold}\U0001F503 LiveDev{reset} v{version}"
        f"   {dim}|{reset}   {accent}{node_count} nodes{reset}"
        f"   {dim}|{reset}   frontend {frontend}",
        f"  {accent}{watched} modules{reset}   {dim}\u00b7{reset}   "
        f"{accent}{state}{reset}   {dim}\u00b7{reset}   "
        f"{accent}debounce {State.DEBOUNCE_TIME:g}s{reset}   {dim}\u00b7{reset}   "
        f"{accent}Settings \u2192 LiveDev{reset}",
        bar,
    ]
    # A console is written through the Windows Unicode API and takes these glyphs; a *redirected*
    # stdout is encoded with the ANSI code page, which has neither the box-drawing character nor the
    # lightning bolt, and `print` would raise. The report is still worth having, so it degrades to
    # ASCII rather than taking the import down with it.
    try:
        print("\n".join(lines))
    except UnicodeEncodeError:
        print("\n".join(lines).encode("ascii", "replace").decode("ascii"))
