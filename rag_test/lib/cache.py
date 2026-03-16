"""
Semantic Cache — Blog architecture.
Caches query results using embedding similarity.
If a very similar query was asked before, returns cached results.

Optional — requires Redis. Falls back gracefully if unavailable.
"""
import time
import json
import hashlib
from typing import Optional, Dict, List

import numpy as np

try:
    import redis
    REDIS_AVAILABLE = True
except ImportError:
    REDIS_AVAILABLE = False

from config import Config


class SemanticCache:
    """Redis-backed semantic cache for RAG queries."""

    def __init__(self):
        self.enabled = False
        self.threshold = Config.CACHE_SIMILARITY_THRESHOLD

        if not REDIS_AVAILABLE:
            print("[Cache] Redis not available. Cache disabled.")
            return

        try:
            self.redis = redis.from_url(Config.REDIS_URL, decode_responses=False)
            self.redis.ping()
            self.enabled = True
            print("[Cache] Connected to Redis")
        except Exception as e:
            print(f"[Cache] Redis connection failed: {e}. Cache disabled.")

    def get(self, query_embedding: np.ndarray) -> Optional[Dict]:
        """Check if a similar query exists in cache."""
        if not self.enabled:
            return None

        cache_keys = self.redis.keys(b"rag_cache:*")
        best_match = None
        highest_sim = 0.0

        for key in cache_keys[:200]:  # Limit scan for performance
            cached = self.redis.hgetall(key)
            if not cached or b"embedding" not in cached:
                continue

            cached_emb = np.frombuffer(cached[b"embedding"], dtype=np.float32)

            # Cosine similarity
            sim = float(
                np.dot(query_embedding, cached_emb)
                / (np.linalg.norm(query_embedding) * np.linalg.norm(cached_emb) + 1e-8)
            )

            if sim >= self.threshold and sim > highest_sim:
                highest_sim = sim
                best_match = {
                    "answer": cached[b"answer"].decode("utf-8"),
                    "sources": json.loads(cached[b"sources"].decode("utf-8")),
                    "cache_hit": True,
                    "similarity": sim,
                }

        return best_match

    def set(
        self,
        query: str,
        query_embedding: np.ndarray,
        answer: str,
        sources: List[Dict],
        ttl: int = 3600,
    ):
        """Cache a query result."""
        if not self.enabled:
            return

        cache_key = f"rag_cache:{hashlib.sha256(query.encode()).hexdigest()[:16]}"

        # Make sources JSON-serializable
        safe_sources = []
        for s in sources:
            safe_sources.append({
                k: (float(v) if isinstance(v, (np.floating, float)) else v)
                for k, v in s.items()
            })

        self.redis.hset(
            cache_key,
            mapping={
                "query": query.encode("utf-8"),
                "embedding": query_embedding.tobytes(),
                "answer": answer.encode("utf-8"),
                "sources": json.dumps(safe_sources).encode("utf-8"),
                "timestamp": str(time.time()).encode("utf-8"),
            },
        )
        self.redis.expire(cache_key, ttl)

    def clear(self):
        """Clear all cached entries."""
        if not self.enabled:
            return
        keys = self.redis.keys(b"rag_cache:*")
        if keys:
            self.redis.delete(*keys)
            print(f"[Cache] Cleared {len(keys)} entries")
