// src/chat/chat.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { Observable } from 'rxjs';
import { Readable } from 'stream';
import { OpenRouterService } from '../openrouter/openrouter.service';
import { ConversationService } from '../conversation/conversation.service';
import { MessageService } from '../message/message.service';
import { MessageRole } from '../message/schema/message.schema';
import { AgentService } from '../agent/agent.service';
import { RagService } from '../rag/rag.service';
import { PythonRagService, PythonRagSource } from '../rag/python-rag.service';

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
    private pythonRagService: PythonRagService,
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
5. Si no tienes información oficial, indícalo claramente — NUNCA inventes información
6. Mantén un tono profesional pero accesible
7. Cuando menciones proyectos, incluye su tipo, estado y autores si están disponibles
8. Proporciona TODA la información disponible — NUNCA truncar con "..." o "…"
9. Si el usuario pregunta sobre la conversación en sí, usa el historial de mensajes previos
10. NO incluyas referencias inline como [REF-1], [REF-2], (REF-1), (REF-2) en el texto — las fuentes se muestran automáticamente

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

    // ── Try Python RAG pipeline first (hybrid retrieval + generation) ──
    if (this.pythonRagService.isAvailable) {
      return this.sendMessageViaPythonRag(
        conversationId,
        userId,
        text,
        { model, temperature, maxTokens, stream },
      );
    }

    // ── Fallback: existing NestJS RAG pipeline ────────────────────────
    return this.sendMessageViaLegacyRag(
      conversationId,
      userId,
      text,
      { model, temperature, maxTokens, stream },
    );
  }

  /**
   * Python RAG pipeline: sends query to FastAPI microservice which handles
   * hybrid retrieval (dense + BM25 + HyDE + multi-query + RRF + reranking)
   * and LLM generation with streaming.
   */
  private async sendMessageViaPythonRag(
    conversationId: string,
    userId: Types.ObjectId,
    text: string,
    options: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
      stream?: boolean;
    },
  ) {
    const { stream = true } = options;

    // 1. Save user message
    const userMessage = await this.messageService.createMessage(userId, {
      conversationId,
      text,
      role: MessageRole.USER,
    });

    // 2. Get recent conversation history for context
    const contextMessages = await this.messageService.getRelevantContext(
      new Types.ObjectId(conversationId),
      text,
      userId,
      10,
    );

    // Build history in the format Python expects
    const conversationHistory = [...contextMessages]
      .reverse()
      .filter(msg => msg.role !== MessageRole.USER || msg.text !== text)
      .map(msg => ({
        role: msg.role === MessageRole.USER ? 'user' : 'assistant',
        text: msg.text,
      }));

    if (stream) {
      // 3a. Get SSE stream from Python RAG
      const pythonStream = await this.pythonRagService.queryStream(
        text,
        conversationHistory,
      );

      // Wrap the Readable stream into an Observable<string> that the
      // controller can subscribe to, same interface as OpenRouter stream
      const streamObservable = new Observable<string>((subscriber) => {
        let buffer = '';

        pythonStream.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            if (line.startsWith('data: ')) {
              const payload = line.slice(6).trim();
              try {
                const event = JSON.parse(payload);
                if (event.type === 'chunk' && event.content) {
                  subscriber.next(event.content);
                } else if (event.type === 'done') {
                  // Emit sources as a special JSON marker the controller can detect
                  if (event.sources && event.sources.length > 0) {
                    subscriber.next(
                      `\n\n<!--RAG_SOURCES:${JSON.stringify(event.sources)}-->`,
                    );
                  }
                  subscriber.complete();
                } else if (event.type === 'error') {
                  subscriber.error(new Error(event.message || 'Python RAG error'));
                }
              } catch {
                // Non-JSON line, skip
              }
            }
          }
        });

        pythonStream.on('error', (err) => subscriber.error(err));
        pythonStream.on('end', () => {
          // Process remaining buffer
          if (buffer.trim()) {
            const remaining = buffer.trim();
            if (remaining.startsWith('data: ')) {
              try {
                const event = JSON.parse(remaining.slice(6));
                if (event.type === 'chunk' && event.content) {
                  subscriber.next(event.content);
                }
                if (event.type === 'done' && event.sources?.length > 0) {
                  subscriber.next(
                    `\n\n<!--RAG_SOURCES:${JSON.stringify(event.sources)}-->`,
                  );
                }
              } catch { /* ignore */ }
            }
          }
          subscriber.complete();
        });
      });

      return {
        stream: streamObservable,
        userMessageId: userMessage._id,
        conversationId,
        relevantDocuments: [],
        pythonRag: true,
      };
    } else {
      // 3b. Non-streaming query
      const response = await this.pythonRagService.query(
        text,
        conversationHistory,
      );

      const assistantMessage = await this.messageService.createMessage(userId, {
        conversationId,
        text: response.answer,
        role: MessageRole.ASSISTANT,
        metadata: {
          streamed: false,
          pythonRag: true,
          sources: response.sources,
          cacheHit: response.cache_hit,
          retrievalCount: response.retrieval_count,
          elapsedMs: response.elapsed_ms,
        },
      });

      return {
        response: response.answer,
        message: assistantMessage,
        sources: response.sources,
        relevantDocuments: response.sources.map((s) => ({
          numero: s.numero,
          tipo: s.tipo,
          similarity: s.score,
        })),
      };
    }
  }

  /**
   * Legacy NestJS RAG pipeline (fallback when Python service is unavailable).
   */
  private async sendMessageViaLegacyRag(
    conversationId: string,
    userId: Types.ObjectId,
    text: string,
    options: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
      stream?: boolean;
    },
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