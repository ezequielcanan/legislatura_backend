// src/documents/schema/document-sync.schema.ts
import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument } from "mongoose";

export type DocumentSyncDocument = HydratedDocument<DocumentSync>;

export enum SyncStatus {
  IDLE = 'idle',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed'
}

@Schema({ timestamps: true })
export class DocumentSync {
  @Prop({ type: String, default: 'main', unique: true })
  syncKey: string; // Para identificar esta sync session

  @Prop({ type: String, enum: Object.values(SyncStatus), default: SyncStatus.IDLE })
  status: SyncStatus;

  @Prop({ type: Date, default: null })
  lastSyncStartedAt?: Date;

  @Prop({ type: Date, default: null })
  lastSyncCompletedAt?: Date;

  @Prop({ type: Number, default: 0 })
  totalDocumentsFound: number;

  @Prop({ type: Number, default: 0 })
  newDocumentsDetected: number;

  @Prop({ type: Number, default: 0 })
  documentsProcessed: number;

  @Prop({ type: Number, default: 0 })
  documentsFailed: number;

  @Prop({ type: String, default: null })
  apiUrl?: string; // URL de la API que se está monitoreando

  @Prop({ type: Object, default: {} })
  lastResponse?: Record<string, any>; // Último response de la API

  @Prop({ type: String, default: null })
  errorMessage?: string;

  @Prop({ type: Boolean, default: true })
  enableFullProcessing: boolean; // FLAG para procesar todos o solo uno

  @Prop({ type: Number, default: 15 })
  syncIntervalMinutes: number; // Intervalo de sincronización

  @Prop({ type: Object, default: {} })
  metadata?: Record<string, any>;
}

export const DocumentSyncSchema = SchemaFactory.createForClass(DocumentSync);