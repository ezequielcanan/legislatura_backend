// src/agent/types/index.ts
import { z } from 'zod';

// ============================================================================
// Report Types
// ============================================================================

export const ReportSectionSchema = z.object({
  title: z.string().describe('Título de la sección'),
  content: z.string().describe('Contenido detallado en Markdown'),
  sources: z.array(z.string()).optional().describe('URLs de fuentes utilizadas'),
});

export const ReportOutlineSchema = z.object({
  title: z.string().describe('Título del informe'),
  summary: z.string().describe('Resumen ejecutivo (2-3 oraciones)'),
  sections: z.array(z.object({
    title: z.string(),
    description: z.string(),
    keywords: z.array(z.string()),
  })).describe('Secciones planificadas del informe'),
  category: z.string().describe('Categoría: Política, Economía, Social, etc.'),
  estimatedPages: z.number().describe('Estimación de páginas del informe final'),
});

export const ReportEvaluationSchema = z.object({
  quality: z.number().min(1).max(10).describe('Calidad general del informe'),
  completeness: z.number().min(1).max(10).describe('Completitud de la información'),
  accuracy: z.number().min(1).max(10).describe('Precisión de datos y fuentes'),
  readability: z.number().min(1).max(10).describe('Legibilidad y claridad'),
  suggestions: z.array(z.string()).describe('Sugerencias de mejora'),
  approved: z.boolean().describe('¿Aprobar el informe?'),
});

export const FinalReportSchema = z.object({
  title: z.string(),
  summary: z.string(),
  content: z.string().describe('Contenido completo en Markdown'),
  category: z.string(),
  sections: z.array(z.object({
    title: z.string(),
    content: z.string(),
  })),
  metadata: z.object({
    readTime: z.string(),
    pages: z.number(),
    sources: z.array(z.string()),
    generatedAt: z.string(),
  }),
});

// ============================================================================
// Survey Types
// ============================================================================

export const SurveyQuestionSchema = z.object({
  id: z.string(),
  question: z.string().describe('Texto de la pregunta'),
  type: z.enum(['single', 'multiple', 'scale', 'open']).describe('Tipo de pregunta'),
  options: z.array(z.string()).optional().describe('Opciones de respuesta'),
  scaleRange: z.object({ min: z.number(), max: z.number() }).optional(),
});

export const SurveyOutlineSchema = z.object({
  title: z.string().describe('Título de la encuesta'),
  description: z.string().describe('Descripción y objetivos'),
  category: z.string(),
  sections: z.array(z.object({
    title: z.string(),
    description: z.string(),
    questionCount: z.number(),
  })),
  estimatedParticipants: z.number().describe('Participantes simulados para análisis'),
});

export const SentimentDataSchema = z.object({
  platform: z.string().describe('Red social o fuente'),
  totalMentions: z.number(),
  sentimentBreakdown: z.object({
    positive: z.number(),
    neutral: z.number(),
    negative: z.number(),
  }),
  topKeywords: z.array(z.string()),
  sampleTexts: z.array(z.string()),
});

export const SurveyResultSchema = z.object({
  questionId: z.string(),
  question: z.string(),
  responses: z.array(z.object({
    option: z.string(),
    percentage: z.number(),
    count: z.number(),
  })),
  confidenceInterval: z.number().describe('Intervalo de confianza del resultado'),
});

export const FinalSurveySchema = z.object({
  title: z.string(),
  description: z.string(),
  category: z.string(),
  methodology: z.string().describe('Descripción de la metodología de análisis'),
  questions: z.array(SurveyQuestionSchema),
  results: z.array(SurveyResultSchema),
  metadata: z.object({
    participants: z.number(),
    confidenceLevel: z.number(),
    marginOfError: z.number(),
    dataCollectionPeriod: z.string(),
    sources: z.array(z.string()),
    generatedAt: z.string(),
  }),
});

// ============================================================================
// Graph State Types
// ============================================================================

export interface ReportGraphState {
  messages: Array<{ role: string; content: string }>;
  userRequest: string;
  outline?: z.infer<typeof ReportOutlineSchema>;
  researchData?: Array<{
    section: string;
    data: string[];
    sources: string[];
  }>;
  sections?: Array<z.infer<typeof ReportSectionSchema>>;
  evaluation?: z.infer<typeof ReportEvaluationSchema>;
  finalReport?: z.infer<typeof FinalReportSchema>;
  iterationCount: number;
  docxBuffer?: Buffer;
  error?: string;
}

export interface SurveyGraphState {
  messages: Array<{ role: string; content: string }>;
  userRequest: string;
  outline?: z.infer<typeof SurveyOutlineSchema>;
  questions?: Array<z.infer<typeof SurveyQuestionSchema>>;
  sentimentData?: Array<z.infer<typeof SentimentDataSchema>>;
  results?: Array<z.infer<typeof SurveyResultSchema>>;
  evaluation?: {
    quality: number;
    suggestions: string[];
    approved: boolean;
  };
  finalSurvey?: z.infer<typeof FinalSurveySchema>;
  iterationCount: number;
  error?: string;
}

// ============================================================================
// Exports
// ============================================================================

export type ReportOutline = z.infer<typeof ReportOutlineSchema>;
export type ReportSection = z.infer<typeof ReportSectionSchema>;
export type ReportEvaluation = z.infer<typeof ReportEvaluationSchema>;
export type FinalReport = z.infer<typeof FinalReportSchema>;

export type SurveyOutline = z.infer<typeof SurveyOutlineSchema>;
export type SurveyQuestion = z.infer<typeof SurveyQuestionSchema>;
export type SentimentData = z.infer<typeof SentimentDataSchema>;
export type SurveyResult = z.infer<typeof SurveyResultSchema>;
export type FinalSurvey = z.infer<typeof FinalSurveySchema>;