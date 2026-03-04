// src/chat/chat.gateway.ts
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { Logger, UseGuards } from '@nestjs/common';
import { ChatService } from './chat.service';
import { Types } from 'mongoose';

@WebSocketGateway({
  namespace: '/chat',
  cors: {
    origin: '*',
    credentials: true,
  },
  transports: ['websocket', 'polling'],
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private logger = new Logger(ChatGateway.name);
  private userSockets = new Map<string, string>(); // userId -> socketId
  private socketRooms = new Map<string, Set<string>>(); // socketId -> Set<conversationIds>

  constructor(
    private readonly jwtService: JwtService,
    private readonly chatService: ChatService,
  ) { }

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token ||
        client.handshake.query?.token as string;

      if (!token) {
        this.logger.warn(`Socket ${client.id} conectado sin token`);
        client.emit('error', { message: 'Token no proporcionado' });
        client.disconnect();
        return;
      }

      // Verificar token JWT
      const payload = this.jwtService.verify(token);
      const userId = payload.userId || payload.sub;

      if (!userId) {
        client.emit('error', { message: 'Token inválido' });
        client.disconnect();
        return;
      }

      // Asociar usuario con socket
      client.data.userId = userId;
      this.userSockets.set(userId, client.id);

      // Unir al room del usuario
      client.join(`user:${userId}`);

      this.logger.log(`Chat socket conectado: ${client.id} usuario: ${userId}`);
      client.emit('connected', { userId, socketId: client.id });

    } catch (error) {
      this.logger.error(`Error de conexión: ${error.message}`);
      client.emit('error', { message: 'Error de autenticación', status: 401 });
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const userId = client.data.userId;

    if (userId) {
      this.userSockets.delete(userId);

      // Limpiar rooms del socket
      const rooms = this.socketRooms.get(client.id);
      if (rooms) {
        rooms.forEach(room => client.leave(room));
        this.socketRooms.delete(client.id);
      }
    }

    this.logger.log(`Chat socket desconectado: ${client.id}`);
  }

  private joinConversationRoom(socketId: string, conversationId: string) {
    if (!this.socketRooms.has(socketId)) {
      this.socketRooms.set(socketId, new Set<string>());
    }
    this.socketRooms.get(socketId)!.add(`conversation:${conversationId}`);
  }


  private leaveConversationRoom(socketId: string, conversationId: string) {
    const rooms = this.socketRooms.get(socketId);
    if (rooms) {
      rooms.delete(`conversation:${conversationId}`);
    }
  }

  @SubscribeMessage('joinConversation')
  async handleJoinConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    try {
      const userId = client.data.userId;
      const { conversationId } = data;

      // Validar que el usuario tiene acceso a la conversación
      // (Aquí deberías agregar lógica de validación según tu aplicación)

      const roomName = `conversation:${conversationId}`;
      client.join(roomName);
      this.joinConversationRoom(client.id, conversationId);

      this.logger.log(`Usuario ${userId} se unió a conversación ${conversationId}`);
      client.emit('joinedConversation', { conversationId });

    } catch (error) {
      client.emit('error', { message: error.message });
    }
  }

  @SubscribeMessage('leaveConversation')
  async handleLeaveConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    try {
      const { conversationId } = data;
      const roomName = `conversation:${conversationId}`;

      client.leave(roomName);
      this.leaveConversationRoom(client.id, conversationId);

      client.emit('leftConversation', { conversationId });

    } catch (error) {
      client.emit('error', { message: error.message });
    }
  }

  private sanitizeChunk(raw: string) {
    // elimina marcas tipo [FINISH_REASON:stop] u otras variantes entre corchetes
    return raw.replace(/\[FINISH_REASON:[^\]]+\]/g, '')
  }

  @SubscribeMessage('sendMessage')
  async handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      conversationId: string;
      text: string;
      model?: string;
      temperature?: number;
      maxTokens?: number;
    },
  ) {
    try {
      const userId = client.data.userId;
      const { conversationId, text, model, temperature, maxTokens } = data;
      // Emitir evento de inicio de stream
      client.emit('streamStart', {
        conversationId,
        messageId: `temp-${Date.now()}`,
        timestamp: new Date().toISOString(),
      });

      // Enviar mensaje al chat service
      const result = await this.chatService.sendMessage(
        conversationId,
        new Types.ObjectId(userId),
        text,
        {
          model,
          temperature,
          maxTokens,
          stream: true,
        },
      );

      const stream = (result as any).stream;
      let fullResponse = '';

      stream.subscribe({
        next: (chunk: string) => {
          const sanitizedChunk = this.sanitizeChunk(chunk);
          if (!sanitizedChunk) return
          fullResponse += sanitizedChunk

          client.emit('chunk', {
            chunk,
            conversationId,
            fullResponse,
            timestamp: new Date().toISOString(),
          });
        },
        error: (error: any) => {
          this.logger.error('Stream error:', error);
          client.emit('streamError', {
            conversationId,
            error: error.message,
          });
        },
        complete: async () => {
          try {
            const finalResponse = this.sanitizeChunk(fullResponse);
            await this.chatService.continueStreamResponse(
              conversationId,
              new Types.ObjectId(userId),
              (result as any).userMessageId,
              finalResponse,
            );

            client.emit('streamComplete', {
              conversationId,
              fullResponse: finalResponse.trim(),
              messageId: (result as any).userMessageId,
            });

          } catch (error) {
            client.emit('streamError', {
              conversationId,
              error: error.message,
            });
          }
        },
      });
    } catch (error) {
      this.logger.error('Error en sendMessage:', error);
      client.emit('error', {
        message: error.message,
      });
    }
  }

  // Método para enviar notificaciones a un usuario específico
  sendToUser(userId: string, event: string, data: any) {
    const socketId = this.userSockets.get(userId);
    if (socketId) {
      this.server.to(socketId).emit(event, data);
    }
  }

  // Método para enviar a todos en una conversación
  sendToConversation(conversationId: string, event: string, data: any) {
    this.server.to(`conversation:${conversationId}`).emit(event, data);
  }
}