"""
Migration script: MongoDB Embeddings → Qdrant

When the Python RAG service is down, NestJS stores document embeddings
directly in MongoDB (provider='mongo', sourceType='document').
This script reads those embeddings and upserts them into Qdrant,
then rebuilds the BM25 index so the system returns to its normal state.

What it does:
  1. Reads all document embeddings from MongoDB that have a vector
  2. Upserts them into the Qdrant collection (preserving text + metadata)
  3. Rebuilds the BM25 index from all Qdrant points
  4. Optionally clears the vector field in MongoDB to save space

Usage:
    python migrate_mongo_to_qdrant.py                     # full migration
    python migrate_mongo_to_qdrant.py --dry-run            # preview only
    python migrate_mongo_to_qdrant.py --batch 200          # custom batch size
    python migrate_mongo_to_qdrant.py --clear-mongo-vectors # remove vectors from mongo after migration
"""
import argparse
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from rich.console import Console
from rich.progress import (
    Progress,
    SpinnerColumn,
    TextColumn,
    BarColumn,
    TaskProgressColumn,
    TimeRemainingColumn,
)

from config import Config
from lib.qdrant_vectors import VectorStore as QdrantStore
from lib.hybrid_retriever import HybridRetriever

console = Console()


def connect_mongo():
    from pymongo import MongoClient
    client = MongoClient(Config.MONGODB_URI)
    db = client[Config.MONGODB_DB]
    return client, db


def fetch_mongo_embeddings(db, batch_size: int = 500):
    """
    Fetch document embeddings from MongoDB that were stored by the
    NestJS fallback (provider='mongo', sourceType='document').
    Returns a cursor that yields batches.

    We explicitly request the 'vector' field (which has select: false
    in Mongoose but is accessible via raw pymongo queries).
    """
    collection = db["embeddings"]

    '''query = {
        "sourceType": "document",
        "deleted": {"$ne": True},
        "vector.0": {"$exists": True},   # non-empty array (avoids $not/$size pymongo quirk)
    }'''

    projection = {
        "_id": 1,
        "sourceId": 1,
        "vector": 1,
        "chunkText": 1,
        "chunkType": 1,
        "snippet": 1,
        "metadata": 1,
        "provider": 1,
    }

    total = collection.count_documents({})
    cursor = collection.find({}, projection).batch_size(batch_size)

    return cursor, total


def mongo_doc_to_qdrant_vector(doc: dict) -> dict:
    """
    Convert a MongoDB embedding document to the Qdrant upsert format.
    Maps the MongoDB schema fields to what VectorStore.upsert_vectors expects.
    """
    meta = doc.get("metadata", {})
    text = doc.get("chunkText") or doc.get("snippet") or ""

    return {
        "key": str(uuid.uuid4()),
        "vector": doc["vector"],
        "text": text,
        "metadata": {
            "expedienteId": int(meta.get("expedienteId", 0)),
            "numero": str(meta.get("numero", "")),
            "tipo": str(meta.get("tipo", "")),
            "chunkType": str(
                meta.get("chunkType", "")
                or doc.get("chunkType", "CONTENT")
            ).upper(),
            "chunkIndex": int(meta.get("chunkIndex", 0)),
            "aiCategory": str(meta.get("aiCategory", "")),
        },
    }


def parse_args():
    p = argparse.ArgumentParser(description="Migrate MongoDB document embeddings → Qdrant")
    p.add_argument("--dry-run", action="store_true", help="Only count; don't write.")
    p.add_argument("--batch", type=int, default=100, help="Upsert batch size (default 100).")
    p.add_argument(
        "--clear-mongo-vectors",
        action="store_true",
        help="After migration, set vector=null in MongoDB to save space.",
    )
    return p.parse_args()


def main():
    args = parse_args()
    console.print("\n[bold cyan]═══ MongoDB → Qdrant Embedding Migration ═══[/]\n")

    # 1. Connect to MongoDB
    console.print("[cyan]Connecting to MongoDB...[/]")
    client, db = connect_mongo()

    cursor, total = fetch_mongo_embeddings(db)
    console.print(f"  Found [bold]{total}[/] document embeddings with vectors in MongoDB")

    if total == 0:
        console.print("[yellow]No document embeddings with vectors found in MongoDB. Nothing to migrate.[/]")
        client.close()
        return

    if args.dry_run:
        console.print(f"\n[yellow]Dry run — would migrate {total} embeddings. Exiting.[/]\n")
        client.close()
        return

    # 2. Setup Qdrant
    console.print("\n[cyan]Setting up Qdrant...[/]")
    qdrant = QdrantStore()
    qdrant.setup()

    # Check existing Qdrant stats
    try:
        stats_before = qdrant.get_collection_stats()
        console.print(f"  Qdrant before: {stats_before.get('points_count', 0)} points")
    except Exception:
        console.print("  [dim]Could not fetch Qdrant stats (new collection?)[/]")

    # 3. Migrate in batches
    migrated = 0
    errors = 0
    all_bm25_docs = []
    migrated_mongo_ids = []

    console.print(f"\n[cyan]Migrating {total} embeddings (batch={args.batch})...[/]\n")

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        TimeRemainingColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("Migrating...", total=total)

        batch = []
        for doc in cursor:
            try:
                vec = mongo_doc_to_qdrant_vector(doc)
                batch.append(vec)
                migrated_mongo_ids.append(doc["_id"])

                # Also collect for BM25
                all_bm25_docs.append({
                    "key": vec["key"],
                    "text": vec["text"],
                    "metadata": vec["metadata"],
                })
            except Exception as e:
                console.print(f"\n[red]  Conversion error: {e}[/]")
                errors += 1
                progress.update(task, advance=1)
                continue

            if len(batch) >= args.batch:
                try:
                    qdrant.upsert_vectors(batch, batch_size=args.batch)
                    migrated += len(batch)
                except Exception as e:
                    console.print(f"\n[red]  Qdrant upsert error: {e}[/]")
                    errors += len(batch)
                progress.update(task, advance=len(batch))
                batch = []
                time.sleep(0.05)

        # Final partial batch
        if batch:
            try:
                qdrant.upsert_vectors(batch, batch_size=args.batch)
                migrated += len(batch)
            except Exception as e:
                console.print(f"\n[red]  Qdrant upsert error (final batch): {e}[/]")
                errors += len(batch)
            progress.update(task, advance=len(batch))

    console.print(f"\n[bold green]✓ Qdrant migration complete[/]")
    console.print(f"  Migrated: {migrated}")
    console.print(f"  Errors:   {errors}")

    # 4. Rebuild BM25 index from ALL data
    # First, collect existing Qdrant points (the ones already there before migration)
    console.print("\n[cyan]Rebuilding BM25 index from all Qdrant data...[/]")

    try:
        # Scroll all points from Qdrant to build a comprehensive BM25 index
        all_corpus_docs = _fetch_all_qdrant_points(qdrant)
        console.print(f"  Total points in Qdrant: {len(all_corpus_docs)}")

        if all_corpus_docs:
            HybridRetriever.build_bm25_index(all_corpus_docs)
            console.print(f"[green]  ✓ BM25 index rebuilt with {len(all_corpus_docs)} documents[/]")
        else:
            console.print("[yellow]  No points found in Qdrant for BM25 rebuild[/]")
    except Exception as e:
        console.print(f"[red]  BM25 rebuild failed: {e}[/]")
        console.print("[yellow]  You can rebuild manually with: python 02_embed_and_index.py[/]")

    # 5. Optionally clear vectors in MongoDB
    if args.clear_mongo_vectors and migrated > 0:
        console.print("\n[cyan]Clearing vector data from MongoDB...[/]")
        embeddings_col = db["embeddings"]
        result = embeddings_col.update_many(
            {"_id": {"$in": migrated_mongo_ids}},
            {"$set": {"vector": None, "provider": "qdrant"}},
        )
        console.print(f"  Cleared vectors from {result.modified_count} documents")

    # 6. Verify
    try:
        stats_after = qdrant.get_collection_stats()
        console.print(f"\n  Qdrant collection [bold]{Config.QDRANT_COLLECTION_NAME}[/]:")
        console.print(f"    Points:  {stats_after.get('points_count', '?')}")
        console.print(f"    Indexed: {stats_after.get('indexed_vectors_count', '?')}")
        console.print(f"    Status:  {stats_after.get('status', '?')}")
    except Exception:
        pass

    client.close()
    console.print("\n[bold green]✓ Migration complete — system should work as before.[/]\n")


def _fetch_all_qdrant_points(qdrant: QdrantStore) -> list:
    """
    Scroll through all points in the Qdrant collection to build
    a complete BM25 corpus. Uses scroll API for efficiency.
    """
    all_docs = []
    offset = None
    limit = 500

    while True:
        scroll_kwargs = {
            "collection_name": qdrant.collection_name,
            "limit": limit,
            "with_payload": True,
            "with_vectors": False,
        }
        if offset is not None:
            scroll_kwargs["offset"] = offset

        points, next_offset = qdrant.client.scroll(**scroll_kwargs)

        for point in points:
            payload = dict(point.payload) if point.payload else {}
            text = payload.pop("text", "")
            all_docs.append({
                "key": str(point.id),
                "text": text,
                "metadata": payload,
            })

        if next_offset is None or len(points) == 0:
            break
        offset = next_offset

    return all_docs


if __name__ == "__main__":
    main()
