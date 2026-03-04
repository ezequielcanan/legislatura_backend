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
  private readonly openaiApiKey: string;
  private readonly openaiBaseUrl: string = 'https://api.openai.com/v1';

  constructor(
    @InjectModel(Embedding.name) private embeddingModel: Model<EmbeddingDocument>,
    private configService: ConfigService,
    private httpService: HttpService,
    private openRouterService: OpenRouterService,
  ) {
    //this.openaiApiKey = this.configService.get<string>('OPENAI_API_KEY');
    // TODO: También podríamos usar OpenRouter para embeddings si lo soporta
  }

  async generateEmbedding(text: string, model: string = 'text-embedding-3-small'): Promise<number[]> {
    if (!this.openaiApiKey) {
      throw new Error('OPENAI_API_KEY is required for embeddings');
    }

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.openaiBaseUrl}/embeddings`,
          {
            input: text,
            model,
          },
          {
            headers: {
              Authorization: `Bearer ${this.openaiApiKey}`,
              'Content-Type': 'application/json',
            },
          },
        ),
      );

      return response.data.data[0].embedding;
    } catch (error: any) {
      this.logger.error('Failed to generate embedding:', error.response?.data || error.message);
      throw new Error(`Embedding generation failed: ${error.message}`);
    }
  }

  async createMessageEmbedding(
    sourceId: Types.ObjectId,
    text: string,
    metadata?: Record<string, any>,
  ): Promise<EmbeddingDocument> {
    const vector = await this.openRouterService.generateEmbedding(text);
    const snippet = text.slice(0, 200); // Guardar snippet para debugging

    const embedding = new this.embeddingModel({
      sourceType: EmbeddingSourceType.MESSAGE,
      sourceId,
      vector,
      provider: VectorProvider.MONGO,
      model: 'text-embedding-3-small',
      dims: vector.length,
      snippet,
      metadata,
      lastIndexedAt: new Date(),
    });

    return embedding.save();
  }

  async findSimilarEmbeddings(
    vector: number[],
    userId: Types.ObjectId,
    limit: number = 5,
    minSimilarity: number = 0.7,
  ): Promise<Array<{ embedding: EmbeddingDocument; similarity: number }>> {
    // TODO: Implementar búsqueda vectorial usando MongoDB Atlas Vector Search
    // Por ahora devolvemos resultados vacíos
    return [];
    
    /*
    // Ejemplo con MongoDB Atlas Vector Search (requiere índice):
    const pipeline = [
      {
        $vectorSearch: {
          index: "embedding_index",
          path: "vector",
          queryVector: vector,
          numCandidates: 100,
          limit: limit,
        },
      },
      {
        $project: {
          _id: 1,
          sourceType: 1,
          sourceId: 1,
          snippet: 1,
          metadata: 1,
          score: { $meta: "vectorSearchScore" },
        },
      },
    ];
    
    return this.embeddingModel.aggregate(pipeline);
    */
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