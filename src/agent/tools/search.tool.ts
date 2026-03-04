// src/agent/tools/search.tool.ts
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import axios from 'axios';

const SearchInputSchema = z.object({
  query: z.string().describe('Consulta de búsqueda'),
  maxResults: z.number().optional().default(10).describe('Número máximo de resultados (máximo 10)'),
  region: z.string().optional().default('ar').describe('Código de país (ar, us, es, etc.)'),
});

interface SerperSearchResult {
  title: string;
  link: string;
  snippet?: string;
  date?: string;
  position?: number;
}

interface SerperResponse {
  organic?: SerperSearchResult[];
  answerBox?: {
    snippet?: string;
    snippetHighlighted?: string[];
  };
  knowledgeGraph?: {
    title?: string;
    description?: string;
  };
  searchInformation?: {
    totalResults?: string;
    timeTaken?: number;
  };
  error?: string;
}

export const createSearchTool = () => {
  return new DynamicStructuredTool({
    name: 'web_search',
    description:
      'Busca información actualizada en internet usando Serper API (Google Search). Útil para investigar temas políticos, económicos y sociales con fuentes verificables.',
    schema: SearchInputSchema,
    func: async ({ query, maxResults, region }) => {
      try {
        // Verificar variable de entorno
        const apiKey = process.env.SERPER_API_KEY;

        if (!apiKey) {
          return JSON.stringify({
            error: 'Falta configurar SERPER_API_KEY en variables de entorno. Obtén tu API key en https://serper.dev',
            query,
            results: [],
          });
        }

        // Limitar resultados (Serper permite hasta 100, pero optimizamos)
        const numResults = Math.min(maxResults ?? 10, 10);

        // Llamada a Serper API
        const response = await axios.post<SerperResponse>(
          'https://google.serper.dev/search',
          {
            q: query,
            num: numResults,
            gl: region, // Geolocation (país)
            hl: 'es', // Idioma de interfaz
            autocorrect: true, // Corrección automática de ortografía
            page: 1, // Primera página de resultados
          },
          {
            headers: {
              'X-API-KEY': apiKey,
              'Content-Type': 'application/json',
            },
            timeout: 15000,
          }
        );

        // Manejo de errores de la API
        if (response.data.error) {
          return JSON.stringify({
            error: `Error de Serper API: ${response.data.error}`,
            query,
            results: [],
          });
        }

        const organicResults = response.data.organic || [];

        if (organicResults.length === 0) {
          return JSON.stringify({
            error: 'No se encontraron resultados',
            query,
            totalResults: '0',
            results: [],
          });
        }

        // Formatear resultados con URLs garantizadas
        const results = organicResults.map((item) => ({
          title: item.title || 'Sin título',
          snippet: item.snippet || '',
          url: item.link || '', // ✅ Campo URL explícito
          date: item.date || '',
          position: item.position || 0,
        }));

        // ✅ Log para debugging (eliminar en producción)
        console.log(`🔍 [Serper] Query: "${query}" | Resultados: ${results.length}`);

        return JSON.stringify({
          query,
          results,
          count: results.length,
          totalResults: response.data.searchInformation?.totalResults || '0',
          timeTaken: response.data.searchInformation?.timeTaken || 0,
          source: 'Serper API (Google Search)',
          // Información adicional útil
          answerBox: response.data.answerBox?.snippet || null,
          knowledgeGraph: response.data.knowledgeGraph?.description || null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        // Manejo específico de errores comunes
        if (axios.isAxiosError(err)) {
          if (err.response?.status === 429) {
            return JSON.stringify({
              error: 'Límite de cuota de API excedido. Verifica tu plan en https://serper.dev/dashboard',
              query,
              results: [],
            });
          }
          if (err.response?.status === 401 || err.response?.status === 403) {
            return JSON.stringify({
              error: 'API Key inválida o expirada. Verifica tu configuración en https://serper.dev/api-key',
              query,
              results: [],
            });
          }
          if (err.response?.status === 500) {
            return JSON.stringify({
              error: 'Error interno del servidor de Serper. Intenta nuevamente en unos minutos.',
              query,
              results: [],
            });
          }
        }

        return JSON.stringify({
          error: `Error en búsqueda: ${message}`,
          query,
          results: [],
        });
      }
    },
  });
};