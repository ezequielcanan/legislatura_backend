// src/rag/rag.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Embedding, EmbeddingDocument, EmbeddingSourceType } from '../embedding/schema/embedding.schema';
import { Expediente, ExpedienteDocument } from '../legislatura/schema/expediente.schema';
import { OpenRouterService } from '../openrouter/openrouter.service';
import { ConfigService } from '@nestjs/config';

// ─── Types ────────────────────────────────────────────────

export interface RetrievedChunk {
  /** The text returned for LLM context (chunkText > snippet > '') */
  text: string;
  /** Atlas vectorSearch score (cosine, 0-1) */
  score: number;
  /** Final score after reranking (may include keyword boost) */
  finalScore: number;
  /** Embedding _id */
  embeddingId: string;
  /** Expediente ObjectId */
  sourceId: string;
  chunkIndex: number;
  totalChunks: number;
  chunkType: string;
  metadata: Record<string, any>;
}

export interface RagResult {
  /** Chunks grouped & deduplicated by expediente, best chunk per expediente */
  chunks: RetrievedChunk[];
  /** Expediente metadata keyed by _id string */
  expedientes: Map<string, ExpedienteMeta>;
  /** Pipeline performance & debugging metrics */
  metrics?: SearchMetrics;
}

export interface SearchMetrics {
  directCount: number;
  vectorCount: number;
  hydeVectorCount: number;
  textSearchCount: number;
  preRerankCount: number;
  postRerankCount: number;
  finalCount: number;
  hydeGenerated: boolean;
  llmRerankUsed: boolean;
  pipelineMs: number;
}

export interface ExpedienteMeta {
  expedienteId: number;
  numero: string;
  titulo: string;
  sumario: string;
  tipo: string;
  aiTags: string[];
  aiCategory: string;
  aiSummary: string;
  fechaIngreso: string;
}

// Legacy interface kept for backward compatibility with chat gateway emissions
export interface ExpedienteChunk {
  content: string;
  expedienteId: number;
  expedienteDbId: string;
  numero: string;
  titulo: string;
  sumario: string;
  tipo: string;
  aiTags: string[];
  aiCategory: string;
  aiSummary: string;
  chunkIndex: number;
  totalChunks: number;
  similarity: number;
}

// ─── Service ──────────────────────────────────────────────

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);

  /** Minimum Atlas vectorSearch score to keep a candidate */
  private readonly minScore: number;
  /** How many candidates Atlas should evaluate (numCandidates) */
  private readonly numCandidates: number;
  /** Raw chunks returned from Atlas before reranking */
  private readonly retrievalLimit: number;
  /** Final chunks after reranking (sent to LLM) */
  private readonly finalLimit: number;
  /** Atlas Vector Search index name */
  private readonly vectorIndexName: string;
  /** Atlas Search (full-text / BM25) index name */
  private readonly textSearchIndexName: string;
  /** Fast LLM model used for HyDE expansion and cross-encoder reranking */
  private readonly rerankModel: string;
  /** Whether to generate a Hypothetical Document Embedding for query expansion */
  private readonly hydeEnabled: boolean;
  /** Whether to run Atlas Full-Text Search (BM25) alongside vector search */
  private readonly textSearchEnabled: boolean;
  /** Whether to use LLM-based cross-encoder reranking instead of keyword boost */
  private readonly llmRerankEnabled: boolean;

  constructor(
    @InjectModel(Embedding.name) private embeddingModel: Model<EmbeddingDocument>,
    @InjectModel(Expediente.name) private expedienteModel: Model<ExpedienteDocument>,
    private openRouterService: OpenRouterService,
    private configService: ConfigService,
  ) {
    this.minScore = Number(this.configService.get('RAG_MIN_SCORE', 0.68));
    this.numCandidates = Number(this.configService.get('RAG_NUM_CANDIDATES', 150));
    this.retrievalLimit = Number(this.configService.get('RAG_RETRIEVAL_LIMIT', 30));
    this.finalLimit = Number(this.configService.get('RAG_FINAL_LIMIT', 20));
    this.vectorIndexName = this.configService.get('ATLAS_VECTOR_INDEX', 'vector_index');
    this.textSearchIndexName = this.configService.get('ATLAS_TEXT_SEARCH_INDEX', 'text_search_index');
    this.rerankModel = this.configService.get('RAG_RERANK_MODEL', 'google/gemini-2.0-flash-lite-001');
    this.hydeEnabled = this.configService.get('RAG_HYDE_ENABLED', 'true') === 'true';
    this.textSearchEnabled = this.configService.get('RAG_TEXT_SEARCH_ENABLED', 'true') === 'true';
    this.llmRerankEnabled = this.configService.get('RAG_LLM_RERANK_ENABLED', 'true') === 'true';
  }

  // ─── Expediente number regex ──────────────────────────────
  // Matches patterns like: 2922-D-2025, 732-J-2026, 100-PE-2024, etc.
  private readonly EXP_NUM_REGEX = /\b(\d{1,5}\s*[-–]\s*[A-Za-z]{1,4}\s*[-–]\s*\d{4})\b/g;

  // ─── Main entry point ────────────────────────────────────

  /**
   * Enterprise-grade hybrid RAG pipeline (2026):
   *
   * 0. Extract explicit expediente numbers → deterministic DB lookup
   * 1. HyDE (Hypothetical Document Embedding) — query expansion via fast LLM
   * 2. Multi-signal parallel retrieval:
   *    a) Atlas $vectorSearch with original query embedding
   *    b) Atlas $vectorSearch with HyDE-generated embedding
   *    c) Atlas $search (BM25 full-text) for exact keyword matching
   * 3. Reciprocal Rank Fusion (RRF) — merge all retrieval signals
   * 4. LLM Cross-Encoder Reranking — pointwise relevance scoring
   * 5. Merge direct matches (always included) + reranked results
   * 6. Deduplication & best-chunk selection per expediente
   * 7. Agentic fallback — if zero results, rewrite query and retry
   * 8. Fetch lean expediente metadata for final set
   */
  async search(
    queryText: string,
    queryVector: number[],
  ): Promise<RagResult> {
    if (!queryText?.trim()) {
      return { chunks: [], expedientes: new Map() };
    }

    const startMs = Date.now();
    const metrics: SearchMetrics = {
      directCount: 0, vectorCount: 0, hydeVectorCount: 0,
      textSearchCount: 0, preRerankCount: 0, postRerankCount: 0,
      finalCount: 0, hydeGenerated: false, llmRerankUsed: false,
      pipelineMs: 0,
    };

    try {
      // ── Stage 0: Detect explicit expediente references ──────────
      const mentionedNumbers = this.extractExpedienteNumbers(queryText);

      // ── Stage 1: HyDE query expansion (parallel with direct lookup) ──
      const [directChunks, hydeVector] = await Promise.all([
        mentionedNumbers.length > 0
          ? this.directExpedienteLookup(mentionedNumbers)
          : Promise.resolve([]),
        this.hydeEnabled
          ? this.hydeExpand(queryText).catch((e) => {
              this.logger.warn(`HyDE expansion failed, skipping: ${e.message}`);
              return null;
            })
          : Promise.resolve(null),
      ]);

      metrics.directCount = directChunks.length;
      metrics.hydeGenerated = hydeVector !== null;

      if (directChunks.length > 0) {
        this.logger.debug(
          `Direct lookup found ${directChunks.length} chunks for: ${mentionedNumbers.join(', ')}`,
        );
      }

      // ── Stage 2: Parallel multi-signal retrieval ────────────────
      const searchPromises: Promise<RetrievedChunk[]>[] = [
        this.atlasVectorSearch(queryVector),
      ];

      if (hydeVector) {
        searchPromises.push(this.atlasVectorSearch(hydeVector));
      }

      if (this.textSearchEnabled) {
        searchPromises.push(
          this.atlasTextSearch(queryText).catch((e) => {
            this.logger.warn(`Atlas Text Search unavailable: ${e.message}`);
            return [];
          }),
        );
      }

      const searchResults = await Promise.all(searchPromises);

      const vectorChunks = searchResults[0];
      const hydeChunks = hydeVector ? searchResults[1] : [];
      const textChunks = this.textSearchEnabled
        ? searchResults[hydeVector ? 2 : 1] || []
        : [];

      metrics.vectorCount = vectorChunks.length;
      metrics.hydeVectorCount = hydeChunks.length;
      metrics.textSearchCount = textChunks.length;

      // ── Stage 3: Reciprocal Rank Fusion across all signals ──────
      const directSourceIds = new Set(directChunks.map((c) => c.sourceId));
      const resultSets = [vectorChunks, hydeChunks, textChunks].filter(
        (s) => s.length > 0,
      );

      const fused =
        resultSets.length > 1
          ? this.reciprocalRankFusion(resultSets)
          : (resultSets[0] || []).map((c) => ({ ...c, finalScore: c.score }));

      // Remove chunks already covered by direct lookup
      const filteredFused = fused.filter((c) => !directSourceIds.has(c.sourceId));
      metrics.preRerankCount = filteredFused.length;

      // ── Stage 4: LLM Cross-Encoder Reranking ───────────────────
      let reranked: RetrievedChunk[];
      if (this.llmRerankEnabled && filteredFused.length > 3) {
        try {
          reranked = await this.llmRerank(queryText, filteredFused);
          metrics.llmRerankUsed = true;
        } catch (e) {
          this.logger.warn(`LLM reranking failed, keyword fallback: ${e.message}`);
          const queryTokens = this.tokenize(queryText);
          reranked = this.rerankWithKeywords(filteredFused, queryTokens);
        }
      } else {
        const queryTokens = this.tokenize(queryText);
        reranked = this.rerankWithKeywords(filteredFused, queryTokens);
      }

      metrics.postRerankCount = reranked.length;

      // ── Stage 5: Combine direct matches + reranked results ──────
      const combined = [...directChunks, ...reranked];

      // ── Stage 6: Deduplicate by expediente ──────────────────────
      const bestPerExp = this.deduplicateByExpediente(combined);

      // ── Stage 7: Final top-N ────────────────────────────────────
      const directCount = directChunks.length > 0
        ? new Set(directChunks.map((c) => c.sourceId)).size
        : 0;
      const limit = Math.max(this.finalLimit, directCount);
      let finalChunks = bestPerExp.slice(0, limit);

      // ── Stage 8: Agentic fallback — rewrite query if no results ─
      if (finalChunks.length === 0) {
        this.logger.debug('No results found, attempting agentic query rewrite...');
        try {
          const rewritten = await this.rewriteQuery(queryText);
          const rewrittenVector = await this.openRouterService.generateEmbedding(rewritten);
          const retryResults = await this.atlasVectorSearch(rewrittenVector);
          if (retryResults.length > 0) {
            const retryDeduped = this.deduplicateByExpediente(retryResults);
            finalChunks = retryDeduped.slice(0, this.finalLimit);
            this.logger.debug(`Agentic retry found ${finalChunks.length} results with: "${rewritten.slice(0, 80)}"`);
          }
        } catch (e) {
          this.logger.warn(`Agentic retry failed: ${e.message}`);
        }
      }

      // ── Stage 9: Fetch expediente metadata ──────────────────────
      const sourceIds = [...new Set(finalChunks.map((c) => c.sourceId))];
      const expedientes = await this.fetchExpedienteMeta(sourceIds);

      metrics.finalCount = finalChunks.length;
      metrics.pipelineMs = Date.now() - startMs;

      this.logger.debug(
        `RAG pipeline [${metrics.pipelineMs}ms]: ` +
        `${metrics.directCount} direct + ${metrics.vectorCount} vector + ` +
        `${metrics.hydeVectorCount} hyde + ${metrics.textSearchCount} bm25 → ` +
        `${metrics.preRerankCount} fused → ${metrics.postRerankCount} reranked → ` +
        `${metrics.finalCount} final ` +
        `(HyDE:${metrics.hydeGenerated} LLM-rerank:${metrics.llmRerankUsed})`,
      );

      return { chunks: finalChunks, expedientes, metrics };
    } catch (error) {
      this.logger.error('RAG search error:', error);
      return { chunks: [], expedientes: new Map() };
    }
  }

  // ─── Explicit Expediente Extraction ─────────────────────

  /**
   * Extract expediente number references from the user query.
   * Normalizes whitespace around dashes: "2922 - D - 2025" → "2922-D-2025"
   */
  private extractExpedienteNumbers(text: string): string[] {
    const matches = text.match(this.EXP_NUM_REGEX);
    if (!matches) return [];

    return [...new Set(
      matches.map((m) =>
        m.replace(/\s*[-–]\s*/g, '-').toUpperCase(),
      ),
    )];
  }

  /**
   * Deterministic lookup: find expedientes by their numero field,
   * then fetch ALL their embedding chunks so the LLM has full context.
   * Returns chunks with score = 1.0 (perfect match).
   */
  private async directExpedienteLookup(numeros: string[]): Promise<RetrievedChunk[]> {
    // Build case-insensitive regex patterns for each numero
    const regexPatterns = numeros.map((n) => new RegExp(`^${n.replace(/-/g, '\\s*-\\s*')}$`, 'i'));

    const expedientes = await this.expedienteModel
      .find({ numero: { $in: regexPatterns } }, { _id: 1 })
      .lean()
      .exec();

    if (expedientes.length === 0) return [];

    const expIds = expedientes.map((e) => e._id);

    // Fetch all embedding chunks for these expedientes
    const embeddings = await this.embeddingModel
      .find(
        {
          sourceId: { $in: expIds },
          sourceType: EmbeddingSourceType.DOCUMENT,
          deleted: { $ne: true },
        },
        {
          _id: 1,
          sourceId: 1,
          chunkText: 1,
          chunkType: 1,
          snippet: 1,
          metadata: 1,
        },
      )
      .lean()
      .exec();

    return embeddings.map((e: any) => ({
      text: e.chunkText || e.snippet || '',
      score: 1.0,
      finalScore: 1.0,
      embeddingId: e._id.toString(),
      sourceId: e.sourceId.toString(),
      chunkIndex: e.metadata?.chunkIndex ?? 0,
      totalChunks: e.metadata?.totalChunks ?? 1,
      chunkType: e.chunkType || e.metadata?.chunkType || 'content',
      metadata: e.metadata || {},
    }));
  }

  // ─── Legacy wrapper ──────────────────────────────────────

  /**
   * Backward-compatible wrapper that returns ExpedienteChunk[] for existing callers.
   */
  async searchRelevantDocuments(
    queryText: string,
    queryVector: number[],
    limit?: number,
    _filters?: any,
  ): Promise<ExpedienteChunk[]> {
    const result = await this.search(queryText, queryVector);
    return this.toExpedienteChunks(result);
  }

  // ─── Atlas Vector Search ────────────────────────────────

  private async atlasVectorSearch(queryVector: number[]): Promise<RetrievedChunk[]> {
    const pipeline: any[] = [
      {
        $vectorSearch: {
          index: this.vectorIndexName,
          path: 'vector',
          queryVector,
          numCandidates: this.numCandidates,
          limit: this.retrievalLimit,
          filter: {
            sourceType: EmbeddingSourceType.DOCUMENT,
            deleted: { $ne: true },
          },
        },
      },
      {
        $project: {
          _id: 1,
          sourceId: 1,
          chunkText: 1,
          chunkType: 1,
          snippet: 1,
          metadata: 1,
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ];

    const results = await this.embeddingModel.aggregate(pipeline).exec();

    return results
      .filter((r) => r.score >= this.minScore)
      .map((r) => ({
        text: r.chunkText || r.snippet || '',
        score: r.score,
        finalScore: r.score,
        embeddingId: r._id.toString(),
        sourceId: r.sourceId.toString(),
        chunkIndex: r.metadata?.chunkIndex ?? 0,
        totalChunks: r.metadata?.totalChunks ?? 1,
        chunkType: r.chunkType || r.metadata?.chunkType || 'content',
        metadata: r.metadata || {},
      }));
  }

  // ─── HyDE: Hypothetical Document Embedding ──────────────

  /**
   * Generate a hypothetical legislative document that would answer the query,
   * then embed it. The HyDE vector captures the "ideal answer" semantics,
   * dramatically improving recall for vague or colloquial queries.
   */
  private async hydeExpand(queryText: string): Promise<number[] | null> {
    const messages = [
      {
        role: 'system' as const,
        content:
          'Eres un generador de documentos legislativos hipotéticos de la Legislatura de Buenos Aires. ' +
          'Dado una consulta, genera un fragmento breve (3-4 oraciones) de un expediente legislativo ' +
          'que respondería perfectamente a esa consulta. No inventes números de expediente específicos. ' +
          'Usa vocabulario legislativo argentino formal. Responde SOLO con el fragmento, sin explicaciones.',
      },
      { role: 'user' as const, content: queryText },
    ];

    const response = await this.openRouterService.createChatCompletion(messages, {
      model: this.rerankModel,
      temperature: 0.3,
      max_tokens: 200,
    });

    const hydeDoc = response.choices?.[0]?.message?.content?.trim();
    if (!hydeDoc) return null;

    this.logger.debug(`HyDE generated: ${hydeDoc.slice(0, 120)}...`);
    return this.openRouterService.generateEmbedding(hydeDoc);
  }

  // ─── Atlas Full-Text Search (BM25) ──────────────────────

  /**
   * BM25 keyword search via MongoDB Atlas Search.
   * Catches exact terms, codes, and expressions that vector search may miss.
   * Requires an Atlas Search index (see ATLAS_TEXT_SEARCH_SETUP.md).
   * Gracefully returns [] if the index does not exist.
   */
  private async atlasTextSearch(queryText: string): Promise<RetrievedChunk[]> {
    const pipeline: any[] = [
      {
        $search: {
          index: this.textSearchIndexName,
          compound: {
            must: [
              {
                text: {
                  query: queryText,
                  path: 'chunkText',
                  fuzzy: { maxEdits: 1, prefixLength: 2 },
                },
              },
            ],
            filter: [
              { equals: { path: 'sourceType', value: EmbeddingSourceType.DOCUMENT } },
            ],
          },
        },
      },
      { $match: { deleted: { $ne: true } } },
      { $limit: this.retrievalLimit },
      {
        $project: {
          _id: 1,
          sourceId: 1,
          chunkText: 1,
          chunkType: 1,
          snippet: 1,
          metadata: 1,
          score: { $meta: 'searchScore' },
        },
      },
    ];

    const results = await this.embeddingModel.aggregate(pipeline).exec();

    // Normalize BM25 scores to 0-1 for RRF compatibility
    const maxScore = results.length > 0
      ? Math.max(...results.map((r) => r.score))
      : 1;

    return results.map((r) => ({
      text: r.chunkText || r.snippet || '',
      score: maxScore > 0 ? r.score / maxScore : 0,
      finalScore: maxScore > 0 ? r.score / maxScore : 0,
      embeddingId: r._id.toString(),
      sourceId: r.sourceId.toString(),
      chunkIndex: r.metadata?.chunkIndex ?? 0,
      totalChunks: r.metadata?.totalChunks ?? 1,
      chunkType: r.chunkType || r.metadata?.chunkType || 'content',
      metadata: r.metadata || {},
    }));
  }

  // ─── Reciprocal Rank Fusion ─────────────────────────────

  /**
   * Merge multiple ranked result lists using Reciprocal Rank Fusion.
   * RRF score = Σ 1/(k + rank) across all lists where the chunk appears.
   * This is the standard technique for combining heterogeneous retrieval
   * signals (semantic, keyword, HyDE) without score normalization issues.
   */
  private reciprocalRankFusion(
    resultSets: RetrievedChunk[][],
    k: number = 60,
  ): RetrievedChunk[] {
    const fusedScores = new Map<string, { chunk: RetrievedChunk; score: number }>();

    for (const results of resultSets) {
      for (let rank = 0; rank < results.length; rank++) {
        const chunk = results[rank];
        const key = chunk.embeddingId;
        const rrfScore = 1 / (k + rank + 1);

        const existing = fusedScores.get(key);
        if (existing) {
          existing.score += rrfScore;
          if (chunk.score > existing.chunk.score) {
            existing.chunk = chunk;
          }
        } else {
          fusedScores.set(key, { chunk: { ...chunk }, score: rrfScore });
        }
      }
    }

    return [...fusedScores.values()]
      .sort((a, b) => b.score - a.score)
      .map(({ chunk, score }) => ({ ...chunk, finalScore: score }));
  }

  // ─── LLM Cross-Encoder Reranking ───────────────────────

  /**
   * Uses a fast LLM as a cross-encoder to score query↔chunk relevance.
   * Single API call with all candidates → much more accurate than keyword overlap.
   * Blends LLM relevance score (70%) with original RRF score (30%) for stability.
   */
  private async llmRerank(
    queryText: string,
    chunks: RetrievedChunk[],
  ): Promise<RetrievedChunk[]> {
    const candidates = chunks.slice(0, 20);

    const candidateList = candidates
      .map((c, i) => `[${i}] ${c.text.slice(0, 300)}`)
      .join('\n\n');

    const messages = [
      {
        role: 'system' as const,
        content:
          'Eres un sistema de evaluación de relevancia para búsqueda legislativa. ' +
          'Evalúa qué tan relevante es cada fragmento para responder la consulta del usuario. ' +
          'Responde SOLO con un JSON array: [{"i":0,"s":8},{"i":1,"s":3},...] ' +
          'donde "i" = índice del fragmento, "s" = score de relevancia (0-10). ' +
          'Incluye TODOS los fragmentos.',
      },
      {
        role: 'user' as const,
        content: `Consulta: "${queryText}"\n\nFragmentos:\n${candidateList}`,
      },
    ];

    const response = await this.openRouterService.createChatCompletion(messages, {
      model: this.rerankModel,
      temperature: 0,
      max_tokens: 800,
    });

    const content = response.choices?.[0]?.message?.content?.trim() || '[]';

    // Extract JSON array (handle markdown code blocks)
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      this.logger.warn('LLM reranker returned invalid format, falling back to keyword reranking');
      return chunks;
    }

    const scores: Array<{ i: number; s: number }> = JSON.parse(jsonMatch[0]);

    // Blend LLM relevance (70%) with original RRF score (30%)
    const reranked = scores
      .filter((s) => s.i >= 0 && s.i < candidates.length && s.s > 0)
      .map((s) => ({
        ...candidates[s.i],
        finalScore: (s.s / 10) * 0.7 + candidates[s.i].finalScore * 0.3,
      }))
      .sort((a, b) => b.finalScore - a.finalScore);

    this.logger.debug(`LLM reranker scored ${reranked.length} chunks`);
    return reranked;
  }

  // ─── Agentic Query Rewriting ────────────────────────────

  /**
   * When the main pipeline returns zero results, rewrite the query
   * with broader terms and synonyms as a single retry attempt.
   */
  private async rewriteQuery(queryText: string): Promise<string> {
    const messages = [
      {
        role: 'system' as const,
        content:
          'Eres un asistente que reformula consultas para búsqueda en una base de datos ' +
          'legislativa de la Ciudad de Buenos Aires. Dado una consulta que no obtuvo resultados, ' +
          'genera una versión más amplia con sinónimos y términos legislativos relacionados. ' +
          'Responde SOLO con la consulta reformulada, sin explicaciones.',
      },
      {
        role: 'user' as const,
        content: `Consulta original sin resultados: "${queryText}"`,
      },
    ];

    const response = await this.openRouterService.createChatCompletion(messages, {
      model: this.rerankModel,
      temperature: 0.5,
      max_tokens: 150,
    });

    return response.choices?.[0]?.message?.content?.trim() || queryText;
  }

  // ─── Keyword Reranking ──────────────────────────────────

  /**
   * Boost chunks that contain exact query keywords.
   * Uses Reciprocal Rank Fusion-style blending:
   *   finalScore = vectorScore + keywordBoost * 0.15
   */
  private rerankWithKeywords(
    chunks: RetrievedChunk[],
    queryTokens: string[],
  ): RetrievedChunk[] {
    if (queryTokens.length === 0) return chunks;

    return chunks
      .map((chunk) => {
        const textLower = chunk.text.toLowerCase();
        const metaText = [
          chunk.metadata?.numero,
          chunk.metadata?.tipo,
          chunk.metadata?.aiCategory,
          ...(chunk.metadata?.aiTags || []),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();

        const combined = `${textLower} ${metaText}`;
        let matchCount = 0;
        for (const token of queryTokens) {
          if (combined.includes(token)) matchCount++;
        }

        const keywordBoost = queryTokens.length > 0 ? matchCount / queryTokens.length : 0;
        return {
          ...chunk,
          finalScore: chunk.score + keywordBoost * 0.15,
        };
      })
      .sort((a, b) => b.finalScore - a.finalScore);
  }

  // ─── Deduplication ──────────────────────────────────────

  /**
   * For direct-match expedientes (score === 1.0), keep ALL chunks (summary first, then by chunkIndex).
   * For vector-search expedientes, keep only the highest-scoring chunk.
   * Summary chunks get a small boost because they are highly dense in information.
   */
  private deduplicateByExpediente(chunks: RetrievedChunk[]): RetrievedChunk[] {
    // Separate direct matches from vector matches
    const directChunks: RetrievedChunk[] = [];
    const vectorChunks: RetrievedChunk[] = [];

    for (const chunk of chunks) {
      if (chunk.score >= 1.0) {
        directChunks.push(chunk);
      } else {
        vectorChunks.push(chunk);
      }
    }

    // For direct matches: keep ALL chunks, sorted summary-first then by chunkIndex
    const sortedDirect = directChunks.sort((a, b) => {
      // Same expediente? summary first, then by chunkIndex
      if (a.sourceId === b.sourceId) {
        if (a.chunkType === 'summary' && b.chunkType !== 'summary') return -1;
        if (b.chunkType === 'summary' && a.chunkType !== 'summary') return 1;
        return a.chunkIndex - b.chunkIndex;
      }
      return 0;
    });

    // For vector matches: best chunk per expediente
    const bestVectorMap = new Map<string, RetrievedChunk>();
    for (const chunk of vectorChunks) {
      const key = chunk.sourceId;
      // Skip if already covered by direct match
      if (directChunks.some((d) => d.sourceId === key)) continue;

      const effective = chunk.chunkType === 'summary'
        ? chunk.finalScore + 0.03
        : chunk.finalScore;

      const existing = bestVectorMap.get(key);
      if (!existing || effective > (existing.chunkType === 'summary' ? existing.finalScore + 0.03 : existing.finalScore)) {
        bestVectorMap.set(key, chunk);
      }
    }

    const bestVector = [...bestVectorMap.values()].sort((a, b) => b.finalScore - a.finalScore);

    return [...sortedDirect, ...bestVector];
  }

  // ─── Expediente Metadata ────────────────────────────────

  private async fetchExpedienteMeta(sourceIds: string[]): Promise<Map<string, ExpedienteMeta>> {
    const docs = await this.expedienteModel
      .find(
        { _id: { $in: sourceIds } },
        {
          expedienteId: 1,
          numero: 1,
          titulo: 1,
          sumario: 1,
          tipo: 1,
          aiTags: 1,
          aiCategory: 1,
          aiSummary: 1,
          fechaIngreso: 1,
        },
      )
      .lean()
      .exec();

    const map = new Map<string, ExpedienteMeta>();
    for (const d of docs) {
      map.set(d._id.toString(), {
        expedienteId: d.expedienteId,
        numero: d.numero,
        titulo: d.titulo,
        sumario: d.sumario,
        tipo: d.tipo,
        aiTags: d.aiTags || [],
        aiCategory: d.aiCategory || '',
        aiSummary: d.aiSummary || '',
        fechaIngreso: d.fechaIngreso || '',
      });
    }
    return map;
  }

  // ─── Context Formatting ──────────────────────────────────

  /**
   * Build a compact, token-efficient context string for the LLM.
   * Each expediente gets a citation ID [REF-N] for traceable responses.
   * Direct-match expedientes get ALL their chunks concatenated.
   * Vector-match expedientes get summary + best chunk.
   */
  formatContextForLLM(result: RagResult): string {
    if (result.chunks.length === 0) {
      return 'No se encontraron expedientes relevantes en la base de datos.';
    }

    // Group chunks by expediente
    const groupedByExp = new Map<string, RetrievedChunk[]>();
    for (const chunk of result.chunks) {
      const list = groupedByExp.get(chunk.sourceId) || [];
      list.push(chunk);
      groupedByExp.set(chunk.sourceId, list);
    }

    const sections: string[] = [];
    let refCounter = 1;

    for (const [sourceId, chunks] of groupedByExp) {
      const meta = result.expedientes.get(sourceId);
      if (!meta) continue;

      const isDirect = chunks.some((c) => c.score >= 1.0);
      const refId = `REF-${refCounter++}`;

      const header = [
        `[${refId}] [Expediente ${meta.numero}]`,
        `Tipo: ${meta.tipo}`,
        meta.aiCategory ? `Categoría: ${meta.aiCategory}` : null,
        meta.aiTags.length ? `Tags: ${meta.aiTags.join(', ')}` : null,
        `Fecha: ${meta.fechaIngreso}`,
        isDirect ? '(COINCIDENCIA EXACTA)' : null,
      ]
        .filter(Boolean)
        .join(' | ');

      let body: string;
      if (isDirect) {
        // Direct match: include summary + ALL content chunks in order
        const summaryChunk = chunks.find((c) => c.chunkType === 'summary');
        const contentChunks = chunks
          .filter((c) => c.chunkType !== 'summary')
          .sort((a, b) => a.chunkIndex - b.chunkIndex);

        const parts: string[] = [];
        if (meta.aiSummary) parts.push(`Resumen: ${meta.aiSummary}`);
        else if (summaryChunk) parts.push(`Resumen: ${summaryChunk.text}`);
        if (meta.sumario) parts.push(`Sumario oficial: ${meta.sumario}`);

        if (contentChunks.length > 0) {
          parts.push(`\nContenido completo del documento (${contentChunks.length} secciones):`);
          for (const c of contentChunks) {
            parts.push(c.text);
          }
        }

        body = parts.join('\n');
      } else {
        // Vector match: just summary + best chunk
        body = chunks[0].chunkType === 'summary'
          ? chunks[0].text
          : `Resumen: ${meta.aiSummary || meta.sumario}\n\nFragmento relevante:\n${chunks[0].text}`;
      }

      sections.push(`${header}\n${body}`);
    }

    return `EXPEDIENTES LEGISLATIVOS RELEVANTES (${groupedByExp.size} resultados):\n\n${sections.join('\n\n---\n\n')}`;
  }

  /**
   * Legacy format method — delegates to new pipeline
   */
  formatDocumentsForContext(chunks: ExpedienteChunk[]): string {
    if (chunks.length === 0) {
      return 'No se encontraron expedientes relevantes en la base de datos.';
    }

    const formatted = chunks.map((chunk) =>
      `[Expediente ${chunk.numero}] Tipo: ${chunk.tipo} | Categoría: ${chunk.aiCategory} | Tags: ${chunk.aiTags.join(', ')}
Resumen: ${chunk.aiSummary || chunk.sumario}
Fragmento: ${chunk.content}`,
    );

    return `EXPEDIENTES LEGISLATIVOS RELEVANTES (${chunks.length} resultados):\n\n${formatted.join('\n\n---\n\n')}`;
  }

  // ─── Converters ──────────────────────────────────────────

  private toExpedienteChunks(result: RagResult): ExpedienteChunk[] {
    return result.chunks.map((c) => {
      const meta = result.expedientes.get(c.sourceId);
      return {
        content: c.text,
        expedienteId: meta?.expedienteId ?? 0,
        expedienteDbId: c.sourceId,
        numero: meta?.numero ?? '',
        titulo: meta?.titulo ?? '',
        sumario: meta?.sumario ?? '',
        tipo: meta?.tipo ?? '',
        aiTags: meta?.aiTags ?? [],
        aiCategory: meta?.aiCategory ?? '',
        aiSummary: meta?.aiSummary ?? '',
        chunkIndex: c.chunkIndex,
        totalChunks: c.totalChunks,
        similarity: c.score,
      };
    });
  }

  // ─── Utilities ──────────────────────────────────────────

  /** Tokenize query into lowercase keywords, removing stopwords */
  private tokenize(text: string): string[] {
    const stopwords = new Set([
      'el', 'la', 'los', 'las', 'de', 'del', 'en', 'un', 'una', 'y', 'o',
      'que', 'es', 'se', 'con', 'por', 'para', 'al', 'lo', 'le', 'su',
      'no', 'a', 'como', 'más', 'pero', 'sus', 'ya', 'fue', 'ha', 'son',
      'me', 'si', 'sobre', 'este', 'entre', 'cuando', 'muy', 'sin',
      'ser', 'hay', 'tiene', 'también', 'otros', 'otro', 'era', 'puede',
      'todo', 'esta', 'cual', 'cuáles', 'qué', 'cómo', 'dónde', 'cuándo',
      'the', 'and', 'or', 'is', 'of', 'in', 'to', 'for', 'on', 'with',
    ]);

    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopwords.has(w));
  }

  // ─── Stats ──────────────────────────────────────────────

  async getStats(): Promise<{
    totalExpedientes: number;
    processedExpedientes: number;
    totalEmbeddings: number;
    averageEmbeddingsPerExp: number;
  }> {
    const [totalExps, processedExps, totalEmbs] = await Promise.all([
      this.expedienteModel.countDocuments(),
      this.expedienteModel.countDocuments({ status: 'completed' }),
      this.embeddingModel.countDocuments({ sourceType: EmbeddingSourceType.DOCUMENT }),
    ]);

    return {
      totalExpedientes: totalExps,
      processedExpedientes: processedExps,
      totalEmbeddings: totalEmbs,
      averageEmbeddingsPerExp: processedExps > 0 ? totalEmbs / processedExps : 0,
    };
  }
}