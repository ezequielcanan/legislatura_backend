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

@Schema({ timestamps: true })
export class Embedding {
  @Prop({ type: String, enum: Object.values(EmbeddingSourceType), required: true })
  sourceType: EmbeddingSourceType;

  @Prop({ type: Types.ObjectId, required: true })
  sourceId: Types.ObjectId;

  // If provider === 'mongo', vector may be present here.
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

  @Prop({ type: String, default: null })
  snippet?: string; // small excerpt for debugging/reranking

  @Prop({ type: Object, default: {} })
  metadata?: Record<string, any>;

  @Prop({ type: Date, default: null })
  lastIndexedAt?: Date | null;

  @Prop({ type: Boolean, default: false })
  deleted?: boolean;
}

export const EmbeddingSchema = SchemaFactory.createForClass(Embedding);

// Índices útiles
EmbeddingSchema.index({ sourceType: 1, sourceId: 1 });
EmbeddingSchema.index({ provider: 1, externalId: 1 });
EmbeddingSchema.index({ model: 1 });
