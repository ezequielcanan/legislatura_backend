// src/rag/rag.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Embedding, EmbeddingDocument, EmbeddingSourceType } from '../embedding/schema/embedding.schema';
import { Expediente, ExpedienteDocument } from '../legislatura/schema/expediente.schema';
import { OpenRouterService } from '../openrouter/openrouter.service';
import { ConfigService } from '@nestjs/config';

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

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);
  private readonly similarityThreshold: number;
  private readonly maxCandidates = 200;

  constructor(
    @InjectModel(Embedding.name) private embeddingModel: Model<EmbeddingDocument>,
    @InjectModel(Expediente.name) private expedienteModel: Model<ExpedienteDocument>,
    private openRouterService: OpenRouterService,
    private configService: ConfigService,
  ) {
    this.similarityThreshold = Number(
      this.configService.get<number>('RAG_SIMILARITY_THRESHOLD', 0.72)
    );
  }

  /**
   * Search relevant expediente chunks based on a query, with optional tag/category pre-filtering
   */
  async searchRelevantDocuments(
    queryText: string,
    queryVector: number[],
    limit: number = 5,
    filters?: {
      tags?: string[];
      categories?: string[];
      tipo?: string;
    },
  ): Promise<ExpedienteChunk[]> {
    if (!queryText || queryText.trim().length === 0) {
      return [];
    }

    try {
      // 1. Find nearby embeddings (optionally pre-filtered by metadata tags)
      const nearbyEmbeddings = await this._findNearbyDocumentEmbeddings(
        queryVector,
        this.maxCandidates,
        filters,
      );

      if (nearbyEmbeddings.length === 0) {
        this.logger.debug('No nearby embeddings found');
        return [];
      }

      // 2. Score and filter by similarity
      const scoredChunks = nearbyEmbeddings
        .map((emb) => ({
          embedding: emb,
          similarity: this._cosineSimilarity(queryVector, emb.vector as number[]),
        }))
        .filter((item) => item.similarity >= this.similarityThreshold)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);

      if (scoredChunks.length === 0) {
        this.logger.debug('No chunks passed similarity threshold');
        return [];
      }

      // 3. Get expediente details
      const expedienteIds = scoredChunks.map((sc) => sc.embedding.sourceId);
      const expedientes = await this.expedienteModel
        .find({ _id: { $in: expedienteIds } })
        .lean()
        .exec();

      const expMap = new Map<string, any>();
      expedientes.forEach((exp) => {
        expMap.set(exp._id.toString(), exp);
      });

      // 4. Build chunks with full metadata
      const chunks: ExpedienteChunk[] = scoredChunks
        .map((sc) => {
          const exp = expMap.get(sc.embedding.sourceId.toString());
          if (!exp) return null;

          const metadata = sc.embedding.metadata || {};

          return {
            content: exp.pdfText || '',
            expedienteId: exp.expedienteId,
            expedienteDbId: exp._id.toString(),
            numero: exp.numero,
            titulo: exp.titulo,
            sumario: exp.sumario,
            tipo: exp.tipo,
            aiTags: exp.aiTags || [],
            aiCategory: exp.aiCategory || '',
            aiSummary: exp.aiSummary || '',
            chunkIndex: metadata.chunkIndex || 0,
            totalChunks: metadata.totalChunks || 1,
            similarity: sc.similarity,
          };
        })
        .filter(Boolean) as ExpedienteChunk[];

      this.logger.debug(
        `Found ${chunks.length} relevant expediente chunks (threshold: ${this.similarityThreshold})`
      );

      return chunks;
    } catch (error) {
      this.logger.error('Error searching relevant expedientes:', error);
      return [];
    }
  }

  /**
   * Format expediente chunks for LLM context
   */
  formatDocumentsForContext(chunks: ExpedienteChunk[]): string {
    if (chunks.length === 0) {
      return 'No se encontraron expedientes relevantes en la base de datos.';
    }

    const formatted = chunks.map((chunk, idx) => {
      return `
[Expediente ${idx + 1}]
Número: ${chunk.numero}
Título: ${chunk.titulo}
Tipo: ${chunk.tipo}
Categoría: ${chunk.aiCategory}
Tags: ${chunk.aiTags.join(', ')}
Resumen AI: ${chunk.aiSummary}
Relevancia: ${(chunk.similarity * 100).toFixed(1)}%
Contenido: ${chunk.content}
---`;
    });

    return `
EXPEDIENTES LEGISLATIVOS RELEVANTES:
${formatted.join('\n')}

INSTRUCCIONES:
- Basa tu respuesta principalmente en estos expedientes legislativos oficiales
- Cita específicamente los expedientes por su número cuando sea relevante
- Si la información no está en los expedientes, indícalo claramente
- Responde en español con tono profesional pero accesible
`;
  }

  private parseDDMMYYYY(dateStr: string): Date {
    const [day, month, year] = dateStr.split('/').map(Number);
    return new Date(year, month - 1, day);
  }

  /**
   * Find nearby document embeddings, optionally pre-filtered by metadata
   */
  private async _findNearbyDocumentEmbeddings(
    vector: number[],
    topN: number = 100,
    filters?: {
      tags?: string[];
      categories?: string[];
      tipo?: string;
      aiCategory?: string;
      dateRange?: { from: string; to: string };
    },
  ): Promise<EmbeddingDocument[]> {
    try {
      const query: any = {
        sourceType: EmbeddingSourceType.DOCUMENT,
        deleted: { $ne: true },
      };

      // Apply metadata filters if provided
      if (filters?.tags && filters.tags.length > 0) {
        query['metadata.aiTags'] = { $in: filters.tags };
      }
      /*if (filters?.aiCategory) {
        query['metadata.aiCategory'] = filters.aiCategory;
      }*/
      /*if (filters?.categories && filters.categories.length > 0) {
        query['metadata.aiCategory'] = { $in: filters.categories };
      }*/
      if (filters?.tipo) {
        query['metadata.tipo'] = filters.tipo;
      }


      if (filters?.dateRange) {
        const from = this.parseDDMMYYYY(filters.dateRange.from);
        from.setUTCHours(0, 0, 0, 0);

        const to = this.parseDDMMYYYY(filters.dateRange.to);
        to.setUTCHours(23, 59, 59, 999);

        query['metadata.fechaIngreso'] = {
          $gte: from,
          $lte: to,
        };
      }

      console.log('RAG search query filters:', query);

      const candidates = await this.embeddingModel
        .find(query)
        .select({ vector: 1, sourceId: 1, snippet: 1, metadata: 1 })
        .limit(this.maxCandidates)
        .lean()
        .exec();

      const scored = candidates
        .map((c: any) => {
          if (!c.vector || !Array.isArray(c.vector)) return null;
          return {
            emb: c as EmbeddingDocument,
            score: this._cosineSimilarity(vector, c.vector as number[]),
          };
        })
        .filter(Boolean)
        .sort((a: any, b: any) => b.score - a.score)
        .slice(0, topN)
        .map((s: any) => s.emb);

      return scored;
    } catch (error) {
      this.logger.error('Error finding nearby document embeddings:', error);
      return [];
    }
  }

  private _cosineSimilarity(a: number[], b: number[]): number {
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