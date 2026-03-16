// src/embeddings/embeddings.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Embedding, EmbeddingDocument, EmbeddingSourceType, VectorProvider } from './schema/embedding.schema';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { OpenRouterService } from 'src/openrouter/openrouter.service';

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly vectorIndexName: string;

  constructor(
    @InjectModel(Embedding.name) private embeddingModel: Model<EmbeddingDocument>,
    private configService: ConfigService,
    private httpService: HttpService,
    private openRouterService: OpenRouterService,
  ) {
    this.vectorIndexName = this.configService.get<string>('ATLAS_VECTOR_INDEX', 'vector_index');
  }

  async createMessageEmbedding(
    sourceId: Types.ObjectId,
    text: string,
    metadata?: Record<string, any>,
  ): Promise<EmbeddingDocument> {
    const vector = await this.openRouterService.generateEmbedding(text);
    const snippet = text.slice(0, 200);

    const embedding = new this.embeddingModel({
      sourceType: EmbeddingSourceType.MESSAGE,
      sourceId,
      vector,
      provider: VectorProvider.MONGO,
      model: 'text-embedding-3-small',
      dims: vector.length,
      chunkText: text,
      snippet,
      metadata,
      lastIndexedAt: new Date(),
    });

    return embedding.save();
  }

  /**
   * Find similar embeddings using MongoDB Atlas $vectorSearch.
   * Requires an Atlas Vector Search index named `vector_index` on the `embeddings` collection.
   */
  async findSimilarEmbeddings(
    vector: number[],
    userId: Types.ObjectId,
    limit: number = 5,
    minScore: number = 0.7,
  ): Promise<Array<{ embedding: EmbeddingDocument; similarity: number }>> {
    try {
      const pipeline: any[] = [
        {
          $vectorSearch: {
            index: this.vectorIndexName,
            path: 'vector',
            queryVector: vector,
            numCandidates: limit * 10,
            limit,
            filter: {
              sourceType: EmbeddingSourceType.MESSAGE,
              deleted: { $ne: true },
            },
          },
        },
        {
          $project: {
            _id: 1,
            sourceType: 1,
            sourceId: 1,
            chunkText: 1,
            snippet: 1,
            metadata: 1,
            score: { $meta: 'vectorSearchScore' },
          },
        },
      ];

      const results = await this.embeddingModel.aggregate(pipeline).exec();

      return results
        .filter((r) => r.score >= minScore)
        .map((r) => ({
          embedding: r as unknown as EmbeddingDocument,
          similarity: r.score,
        }));
    } catch (error) {
      this.logger.error('Atlas Vector Search failed:', error);
      return [];
    }
  }

  async deleteEmbeddingsBySource(
    sourceType: EmbeddingSourceType,
    sourceId: Types.ObjectId,
  ): Promise<void> {
    await this.embeddingModel.updateMany(
      { sourceType, sourceId },
      { deleted: true },
    );
  }
}