"""
Semantic Chunker — Blog architecture adapted for legislative documents.

Key ideas from the blog:
- Token-based chunking (300 tokens, 50 overlap) instead of char-based
- Structure-aware: detect sections, respect boundaries
- Contextual metadata prefix per chunk (from existing backend approach)
"""
import re
from typing import List, Dict
import tiktoken
from config import Config


class SemanticChunker:
    """
    Splits document text into semantically meaningful chunks with overlap,
    respecting section boundaries where possible.
    """

    def __init__(
        self,
        chunk_size: int = Config.CHUNK_SIZE_TOKENS,
        overlap: int = Config.CHUNK_OVERLAP_TOKENS,
    ):
        self.chunk_size = chunk_size
        self.overlap = overlap
        self.encoder = tiktoken.get_encoding("cl100k_base")

    # ── Public API ──────────────────────────────────────────────

    def chunk_document(self, text: str, metadata: Dict) -> List[Dict]:
        """
        Chunk a document into pieces.  Returns list of dicts:
        {text, metadata: {…, chunk_size, chunkIndex, totalChunks, chunkType}}
        """
        if not text or not text.strip():
            return []

        # 1. Clean text
        text = self._clean_text(text)

        # 2. Detect sections (articles, chapters, headings)
        sections = self._detect_sections(text)

        # 3. Create raw chunks respecting section boundaries
        raw_chunks: List[str] = []
        for section in sections:
            token_len = len(self.encoder.encode(section))
            if token_len <= self.chunk_size:
                # Atomic section — keep as single chunk
                raw_chunks.append(section)
            else:
                # Split with overlap
                raw_chunks.extend(
                    self._split_with_overlap(section, self.chunk_size, self.overlap)
                )

        # 4. Build chunk dicts with contextual prefix
        total = len(raw_chunks)
        chunks = []
        for idx, chunk_text in enumerate(raw_chunks):
            prefixed = self._add_context_prefix(chunk_text, metadata, idx, total)
            chunks.append(
                self._create_chunk(prefixed, chunk_text, metadata, idx, total, "CONTENT")
            )

        return chunks

    def create_summary_chunk(self, metadata: Dict) -> Dict:
        """
        Create a summary embedding chunk from AI-generated fields,
        matching the backend's SUMMARY chunkType strategy.
        """
        parts = []
        parts.append(f"[Expediente {metadata.get('numero', '?')} | "
                      f"{metadata.get('tipo', '?')} | "
                      f"{metadata.get('aiCategory', '?')}]")

        if metadata.get("titulo"):
            parts.append(f"Título: {metadata['titulo']}")

        autor_str = self._format_autor(metadata)
        if autor_str:
            parts.append(f"Autor: {autor_str}")

        if metadata.get("fechaIngreso"):
            parts.append(f"Fecha: {metadata['fechaIngreso']}")

        if metadata.get("aiSummary"):
            parts.append(f"Resumen: {metadata['aiSummary']}")

        if metadata.get("aiTags"):
            tags = metadata["aiTags"]
            if isinstance(tags, list):
                parts.append(f"Tags: {', '.join(tags)}")

        text = "\n".join(parts)
        return self._create_chunk(text, text, metadata, 0, 1, "SUMMARY")

    # ── Internal helpers ────────────────────────────────────────

    def _clean_text(self, text: str) -> str:
        # Collapse whitespace but keep paragraph breaks
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()

    def _detect_sections(self, text: str) -> List[str]:
        """
        Split on legislative-style section markers:
        ARTÍCULO, TÍTULO, CAPÍTULO, numbered headings, double newlines.
        """
        # Legislative section patterns
        pattern = r"(?=(?:^|\n)(?:ART[ÍI]CULO|T[ÍI]TULO|CAP[ÍI]TULO|SECCI[ÓO]N)\s)"
        sections = re.split(pattern, text, flags=re.IGNORECASE)

        # If no sections detected, split on double newlines (paragraphs)
        if len(sections) <= 1:
            sections = re.split(r"\n\n+", text)

        # Filter empty
        return [s.strip() for s in sections if s.strip()]

    def _split_with_overlap(
        self, text: str, size: int, overlap: int
    ) -> List[str]:
        tokens = self.encoder.encode(text)
        chunks = []
        step = max(size - overlap, 1)

        for i in range(0, len(tokens), step):
            chunk_tokens = tokens[i : i + size]
            if chunk_tokens:
                chunks.append(self.encoder.decode(chunk_tokens))

        return chunks

    def _add_context_prefix(
        self, chunk_text: str, metadata: Dict, idx: int, total: int
    ) -> str:
        """Add contextual prefix to each content chunk (backend strategy)."""
        parts = []
        parts.append(
            f"[Expediente {metadata.get('numero', '?')} | "
            f"{metadata.get('tipo', '?')} | "
            f"{metadata.get('aiCategory', '?')}]"
        )
        if metadata.get("titulo"):
            parts.append(f"Título: {metadata['titulo']}")

        autor_str = self._format_autor(metadata)
        if autor_str:
            parts.append(f"Autor: {autor_str}")

        if metadata.get("fechaIngreso"):
            parts.append(f"Fecha: {metadata['fechaIngreso']}")

        if metadata.get("aiSummary"):
            summary = metadata["aiSummary"]
            if len(summary) > 200:
                summary = summary[:200] + "…"
            parts.append(f"Resumen: {summary}")

        parts.append(f"[Sección {idx + 1} de {total}]")
        parts.append("---")
        parts.append(chunk_text)
        return "\n".join(parts)

    def _format_autor(self, metadata: Dict) -> str:
        autor = metadata.get("autor")
        if not autor:
            return ""
        if isinstance(autor, dict):
            nombre = autor.get("nombre", "")
            apellido = autor.get("apellido", "")
            return f"{nombre} {apellido}".strip()
        return str(autor)

    def _create_chunk(
        self,
        prefixed_text: str,
        raw_text: str,
        metadata: Dict,
        idx: int,
        total: int,
        chunk_type: str,
    ) -> Dict:
        token_count = len(self.encoder.encode(prefixed_text))
        return {
            "text": prefixed_text,
            "raw_text": raw_text,
            "metadata": {
                "expedienteId": metadata.get("expedienteId"),
                "numero": metadata.get("numero", ""),
                "tipo": metadata.get("tipo", ""),
                "titulo": metadata.get("titulo", ""),
                "aiTags": metadata.get("aiTags", []),
                "aiCategory": metadata.get("aiCategory", ""),
                "fechaIngreso": metadata.get("fechaIngreso", ""),
                "baeSource": metadata.get("baeSource", False),
                "chunkIndex": idx,
                "totalChunks": total,
                "chunkType": chunk_type,
                "chunk_size_tokens": token_count,
                "preview": raw_text[:100] + "…" if len(raw_text) > 100 else raw_text,
            },
        }
