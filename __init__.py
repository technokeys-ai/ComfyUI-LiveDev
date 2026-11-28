"""ComfyUI-LiveDev: a development toolkit that reloads custom nodes without restarting the server.

This file is the composition root and nothing else. It imports the modules, starts the watcher and
the console tee, and tells ComfyUI which nodes the pack defines. The reload engine is in
`Core/Reloader.py`, the routes in `Core/Routes.py`, and the state they share in `Core/State.py`.

The routes register themselves through the decorators on `PromptServer.instance.routes`, so
`Core.Routes` is imported for that side effect and never called directly.
"""

import atexit
import logging

from .Core import Banner, Console, Reloader, State
from .Core import Routes  # noqa: F401  (imported for the route decorators it registers)
from .Nodes.BypassNodes import NODE_CLASS_MAPPINGS as MAPS_BYPASS
from .Nodes.BypassNodes import NODE_DISPLAY_NAME_MAPPINGS as NAMES_BYPASS
from .Nodes.Memory import NODE_CLASS_MAPPINGS as MAPS_MEMORY
from .Nodes.Memory import NODE_DISPLAY_NAME_MAPPINGS as NAMES_MEMORY
from .Nodes.RunTimer import NODE_CLASS_MAPPINGS as MAPS_RUN_TIMER
from .Nodes.RunTimer import NODE_DISPLAY_NAME_MAPPINGS as NAMES_RUN_TIMER
from .Nodes.Terminal import NODE_CLASS_MAPPINGS as MAPS_TERMINAL
from .Nodes.Terminal import NODE_DISPLAY_NAME_MAPPINGS as NAMES_TERMINAL


def setup():
    logging.info("[LiveDev] Monkey patching comfy_execution.caching.BasicCache")
    Reloader.monkeypatch()
    Console.install_console_tee()
    service = Reloader.LiveDevService()
    State.ACTIVE_RELOADER = service.get_reloader()
    atexit.register(service.stop)
    service.start()
    Reloader.schedule_watch_grace()


setup()

WEB_DIRECTORY = "./Web"

NODE_CLASS_MAPPINGS = {
    **MAPS_TERMINAL,
    **MAPS_MEMORY,
    **MAPS_RUN_TIMER,
    **MAPS_BYPASS,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    **NAMES_TERMINAL,
    **NAMES_MEMORY,
    **NAMES_RUN_TIMER,
    **NAMES_BYPASS,
}

Banner.display_livedev_banner(len(NODE_CLASS_MAPPINGS))
