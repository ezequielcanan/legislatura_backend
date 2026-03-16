# RAG Test Pipeline — Legislatura CABA

Pipeline de prueba independiente que replica la arquitectura del blog con tus datos reales de MongoDB, usando **S3 Vectors** como vector store.

## Arquitectura (del blog)

```
┌─────────────────────────────────────────────────────────────────┐
│                    PIPELINE DE INGESTA                          │
│                                                                 │
│  MongoDB ──→ Extraer expedientes ──→ Semantic Chunking          │
│  (existente)   (pdfText, metadata)    (300 tokens, 50 overlap)  │
│                                           │                     │
│                                    Generar embeddings           │
│                                    (text-embedding-3-small)     │
│                                           │                     │
│                              ┌─────────────┴──────────┐        │
│                              ▼                        ▼         │
│                        S3 Vectors               BM25 Index      │
│                      (dense search)          (sparse search)    │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    PIPELINE DE BÚSQUEDA                         │
│                                                                 │
│  Query ──→ Stage 0: Match explícito (regex expediente)          │
│        ──→ Stage 1: HyDE (documento hipotético)                 │
│        ──→ Stage 2: Búsqueda paralela                           │
│              │  Dense (S3 Vectors, query embedding)              │
│              │  Dense (S3 Vectors, HyDE embedding)               │
│              │  Sparse (BM25 keywords)                           │
│        ──→ Stage 3: Reciprocal Rank Fusion (RRF, k=60)          │
│        ──→ Stage 4: LLM Cross-encoder reranking                 │
│        ──→ Stage 5: Deduplicación + best-chunk                  │
│        ──→ Stage 6: Generación con citas [REF-N]                │
└─────────────────────────────────────────────────────────────────┘
```

## Pre-requisitos

### 1. Python 3.10+
```bash
python --version  # Debe ser 3.10 o superior
```

### 2. AWS Account con S3 Vectors habilitado

S3 Vectors es un servicio relativamente nuevo de AWS. Necesitas:

1. **Crear una cuenta AWS** (si no tienes una)
2. **Crear un usuario IAM** con permisos para S3 Vectors:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "s3vectors:CreateVectorBucket",
                "s3vectors:CreateVectorIndex",
                "s3vectors:DeleteVectorIndex",
                "s3vectors:GetVectorIndex",
                "s3vectors:ListVectorBuckets",
                "s3vectors:ListVectorIndexes",
                "s3vectors:PutVectors",
                "s3vectors:QueryVectors",
                "s3vectors:GetVectors",
                "s3vectors:DeleteVectors"
            ],
            "Resource": "*"
        }
    ]
}
```

3. **Generar Access Key + Secret Key** del usuario IAM
4. **Región**: S3 Vectors está disponible en `us-east-1`, `us-east-2`, `us-west-2`. Usa una de estas.

> **Alternativa gratuita para probar**: Si no quieres configurar S3 Vectors todavía, puedes modificar `lib/s3_vectors.py` para usar una implementación local en memoria. Te lo puedo hacer si quieres.

### 3. OpenRouter API Key (ya la tienes)

Tu key existente de OpenRouter funciona para embeddings y LLM.

### 4. Acceso a MongoDB (ya configurado)

La pipeline lee directamente de tu MongoDB existente (solo lectura, no modifica nada).

## Setup

```bash
# 1. Ir al directorio del proyecto
cd rag_test

# 2. Crear entorno virtual
python -m venv venv

# En Windows:
venv\Scripts\activate

# En Mac/Linux:
# source venv/bin/activate

# 3. Instalar dependencias
pip install -r requirements.txt

# 4. Configurar variables de entorno
copy .env.example .env
# Editar .env con tus credenciales reales
```

### Configurar `.env`:

```ini
# MongoDB — copiar de tu backend .env
MONGODB_URI=mongodb+srv://admin:TU_PASSWORD@legislatura.xm7wst4.mongodb.net/
MONGODB_DB=test

# OpenRouter — copiar de tu backend .env
OPENROUTER_API_KEY=sk-or-v1-tu-key-aqui

# AWS — del paso 2
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=tu-secret-key
AWS_REGION=us-east-1
S3_VECTORS_BUCKET=legislatura-rag-vectors
S3_VECTORS_INDEX=expedientes-index

# Opcional: limitar expedientes para la prueba
MAX_EXPEDIENTES=100
```

## Ejecución

### Paso 0: Verificar conexiones
```bash
python 00_test_connections.py
```
Esto verifica: MongoDB, OpenRouter, S3 Vectors, y el chunker.

### Paso 1: Extraer y chunkear expedientes
```bash
python 01_extract_and_chunk.py
```
- Lee expedientes COMPLETED de MongoDB
- Aplica semantic chunking (300 tokens, 50 overlap)
- Genera `data/chunks.json`

### Paso 2: Embeddings + Indexación
```bash
python 02_embed_and_index.py
```
- Genera embeddings via OpenRouter (text-embedding-3-small)
- Indexa vectores en S3 Vectors
- Construye índice BM25 local
- **Tiene checkpoint**: si falla a mitad, re-ejecutar continúa donde quedó

### Paso 3: Chatbot interactivo
```bash
# Modo interactivo (recomendado)
python 03_chatbot.py

# Con streaming
python 03_chatbot.py --stream

# Query única
python 03_chatbot.py --single "¿Qué proyectos de ley tratan sobre educación?"

# Con debug (ver documentos recuperados)
python 03_chatbot.py --debug

# Desactivar componentes para comparar
python 03_chatbot.py --no-hyde     # Sin HyDE expansion
python 03_chatbot.py --no-bm25    # Sin BM25 (solo vector)
python 03_chatbot.py --no-rerank  # Sin reranking LLM
```

### Comandos dentro del chatbot:
- `/clear` — Limpiar historial de conversación
- `/debug` — Toggle modo debug 
- `/quit` — Salir

## Ejemplo de uso

```
$ python 03_chatbot.py --debug

═══ RAG Chatbot — Legislatura CABA ═══

Tú: ¿Que proyectos hay sobre movilidad sustentable?

  Retrieved 10 documents in 1.2s
  ┌───┬────────┬────────┬──────────────────┬──────────┬───────────────────────┐
  │ # │ Score  │ Source │ Expediente       │ Type     │ Preview               │
  ├───┼────────┼────────┼──────────────────┼──────────┼───────────────────────┤
  │ 1 │ 0.8234 │ dense  │ 2922-D-2025      │ SUMMARY  │ [Expediente 2922-D... │
  │ 2 │ 0.7891 │ hyde   │ 1456-D-2025      │ CONTENT  │ ARTÍCULO 1°.- Créa... │
  │ 3 │ 0.6543 │ bm25   │ 892-D-2024       │ CONTENT  │ ...movilidad suste... │
  └───┴────────┴────────┴──────────────────┴──────────┴───────────────────────┘

Asistente:
Existen varios proyectos relacionados con movilidad sustentable:

1. **Expediente 2922-D-2025**: Proyecto de ley que propone crear un programa
   de incentivos para el uso de transporte eléctrico... [REF-1]

2. **Expediente 1456-D-2025**: Establece la obligatoriedad de... [REF-2]

Fuentes:
  REF-1: Expediente 2922-D-2025 (Proyecto de Ley) — score: 0.8234
  REF-2: Expediente 1456-D-2025 (Proyecto de Ley) — score: 0.7891
```

## Estructura de archivos

```
rag_test/
├── .env.example              # Template de configuración
├── .env                      # Tu configuración (no commitear)
├── requirements.txt          # Dependencias Python
├── config.py                 # Carga .env en classes Config
├── 00_test_connections.py    # Verificar todo funciona
├── 01_extract_and_chunk.py   # MongoDB → chunks.json
├── 02_embed_and_index.py     # Embeddings → S3 Vectors + BM25
├── 03_chatbot.py             # Chatbot interactivo
├── lib/
│   ├── __init__.py
│   ├── mongo_client.py       # Conexión MongoDB (solo lectura)
│   ├── chunker.py            # Semantic chunking (blog architecture)
│   ├── embeddings.py         # OpenRouter embedding client
│   ├── s3_vectors.py         # S3 Vectors store
│   ├── hybrid_retriever.py   # BM25 + Vector + HyDE + RRF + Rerank
│   ├── generator.py          # RAG generation con citas
│   └── cache.py              # Semantic cache (Redis, opcional)
└── data/                     # Generado automáticamente
    ├── chunks.json           # Chunks procesados
    ├── bm25_index.pkl        # Índice BM25
    └── bm25_corpus.pkl       # Corpus BM25
```

## Costos estimados

| Componente | Costo aprox. (100 expedientes) |
|---|---|
| OpenRouter embeddings | ~$0.02 |
| OpenRouter LLM (por query) | ~$0.01-0.04 |
| S3 Vectors storage | ~$0.001/mes |
| S3 Vectors queries | ~$0.0001/query |
| **Total pipeline completo** | **< $1** |

## Comparación con tu flujo actual

| Aspecto | Tu backend actual | Este test pipeline |
|---|---|---|
| Vector DB | MongoDB Atlas Vector Search | S3 Vectors |
| Chunking | 1500 chars, 200 overlap | 300 tokens, 50 overlap (blog) |
| Búsqueda | Vector + BM25 + HyDE | Vector + BM25 + HyDE (idéntico) |
| Fusión | RRF (k=60) | RRF (k=60) (idéntico) |
| Reranking | LLM pointwise | LLM pointwise (idéntico) |
| Cache | No | Semantic cache (Redis, opcional) |
| Cross-encoder | LLM-based | LLM-based (blog usa sentence-transformers) |

## Notas

- **No modifica** tu backend ni frontend
- **Solo lectura** contra MongoDB (extrae expedientes, no escribe)
- Los embeddings se guardan en S3 Vectors (separado de tu Atlas Vector Search)
- Redis es opcional (cache semántico)
- El pipeline tiene checkpoint: si falla, re-ejecutar retoma donde quedó
