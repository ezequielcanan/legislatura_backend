// src/agent/agent.service.ts
import { Injectable, Logger } from '@nestjs/common';

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

// ─── Category / Tag keyword maps (zero-cost, no LLM) ────

const TAG_KEYWORDS: Record<string, string[]> = {
  educacion: ['educación', 'educacion', 'escuela', 'colegio', 'universidad', 'docente', 'alumno', 'estudiante', 'escolar', 'pedagog'],
  salud: ['salud', 'hospital', 'clínica', 'clinica', 'médic', 'medic', 'sanitar', 'vacuna', 'farmacia', 'enferm'],
  seguridad: ['seguridad', 'policía', 'policia', 'delito', 'crimen', 'vigilancia', 'penal', 'robo', 'inseguridad'],
  transporte: ['transporte', 'tránsito', 'transito', 'colectivo', 'subte', 'metrobús', 'metrobus', 'bicicleta', 'ciclovia', 'estacion'],
  vivienda: ['vivienda', 'viviendas', 'inmueble', 'alquiler', 'inquilino', 'habitat', 'urbanización', 'urbanizacion'],
  economia: ['economía', 'economia', 'impuesto', 'tributar', 'presupuesto', 'fiscal', 'financier', 'comercio', 'emprendedor'],
  cultura: ['cultura', 'cultural', 'museo', 'teatro', 'biblioteca', 'patrimonio', 'artíst', 'artist'],
  ambiente: ['ambiente', 'ambiental', 'ecolog', 'contaminación', 'contaminacion', 'residuo', 'basura', 'reciclaje', 'verde', 'arbol'],
  tecnologia: ['tecnología', 'tecnologia', 'digital', 'internet', 'software', 'sistema', 'datos', 'ciberseguridad'],
  trabajo: ['trabajo', 'empleo', 'laboral', 'trabajador', 'sindicato', 'gremio', 'sueldo', 'salar'],
  justicia: ['justicia', 'judicial', 'juicio', 'tribunal', 'penal', 'defensor', 'amparo'],
  derechos_humanos: ['derechos humanos', 'discriminación', 'discriminacion', 'igualdad', 'género', 'genero', 'diversidad', 'inclusión', 'inclusion'],
  presupuesto: ['presupuesto', 'gasto', 'partida', 'erogación', 'erogacion', 'hacienda'],
  gobierno: ['gobierno', 'administración', 'administracion', 'decreto', 'ejecutivo', 'ministerio'],
};

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  'Proyecto de Ley': ['ley', 'legislar', 'proyecto de ley', 'legislación', 'legislacion'],
  'Proyecto de Resolución': ['resolución', 'resolucion', 'proyecto de resolución'],
  'Proyecto de Declaración': ['declaración', 'declaracion', 'proyecto de declaración'],
  'Comunicación': ['comunicación', 'comunicacion'],
  'Pedido de informes': ['pedido de informe', 'solicitud de informe', 'requerir informe'],
};

const INTENT_PATTERNS: [RegExp, QueryClassification['intent']][] = [
  [/\b(legislador|diputad|senador)\b/i, 'legislador_info'],
  [/\b(bloque|partido|bancada|coalición|coalicion)\b/i, 'bloque_info'],
  [/\b(estadística|estadistica|cuánt|cuant|total|porcentaje|promedio|cifra)\b/i, 'stats'],
  [/\b(hola|buenos días|buenos dias|buenas tardes|buenas noches|saludos|gracias)\b/i, 'general_chat'],
];

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor() {}

  /**
   * Lightweight, zero-cost query classification using keyword matching.
   * No LLM call — runs in <1 ms.
   */
  classifyQuery(userQuery: string): QueryClassification {
    const q = userQuery.toLowerCase().trim();

    // Intent detection
    let intent: QueryClassification['intent'] = 'search_expedientes';
    for (const [pattern, detected] of INTENT_PATTERNS) {
      if (pattern.test(q)) {
        intent = detected;
        break;
      }
    }

    // Tag extraction
    const tags: string[] = [];
    for (const [tag, keywords] of Object.entries(TAG_KEYWORDS)) {
      for (const kw of keywords) {
        if (q.includes(kw)) {
          tags.push(tag);
          break;
        }
      }
    }

    // Category extraction
    const categories: string[] = [];
    for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      for (const kw of keywords) {
        if (q.includes(kw)) {
          categories.push(cat);
          break;
        }
      }
    }

    // Tipo detection
    let tipo: string | null = null;
    const tipoMatch = q.match(/proyecto de (ley|resolución|resolucion|declaración|declaracion|comunicación|comunicacion)/i);
    if (tipoMatch) {
      tipo = `Proyecto de ${tipoMatch[1].charAt(0).toUpperCase()}${tipoMatch[1].slice(1)}`;
    }

    // Legislador name extraction
    let legisladorName: string | null = null;
    const legMatch = q.match(/(?:legislador|diputad[oa]|senador[a]?)\s+([A-ZÁÉÍÓÚÑa-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑa-záéíóúñ]+){0,2})/i);
    if (legMatch) legisladorName = legMatch[1].trim();

    // Bloque name extraction
    let bloqueName: string | null = null;
    const bloqueMatch = q.match(/(?:bloque|partido)\s+(?:de\s+)?([A-ZÁÉÍÓÚÑa-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑa-záéíóúñ]+){0,3})/i);
    if (bloqueMatch) bloqueName = bloqueMatch[1].trim();

    return {
      tags,
      categories,
      tipo,
      legisladorName,
      bloqueName,
      dateRange: null,
      intent,
      refinedQuery: userQuery,
    };
  }
}
