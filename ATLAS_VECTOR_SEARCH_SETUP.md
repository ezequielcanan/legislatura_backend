# MongoDB Atlas Vector Search — Setup Guide

## 1. Create the Vector Search Index

Go to your MongoDB Atlas cluster → **Atlas Search** → **Create Search Index** → choose **JSON Editor**.

- **Index name**: `vector_index`
- **Database**: your database name
- **Collection**: `embeddings`

Paste this index definition:

```json
{
  "fields": [
    {
      "type": "vector",
      "path": "vector",
      "numDimensions": 1536,
      "similarity": "cosine"
    },
    {
      "type": "filter",
      "path": "sourceType"
    },
    {
      "type": "filter",
      "path": "deleted"
    }
  ]
}
```

> `numDimensions: 1536` matches `text-embedding-3-small`. If you switch to a different model, update this value.

## 2. Environment Variables

Add these to your `.env` file (all optional, shown with defaults):

```env
# Atlas Vector Search index name (must match what you created above)
ATLAS_VECTOR_INDEX=vector_index

# Minimum cosine similarity score to include a result (0-1)
RAG_MIN_SCORE=0.68

# How many candidates Atlas evaluates internally (higher = slower but more precise)
RAG_NUM_CANDIDATES=150

# Max chunks returned from Atlas before reranking
RAG_RETRIEVAL_LIMIT=30

# Final number of chunks sent to the LLM (controls cost)
RAG_FINAL_LIMIT=8
```

## 3. Backfill Existing Embeddings

Existing embeddings created before this update only have `snippet` (500 chars). Run the backfill script to copy `snippet` → `chunkText`:

```bash
npx ts-node -r tsconfig-paths/register src/rag/scripts/backfill-chunk-text.ts
```

For **best quality**, re-process expedientes so full 1500-char chunks are stored:

```bash
# From your app, call the re-process endpoint or reset status to PENDING
# and let the worker re-process them.
```

## 4. Architecture Overview

```
User Query
    │
    ▼
[Lightweight Keyword Analysis]  ← zero-cost, no LLM call (~0ms)
    │
    ▼
[Generate Query Embedding]      ← OpenRouter text-embedding-3-small (~0.0001$)
    │
    ▼
[MongoDB Atlas $vectorSearch]   ← server-side ANN search, 30 candidates (~5ms)
    │
    ▼
[Keyword Boost Reranking]       ← client-side, zero-cost (~0ms)
    │
    ▼
[Deduplicate by Expediente]     ← best chunk per expediente
    │
    ▼
[Top 8 chunks → LLM]           ← ~4K tokens context (was ~200K+)
    │
    ▼
[Streaming Response]
```

### Cost Reduction Summary

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| LLM calls per query | 2 (classify + answer) | 1 (answer only) | **50% fewer calls** |
| Context tokens | ~200K+ (50 full docs) | ~4K (8 chunks) | **~98% reduction** |
| Vector search | App-side cosine similarity | Atlas server-side ANN | **~100x faster** |
| Date filter bug | Defaulted to today | No forced filter | **Fixed** |
| Chunk precision | 6000 char chunks | 1500 char chunks | **4x more precise** |
