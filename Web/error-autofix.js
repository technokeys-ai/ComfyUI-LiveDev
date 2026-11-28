// Smart Error Auto-Fixer for ComfyUI-LiveDev.
//
// Hooks into LiveDev's Error Card (ERROR_CARD_HOOKS) and classifies common ComfyUI runtime
// failures (CUDA OOM, ModuleNotFoundError, Missing Model, Shape/Device mismatch, Dtype
// mismatch, NaN latents, Stale node schema) to provide clear diagnosis and 1-click fixes.

import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import { esc, showToast } from "./utils.js";
import { ACCENT, DANGER, FONT_MONO, LD_ICONS } from "./livedev-theme.js";
import { ERROR_CARD_HOOKS, clearAllErrorOverlays } from "./livedev-toolkit.js";
import { openPreflightModal } from "./preflight-check.js";
import { openDependenciesHub } from "./livedev-deps-popup.js";
import { rebuildNodes } from "./node-tools.js";

// Common Python import name -> PyPI distribution name mapping
const MODULE_TO_PYPI = {
  cv2: "opencv-python",
  PIL: "pillow",
  skimage: "scikit-image",
  sklearn: "scikit-learn",
  yaml: "pyyaml",
  bs4: "beautifulsoup4",
  dotenv: "python-dotenv",
  dateutil: "python-dateutil",
  OpenSSL: "pyopenssl",
  Crypto: "pycryptodome",
  fitz: "pymupdf",
  serial: "pyserial",
  usb: "pyusb",
  google: "protobuf",
  wx: "wxPython",
  git: "gitpython",
  magic: "python-magic",
  segment_anything: "segment-anything",
  clip: "open-clip-torch",
  ultralytics: "ultralytics",
  insightface: "insightface",
  onnxruntime: "onnxruntime-gpu",
  einops: "einops",
  timm: "timm",
  diffusers: "diffusers",
  transformers: "transformers",
  accelerate: "accelerate",
  safetensors: "safetensors",
  scipy: "scipy",
  imageio: "imageio",
  av: "av",
  decord: "decord",
  trimesh: "trimesh",
  kornia: "kornia",
  compel: "compel",
  omegaconf: "omegaconf",
  hydra: "hydra-core",
  albumentations: "albumentations",
  mediapipe: "mediapipe",
  rembg: "rembg",
  sageattention: "sageattention",
};

function resolvePypiName(importName) {
  const root = String(importName || "").split(".")[0].trim();
  if (!root) return "";
  return MODULE_TO_PYPI[root] || root;
}

async function freeMemoryNow() {
  const res = await api.fetchApi("/livedev/free_memory", { method: "POST" });
  const d = await res.json();
  if (!d?.ok) throw new Error(d?.error || "Memory cleanup failed");
  const vram = Math.max(0, (d.before?.vram_mb || 0) - (d.after?.vram_mb || 0));
  const ram = Math.max(0, (d.before?.ram_mb || 0) - (d.after?.ram_mb || 0));
  return { vram, ram, unloaded: d.unloaded || 0 };
}

async function installMissingPackage(pkgName, nodeType) {
  if (!confirm(`Install missing Python package "${pkgName}" into the ComfyUI environment? (Rollback snapshot is saved automatically.)`)) {
    return false;
  }
  showToast(`LiveDev: Installing "${pkgName}"...`, 4000);
  const res = await api.fetchApi("/livedev/deps/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ package: pkgName, node_name: nodeType || "" }),
  });
  const d = await res.json();
  if (!res.ok || !d?.ok) {
    throw new Error(d?.error || d?.stderr || `Install failed (HTTP ${res.status})`);
  }
  showToast(`LiveDev: Installed "${pkgName}" — restart ComfyUI or reload the module to apply`, 4500);
  return true;
}

/**
 * Inspect a ComfyUI execution_error payload and return a structured diagnosis + 1-click fixes.
 */
export function diagnoseError(detail, node) {
  const msg = String(detail?.exception_message || detail?.message || "");
  const excType = String(detail?.exception_type || "");
  const tbText = Array.isArray(detail?.traceback)
    ? detail.traceback.join("\n")
    : String(detail?.traceback || "");
  const full = `${excType}\n${msg}\n${tbText}`;

  // 1. CUDA / MPS Out of Memory
  if (
    /CUDA out of memory|OutOfMemoryError|CUBLAS_STATUS_ALLOC_FAILED|HIP out of memory|MPS backend out of memory|Allocation on device/i.test(
      full,
    )
  ) {
    return {
      id: "oom",
      title: "GPU Out of Memory (VRAM)",
      summary: "VRAM ran out during execution. Unload cached models and retry, or lower resolution / batch size.",
      actions: [
        {
          label: "Free VRAM & Retry",
          primary: true,
          run: async () => {
            const freed = await freeMemoryNow();
            showToast(`LiveDev: Freed ${freed.vram} MB VRAM — retrying workflow...`);
            clearAllErrorOverlays();
            await new Promise((r) => setTimeout(r, 350));
            if (typeof app.queuePrompt === "function") await app.queuePrompt(0, 1);
          },
        },
        {
          label: "Free VRAM",
          primary: false,
          run: async () => {
            const freed = await freeMemoryNow();
            showToast(`LiveDev: Freed ${freed.vram} MB VRAM, ${freed.ram} MB RAM`);
          },
        },
      ],
    };
  }

  // 2. Missing Python Module
  const modMatch =
    full.match(/No module named ['"]([A-Za-z0-9_.\-]+)['"]/i) ||
    full.match(/cannot import name ['"][^'"]+['"] from ['"]([A-Za-z0-9_.\-]+)['"]/i);
  if (modMatch && modMatch[1]) {
    const rawMod = modMatch[1];
    const pypi = resolvePypiName(rawMod);
    return {
      id: "missing_module",
      title: `Missing Package: ${rawMod}`,
      summary: `Python could not import "${rawMod}". Install "${pypi}" via LiveDev Deps Hub with automatic rollback protection.`,
      actions: [
        {
          label: `Install ${pypi}`,
          primary: true,
          run: async () => {
            await installMissingPackage(pypi, node?.type || "");
          },
        },
        {
          label: "Deps Hub",
          primary: false,
          run: () => openDependenciesHub(),
        },
      ],
    };
  }

  // 3. Missing Model / File Not Found
  if (
    /FileNotFoundError|No such file or directory|Value not in list|not in list|Model not found|ckpt_name|lora_name|vae_name/i.test(
      full,
    )
  ) {
    return {
      id: "missing_file",
      title: "Missing Model or File",
      summary: "A referenced checkpoint, LoRA, VAE, or file was not found on disk. Run Pre-Flight Check to Fuzzy-Swap it with an installed model.",
      actions: [
        {
          label: "Pre-Flight & Fuzzy Swap",
          primary: true,
          run: () => openPreflightModal(),
        },
      ],
    };
  }

  // 4. Stale Node Schema / Unexpected Keyword Argument
  if (
    /unexpected keyword argument|missing \d+ required positional argument|takes \d+ positional arguments? but/i.test(
      full,
    )
  ) {
    return {
      id: "stale_signature",
      title: "Node Signature Mismatch",
      summary: "The node inputs on canvas no longer match its Python execute() signature (often after a custom node update or Live Reload).",
      actions: node
        ? [
            {
              label: "Rebuild Node (Keep Values)",
              primary: true,
              run: () => {
                rebuildNodes([node], true);
                clearAllErrorOverlays();
                showToast(`LiveDev: Rebuilt ${node.title || node.type}`);
              },
            },
          ]
        : [],
    };
  }

  // 5. Tensor / Model-CLIP-VAE Shape or Device Mismatch
  if (
    /mat1 and mat2 shapes cannot be multiplied|size of tensor a|Expected all tensors to be on the same device|shape mismatch|Given groups=\d+, weight of size/i.test(
      full,
    )
  ) {
    return {
      id: "shape_mismatch",
      title: "Model / Tensor Shape Mismatch",
      summary: "Incompatible architecture mix (e.g. SD1.5 / SDXL / Flux / Qwen checkpoint, LoRA, CLIP, ControlNet, or VAE mismatch) or CPU/GPU device mismatch.",
      actions: [
        {
          label: "Pre-Flight Check",
          primary: true,
          run: () => openPreflightModal(),
        },
        {
          label: "Free VRAM",
          primary: false,
          run: async () => {
            const freed = await freeMemoryNow();
            showToast(`LiveDev: Freed ${freed.vram} MB VRAM`);
          },
        },
      ],
    };
  }

  // 6. Dtype / Precision Mismatch
  if (/expected scalar type (Half|Float|BFloat16|Float8)|Input type .* and weight type .* should be the same/i.test(full)) {
    return {
      id: "dtype_mismatch",
      title: "Precision / Dtype Mismatch",
      summary: "Half (fp16), BFloat16, Float8, and Float32 weights conflicted. Match precision across UNET, CLIP, and VAE loaders, or clear loaded models.",
      actions: [
        {
          label: "Free VRAM & Retry",
          primary: true,
          run: async () => {
            await freeMemoryNow();
            clearAllErrorOverlays();
            await new Promise((r) => setTimeout(r, 350));
            if (typeof app.queuePrompt === "function") await app.queuePrompt(0, 1);
          },
        },
      ],
    };
  }

  // 7. NaN / Inf values
  if (/NaN|invalid value encountered|contains NaN/i.test(full)) {
    return {
      id: "nan_latent",
      title: "NaN / Numerical Overflow",
      summary: "Latent or image produced NaN values. Try lowering CFG or LoRA strength, switching to an fp32 VAE, or clearing VRAM.",
      actions: [
        {
          label: "Free VRAM",
          primary: false,
          run: async () => {
            await freeMemoryNow();
            showToast("LiveDev: Cleared VRAM");
          },
        },
      ],
    };
  }

  return null;
}

function attachSmartFixStrip(node, detail, _buttons, card) {
  if (!card) return;
  const diag = diagnoseError(detail, node);
  if (!diag) return;

  const strip = document.createElement("div");
  strip.className = "ld-err-fix";

  const head = document.createElement("div");
  head.className = "ld-err-fix-head";
  head.innerHTML = `${LD_ICONS.bolt}<span>Smart Fix · ${esc(diag.title)}</span>`;

  const desc = document.createElement("div");
  desc.className = "ld-err-fix-desc";
  desc.textContent = diag.summary;

  strip.append(head, desc);

  if (Array.isArray(diag.actions) && diag.actions.length) {
    const row = document.createElement("div");
    row.className = "ld-err-fix-row";
    for (const act of diag.actions) {
      const fixBtn = document.createElement("button");
      fixBtn.type = "button";
      fixBtn.className = act.primary ? "ld-btn ld-btn-primary ld-err-btn" : "ld-btn ld-err-btn";
      fixBtn.textContent = act.label;
      fixBtn.onclick = async (e) => {
        e.stopPropagation();
        fixBtn.disabled = true;
        const origLabel = fixBtn.textContent;
        fixBtn.textContent = "Working...";
        try {
          await act.run();
        } catch (err) {
          showToast(`LiveDev Fix Failed: ${err.message}`, 4200);
        } finally {
          fixBtn.disabled = false;
          fixBtn.textContent = origLabel;
        }
      };
      row.appendChild(fixBtn);
    }
    strip.appendChild(row);
  }

  const host = card.querySelector(".ld-err-body") || card;
  host.appendChild(strip);
}

app.registerExtension({
  name: "LiveDev.ErrorAutoFix",
  async setup() {
    if (!ERROR_CARD_HOOKS.includes(attachSmartFixStrip)) {
      ERROR_CARD_HOOKS.push(attachSmartFixStrip);
    }
  },
});
