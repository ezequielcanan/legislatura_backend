"""
Embedding client — wraps OpenRouter / OpenAI compatible API
for text-embedding-3-small (1536 dims).
"""
import time
import requests
import numpy as np
from typing import List
from config import Config


def embed_texts(texts: List[str], batch_size: int = 50) -> List[np.ndarray]:
    """
    Embed a list of texts using OpenRouter's embedding API.
    Returns list of numpy arrays (float32, 1536 dims).
    Handles batching and rate-limiting automatically.
    """
    all_embeddings: List[np.ndarray] = []

    for i in range(0, len(texts), batch_size):
        batch = texts[i : i + batch_size]
        batch_embeddings = _call_embedding_api(batch)
        all_embeddings.extend(batch_embeddings)

        # Small delay between batches to avoid rate limits
        if i + batch_size < len(texts):
            time.sleep(0.5)

    return all_embeddings


def embed_single(text: str) -> np.ndarray:
    """Embed a single text string."""
    result = _call_embedding_api([text])
    return result[0]


def _call_embedding_api(texts: List[str]) -> List[np.ndarray]:
    """Call the OpenRouter/OpenAI embedding endpoint."""
    url = f"{Config.OPENROUTER_API_URL}/embeddings"
    headers = {
        "Authorization": f"Bearer {Config.OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": Config.OPENROUTER_EMBEDDING_MODEL,
        "input": texts,
    }

    resp = requests.post(url, json=payload, headers=headers, timeout=60)
    resp.raise_for_status()
    data = resp.json()

    # Sort by index to guarantee order
    sorted_data = sorted(data["data"], key=lambda x: x["index"])
    return [np.array(item["embedding"], dtype=np.float32) for item in sorted_data]
