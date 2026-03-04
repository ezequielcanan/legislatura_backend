// src/chat/chat.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { OpenRouterService } from '../openrouter/openrouter.service';
import { ConversationService } from '../conversation/conversation.service';
import { MessageService } from '../message/message.service';
import { MessageRole } from '../message/schema/message.schema';
import { MemoryService } from '../memory/memory.service';
import { AgentService } from '../agent/agent.service';
import { RagService } from '../rag/rag.service';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly systemPrompt: string;

  constructor(
    private openRouterService: OpenRouterService,
    private conversationService: ConversationService,
    private agentService: AgentService,
    private messageService: MessageService,
    private memoryService: MemoryService,
    private ragService: RagService,
  ) {
    this.systemPrompt = `Eres un asistente AI especializado en documentos oficiales y normas del Gobierno de la Ciudad de Buenos Aires.

CAPACIDADES:
1. Analizar y explicar documentos oficiales (decretos, resoluciones, disposiciones)
2. Recordar contexto e información personal del usuario
3. Proporcionar respuestas basadas en fuentes oficiales verificables

DIRECTRICES:
1. **Prioriza información de documentos oficiales** cuando estén disponibles
2. Cita específicamente los documentos que uses (nombre, número, área)
3. Proporciona URLs para verificación
4. Sé empático y natural en el tono
5. Si no tienes información oficial, indícalo claramente
6. Mantén un tono profesional pero accesible

DOCUMENTOS RELEVANTES:
{documents}`;
  }

  async sendMessage(
    conversationId: string,
    userId: Types.ObjectId,
    text: string,
    options: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
      stream?: boolean;
    } = {},
  ) {
    const { model, temperature, maxTokens, stream = true } = options;

    // 1. Generar embedding del mensaje
    const qVec = await this.openRouterService.generateEmbedding(text);

    // 2. Guardar mensaje del usuario
    const userMessage = await this.messageService.createMessage(
      userId,
      {
        conversationId,
        text,
        role: MessageRole.USER,
      },
      qVec,
    );

    // 3. **RAG: Buscar documentos relevantes**
    const relevantDocuments = await this.ragService.searchRelevantDocuments(
      text,
      qVec,
      50, // Top 5 documentos más relevantes
    );

    
    const documentsContext = this.ragService.formatDocumentsForContext(relevantDocuments);
    
    // 4. Obtener contexto conversacional
    const contextMessages = await this.messageService.getRelevantContext(
      new Types.ObjectId(conversationId),
      text,
      userId,
      10,
    );

    // 6. Preparar mensajes para el LLM con contexto RAG
    const messages = this.buildMessagesWithContext(
      text,
      contextMessages,
      documentsContext,
    );


    if (stream) {
      // Stream de respuesta
      const streamObservable = this.agentService.createStream(messages, userId);

      return {
        stream: streamObservable,
        userMessageId: userMessage._id,
        conversationId: conversationId,
        relevantDocuments, // Incluir documentos en la respuesta
      };
    } else {
      // Respuesta sin stream
      const response = await this.openRouterService.createChatCompletion(messages, {
        model,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      });

      const assistantText = response?.choices?.[0]?.message?.content ?? '';

      const assistantMessage = await this.messageService.createMessage(userId, {
        conversationId,
        text: assistantText,
        role: MessageRole.ASSISTANT,
        metadata: {
          model: response.model,
          tokenCount: response.usage?.total_tokens,
          finishReason: response.choices[0].finish_reason,
          relevantDocuments: relevantDocuments.map((d) => ({
            idNorma: d.idNorma,
            name: d.documentName,
            similarity: d.similarity,
          })),
        },
      });

      return {
        response: assistantText,
        message: assistantMessage,
        usage: response.usage,
        relevantDocuments,
      };
    }
  }

  private buildMessagesWithContext(
    currentMessage: string,
    contextMessages: any[],
    documentsContext: string,
  ): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    const reversedMessages = [...contextMessages].reverse();

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

    // System prompt con todos los contextos
    messages.push({
      role: 'system',
      content: this.systemPrompt
        .replace('{documents}', documentsContext)
    });

    // Agregar historial de mensajes (limitado)
    let tokenCount = 0;
    const maxTokens = 2000;

    for (const msg of reversedMessages) {
      const estimatedTokens = msg.text.length / 4;
      if (tokenCount + estimatedTokens > maxTokens) break;

      messages.push({
        role: msg.role,
        content: msg.text,
      });
      tokenCount += estimatedTokens;
    }

    // Agregar mensaje actual
    messages.push({
      role: 'user',
      content: currentMessage,
    });

    return messages;
  }

  async continueStreamResponse(
    conversationId: string,
    userId: Types.ObjectId,
    userMessageId: string,
    fullResponse: string,
  ): Promise<void> {
    try {
      await this.messageService.createMessage(userId, {
        conversationId,
        text: fullResponse.trim(),
        role: MessageRole.ASSISTANT,
        metadata: {
          streamed: true,
        },
      });
    } catch (error) {
      this.logger.error(
        'Error saving streamed response:',
        error,
        fullResponse,
        fullResponse.trim(),
      );
      throw error;
    }
  }
}