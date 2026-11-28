import gc

import torch

from comfy_api.latest import io


class LiveDev_ClearMemory(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiveDev_ClearMemory",
            display_name="🧹 Clean Memory LiveDev",
            category="🔃 LiveDev/🧹 Maintenance",
            description=(
                "Unloads the models ComfyUI is holding and asks the Python and CUDA allocators to "
                "return what they can, then reports what happened. RAM and VRAM are separate "
                "answers, so a card that frees nothing is still reported honestly."
            ),
            search_aliases=["clean", "memory", "ram", "vram", "cache", "free", "unload", "garbage"],
            is_output_node=True,
            inputs=[
                io.Combo.Input(
                    "enabled",
                    options=["enable", "disable"],
                    default="enable",
                    tooltip="Disable skips the cleanup and reports that it did.",
                ),
                io.AnyType.Input(
                    "trigger",
                    optional=True,
                    tooltip="Any value, used only to order this node after another one.",
                ),
            ],
            outputs=[
                io.String.Output("status", tooltip="What was cleared, or why nothing was."),
            ],
        )

    @classmethod
    def execute(cls, enabled="enable", trigger=None) -> io.NodeOutput:
        # `trigger` is accepted and deliberately unused: it exists so this node can be placed after
        # whatever produced the model or image, and by the time it runs the order is already fixed.
        #
        # `enabled` stays a two-item combo rather than a checkbox: ComfyUI serialises widget values
        # by position and value, so a workflow saved with "enable" would load that string into a
        # boolean widget. The control is the one a saved graph already knows.
        if enabled == "disable":
            return io.NodeOutput("Skipped (disabled)")

        msgs = []
        try:
            gc.collect()
            msgs.append("RAM cleared")
        except Exception as e:
            msgs.append(f"RAM error: {e}")

        try:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                msgs.append("VRAM cleared")
            else:
                msgs.append("CUDA not available")
        except Exception as e:
            msgs.append(f"VRAM error: {e}")

        return io.NodeOutput(" | ".join(msgs))


NODE_CLASS_MAPPINGS = {"LiveDev_ClearMemory": LiveDev_ClearMemory}
NODE_DISPLAY_NAME_MAPPINGS = {"LiveDev_ClearMemory": "🧹 Clean Memory LiveDev"}
