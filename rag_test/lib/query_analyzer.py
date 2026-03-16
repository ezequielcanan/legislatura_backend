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
