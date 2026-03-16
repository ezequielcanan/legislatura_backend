"""
Migration script: Pinecone → Qdrant

Reads every vector (with embedding + metadata) from the existing Pinecone
index and upserts them into the Qdrant collection, preserving IDs, payloads,
and embeddings exactly as they are — no re-embedding required.

Usage:
    python migrate_pinecone_to_qdrant.py                 # full migration
    python migrate_pinecone_to_qdrant.py --dry-run       # preview only
    python migrate_pinecone_to_qdrant.py --batch 200     # custom batch size
"""
import argparse
import sys
import time
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

console = Console()

# ── Pinecone helpers (use the legacy module directly) ───────────
from pinecone import Pinecone


def connect_pinecone():
    pc = Pinecone(api_key=Config.PINECONE_API_KEY)
    index = pc.Index(Config.PINECONE_INDEX_NAME)
    return index


def fetch_all_ids(index, namespace: str = "") -> list:
    """Paginate through Pinecone list endpoint to collect all vector IDs.
    In Pinecone SDK v6, index.list() is a generator that yields pages,
    where each page is a list of ID strings.
    """
    all_ids = []
    for page in index.list(namespace=namespace, limit=100):
        all_ids.extend(page)
    return all_ids


def fetch_vectors_batch(index, ids: list, namespace: str = "") -> list:
    """Fetch full vectors (values + metadata) for a batch of IDs.
    Pinecone v6 returns a FetchResponse dataclass with .vectors dict
    mapping ID → Vector(id, values, metadata).
    """
    resp = index.fetch(ids=ids, namespace=namespace)
    vectors = []
    for vid, data in resp.vectors.items():
        meta = dict(data.metadata) if data.metadata else {}
        text = meta.pop("text", "")
        # Pinecone stores numeric fields as float; cast back to int
        if "expedienteId" in meta:
            meta["expedienteId"] = int(meta["expedienteId"])
        if "chunkIndex" in meta:
            meta["chunkIndex"] = int(meta["chunkIndex"])
        vectors.append({
            "key": vid,
            "vector": list(data.values),
            "text": text,
            "metadata": meta,
        })
    return vectors


# ── Qdrant target ──────────────────────────────────────────────
from lib.qdrant_vectors import VectorStore as QdrantStore


def parse_args():
    p = argparse.ArgumentParser(description="Migrate Pinecone → Qdrant")
    p.add_argument("--dry-run", action="store_true", help="Only count vectors; don't write.")
    p.add_argument("--batch", type=int, default=100, help="Upsert batch size (default 100).")
    p.add_argument("--namespace", type=str, default="", help="Pinecone namespace (default: '').")
    return p.parse_args()


def main():
    args = parse_args()
    console.print("\n[bold cyan]═══ Pinecone → Qdrant Migration ═══[/]\n")

    # 1. Connect to Pinecone
    console.print("[cyan]Connecting to Pinecone...[/]")
    pc_index = connect_pinecone()
    stats = pc_index.describe_index_stats()
    total_vectors = stats.get("total_vector_count", 0)
    console.print(f"  Pinecone index [bold]{Config.PINECONE_INDEX_NAME}[/]: {total_vectors} vectors")

    if total_vectors == 0:
        console.print("[yellow]No vectors found in Pinecone. Nothing to migrate.[/]")
        return

    # 2. Collect all IDs
    console.print("\n[cyan]Listing all vector IDs...[/]")
    all_ids = fetch_all_ids(pc_index, namespace=args.namespace)
    console.print(f"  Found {len(all_ids)} IDs")

    if not all_ids:
        console.print("[yellow]Could not list IDs. Trying stats-based estimation...[/]")
        console.print("[red]Migration aborted — Pinecone list() returned no IDs.[/]")
        console.print("[dim]Tip: ensure your Pinecone plan supports the list() endpoint.[/]")
        return

    if args.dry_run:
        console.print(f"\n[yellow]Dry run — would migrate {len(all_ids)} vectors. Exiting.[/]\n")
        return

    # 3. Setup Qdrant
    console.print("\n[cyan]Setting up Qdrant...[/]")
    qdrant = QdrantStore()
    qdrant.setup()

    # 4. Migrate in batches
    batch_size = args.batch
    fetch_batch_size = min(batch_size, 100)  # Pinecone fetch limit per call
    migrated = 0
    errors = 0

    console.print(f"\n[cyan]Migrating {len(all_ids)} vectors (batch={batch_size})...[/]\n")

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        TimeRemainingColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("Migrating...", total=len(all_ids))

        for i in range(0, len(all_ids), fetch_batch_size):
            id_batch = all_ids[i : i + fetch_batch_size]

            try:
                vectors = fetch_vectors_batch(pc_index, id_batch, namespace=args.namespace)
            except Exception as e:
                console.print(f"\n[red]  Fetch error at offset {i}: {e}[/]")
                errors += len(id_batch)
                progress.update(task, advance=len(id_batch))
                continue

            if not vectors:
                progress.update(task, advance=len(id_batch))
                continue

            try:
                qdrant.upsert_vectors(vectors, batch_size=batch_size)
                migrated += len(vectors)
            except Exception as e:
                console.print(f"\n[red]  Upsert error at offset {i}: {e}[/]")
                errors += len(vectors)

            progress.update(task, advance=len(id_batch))

            # Small delay to avoid hammering Pinecone
            time.sleep(0.1)

    # 5. Verify
    console.print(f"\n[bold green]✓ Migration complete[/]")
    console.print(f"  Migrated: {migrated}")
    console.print(f"  Errors:   {errors}")

    qdrant_stats = qdrant.get_collection_stats()
    console.print(f"\n  Qdrant collection [bold]{Config.QDRANT_COLLECTION_NAME}[/]:")
    console.print(f"    Points:  {qdrant_stats.get('points_count', '?')}")
    console.print(f"    Indexed: {qdrant_stats.get('indexed_vectors_count', '?')}")
    console.print(f"    Status:  {qdrant_stats.get('status', '?')}")
    console.print()


if __name__ == "__main__":
    main()
