// src/schemas/memory.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { VectorProvider } from '../../embedding/schema/embedding.schema'; // opcional si quieres referenciar provider enum

export type MemoryDocument = HydratedDocument<Memory>;

export enum MemoryType {
  FACT = 'fact',                // hechos objetivos (ej: "Mi mamá se llama Ana")
  PREFERENCE = 'preference',    // gustos, preferencias (ej: "Me gusta el mate")
  EVENT = 'event',              // eventos (ej: "Fui a tal charla el 2025-01-01")
  TODO = 'todo',                // tareas o recordatorios
  EPHEMERAL = 'ephemeral'       // recuerdos de corta vida (caducan)
}

export enum MemoryStatus {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
  FORGOTTEN = 'forgotten',
  DELETED = 'deleted'
}

@Schema({ timestamps: true })
export class Memory {
  // Identidad
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  // Contexto de origen (opcional)
  @Prop({ type: Types.ObjectId, ref: 'Conversation', default: null, index: true })
  conversationId?: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'Message', default: null, index: true })
  sourceMessageId?: Types.ObjectId | null;

  // Tipo y estado
  @Prop({ type: String, enum: Object.values(MemoryType), default: MemoryType.FACT })
  type: MemoryType;

  @Prop({ type: String, enum: Object.values(MemoryStatus), default: MemoryStatus.ACTIVE })
  status: MemoryStatus;

  // Contenido principal
  @Prop({ type: String, required: true })
  content: string; // texto completo del "fact"

  @Prop({ type: String, default: null })
  title?: string | null; // resumen corto opcional

  // Canonicalización (normalización para deduplicar)
  @Prop({ type: String, default: null, select: false })
  canonical?: string | null;

  // Enlaces a embeddings (guardar el id de la colección Embedding)
  @Prop({ type: Types.ObjectId, ref: 'Embedding', default: null, select: false })
  embeddingRef?: Types.ObjectId | null;

  // Señales de importancia / uso
  @Prop({ type: Number, default: 0.5 }) // 0..1
  salience: number;

  @Prop({ type: Number, default: 0 })
  recallCount: number; // cuantas veces la IA recuperó esta memoria

  @Prop({ type: Date, default: null })
  lastReferencedAt?: Date | null; // para decay / recency

  @Prop({ type: Boolean, default: false })
  pinned: boolean;

  // Visibilidad / privacidad (por ahora, sólo user-scoped)
  @Prop({ type: Boolean, default: true })
  visibleToUserOnly: boolean;

  // Etiquetas y metadatos libres
  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ type: Object, default: {} })
  metadata?: Record<string, any>;

  // Caducidad opcional (para memories EPHEMERAL)
  @Prop({ type: Date, default: null })
  expiresAt?: Date | null;

  // Soft delete
  @Prop({ type: Boolean, default: false })
  deleted?: boolean;
}

export const MemorySchema = SchemaFactory.createForClass(Memory);

// Transformaciones toJSON / toObject útiles
MemorySchema.set('toJSON', {
  virtuals: true,
  transform: (_doc: any, ret: any) => {
    if (ret._id) ret._id = ret._id.toString();
    if (ret.userId) ret.userId = ret.userId.toString();
    delete ret.__v;
    return ret;
  },
});

MemorySchema.set('toObject', {
  virtuals: true,
  transform: (_doc: any, ret: any) => {
    if (ret._id) ret._id = ret._id.toString();
    if (ret.userId) ret.userId = ret.userId.toString();
    delete ret.__v;
    return ret;
  },
});

// Índices recomendados
MemorySchema.index({ userId: 1, status: 1, type: 1 });
MemorySchema.index({ userId: 1, lastReferencedAt: -1 });
MemorySchema.index({ userId: 1, tags: 1 });
MemorySchema.index({ userId: 1, pinned: 1, salience: -1 });

// Índice de texto para búsquedas rápidas (weights para dar prioridad al title)
MemorySchema.index(
  { title: 'text', content: 'text' },
  { weights: { title: 5, content: 1 }, name: 'MemoryTextIndex' }
);

// Índice para expiración si usas TTL (opcional)
// MemorySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
