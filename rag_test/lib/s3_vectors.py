"""
Pinecone Vector Store — managed vector database for embeddings.

Replaces the S3 Vectors approach (not yet available in boto3) with
Pinecone Serverless, which the blog author also tested.

Free tier: 5 indexes, 2GB storage, unlimited reads/writes.
"""
import uuid
import time
from typing import List, Dict, Optional
import numpy as np
from pinecone import Pinecone, ServerlessSpec
from config import Config


class VectorStore:
    """
    Wraps the Pinecone client for:
    - Creating serverless indexes
    - Upserting vectors with metadata
    - Querying nearest neighbors (cosine similarity)
    """

    def __init__(self):
        self.pc = Pinecone(api_key=Config.PINECONE_API_KEY)
        self.index_name = Config.PINECONE_INDEX_NAME
        self.index = None

    # ── Setup ───────────────────────────────────────────────────

    def setup(self):
        """Create index if it doesn't exist, then connect."""
        existing = [idx.name for idx in self.pc.list_indexes()]

        if self.index_name not in existing:
            print(f"[Pinecone] Creating index: {self.index_name}")
            self.pc.create_index(
                name=self.index_name,
                dimension=Config.EMBEDDING_DIMS,
                metric="cosine",
                spec=ServerlessSpec(
                    cloud=Config.PINECONE_CLOUD,
                    region=Config.PINECONE_REGION,
                ),
            )
            # Wait for index to be ready
            print("[Pinecone] Waiting for index to be ready...")
            while not self.pc.describe_index(self.index_name).status["ready"]:
                time.sleep(2)
            print(f"[Pinecone] Index ready: {self.index_name}")
        else:
            print(f"[Pinecone] Index already exists: {self.index_name}")

        self.index = self.pc.Index(self.index_name)

    # ── Indexing ────────────────────────────────────────────────

    def upsert_vectors(
        self,
        vectors: List[Dict],
        batch_size: int = 100,
    ) -> int:
        """
        Upsert a list of vectors.  Each dict must have:
        - 'key': unique string ID
        - 'vector': np.ndarray or list of floats
        - 'metadata': dict with expedienteId, numero, tipo, etc.
        - 'text': the chunk text (stored in metadata for retrieval)
        """
        if self.index is None:
            self.setup()

        total = 0

        for i in range(0, len(vectors), batch_size):
            batch = vectors[i : i + batch_size]
            pinecone_vectors = []

            for v in batch:
                vec = v["vector"]
                if isinstance(vec, np.ndarray):
                    vec = vec.tolist()

                meta = v.get("metadata", {})
                # Pinecone metadata limit: ~40KB per vector
                # Truncate text to stay safe
                text = v.get("text", "")
                if len(text) > 30000:
                    text = text[:30000]

                pinecone_vectors.append({
                    "id": v.get("key", str(uuid.uuid4())),
                    "values": vec,
                    "metadata": {
                        "expedienteId": int(meta.get("expedienteId", 0)),
                        "numero": str(meta.get("numero", "")),
                        "tipo": str(meta.get("tipo", "")),
                        "chunkType": str(meta.get("chunkType", "CONTENT")),
                        "chunkIndex": int(meta.get("chunkIndex", 0)),
                        "aiCategory": str(meta.get("aiCategory", "")),
                        "text": text,
                    },
                })

            self.index.upsert(vectors=pinecone_vectors)
            total += len(pinecone_vectors)

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
        """
        if self.index is None:
            self.setup()

        vec = query_vector.tolist() if isinstance(query_vector, np.ndarray) else query_vector

        kwargs = {
            "vector": vec,
            "top_k": top_k,
            "include_metadata": True,
        }

        if filter_expr:
            kwargs["filter"] = filter_expr

        response = self.index.query(**kwargs)

        results = []
        for match in response.get("matches", []):
            meta = dict(match.get("metadata", {}))
            text = meta.pop("text", "")
            results.append({
                "key": match["id"],
                "score": match.get("score", 0.0),
                "text": text,
                "metadata": meta,
            })

        return results

    # ── Utilities ───────────────────────────────────────────────

    def delete_index(self):
        """Delete the index (destructive!)."""
        self.pc.delete_index(self.index_name)
        self.index = None
        print(f"[Pinecone] Deleted index: {self.index_name}")

    def get_index_stats(self) -> Dict:
        """Get stats about the index."""
        if self.index is None:
            self.setup()
        return self.index.describe_index_stats()

    def list_indexes(self) -> List[str]:
        """List all indexes in the Pinecone project."""
        return [idx.name for idx in self.pc.list_indexes()]
