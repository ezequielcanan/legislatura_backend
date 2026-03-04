// src/conversations/conversations.service.ts
import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Conversation, ConversationDocument, ConversationStatus, ConversationType } from './schema/conversation.schema';
import { CreateConversationDto, UpdateConversationDto } from './dto/conversation.dto';

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    @InjectModel(Conversation.name) private conversationModel: Model<ConversationDocument>,
  ) { }

  async createConversation(
    userId: Types.ObjectId,
    dto: CreateConversationDto,
  ): Promise<ConversationDocument | any> {
    const existingConv = await this.conversationModel.findOne({ messageCount: 0 }).lean().exec()

    if (existingConv) {
      return { ...existingConv, _id: existingConv._id?.toString() };
    }

    const conversation = new this.conversationModel({
      userId: new Types.ObjectId(userId),
      title: dto.title || 'New Conversation',
      type: dto.type,
      tags: dto.tags || [],
      metadata: dto.metadata || {},
      lastActivityAt: new Date(),
    });

    const saved = await conversation.save()
    return saved.toObject()
  }

  async getUserConversations(
    userId: Types.ObjectId,
    page: number = 1,
    limit: number = 20,
    status: ConversationStatus = ConversationStatus.ACTIVE,
    section?: string | ConversationType,
  ): Promise<{ conversations: ConversationDocument[]; total: number }> {
    const skip = (page - 1) * limit;
    const sectionFilter = {}
    if (section) {
      sectionFilter['type'] = section
    }
    const [conversationsDocs, total] = await Promise.all([
      this.conversationModel
        .find({ userId: new Types.ObjectId(userId), status, ...sectionFilter })
        .sort({ lastActivityAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      this.conversationModel.countDocuments({ userId, status, ...sectionFilter }),
    ]);

    const conversations = conversationsDocs.map(doc => doc.toObject());
    return { conversations: conversations, total };
  }

  async getConversation(
    conversationId: string,
    userId: Types.ObjectId,
  ): Promise<ConversationDocument> {
    // Validar que el conversationId sea un ObjectId válido
    if (!Types.ObjectId.isValid(conversationId)) {
      this.logger.warn(`Invalid conversation ID format: ${conversationId}`);
      throw new NotFoundException('Invalid conversation ID format');
    }

    const conversation = await this.conversationModel.findOne({
      _id: new Types.ObjectId(conversationId),
      userId: new Types.ObjectId(userId),
      status: { $ne: ConversationStatus.DELETED },
    }).exec();

    if (!conversation) {
      this.logger.warn(`Conversation not found: ${conversationId} for user: ${userId}`);
      throw new NotFoundException('Conversation not found');
    }

    return conversation;
  }

  async updateConversation(
    conversationId: string,
    userId: Types.ObjectId,
    dto: UpdateConversationDto,
  ): Promise<ConversationDocument> {
    const conversation = await this.conversationModel.findOneAndUpdate(
      { _id: new Types.ObjectId(conversationId), userId: new Types.ObjectId(userId) },
      {
        ...dto,
        ...(dto.title || dto.status ? { lastActivityAt: new Date() } : {}),
      },
      { new: true },
    ).exec();

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    return conversation;
  }

  async deleteConversation(
    conversationId: string,
    userId: Types.ObjectId,
  ): Promise<ConversationDocument | any> {
    const conversation = await this.conversationModel.findOneAndDelete(
      { _id: new Types.ObjectId(conversationId), userId: new Types.ObjectId(userId) },
    ).exec();
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    return { conversation, _id: conversation?._id?.toString() };
  }

  async incrementMessageCount(conversationId: Types.ObjectId): Promise<void> {
    await this.conversationModel.findByIdAndUpdate(
      conversationId,
      {
        $inc: { messageCount: 1 },
        lastActivityAt: new Date(),
      },
    ).exec();
  }

  async updateConversationTitle(
    conversationId: Types.ObjectId,
    title: string,
  ): Promise<void> {
    await this.conversationModel.findByIdAndUpdate(
      conversationId,
      { title, lastActivityAt: new Date() },
    ).exec();
  }
}