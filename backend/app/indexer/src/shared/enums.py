from enum import Enum

class SystemStatusModel(Enum):
    OS = 'os'
    ARCHITECTURE = 'architecture'
    CPU_COUNT = 'cpu_count'
    GPU_TOTAL = 'gpu_total'
    GPU_AVAILABLE = 'gpu_available'
    DISK_FREE = 'disk_free'
    GPU = 'gpu'

class LLMModel(Enum):
    FILE_NAME = "file_name"
    FILE_PATH = "file_path"
    FILE_SIZE = "file_size"

class Classifiers(Enum):
    REASONING = "reasoning"
    KNOWLEDGE = "knowledge"
    INSTRUCTION_FOLLOWING = "instruction_following"
    MATH = "math"
    MULTIMODAL = "multimodal"
    GENERAL = "general"

class MemoryReplacementStrategy(Enum):
    LRU = "lru" # Least Recently Used
    LFU = "lfu" # Least Frequently Used
    FIFO = "fifo" # First In First Out
    LARGEST_FIRST = "largest_first" # Largest First