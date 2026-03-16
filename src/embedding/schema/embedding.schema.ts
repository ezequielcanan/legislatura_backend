// src/schemas/embedding.schema.ts
import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";

export type EmbeddingDocument = HydratedDocument<Embedding>;

export enum EmbeddingSourceType {
  MESSAGE = 'message',
  CHUNK = 'chunk',
  DOCUMENT = 'document',
  MEMORY = 'memory'
}

export enum VectorProvider {
  MONGO = 'mongo',         // store vector in this collection (useful for local + Atlas vector search)
  PINECONE = 'pinecone',   // store vector in Pinecone and reference it here
}

export enum ChunkType {
  SUMMARY = 'summary',     // AI-generated summary + metadata
  CONTENT = 'content',     // Actual document content chunk
}

@Schema({ timestamps: true })
export class Embedding {
  @Prop({ type: String, enum: Object.values(EmbeddingSourceType), required: true })
  sourceType: EmbeddingSourceType;

  @Prop({ type: Types.ObjectId, required: true })
  sourceId: Types.ObjectId;

  // Vector stored in MongoDB for Atlas Vector Search ($vectorSearch)
  @Prop({ type: [Number], required: false, select: false })
  vector?: number[] | null;

  @Prop({ type: String, enum: Object.values(VectorProvider), default: VectorProvider.MONGO })
  provider: VectorProvider;

  // If stored externally (pinecone), save its id
  @Prop({ type: String, default: null, index: true })
  externalId?: string | null;

  @Prop({ type: String, default: null })
  model?: string; // e.g. text-embedding-3-small

  @Prop({ type: Number, default: 0 })
  dims?: number;

  // Full chunk text for retrieval context (returned by Atlas Vector Search)
  @Prop({ type: String, default: null })
  chunkText?: string;

  // Chunk type: 'summary' for AI-generated summary, 'content' for document content
  @Prop({ type: String, enum: Object.values(ChunkType), default: ChunkType.CONTENT })
  chunkType?: ChunkType;

  @Prop({ type: String, default: null })
  snippet?: string; // small excerpt for debugging (legacy, replaced by chunkText)

  @Prop({ type: Object, default: {} })
  metadata?: Record<string, any>;

  @Prop({ type: Date, default: null })
  lastIndexedAt?: Date | null;

  @Prop({ type: Boolean, default: false })
  deleted?: boolean;
}

export const EmbeddingSchema = SchemaFactory.createForClass(Embedding);

// Standard indexes
EmbeddingSchema.index({ sourceType: 1, sourceId: 1 });
EmbeddingSchema.index({ sourceType: 1, deleted: 1 });
EmbeddingSchema.index({ provider: 1, externalId: 1 });
EmbeddingSchema.index({ model: 1 });

/**
 * IMPORTANT: MongoDB Atlas Vector Search Index
 * 
 * You must create this index via the Atlas UI / CLI / API.
 * Index name: "vector_index"
 * Collection: "embeddings"
 * 
 * Index definition (JSON):
 * {
 *   "fields": [
 *     {
 *       "type": "vector",
 *       "path": "vector",
 *       "numDimensions": 1536,
 *       "similarity": "cosine"
 *     },
 *     {
 *       "type": "filter",
 *       "path": "sourceType"
 *     },
 *     {
 *       "type": "filter",
 *       "path": "deleted"
 *     }
 *   ]
 * }
 */
