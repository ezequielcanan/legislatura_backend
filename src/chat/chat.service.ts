// src/chat/chat.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { OpenRouterService } from '../openrouter/openrouter.service';
import { ConversationService } from '../conversation/conversation.service';
import { MessageService } from '../message/message.service';
import { MessageRole } from '../message/schema/message.schema';
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
2. **Cita SIEMPRE las fuentes** usando el formato [REF-N] cuando uses información de los expedientes proporcionados
3. Cita específicamente los expedientes por su número (ej: "Expediente 1234-D-2024")
4. Sé preciso con la información de legisladores y sus bloques
5. Sé empático y natural en el tono
6. Si no tienes información oficial, indícalo claramente — NUNCA inventes información
7. Mantén un tono profesional pero accesible
8. Cuando menciones proyectos, incluye su tipo, estado y autores si están disponibles

CITACIONES:
- Cada expediente en el contexto tiene un identificador [REF-N] asociado
- Cuando uses información de un expediente, incluye su [REF-N] al final de la oración o párrafo relevante
- Si combinas información de múltiples expedientes, cita todos los relevantes: [REF-1][REF-3]
- Si la información NO proviene de los expedientes proporcionados, indícalo explícitamente
- Ejemplo: "El proyecto propone modificar la normativa de tránsito en la zona centro [REF-2]."

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

    // 1. Lightweight classification (zero-cost, no LLM call)
    const classification = this.agentService.classifyQuery(text);

    // 2. Generate embedding of the user message
    const qVec = await this.openRouterService.generateEmbedding(text);

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

    // 4. RAG: Atlas Vector Search → keyword rerank → deduplicate → top N
    const ragResult = await this.ragService.search(text, qVec);

    const documentsContext = this.ragService.formatContextForLLM(ragResult);

    // Convert for backward-compatible emission
    const relevantDocuments = ragResult.chunks.map((c) => {
      const meta = ragResult.expedientes.get(c.sourceId);
      return {
        expedienteId: meta?.expedienteId ?? 0,
        numero: meta?.numero ?? '',
        similarity: c.score,
      };
    });

    // 5. Conversational context (recent messages)
    const contextMessages = await this.messageService.getRelevantContext(
      new Types.ObjectId(conversationId),
      text,
      userId,
      10,
    );

    // 6. Build messages for LLM
    const messages = this.buildMessagesWithContext(
      text,
      contextMessages,
      documentsContext,
    );

    if (stream) {
      const streamObservable = this.openRouterService.createChatCompletionStream(messages, {
        model,
        temperature,
        max_tokens: maxTokens,
      });

      return {
        stream: streamObservable,
        userMessageId: userMessage._id,
        conversationId,
        relevantDocuments,
      };
    } else {
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
          relevantDocuments,
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
    const filteredContext = contextMessages.filter(
      msg => msg.role !== MessageRole.USER || msg.text !== currentMessage
    );

    const reversedMessages = [...filteredContext].reverse();

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

    messages.push({
      role: 'system',
      content: this.systemPrompt
        .replace('{documents}', documentsContext)
        .replace('{current_date}', new Date().toLocaleDateString('es-AR')),
    });

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
    const trimmed = fullResponse.trim();
    if (!trimmed) {
      this.logger.warn('Received empty response from stream, skipping message save');
      return;
    }
    try {
      await this.messageService.createMessage(userId, {
        conversationId,
        text: trimmed,
        role: MessageRole.ASSISTANT,
        metadata: {
          streamed: true,
        },
      });
    } catch (error) {
      this.logger.error('Error saving streamed response:', error);
      throw error;
    }
  }
}