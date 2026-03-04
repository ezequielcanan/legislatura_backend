// src/agent/graphs/report-graph.ts
import { StateGraph, END, START } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { createAllTools } from '../tools';
import { createLLM, createReasoningLLM, getCurrentTimestamp } from './shared/nodes';
import {
  ReportGraphState,
  ReportOutlineSchema,
  ReportSectionSchema,
  ReportEvaluationSchema,
  FinalReportSchema,
} from '../types';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { buildPdfFromReport } from '../utils/docx';

// Configuración general
const MAX_ITERATIONS = 2; // Permitimos algunas iteraciones de mejora
const REFERENCE_REPORT_EXCERPT = `
[INICIO REPORTE REFERENCIA - SOLO COPIAR ESTILO, NO EL CONTENIDO]
Acuerdo entre la UE y el MERCOSUR de cooperación interregional

I.Antecedentes históricos:
El diálogo oficial se formalizó en la Cumbre de Madrid... [Narrativa fluida, párrafos de 4-6 líneas].

II.Marco político y comercial:
El nuevo Acuerdo representa una asociación estratégica... [Uso de citas integradas: "Según el Consejo..."].
• Diálogo político: En un contexto internacional... [Subsecciones con viñetas descriptivas, no listas secas].
• Comercio de bienes: Se eliminarán aranceles a más del 90%... [Datos integrados en el texto: "aranceles del 35% desaparecen"].

IV. Implicancias para la República Argentina:
Para la Argentina, representa una oportunidad... [Enfoque estratégico nacional].
Bajo el escenario contemplado, la producción podría alcanzar 184,2 millones de toneladas... [Datos cuantitativos específicos soportando la narrativa].

V. Estado actual:
Tras semanas de intenso trámite político... [Análisis de coyuntura política y fechas].
[FIN REPORTE REFERENCIA]
`;

// ============================================================================
// Nodos del Grafo
// ============================================================================

/**
 * Nodo 1: Planificador - Crea el outline del informe
 */
async function plannerNode(state: ReportGraphState): Promise<Partial<ReportGraphState>> {
  console.log('📋 [Planner] Creando outline del informe...');

  const llm = createReasoningLLM().withStructuredOutput(ReportOutlineSchema);

  const systemPrompt = `Eres un arquitecto de informes de inteligencia profesional. Tu objetivo es estructurar un reporte sobre CUALQUIER TEMA que el usuario pida, pero siguiendo estrictamente el formato de un reporte de referencia de alta calidad.

**CONTEXTO:**
Fecha actual: ${new Date().toLocaleDateString('es-AR', {
    dateStyle: 'full',
    timeZone: 'America/Argentina/Buenos_Aires'
  })}

**INSTRUCCIONES CLAVE SOBRE LA ESTRUCTURA:**
1. **Prioridad del Usuario:** Si el usuario ("input") define explícitamente qué secciones quiere, ÚSALAS. Solo ajusta sus títulos para que suenen profesionales si es necesario.
2. **Generación Automática:** Si el usuario solo da un tema general, genera tú la estructura lógica ideal (Antecedentes, Situación Actual, Impacto, Conclusiones).
3. **Estilo de Títulos:** Usa numeración romana (I, II, III). Los títulos deben ser sobrios y descriptivos.

**FORMATO DE REFERENCIA (ESTILO A IMITAR):**
Observa este ejemplo de estructura (NO COPIES EL TEMA, SOLO LA FORMA):
- I. Antecedentes históricos
- II. Marco político/teórico
- III. Principales elementos/Análisis central
- IV. Implicancias para [Actor Principal/Argentina]
- V. Conclusiones o Estado actual

**TU TAREA:**
Genera un JSON con el título, categoría y la lista de secciones.
- Cada sección debe tener una descripción de qué investigar (keywords).
- Longitud estimada total: 5-12 páginas.
`;

  const outline = await llm.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(`Solicitud del usuario: "${state.userRequest}"
    
    Define la estructura del reporte. Si la solicitud mencionaba secciones específicas, inclúyelas obligatoriamente.`),
  ]);

  return {
    outline,
    messages: [
      ...state.messages,
      {
        role: 'assistant',
        content: `✅ Outline creado: "${outline.title}" con ${outline.sections.length} secciones.`,
      },
    ],
  };
}

/**
 * Nodo 2: Investigador - Busca información para cada sección
 */
async function researcherNode(state: ReportGraphState): Promise<Partial<ReportGraphState>> {
  console.log('🔍 [Researcher] Investigando información...');

  const llm = createLLM();
  const tools = createAllTools();
  const llmWithTools = llm.bindTools(tools);

  const researchData: Array<{ section: string; data: string[]; sources: string[] }> = [];

  for (const section of state.outline!.sections) {
    console.log(`  📚 Investigando: ${section.title}`);

    // Crear queries de búsqueda basadas en la descripción de la sección y el tema general
    const searchQueries = section.keywords.slice(0, 3).map(kw => 
      `${kw} ${state.outline?.title} contexto actual datos`
    );

    const sectionData: string[] = [];
    const sources: string[] = [];

    // Prompt dinámico para búsqueda
    const searchPrompt = `**INVESTIGADOR DE INTELEGEENCIA**
    
    **OBJETIVO:** Encontrar datos duros, fechas, nombres y cifras para la sección: "${section.title}" del reporte sobre "${state.outline?.title}".
    
    **Queries a ejecutar:** ${searchQueries.join(', ')}

    **CRITERIOS:**
    1. Prioriza fuentes oficiales, think tanks reconocidos y prensa seria.
    2. Busca información RECIENTE (últimos 2 años a menos que sean antecedentes históricos).
    3. Si el tema es sobre Argentina, prioriza fuentes locales (.gob.ar, medios nacionales).
    4. Si es internacional, fuentes de organismos globales (ONU, FMI, UE).
    
    Usa la herramienta de búsqueda para obtener contexto real.
    `;

    try {
        const response = await llmWithTools.invoke([
          new SystemMessage('Eres un investigador experto. Usa las herramientas disponibles para buscar información precisa.'),
          new HumanMessage(searchPrompt),
        ]);

        // Procesar tool calls si existen
        if (response.tool_calls && response.tool_calls.length > 0) {
          for (const toolCall of response.tool_calls) {
            const tool = tools.find(t => t.name === toolCall.name);
            if (tool) {
              const result = await (tool as any).invoke(toolCall.args);
              // Parsear resultados simples simulados para este ejemplo
              // En producción aquí iría el parseo real del JSON de la tool
              try {
                  const parsed = typeof result === 'string' ? JSON.parse(result) : result;
                  if (parsed.results) {
                      parsed.results.forEach((r: any) => {
                          sectionData.push(`${r.title}: ${r.snippet}`);
                          if(r.url) sources.push(r.url);
                      });
                  } else {
                       sectionData.push(String(result).slice(0, 500));
                  }
              } catch (e) {
                  sectionData.push(String(result).slice(0, 500));
              }
            }
          }
        }
      } catch (error) {
        console.error(`Error investigando sección ${section.title}:`, error);
      }

    researchData.push({
      section: section.title,
      data: sectionData.length > 0 ? sectionData : ["No se encontraron datos específicos, redactar con conocimiento general."],
      sources: [...new Set(sources)],
    });
  }

  return {
    researchData,
    messages: [
      ...state.messages,
      {
        role: 'assistant',
        content: `✅ Investigación completada para ${state.outline?.sections.length} secciones.`,
      },
    ],
  };
}

/**
 * Nodo 3: Escritor - Genera el contenido de cada sección
 */
async function writerNode(state: ReportGraphState): Promise<Partial<ReportGraphState>> {
  console.log('✍️ [Writer] Escribiendo secciones del informe...');

  const llm = createLLM().withStructuredOutput(ReportSectionSchema);
  const sections: any[] = [];

  for (let i = 0; i < state.outline!.sections.length; i++) {
    const sectionPlan = state.outline!.sections[i];
    const research = state.researchData![i];

    console.log(`  ✏️ Escribiendo: ${sectionPlan.title}`);

    const systemPrompt = `Eres un redactor de informes de élite. Tu tarea es escribir una sección de un reporte sobre "${state.outline?.title}".
    
    IMPORTANTE: DEBES USAR EL "REPORTE DE REFERENCIA" **SOLO PARA COPIAR EL ESTILO, FORMATO Y TONO**, PERO EL CONTENIDO DEBE SER SOBRE EL TEMA DE MI REPORTE.

    ---
    **ESTILO A IMITAR (REFERENCE STYLE):**
    ${REFERENCE_REPORT_EXCERPT}

    **CARACTERÍSTICAS DEL ESTILO OBLIGATORIO:**
    1. **Narrativa Fluida:** No uses listas interminables ("bullet points") a menos que sean subsecciones explicadas detalladamente. Prefiere párrafos sólidos.
    2. **Densidad de Datos:** Integra los números en el texto ("...representando un aumento del 20% respecto a...", en lugar de una lista "Aumento: 20%").
    3. **Tono:** Profesional, analítico, objetivo, diplomático. Ni muy académico ni muy coloquial.
    4. **Formato:** Usa Markdown. Negritas solo para conceptos clave. 
    5. **Subtítulos:** Si es necesario dividir, usa viñeta grande (•) con título en negrita al inicio del párrafo, igual que el modelo.

    ---
    **CONTENIDO A ESCRIBIR (TU FUENTE DE VERDAD):**
    
    TEMA DE LA SECCIÓN: ${sectionPlan.title}
    DESCRIPCIÓN: ${sectionPlan.description}
    
    DATOS INVESTIGADOS (Usa estos datos para armar el texto):
    ${research.data.slice(0, 15).join('\n')}

    ---
    **INSTRUCCIÓN:**
    Escribe la sección. Longitud aproximada: 300-600 palabras. Que parezca escrita por el mismo autor del reporte de la UE-Mercosur, pero hablando de ${state.outline?.title}.`;

    const section = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(`Escribe la sección "${sectionPlan.title}" ahora.`),
    ]);

    sections.push(section as any);
  }

  return {
    sections,
    messages: [
      ...state.messages,
      {
        role: 'assistant',
        content: `✅ ${sections.length} secciones escritas imitando el estilo de referencia.`,
      },
    ],
  };
}

/**
 * Nodo 4: Evaluador - Revisa calidad del informe
 */
async function evaluatorNode(state: ReportGraphState): Promise<Partial<ReportGraphState>> {
  console.log('🔎 [Evaluator] Evaluando calidad del informe...');

  const llm = createReasoningLLM().withStructuredOutput(ReportEvaluationSchema);

  // Unimos el contenido para que el evaluador vea el flujo
  const contentPreview = state.sections!.map(s => `## ${s.title}\n${s.content.substring(0, 500)}...`).join('\n\n');

  const systemPrompt = `Eres un editor jefe exigente. Estás revisando un borrador de reporte sobre "${state.outline?.title}".

  **TU ESTÁNDAR DE COMPARACIÓN (GOLD STANDARD):**
  El reporte debe sentirse idéntico en estilo al "Acuerdo UE-Mercosur" (formal, denso, analítico), sin importar de qué tema trate.

  **CRITERIOS DE EVALUACIÓN:**
  1. **Estilo (Quality):** ¿El tono es profesional? ¿Evita sonar como un blog o Wikipedia? ¿Integra datos en la narrativa en lugar de hacer listas?
  2. **Estructura:** ¿Respeta la numeración romana y el formato de subsecciones con viñetas descriptivas?
  3. **Contenido:** ¿Responde a lo que pide el título de la sección y del reporte? (No evalúes la veracidad estricta, sino la coherencia interna y uso de los datos provistos).

  **DECISIÓN:**
  - Aprueba (true) si es un informe sólido y profesional.
  - Rechaza (false) si es muy breve, informal, usa demasiadas listas ("bullets") sin explicación, o se desvía del tema.

  Si rechazas, da sugerencias concretas de estilo o profundidad.`;

  const evaluation = await llm.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(`Evalúa este borrador:\n\n${contentPreview}`),
  ]);

  return {
    evaluation,
    messages: [
      ...state.messages,
      {
        role: 'assistant',
        content: `✅ Evaluación: ${evaluation.approved ? 'APROBADO' : 'REVISIÓN REQUERIDA'} (Score: ${evaluation.quality}/10)`,
      },
    ],
  };
}

/**
 * Nodo 5: Revisor - Mejora el informe basándose en feedback
 */
async function revisorNode(state: ReportGraphState): Promise<Partial<ReportGraphState>> {
  console.log('🔄 [Revisor] Aplicando mejoras sugeridas...');

  if (!state.evaluation || state.evaluation.suggestions.length === 0) {
    return state;
  }

  const llm = createLLM();
  const revisedSections: any[] = [];

  // Revisamos las secciones aplicando el feedback general
  for (const section of state.sections!) {
    const systemPrompt = `Eres el editor corrigiendo el reporte sobre "${state.outline?.title}".
    
    SECCIÓN: ${section.title}
    CONTENIDO ACTUAL:
    ${section.content}
    
    FEEDBACK DEL EDITOR JEFE:
    ${state.evaluation.suggestions.join('\n- ')}
    
    INSTRUCCIÓN:
    Reescribe la sección para solucionar los problemas mencionados. Mantén el estilo del "Reporte de Referencia" (formal, analítico) pero mejora el contenido.`;

    const response = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage('Reescribe la sección mejorada.'),
    ]);

    revisedSections.push({
      ...section,
      content: typeof response.content === 'string' ? response.content : String(response.content),
    });
  }

  return {
    sections: revisedSections,
    iterationCount: state.iterationCount + 1,
    messages: [
      ...state.messages,
      {
        role: 'assistant',
        content: `✅ Secciones refinadas según feedback del evaluador.`,
      },
    ],
  };
}

/**
 * Nodo 6: Compilador - Genera el informe final y DOCX
 */
async function compilerNode(state: ReportGraphState): Promise<Partial<ReportGraphState>> {
  console.log('📦 [Compiler] Compilando informe final...');

  const allSources = state.researchData ? state.researchData.flatMap(r => r.sources) : [];
  const uniqueSources = [...new Set(allSources)];

  // Construcción del Markdown final
  const fullContent = `# ${state.outline!.title}

${state.sections!.map((s, i) => {
    // Generador de números romanos simple para I, II, III...
    const roman = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][i] || `${i + 1}`;
    return `### ${roman}. ${s.title}\n\n${s.content}`;
  }).join('\n\n')}

---
**Fuentes consultadas:**
${uniqueSources.slice(0, 10).map(s => `- ${s}`).join('\n')}

**Informe generado el:** ${new Date().toLocaleDateString('es-AR', {
    dateStyle: 'full',
    timeZone: 'America/Argentina/Buenos_Aires'
  })}`;

  const wordCount = fullContent.split(/\s+/).length;
  const readTimeMinutes = Math.ceil(wordCount / 200);

  const finalReport: any = {
    title: state.outline!.title,
    summary: state.outline!.summary || `Reporte completo sobre ${state.outline!.title}`,
    sections: state.sections!.map((s, i) => ({
      title: s.title,
      content: s.content
    })),
    content: fullContent,
    category: state.outline!.category || 'General',
    metadata: {
      readTime: `${readTimeMinutes} min`,
      pages: Math.ceil(wordCount / 500), // Estimación burda de páginas
      sources: uniqueSources,
      generatedAt: getCurrentTimestamp(),
    },
  };

  // Generar buffer del DOCX/PDF (Simulado o usando la utilidad real)
  let docBuffer;
  try {
      docBuffer = await buildPdfFromReport(finalReport);
  } catch (e) {
      console.error("Error generando PDF/DOCX", e);
      docBuffer = Buffer.from(fullContent); // Fallback
  }

  return {
    finalReport,
    docxBuffer: docBuffer,
    messages: [
      ...state.messages,
      {
        role: 'assistant',
        content: `✅ Informe final compilado: ${wordCount} palabras.`,
      },
    ],
  };
}

// ============================================================================
// Condiciones de Flujo
// ============================================================================

function shouldRevise(state: ReportGraphState): string {
  if (!state.evaluation) return 'compile';
  
  // Si está aprobado, compilar
  if (state.evaluation.approved) {
    return 'compile';
  }

  // Si llegamos al límite de iteraciones, compilar igual (best effort)
  if (state.iterationCount >= MAX_ITERATIONS) {
    console.log(`⚠️ Máximo de iteraciones (${MAX_ITERATIONS}) alcanzado. Compilando lo que hay.`);
    return 'compile';
  }

  return 'revise';
}

// ============================================================================
// Construcción del Grafo
// ============================================================================

export const createReportGraph = () => {
  const workflow = new StateGraph<ReportGraphState>({
    channels: {
      messages: {
        value: (prev: any[], next: any[]) => [...prev, ...next],
        default: () => [],
      },
      userRequest: {
        value: (prev: string | undefined, next: string) => next ?? prev,
        default: () => '',
      },
      outline: {
        value: (prev, next) => next ?? prev,
        default: () => undefined,
      },
      researchData: {
        value: (prev, next) => next ?? prev,
        default: () => undefined,
      },
      sections: {
        value: (prev, next) => next ?? prev,
        default: () => undefined,
      },
      evaluation: {
        value: (prev, next) => next ?? prev,
        default: () => undefined,
      },
      finalReport: {
        value: (prev, next) => next ?? prev,
        default: () => undefined,
      },
      iterationCount: {
        value: (prev: number, next: number) => next ?? prev,
        default: () => 0,
      },
      docxBuffer: {
        value: (prev, next) => next ?? prev,
        default: () => undefined,
      },
      error: {
        value: (prev, next) => next ?? prev,
        default: () => undefined,
      },
    },
  });

  // Agregar nodos
  workflow.addNode('planner', plannerNode);
  workflow.addNode('researcher', researcherNode);
  workflow.addNode('writer', writerNode);
  workflow.addNode('evaluator', evaluatorNode);
  workflow.addNode('revisor', revisorNode);
  workflow.addNode('compiler', compilerNode);

  // Definir flujo
  workflow.addEdge(START as any, 'planner' as any);
  workflow.addEdge('planner' as any, 'researcher' as any);
  workflow.addEdge('researcher' as any, 'writer' as any);
  workflow.addEdge('writer' as any, 'evaluator' as any);

  // Condicional: revisar o compilar
  workflow.addConditionalEdges('evaluator' as any, shouldRevise as any, {
    revise: 'revisor' as any,
    compile: 'compiler' as any,
  } as any);

  // Después de revisar, re-evaluar
  workflow.addEdge('revisor' as any, 'evaluator' as any);

  // Fin después de compilar
  workflow.addEdge('compiler' as any, END as any);

  return workflow.compile();
};