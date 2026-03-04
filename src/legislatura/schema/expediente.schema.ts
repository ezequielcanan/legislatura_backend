import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ExpedienteDocument = HydratedDocument<Expediente>;

export enum ExpedienteStatus {
  PENDING = 'pending',
  DOWNLOADING = 'downloading',
  SUMMARIZING = 'summarizing',
  EMBEDDING = 'embedding',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

@Schema({ timestamps: true })
export class Expediente {
  @Prop({ type: Number, required: true, unique: true, index: true })
  expedienteId: number;

  @Prop({ type: String, required: true })
  numero: string;

  @Prop({ type: String })
  titulo: string;

  @Prop({ type: String })
  sumario: string;

  @Prop({ type: String })
  tipo: string;

  @Prop({ type: Number })
  tipoId: number;

  @Prop({ type: String })
  estado: string;

  @Prop({ type: Number })
  estadoId: number;

  @Prop({ type: String })
  ubicacion: string;

  @Prop({ type: Number })
  ubicacionId: number;

  @Prop({ type: String })
  fechaIngreso: string;

  @Prop({ type: Date, index: true })
  fechaIngresoDate: Date;

  @Prop({ type: String })
  anioParlamentario: string;

  // Authors from the API
  @Prop({ type: { legisladorId: Number, nombre: String, apellido: String }, required: false })
  autor: { legisladorId: number; nombre: string; apellido: string };

  @Prop({ type: [{ legisladorId: Number, nombre: String, apellido: String }], default: [] })
  coautores: Array<{ legisladorId: number; nombre: string; apellido: string }>;

  // PDF text extracted from the document
  @Prop({ type: String })
  pdfText: string;

  // AI-generated summary
  @Prop({ type: String })
  aiSummary: string;

  // AI-generated tags/categories
  @Prop({ type: [String], default: [] })
  aiTags: string[];

  // AI-generated category classification
  @Prop({ type: String })
  aiCategory: string;

  // Libros (books/documents) associated with the expediente
  @Prop({ type: [{ idDoc: Number, nombre: String, url: String, tipo: String }], default: [] })
  libros: Array<{ idDoc: number; nombre: string; url: string; tipo: string }>;

  // Voting data
  @Prop({ type: Object, default: null })
  votaciones: Record<string, any> | null;

  // Processing status
  @Prop({ type: String, enum: Object.values(ExpedienteStatus), default: ExpedienteStatus.PENDING })
  status: ExpedienteStatus;

  @Prop({ type: Number, default: 0 })
  embeddingCount: number;

  @Prop({ type: Date })
  processedAt: Date;

  @Prop({ type: String })
  errorMessage: string | undefined;

  @Prop({ type: Number, default: 0 })
  retryCount: number;

  @Prop({ type: Date })
  lastRetryAt: Date;
}

export const ExpedienteSchema = SchemaFactory.createForClass(Expediente);
ExpedienteSchema.index({ expedienteId: 1 }, { unique: true });
ExpedienteSchema.index({ numero: 1 });
ExpedienteSchema.index({ status: 1 });
ExpedienteSchema.index({ fechaIngresoDate: -1 });
ExpedienteSchema.index({ aiTags: 1 });
ExpedienteSchema.index({ aiCategory: 1 });
ExpedienteSchema.index({ tipo: 1 });
ExpedienteSchema.index({ 'autores.legisladorId': 1 });
