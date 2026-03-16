"""
Step 1: Extract expedientes from MongoDB and chunk them.

Connects to your existing MongoDB, fetches COMPLETED expedientes
with pdfText, and applies semantic chunking (blog architecture).

Output: data/chunks.json — all chunks ready for embedding.
"""
import json
import os
import sys
from pathlib import Path

from rich.console import Console
from rich.progress import track
from rich.table import Table

# Ensure project root is in path
sys.path.insert(0, str(Path(__file__).parent))

from config import Config
from lib.mongo_client import fetch_completed_expedientes, count_expedientes
from lib.chunker import SemanticChunker

console = Console()
DATA_DIR = Path(__file__).parent / "data"


def main():
    DATA_DIR.mkdir(exist_ok=True)

    # ── 1. Show database stats ──────────────────────────────────
    console.print("\n[bold cyan]═══ Step 1: Extract & Chunk Expedientes ═══[/]\n")

    total = count_expedientes()
    completed = count_expedientes("COMPLETED")
    console.print(f"  Total expedientes in DB: [bold]{total}[/]")
    console.print(f"  COMPLETED expedientes:   [bold green]{completed}[/]")
    console.print(f"  Will process up to:      [bold yellow]{Config.MAX_EXPEDIENTES}[/]\n")

    # ── 2. Fetch from MongoDB ───────────────────────────────────
    console.print("[cyan]Fetching expedientes from MongoDB...[/]")
    expedientes = fetch_completed_expedientes(limit=Config.MAX_EXPEDIENTES)
    console.print(f"  Fetched: [bold]{len(expedientes)}[/] expedientes\n")

    if not expedientes:
        console.print("[red]No expedientes found. Check your MongoDB connection.[/]")
        return

    # ── 3. Chunk documents ──────────────────────────────────────
    chunker = SemanticChunker(
        chunk_size=Config.CHUNK_SIZE_TOKENS,
        overlap=Config.CHUNK_OVERLAP_TOKENS,
    )

    all_chunks = []
    stats = {"total_expedientes": 0, "total_chunks": 0, "summary_chunks": 0}

    for exp in track(expedientes, description="Chunking documents..."):
        pdf_text = exp.get("pdfText", "")
        if not pdf_text or len(pdf_text.strip()) < 50:
            continue

        metadata = {
            "expedienteId": exp.get("expedienteId"),
            "numero": exp.get("numero", ""),
            "titulo": exp.get("titulo", ""),
            "tipo": exp.get("tipo", ""),
            "autor": exp.get("autor"),
            "fechaIngreso": exp.get("fechaIngreso", ""),
            "aiSummary": exp.get("aiSummary", ""),
            "aiTags": exp.get("aiTags", []),
            "aiCategory": exp.get("aiCategory", ""),
            "baeSource": exp.get("baeSource", False),
        }

        # Summary chunk (always created if AI summary exists)
        if metadata.get("aiSummary"):
            summary_chunk = chunker.create_summary_chunk(metadata)
            all_chunks.append(summary_chunk)
            stats["summary_chunks"] += 1

        # Content chunks
        content_chunks = chunker.chunk_document(pdf_text, metadata)
        all_chunks.extend(content_chunks)

        stats["total_expedientes"] += 1
        stats["total_chunks"] += len(content_chunks)

    # ── 4. Save to disk ────────────────────────────────────────
    output_path = DATA_DIR / "chunks.json"

    # Convert for JSON serialization
    serializable = []
    for chunk in all_chunks:
        c = chunk.copy()
        # Ensure all metadata values are JSON-safe
        meta = c.get("metadata", {})
        if isinstance(meta.get("aiTags"), list):
            meta["aiTags"] = [str(t) for t in meta["aiTags"]]
        serializable.append(c)

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(serializable, f, ensure_ascii=False, indent=2, default=str)

    # ── 5. Report ──────────────────────────────────────────────
    console.print()
    table = Table(title="Chunking Results")
    table.add_column("Metric", style="cyan")
    table.add_column("Value", style="green", justify="right")
    table.add_row("Expedientes processed", str(stats["total_expedientes"]))
    table.add_row("Summary chunks", str(stats["summary_chunks"]))
    table.add_row("Content chunks", str(stats["total_chunks"]))
    table.add_row("Total chunks", str(len(all_chunks)))
    table.add_row("Output file", str(output_path))
    console.print(table)

    # Sample
    if all_chunks:
        console.print("\n[bold]Sample chunk:[/]")
        sample = all_chunks[0]
        console.print(f"  Type: {sample['metadata']['chunkType']}")
        console.print(f"  Expediente: {sample['metadata']['numero']}")
        console.print(f"  Tokens: {sample['metadata']['chunk_size_tokens']}")
        console.print(f"  Preview: {sample['metadata']['preview'][:120]}...")

    console.print("\n[green]✓ Done! Run 02_embed_and_index.py next.[/]\n")


if __name__ == "__main__":
    main()
