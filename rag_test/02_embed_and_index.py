"""
Step 2: Generate embeddings and index them in Pinecone + BM25.

Reads chunks from data/chunks.json, generates embeddings via OpenRouter,
stores vectors in Qdrant, and builds a local BM25 index.

This is the most time/cost intensive step — progress is checkpointed.
"""
import json
import os
import sys
import uuid
from pathlib import Path

import numpy as np
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TaskProgressColumn

sys.path.insert(0, str(Path(__file__).parent))

from config import Config
from lib.embeddings import embed_texts
from lib.qdrant_vectors import VectorStore
from lib.hybrid_retriever import HybridRetriever

console = Console()
DATA_DIR = Path(__file__).parent / "data"
CHECKPOINT_PATH = DATA_DIR / "embedding_checkpoint.json"


def load_chunks() -> list:
    chunks_path = DATA_DIR / "chunks.json"
    if not chunks_path.exists():
        console.print("[red]No chunks.json found. Run 01_extract_and_chunk.py first.[/]")
        sys.exit(1)

    with open(chunks_path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_checkpoint() -> dict:
    if CHECKPOINT_PATH.exists():
        with open(CHECKPOINT_PATH, "r") as f:
            return json.load(f)
    return {"processed": 0, "keys": []}


def save_checkpoint(processed: int, keys: list):
    with open(CHECKPOINT_PATH, "w") as f:
        json.dump({"processed": processed, "keys": keys}, f)


def main():
    console.print("\n[bold cyan]═══ Step 2: Embed & Index ═══[/]\n")

    # ── 1. Load chunks ──────────────────────────────────────────
    chunks = load_chunks()
    console.print(f"  Loaded [bold]{len(chunks)}[/] chunks from chunks.json")

    checkpoint = load_checkpoint()
    start_idx = checkpoint["processed"]
    all_keys = checkpoint["keys"]

    if start_idx > 0:
        console.print(f"  [yellow]Resuming from checkpoint: {start_idx}/{len(chunks)}[/]")

    remaining = chunks[start_idx:]
    if not remaining:
        console.print("[green]All chunks already processed![/]")
        _build_bm25(chunks, all_keys)
        return

    # ── 2. Setup Qdrant ─────────────────────────────────────────
    console.print("\n[cyan]Setting up Qdrant...[/]")
    store = VectorStore()
    store.setup()
    console.print("[green]  ✓ Qdrant ready[/]\n")

    # ── 3. Generate embeddings + index in batches ───────────────
    batch_size = Config.EMBEDDING_BATCH_SIZE

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        console=console,
    ) as progress:
        task = progress.add_task(
            "Embedding & indexing...",
            total=len(remaining),
        )

        for i in range(0, len(remaining), batch_size):
            batch = remaining[i : i + batch_size]

            # Extract texts for embedding
            texts = [chunk["text"] for chunk in batch]

            # Generate embeddings
            try:
                embeddings = embed_texts(texts, batch_size=batch_size)
            except Exception as e:
                console.print(f"\n[red]Embedding error at batch {i}: {e}[/]")
                save_checkpoint(start_idx + i, all_keys)
                console.print("[yellow]Checkpoint saved. Re-run to continue.[/]")
                return

            # Prepare vectors for Qdrant
            vectors = []
            for chunk, embedding in zip(batch, embeddings):
                key = str(uuid.uuid4())
                all_keys.append(key)
                vectors.append({
                    "key": key,
                    "vector": embedding,
                    "text": chunk["text"],
                    "metadata": chunk["metadata"],
                })

            # Upsert to Qdrant
            try:
                store.upsert_vectors(vectors)
            except Exception as e:
                console.print(f"\n[red]Qdrant error at batch {i}: {e}[/]")
                save_checkpoint(start_idx + i, all_keys)
                console.print("[yellow]Checkpoint saved. Re-run to continue.[/]")
                return

            # Update checkpoint
            processed_so_far = start_idx + i + len(batch)
            save_checkpoint(processed_so_far, all_keys)
            progress.update(task, advance=len(batch))

    console.print(f"\n[green]✓ Indexed {len(chunks)} vectors in Qdrant[/]")

    # ── 4. Build BM25 index ─────────────────────────────────────
    _build_bm25(chunks, all_keys)

    # ── 5. Cleanup checkpoint ───────────────────────────────────
    if CHECKPOINT_PATH.exists():
        os.remove(CHECKPOINT_PATH)

    console.print("\n[green]✓ Done! Run 03_chatbot.py to start chatting.[/]\n")


def _build_bm25(chunks: list, keys: list):
    console.print("\n[cyan]Building BM25 index...[/]")

    bm25_docs = []
    for idx, chunk in enumerate(chunks):
        key = keys[idx] if idx < len(keys) else str(uuid.uuid4())
        bm25_docs.append({
            "key": key,
            "text": chunk["text"],
            "metadata": chunk["metadata"],
        })

    HybridRetriever.build_bm25_index(bm25_docs)
    console.print("[green]  ✓ BM25 index ready[/]")


if __name__ == "__main__":
    main()
