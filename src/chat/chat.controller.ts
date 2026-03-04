// src/chat/chat.controller.ts
import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  Sse,
  MessageEvent,
  HttpStatus,
  HttpException,
  Res,
  Delete,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ChatService } from './chat.service';
import { ConversationService } from '../conversation/conversation.service';
import { MessageService } from '../message/message.service';
import { CreateConversationDto } from '../conversation/dto/conversation.dto';
import { SendMessageDto } from './dto/chat.dto';
import { Observable, map } from 'rxjs';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';
import { Roles } from 'src/common/decorators/roles.decorator';
import { UserRole } from 'src/users/schema/users.schema';

@ApiTags('chat')
@ApiBearerAuth()
@Controller('chat')
@UseGuards(JwtAuthGuard)
@Roles(UserRole.ADMIN)
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly conversationService: ConversationService,
    private readonly messageService: MessageService,
  ) { }

  @Post('conversations')
  @ApiOperation({ summary: 'Create a new conversation' })
  @ApiResponse({ status: 201, description: 'Conversation created' })
  async createConversation(
    @Req() req: any,
    @Body() dto: CreateConversationDto,
  ) {
    const userId = req.user.userId;
    return this.conversationService.createConversation(userId, dto);
  }

  @Get('conversations')
  @ApiOperation({ summary: 'Get user conversations' })
  async getConversations(
    @Req() req: any,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '20',
    @Query('status') status?: string,
    @Query('section') section?: string,
  ) {
    const userId = req.user.userId;
    return this.conversationService.getUserConversations(
      userId,
      parseInt(page),
      parseInt(limit),
      status as any,
      section
    );
  }

  @Get('conversations/:id')
  @ApiOperation({ summary: 'Get conversation details' })
  async getConversation(
    @Param('id') id: string,
    @Req() req: any,
  ) {
    const userId = req.user.userId;
    return this.conversationService.getConversation(id, userId);
  }

  @Get('conversations/:id/messages')
  @ApiOperation({ summary: 'Get conversation messages' })
  async getMessages(
    @Param('id') id: string,
    @Req() req: any,
    @Query('limit') limit: string = '50',
    @Query('before') before?: string,
  ) {
    const userId = req.user.userId;
    return this.messageService.getConversationMessages(id, userId, parseInt(limit), before);
  }

  @Post('conversations/:id/messages')
  @ApiOperation({ summary: 'Send a message (non-streaming)' })
  async sendMessage(
    @Param('id') conversationId: string,
    @Req() req: any,
    @Body() dto: SendMessageDto,
  ) {
    const userId = req.user.userId;

    try {
      const result = await this.chatService.sendMessage(
        conversationId,
        userId,
        dto.text,
        {
          model: dto.model,
          temperature: dto.temperature,
          maxTokens: dto.maxTokens,
          stream: false,
        },
      );

      return result;
    } catch (error) {
      throw new HttpException(
        error.message,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('conversations/:id/messages/stream')
  async streamMessage(
    @Param('id') conversationId: string,
    @Req() req: any,
    @Body() dto: SendMessageDto,
    @Res() res: Response,
  ) {
    const userId = req.user.userId;

    try {
      const result = await this.chatService.sendMessage(
        conversationId,
        userId,
        dto.text,
        {
          model: dto.model,
          temperature: dto.temperature,
          maxTokens: dto.maxTokens,
          stream: true,
        },
      );

      // Establecer headers para SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');

      const stream = (result as any).stream;

      stream.subscribe({
        next: (chunk: string) => {
          const data = {
            chunk,
            conversationId,
            timestamp: new Date().toISOString(),
          };
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        },
        error: (error: any) => {
          console.error('Stream error:', error);
          res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
          res.end();
        },
        complete: () => {
          res.write('data: [DONE]\n\n');
          res.end();
        },
      });

      // Manejar cierre de conexión
      req.on('close', () => {
        res.end();
      });
    } catch (error) {
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        message: error.message,
      });
    }
  }

  @Delete('conversations/:id')
  @ApiOperation({ summary: 'Get conversation details' })
  async deleteConversation(
    @Param('id') id: string,
    @Req() req: any,
  ) {
    const userId = req.user.userId;
    return this.conversationService.deleteConversation(id, userId);
  }
}