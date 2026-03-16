// src/messages/messages.service.ts
import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Message, MessageDocument, MessageRole } from './schema/message.schema';
import { ConversationService } from '../conversation/conversation.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { CreateMessageDto } from './dto/message.dto';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MessageService {
  private readonly logger = new Logger(MessageService.name);
  private readonly enableEmbeddings: boolean;

  constructor(
    @InjectModel(Message.name) private messageModel: Model<MessageDocument>,
    private conversationService: ConversationService,
    private embeddingService: EmbeddingService,
    private configService: ConfigService,
  ) {
    this.enableEmbeddings = this.configService.get<boolean>('ENABLE_EMBEDDINGS', true);
  }

  async createMessage(
    userId: Types.ObjectId,
    dto: CreateMessageDto,
    qVec?: number[]
  ): Promise<MessageDocument> {
    // Verificar que la conversación existe y pertenece al usuario
    const conv = await this.conversationService.getConversation(dto.conversationId, userId);

    const message = new this.messageModel({
      conversationId: new Types.ObjectId(dto.conversationId),
      userId,
      role: dto.role || MessageRole.USER,
      text: dto.text,
      metadata: dto.metadata || {},
    });

    const savedMessage = await message.save();

    await this.conversationService.incrementMessageCount(
      new Types.ObjectId(dto.conversationId),
    );

    if (conv?.messageCount === 0) {
      await this.conversationService.updateConversation(dto?.conversationId, userId, {title: dto.text?.slice(0,40)})
    }

    return savedMessage;
  }

  async getConversationMessages(
    conversationId: string,
    userId: Types.ObjectId,
    limit: number = 50,
    before?: string,
  ): Promise<MessageDocument[]> {
    // Verificar que la conversación pertenece al usuario
    await this.conversationService.getConversation(conversationId, userId);
    const query: any = {
      conversationId: new Types.ObjectId(conversationId),
    };

    if (before) {
      query.createdAt = { $lt: new Date(before) };
    }

    const messages = await this.messageModel
      .find(query)
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean()
      .exec();

    return messages.map((m: any) => ({ ...m, _id: m._id.toString() }));
  }

  async getMessagesForContext(
    conversationId: Types.ObjectId,
    limit: number = 10,
  ): Promise<MessageDocument[]> {
    return this.messageModel
      .find({ conversationId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .exec();
  }

  async getRelevantContext(
    conversationId: Types.ObjectId,
    currentMessage: string,
    userId: Types.ObjectId,
    limit: number = 5,
  ): Promise<MessageDocument[]> {
    if (!this.enableEmbeddings) {
      // Fallback a los últimos mensajes
      return this.getMessagesForContext(conversationId, limit);
    }

    try {
      // Generar embedding del mensaje actual para buscar en la memoria de los documentos
      //const currentVector = await this.embeddingService.generateEmbedding(currentMessage);
      // (TODO: implementar búsqueda vectorial)

      return this.getMessagesForContext(conversationId, limit);
    } catch (error) {
      this.logger.warn('Vector search failed, falling back to recent messages:', error);
      return this.getMessagesForContext(conversationId, limit);
    }
  }

  async deleteMessage(
    messageId: string,
    userId: Types.ObjectId,
  ): Promise<void> {
    const message = await this.messageModel.findOneAndDelete({
      _id: messageId,
      userId,
    }).exec();

    if (!message) {
      throw new NotFoundException('Message not found');
    }

    // Marcar embedding como eliminado si existe
    if (this.enableEmbeddings) {
      try {
        await this.embeddingService.deleteEmbeddingsBySource(
          'message' as any,
          message._id,
        );
      } catch (error) {
        this.logger.error('Failed to delete embedding:', error);
      }
    }
  }
}