from pprint import pprint

from src.shared.config import DUMMY_GPU_MEMORY, IS_DEBUG
from ...shared.enums import SystemStatusModel
import platform
import psutil
import shutil

if not IS_DEBUG:
    from pynvml import (
        nvmlInit,
        nvmlDeviceGetHandleByIndex,
        nvmlDeviceGetMemoryInfo,
    )
    try:
        nvmlInit()
        _HAS_GPU = True
    except Exception:
        _HAS_GPU = False

def get_system_status():
    status = {
        SystemStatusModel.OS: platform.system(),
        SystemStatusModel.ARCHITECTURE: platform.machine(),
        SystemStatusModel.CPU_COUNT: psutil.cpu_count(logical=True),
        SystemStatusModel.DISK_FREE: shutil.disk_usage('/').free,
    }

    if IS_DEBUG:
        fake_total = DUMMY_GPU_MEMORY
        gpu_stats = {
            "gpu_total": fake_total,
            "gpu_used": 0,
            "gpu_free": fake_total,
        }
        status[SystemStatusModel.GPU] = gpu_stats
        status[SystemStatusModel.GPU_TOTAL] = fake_total
        status[SystemStatusModel.GPU_AVAILABLE] = fake_total
        return status

    if _HAS_GPU:
        handle = nvmlDeviceGetHandleByIndex(0)
        mem = nvmlDeviceGetMemoryInfo(handle)
        gpu_stats = {
            "gpu_total": mem.total,
            "gpu_used": mem.used,
            "gpu_free": mem.free,
        }
        status[SystemStatusModel.GPU] = gpu_stats
        status[SystemStatusModel.GPU_TOTAL] = gpu_stats["gpu_total"]
        status[SystemStatusModel.GPU_AVAILABLE] = gpu_stats["gpu_free"]
    else:
        status[SystemStatusModel.GPU] = None
        status[SystemStatusModel.GPU_TOTAL] = None
        status[SystemStatusModel.GPU_AVAILABLE] = None
    return status