// src/surveys/schema/survey.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type SurveyDocument = HydratedDocument<Survey>;

export enum SurveyStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
  ARCHIVED = 'archived',
}

export enum QuestionType {
  SINGLE = 'single',
  MULTIPLE = 'multiple',
  SCALE = 'scale',
  OPEN = 'open',
}

@Schema({ _id: false })
export class SurveyQuestion {
  @Prop({ type: String, required: true })
  id: string;

  @Prop({ type: String, required: true })
  question: string;

  @Prop({ type: String, enum: Object.values(QuestionType), required: true })
  type: QuestionType;

  @Prop({ type: [String] })
  options?: string[];

  @Prop({ type: Object })
  scaleRange?: { min: number; max: number };
}

@Schema({ _id: false })
export class SurveyResult {
  @Prop({ type: String, required: true })
  questionId: string;

  @Prop({ type: String, required: true })
  question: string;

  @Prop({
    type: [
      {
        option: String,
        percentage: Number,
        count: Number,
      },
    ],
  })
  responses: Array<{
    option: string;
    percentage: number;
    count: number;
  }>;

  @Prop({ type: Number })
  confidenceInterval: number;
}

@Schema({ timestamps: true })
export class Survey {
  @Prop({ type: String, required: true })
  title: string;

  @Prop({ type: String, required: true })
  description: string;

  @Prop({ type: String, required: true, index: true })
  category: string;

  @Prop({ type: String, required: true })
  methodology: string;

  @Prop({ type: [SurveyQuestion], required: true })
  questions: SurveyQuestion[];

  @Prop({ type: [SurveyResult], required: true })
  results: SurveyResult[];

  @Prop({ type: Number, required: true })
  participants: number;

  @Prop({ type: Number, required: true })
  confidenceLevel: number;

  @Prop({ type: Number, required: true })
  marginOfError: number;

  @Prop({ type: String, required: true })
  dataCollectionPeriod: string;

  @Prop({ type: [String], default: [] })
  sources: string[];

  @Prop({ type: String, enum: Object.values(SurveyStatus), default: SurveyStatus.DRAFT })
  status: SurveyStatus;

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

export const SurveySchema = SchemaFactory.createForClass(Survey);

// Índices
SurveySchema.index({ title: 'text', description: 'text' });
SurveySchema.index({ category: 1, isPublished: 1 });
SurveySchema.index({ generatedAt: -1 });
SurveySchema.index({ isPremium: 1, isPublished: 1 });