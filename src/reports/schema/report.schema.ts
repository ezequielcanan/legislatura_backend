// src/reports/schema/report.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ReportDocument = HydratedDocument<Report>;

export enum ReportStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
  ARCHIVED = 'archived',
}

@Schema({ timestamps: true })
export class Report {
  @Prop({ type: String, required: true })
  title: string;

  @Prop({ type: String, required: true })
  summary: string;

  @Prop({ type: String, required: true })
  content: string; // Contenido en Markdown

  @Prop({ type: String, required: true, index: true })
  category: string;

  @Prop({ type: String })
  readTime: string;

  @Prop({ type: Number })
  pages: number;

  @Prop({ type: [String], default: [] })
  sources: string[];

  @Prop({ type: String })
  docxPath?: string;

  @Prop({ type: Object })
  docxMeta?: {
    url: string;
    size: number;
    mimeType: string;
  };

  @Prop({ type: String, enum: Object.values(ReportStatus), default: ReportStatus.DRAFT })
  status: ReportStatus;

  @Prop({ type: Boolean, default: false, index: true })
  isPublished: boolean;

  @Prop({ type: Boolean, default: false, index: true })
  isPremium: boolean;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  generatedBy: Types.ObjectId;

  @Prop({ type: Date, required: true })
  generatedAt: Date;

  @Prop({ type: Date })
  publishedAt?: Date;

  @Prop({ type: Number, default: 0 })
  viewCount: number;

  @Prop({ type: Object, default: {} })
  metadata?: Record<string, any>;

  @Prop({ type: Boolean, default: false })
  deleted?: boolean;
}

export const ReportSchema = SchemaFactory.createForClass(Report);

// Índices
ReportSchema.index({ title: 'text', summary: 'text', content: 'text' });
ReportSchema.index({ category: 1, isPublished: 1 });
ReportSchema.index({ generatedAt: -1 });
ReportSchema.index({ isPremium: 1, isPublished: 1 });