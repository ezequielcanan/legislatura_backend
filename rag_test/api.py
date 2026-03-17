"""
FastAPI bridge — exposes the full Python RAG pipeline as HTTP endpoints
for the NestJS backend to consume.

Endpoints:
  POST /rag/query          → Full hybrid retrieval + generation (non-streaming)
  POST /rag/query/stream   → Full hybrid retrieval + streaming generation (SSE)
  POST /rag/retrieve       → Retrieval only (no generation)
  GET  /health             → Health check
"""
import sys
import time
import json
import asyncio
from pathlib import Path
from typing import List, Dict, Optional
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

# Ensure the rag_test root is on sys.path so lib/ imports work
sys.path.insert(0, str(Path(__file__).parent))

from config import Config
from lib.hybrid_retriever import HybridRetriever
from lib.generator import RAGGenerator
from lib.cache import SemanticCache
from lib.embeddings import embed_single, embed_texts
from lib.chunker import SemanticChunker
from lib.query_analyzer import QueryAnalyzer


# ── Singletons (initialized once at startup) ───────────────

retriever: Optional[HybridRetriever] = None
generator: Optional[RAGGenerator] = None
cache: Optional[SemanticCache] = None
chunker: Optional[SemanticChunker] = None
query_analyzer: Optional[QueryAnalyzer] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize heavy objects once at startup."""
    global retriever, generator, cache, chunker, query_analyzer
    print("[API] Initializing RAG pipeline components...")
    retriever = HybridRetriever()
    generator = RAGGenerator()
    chunker = SemanticChunker()
    query_analyzer = QueryAnalyzer()
    try:
        cache = SemanticCache()
        if not cache.enabled:
            cache = None
    except Exception:
        cache = None
    print("[API] RAG pipeline ready.")
    yield
    print("[API] Shutting down.")


app = FastAPI(
    title="Legislatura RAG API",
    description="Python RAG microservice for the Legislatura CABA backend",
    version="1.0.0",
    lifespan=lifespan,
)


# ── Request / Response models ──────────────────────────────

class ConversationMessage(BaseModel):
    role: str  # "user" | "assistant"
    text: str


class RAGQueryRequest(BaseModel):
    query: str
    conversation_history: List[ConversationMessage] = Field(default_factory=list)
    top_k: int = Config.RAG_TOP_K
    enable_hyde: bool = True
    enable_bm25: bool = True
    enable_rerank: bool = True
    enable_multi_query: bool = True
    enable_mmr: bool = True
    enable_parent_retrieval: bool = True
    enable_cache: bool = True


class RetrieveRequest(BaseModel):
    query: str
    top_k: int = Config.RAG_TOP_K
    enable_hyde: bool = True
    enable_bm25: bool = True
    enable_rerank: bool = True
    enable_multi_query: bool = True
    enable_mmr: bool = True
    enable_parent_retrieval: bool = True


class SourceItem(BaseModel):
    ref: str
    numero: str
    tipo: str
    preview: str
    score: float


class RAGQueryResponse(BaseModel):
    answer: str
    sources: List[dict]
    context_count: int
    retrieval_count: int
    elapsed_ms: int
    cache_hit: bool = False


# ── Endpoints ──────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "retriever_ready": retriever is not None,
        "generator_ready": generator is not None,
        "cache_enabled": cache is not None and cache.enabled,
    }


@app.post("/rag/query", response_model=RAGQueryResponse)
async def rag_query(req: RAGQueryRequest):
    """Full RAG pipeline: retrieve + generate (non-streaming)."""
    if not retriever or not generator:
        raise HTTPException(status_code=503, detail="RAG pipeline not initialized")

    start = time.time()

    # Rewrite follow-up queries using conversation history
    history = [{
        "role": m.role, "text": m.text
    } for m in req.conversation_history]
    retrieval_query = await asyncio.to_thread(
        query_analyzer.rewrite_with_context, req.query, history if history else None
    )

    # Embed the (possibly rewritten) query
    query_embedding = await asyncio.to_thread(embed_single, retrieval_query)

    # Check cache
    if req.enable_cache and cache:
        cached = cache.get(query_embedding)
        if cached:
            return RAGQueryResponse(
                answer=cached["answer"],
                sources=cached.get("sources", []),
                context_count=0,
                retrieval_count=0,
                elapsed_ms=int((time.time() - start) * 1000),
                cache_hit=True,
            )

    # Retrieve
    results = await asyncio.to_thread(
        retriever.retrieve,
        retrieval_query,
        top_k=req.top_k,
        enable_hyde=req.enable_hyde,
        enable_bm25=req.enable_bm25,
        enable_rerank=req.enable_rerank,
        enable_multi_query=req.enable_multi_query,
        enable_mmr=req.enable_mmr,
        enable_parent_retrieval=req.enable_parent_retrieval,
        query_embedding=query_embedding,
    )

    if not results:
        return RAGQueryResponse(
            answer="No encontré documentos relevantes para tu consulta. Intentá reformular la pregunta.",
            sources=[],
            context_count=0,
            retrieval_count=0,
            elapsed_ms=int((time.time() - start) * 1000),
        )

    # Generate
    response = await asyncio.to_thread(
        generator.generate,
        query=req.query,
        retrieved_docs=results,
        conversation_history=history if history else None,
        stream=False,
    )

    answer = response["answer"]
    sources = response.get("sources", [])

    # Cache result
    if req.enable_cache and cache:
        try:
            cache.set(req.query, query_embedding, answer, sources)
        except Exception:
            pass

    elapsed_ms = int((time.time() - start) * 1000)
    return RAGQueryResponse(
        answer=answer,
        sources=sources,
        context_count=response.get("context_count", len(results)),
        retrieval_count=len(results),
        elapsed_ms=elapsed_ms,
    )


@app.post("/rag/query/stream")
async def rag_query_stream(req: RAGQueryRequest):
    """Full RAG pipeline with streaming generation (SSE)."""
    if not retriever or not generator:
        raise HTTPException(status_code=503, detail="RAG pipeline not initialized")

    start = time.time()

    # Rewrite follow-up queries using conversation history
    history = [{
        "role": m.role, "text": m.text
    } for m in req.conversation_history]
    retrieval_query = await asyncio.to_thread(
        query_analyzer.rewrite_with_context, req.query, history if history else None
    )

    # Embed the (possibly rewritten) query
    query_embedding = await asyncio.to_thread(embed_single, retrieval_query)

    # Check cache
    if req.enable_cache and cache:
        cached = cache.get(query_embedding)
        if cached:
            def cached_stream():
                data = {
                    "type": "chunk",
                    "content": cached["answer"],
                }
                yield f"data: {json.dumps(data, ensure_ascii=False)}\n\n"
                done_data = {
                    "type": "done",
                    "sources": cached.get("sources", []),
                    "cache_hit": True,
                    "elapsed_ms": int((time.time() - start) * 1000),
                }
                yield f"data: {json.dumps(done_data, ensure_ascii=False)}\n\n"

            return StreamingResponse(
                cached_stream(),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no",
                },
            )

    # Retrieve using the (possibly rewritten) query
    results = await asyncio.to_thread(
        retriever.retrieve,
        retrieval_query,
        top_k=req.top_k,
        enable_hyde=req.enable_hyde,
        enable_bm25=req.enable_bm25,
        enable_rerank=req.enable_rerank,
        enable_multi_query=req.enable_multi_query,
        enable_mmr=req.enable_mmr,
        enable_parent_retrieval=req.enable_parent_retrieval,
        query_embedding=query_embedding,
    )

    if not results:
        def no_results_stream():
            msg = "No encontré documentos relevantes para tu consulta. Intentá reformular la pregunta."
            yield f"data: {json.dumps({'type': 'chunk', 'content': msg}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'done', 'sources': [], 'elapsed_ms': int((time.time() - start) * 1000)}, ensure_ascii=False)}\n\n"

        return StreamingResponse(
            no_results_stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
        )

    # Generate with streaming
    response = await asyncio.to_thread(
        generator.generate,
        query=req.query,
        retrieved_docs=results,
        conversation_history=history if history else None,
        stream=True,
    )

    stream_gen = response["stream"]
    sources = generator._deduplicated_sources(
        generator._pack_context(results, generator.MAX_CONTEXT_TOKENS)
    )

    def event_stream():
        full_answer = []
        try:
            for token in stream_gen:
                full_answer.append(token)
                data = {"type": "chunk", "content": token}
                yield f"data: {json.dumps(data, ensure_ascii=False)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"

        # Cache the full answer
        complete_answer = "".join(full_answer)
        if req.enable_cache and cache:
            try:
                cache.set(req.query, query_embedding, complete_answer, sources)
            except Exception:
                pass

        # Send done event with sources
        done_data = {
            "type": "done",
            "sources": sources,
            "retrieval_count": len(results),
            "elapsed_ms": int((time.time() - start) * 1000),
        }
        yield f"data: {json.dumps(done_data, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/rag/retrieve")
async def rag_retrieve(req: RetrieveRequest):
    """Retrieval only — returns raw chunks without LLM generation."""
    if not retriever:
        raise HTTPException(status_code=503, detail="Retriever not initialized")

    start = time.time()
    query_embedding = await asyncio.to_thread(embed_single, req.query)

    results = await asyncio.to_thread(
        retriever.retrieve,
        req.query,
        top_k=req.top_k,
        enable_hyde=req.enable_hyde,
        enable_bm25=req.enable_bm25,
        enable_rerank=req.enable_rerank,
        enable_multi_query=req.enable_multi_query,
        enable_mmr=req.enable_mmr,
        enable_parent_retrieval=req.enable_parent_retrieval,
        query_embedding=query_embedding,
    )

    return {
        "results": [
            {
                "key": r.get("key", ""),
                "text": r.get("text", ""),
                "score": r.get("score", 0),
                "metadata": r.get("metadata", {}),
                "source": r.get("source", ""),
            }
            for r in results
        ],
        "count": len(results),
        "elapsed_ms": int((time.time() - start) * 1000),
    }


# ── Indexing endpoint ──────────────────────────────────────

class IndexExpedienteRequest(BaseModel):
    """Payload from NestJS to index a single expediente into Qdrant + BM25."""
    expedienteId: int
    numero: str
    tipo: str = ""
    titulo: str = ""
    sumario: str = ""
    aiSummary: str = ""
    aiTags: List[str] = Field(default_factory=list)
    aiCategory: str = ""
    fechaIngreso: str = ""
    pdfText: str = ""
    baeSource: bool = False
    autor: Optional[Dict] = None


@app.post("/rag/index")
async def rag_index(req: IndexExpedienteRequest):
    """
    Index a single expediente into Qdrant and update BM25 index.
    Called by NestJS after processing an expediente.
    """
    if not retriever or not chunker:
        raise HTTPException(status_code=503, detail="RAG pipeline not initialized")

    start = time.time()

    metadata = {
        "expedienteId": req.expedienteId,
        "numero": req.numero,
        "tipo": req.tipo,
        "titulo": req.titulo or req.sumario or "",
        "aiSummary": req.aiSummary or req.sumario or "",
        "aiTags": req.aiTags,
        "aiCategory": req.aiCategory,
        "fechaIngreso": req.fechaIngreso,
        "baeSource": req.baeSource,
        "autor": req.autor,
    }

    chunks = []

    # 1. Create summary chunk
    summary_chunk = chunker.create_summary_chunk(metadata)
    if summary_chunk:
        chunks.append(summary_chunk)

    # 2. Create content chunks from PDF text
    if req.pdfText and len(req.pdfText) > 20:
        content_chunks = chunker.chunk_document(req.pdfText, metadata)
        chunks.extend(content_chunks)

    if not chunks:
        return {"indexed": 0, "message": "No text to index", "elapsed_ms": int((time.time() - start) * 1000)}

    # 3. Generate embeddings for all chunks
    texts = [c["text"] for c in chunks]
    try:
        embeddings = await asyncio.to_thread(embed_texts, texts)
    except Exception as e:
        print(f"[API] Embedding generation failed: {e}")
        raise HTTPException(status_code=500, detail=f"Embedding failed: {str(e)}")

    # 4. Upsert to Qdrant
    import uuid
    vectors = []
    new_bm25_docs = []
    for chunk, embedding in zip(chunks, embeddings):
        key = str(uuid.uuid4())
        vectors.append({
            "key": key,
            "vector": embedding,
            "text": chunk["text"],
            "metadata": chunk["metadata"],
        })
        new_bm25_docs.append({
            "key": key,
            "text": chunk["text"],
            "metadata": chunk["metadata"],
        })

    try:
        store = retriever.s3
        await asyncio.to_thread(store.upsert_vectors, vectors)
    except Exception as e:
        print(f"[API] Qdrant upsert failed: {e}")
        raise HTTPException(status_code=500, detail=f"Qdrant upsert failed: {str(e)}")

    # 5. Update in-memory BM25 index (add new docs and rebuild)
    try:
        await asyncio.to_thread(retriever.add_documents, new_bm25_docs)
    except Exception as e:
        print(f"[API] BM25 update warning: {e}")

    elapsed_ms = int((time.time() - start) * 1000)
    return {
        "indexed": len(vectors),
        "expedienteId": req.expedienteId,
        "numero": req.numero,
        "elapsed_ms": elapsed_ms,
    }


# ── Main ───────────────────────────────────────────────────

if __name__ == "__main__":
    import os
    port = int(os.getenv("RAG_API_PORT", "8100"))
    uvicorn.run(
        "api:app",
        host="0.0.0.0",
        port=port,
        reload=False,
        log_level="info",
    )
