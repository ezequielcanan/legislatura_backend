// src/memory/memory.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Memory, MemoryDocument, MemoryType } from './schema/memory.schema';
import { Embedding, EmbeddingDocument, EmbeddingSourceType, VectorProvider } from '../embedding/schema/embedding.schema';
import { OpenRouterService } from '../openrouter/openrouter.service';
import { ConfigService } from '@nestjs/config';
import { MemoryProducer } from './memory.producer';
import { Job } from 'bullmq';

@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);
  private readonly embeddingModelName: string;
  private readonly similarityThreshold: number;
  private readonly maxCandidatesToFetch = 200; // para comparación local

  constructor(
    @InjectModel(Memory.name) private memoryModel: Model<MemoryDocument>,
    @InjectModel(Embedding.name) private embeddingModel: Model<EmbeddingDocument>,
    private openRouterService: OpenRouterService,
    private configService: ConfigService,
    private readonly memoryProducer: MemoryProducer,
  ) {
    this.embeddingModelName = this.configService.get<string>('EMBEDDING_MODEL', 'text-embedding-3-small');
    this.similarityThreshold = Number(this.configService.get<number>('MEMORY_SIMILARITY_THRESHOLD', 0.82));
  }


  async saveMemory(userId: Types.ObjectId, message: any): Promise<Job> {
    const job = await this.memoryProducer.enqueueGenerate(userId, message);
    return job
  }
  /**
   * Evalúa un mensaje y crea/actualiza memorias si corresponde.
   * - userId: owner
   * - message: { _id, conversationId, text, role, createdAt, metadata }
   */
  async evaluateAndSaveMemory(userId: Types.ObjectId, message: any): Promise<void> {
    try {
      if (!message || message.role !== 'user') return;

      // 1) Pedimos al LLM que extraiga candidatos de memoria en JSON
      const promptSystem = `Eres un extractor que recibe un único mensaje de usuario y devuelve (sólo JSON) una lista de 0..N "memorias" extraídas. Cada memoria debe tener: 
- title: resumen corto (<= 60 chars)
- content: texto completo que contiene el hecho
- type: uno de [fact, preference, event, todo, ephemeral]
- salience: número entre 0 y 1 (qué tan importante)
- tags: array de strings
- expiresAt: ISO date o null
- canonical: versión canónica breve para dedupe (o null)
Devuelve estrictamente un JSON array.`;

      const promptUser = `Mensaje: """${message.text.replace(/\"\"\"/g, '')}""" 
Analiza y responde con JSON.`;

      const res = await this.openRouterService.createChatCompletion(
        [
          { role: 'system', content: promptSystem },
          { role: 'user', content: promptUser },
        ],
        { model: this.configService.get('OPENROUTER_DEFAULT_MODEL') || undefined, temperature: 0.0, max_tokens: 512 },
      );

      const raw = res?.choices?.[0]?.message?.content ?? '';
      const json = this._safeExtractJSON(raw);
      if (!json || !Array.isArray(json) || json.length === 0) {
        this.logger.debug('No memory candidates extracted or parse failed.', raw);
        return;
      }

      // 2) Para cada candidato: canonicalizar, generar embedding, buscar duplicados y merge o crear
      for (const candidate of json) {
        try {
          // validaciones básicas
          if (!candidate.content || typeof candidate.content !== 'string') continue;
          candidate.title = (candidate.title || this._truncate(candidate.content, 60)).trim();
          candidate.type = candidate.type || MemoryType.FACT;
          candidate.salience = Number(candidate.salience ?? 0.5);
          candidate.tags = Array.isArray(candidate.tags) ? candidate.tags : [];

          const canonical = candidate.canonical || this._canonicalize(candidate.content);
          const contentToEmbed = canonical || candidate.content;

          // embedding del contenido
          const vector = await this.openRouterService.generateEmbedding(contentToEmbed, this.embeddingModelName);

          // buscar embeddings existentes del mismo user (provider MONGO) para detectar duplicados
          const nearby = await this._findNearbyEmbeddingsForUser(userId, vector, this.maxCandidatesToFetch);

          // calcular mejor candidato y decidir merge/create
          let bestMatch: { emb: EmbeddingDocument; score: number } | null = null;
          for (const emb of nearby) {
            const score = this._cosineSimilarity(vector, emb.vector as number[]);
            if (!bestMatch || score > bestMatch.score) bestMatch = { emb, score };
          }

          if (bestMatch && bestMatch.score >= this.similarityThreshold) {
            // merge heuristic: actualizar memory content/salience/lastReferencedAt
            const memoryId = bestMatch.emb.sourceId;
            await this.memoryModel.findByIdAndUpdate(
              memoryId,
              {
                $set: {
                  // preserve existing content but keep a combined summary in metadata
                  lastReferencedAt: new Date(),
                },
                $inc: { recallCount: 1 },
                $max: { salience: candidate.salience },
                $addToSet: { tags: { $each: candidate.tags } },
              },
              { new: true },
            ).exec();

            // Opción: actualizar embedding (merge) -> aquí actualizamos lastIndexedAt
            await this.embeddingModel.findByIdAndUpdate(bestMatch.emb._id, {
              $set: { lastIndexedAt: new Date(), model: this.embeddingModelName },
            }).exec();

            this.logger.debug(`Merged memory candidate into existing memory ${bestMatch.emb.sourceId} (score=${bestMatch.score})`);
          } else {
            // crear nueva memory
            const memory = new this.memoryModel({
              userId: new Types.ObjectId(userId),
              conversationId: message.conversationId ? new Types.ObjectId(message.conversationId) : null,
              sourceMessageId: message._id ? new Types.ObjectId(message._id) : null,
              type: candidate.type,
              status: 'active',
              content: candidate.content,
              title: candidate.title,
              canonical: canonical,
              salience: candidate.salience ?? 0.5,
              recallCount: 0,
              lastReferencedAt: new Date(),
              pinned: false,
              visibleToUserOnly: true,
              tags: candidate.tags || [],
              metadata: { extractedBy: 'llm' },
              expiresAt: candidate.expiresAt ? new Date(candidate.expiresAt) : null,
            });

            const saved = await memory.save();

            // guardar embedding referenciando memory
            const embDoc = new this.embeddingModel({
              sourceType: EmbeddingSourceType.MEMORY,
              sourceId: saved._id,
              vector,
              provider: VectorProvider.MONGO,
              model: this.embeddingModelName,
              dims: vector.length,
              snippet: this._truncate(candidate.content, 200),
              metadata: { userId: userId.toString(), conversationId: message.conversationId?.toString() ?? null },
              lastIndexedAt: new Date(),
            });

            await embDoc.save();
            this.logger.debug(`Created new memory ${saved._id.toString()}`);
          }
        } catch (err) {
          this.logger.warn('Failed to process candidate memory:', err);
        }
      }
    } catch (err) {
      this.logger.error('evaluateAndSaveMemory failed:', err);
    }
  }

  /**
   * Recupera memorias relevantes dado un texto de consulta (ej. mensaje actual).
   * Combina similitud vectorial + salience + recency.
   */
  async getRelevantMemories(userId: Types.ObjectId, queryText: string, qVec: number[], limit: number = 5): Promise<MemoryDocument[]> {
    if (!queryText || queryText.trim().length === 0) return [];

    // 1) embedding de la query

    // 2) buscar embeddings cercanos del user
    const nearby = await this._findNearbyEmbeddingsForUser(userId, qVec, Math.max(limit * 10, 50));

    // 3) puntuar y obtener memory ids
    const scored: Array<{ memId: string; score: number; emb: EmbeddingDocument }> = [];
    for (const emb of nearby) {
      const sim = this._cosineSimilarity(qVec, emb.vector as number[]);
      const memId = emb.sourceId?.toString();
      if (!memId) continue;
      scored.push({ memId, score: sim, emb });
    }

    // agrupar por memory y seleccionar mejor score por memory
    const bestByMem = new Map<string, { score: number; emb: EmbeddingDocument }>();
    for (const s of scored) {
      const prev = bestByMem.get(s.memId);
      if (!prev || s.score > prev.score) bestByMem.set(s.memId, { score: s.score, emb: s.emb });
    }

    const memList = Array.from(bestByMem.entries()).map(([memId, { score }]) => ({ memId, score }));
    // Fetch memories
    const memDocs = await this.memoryModel.find({
      _id: { $in: memList.map(m => m.memId) },
      userId: new Types.ObjectId(userId),
      status: { $ne: 'deleted' },
      deleted: { $ne: true },
    }).lean().exec();

    // combine score with salience and recency
    const memMap = new Map<string, any>();
    memDocs.forEach(m => memMap.set(m._id.toString(), m));

    const weighted = memList
      .map(m => {
        const mem = memMap.get(m.memId);
        if (!mem) return null;
        const recencyScore = mem.lastReferencedAt ? (1 / (1 + ((Date.now() - new Date(mem.lastReferencedAt).getTime()) / (1000 * 60 * 60 * 24)))) : 0;
        // weight: 0.6*sim + 0.3*salience + 0.1*recency
        const score = (0.6 * m.score) + (0.3 * (mem.salience ?? 0.5)) + (0.1 * recencyScore);
        return { memory: mem, score, rawSim: m.score };
      })
      .filter(Boolean)
      .sort((a, b) => (b && a) ? b?.score - a?.score : 1)
      .slice(0, limit);

    // opcional: actualizar lastReferencedAt y recallCount
    const toUpdateIds = weighted.map(w => w ? w.memory._id : w);
    if (toUpdateIds.length) {
      this.memoryModel.updateMany(
        { _id: { $in: toUpdateIds } },
        { $inc: { recallCount: 1 }, $set: { lastReferencedAt: new Date() } },
      ).exec().catch(e => this.logger.warn('Failed to bump recallCount:', e));
    }

    return weighted.map(w => w ? w.memory : w);
  }

  /* ------------------ UTILITIES ------------------ */

  _truncate(s: string, n: number) {
    if (!s) return s;
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  private _canonicalize(text: string): string {
    if (!text) return '';
    // Normalización simple; puedes mejorar con librería de NLP
    return text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private _safeExtractJSON(raw: string): any | null {
    try {
      // Si raw ya es JSON
      return JSON.parse(raw);
    } catch (err) {
      // buscar primer '[' y última ']' e intentar parsear substring
      const start = raw.indexOf('[');
      const end = raw.lastIndexOf(']');
      if (start >= 0 && end > start) {
        const sub = raw.substring(start, end + 1);
        try {
          return JSON.parse(sub);
        } catch (e) {
          this.logger.debug('safeExtractJSON failed to parse substring', e);
          return null;
        }
      }
      return null;
    }
  }

  private _cosineSimilarity(a: number[], b: number[]) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  /**
   * Busca embeddings cercanos del mismo user.
   * Estrategia: cargar top N embeddings del usuario (puedes optimizar con index/Atlas vector search).
   */
  private async _findNearbyEmbeddingsForUser(userId: Types.ObjectId, vector: number[], topN: number = 100) {
    // Si guardaste `metadata.userId` en embeddings, filtramos por eso
    const candidates = await this.embeddingModel.find({
      'metadata.userId': userId.toString(),
      provider: VectorProvider.MONGO,
      deleted: { $ne: true },
    })
      .select({ vector: 1, sourceId: 1, provider: 1, metadata: 1, model: 1 })
      .limit(this.maxCandidatesToFetch)
      .lean()
      .exec();

    // calcular similitud cliente-lado
    const scored = candidates
      .map((c: any) => {
        if (!c.vector || !Array.isArray(c.vector)) return null;
        return { emb: c as EmbeddingDocument, score: this._cosineSimilarity(vector, c.vector as number[]) };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, topN)
      .map((s: any) => s.emb);

    return scored;
  }
}
