# Atlas Text Search Index Setup (BM25 Hybrid Search)

The upgraded RAG pipeline uses **MongoDB Atlas Search** for BM25 keyword matching alongside the existing **Atlas Vector Search** for semantic similarity. This enables true **hybrid search** — combining the strengths of both approaches.

## Why Hybrid Search?

| Signal | Strengths | Weaknesses |
|--------|-----------|------------|
| Vector Search | Semantic understanding, synonyms, paraphrases | Misses exact codes, numbers, technical terms |
| BM25 Text Search | Exact keyword matching, codes, proper nouns | No semantic understanding |
| **Hybrid (RRF)** | **Best of both worlds** | Slightly more compute |

## Create the Atlas Search Index

Go to **MongoDB Atlas → Your Cluster → Search → Create Index** and create the following:

### Index Name: `text_search_index`
### Collection: `embeddings`
### Index Type: Atlas Search (NOT Vector Search)

```json
{
  "mappings": {
    "dynamic": false,
    "fields": {
      "chunkText": {
        "type": "string",
        "analyzer": "lucene.spanish"
      },
      "sourceType": {
        "type": "token"
      },
      "deleted": {
        "type": "boolean"
      }
    }
  }
}
```

### Using the Atlas CLI:

```bash
atlas clusters search indexes create \
  --clusterName <YOUR_CLUSTER> \
  --db <YOUR_DB> \
  --collection embeddings \
  --file text-search-index.json
```

Where `text-search-index.json` contains:

```json
{
  "name": "text_search_index",
  "type": "search",
  "definition": {
    "mappings": {
      "dynamic": false,
      "fields": {
        "chunkText": {
          "type": "string",
          "analyzer": "lucene.spanish"
        },
        "sourceType": {
          "type": "token"
        },
        "deleted": {
          "type": "boolean"
        }
      }
    }
  }
}
```

## Environment Variables

Add these to your `.env` file:

```env
# ─── Advanced RAG Pipeline Configuration ───────────────────

# Atlas Search index name for BM25 text search
ATLAS_TEXT_SEARCH_INDEX=text_search_index

# Fast LLM model for HyDE expansion and cross-encoder reranking
# Use a cheap, fast model (Gemini Flash Lite, Haiku, etc.)
RAG_RERANK_MODEL=google/gemini-2.0-flash-lite-001

# Feature toggles (all enabled by default)
RAG_HYDE_ENABLED=true           # HyDE query expansion
RAG_TEXT_SEARCH_ENABLED=true    # BM25 full-text search (requires Atlas Search index)
RAG_LLM_RERANK_ENABLED=true    # LLM cross-encoder reranking
```

### If the Atlas Search index is not yet created

Set `RAG_TEXT_SEARCH_ENABLED=false` — the pipeline will gracefully skip BM25 search and operate with vector search + HyDE + LLM reranking.

## Existing Vector Search Index

Your existing `vector_index` remains unchanged. Both indexes coexist on the `embeddings` collection:

| Index | Type | Purpose |
|-------|------|---------|
| `vector_index` | Atlas Vector Search | Semantic similarity (cosine) |
| `text_search_index` | Atlas Search | BM25 keyword matching |

## Verifying the Setup

Once both indexes are active, the RAG pipeline logs will show all signals:

```
RAG pipeline [1250ms]: 0 direct + 12 vector + 8 hyde + 15 bm25 → 22 fused → 18 reranked → 8 final (HyDE:true LLM-rerank:true)
```

## Re-embedding Existing Documents (Optional)

The **Contextual Retrieval** upgrade enriches content chunks with a document-level preamble before embedding. Existing embeddings will still work with the new pipeline, but re-processing documents will improve retrieval quality:

```bash
# Re-process all completed expedientes to use contextual embeddings
# (Run from your application or create a migration script)
```

New expedientes processed after this upgrade will automatically get contextual embeddings.
