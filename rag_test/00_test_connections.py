"""
Quick test script — verifies each component independently.
Run after installing dependencies but before the full pipeline.

Usage:  python 00_test_connections.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from rich.console import Console

console = Console()


def test_config():
    console.print("\n[bold]1. Testing config...[/]")
    from config import Config

    assert Config.MONGODB_URI, "MONGODB_URI not set"
    assert Config.OPENROUTER_API_KEY, "OPENROUTER_API_KEY not set"
    assert Config.QDRANT_URL, "QDRANT_URL not set"
    console.print("  [green]✓ Config loaded[/]")


def test_mongodb():
    console.print("\n[bold]2. Testing MongoDB...[/]")
    from lib.mongo_client import count_expedientes

    total = count_expedientes()
    completed = count_expedientes("completed")
    console.print(f"  Total expedientes: {total}")
    console.print(f"  COMPLETED:         {completed}")
    assert total > 0, "No expedientes found"
    console.print("  [green]✓ MongoDB connected[/]")


def test_openrouter_embedding():
    console.print("\n[bold]3. Testing OpenRouter embeddings...[/]")
    from lib.embeddings import embed_single

    vec = embed_single("Proyecto de ley sobre educación en CABA")
    assert len(vec) == 1536, f"Expected 1536 dims, got {len(vec)}"
    console.print(f"  Embedding dims: {len(vec)}")
    console.print(f"  Sample values: {vec[:5]}")
    console.print("  [green]✓ Embeddings working[/]")


def test_openrouter_chat():
    console.print("\n[bold]4. Testing OpenRouter chat...[/]")
    import requests
    from config import Config

    url = f"{Config.OPENROUTER_API_URL}/chat/completions"
    headers = {
        "Authorization": f"Bearer {Config.OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": Config.OPENROUTER_RERANK_MODEL,
        "messages": [{"role": "user", "content": "Di 'hola' en una palabra."}],
        "max_tokens": 10,
    }
    resp = requests.post(url, json=payload, headers=headers, timeout=30)
    resp.raise_for_status()
    answer = resp.json()["choices"][0]["message"]["content"]
    console.print(f"  LLM response: {answer}")
    console.print("  [green]✓ Chat LLM working[/]")


def test_qdrant():
    console.print("\n[bold]5. Testing Qdrant...[/]")
    from lib.qdrant_vectors import VectorStore

    store = VectorStore()
    collections = store.list_collections()
    console.print(f"  Existing collections: {len(collections)}")
    for name in collections:
        console.print(f"    - {name}")
    console.print("  [green]✓ Qdrant accessible[/]")


def test_chunker():
    console.print("\n[bold]6. Testing chunker...[/]")
    from lib.chunker import SemanticChunker

    chunker = SemanticChunker(chunk_size=100, overlap=20)
    test_text = (
        "ARTÍCULO 1°.- Créase el Programa de Educación Digital en el ámbito "
        "de la Ciudad Autónoma de Buenos Aires. El mismo tendrá como objetivo "
        "promover la alfabetización digital de todos los habitantes.\n\n"
        "ARTÍCULO 2°.- El Poder Ejecutivo reglamentará la presente ley dentro "
        "de los noventa (90) días de su promulgación."
    )
    chunks = chunker.chunk_document(
        test_text,
        {"numero": "TEST-1-2025", "tipo": "Proyecto de Ley", "aiCategory": "Educación"},
    )
    console.print(f"  Input: {len(test_text)} chars")
    console.print(f"  Output: {len(chunks)} chunks")
    for i, c in enumerate(chunks):
        console.print(f"    Chunk {i}: {c['metadata']['chunk_size_tokens']} tokens")
    console.print("  [green]✓ Chunker working[/]")


def main():
    console.print("[bold cyan]═══ Connection & Component Tests ═══[/]")

    tests = [
        ("Config", test_config),
        ("MongoDB", test_mongodb),
        ("OpenRouter Embedding", test_openrouter_embedding),
        ("OpenRouter Chat", test_openrouter_chat),
        ("Qdrant", test_qdrant),
        ("Chunker", test_chunker),
    ]

    passed = 0
    failed = 0

    for name, fn in tests:
        try:
            fn()
            passed += 1
        except Exception as e:
            console.print(f"  [red]✗ {name} failed: {e}[/]")
            failed += 1

    console.print(f"\n[bold]Results: {passed} passed, {failed} failed[/]")

    if failed > 0:
        console.print("[yellow]Fix the failing tests before running the pipeline.[/]\n")
        sys.exit(1)
    else:
        console.print("[green]All tests passed! Ready to run the pipeline.[/]\n")


if __name__ == "__main__":
    main()
