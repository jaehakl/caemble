import numpy as np
import torch

# GPU 디바이스 설정
device = 'cuda' if torch.cuda.is_available() else 'cpu'

def get_text_embedding(text: str):
    # get_text_embedding 함수가 처음 호출될 때만 SentenceTransformer 모듈과 모델을 동적으로 로드합니다.
    # (embedding.py가 import될 때는 아무런 리소스가 사용되지 않음)
    if not hasattr(get_text_embedding, "model"):
        print(f"Initializing Embedding Model on {device}")
        from sentence_transformers import SentenceTransformer
        model_name = "dragonkue/snowflake-arctic-embed-l-v2.0-ko"
        get_text_embedding.model = SentenceTransformer(model_name, device=device)

    model = get_text_embedding.model

    embeddings = model.encode([text])
    v = embeddings[0]
    norm = np.linalg.norm(v)
    normalized_embedding = v / norm
    return normalized_embedding.tolist()
