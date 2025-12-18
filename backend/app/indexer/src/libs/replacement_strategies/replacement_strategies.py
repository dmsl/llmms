
def lru_eviction(memory_manager, size_needed: float):
    while memory_manager.available_memory < size_needed and memory_manager.loaded_models:
        oldest = min(memory_manager.loaded_models.items(), key=lambda x: x[1]['last_used'])[0]
        print(f"Evicting (LRU): {oldest}")
        memory_manager.unload_model(oldest)


def lfu_eviction(memory_manager, size_needed: float):
    while memory_manager.available_memory < size_needed and memory_manager.loaded_models:
        least_used = min(memory_manager.loaded_models.items(), key=lambda x: x[1]['use_count'])[0]
        print(f"Evicting (LFU): {least_used}")
        memory_manager.unload_model(least_used)


def fifo_eviction(memory_manager, size_needed: float):
    while memory_manager.available_memory < size_needed and memory_manager.loaded_models:
        first_loaded = min(memory_manager.loaded_models.items(), key=lambda x: x[1]['load_time'])[0]
        print(f"Evicting (FIFO): {first_loaded}")
        memory_manager.unload_model(first_loaded)


def largest_first_eviction(memory_manager, size_needed: float):
    while memory_manager.available_memory < size_needed and memory_manager.loaded_models:
        largest = max(memory_manager.loaded_models.items(), key=lambda x: x[1]['size'])[0]
        print(f"Evicting (LargestFirst): {largest}")
        memory_manager.unload_model(largest)

