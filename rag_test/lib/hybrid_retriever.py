"""
Hybrid Retriever — Parallel architecture:
  1. Query analysis (filters + variants)
  2. Explicit expediente number matching
  3. [PARALLEL] Dense vector search (Qdrant) with metadata filters
  4. [PARALLEL] HyDE expansion + second vector search
  5. [PARALLEL] Multi-query expansion (batch embedding + query variants)
  6. [PARALLEL] Sparse BM25 keyword search (with Spanish stemming)
  7. Reciprocal Rank Fusion (RRF)
  8. Diversity-aware selection (metadata-based, replaces expensive MMR)
  9. Cross-encoder reranking (LLM-based)
  10. Parent-child chunk retrieval (sibling chunks for completeness)
"""
import re
import json
import pickle
import os
from typing import List, Dict, Tuple, Optional
from pathlib import Path

import numpy as np
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from rank_bm25 import BM25Okapi

from config import Config
from lib.embeddings import embed_single, embed_texts
from lib.qdrant_vectors import VectorStore
from lib.query_analyzer import QueryAnalyzer

# Path to persisted BM25 index
BM25_INDEX_PATH = Path(__file__).parent.parent / "data" / "bm25_index.pkl"
BM25_CORPUS_PATH = Path(__file__).parent.parent / "data" / "bm25_corpus.pkl"

# Spanish stopwords for BM25
SPANISH_STOPWORDS = {
    "de", "la", "que", "el", "en", "y", "a", "los", "del", "se", "las",
    "por", "un", "para", "con", "no", "una", "su", "al", "lo", "como",
    "más", "pero", "sus", "le", "ya", "o", "este", "sí", "porque", "esta",
    "entre", "cuando", "muy", "sin", "sobre", "también", "me", "hasta",
    "hay", "donde", "quien", "desde", "todo", "nos", "durante", "todos",
    "uno", "les", "ni", "contra", "otros", "ese", "eso", "ante", "ellos",
    "e", "esto", "mí", "antes", "algunos", "qué", "unos", "yo", "otro",
    "otras", "otra", "él", "tanto", "esa", "estos", "mucho", "quienes",
    "nada", "muchos", "cual", "poco", "ella", "estar", "estas", "algunas",
    "algo", "nosotros", "mi", "mis", "tú", "te", "ti", "tu", "tus",
    "ellas", "nosotras", "vosotros", "vosotras", "os", "mío", "mía",
    "artículo", "articulo", "art", "inc", "inciso",
}


class HybridRetriever:
    """
    Combines Qdrant (dense) + BM25 (sparse) + HyDE + Multi-query +
    RRF + MMR + LLM reranking + Parent-child chunk retrieval.
    """

    def __init__(self, vector_store: Optional[VectorStore] = None):
        self.s3 = vector_store or VectorStore()
        self.bm25: Optional[BM25Okapi] = None
        self.corpus: List[Dict] = []
        self.analyzer = QueryAnalyzer()
        self._load_bm25()

    # ── Main retrieval entry point ──────────────────────────────

    def retrieve(
        self,
        query: str,
        top_k: int = Config.RAG_TOP_K,
        enable_hyde: bool = True,
        enable_bm25: bool = True,
        enable_rerank: bool = True,
        enable_multi_query: bool = True,
        enable_mmr: bool = True,
        enable_parent_retrieval: bool = True,
        query_embedding: Optional[np.ndarray] = None,
    ) -> List[Dict]:
        """
        Full hybrid retrieval pipeline.
        Returns top_k results with keys: text, score, metadata.
        """
        results: List[Dict] = []

        # Stage 0: Query analysis — extract filters and variants
        analysis = self.analyzer.analyze(query)
        vector_filter = self._build_vector_filter(analysis.get("filters", {}))

        # Stage 1: Explicit expediente number extraction
        explicit = self._extract_explicit_matches(query)
        if explicit:
            results.extend(explicit)

        # Pre-compute query embedding once (reuse if provided by caller)
        if query_embedding is None:
            query_embedding = embed_single(query)

        # Stages 2-5: Run all searches in parallel (I/O-bound)
        dense_results = []
        hyde_results = []
        multi_query_results = []
        bm25_results = []

        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = {}
            futures[executor.submit(
                self._dense_search, query_embedding, top_k * 3, vector_filter
            )] = "dense"
            if enable_hyde:
                futures[executor.submit(
                    self._hyde_search, query, top_k * 3, vector_filter
                )] = "hyde"
            if enable_multi_query and analysis.get("query_variants"):
                futures[executor.submit(
                    self._multi_query_search,
                    analysis["query_variants"], top_k * 2, vector_filter,
                )] = "multi_query"
            if enable_bm25 and self.bm25:
                futures[executor.submit(
                    self._bm25_search, query, top_k * 3
                )] = "bm25"

            for future in as_completed(futures):
                source = futures[future]
                try:
                    res = future.result()
                    if source == "dense":
                        dense_results = res
                    elif source == "hyde":
                        hyde_results = res
                    elif source == "multi_query":
                        multi_query_results = res
                    elif source == "bm25":
                        bm25_results = res
                except Exception as e:
                    print(f"[Retrieval] {source} stage failed: {e}")

        # Stage 6: Reciprocal Rank Fusion
        fused = self._reciprocal_rank_fusion(
            dense_results, hyde_results, bm25_results, multi_query_results,
            k=Config.RAG_RRF_K,
        )

        # Stage 7: Fast diversity selection (replaces expensive MMR)
        if enable_mmr and len(fused) > top_k:
            fused = self._diversified_selection(
                fused, top_n=min(len(fused), top_k * 2),
            )

        # Stage 8: LLM Cross-encoder reranking
        if enable_rerank and fused:
            reranked = self._llm_rerank(query, fused[:20])
        else:
            reranked = fused

        # Stage 9: Merge explicit + reranked, deduplicate
        all_results = self._merge_and_deduplicate(results, reranked)

        # Stage 10: Parent-child chunk retrieval (fetch sibling chunks)
        if enable_parent_retrieval:
            all_results = self._expand_with_siblings(all_results[:top_k])

        return all_results[:top_k]

    # ── Filter builder ──────────────────────────────────────────

    def _build_vector_filter(self, filters: Dict) -> Optional[Dict]:
        """Convert extracted filters to vector DB filter expression."""
        if not filters:
            return None
        vector_filter = {}
        if "tipo" in filters:
            vector_filter["tipo"] = {"$eq": filters["tipo"]}
        if "aiCategory" in filters:
            vector_filter["aiCategory"] = {"$eq": filters["aiCategory"]}
        return vector_filter if vector_filter else None

    # ── Stage 0: Explicit match ─────────────────────────────────

    def _extract_explicit_matches(self, query: str) -> List[Dict]:
        """Find expediente numbers mentioned in the query."""
        pattern = r"\b(\d{1,5}\s*[-–]\s*[A-Za-z]{1,4}\s*[-–]\s*\d{4})\b"
        matches = re.findall(pattern, query)
        if not matches:
            return []

        results = []
        for match in matches:
            normalized = re.sub(r"\s+", "", match).upper()
            # Search BM25 corpus for exact numero match
            for doc in self.corpus:
                meta = doc.get("metadata", {})
                doc_numero = str(meta.get("numero", "")).replace(" ", "").upper()
                if normalized in doc_numero:
                    results.append({
                        "key": doc.get("key", ""),
                        "text": doc.get("text", ""),
                        "score": 1.0,
                        "metadata": meta,
                        "source": "explicit",
                    })
        return results

    # ── Stage 2: Dense vector search ────────────────────────────

    def _dense_search(
        self, query_vector: np.ndarray, limit: int,
        filter_expr: Optional[Dict] = None,
    ) -> List[Dict]:
        raw = self.s3.query(query_vector, top_k=limit, filter_expr=filter_expr)
        return [
            {**r, "source": "dense"}
            for r in raw
            if r.get("score", 0) >= Config.RAG_MIN_SCORE
        ]

    # ── Stage 3: HyDE (Hypothetical Document Embedding) ────────

    def _hyde_search(self, query: str, limit: int,
                     filter_expr: Optional[Dict] = None) -> List[Dict]:
        """Generate a hypothetical answer, embed it, search."""
        hyde_text = self._generate_hyde(query)
        if not hyde_text:
            return []

        hyde_embedding = embed_single(hyde_text)
        raw = self.s3.query(hyde_embedding, top_k=limit, filter_expr=filter_expr)
        return [
            {**r, "source": "hyde"}
            for r in raw
            if r.get("score", 0) >= Config.RAG_MIN_SCORE
        ]

    def _generate_hyde(self, query: str) -> str:
        """Use LLM to generate a hypothetical legislative document."""
        url = f"{Config.OPENROUTER_API_URL}/chat/completions"
        headers = {
            "Authorization": f"Bearer {Config.OPENROUTER_API_KEY}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": Config.OPENROUTER_RERANK_MODEL,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "Eres un asistente legislativo. Genera un fragmento breve "
                        "(3-4 oraciones) de un documento legislativo hipotético que "
                        "respondería la siguiente consulta. Responde SOLO con el texto "
                        "del documento, sin explicaciones."
                    ),
                },
                {"role": "user", "content": query},
            ],
            "temperature": 0.5,
            "max_tokens": 200,
        }

        try:
            resp = requests.post(url, json=payload, headers=headers, timeout=30)
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"].strip()
        except Exception as e:
            print(f"[HyDE] Error: {e}")
            return ""

    # ── Stage 5: BM25 sparse search ────────────────────────────

    def _bm25_search(self, query: str, limit: int) -> List[Dict]:
        if not self.bm25 or not self.corpus:
            return []

        tokenized_query = self._tokenize_spanish(query)
        scores = self.bm25.get_scores(tokenized_query)

        # Normalize to 0-1
        max_score = scores.max() if scores.max() > 0 else 1.0
        normalized = scores / max_score

        # Get top results
        top_indices = np.argsort(normalized)[::-1][:limit]

        results = []
        for idx in top_indices:
            score = float(normalized[idx])
            if score < 0.1:
                break
            doc = self.corpus[idx]
            results.append({
                "key": doc.get("key", str(idx)),
                "text": doc.get("text", ""),
                "score": score,
                "metadata": doc.get("metadata", {}),
                "source": "bm25",
            })

        return results

    # ── Stage 4: Multi-query expansion ──────────────────────────

    def _multi_query_search(
        self, variants: List[str], limit: int,
        filter_expr: Optional[Dict] = None,
    ) -> List[Dict]:
        """Search with multiple query variants using batch embedding."""
        variants = variants[:3]
        if not variants:
            return []

        # Batch embed all variants at once (1 API call instead of N)
        embeddings = embed_texts(variants)
        per_variant = max(limit // len(variants), 5)

        all_results = []
        for emb in embeddings:
            try:
                raw = self.s3.query(
                    emb, top_k=per_variant,
                    filter_expr=filter_expr,
                )
                all_results.extend([
                    {**r, "source": "multi_query"}
                    for r in raw
                    if r.get("score", 0) >= Config.RAG_MIN_SCORE
                ])
            except Exception as e:
                print(f"[MultiQuery] Variant search failed: {e}")
        return all_results

    # ── Spanish tokenizer for BM25 ─────────────────────────────

    @staticmethod
    def _tokenize_spanish(text: str) -> List[str]:
        """Tokenize with Spanish stopword removal and basic stemming."""
        text = text.lower()
        text = re.sub(r"[^\wáéíóúñü]", " ", text)
        tokens = text.split()
        # Remove stopwords and very short tokens
        tokens = [t for t in tokens if t not in SPANISH_STOPWORDS and len(t) > 2]
        # Basic suffix stripping (lightweight Spanish stemming)
        stemmed = []
        for t in tokens:
            for suffix in ("ción", "cion", "iones", "mente", "idad", "idades",
                           "ando", "iendo", "ados", "idos", "adas", "idas"):
                if t.endswith(suffix) and len(t) - len(suffix) >= 3:
                    t = t[: -len(suffix)]
                    break
            stemmed.append(t)
        return stemmed

    # ── Stage 6: Reciprocal Rank Fusion ─────────────────────────

    def _reciprocal_rank_fusion(
        self,
        dense: List[Dict],
        hyde: List[Dict],
        sparse: List[Dict],
        multi_query: Optional[List[Dict]] = None,
        k: int = 60,
    ) -> List[Dict]:
        """Merge multiple ranked lists using RRF."""
        scores: Dict[str, float] = {}
        docs: Dict[str, Dict] = {}

        signal_lists = [dense, hyde, sparse]
        if multi_query:
            signal_lists.append(multi_query)

        for signal_results in signal_lists:
            for rank, result in enumerate(signal_results, 1):
                doc_key = result.get("key", "")
                if not doc_key:
                    continue
                scores[doc_key] = scores.get(doc_key, 0) + 1 / (k + rank)
                if doc_key not in docs:
                    docs[doc_key] = result

        # Sort by fused score
        ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)

        results = []
        for doc_key, fused_score in ranked:
            doc = docs[doc_key].copy()
            doc["rrf_score"] = fused_score
            doc["score"] = fused_score
            results.append(doc)

        return results

    # ── Stage 5: LLM Cross-encoder reranking ────────────────────

    def _llm_rerank(self, query: str, candidates: List[Dict]) -> List[Dict]:
        """
        Use LLM to score each candidate's relevance (0-10).
        Blend with RRF score: final = 0.7 * llm + 0.3 * rrf
        """
        if not candidates:
            return []

        # Build pairs for scoring
        texts = []
        for i, c in enumerate(candidates):
            preview = c.get("text", "")[:500]
            texts.append(f"[{i}] {preview}")

        url = f"{Config.OPENROUTER_API_URL}/chat/completions"
        headers = {
            "Authorization": f"Bearer {Config.OPENROUTER_API_KEY}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": Config.OPENROUTER_RERANK_MODEL,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "Eres un evaluador de relevancia. Califica cada documento "
                        "del 0 al 10 según su relevancia para la consulta del usuario. "
                        'Responde SOLO con JSON: [{"i":0,"s":8},{"i":1,"s":5},...]'
                    ),
                },
                {
                    "role": "user",
                    "content": f"Consulta: {query}\n\nDocumentos:\n" + "\n".join(texts),
                },
            ],
            "temperature": 0.0,
            "max_tokens": 500,
        }

        try:
            resp = requests.post(url, json=payload, headers=headers, timeout=30)
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"].strip()

            # Parse JSON from response (handle markdown wrapping)
            json_match = re.search(r"\[.*\]", content, re.DOTALL)
            if not json_match:
                return candidates

            llm_scores = json.loads(json_match.group())

            # Blend scores
            for entry in llm_scores:
                idx = entry.get("i", -1)
                llm_score = entry.get("s", 0)
                if 0 <= idx < len(candidates):
                    rrf_score = candidates[idx].get("rrf_score", 0)
                    candidates[idx]["score"] = (
                        (llm_score / 10) * Config.RAG_RERANK_WEIGHT
                        + rrf_score * Config.RAG_FUSION_WEIGHT
                    )

            candidates.sort(key=lambda x: x.get("score", 0), reverse=True)
            return candidates

        except Exception as e:
            print(f"[Rerank] LLM reranking failed, using RRF scores: {e}")
            return candidates

    # ── Stage 6: Merge & deduplicate ────────────────────────────

    def _merge_and_deduplicate(
        self, explicit: List[Dict], ranked: List[Dict]
    ) -> List[Dict]:
        seen_keys = set()
        merged = []

        # Explicit matches first (score=1.0)
        for doc in explicit:
            key = doc.get("key", "")
            if key and key not in seen_keys:
                seen_keys.add(key)
                merged.append(doc)

        # Then ranked results
        for doc in ranked:
            key = doc.get("key", "")
            if key and key not in seen_keys:
                seen_keys.add(key)
                merged.append(doc)

        return merged

    # ── Diversity-aware selection (fast MMR replacement) ────────

    def _diversified_selection(
        self,
        candidates: List[Dict],
        top_n: int = 30,
        max_per_expediente: int = 2,
    ) -> List[Dict]:
        """
        Fast diversity selection: limits chunks per expediente.
        Per expediente keeps at most 1 SUMMARY + 1 CONTENT chunk.
        Documents are already sorted by RRF score, so this preserves
        relevance ordering while ensuring diversity across expedientes.
        """
        if len(candidates) <= top_n:
            return candidates

        selected = []
        # Track which chunk types we've taken per expediente
        exp_types: Dict[str, set] = {}  # numero -> set of chunkTypes taken
        exp_count: Dict[str, int] = {}  # numero -> total chunks taken

        for doc in candidates:
            if len(selected) >= top_n:
                break
            numero = doc.get("metadata", {}).get("numero", "")
            chunk_type = doc.get("metadata", {}).get("chunkType", "CONTENT")

            if not numero:
                selected.append(doc)
                continue

            count = exp_count.get(numero, 0)
            types_taken = exp_types.get(numero, set())

            if count >= max_per_expediente:
                continue
            # Prefer diversity of chunk types: skip if we already have this type
            if count > 0 and chunk_type in types_taken:
                continue

            selected.append(doc)
            exp_count[numero] = count + 1
            if numero not in exp_types:
                exp_types[numero] = set()
            exp_types[numero].add(chunk_type)

        return selected

    # ── Parent-child chunk retrieval ────────────────────────────

    def _expand_with_siblings(self, results: List[Dict]) -> List[Dict]:
        """
        For each retrieved chunk, fetch its SUMMARY sibling if missing.
        Only expands expedientes that have a single chunk to ensure
        complete info without inflating duplicates.
        """
        if not self.corpus:
            return results

        # Build index of corpus by expedienteId for fast lookup
        exp_index: Dict[str, List[Dict]] = {}
        for doc in self.corpus:
            exp_id = str(doc.get("metadata", {}).get("expedienteId", ""))
            if exp_id:
                exp_index.setdefault(exp_id, []).append(doc)

        # Count how many chunks per expediente we already have
        exp_chunk_count: Dict[str, int] = {}
        for result in results:
            numero = result.get("metadata", {}).get("numero", "")
            if numero:
                exp_chunk_count[numero] = exp_chunk_count.get(numero, 0) + 1

        expanded = []
        seen_keys = set()

        for result in results:
            key = result.get("key", "")
            if key in seen_keys:
                continue
            seen_keys.add(key)
            expanded.append(result)

            # Only expand expedientes with a single chunk
            numero = result.get("metadata", {}).get("numero", "")
            exp_id = str(result.get("metadata", {}).get("expedienteId", ""))
            if not exp_id or exp_id not in exp_index:
                continue
            if exp_chunk_count.get(numero, 0) > 1:
                continue

            chunk_type = result.get("metadata", {}).get("chunkType", "CONTENT")

            # If we have CONTENT, try to add SUMMARY (and vice versa)
            target_type = "SUMMARY" if chunk_type == "CONTENT" else "CONTENT"
            for sibling in exp_index[exp_id]:
                sib_key = sibling.get("key", "")
                sib_type = sibling.get("metadata", {}).get("chunkType", "CONTENT")
                if sib_type == target_type and sib_key not in seen_keys:
                    seen_keys.add(sib_key)
                    expanded.append({
                        **sibling,
                        "score": result.get("score", 0) * 0.9,
                        "source": "sibling",
                    })
                    break  # Only add one sibling

        # Re-sort: group by expediente, then by chunkIndex within each group
        def sort_key(doc):
            return (
                -doc.get("score", 0) if doc.get("source") != "sibling" else 0,
                doc.get("metadata", {}).get("numero", ""),
                doc.get("metadata", {}).get("chunkIndex", 0),
            )

        expanded.sort(key=sort_key)
        return expanded

    # ── BM25 index management ───────────────────────────────────

    def _load_bm25(self):
        """Load persisted BM25 index if available."""
        if BM25_INDEX_PATH.exists() and BM25_CORPUS_PATH.exists():
            with open(BM25_INDEX_PATH, "rb") as f:
                self.bm25 = pickle.load(f)
            with open(BM25_CORPUS_PATH, "rb") as f:
                self.corpus = pickle.load(f)
            print(f"[BM25] Loaded index with {len(self.corpus)} documents")
        else:
            print("[BM25] No index found. Run 02_embed_and_index.py first.")

    @staticmethod
    def build_bm25_index(chunks: List[Dict]):
        """
        Build and persist a BM25 index from chunk dicts.
        Each chunk: {key, text, metadata}
        """
        os.makedirs(BM25_INDEX_PATH.parent, exist_ok=True)

        # Tokenize with Spanish stemming + stopword removal
        tokenized = [HybridRetriever._tokenize_spanish(doc["text"]) for doc in chunks]
        bm25 = BM25Okapi(tokenized)

        with open(BM25_INDEX_PATH, "wb") as f:
            pickle.dump(bm25, f)
        with open(BM25_CORPUS_PATH, "wb") as f:
            pickle.dump(chunks, f)

        print(f"[BM25] Built and saved index with {len(chunks)} documents")

    def add_documents(self, new_docs: List[Dict]):
        """
        Add new documents to the in-memory corpus and rebuild BM25 index.
        Each doc: {key, text, metadata}
        Also persists the updated index to disk.
        """
        self.corpus.extend(new_docs)

        # Rebuild BM25 from full corpus
        tokenized = [self._tokenize_spanish(doc["text"]) for doc in self.corpus]
        self.bm25 = BM25Okapi(tokenized)

        # Persist to disk
        os.makedirs(BM25_INDEX_PATH.parent, exist_ok=True)
        with open(BM25_INDEX_PATH, "wb") as f:
            pickle.dump(self.bm25, f)
        with open(BM25_CORPUS_PATH, "wb") as f:
            pickle.dump(self.corpus, f)

        print(f"[BM25] Updated index: now {len(self.corpus)} documents")
