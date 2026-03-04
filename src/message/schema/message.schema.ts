// src/schemas/message.schema.ts
import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";

export type MessageDocument = HydratedDocument<Message>;

export enum MessageRole {
  USER = 'user',
  ASSISTANT = 'assistant',
  SYSTEM = 'system'
}

@Schema({ timestamps: true })
export class Message {
  @Prop({ type: Types.ObjectId, required: true, index: true, ref: 'Conversation' })
  conversationId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true, index: true, ref: 'User' })
  userId: Types.ObjectId;

  @Prop({ type: String, enum: Object.values(MessageRole), default: MessageRole.USER })
  role: MessageRole;

  @Prop({ type: String, required: true })
  text: string;

  @Prop({ type: Number, default: null })
  tokenCount?: number;

  // Optional: small metadata (intent, source, channel)
  @Prop({ type: Object, default: {} })
  metadata?: Record<string, any>;

  // Option A: embedding stored inline (useful if Atlas Vector Search)
  @Prop({ type: [Number], required: false, select: false })
  embedding?: number[] | null;

  // If you prefer storing an external vector ref, keep an id:
  @Prop({ type: Types.ObjectId, ref: 'Embedding', default: null, select: false })
  embeddingRef?: Types.ObjectId | null;
}

export const MessageSchema = SchemaFactory.createForClass(Message);
MessageSchema.index({ conversationId: 1, createdAt: 1 });
MessageSchema.index({ userId: 1, createdAt: -1 });
