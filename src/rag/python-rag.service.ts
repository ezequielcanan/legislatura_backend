// src/rag/python-rag.service.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Readable } from 'stream';

export interface PythonRagSource {
  ref: string;
  numero: string;
  tipo: string;
  preview: string;
  score: number;
}

export interface PythonRagResponse {
  answer: string;
  sources: PythonRagSource[];
  context_count: number;
  retrieval_count: number;
  elapsed_ms: number;
  cache_hit: boolean;
}

export interface ConversationMessage {
  role: string;
  text: string;
}

export interface PythonRagStreamEvent {
  type: 'chunk' | 'done' | 'error';
  content?: string;
  sources?: PythonRagSource[];
  message?: string;
  cache_hit?: boolean;
  retrieval_count?: number;
  elapsed_ms?: number;
}

@Injectable()
export class PythonRagService implements OnModuleInit {
  private readonly logger = new Logger(PythonRagService.name);
  private readonly baseUrl: string;
  private healthy = false;

  constructor(
    private configService: ConfigService,
    private httpService: HttpService,
  ) {
    this.baseUrl = this.configService.get<string>(
      'PYTHON_RAG_URL',
      'http://localhost:8100',
    );
  }

  async onModuleInit() {
    await this.checkHealth();
  }

  async checkHealth(): Promise<boolean> {
    try {
      const res = await firstValueFrom(
        this.httpService.get(`${this.baseUrl}/health`, { timeout: 5000 }),
      );
      this.healthy = res.data?.status === 'ok';
      if (this.healthy) {
        this.logger.log('Python RAG service is healthy');
      }
      return this.healthy;
    } catch {
      this.healthy = false;
      this.logger.warn(
        `Python RAG service not reachable at ${this.baseUrl}. ` +
        'Falling back to NestJS RAG pipeline.',
      );
      return false;
    }
  }

  get isAvailable(): boolean {
    return this.healthy;
  }

  /**
   * Full RAG query (non-streaming): retrieval + generation.
   */
  async query(
    queryText: string,
    conversationHistory: ConversationMessage[] = [],
    options: {
      topK?: number;
      enableHyde?: boolean;
      enableBm25?: boolean;
      enableRerank?: boolean;
      enableMultiQuery?: boolean;
      enableMmr?: boolean;
      enableParentRetrieval?: boolean;
      enableCache?: boolean;
    } = {},
  ): Promise<PythonRagResponse> {
    const payload = {
      query: queryText,
      conversation_history: conversationHistory,
      top_k: options.topK ?? 20,
      enable_hyde: options.enableHyde ?? true,
      enable_bm25: options.enableBm25 ?? true,
      enable_rerank: options.enableRerank ?? true,
      enable_multi_query: options.enableMultiQuery ?? true,
      enable_mmr: options.enableMmr ?? true,
      enable_parent_retrieval: options.enableParentRetrieval ?? true,
      enable_cache: options.enableCache ?? true,
    };

    const res = await firstValueFrom(
      this.httpService.post<PythonRagResponse>(
        `${this.baseUrl}/rag/query`,
        payload,
        { timeout: 120_000 },
      ),
    );

    return res.data;
  }

  /**
   * Streaming RAG query: returns a Readable stream of SSE events from Python.
   * Each event is a PythonRagStreamEvent.
   */
  async queryStream(
    queryText: string,
    conversationHistory: ConversationMessage[] = [],
    options: {
      topK?: number;
      enableHyde?: boolean;
      enableBm25?: boolean;
      enableRerank?: boolean;
      enableMultiQuery?: boolean;
      enableMmr?: boolean;
      enableParentRetrieval?: boolean;
      enableCache?: boolean;
    } = {},
  ): Promise<Readable> {
    const payload = {
      query: queryText,
      conversation_history: conversationHistory,
      top_k: options.topK ?? 20,
      enable_hyde: options.enableHyde ?? true,
      enable_bm25: options.enableBm25 ?? true,
      enable_rerank: options.enableRerank ?? true,
      enable_multi_query: options.enableMultiQuery ?? true,
      enable_mmr: options.enableMmr ?? true,
      enable_parent_retrieval: options.enableParentRetrieval ?? true,
      enable_cache: options.enableCache ?? false,
    };

    const res = await firstValueFrom(
      this.httpService.post(`${this.baseUrl}/rag/query/stream`, payload, {
        responseType: 'stream',
        timeout: 120_000,
      }),
    );

    return res.data as Readable;
  }

  /**
   * Index a single expediente into Qdrant + BM25 via the Python RAG service.
   * Called from processExpediente() after AI summarization.
   */
  async indexExpediente(data: {
    expedienteId: number;
    numero: string;
    tipo?: string;
    titulo?: string;
    sumario?: string;
    aiSummary?: string;
    aiTags?: string[];
    aiCategory?: string;
    fechaIngreso?: string;
    pdfText?: string;
    baeSource?: boolean;
    autor?: { legisladorId: number; nombre: string; apellido: string } | null;
  }): Promise<{ indexed: number; elapsed_ms: number }> {
    const res = await firstValueFrom(
      this.httpService.post<{ indexed: number; elapsed_ms: number }>(
        `${this.baseUrl}/rag/index`,
        data,
        { timeout: 300_000 },
      ),
    );
    return res.data;
  }
}
