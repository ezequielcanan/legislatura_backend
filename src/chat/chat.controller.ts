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
  NotFoundException,
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
      // Establecer headers para SSE primero
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Accel-Buffering', 'no');
      // Disable Nagle's algorithm for real-time streaming
      res.socket?.setNoDelay?.(true);
      res.flushHeaders();

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

      const stream = (result as any).stream;

      if (!stream || typeof stream.subscribe !== 'function') {
        throw new Error('Invalid stream object returned from chat service');
      }

      let fullResponse = '';
      let ragSources: any[] = [];
      // Regex to strip inline [REF-N] and (REF-N) patterns the LLM might still produce
      const refPattern = /\s*(?:\[REF-\d+\]|\(REF-\d+\))\s*/g;

      stream.subscribe({
        next: (chunk: string) => {
          // Check for embedded RAG sources marker from Python pipeline
          const sourcesMatch = chunk.match(/<!--RAG_SOURCES:(.*?)-->/s);
          if (sourcesMatch) {
            try {
              ragSources = JSON.parse(sourcesMatch[1]);
            } catch { /* ignore parse errors */ }
            // Remove the marker from the chunk before forwarding
            const cleanChunk = chunk.replace(/\n*<!--RAG_SOURCES:.*?-->/s, '').replace(refPattern, ' ').trim();
            if (cleanChunk) {
              fullResponse += cleanChunk;
              try {
                res.write(`data: ${JSON.stringify({ chunk: cleanChunk, conversationId, timestamp: new Date().toISOString() })}\n\n`);
                if (typeof (res as any).flush === 'function') (res as any).flush();
              } catch (err) {
                console.error('Error writing chunk:', err);
              }
            }
            return;
          }

          // Strip any inline [REF-N] patterns
          const cleanedChunk = chunk.replace(refPattern, ' ');
          fullResponse += cleanedChunk;
          
          try {
            const data = {
              chunk: cleanedChunk,
              conversationId,
              timestamp: new Date().toISOString(),
            };
            res.write(`data: ${JSON.stringify(data)}\n\n`);
            // Forzar flush inmediato para que el chunk llegue al cliente sin buffering
            if (typeof (res as any).flush === 'function') {
              (res as any).flush();
            }
          } catch (err) {
            console.error('Error writing chunk:', err);
          }
        },
        error: (error: any) => {
          console.error('Stream error:', error);
          try {
            res.write(`data: ${JSON.stringify({ error: error.message || 'Stream error' })}\n\n`);
          } catch (err) {
            console.error('Error writing error message:', err);
          } finally {
            res.end();
          }
        },
        complete: async () => {
          try {
            // Guardar el mensaje del asistente en la base de datos
            await this.chatService.continueStreamResponse(
              conversationId,
              userId,
              (result as any).userMessageId,
              fullResponse,
            );

            // Send sources event if available (from Python RAG pipeline)
            if (ragSources.length > 0) {
              res.write(`data: ${JSON.stringify({ sources: ragSources, conversationId })}\n\n`);
            }
            
            res.write('data: [DONE]\n\n');
          } catch (err) {
            console.error('Error writing completion:', err);
          } finally {
            res.end();
          }
        },
      });

      // Manejar cierre de conexión
      req.on('close', () => {
        if (!res.writableEnded) {
          res.end();
        }
      });
    } catch (error) {
      console.error('Stream message error:', error);
      if (!res.headersSent) {
        const statusCode = error instanceof NotFoundException 
          ? HttpStatus.NOT_FOUND 
          : HttpStatus.INTERNAL_SERVER_ERROR;
        
        res.status(statusCode).json({
          statusCode,
          message: error.message || 'Internal server error',
          error: error instanceof NotFoundException ? 'Not Found' : 'Internal Server Error',
        });
      } else {
        try {
          res.write(`data: ${JSON.stringify({ error: error.message || 'Internal server error' })}\n\n`);
          res.write('data: [DONE]\n\n');
        } catch (err) {
          console.error('Error sending error message:', err);
        } finally {
          res.end();
        }
      }
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