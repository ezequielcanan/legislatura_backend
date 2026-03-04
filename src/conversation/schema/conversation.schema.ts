import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { User } from '../../users/schema/users.schema';

export enum ConversationType {
  CHAT = 'chat',
  CALENDAR = 'calendar',
  SEARCH = 'search',
  PSYCHOLOGICAL = 'psychological',
  TASK = 'task',
  GENERAL = 'general'
}

export enum ConversationStatus {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
  DELETED = 'deleted'
}

@Schema({ timestamps: true })
export class Conversation {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ type: String, required: true, default: 'New Conversation' })
  title: string;

  @Prop({ type: String, enum: ConversationType, default: ConversationType.CHAT })
  type: ConversationType;

  @Prop({ type: String, enum: ConversationStatus, default: ConversationStatus.ACTIVE })
  status: ConversationStatus;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ type: Number, default: 0 })
  messageCount: number;

  @Prop({ type: Date, default: Date.now })
  lastActivityAt: Date;

  @Prop({ type: Object, default: {} })
  metadata: Record<string, any>;
}

export const ConversationSchema = SchemaFactory.createForClass(Conversation);
export type ConversationDocument = HydratedDocument<Conversation>;

ConversationSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc: any, ret: any) => {
    if (ret._id) ret._id = ret._id.toString();
    if (ret.userId) ret.userId = ret.userId.toString();
    delete ret.__v;
    return ret;
  },
});

ConversationSchema.set('toObject', {
  virtuals: true,
  transform: (_doc: any, ret: any) => {
    if (ret._id) ret._id = ret._id.toString();
    if (ret.userId) ret.userId = ret.userId.toString();
    delete ret.__v;
    return ret;
  },
});

// Índices para búsquedas frecuentes
ConversationSchema.index({ userId: 1, lastActivityAt: -1 });
ConversationSchema.index({ userId: 1, type: 1, status: 1 });
ConversationSchema.index({ userId: 1, tags: 1 });
ConversationSchema.index({ 'metadata.category': 1 });