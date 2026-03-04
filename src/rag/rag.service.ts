// src/rag/rag.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Embedding, EmbeddingDocument, EmbeddingSourceType } from '../embedding/schema/embedding.schema';
import { Document, DocumentDocument } from '../documents/schema/document.schema';
import { OpenRouterService } from '../openrouter/openrouter.service';
import { ConfigService } from '@nestjs/config';

export interface DocumentChunk {
  content: string;
  documentId: string;
  idNorma: number;
  documentName: string;
  documentSummary: string;
  area: string;
  type: string;
  chunkIndex: number;
  totalChunks: number;
  similarity: number;
  url: string;
}

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);
  private readonly similarityThreshold: number;
  private readonly maxCandidates = 200;

  constructor(
    @InjectModel(Embedding.name) private embeddingModel: Model<EmbeddingDocument>,
    @InjectModel(Document.name) private documentModel: Model<DocumentDocument>,
    private openRouterService: OpenRouterService,
    private configService: ConfigService,
  ) {
    this.similarityThreshold = Number(
      this.configService.get<number>('RAG_SIMILARITY_THRESHOLD', 0.75)
    );
  }

  /**
   * Busca documentos relevantes basados en una consulta
   */
  async searchRelevantDocuments(
    queryText: string,
    queryVector: number[],
    limit: number = 5,
  ): Promise<DocumentChunk[]> {
    if (!queryText || queryText.trim().length === 0) {
      return [];
    }

    try {
      // 1. Buscar embeddings similares de documentos
      const nearbyEmbeddings = await this._findNearbyDocumentEmbeddings(
        queryVector,
        this.maxCandidates
      );

      if (nearbyEmbeddings.length === 0) {
        this.logger.debug('No nearby embeddings found');
        return [];
      }

      // 2. Calcular similitud y filtrar
      const scoredChunks: Array<{
        embedding: EmbeddingDocument;
        similarity: number;
      }> = nearbyEmbeddings
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

      // 3. Obtener información de documentos
      const documentIds = scoredChunks.map((sc) => sc.embedding.sourceId);
      const documents = await this.documentModel
        .find({ _id: { $in: documentIds } })
        .lean()
        .exec();

      const docMap = new Map<string, any>();
      documents.forEach((doc) => {
        docMap.set(doc._id.toString(), doc);
      });

      // 4. Construir chunks con metadata completa
      const chunks: DocumentChunk[] = scoredChunks
        .map((sc) => {
          const doc = docMap.get(sc.embedding.sourceId.toString());
          if (!doc) return null;

          const metadata = sc.embedding.metadata || {};

          return {
            content: sc.embedding.snippet || '',
            documentId: doc._id.toString(),
            idNorma: doc.idNorma,
            documentName: doc.nombre,
            documentSummary: doc.sumario,
            area: doc.area,
            type: doc.type,
            chunkIndex: metadata.chunkIndex || 0,
            totalChunks: metadata.totalChunks || 1,
            similarity: sc.similarity,
            url: doc.urlNorma,
          };
        })
        .filter(Boolean) as DocumentChunk[];

      this.logger.debug(
        `Found ${chunks.length} relevant document chunks (threshold: ${this.similarityThreshold})`
      );

      return chunks;
    } catch (error) {
      this.logger.error('Error searching relevant documents:', error);
      return [];
    }
  }

  /**
   * Formatea los chunks de documentos para el contexto del LLM
   */
  formatDocumentsForContext(chunks: DocumentChunk[]): string {
    if (chunks.length === 0) {
      return 'No se encontraron documentos relevantes.';
    }

    const formatted = chunks.map((chunk, idx) => {
      return `
[Documento ${idx + 1}]
Nombre: ${chunk.documentName}
Área: ${chunk.area} - ${chunk.type}
Sumario: ${chunk.documentSummary}
Relevancia: ${(chunk.similarity * 100).toFixed(1)}%
Contenido: ${chunk.content}
URL: ${chunk.url}
---`;
    });

    return `
DOCUMENTOS OFICIALES RELEVANTES:
${formatted.join('\n')}

INSTRUCCIONES:
- Basa tu respuesta principalmente en estos documentos oficiales
- Cita específicamente los documentos cuando sea relevante
- Si la información no está en los documentos, indícalo claramente
- Proporciona las URLs para que el usuario pueda verificar
`;
  }

  /**
   * Busca embeddings de documentos cercanos al vector query
   */
  private async _findNearbyDocumentEmbeddings(
    vector: number[],
    topN: number = 100
  ): Promise<EmbeddingDocument[]> {
    try {
      // Buscar solo embeddings de documentos
      const candidates = await this.embeddingModel
        .find({
          sourceType: EmbeddingSourceType.DOCUMENT,
          deleted: { $ne: true },
        })
        .select({ vector: 1, sourceId: 1, snippet: 1, metadata: 1 })
        .limit(this.maxCandidates)
        .lean()
        .exec();

      // Calcular similitud cliente-lado
      // En producción, usar MongoDB Atlas Vector Search para mejor rendimiento
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

  /**
   * Calcula similitud coseno entre dos vectores
   */
  private _cosineSimilarity(a: number[], b: number[]): number {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0,
      na = 0,
      nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  /**
   * Obtiene estadísticas de documentos y embeddings
   */
  async getStats(): Promise<{
    totalDocuments: number;
    processedDocuments: number;
    totalEmbeddings: number;
    averageEmbeddingsPerDoc: number;
  }> {
    const [totalDocs, processedDocs, totalEmbs] = await Promise.all([
      this.documentModel.countDocuments(),
      this.documentModel.countDocuments({ status: 'completed' }),
      this.embeddingModel.countDocuments({ sourceType: EmbeddingSourceType.DOCUMENT }),
    ]);

    return {
      totalDocuments: totalDocs,
      processedDocuments: processedDocs,
      totalEmbeddings: totalEmbs,
      averageEmbeddingsPerDoc: processedDocs > 0 ? totalEmbs / processedDocs : 0,
    };
  }
}