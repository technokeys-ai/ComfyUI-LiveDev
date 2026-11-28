from comfy_api.latest import io


class LiveDev_BypassNodes(io.ComfyNode):
    """Frontend-driven remote node & group controller styled with the LiveDev glassmorphic identity.

    Remotely toggles Bypass (mode 4) or Mute (mode 2) for individual nodes, custom collapsible
    decks, and ComfyUI canvas groups without drawing a single wire. Supports searching nodes
    inside subgraphs, 1-click camera jump, compact dashboard lock mode, and smart recovery for
    missing or renumbered node IDs.
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiveDev_BypassNodes",
            display_name="\U0001f500 Bypass LiveDev",
            category="\U0001f503 LiveDev/\u23f1 Utilities",
            description=(
                "Remote Bypass and Mute control board with LiveDev glassmorphic styling. Toggle "
                "individual nodes, custom collapsible decks, or entire ComfyUI canvas groups "
                "without wires, jump instantly to any target (including inside subgraphs), switch "
                "between Bypass and Mute per row, lock into a compact dashboard view, and recover "
                "missing node IDs with 1-click smart matching."
            ),
            search_aliases=[
                "bypass",
                "mute",
                "toggle",
                "switch",
                "group",
                "control",
                "remote",
                "bypasser",
                "deck",
                "nodes",
            ],
            is_output_node=False,
        )

    @classmethod
    def execute(cls) -> io.NodeOutput:
        return io.NodeOutput()


NODE_CLASS_MAPPINGS = {"LiveDev_BypassNodes": LiveDev_BypassNodes}
NODE_DISPLAY_NAME_MAPPINGS = {"LiveDev_BypassNodes": "\U0001f500 Bypass LiveDev"}
