"""
Query Analyzer — Extracts structured filters and generates query variants.

For domains with similar documents (legislative), pure vector search
struggles to differentiate. This module:
1. Extracts metadata filters (tipo, categoria, author, date) from the query
2. Generates multiple query variations for multi-query retrieval
3. Detects intent (specific expediente lookup vs. thematic search)
"""
import re
import json
import requests
from typing import Dict, List, Optional
from config import Config


# Known legislative document types (lowercase for matching)
TIPOS_CONOCIDOS = [
    "proyecto de ley", "proyecto de resolución", "proyecto de declaración",
    "proyecto de comunicación", "ley", "resolución", "declaración",
    "comunicación", "decreto", "ordenanza", "pedido de informes",
]

# Known categories (from aiCategory field)
CATEGORIAS_CONOCIDAS = [
    "educación", "salud", "transporte", "seguridad", "medio ambiente",
    "vivienda", "cultura", "presupuesto", "economía", "trabajo",
    "derechos humanos", "infraestructura", "tecnología", "género",
    "niñez", "discapacidad", "turismo", "deportes", "justicia",
    "espacio público", "patrimonio", "homenaje", "beneplácito",
]


class QueryAnalyzer:
    """Analyzes user queries to extract filters and generate variants."""

    def rewrite_with_context(
        self, query: str, conversation_history: Optional[List[Dict]] = None
    ) -> str:
        """
        Rewrite a follow-up query by resolving references (e.g., "este expediente",
        "ese proyecto", "contame mas") using conversation history.
        Returns the rewritten query, or the original if no rewriting is needed.
        """
        if not conversation_history:
            return query

        # If query already has explicit expediente numbers, no rewriting needed
        exp_pattern = r"\b(\d{1,5}\s*[-–]\s*[A-Za-z]{1,4}\s*[-–]\s*\d{4})\b"
        if re.search(exp_pattern, query):
            return query

        # Check for vague/follow-up patterns that need context
        followup_patterns = [
            r"\b(este|ese|aquel|dicho|el mismo|la misma)\b",
            r"\b(contame|decime|explicame|dame|hablame)\s+(mas|más)",
            r"\b(mas|más)\s+(info|información|detalle|detalles)",
            r"\b(sobre (eso|esto|el|lo anterior|lo mismo))\b",
            r"\b(ampliar?|profundizar?|detallar?)\b",
            r"\b(el expediente|el proyecto|la ley|la resolución)\b",
            r"\b(cada uno|uno por uno|todos|esos|estas|estos|esas)\b",
            r"\b(explica|resume|resumi|detalla|enumera)\b",
            r"\b(anterior|previo|mencionad[oa]s?|citad[oa]s?|listados?)\b",
        ]
        is_followup = any(
            re.search(p, query, re.IGNORECASE) for p in followup_patterns
        )
        if not is_followup:
            return query

        # Try to extract expediente numbers from conversation history directly
        # This is cheaper and more reliable than LLM rewriting for multi-exp queries
        history_exp_numbers = []
        for msg in reversed(conversation_history):
            text = msg.get("text", msg.get("content", ""))
            nums = re.findall(exp_pattern, text)
            for n in nums:
                normalized = re.sub(r"\s+", "", n).upper().replace("–", "-")
                if normalized not in history_exp_numbers:
                    history_exp_numbers.append(normalized)

        # If we found expediente numbers in history and the user is asking
        # about "each one" / "those" etc., inject them directly
        if len(history_exp_numbers) >= 2:
            nums_str = ", ".join(history_exp_numbers)
            rewritten = f"{query} — Expedientes referidos: {nums_str}"
            print(f"[QueryAnalyzer] Direct rewrite with {len(history_exp_numbers)} "
                  f"expedientes from history: '{query}' → '{rewritten}'")
            return rewritten

        # Build compact history for the LLM (use more text for better context)
        recent = conversation_history[-8:]
        history_text = "\n".join(
            f"{m.get('role', 'user').upper()}: {m.get('text', m.get('content', ''))[:600]}"
            for m in recent
        )

        url = f"{Config.OPENROUTER_API_URL}/chat/completions"
        headers = {
            "Authorization": f"Bearer {Config.OPENROUTER_API_KEY}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": Config.OPENROUTER_RERANK_MODEL,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "Eres un reescritor de consultas. El usuario está en un chat sobre "
                        "legislación de Buenos Aires. Su última pregunta hace referencia a algo "
                        "mencionado antes en la conversación.\n"
                        "Tu tarea: reescribir la consulta del usuario para que sea AUTÓNOMA "
                        "(se entienda sin contexto previo). Incluye números de expediente, "
                        "nombres o temas específicos mencionados en el historial.\n"
                        "Responde SOLO con la consulta reescrita, sin explicaciones."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Historial reciente:\n{history_text}\n\n"
                        f"Consulta actual del usuario: {query}\n\n"
                        "Reescribe la consulta para que sea autónoma:"
                    ),
                },
            ],
            "temperature": 0.0,
            "max_tokens": 200,
        }

        try:
            resp = requests.post(url, json=payload, headers=headers, timeout=10)
            resp.raise_for_status()
            rewritten = resp.json()["choices"][0]["message"]["content"].strip()
            # Sanity: non-empty and not absurdly long
            if rewritten and len(rewritten) < 500:
                print(f"[QueryAnalyzer] Rewrite: '{query}' → '{rewritten}'")
                return rewritten
        except Exception as e:
            print(f"[QueryAnalyzer] Rewrite failed, using original: {e}")

        return query

    def analyze(self, query: str) -> Dict:
        """
        Returns:
        {
            "original_query": str,
            "filters": {"tipo": ..., "aiCategory": ..., ...},
            "query_variants": [str, ...],
            "intent": "specific" | "thematic" | "exploratory",
            "clean_query": str,  # query without filter keywords
        }
        """
        result = {
            "original_query": query,
            "filters": {},
            "query_variants": [],
            "intent": "thematic",
            "clean_query": query,
        }

        # 1. Check for explicit expediente numbers
        exp_pattern = r"\b(\d{1,5}\s*[-–]\s*[A-Za-z]{1,4}\s*[-–]\s*\d{4})\b"
        if re.search(exp_pattern, query):
            result["intent"] = "specific"
            return result

        # 2. Extract tipo filter
        query_lower = query.lower()
        for tipo in TIPOS_CONOCIDOS:
            if tipo in query_lower:
                result["filters"]["tipo"] = self._normalize_tipo(tipo)
                break

        # 3. Extract category filter (rule-based)
        for cat in CATEGORIAS_CONOCIDAS:
            if cat in query_lower:
                result["filters"]["aiCategory"] = cat
                break

        # 4. Generate query variants with LLM
        result["query_variants"] = self._generate_variants(query)

        # 5. Determine intent
        if result["filters"]:
            result["intent"] = "thematic"
        else:
            result["intent"] = "exploratory"

        return result

    def _normalize_tipo(self, tipo_text: str) -> str:
        """Map natural language tipo to database values."""
        mapping = {
            "proyecto de ley": "LEY",
            "ley": "LEY",
            "proyecto de resolución": "RESOLUCIÓN",
            "resolución": "RESOLUCIÓN",
            "proyecto de declaración": "DECLARACIÓN",
            "declaración": "DECLARACIÓN",
            "proyecto de comunicación": "COMUNICACIÓN",
            "comunicación": "COMUNICACIÓN",
            "decreto": "DECRETO",
            "ordenanza": "ORDENANZA",
            "pedido de informes": "PEDIDO DE INFORMES",
        }
        return mapping.get(tipo_text.lower(), tipo_text.upper())

    def _generate_variants(self, query: str) -> List[str]:
        """Use LLM to generate 3 query variants for multi-query retrieval."""
        url = f"{Config.OPENROUTER_API_URL}/chat/completions"
        headers = {
            "Authorization": f"Bearer {Config.OPENROUTER_API_KEY}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": Config.OPENROUTER_RERANK_MODEL,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "Genera exactamente 3 variaciones de la consulta del usuario "
                        "para buscar en una base de documentos legislativos de Buenos Aires. "
                        "Cada variación debe capturar un aspecto diferente o usar sinónimos. "
                        'Responde SOLO con JSON: ["variación 1", "variación 2", "variación 3"]'
                    ),
                },
                {"role": "user", "content": query},
            ],
            "temperature": 0.4,
            "max_tokens": 300,
        }

        try:
            resp = requests.post(url, json=payload, headers=headers, timeout=15)
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"].strip()
            json_match = re.search(r"\[.*\]", content, re.DOTALL)
            if json_match:
                variants = json.loads(json_match.group())
                return [v for v in variants if isinstance(v, str)][:3]
        except Exception as e:
            print(f"[QueryAnalyzer] Variant generation failed: {e}")

        return []
