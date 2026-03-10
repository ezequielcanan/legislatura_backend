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
    this.systemPrompt = `Eres un asistente AI especializado en la Legislatura de la Ciudad Autónoma de Buenos Aires.

CONTEXTO TEMPORAL:
Fecha actual de referencia: {current_date}

Esta fecha se proporciona únicamente como referencia temporal para el modelo.
- No asumas otras fechas distintas.
- Cuando hables de "hoy", "actualmente" o "recientemente", utiliza esta fecha como referencia.
- No modifiques ni infieras una fecha diferente salvo que el usuario lo indique explícitamente.

CAPACIDADES:
1. Analizar y explicar expedientes legislativos (proyectos de ley, resoluciones, declaraciones, comunicaciones)
2. Proporcionar información sobre legisladores, bloques políticos y comisiones
3. Recordar contexto e información de conversaciones anteriores
4. Responder consultas basándote en fuentes legislativas verificables

DIRECTRICES:
1. **Prioriza información de expedientes legislativos** cuando estén disponibles
2. Cita específicamente los expedientes por su número (ej: "Expediente 1234-D-2024")
3. Sé preciso con la información de legisladores y sus bloques
4. Sé empático y natural en el tono
5. Si no tienes información oficial, indícalo claramente
6. Mantén un tono profesional pero accesible
7. Cuando menciones proyectos, incluye su tipo, estado y autores si están disponibles

EXPEDIENTES LEGISLATIVOS RELEVANTES:
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

    // 1. Classify query to extract structured filters (intelligent RAG)
    const classification = await this.agentService.classifyQuery(text);
    //this.logger.debug(`Query classified: intent=${classification.intent}`);

    // 2. Generate embedding of the user message
    const qVec = await this.openRouterService.generateEmbedding(
      classification.refinedQuery || text,
    );

    // 3. Save user message
    const userMessage = await this.messageService.createMessage(
      userId,
      {
        conversationId,
        text,
        role: MessageRole.USER,
      },
      qVec,
    );

    // 4. **RAG: Search relevant expedientes with intelligent filtering**
    const ragFilters: any = {};
    if (classification.tags.length > 0) ragFilters.aiCategory = classification.tags[0];
    //if (classification.tags.length > 0) ragFilters.tags = classification.tags;
    if (classification.categories.length > 0) ragFilters.categories = classification.categories;
    if (classification.tipo) ragFilters.tipo = classification.tipo;
    if (classification.dateRange) ragFilters.dateRange = classification.dateRange;

    const relevantDocuments = await this.ragService.searchRelevantDocuments(
      classification.refinedQuery || text,
      qVec,
      50,
      ragFilters,
    );

    
    const documentsContext = this.ragService.formatDocumentsForContext(relevantDocuments);
    
    // 4. Obtener contexto conversacional
    const contextMessages = await this.messageService.getRelevantContext(
      new Types.ObjectId(conversationId),
      text,
      userId,
      10,
    );

    //console.log(contextMessages)

    // 6. Preparar mensajes para el LLM con contexto RAG
    const messages = this.buildMessagesWithContext(
      text,
      contextMessages,
      documentsContext,
    );

    //console.log(messages)


    if (stream) {
      // Stream de respuesta
      const streamObservable = this.openRouterService.createChatCompletionStream(messages, {
        model,
        temperature,
        max_tokens: maxTokens,
      });

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
            expedienteId: d.expedienteId,
            numero: d.numero,
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
    // Filtrar el mensaje actual del contexto si ya está incluido (evitar duplicados)
    const filteredContext = contextMessages.filter(
      msg => msg.role !== MessageRole.USER || msg.text !== currentMessage
    );
    
    const reversedMessages = [...filteredContext].reverse();

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

    // System prompt con todos los contextos
    messages.push({
      role: 'system',
      content: this.systemPrompt
        .replace('{documents}', documentsContext)
        .replace('{current_date}', new Date().toLocaleDateString('es-AR')),
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