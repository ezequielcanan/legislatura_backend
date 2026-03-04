// src/agent/agent.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { Types } from 'mongoose';
import { ChatOpenAI } from '@langchain/openai';
import { createAgent } from 'langchain';

export interface QueryClassification {
  tags: string[];
  categories: string[];
  tipo: string | null;
  legisladorName: string | null;
  bloqueName: string | null;
  dateRange: { from: string; to: string } | null;
  intent: 'search_expedientes' | 'legislador_info' | 'bloque_info' | 'general_chat' | 'stats';
  refinedQuery: string;
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor() { }

  /**
   * Classifies a user query to extract structured filters for intelligent RAG search.
   * Uses an LLM to analyze the question and return tags, categories, date ranges, etc.
   */
  async classifyQuery(userQuery: string): Promise<QueryClassification> {
    try {
      const llm = new ChatOpenAI({
        model: process.env.OPENROUTER_DEFAULT_MODEL ?? 'x-ai/grok-4.1-fast',
        streaming: false,
        apiKey: process.env.OPENROUTER_API_KEY,
        configuration: {
          baseURL: process.env.OPENROUTER_API_URL,
        },
        temperature: 0,
      });

      const now = new Date();
      const buenosAiresNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
      const todayStr = buenosAiresNow.toISOString().split('T')[0];

      const systemPrompt = `You are a query classifier for the Buenos Aires City Legislature system.
Given a user question in Spanish, extract structured metadata to optimize document search.

Current date: ${todayStr}

Return ONLY valid JSON with this exact structure:
{
  "tags": [],           // Relevant topic tags (e.g. "educacion", "transporte", "salud", "seguridad", "medio ambiente", "presupuesto", "vivienda")
  "categories": [],     // Document categories (e.g. "Ley", "Decreto", "Resolucion", "Declaracion", "Comunicacion", "Pedido de informes")
  "tipo": null,         // Exact expediente tipo if mentioned (e.g. "Proyecto de Ley", "Proyecto de Resolución")
  "legisladorName": null,  // Legislator name if mentioned
  "bloqueName": null,      // Political bloc name if mentioned
  "dateRange": null,       // { "from": "dd/mm/yyyy", "to": "dd/mm/yyyy" } if temporal reference detected
  "intent": "search_expedientes",  // One of: "search_expedientes", "legislador_info", "bloque_info", "general_chat", "stats"
  "refinedQuery": ""       // A refined version of the query optimized for semantic search
}

Rules:
- Extract tags from the topic/subject of the question
- If user mentions "this week", "today", "last month", calculate actual dates
- If user asks about a specific legislator, set intent to "legislador_info"
- If user asks about a bloc/party, set intent to "bloque_info"
- If user asks for statistics or numbers, set intent to "stats"
- If it's a general greeting or unrelated question, set intent to "general_chat"
- refinedQuery should be a clear, concise version of what the user wants to find`;

      const response = await llm.invoke([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userQuery },
      ]);

      const content = typeof response.content === 'string' ? response.content : '';

      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.logger.warn('Could not parse query classification, using defaults');
        return this.defaultClassification(userQuery);
      }

      const parsed = JSON.parse(jsonMatch[0]) as QueryClassification;
      this.logger.debug(`Query classified: intent=${parsed.intent}, tags=${parsed.tags.join(',')}`);
      this.logger.debug(parsed)
      return parsed;
    } catch (error) {
      this.logger.error('Query classification failed:', error);
      return this.defaultClassification(userQuery);
    }
  }

  private defaultClassification(query: string): QueryClassification {
    return {
      tags: [],
      categories: [],
      tipo: null,
      legisladorName: null,
      bloqueName: null,
      dateRange: null,
      intent: 'search_expedientes',
      refinedQuery: query,
    };
  }
}
