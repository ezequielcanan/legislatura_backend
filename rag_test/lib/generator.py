"""
RAG Generator — produces LLM answers grounded in retrieved context,
with mandatory source citations.

Follows the blog's approach:
- Pack context intelligently (highest score first, fit within token budget)
- Low temperature for factual accuracy
- Citation format: [REF-N]
- System prompt enforcing grounding rules
"""
import requests
from typing import List, Dict, Optional, Generator
from config import Config


class RAGGenerator:
    """Generates answers from retrieved context using OpenRouter LLM."""

    MAX_CONTEXT_TOKENS = 16384  # Leave room for response

    def generate(
        self,
        query: str,
        retrieved_docs: List[Dict],
        conversation_history: Optional[List[Dict]] = None,
        stream: bool = False,
    ) -> Dict:
        """
        Generate a grounded answer.
        Returns: {answer, sources, context_used}
        """
        context = self._pack_context(retrieved_docs, self.MAX_CONTEXT_TOKENS)
        messages = self._build_messages(query, context, conversation_history)

        if stream:
            return {"stream": self._stream_response(messages), "sources": context}

        # Non-streaming
        url = f"{Config.OPENROUTER_API_URL}/chat/completions"
        headers = {
            "Authorization": f"Bearer {Config.OPENROUTER_API_KEY}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": Config.OPENROUTER_CHAT_MODEL,
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": 8000,
        }

        resp = requests.post(url, json=payload, headers=headers, timeout=120)
        resp.raise_for_status()
        answer = resp.json()["choices"][0]["message"]["content"]

        return {
            "answer": answer,
            "sources": self._deduplicated_sources(context),
            "context_count": len(context),
        }

    def _stream_response(self, messages: List[Dict]) -> Generator[str, None, None]:
        """Stream the response token by token."""
        url = f"{Config.OPENROUTER_API_URL}/chat/completions"
        headers = {
            "Authorization": f"Bearer {Config.OPENROUTER_API_KEY}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": Config.OPENROUTER_CHAT_MODEL,
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": 8000,
            "stream": True,
        }

        with requests.post(
            url, json=payload, headers=headers, timeout=120, stream=True
        ) as resp:
            resp.raise_for_status()
            for line in resp.iter_lines():
                if not line:
                    continue
                text = line.decode("utf-8")
                if text.startswith("data: "):
                    data = text[6:]
                    if data.strip() == "[DONE]":
                        break
                    try:
                        import json
                        chunk = json.loads(data)
                        delta = chunk["choices"][0].get("delta", {})
                        content = delta.get("content", "")
                        if content:
                            yield content
                    except (KeyError, IndexError, json.JSONDecodeError):
                        continue

    def _pack_context(
        self, docs: List[Dict], max_tokens: int
    ) -> List[Dict]:
        """
        Pack the best documents into the context window.
        Blog approach: highest score first, estimate tokens, stop at budget.
        """
        sorted_docs = sorted(
            docs, key=lambda x: x.get("score", 0), reverse=True
        )
        packed = []
        token_count = 0

        for doc in sorted_docs:
            text = doc.get("text", "")
            # Rough token estimate: 1 token ≈ 4 chars for Spanish
            estimated_tokens = len(text) / 3.5
            if token_count + estimated_tokens > max_tokens:
                break
            packed.append(doc)
            token_count += estimated_tokens

        return packed

    def _build_messages(
        self,
        query: str,
        context: List[Dict],
        history: Optional[List[Dict]] = None,
    ) -> List[Dict]:
        # System prompt
        messages = [{"role": "system", "content": self._system_prompt()}]

        # Conversation history (last 6 messages)
        if history:
            for msg in history[-6:]:
                messages.append({
                    "role": msg.get("role", "user"),
                    "content": msg.get("text", msg.get("content", "")),
                })

        # Group context by expediente for coherent presentation
        context_text = self._group_context_by_expediente(context)

        user_msg = f"""Documentos de contexto:
{context_text}

Pregunta del usuario: {query}

Proporciona una respuesta completa basada en los documentos de contexto anteriores.
Incluye TODA la información relevante sin truncar ni resumir con puntos suspensivos.
Si la pregunta es sobre la conversación en sí, usa el historial de mensajes."""

        messages.append({"role": "user", "content": user_msg})
        return messages

    def _group_context_by_expediente(self, context: List[Dict]) -> str:
        """Group chunks by expediente and order by chunkIndex for completeness."""
        from collections import OrderedDict

        grouped: OrderedDict = OrderedDict()
        ref_counter = 0

        for doc in context:
            numero = doc.get("metadata", {}).get("numero", "unknown")
            if numero not in grouped:
                grouped[numero] = {
                    "docs": [],
                    "tipo": doc.get("metadata", {}).get("tipo", "?"),
                    "ref_start": ref_counter + 1,
                }
            grouped[numero]["docs"].append(doc)

        parts = []
        ref_counter = 0
        for numero, group in grouped.items():
            # Sort chunks within expediente by chunkIndex
            group["docs"].sort(
                key=lambda d: d.get("metadata", {}).get("chunkIndex", 999)
            )
            for doc in group["docs"]:
                ref_counter += 1
                chunk_type = doc.get("metadata", {}).get("chunkType", "CONTENT")
                parts.append(
                    f"[REF-{ref_counter}] (Expediente: {numero}, "
                    f"Tipo: {group['tipo']}, Parte: {chunk_type})\n"
                    f"{doc.get('text', '')}"
                )

        return "\n\n".join(parts)

    @staticmethod
    def _deduplicated_sources(context: list) -> list:
        """One source entry per unique expediente (best score wins)."""
        seen: dict = {}  # numero -> source dict
        ref_counter = 0
        for doc in context:
            numero = doc.get("metadata", {}).get("numero", "?")
            score = doc.get("score", 0)
            if numero not in seen or score > seen[numero]["score"]:
                ref_counter += 1
                seen[numero] = {
                    "ref": f"REF-{ref_counter}",
                    "numero": numero,
                    "tipo": doc.get("metadata", {}).get("tipo", "?"),
                    "preview": doc.get("text", "")[:150],
                    "score": score,
                }
        # Re-number sequentially
        sources = sorted(seen.values(), key=lambda s: s["score"], reverse=True)
        for i, s in enumerate(sources):
            s["ref"] = f"REF-{i + 1}"
        return sources

    def _system_prompt(self) -> str:
        return """Eres un asistente experto en legislación de la Ciudad de Buenos Aires (CABA).

Reglas estrictas:
1. Responde usando información de los documentos de contexto proporcionados como fuente principal
2. NO incluyas referencias inline como [REF-1], [REF-2], etc. en el texto de tu respuesta — las fuentes se proporcionan de forma estructurada por separado y el usuario las verá automáticamente
3. Si la información no está en el contexto, di: "Los documentos proporcionados no contienen información sobre [tema]"
4. NUNCA inventes datos, números de expediente, o información no presente en el contexto
5. Mantén un lenguaje profesional y preciso
6. Si hay múltiples expedientes relevantes, menciona TODOS Y CADA UNO con su número completo — no te limites a un subconjunto arbitrario
7. Cuando menciones un expediente, incluye siempre su número (ej: "2922-D-2025")
8. Los chunks del MISMO expediente están agrupados y ordenados — úsalos juntos para dar respuestas COMPLETAS. NUNCA truncar información con "..." o "…" — proporciona la información COMPLETA
9. Distingue claramente entre expedientes diferentes aunque traten temas similares: cita el número, tipo y autor de cada uno
10. Si el contexto contiene chunks de tipo SUMMARY, úsalos para dar una visión general antes de entrar en detalles
11. Tienes acceso al historial de conversación previo — puedes referirte a mensajes anteriores del usuario o tus propias respuestas previas cuando sea relevante
12. Si el usuario hace una pregunta sobre la conversación en sí (ej: "¿qué te pregunté antes?"), responde usando el historial de la conversación, NO de los documentos

Formato de respuesta:
- Respuesta clara y estructurada
- Cuando hay múltiples expedientes, usa listas o secciones para cada uno
- Proporciona TODA la información disponible en los documentos — nunca recortes con puntos suspensivos
- Idioma: Español"""
