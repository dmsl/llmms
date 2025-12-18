from sentence_transformers import SentenceTransformer, util
from src.shared.config import GENERAL_CLASSIFIER_SAFETY_FACTOR
from src.shared.enums import Classifiers
import numpy as np

_model_cache = None

def load_model():
    global _model_cache
    if _model_cache is None:
        _model_cache = SentenceTransformer('all-MiniLM-L6-v2', device='cpu')
    return _model_cache
    # return SentenceTransformer('all-MiniLM-L6-v2')

def query_classification(query):
    model = load_model()

    # Define categories and descriptions
    categories = {
        Classifiers.REASONING: "logical reasoning, explanation, deduction",
        Classifiers.KNOWLEDGE: "factual knowledge, general information, quizzes",
        Classifiers.INSTRUCTION_FOLLOWING: "following instructions, performing steps",
        Classifiers.MATH: "solving mathematical problems, equations, integrals",
        Classifiers.MULTIMODAL: "image, video, sound, multimodal tasks"
    }

    category_names = list(categories.keys())
    category_texts = list(categories.values())

    # Compute embeddings
    query_emb = model.encode(query, convert_to_tensor=True)
    category_embs = model.encode(category_texts, convert_to_tensor=True)

    # Compute cosine similarity
    cos_scores = util.cos_sim(query_emb, category_embs)[0]

    # Normalize to sum to 97%
    scores = np.array([float(s) for s in cos_scores])
    scores = scores - scores.min()       # make all values non-negative
    
    normalized_scores = scores / scores.sum()
    percentages = {category_names[i]: float(normalized_scores[i]*97) for i in range(len(category_names))}
    percentages[Classifiers.GENERAL] = GENERAL_CLASSIFIER_SAFETY_FACTOR # Assign a fixed percentage to GENERAL category

    # print("Query classification percentages:")
    # for cat, score in percentages.items():
    #     print(f"{cat}: {score:.1f}%")
    # print("-----")
    return percentages