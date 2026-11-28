from comfy_api.latest import io


class LiveDev_RunTimer(io.ComfyNode):
    """Frontend-driven workflow stopwatch styled with the LiveDev glassmorphic identity.

    Resets to zero when a run starts, ticks smoothly while the workflow executes, freezes on the
    final duration when execution finishes, records run history, and optionally plays a soft Web
    Audio finish chime. The node requires no inputs or outputs and is skipped during Python graph
    execution.
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiveDev_RunTimer",
            display_name="\u23f1 Run Timer LiveDev",
            category="\U0001f503 LiveDev/\u23f1 Utilities",
            description=(
                "Live workflow stopwatch with unified LiveDev glassmorphic styling. Counts up "
                "automatically on Run, freezes on total elapsed time when finished, keeps a "
                "persistent run history with stats, scales cleanly when resized, and plays an "
                "optional synthesized finish chime. Right-click or double-click the clock for "
                "settings and history."
            ),
            search_aliases=[
                "timer",
                "stopwatch",
                "clock",
                "run",
                "duration",
                "benchmark",
                "elapsed",
                "chime",
            ],
            is_output_node=False,
        )

    @classmethod
    def execute(cls) -> io.NodeOutput:
        return io.NodeOutput()


NODE_CLASS_MAPPINGS = {"LiveDev_RunTimer": LiveDev_RunTimer}
NODE_DISPLAY_NAME_MAPPINGS = {"LiveDev_RunTimer": "\u23f1 Run Timer LiveDev"}
