"""
Centralized configuration loaded from .env
"""
import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    # MongoDB
    MONGODB_URI = os.getenv("MONGODB_URI", "")
    MONGODB_DB = os.getenv("MONGODB_DB", "test")

    # OpenRouter
    OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
    OPENROUTER_API_URL = os.getenv("OPENROUTER_API_URL", "https://openrouter.ai/api/v1")
    OPENROUTER_CHAT_MODEL = os.getenv("OPENROUTER_CHAT_MODEL", "google/gemini-2.5-flash")
    OPENROUTER_RERANK_MODEL = os.getenv("OPENROUTER_RERANK_MODEL", "google/gemini-2.0-flash-lite-001")
    OPENROUTER_EMBEDDING_MODEL = os.getenv("OPENROUTER_EMBEDDING_MODEL", "text-embedding-3-small")

    # Pinecone (legacy — kept for migration, no longer in the active flow)
    PINECONE_API_KEY = os.getenv("PINECONE_API_KEY", "")
    PINECONE_INDEX_NAME = os.getenv("PINECONE_INDEX_NAME", "legislatura-expedientes")
    PINECONE_CLOUD = os.getenv("PINECONE_CLOUD", "aws")
    PINECONE_REGION = os.getenv("PINECONE_REGION", "us-east-1")

    # Qdrant (active vector store)
    QDRANT_URL = os.getenv("QDRANT_URL", "http://localhost:6333")
    QDRANT_COLLECTION_NAME = os.getenv("QDRANT_COLLECTION_NAME", "legislatura-expedientes")

    # RAG
    CHUNK_SIZE_TOKENS = int(os.getenv("CHUNK_SIZE_TOKENS", "300"))
    CHUNK_OVERLAP_TOKENS = int(os.getenv("CHUNK_OVERLAP_TOKENS", "50"))
    EMBEDDING_DIMS = int(os.getenv("EMBEDDING_DIMS", "1536"))
    RAG_TOP_K = int(os.getenv("RAG_TOP_K", "20"))
    RAG_MIN_SCORE = float(os.getenv("RAG_MIN_SCORE", "0.40"))
    RAG_RRF_K = int(os.getenv("RAG_RRF_K", "60"))
    RAG_RERANK_WEIGHT = float(os.getenv("RAG_RERANK_WEIGHT", "0.7"))
    RAG_FUSION_WEIGHT = float(os.getenv("RAG_FUSION_WEIGHT", "0.3"))

    # Redis
    REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
    CACHE_SIMILARITY_THRESHOLD = float(os.getenv("CACHE_SIMILARITY_THRESHOLD", "0.95"))

    # Processing
    MAX_EXPEDIENTES = int(os.getenv("MAX_EXPEDIENTES", "500"))
    EMBEDDING_BATCH_SIZE = int(os.getenv("EMBEDDING_BATCH_SIZE", "50"))
