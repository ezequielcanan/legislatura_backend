// openrouter/openrouter.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { AxiosRequestConfig } from 'axios';
import { firstValueFrom, Observable } from 'rxjs';
import { Readable } from 'stream';
import sharp from 'sharp';

export interface OpenRouterResponse {
  id?: string;
  model?: string;
  created?: number;
  // la estructura real puede variar; tratamos el JSON de forma genérica
  [k: string]: any;
}

export interface ChatCompletionRequest {
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  [key: string]: any;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message?: { role: string; content: string };
    delta?: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

@Injectable()
export class OpenRouterService {
  private readonly logger = new Logger(OpenRouterService.name);
  private readonly apiKey: string | undefined;
  private readonly baseApiUrl: string;
  private readonly defaultImageModel: string;
  private readonly defaultModel: string;

  constructor(
    private configService: ConfigService,
    private httpService: HttpService,
  ) {
    this.apiKey = this.configService.get<string>('OPENROUTER_API_KEY');
    if (!this.apiKey) {
      this.logger.error('OPENROUTER_API_KEY no está configurada');
      throw new Error('OPENROUTER_API_KEY missing');
    }

    // NOTA: baseApiUrl debe ser la raíz /api/v1 para componer endpoints correctamente
    this.baseApiUrl = this.configService.get<string>('OPENROUTER_API_URL', 'https://openrouter.ai/api/v1');
    this.defaultImageModel = this.configService.get<string>('OPENROUTER_DEFAULT_IMAGE_MODEL', 'black-forest-labs/flux-schnell');
    this.defaultModel = this.configService.get<string>('OPENROUTER_DEFAULT_MODEL', 'black-forest-labs/flux-schnell');
  }


  async createChatCompletion(
    messages: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string;
    }>,
    options: {
      model?: string;
      temperature?: number;
      max_tokens?: number;
      stream?: false;
    } = {},
  ): Promise<ChatCompletionResponse> {
    const url = `${this.baseApiUrl}/chat/completions`;
    const model = options.model || this.defaultModel;

    const payload: ChatCompletionRequest = {
      model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.max_tokens ?? 1000,
      stream: false,
    };

    const config: AxiosRequestConfig = {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': this.configService.get<string>('APP_URL', 'http://localhost:3000'),
        'X-Title': this.configService.get<string>('APP_NAME', 'AI Assistant'),
      },
      timeout: 30000,
    };

    try {
      const res = await firstValueFrom(
        this.httpService.post<ChatCompletionResponse>(url, payload, config),
      );
      return res.data;
    } catch (error: any) {
      this.logger.error('OpenRouter API error:', error.response?.data || error.message);
      throw new Error(`OpenRouter API error: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  createChatCompletionStream(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options: {
      model?: string;
      temperature?: number;
      max_tokens?: number;
    } = {},
  ): Observable<string> {
    const url = `${this.baseApiUrl}/chat/completions`;
    const model = options.model || this.defaultModel;

    const payload: ChatCompletionRequest = {
      model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.max_tokens ?? 1000,
      stream: true,
    };

    const config: AxiosRequestConfig = {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': this.configService.get<string>('APP_URL', 'http://localhost:3000'),
        'X-Title': this.configService.get<string>('APP_NAME', 'AI Assistant'),
      },
      responseType: 'stream',
      timeout: 60000,
    };

    return new Observable<string>((subscriber) => {
      let buffer = '';

      this.httpService.post(url, payload, config).subscribe({
        next: (response) => {
          const stream = response.data as Readable;

          stream.on('data', (chunk: Buffer) => {
            // Acumulamos el buffer
            buffer += chunk.toString();

            // Procesamos líneas completas
            const lines = buffer.split('\n');

            // Mantenemos la última línea incompleta en el buffer
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.trim()) continue;

              if (line.startsWith('data: ')) {
                const data = line.slice(6);

                if (data === '[DONE]') {
                  subscriber.complete();
                  return;
                }

                try {
                  const parsed = JSON.parse(data);
                  if (parsed.choices?.[0]?.delta?.content) {
                    subscriber.next(parsed.choices[0].delta.content);
                  }
                  if (parsed.choices?.[0]?.finish_reason) {
                    subscriber.next(`\n[FINISH_REASON:${parsed.choices[0].finish_reason}]`);
                  }
                } catch (error) {
                  this.logger.warn('Failed to parse stream data:', error);
                  this.logger.debug('Problematic data:', data);
                }
              }
            }
          });

          stream.on('error', (error) => {
            this.logger.error('Stream error:', error);
            subscriber.error(error);
          });

          stream.on('end', () => {
            // Procesar cualquier dato restante en el buffer
            if (buffer.trim()) {
              try {
                const line = buffer.trim();
                if (line.startsWith('data: ')) {
                  const data = line.slice(6);
                  if (data !== '[DONE]') {
                    const parsed = JSON.parse(data);
                    if (parsed.choices?.[0]?.delta?.content) {
                      subscriber.next(parsed.choices[0].delta.content);
                    }
                  }
                }
              } catch (error) {
                this.logger.warn('Failed to parse final buffer data:', error);
              }
            }
            subscriber.complete();
          });
        },
        error: (error) => {
          this.logger.error('HTTP request error:', error.response?.data || error.message);
          subscriber.error(error);
        },
      });
    });
  }

  // TODO: Implementar generación de embeddings cuando OpenRouter lo soporte
  // Por ahora podemos usar otro servicio para embeddings
  async generateEmbedding(
    text: string | string[],
    model: string = 'text-embedding-3-small',
  ): Promise<number[]> {
    const url = `${this.baseApiUrl}/embeddings`;
    const inputs = Array.isArray(text) ? text : [text];

    const payload = {
      model,
      input: inputs,
    };

    const config: AxiosRequestConfig = {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': this.configService.get<string>('APP_URL', 'http://localhost:3000'),
        'X-Title': this.configService.get<string>('APP_NAME', 'AI Assistant'),
      },
      timeout: 30000,
    };

    try {
      // Llamada a OpenRouter
      const res = await firstValueFrom(this.httpService.post(url, payload, config));
      const body = res.data;

      // Validaciones básicas del response (OpenRouter es compatible con esquema OpenAI)
      if (!body) {
        this.logger.error('OpenRouter embeddings: respuesta vacía');
        throw new Error('OpenRouter embeddings: empty response');
      }

      if (!Array.isArray(body.data) || body.data.length === 0) {
        this.logger.error('OpenRouter embeddings: no se recibieron embeddings', JSON.stringify(body).slice(0, 1000));
        throw new Error('OpenRouter returned no embeddings');
      }

      // Si pedimos embeddings para varios inputs, devolvemos el primero (ajusta si quieres devolver todos)
      const firstEntry = body.data[0];
      const embedding: unknown = firstEntry?.embedding ?? firstEntry?.vector ?? null;

      if (!Array.isArray(embedding)) {
        this.logger.error('OpenRouter embeddings: formato inesperado', JSON.stringify(firstEntry).slice(0, 1000));
        throw new Error('Unexpected embeddings format from OpenRouter');
      }

      // Asegurar que los elementos sean números
      const vector = (embedding as any[]).map((v) => {
        const n = Number(v);
        if (Number.isNaN(n)) {
          // Si encontramos algo raro, logueamos y lanzamos
          this.logger.error('OpenRouter embeddings: valor no numérico en embedding', v);
          throw new Error('Non-numeric value in embedding vector');
        }
        return n;
      });

      return vector;
    } catch (err: any) {
      const status = err?.response?.status;
      const respData = err?.response?.data;
      const msg = err?.message ?? String(err);

      this.logger.error('OpenRouter embeddings error:', { status, respData, msg });

      // Mensajes de error amigables para debugging
      if (status === 401 || status === 403) {
        throw new Error(`OpenRouter authentication error (${status}). Revisa OPENROUTER_API_KEY.`);
      }
      if (status === 404) {
        throw new Error(`OpenRouter embeddings endpoint not found (404). Verifica OPENROUTER_API_URL y el endpoint /embeddings.`);
      }
      // Fallback
      throw new Error(`OpenRouter embeddings failed: ${respData?.error?.message ?? msg}`);
    }
  }


  async getModels(): Promise<any[]> {
    const url = `${this.baseApiUrl}/models`;
    try {
      const res = await firstValueFrom(this.httpService.get(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      }));
      return res.data;
    } catch (err: any) {
      this.logger.error('Failed to fetch OpenRouter models:', err?.response?.data ?? err?.message ?? err);
      return [];
    }
  }
}
