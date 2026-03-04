// src/documents/schema/document.schema.ts
import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";

export type DocumentDocument = HydratedDocument<Document>;

export enum DocumentType {
  DECRETO = 'Decreto',
  RESOLUCION = 'Resolución',
  DISPOSICION = 'Disposición',
  OTHER = 'Otro'
}

export enum DocumentStatus {
  PENDING = 'pending',           // Detectado, pendiente de procesamiento
  PROCESSING = 'processing',      // Descargando/procesando PDF
  EMBEDDING = 'embedding',        // Generando embeddings
  COMPLETED = 'completed',        // Procesado completamente
  FAILED = 'failed',             // Error en procesamiento
  SKIPPED = 'skipped'            // Saltado por flag
}

export enum DocumentArea {
  PODER_EJECUTIVO = 'Poder Ejecutivo',
  JEFATURA_GOBIERNO = 'Área Jefe de Gobierno',
  VICEJEFATURA = 'Vicejefatura de Gobierno',
  JEFATURA_GABINETE = 'Jefatura de Gabinete de Ministros',
  HACIENDA = 'Ministerio de Hacienda y Finanzas',
  SALUD = 'Ministerio de Salud',
  SEGURIDAD = 'Ministerio de Seguridad',
  EDUCACION = 'Ministerio de Educación',
  OTHER = 'Otro'
}

@Schema({ timestamps: true })
export class Document {
  @Prop({ type: String, required: true })
  nombre: string;

  @Prop({ type: String, required: true })
  sumario: string;

  @Prop({ type: Number, required: true, unique: true, index: true })
  idNorma: number; // id_norma de la API

  @Prop({ type: String, required: true })
  urlNorma: string; // URL del PDF principal

  @Prop({ type: String, enum: Object.values(DocumentType), required: true })
  type: DocumentType;

  @Prop({ type: String, enum: Object.values(DocumentArea), default: DocumentArea.OTHER })
  area: DocumentArea;

  @Prop({ type: String, default: null })
  subarea?: string; // ej: "Agencia de Protección Ambiental"

  @Prop({
    type: [
      {
        filenetFirmado: String,
        nombreAnexo: String,
        processed: { type: Boolean, default: false },
        url: String
      }
    ], default: []
  })
  anexos: Array<{
    filenetFirmado: string;
    nombreAnexo: string;
    processed: boolean;
    url: string;
  }>;

  @Prop({ type: String, default: null })
  idSdin?: string;

  @Prop({ type: String, enum: Object.values(DocumentStatus), default: DocumentStatus.PENDING })
  status: DocumentStatus;

  @Prop({ type: String, default: null })
  pdfText?: string; // Texto extraído del PDF

  @Prop({ type: Date, default: null, index: true })
  documentDate?: Date;

  @Prop({ type: Date, default: null, index: true })
  publicationDate?: Date; // Fecha en que se publicó en el boletín

  @Prop({ type: Number, default: 0 })
  embeddingCount: number; // Cuántos embeddings se crearon

  @Prop({ type: Date, default: null })
  processedAt?: Date;

  @Prop({ type: Date, default: null })
  lastSyncedAt?: Date;

  @Prop({ type: Object, default: {} })
  metadata?: Record<string, any>;

  @Prop({ type: String, default: null })
  errorMessage?: string;

  @Prop()
  lastRetryAt?: Date;

  @Prop({ type: Number, default: 0 })
  retryCount: number;

  @Prop({ type: Boolean, default: false })
  deleted?: boolean;

  @Prop({type: String})
  aiSummary: string;
}

export const DocumentSchema = SchemaFactory.createForClass(Document);

// Índices
DocumentSchema.index({ idNorma: 1 }, { unique: true });
DocumentSchema.index({ status: 1 });
DocumentSchema.index({ type: 1, area: 1 });
DocumentSchema.index({ processedAt: -1 });
DocumentSchema.index({ lastSyncedAt: -1 });
DocumentSchema.index({ documentDate: -1 });
DocumentSchema.index({ documentDate: 1, type: 1, area: 1 });
DocumentSchema.index({ publicationDate: -1, type: 1, area: 1 });