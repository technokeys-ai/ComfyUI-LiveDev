"""The pack's own modules, kept out of the node folder.

ComfyUI loads every folder directly under `custom_nodes` as a pack, and `Nodes/` holds the two
nodes. Nothing here is a node: this is the reloader, the routes, the console tee and the state they
share, and `__init__.py` wires them together.
"""
