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

  @Prop({ type: String })
  url: string;

  // Libros (books/documents) associated with the expediente
  @Prop({ type: [{ idDoc: Number, nombre: String, url: String, tipo: String }], default: [] })
  libros: Array<{ idDoc: number; nombre: string; url: string; tipo: string }>;

  // Voting data
  @Prop({ type: Object, default: null })
  votaciones: Record<string, any> | null;

  // Comisiones (from giros API)
  @Prop({ type: [{ idComision: Number, comisionDes: String, comisionUrl: String, orden: Number, giroTipoDes: String }], default: [] })
  comisiones: Array<{ idComision: number; comisionDes: string; comisionUrl: string; orden: number; giroTipoDes: string }>;

  @Prop({ type: Date })
  comisionesUpdatedAt: Date;

  // Ubicacion actual (from API, refreshed periodically)
  @Prop({ type: String })
  ubicacionActual: string;

  @Prop({ type: Date })
  ubicacionActualUpdatedAt: Date;

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

  // BAE origin tracking
  @Prop({ type: Boolean, default: false })
  baeSource: boolean;

  @Prop({ type: [{ nroOrden: Number, anoParlamentario: Number }], default: [] })
  baeReferences: Array<{ nroOrden: number; anoParlamentario: number }>;

  @Prop({ type: String })
  baeGrupo: string;

  @Prop({ type: Number })
  baeOrden: number;

  @Prop({ type: String })
  baeDescripcion: string;
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
ExpedienteSchema.index({ 'comisiones.comisionUrl': 1 });
ExpedienteSchema.index({ baeSource: 1 });
ExpedienteSchema.index({ 'baeReferences.nroOrden': 1, 'baeReferences.anoParlamentario': 1 });
