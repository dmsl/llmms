import gc
import time
import torch
import psutil
from transformers import AutoModelForCausalLM, AutoTokenizer

from src.libs.replacement_strategies.replacement_strategies import (
    lru_eviction, lfu_eviction, fifo_eviction, largest_first_eviction
)
from src.shared.config import CACHE, DUMMY_GPU_MEMORY, GPU_SAFETY_FACTOR, IS_DEBUG, MEMORY_REPLACEMENT_STRATEGY, SHOULD_FIT_IN_GPU
from src.shared.enums import MemoryReplacementStrategy

import torch
torch.backends.cuda.enable_flash_sdp(False)
torch.backends.cuda.enable_mem_efficient_sdp(False)
torch.backends.cuda.enable_math_sdp(True)

# ---------------------------
# GPU Utilities
# ---------------------------
if not IS_DEBUG:
    try:
        from pynvml import (
            nvmlInit, nvmlDeviceGetHandleByIndex, nvmlDeviceGetMemoryInfo, nvmlDeviceGetCount
        )
        nvmlInit()
    except Exception:
        nvmlInit = None
        nvmlDeviceGetHandleByIndex = None
        nvmlDeviceGetMemoryInfo = None
        nvmlDeviceGetCount = None
else:
    nvmlInit = None
    nvmlDeviceGetHandleByIndex = None
    nvmlDeviceGetMemoryInfo = None
    nvmlDeviceGetCount = None


# ---------------------------
# Model container
# ---------------------------
class Model:
    def __init__(self, name, architecture, params_b, benchmarks, size, precision):
        self.fullname = name
        self.architecture = architecture
        self.params_b = params_b  # in billions
        self.benchmarks = benchmarks
        self.size = size          # in bytes
        self.size_gb = round(size / (1024**3), 4)
        self.precision = precision
        self.suitability = 0
        self.final_score = 0
        self.reward = 0
        self.f1 = 0
        self.tokens_used = 0

    def __repr__(self):
        return (
            "------\n"
            f"  fullname={self.fullname!r},\n"
            f"  size={self.size},\n"
            f"  suitability={self.suitability:.4f}"
        )


# ---------------------------
# Memory Manager
# ---------------------------
class MemoryManager:
    def __init__(self):
        self.loaded_models = {}

        # DEBUG MODE → create a simulated GPU memory pool
        if IS_DEBUG:
            self.sim_total = DUMMY_GPU_MEMORY 
            self.sim_free = self.sim_total

    # ---------------------------
    # NVML helpers (single source of truth)
    # ---------------------------
    def _nvml_handle(self):
        if IS_DEBUG:
            return None
        return nvmlDeviceGetHandleByIndex(0)

    def gpu_total_bytes(self) -> int:
        if IS_DEBUG:
            return self.sim_total
        handle = self._nvml_handle()
        mem = nvmlDeviceGetMemoryInfo(handle)
        return int(mem.total)

    def gpu_free_bytes_raw(self) -> int:
        if IS_DEBUG:
            return self.sim_free
        handle = self._nvml_handle()
        mem = nvmlDeviceGetMemoryInfo(handle)
        return int(mem.free)

    def gpu_free_bytes(self) -> int:
        free = self.gpu_free_bytes_raw()
        factor = GPU_SAFETY_FACTOR if 0 < GPU_SAFETY_FACTOR <= 1 else 0.95
        return int(free * factor)

    def used_memory(self) -> int:
        return sum(int(m["size"]) for m in self.loaded_models.values())

    # ---------------------------
    # Diagnostics
    # ---------------------------
    def print_diagnostics(self, prefix=""):
        print(f"{prefix} NVML free(raw): {self.gpu_free_bytes_raw()/(1024**3):.4f} GB, total: {self.gpu_total_bytes()/(1024**3):.4f} GB")
        print(f"{prefix} NVML free(safe): {self.gpu_free_bytes()/(1024**3):.4f} GB")
        print(f"{prefix} Manager-tracked used: {self.used_memory()/(1024**3):.4f} GB (models: {len(self.loaded_models)})")
        if torch.cuda.is_available() and not IS_DEBUG:
            print(f"{prefix} torch.allocated: {torch.cuda.memory_allocated()/(1024**3):.4f} GB")
            print(f"{prefix} torch.reserved:  {torch.cuda.memory_reserved()/(1024**3):.4f} GB")
        print("")

    # ---------------------------
    # Core API
    # ---------------------------
    def is_model_loaded(self, model_name: str) -> bool:
        return model_name in self.loaded_models.keys()

    def can_load_model(self, model_size_bytes: int) -> bool:
        if model_size_bytes <= 0:
            return True
        return self.gpu_free_bytes() >= int(model_size_bytes)

    def wait_for_free_space(self, size_needed_bytes: int, timeout: float = 3.0, poll_interval: float = 0.05) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.can_load_model(size_needed_bytes):
                return True
            time.sleep(poll_interval)
        return False

    def getLoadedModel(self, model_name: str):
        return self.loaded_models.get(model_name, None)

    # ---------------------------
    # LOAD MODEL (REAL + SIM MODE)
    # ---------------------------
    def load_model(self, model_name: str, model_size_bytes: int, model_precision: str):
        model_size_bytes = int(model_size_bytes)

        # ============================================================
        # DEBUG MODE → simulate only, do NOT load real model
        # ============================================================
        if IS_DEBUG:
            if self.is_model_loaded(model_name):
                self.mark_used(model_name)
                return ("tokenizer_sim", "model_sim")

            if not self.can_load_model(model_size_bytes):
                print(f"[SIM] Not enough VRAM for {model_name}. Evicting...")
                self.evict_until_fit(model_size_bytes)

            self.sim_free -= model_size_bytes

            print(f"[SIM] Loading model into GPU: {model_name}")

            self.loaded_models[model_name] = {
                "size": model_size_bytes,
                "last_used": time.time(),
                "load_time": time.time(),
                "use_count": 1,
                "object": ("tokenizer_sim", "model_sim"),
            }
            return ("tokenizer_sim", "model_sim")

        # ============================================================
        # REAL GPU LOAD
        # ============================================================
        if self.is_model_loaded(model_name):
            self.mark_used(model_name)
            return self.loaded_models[model_name]["object"]

        if not self.can_load_model(model_size_bytes):
            print(f"⚠️ Not enough VRAM for {model_name}. Evicting...")
            self.evict_until_fit(model_size_bytes)

        tried_once = False

        while True:
            try:
                print(f"🚀 Loading model into GPU: {model_name}")

                tokenizer = AutoTokenizer.from_pretrained(
                    model_name,
                    trust_remote_code=True,
                    cache_dir=CACHE
                )

                if tokenizer.pad_token is None:
                    if tokenizer.eos_token:
                        tokenizer.pad_token = tokenizer.eos_token
                    else:
                        tokenizer.add_special_tokens({"pad_token": "[PAD]"})

                model = AutoModelForCausalLM.from_pretrained(
                    model_name,
                    torch_dtype=torch.float16 if model_precision == "float16" else torch.bfloat16,
                    device_map={"": "cuda:0"},
                    trust_remote_code=True,
                    cache_dir=CACHE,
                    pad_token_id=tokenizer.pad_token_id
                )

                if hasattr(model, "resize_token_embeddings"):
                    model.resize_token_embeddings(len(tokenizer))

                model.eval()

                self.loaded_models[model_name] = {
                    "size": model_size_bytes,
                    "last_used": time.time(),
                    "load_time": time.time(),
                    "use_count": 1,
                    "object": (tokenizer, model),
                }
                return tokenizer, model

            except RuntimeError as e:
                msg = str(e)

                if "CUDA out of memory" in msg or "out of memory" in msg.lower():
                    print(f"❌ OOM while loading {model_name}. Attempting recovery...")

                    torch.cuda.empty_cache()
                    gc.collect()

                    if not tried_once:
                        tried_once = True
                        self.evict_until_fit(model_size_bytes)
                        print("🔁 Retrying model load after eviction...")
                        continue
                    else:
                        print(f"⛔ Model {model_name} cannot fit even after eviction.")
                        return None

                raise e

            except Exception:
                print(f"❌ Unexpected failure loading {model_name}")
                torch.cuda.empty_cache()
                gc.collect()
                return None

    def mark_used(self, model_name: str):
        if model_name in self.loaded_models:
            self.loaded_models[model_name]["last_used"] = time.time()
            self.loaded_models[model_name]["use_count"] += 1

    # ---------------------------
    # UNLOAD MODEL (REAL + SIM MODE)
    # ---------------------------
    def unload_model(self, model_name: str, wait_for_nvml: bool = True, wait_timeout: float = 3.0):
        if model_name not in self.loaded_models:
            return

        # ============================================================
        # DEBUG MODE → simulate
        # ============================================================
        if IS_DEBUG:
            entry = self.loaded_models.pop(model_name)
            size = entry["size"]
            self.sim_free += size
            print(f"[SIM] Unloading model: {model_name} (+{size/(1024**3):.2f} GB)")
            return

        # ============================================================
        # REAL GPU UNLOAD
        # ============================================================
        print(f"🧹 Unloading model (safe): {model_name}")

        entry = self.loaded_models.get(model_name)
        tokenizer, model = entry["object"]

        try:
            self.loaded_models.pop(model_name, None)
        except Exception:
            pass

        if torch.cuda.is_available():
            try:
                torch.cuda.synchronize()
            except Exception as e:
                print(f"⚠️ torch.cuda.synchronize failed: {e}")

        moved = False
        try:
            model.to("cpu")
            moved = True
        except Exception as e:
            print(f"⚠️ model.to('cpu') failed ({e}); falling back to per-tensor CPU move")
            try:
                for p in model.parameters():
                    try:
                        p.data = p.data.cpu()
                    except Exception:
                        pass
                for b in model.buffers():
                    try:
                        b.data = b.data.cpu()
                    except Exception:
                        pass
                moved = True
            except Exception as ee:
                print(f"⚠️ Per-tensor CPU move also failed: {ee}")

        try:
            del tokenizer
        except Exception:
            pass
        try:
            del model
        except Exception:
            pass

        gc.collect()

        if torch.cuda.is_available():
            try:
                torch.cuda.empty_cache()
            except Exception:
                pass
            try:
                torch.cuda.ipc_collect()
            except Exception:
                pass

        if wait_for_nvml:
            ok = self.wait_for_free_space(size_needed_bytes=1, timeout=wait_timeout)
            if not ok:
                print("⚠️ NVML did not detect expected free memory in time")

        time.sleep(0.05)

    # ---------------------------
    # Eviction
    # ---------------------------
    def evict_one_model(self, reason: str = None) -> bool:
        if not self.loaded_models:
            return False

        if MEMORY_REPLACEMENT_STRATEGY == MemoryReplacementStrategy.LRU:
            victim = min(self.loaded_models.items(), key=lambda kv: kv[1]["last_used"])[0]
        elif MEMORY_REPLACEMENT_STRATEGY == MemoryReplacementStrategy.LFU:
            victim = min(self.loaded_models.items(), key=lambda kv: kv[1]["use_count"])[0]
        elif MEMORY_REPLACEMENT_STRATEGY == MemoryReplacementStrategy.FIFO:
            victim = min(self.loaded_models.items(), key=lambda kv: kv[1]["load_time"])[0]
        elif MEMORY_REPLACEMENT_STRATEGY == MemoryReplacementStrategy.LARGEST_FIRST:
            victim = max(self.loaded_models.items(), key=lambda kv: kv[1]["size"])[0]
        else:
            victim = min(self.loaded_models.items(), key=lambda kv: kv[1]["last_used"])[0]

        victim_size = int(self.loaded_models[victim]["size"])
        print(f"🗑️  Evicting '{victim}' ({victim_size/(1024**3):.3f} GB) — reason: {reason}")
        self.unload_model(victim)
        return True

    def evict_until_fit(self, size_needed_bytes: int):
        size_needed_bytes = int(size_needed_bytes)

        if self.can_load_model(size_needed_bytes):
            return

        while not self.can_load_model(size_needed_bytes):
            evicted = self.evict_one_model(reason=f"need {size_needed_bytes/(1024**3):.3f} GB")
            if not evicted:
                break

        if not self.can_load_model(size_needed_bytes):
            self.print_diagnostics(prefix="[evict_until_fit failed] ")
            raise RuntimeError(
                f"Unable to free {size_needed_bytes/(1024**3):.2f} GB. NVML free(safe): {self.gpu_free_bytes()/(1024**3):.4f} GB, manager used: {self.used_memory()/(1024**3):.4f} GB"
            )

    # ---------------------------
    # Convenience for printing state
    # ---------------------------
    def print_memory_state(self):
        gpu_total = self.gpu_total_bytes()
        gpu_free_raw = self.gpu_free_bytes_raw()
        gpu_free_safe = self.gpu_free_bytes()
        print("\n===== 🎮 GPU Memory State =====")
        print(f"Total VRAM:        {gpu_total / (1024 ** 3):,.2f} GB")
        print(f"Free VRAM (raw):   {gpu_free_raw / (1024 ** 3):,.2f} GB")
        print(f"Free VRAM (safe):  {gpu_free_safe / (1024 ** 3):,.2f} GB")
        print(f"Used by Manager:   {self.used_memory() / (1024 ** 3):,.2f} GB")
        print(f"Loaded Models:     {len(self.loaded_models)}\n")
        for name, info in self.loaded_models.items():
            print(f"📦 {name}")
            print(f"    Size:      {info['size'] / (1024 ** 3):,.2f} GB")
            print(f"    Last used: {time.strftime('%H:%M:%S', time.localtime(info['last_used']))}")
            print(f"    Use count: {info['use_count']}")
        print("===============================\n")
