from pprint import pprint
import warnings

warnings.filterwarnings("ignore")

import sys
import re
import string
import ollama
import numpy as np
import pandas as pd
from pathlib import Path
from collections import Counter
from src.main import FAULTY_MODELS, getIndexerModels, getLoadedModel, printMemoryState, unloadModel, useModel
from src.main import init as initialize_indexer
from sklearn.metrics.pairwise import cosine_similarity
from src.shared.config import PICK_TOP_N_MODELS, IS_DEBUG

import torch
torch.backends.cuda.enable_flash_sdp(False)
torch.backends.cuda.enable_mem_efficient_sdp(False)
torch.backends.cuda.enable_math_sdp(True)

ALPHA = 1
BETA = 0.5
GAMMA = 0.5
NUMBER_OF_QUESTIONS = 100

QUERY = None

IS_INDEXER = True
MODEL = "deepseek-r1:latest"

system = """You are a concise and direct assistant. Provide brief, to-the-point answers 
with minimal elaboration. Strive to be factually correct, and explicitly state 
when you are unsure. Avoid mentioning that you are an AI model or adding 
unnecessary disclaimers. Focus on clarity, correctness, and relevance above all."""

##############################################################################
# F1 SCORING FUNCTIONS
##############################################################################
def normalize_answer(text: str) -> str:
    """
    Lowercases, removes punctuation, articles ('a', 'an', 'the'),
    and extra whitespace. Mimics the SQuAD approach for F1 scoring.
    """

    # 1. Lowercase
    text = str(text).lower()

    # 2. Remove punctuation
    text = "".join(ch for ch in text if ch not in set(string.punctuation))
    # 3. Remove articles
    text = re.sub(r"\b(a|an|the)\b", " ", text)
    # 4. Remove extra whitespace
    text = " ".join(text.split())
    return text

def f1_score_single_ref(prediction: str, ground_truth: str) -> float:
    """
    Computes token-level F1 between prediction and a single reference answer.
    """
    pred_tokens = normalize_answer(prediction).split()
    gold_tokens = normalize_answer(ground_truth).split()

    if not pred_tokens and not gold_tokens:
        return 1.0  # Both are empty

    if not pred_tokens or not gold_tokens:
        return 0.0  # One is empty, the other is not

    pred_counts = Counter(pred_tokens)
    gold_counts = Counter(gold_tokens)

    overlap_count = sum(
        min(pred_counts[tok], gold_counts[tok])
        for tok in pred_counts.keys() & gold_counts.keys()
    )

    precision = overlap_count / len(pred_tokens) if pred_tokens else 0.0
    recall = overlap_count / len(gold_tokens) if gold_tokens else 0.0

    if precision + recall == 0:
        return 0.0

    return 2 * (precision * recall) / (precision + recall)

def f1_score_multi_ref(prediction: str, ground_truths: list[str]) -> float:
    """
    Computes the max F1 score between the prediction and multiple valid references.
    """
    if not ground_truths:
        return 0.0
    return max(f1_score_single_ref(prediction, gt) for gt in ground_truths)


##############################################################################
# EMBEDDING UTILS
##############################################################################
def flatten_embedding(emb):
    """
    Recursively converts nested sequences into a flat NumPy array.
    """
    if isinstance(emb, np.ndarray) and emb.dtype == object:
        return np.vstack([flatten_embedding(x) for x in emb])
    elif isinstance(emb, list):
        if len(emb) == 1 and isinstance(emb[0], (list, np.ndarray)):
            return flatten_embedding(emb[0])
        if len(emb) > 0 and isinstance(emb[0], (list, np.ndarray)):
            return np.vstack([flatten_embedding(x) for x in emb])
        else:
            return np.array(emb, dtype=np.float32)
    else:
        return np.array(emb, dtype=np.float32)

def process_embedding(emb, expected_ndim):
    """
    Processes stored embeddings to ensure correct dimensionality.
    """
    arr = flatten_embedding(emb)
    if expected_ndim == 1:
        arr = arr.flatten()
    elif expected_ndim == 2:
        if arr.ndim == 1:
            arr = arr.reshape(1, -1)
    return arr

def get_embeddings(texts):
    """
    Returns embeddings for a single text string or a list of strings.
    """
    if isinstance(texts, str):
        response = ollama.embed(model="mxbai-embed-large", input=texts)
        return np.array(response.get("embeddings", []), dtype=np.float32)
    elif isinstance(texts, list):
        embeddings = []
        for text in texts:
            response = ollama.embed(model="mxbai-embed-large", input=text)
            embeddings.append(
                np.array(response.get("embeddings", []), dtype=np.float32)
            )
        return np.array(embeddings)
    else:
        raise ValueError("Input must be a string or a list of strings")


##############################################################################
# SCORING FUNCTION
##############################################################################
def vectorized_similarity(model_emb, answer_embs):
    """
    Computes the sum of cosine similarities between model_emb and each vector in answer_embs.
    """
    if answer_embs.size == 0:
        return 0
    if answer_embs.ndim == 1:
        answer_embs = answer_embs.reshape(1, -1)
    model_emb = model_emb.reshape(1, -1)
    sims = cosine_similarity(model_emb, answer_embs)[0]
    return np.sum(sims)

def accuracy_metric(model_emb, best_emb, correct_embs, incorrect_embs):
    """
    Embedding-based reward = alpha * sim(best_answer)
                            + beta * mean(sim(correct_answers))
                            - gamma * mean(sim(incorrect_answers)).
    """
    best_emb = process_embedding(best_emb, expected_ndim=1)
    correct_embs = process_embedding(correct_embs, expected_ndim=2)
    incorrect_embs = process_embedding(incorrect_embs, expected_ndim=2)

    best_score = (
        cosine_similarity(model_emb.reshape(1, -1), best_emb.reshape(1, -1))[0][0]
        * ALPHA
    )

    correct_score = 0
    if correct_embs.size:
        correct_score = vectorized_similarity(model_emb, correct_embs) * (
            BETA / correct_embs.shape[0]
        )

    incorrect_score = 0
    if incorrect_embs.size:
        incorrect_score = vectorized_similarity(model_emb, incorrect_embs) * (
            GAMMA / incorrect_embs.shape[0]
        )

    return best_score + correct_score - incorrect_score


##############################################################################
# LOAD MODEL AND RUN QUERY
##############################################################################
def run_query_on_model(model_id: str):
    global QUERY

    model_object = getLoadedModel(model_id)

    tokenizer, model = model_object["object"]

    # inputs = tokenizer(QUERY, return_tensors="pt").to(model.device)

    # outputs = model.generate(
    #     **inputs,
    #     max_new_tokens=2048,
    #     do_sample=True,
    #     temperature=0.7,
    #     pad_token_id=tokenizer.eos_token_id  
    # )

    # text = tokenizer.decode(outputs[0], skip_special_tokens=True)

    # input_tokens = inputs["input_ids"].shape[1]
    # total_tokens = outputs[0].shape[0]
    # eval_count = total_tokens - input_tokens

    # return text, eval_count

    try:
        with torch.no_grad():
            # Always create attention mask explicitly — prevents SDPA crashes
            inputs = tokenizer(
                QUERY,
                return_tensors="pt",
                padding=True,
                truncation=True
            )
            inputs["attention_mask"] = (inputs["input_ids"] != tokenizer.pad_token_id).long()

            # Move inputs to GPU
            inputs = {k: v.to(model.device) for k, v in inputs.items()}

            outputs = model.generate(
                **inputs,
                max_new_tokens=2048,
                do_sample=True,
                temperature=0.7,
                pad_token_id=tokenizer.pad_token_id
            )

            torch.cuda.synchronize()

            text = tokenizer.decode(outputs[0], skip_special_tokens=True)
            input_tokens = inputs["input_ids"].shape[1]
            total_tokens = outputs[0].shape[0]
            eval_count = total_tokens - input_tokens

            return text, eval_count

    except RuntimeError as e:
        msg = str(e).lower()

        # Universal catch for device-side assert
        if "device-side assert" in msg or "illegal memory access" in msg:
            print(f"⚠️ GPU assert during generation on model {model_id}. Resetting CUDA.")
            torch.cuda.empty_cache()
            return None, 0

        raise


##############################################################################
# REWARD CALCULATIONS   
##############################################################################
def calculate_reward_and_f1(row, best_answer_text, correct_answers_list, incorrect_answers_list, model_output):
    model_emb = get_embeddings(model_output)
    torch.cuda.synchronize()

    reward = accuracy_metric(
            model_emb, row["best_emb"], row["correct_embs"], row["incorrect_embs"]
        )

    correct_f1 = f1_score_multi_ref(model_output, correct_answers_list) or 0.0
    best_f1 = f1_score_single_ref(model_output, best_answer_text) or 0.0
    incorrect_f1 = f1_score_multi_ref(model_output, incorrect_answers_list) or 0.0

        # Compute the final F1 score using a weighted approach
    f1 = (correct_f1 + best_f1) / 2  # Give equal weight to correct and best answer
    f1 -= 0.5 * incorrect_f1  # Apply a softer penalty for incorrect answers

        # Ensure F1 is at least 0
    f1 = max(f1, 0.0)
    return reward,f1


##############################################################################
# PRINTS
##############################################################################
def print_question_summary(idx, model_output, tokens_used, reward, f1):
    print(
            f"Question #{idx} | Response: {model_output} | Reward: {reward:.4f} "
            f"| F1: {f1:.4f} | Tokens used: {tokens_used}\n----------------------------"
        )


##############################################################################
# MAIN
##############################################################################
def main():
    ###### terminates if unresponsiive
    import sys, time, threading, os, signal

    last = time.time()

    def heartbeat(frame, event, arg):
        global last
        last = time.time()
        return heartbeat

    sys.settrace(heartbeat)

    def watchdog():
        global last
        while True:
            time.sleep(5)
            if time.time() - last > 120:
                print("Watchdog: No activity for 2 minutes. Killing.")
                os.kill(os.getpid(), signal.SIGKILL)

    threading.Thread(target=watchdog, daemon=True).start()
    ###### terminates if unresponsiive

    global MODEL
    global IS_INDEXER
    global QUERY
    global PICK_TOP_N_MODELS
    # init indexer
    if(IS_INDEXER):
        initialize_indexer()

    data = pd.read_parquet(
        Path("src/evaluation/truthful_qa/generation/validation-00000-of-00001.parquet")
    ).head(NUMBER_OF_QUESTIONS)

    data = (
        data[["question", "best_answer", "correct_answers", "incorrect_answers"]]
        .dropna()
        .reset_index(drop=True)
    )

    embeddings_path = Path("src/evaluation/truthful_qa/generation/embeddings_data.parquet")

    # Try loading existing parquet with text + embeddings
    try:
        embeddings_data = pd.read_parquet(embeddings_path).head(NUMBER_OF_QUESTIONS)
        print("Loaded embeddings_data from parquet file.\n----------------------------")
    except Exception as e:
        print("Embeddings file not found. Start embedding the data.")
        embeddings_list = []
        for _, row in data.iterrows():
            QUERY = row["question"]
            best_answer_text = row["best_answer"]
            # Ensure correct_answers & incorrect_answers are lists
            # Make sure correct_answers_list is a list of strings
            correct_answers_list = row["correct_answers"]
            if not isinstance(correct_answers_list, list):
                correct_answers_list = [correct_answers_list]
            correct_answers_list = [str(ans) for ans in correct_answers_list]

            # Make sure incorrect_answers_list is a list of strings
            incorrect_answers_list = row["incorrect_answers"]
            if not isinstance(incorrect_answers_list, list):
                incorrect_answers_list = [incorrect_answers_list]
            incorrect_answers_list = [str(ans) for ans in incorrect_answers_list]

            embeddings_list.append(
                {
                    "question": QUERY,
                    "best_answer": best_answer_text,
                    "correct_answers": correct_answers_list,
                    "incorrect_answers": incorrect_answers_list,
                    "question_emb": get_embeddings(QUERY).tolist(),
                    "best_emb": get_embeddings(best_answer_text).tolist(),
                    "correct_embs": get_embeddings(correct_answers_list).tolist(),
                    "incorrect_embs": get_embeddings(incorrect_answers_list).tolist(),
                }
            )

        embeddings_data = pd.DataFrame(embeddings_list)
        embeddings_data.to_parquet(embeddings_path)
        print("Embeddings data saved to parquet file")

    results = []
    allModelsUsedData = []
    # We no longer need the original 'data'
    del data

    for idx, row in embeddings_data.iterrows():
        if(IS_INDEXER):
            printMemoryState()

        QUERY = row["question"]
        best_answer_text = row["best_answer"]
        correct_answers_list = row["correct_answers"]
        incorrect_answers_list = row["incorrect_answers"]
        if not isinstance(correct_answers_list, list):
            correct_answers_list = [correct_answers_list]
        if not isinstance(incorrect_answers_list, list):
            incorrect_answers_list = [incorrect_answers_list]

        # Generate model output
        print(f"Processing question : {QUERY}...")
        if(IS_INDEXER):
            indexer_models = getIndexerModels(QUERY)
            modelsUsed = 0
            modelsUsedData = []
            for indexer_model in indexer_models:
                if(indexer_model.fullname in FAULTY_MODELS):
                    print(f"Skipping previously faulty model: {indexer_model.fullname}")
                    continue
                try:
                    if IS_DEBUG:
                        # print("-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-\n")
                        # print("Trying model:", indexer_model.fullname)
                        # print(indexer_model)
                        # input()

                        print("Using model:", indexer_model.fullname)
                        
                        useModel(indexer_model)

                        # print("Model loaded and in use. Generate response?")
                        # input()

                        model_output, tokens_used = run_query_on_model(indexer_model.fullname)

                        # print(model_output)
                        # input()

                        modelsUsed += 1

                        # Get embedding-based reward
                        reward, f1 = calculate_reward_and_f1(row, best_answer_text, correct_answers_list, incorrect_answers_list, model_output)
                        indexer_model.reward = reward
                        indexer_model.f1 = f1
                        indexer_model.tokens_used = tokens_used

                        # print("i calculated reward and f1")
                        # input()
    
                        print_question_summary(idx, model_output, tokens_used, reward, f1)
                        # print("models used so far:", modelsUsed)
                        model = {
                            "question": idx,
                            "model_fullname": indexer_model.fullname,
                            "response": model_output,
                            "reward": reward,
                            "f1_score": f1,
                            "tokens_used": tokens_used,
                            "size_gb": indexer_model.size / (1024**3),
                        }
                        allModelsUsedData.append(model)
                        modelsUsedData.append(model)

                    if modelsUsed == PICK_TOP_N_MODELS:
                        avgReward = sum(m["reward"] for m in modelsUsedData) / PICK_TOP_N_MODELS
                        avgF1 = sum(m["f1_score"] for m in modelsUsedData) / PICK_TOP_N_MODELS
                        avgSizeGB = sum(m["size_gb"] for m in modelsUsedData) / PICK_TOP_N_MODELS
                        avgTokensUsed = sum(m["tokens_used"] for m in modelsUsedData) / PICK_TOP_N_MODELS

                        reward, f1, size_gb, tokens_used =  avgReward, avgF1, avgSizeGB, avgTokensUsed

                        break

                except Exception as e:
                    print(e)
                    print(f"⚠️ Error loading {indexer_model.fullname}")
                    FAULTY_MODELS.append(indexer_model.fullname)
                    unloadModel(indexer_model.fullname)
                    continue

        else:
            resp = ollama.generate(model=MODEL, prompt=QUERY, system=system)
            model_output = resp.get("response", "").strip()
            tokens_used = resp.get("eval_count")

            # Get embedding-based reward
            reward, f1 = calculate_reward_and_f1(row, best_answer_text, correct_answers_list, incorrect_answers_list, model_output)
            
            print_question_summary(idx, model_output, tokens_used, reward, f1)

        results.append(
            {
                "question": idx,
                "response": model_output,
                "reward": reward,
                "f1_score": f1,
                "tokens_used": tokens_used,
                "size_gb": size_gb if IS_INDEXER else None,
            }
        )

    results_df = pd.DataFrame(results)
    results_df.to_csv(
        Path(
            "src/evaluation_results.csv"
        ),
        index=False,
    )

    allModelsUsedData_df = pd.DataFrame(allModelsUsedData)
    allModelsUsedData_df.to_csv(
        Path(
            "src/evaluation_models_used_details.csv"
        ),
        index=False,
    )

    # Cleanup
    del results_df
    del results

if __name__ == "__main__":
    main()
