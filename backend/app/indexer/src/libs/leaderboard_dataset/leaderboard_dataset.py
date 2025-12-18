from datasets import load_dataset
from src.shared.classes import Model
from src.shared.config import MODEL_SIZE_SAFETY_FACTOR, SHOULD_BE_OFICIAL_PROVIDER, DATASET

def load_hf_dataset():
    ds = load_dataset(DATASET, split="train", streaming=True)
    
    # # strictly limit models down to official
    if SHOULD_BE_OFICIAL_PROVIDER:
        ds = (model for model in ds if model.get('Official Providers', False) is True)

    # remove models with invalid weights
    ds = (model for model in ds if model.get('#Params (B)', 0) > 0)

    models = []
    for model in ds:
        models.append(modelInit(model))

    return models

def modelInit(model):
    return Model(
        name=model.get("fullname"),
        architecture=model.get("Architecture"),
        params_b=model.get("#Params (B)"),
        benchmarks=getBenchmarkResults(model),
        precision=model.get("Precision"),
        size=getEstimatedModelSize(model)
    )

def getEstimatedModelSize(model):
    precision_bytes = {
        "float32": 4,
        "float16": 2,
        "bfloat16": 2,
        "int8": 1,
        "4bit": 0.5,
    }

    params_b = model.get("#Params (B)", 0)
    params = params_b * 1e9  # Billion to raw count
    precision = model.get("Precision")
    weight_type = model.get("Weight type", "Original")

    bytes_per_param = precision_bytes.get(precision, 4)

    # Reduce size for quantized weights
    if weight_type.lower() in ["int8", "int4", "quantized"]:
        bytes_per_param = 1

    return params * bytes_per_param * MODEL_SIZE_SAFETY_FACTOR

def getBenchmarkResults(model):
    return {
        # https://dl.acm.org/doi/10.5555/3737916.3740934
        'MMLU-PRO Raw': model['MMLU-PRO Raw'],

        # https://github.com/suzgunmirac/BIG-Bench-Hard (https://arxiv.org/abs/2210.09261)
        'BBH Raw': model['BBH Raw'],

        # https://arxiv.org/abs/2311.12022
        'GPQA Raw': model['GPQA Raw'],

        # https://arxiv.org/abs/2311.07911
        'IFEval Raw': model['IFEval Raw'],

        # https://epoch.ai/benchmarks/math-level-5
        'MATH Lvl 5 Raw': model['MATH Lvl 5 Raw'],

        # https://arxiv.org/abs/2310.16049
        'MUSR Raw': model['MUSR Raw'],
        'Average': model['Average ⬆️']  # optional aggregate
    }