"""
Step 3: Interactive RAG Chatbot.

Full pipeline: query → hybrid retrieval → LLM generation with citations.
Supports conversation history, streaming, and optional semantic cache.

Usage:
    python 03_chatbot.py              # Interactive console mode
    python 03_chatbot.py --single "¿Qué proyectos de ley tratan sobre educación?"
    python 03_chatbot.py --stream     # Enable streaming output
    python 03_chatbot.py --no-hyde    # Disable HyDE expansion
    python 03_chatbot.py --no-bm25   # Disable BM25
    python 03_chatbot.py --no-rerank # Disable LLM reranking
    python 03_chatbot.py --debug     # Show retrieval details
"""
import argparse
import sys
import time
from pathlib import Path

from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.table import Table

sys.path.insert(0, str(Path(__file__).parent))

from config import Config
from lib.hybrid_retriever import HybridRetriever
from lib.generator import RAGGenerator
from lib.cache import SemanticCache
from lib.embeddings import embed_single

console = Console()


def parse_args():
    parser = argparse.ArgumentParser(description="RAG Chatbot for Legislatura CABA")
    parser.add_argument("--single", type=str, help="Single query mode (non-interactive)")
    parser.add_argument("--stream", action="store_true", help="Enable streaming output")
    parser.add_argument("--no-hyde", action="store_true", help="Disable HyDE expansion")
    parser.add_argument("--no-bm25", action="store_true", help="Disable BM25 search")
    parser.add_argument("--no-rerank", action="store_true", help="Disable LLM reranking")
    parser.add_argument("--no-multi-query", action="store_true", help="Disable multi-query expansion")
    parser.add_argument("--no-mmr", action="store_true", help="Disable MMR diversity")
    parser.add_argument("--no-parent", action="store_true", help="Disable parent-child chunk retrieval")
    parser.add_argument("--no-cache", action="store_true", help="Disable semantic cache")
    parser.add_argument("--debug", action="store_true", help="Show retrieval debug info")
    parser.add_argument("--top-k", type=int, default=Config.RAG_TOP_K, help="Number of results")
    return parser.parse_args()


class Chatbot:
    def __init__(self, args):
        self.args = args
        self.retriever = HybridRetriever()
        self.generator = RAGGenerator()
        self.cache = SemanticCache() if not args.no_cache else None
        self.history = []  # Conversation history

    def ask(self, query: str) -> str:
        """Full RAG pipeline: retrieve → generate → return answer."""
        start = time.time()

        # ── Embed query once (reused for cache + retrieval) ─────
        query_embedding = embed_single(query)

        # ── Check cache ─────────────────────────────────────────
        if self.cache:
            cached = self.cache.get(query_embedding)
            if cached:
                elapsed = time.time() - start
                if self.args.debug:
                    console.print(f"  [dim]Cache hit (similarity: {cached['similarity']:.3f}, {elapsed:.1f}s)[/]")
                return cached["answer"]

        # ── Retrieve ────────────────────────────────────────────
        t_retrieve = time.time()

        if self.args.debug:
            from lib.query_analyzer import QueryAnalyzer
            analyzer = QueryAnalyzer()
            analysis = analyzer.analyze(query)
            console.print(f"\n  [dim]Intent: {analysis['intent']} | Filters: {analysis.get('filters', {})}[/]")
            if analysis.get("query_variants"):
                console.print(f"  [dim]Query variants: {analysis['query_variants'][:3]}[/]")

        results = self.retriever.retrieve(
            query,
            top_k=self.args.top_k,
            enable_hyde=not self.args.no_hyde,
            enable_bm25=not self.args.no_bm25,
            enable_rerank=not self.args.no_rerank,
            enable_multi_query=not self.args.no_multi_query,
            enable_mmr=not self.args.no_mmr,
            enable_parent_retrieval=not self.args.no_parent,
            query_embedding=query_embedding,
        )
        retrieve_time = time.time() - t_retrieve

        if self.args.debug:
            self._show_retrieval_debug(results, retrieve_time)

        if not results:
            return "No encontré documentos relevantes para tu consulta. Intenta reformular la pregunta."

        # ── Generate ────────────────────────────────────────────
        t_generate = time.time()
        response = self.generator.generate(
            query=query,
            retrieved_docs=results,
            conversation_history=self.history,
            stream=self.args.stream,
        )

        if self.args.stream:
            # Handle streaming
            answer_parts = []
            for token in response["stream"]:
                console.print(token, end="")
                answer_parts.append(token)
            console.print()  # newline
            answer = "".join(answer_parts)
        else:
            answer = response["answer"]

        generate_time = time.time() - t_generate
        total_time = time.time() - start

        # ── Update history ──────────────────────────────────────
        self.history.append({"role": "user", "content": query})
        self.history.append({"role": "assistant", "content": answer})

        # Keep last 10 messages
        if len(self.history) > 10:
            self.history = self.history[-10:]

        # ── Cache result ────────────────────────────────────────
        if self.cache and not self.args.stream:
            try:
                self.cache.set(query, query_embedding, answer, response.get("sources", []))
            except Exception:
                pass  # Cache is optional

        # ── Show timing ─────────────────────────────────────────
        if self.args.debug:
            console.print(
                f"\n  [dim]Retrieval: {retrieve_time:.1f}s | "
                f"Generation: {generate_time:.1f}s | "
                f"Total: {total_time:.1f}s[/]"
            )

        # ── Show sources ────────────────────────────────────────
        if not self.args.stream and response.get("sources"):
            self._show_sources(response["sources"])

        return answer

    def _show_retrieval_debug(self, results, elapsed):
        console.print(f"\n  [dim]Retrieved {len(results)} documents in {elapsed:.1f}s[/]")
        table = Table(title="Retrieved Documents", show_lines=True, width=120)
        table.add_column("#", width=3)
        table.add_column("Score", width=8)
        table.add_column("Source", width=8)
        table.add_column("Expediente", width=18)
        table.add_column("Type", width=10)
        table.add_column("Preview", width=60)

        for i, r in enumerate(results[:10]):
            meta = r.get("metadata", {})
            table.add_row(
                str(i + 1),
                f"{r.get('score', 0):.4f}",
                r.get("source", "?"),
                str(meta.get("numero", "?")),
                str(meta.get("chunkType", "?")),
                r.get("text", "")[:60] + "...",
            )
        console.print(table)

    def _show_sources(self, sources):
        if not sources:
            return
        console.print(f"\n[dim]Fuentes totales: {len(sources)}[/]")       
        console.print("\n[dim]Fuentes:[/]")
        for s in sources:
            ref = s.get("ref", "?")
            numero = s.get("numero", "?")
            tipo = s.get("tipo", "?")
            score = s.get("score", 0)
            console.print(f"  [dim]{ref}: Expediente {numero} ({tipo}) — score: {score:.4f}[/]")


def interactive_mode(chatbot: Chatbot):
    """Interactive console chatbot loop."""
    console.print(
        Panel.fit(
            "[bold cyan]RAG Chatbot — Legislatura CABA[/]\n"
            "[dim]Escribe tu pregunta sobre legislación porteña.\n"
            "Comandos: /clear (limpiar historial), /debug (toggle debug), /quit (salir)[/]",
            border_style="cyan",
        )
    )
    console.print()

    while True:
        try:
            query = console.input("[bold green]Tú:[/] ").strip()
        except (EOFError, KeyboardInterrupt):
            console.print("\n[dim]¡Hasta luego![/]")
            break

        if not query:
            continue

        if query.lower() in ("/quit", "/exit", "/q"):
            console.print("[dim]¡Hasta luego![/]")
            break

        if query.lower() == "/clear":
            chatbot.history.clear()
            console.print("[dim]Historial limpiado.[/]\n")
            continue

        if query.lower() == "/debug":
            chatbot.args.debug = not chatbot.args.debug
            console.print(f"[dim]Debug: {'ON' if chatbot.args.debug else 'OFF'}[/]\n")
            continue

        console.print()
        console.print("[bold blue]Asistente:[/]")

        if chatbot.args.stream:
            chatbot.ask(query)
        else:
            answer = chatbot.ask(query)
            console.print(Markdown(answer))

        console.print()


def single_query_mode(chatbot: Chatbot, query: str):
    """Run a single query and exit."""
    console.print(f"\n[bold green]Query:[/] {query}\n")
    console.print("[bold blue]Asistente:[/]")

    if chatbot.args.stream:
        chatbot.ask(query)
    else:
        answer = chatbot.ask(query)
        console.print(Markdown(answer))

    console.print()


def main():
    args = parse_args()
    chatbot = Chatbot(args)

    if args.single:
        single_query_mode(chatbot, args.single)
    else:
        interactive_mode(chatbot)


if __name__ == "__main__":
    main()
