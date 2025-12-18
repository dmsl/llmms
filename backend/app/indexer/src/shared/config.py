# setup config
from pathlib import Path

from src.shared.enums import Classifiers, MemoryReplacementStrategy
# https://huggingface.co/datasets/open-llm-leaderboard/contents/viewer/default/

GPU_SAFETY_FACTOR = 0.8  # Leave 20% of available gpu for other processes, os, overhead, etc.
MODEL_SIZE_SAFETY_FACTOR = 1.2  # Increase estimated model size by 20% for safety
GENERAL_CLASSIFIER_SAFETY_FACTOR = 3 # 3% goes to general classifier to smooth result

DATASET = "open-llm-leaderboard/contents"
CACHE = Path("./.cache/hf_models")

HF_TOKEN = "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"
# MODEL_DIR = Path("enter path to local models here")  # if you have local models, put the path here
# GGUF_METADATA_SIMILARITY_THRESHOLD = 0.7  # 70% similarity to consider same family
# UNUSED_FILES = "_DISABLED"

CATEGORY_TO_BENCHMARKS = {
    Classifiers.REASONING: ["MMLU-PRO Raw", "BBH Raw", "GPQA Raw"],
    Classifiers.KNOWLEDGE: ["MMLU-PRO Raw", "GPQA Raw"],
    Classifiers.INSTRUCTION_FOLLOWING: ["IFEval Raw"],
    Classifiers.MATH: ["MATH Lvl 5 Raw"],
    Classifiers.MULTIMODAL: ["MUSR Raw"],
    Classifiers.GENERAL: ["Average"]
}

# user config
QUERY = None

SHOULD_BE_OFICIAL_PROVIDER = False  # If true, use Huggingface official models only

SHOULD_FIT_IN_GPU = True  # If true, filter models based on size

SHOULD_USE_MEMORY_MANAGER = True
SHOULD_BE_MEMORY_AWARE = True  # If true, reuse models in memory if possible

LOADED_MODEL_BONUS = 3 # Percentage suitability boost for loaded models
MEMORY_REPLACEMENT_STRATEGY = MemoryReplacementStrategy.LRU
SUITABILITY_THRESHOLD = 0.01  # Consider models with suitability -0.01 of lowest top model as well
PICK_TOP_N_MODELS = 5

MEMORY_IMPORTANCE = 0 # Higher means prefer smaller models
QUALITY_IMPORTANCE = 100 - MEMORY_IMPORTANCE # Higher means prefer higher quality models (higher suitability)

IS_DEBUG = True
DUMMY_GPU_MEMORY = 32 * 1024 * 1024 * 1024  # 16 GB for debugging/testing


# def bold_print(text):
#     return f'\033[1m{text}\033[0m'

# def print_info():
#   print(bold_print('Metadata Comparison:'), 'helps identify if models are of same family')
#   print(bold_print('Blocks:'), 'how many layers the model has (blk.0, blk.1, ..., blk.29)')
#   print(bold_print('Attention:'), 'a way to decide which tokens are important to pay attention to during feed-forward')
#   print(bold_print('Query Q:'), 'the query. "Who is the president of Cyprus?"')
#   print(bold_print('Key K:'), 'the key. "Who is the president of Cyprus?"')
#   print(bold_print('Value V:'), 'the value. "Donald Trump"')
#   print(bold_print('Token Vectors:'), 'each token has Q K V')
#   print(bold_print('Q K V calculation:'), 'These are calculated on the fly, based on the attn_q.weight attn_k.weight attn_v.weight tensors on the gguf')
#   print(bold_print('Feed-forward:'), 'After attention, the layer knows which tokens are worth looking into, so it starts generating the output based on them ("Thinking" time)')
#   print(bold_print('ffn_up:'), 'Expands the token vector size. Each token vector now has more dimensions (size 4 becomes size 10 ex.) so the model has more room to play around.\nIt makes the token more detailed, defined, enhanced, sharp etc.')
#   print(bold_print('ffn_gate:'), 'By expanding the token vector size, the model can think far away from the query, so you use ffn_gate to set some boundaries as to not misbehave')
#   print(bold_print('ffn_down:'), 'Reduces the token vector size back to the original size')
#   print("User enters query. Query is tokenized. for the first layer, tokens are multiplied with", bold_print('token embedding weights'), "to create the token vectors.\nToken vectors are multiplied with the QKV attention weights to create the QKV pairs. For each token, its Q similarity with other tokens K is calculated.\nThe score is then multiplied with the V of the token who is used for K in the multiplication, and this value is the vector that will be passed to feed forward.\nThis value is passed through output and normalization to reduce its size and get the vector ready for feed forward")
#   print("Feed-forward gets the token vectors from attention.", bold_print("\nffn_up"), "is applied that expands the vector size, making the vector more defined/enhanced/sharp to give the model more room to play around.\nThis extra room added might cause the model to misbehave so", bold_print('ffn_gate'), "is applied to bound the model's response.\nIt somehow makes the new vectors for the output, and then", bold_print('ffn_down'), 'is applied to compress the vector size. These vectors are passed as the input for the next layer')

