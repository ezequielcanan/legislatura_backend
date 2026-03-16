"""
Qdrant Vector Store — managed vector database for embeddings.

Drop-in replacement for the Pinecone VectorStore (s3_vectors.py).
Connects to a self-hosted Qdrant instance on AWS EC2.

Same public API so the rest of the pipeline remains unchanged:
  - setup()
  - upsert_vectors(vectors, batch_size)
  - query(query_vector, top_k, filter_expr)
  - delete_collection()
  - get_collection_stats()
"""
import uuid
from typing import List, Dict, Optional

import numpy as np
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    VectorParams,
    PointStruct,
    Filter,
    FieldCondition,
    MatchValue,
)

from config import Config


class VectorStore:
    """
    Wraps the Qdrant client with the same interface as the Pinecone
    VectorStore so every consumer (hybrid_retriever, 02_embed_and_index,
    03_chatbot, etc.) works without changes.
    """

    def __init__(self):
        self.client = QdrantClient(
            url=Config.QDRANT_URL,
            timeout=60,
        )
        self.collection_name = Config.QDRANT_COLLECTION_NAME

    # ── Setup ───────────────────────────────────────────────────

    def setup(self):
        """Create collection if it doesn't exist."""
        existing = [c.name for c in self.client.get_collections().collections]

        if self.collection_name not in existing:
            print(f"[Qdrant] Creating collection: {self.collection_name}")
            self.client.create_collection(
                collection_name=self.collection_name,
                vectors_config=VectorParams(
                    size=Config.EMBEDDING_DIMS,
                    distance=Distance.COSINE,
                ),
            )
            # Create payload indexes for filterable fields
            for field in ("tipo", "aiCategory", "numero", "expedienteId"):
                self.client.create_payload_index(
                    collection_name=self.collection_name,
                    field_name=field,
                    field_schema="keyword",
                )
            print(f"[Qdrant] Collection ready: {self.collection_name}")
        else:
            print(f"[Qdrant] Collection already exists: {self.collection_name}")

    # ── Indexing ────────────────────────────────────────────────

    def upsert_vectors(
        self,
        vectors: List[Dict],
        batch_size: int = 100,
    ) -> int:
        """
        Upsert a list of vectors.  Each dict must have:
        - 'key':      unique string ID
        - 'vector':   np.ndarray or list of floats
        - 'text':     the chunk text (stored in payload for retrieval)
        - 'metadata': dict with expedienteId, numero, tipo, etc.
        """
        total = 0

        for i in range(0, len(vectors), batch_size):
            batch = vectors[i : i + batch_size]
            points: List[PointStruct] = []

            for v in batch:
                vec = v["vector"]
                if isinstance(vec, np.ndarray):
                    vec = vec.tolist()

                meta = v.get("metadata", {})
                text = v.get("text", "")
                if len(text) > 30000:
                    text = text[:30000]

                payload = {
                    "expedienteId": int(meta.get("expedienteId", 0)),
                    "numero": str(meta.get("numero", "")),
                    "tipo": str(meta.get("tipo", "")),
                    "chunkType": str(meta.get("chunkType", "CONTENT")),
                    "chunkIndex": int(meta.get("chunkIndex", 0)),
                    "aiCategory": str(meta.get("aiCategory", "")),
                    "text": text,
                }

                point_id = v.get("key", str(uuid.uuid4()))
                points.append(
                    PointStruct(
                        id=point_id,
                        vector=vec,
                        payload=payload,
                    )
                )

            self.client.upsert(
                collection_name=self.collection_name,
                points=points,
            )
            total += len(points)

        return total

    # ── Querying ────────────────────────────────────────────────

    def query(
        self,
        query_vector: np.ndarray,
        top_k: int = 30,
        filter_expr: Optional[Dict] = None,
    ) -> List[Dict]:
        """
        Query nearest neighbors.  Returns list of dicts:
        [{'key', 'score', 'metadata': {...}, 'text'}, ...]

        filter_expr follows the same format the pipeline already uses:
          {"tipo": {"$eq": "LEY"}, "aiCategory": {"$eq": "educación"}}
        We translate to Qdrant Filter on the fly.
        """
        vec = query_vector.tolist() if isinstance(query_vector, np.ndarray) else query_vector

        qdrant_filter = self._translate_filter(filter_expr) if filter_expr else None

        response = self.client.query_points(
            collection_name=self.collection_name,
            query=vec,
            limit=top_k,
            query_filter=qdrant_filter,
            with_payload=True,
        )

        results: List[Dict] = []
        for hit in response.points:
            payload = dict(hit.payload) if hit.payload else {}
            text = payload.pop("text", "")
            results.append({
                "key": str(hit.id),
                "score": hit.score,
                "text": text,
                "metadata": payload,
            })

        return results

    # ── Filter translation ──────────────────────────────────────

    @staticmethod
    def _translate_filter(filter_expr: Dict) -> Filter:
        """
        Convert Pinecone-style filter  {"field": {"$eq": value}}
        to a Qdrant Filter.
        """
        conditions = []
        for field, condition in filter_expr.items():
            if isinstance(condition, dict) and "$eq" in condition:
                conditions.append(
                    FieldCondition(
                        key=field,
                        match=MatchValue(value=condition["$eq"]),
                    )
                )
        return Filter(must=conditions) if conditions else None

    # ── Utilities ───────────────────────────────────────────────

    def delete_collection(self):
        """Delete the collection (destructive!)."""
        self.client.delete_collection(self.collection_name)
        print(f"[Qdrant] Deleted collection: {self.collection_name}")

    def get_collection_stats(self) -> Dict:
        """Get stats about the collection."""
        info = self.client.get_collection(self.collection_name)
        return {
            "points_count": info.points_count,
            "indexed_vectors_count": info.indexed_vectors_count,
            "status": info.status.value,
            "segments_count": info.segments_count,
        }

    def list_collections(self) -> List[str]:
        """List all collections in the Qdrant instance."""
        return [c.name for c in self.client.get_collections().collections]
