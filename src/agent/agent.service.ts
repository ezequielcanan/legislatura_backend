// src/agent/agent.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Types } from 'mongoose';
import { ChatOpenAI } from '@langchain/openai';
import { createAgent } from 'langchain';
import { createReportGraph } from './graphs/report-graph';
import { createSurveyGraph } from './graphs/survey-graph';
import { ReportGraphState, SurveyGraphState } from './types';
import { Report, ReportDocument } from '../reports/schema/report.schema';
import { Survey, SurveyDocument } from '../surveys/schema/survey.schema';
import { buildPdfFromReport } from './utils/docx';
import { StorageService } from 'src/storage/storage.service';

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private reportGraph: ReturnType<typeof createReportGraph>;
  private surveyGraph: ReturnType<typeof createSurveyGraph>;

  constructor(
    @InjectModel(Report.name) private reportModel: Model<ReportDocument>,
    @InjectModel(Survey.name) private surveyModel: Model<SurveyDocument>,
    private storageService: StorageService,
  ) {
    this.reportGraph = createReportGraph();
    this.surveyGraph = createSurveyGraph();
  }

  /**
   * Crea un stream observable para generación de informes
   */
  createReportStream(userRequest: string, userId: string): Observable<string> {
    return new Observable<string>((subscriber) => {
      (async () => {
        try {
          const initialState: ReportGraphState = {
            messages: [],
            userRequest,
            iterationCount: 0,
          };

          const stream = await this.reportGraph.stream(initialState as any, {
            streamMode: 'updates',
          });

          let docxBuffer: Buffer | null = null;
          let savedReport: ReportDocument | null = null;

          for await (const update of stream) {
            const [nodeName, nodeUpdate] = Object.entries(update)[0];
            const nodeUpdateAny = nodeUpdate as any;

            // Emitir mensajes del agente
            if (nodeUpdateAny.messages && nodeUpdateAny.messages.length > 0) {
              const lastMessage = nodeUpdateAny.messages[nodeUpdateAny.messages.length - 1];

              if (lastMessage.content) {
                const data = {
                  type: 'agent_message',
                  node: nodeName,
                  content: lastMessage.content,
                  timestamp: new Date().toISOString(),
                };
                subscriber.next(JSON.stringify(data));
              }
            }

            // Capturar buffer del DOCX (generado en compiler node)
            if (nodeUpdateAny.docxBuffer) {
              docxBuffer = nodeUpdateAny.docxBuffer;
            }

            // Emitir informe final
            if (nodeUpdateAny.finalReport) {
              // Guardar en DB
              //console.log(nodeUpdateAny.docxBuffer)
              savedReport = await this.saveReport(nodeUpdateAny.finalReport, userId, nodeUpdateAny?.docxBuffer as Buffer);

              const data = {
                type: 'final_report',
                report: {
                  ...nodeUpdateAny.finalReport,
                  _id: savedReport._id.toString(),
                  // Convertir buffer a base64 para transmitir por SSE
                  //docxBase64: docxBuffer ? docxBuffer.toString('base64') : null,
                },
                timestamp: new Date().toISOString(),
              };
              subscriber.next(JSON.stringify(data));
            }
          }

          if (!subscriber.closed) subscriber.complete();
        } catch (error) {
          this.logger.error('Error en stream de informe:', error);
          if (!subscriber.closed) {
            subscriber.next(JSON.stringify({
              type: 'error',
              message: error.message,
            }));
            subscriber.error(error);
          }
        }
      })();

      return () => {
        this.logger.log('Stream de informe cancelado');
      };
    });
  }

  /**
   * Crea un stream observable para generación de encuestas
   */
  createSurveyStream(userRequest: string, userId: string): Observable<string> {
    return new Observable<string>((subscriber) => {
      (async () => {
        try {
          const initialState: SurveyGraphState = {
            messages: [],
            userRequest,
            iterationCount: 0,
          };
          const stream = await this.surveyGraph.stream(initialState as any, {
            streamMode: 'updates',
          });

          for await (const update of stream) {
            const [nodeName, nodeUpdate] = Object.entries(update)[0];
            const nodeUpdateAny = nodeUpdate as any;

            if (nodeUpdateAny.messages && nodeUpdateAny.messages.length > 0) {
              const lastMessage = nodeUpdateAny.messages[nodeUpdateAny.messages.length - 1];

              if (lastMessage.content) {
                const data = {
                  type: 'agent_message',
                  node: nodeName,
                  content: lastMessage.content,
                  timestamp: new Date().toISOString(),
                };
                subscriber.next(JSON.stringify(data));
              }
            }

            // Emitir cuando se complete la encuesta final
            if (nodeUpdateAny.finalSurvey) {
              const data = {
                type: 'final_survey',
                survey: nodeUpdateAny.finalSurvey,
                timestamp: new Date().toISOString(),
              };
              subscriber.next(JSON.stringify(data));

              // Guardar en base de datos
              await this.saveSurvey(nodeUpdateAny.finalSurvey, userId);
            }
          }

          if (!subscriber.closed) subscriber.complete();
        } catch (error) {
          this.logger.error('Error en stream de encuesta:', error);
          if (!subscriber.closed) subscriber.error(error);
        }
      })();

      return () => {
        this.logger.log('Stream de encuesta cancelado');
      };
    });
  }

  /*createModifyReportStream(reportId: string, modificationRequest: string, userId: string): Observable<string> {
    return new Observable<string>((subscriber) => {
      (async () => {
        try {
          // 1. Obtener el informe actual
          const existingReport = await this.reportModel.findById(reportId);

          if (!existingReport) {
            throw new Error('Informe no encontrado');
          }

          // 2. Crear estado inicial con contexto del informe actual
          const initialState: ReportGraphState = {
            messages: [],
            userRequest: modificationRequest,
            iterationCount: 0,
            existingReport: {
              title: existingReport.title,
              summary: existingReport.summary,
              content: existingReport.content,
              sections: existingReport.content.split('\n## ').slice(1).map(section => {
                const [title, ...contentParts] = section.split('\n');
                return {
                  title: title.trim(),
                  content: contentParts.join('\n').trim(),
                };
              }),
            },
          };

          // 3. Ejecutar grafo de modificación
          const stream = await this.reportGraph.stream(initialState as any, {
            streamMode: 'updates',
          });

          let docxBuffer: Buffer | null = null;

          for await (const update of stream) {
            const [nodeName, nodeUpdate] = Object.entries(update)[0];
            const nodeUpdateAny = nodeUpdate as any;

            // Emitir mensajes del agente
            if (nodeUpdateAny.messages && nodeUpdateAny.messages.length > 0) {
              const lastMessage = nodeUpdateAny.messages[nodeUpdateAny.messages.length - 1];

              if (lastMessage.content) {
                const data = {
                  type: 'agent_message',
                  node: nodeName,
                  content: lastMessage.content,
                  timestamp: new Date().toISOString(),
                };
                subscriber.next(JSON.stringify(data));
              }
            }

            // Capturar buffer del DOCX
            if (nodeUpdateAny.docxBuffer) {
              docxBuffer = nodeUpdateAny.docxBuffer;
            }

            // Emitir informe modificado
            if (nodeUpdateAny.finalReport) {
              // Actualizar en DB
              existingReport.title = nodeUpdateAny.finalReport.title;
              existingReport.summary = nodeUpdateAny.finalReport.summary;
              existingReport.content = nodeUpdateAny.finalReport.content;
              existingReport.readTime = nodeUpdateAny.finalReport.metadata.readTime;
              existingReport.pages = nodeUpdateAny.finalReport.metadata.pages;
              existingReport.sources = nodeUpdateAny.finalReport.metadata.sources;

              // Actualizar DOCX si se generó nuevo
              if (docxBuffer) {
                const path = `reports/${existingReport._id}`;
                const upload = await this.storageService.uploadBuffer(
                  docxBuffer,
                  path,
                  {
                    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    public: false,
                  }
                );

                existingReport.docxPath = upload.key;
                existingReport.docxMeta = {
                  url: upload.url,
                  size: upload.size,
                  mimeType: upload.mimeType,
                };
              }

              await existingReport.save();

              const data = {
                type: 'modified_report',
                report: {
                  _id: existingReport._id.toString(),
                  title: existingReport.title,
                  summary: existingReport.summary,
                  content: existingReport.content,
                  category: existingReport.category,
                  readTime: existingReport.readTime,
                  pages: existingReport.pages,
                  isPremium: existingReport.isPremium,
                  isPublished: existingReport.isPublished,
                },
                timestamp: new Date().toISOString(),
              };
              subscriber.next(JSON.stringify(data));
            }
          }

          if (!subscriber.closed) subscriber.complete();
        } catch (error) {
          this.logger.error('Error en stream de modificación:', error);
          if (!subscriber.closed) {
            subscriber.next(JSON.stringify({
              type: 'error',
              message: error.message,
            }));
            subscriber.error(error);
          }
        }
      })();

      return () => {
        this.logger.log('Stream de modificación cancelado');
      };
    });
  }*/

  /**
   * Guarda un informe generado en la base de datos
   */
  // src/agent/agent.service.ts
  private async saveReport(reportData: any, userId: string, docxBuffer: Buffer): Promise<ReportDocument> {
    try {
      const report = new this.reportModel({
        title: reportData.title,
        summary: reportData.summary,
        content: reportData.content,
        category: reportData.category,
        readTime: reportData.metadata.readTime,
        pages: reportData.metadata.pages,
        sources: reportData.metadata.sources,
        docxBuffer: docxBuffer, // ⚠️ Guardar buffer
        generatedBy: userId,
        generatedAt: new Date(reportData.metadata.generatedAt),
        isPublished: false,
        isPremium: false,
      });

      const path = `reports/${report?._id}`; // carpeta / prefijo en storage
      const upload = await this.storageService.uploadBuffer(
        docxBuffer,
        path,
        {
          contentType: "application/pdf",
          public: false, // o true si quieres público
        }
      );

      report.docxPath = upload.key;
      report.docxMeta = {
        url: upload.url,
        size: upload.size,
        mimeType: upload.mimeType,
      }

      await report.save();
      this.logger.log(`Informe guardado: ${report._id}`);

      return report;
    } catch (error) {
      this.logger.error('Error guardando informe:', error);
      throw error;
    }
  }

  /**
   * Guarda una encuesta generada en la base de datos
   */
  private async saveSurvey(surveyData: any, userId: string): Promise<SurveyDocument> {
    try {
      const survey = new this.surveyModel({
        title: surveyData.title,
        description: surveyData.description,
        category: surveyData.category,
        methodology: surveyData.methodology,
        questions: surveyData.questions,
        results: surveyData.results,
        participants: surveyData.metadata.participants,
        confidenceLevel: surveyData.metadata.confidenceLevel,
        marginOfError: surveyData.metadata.marginOfError,
        dataCollectionPeriod: surveyData.metadata.dataCollectionPeriod,
        sources: surveyData.metadata.sources,
        generatedBy: userId,
        generatedAt: new Date(surveyData.metadata.generatedAt),
        isPublished: false,
        isPremium: false,
      });

      await survey.save();
      this.logger.log(`Encuesta guardada: ${survey._id}`);

      return survey;
    } catch (error) {
      this.logger.error('Error guardando encuesta:', error);
      throw error;
    }
  }

  createStream(messages: any, userId: string | Types.ObjectId): Observable<string> {
    return new Observable<string>((subscriber) => {
      (async () => {
        try {
          // 1) Crear LLM apuntando a OpenRouter (OpenAI-compatible)
          const llm = new ChatOpenAI({
            // nombre del modelo que uses en OpenRouter
            model: process.env.OPENROUTER_DEFAULT_MODEL ?? 'x-ai/grok-4.1-fast',
            streaming: true,
            apiKey: process.env.OPENROUTER_API_KEY,
            // pasar base URL de OpenRouter dentro de `configuration`
            configuration: {
              baseURL: process.env.OPENROUTER_API_URL, // ej: "https://api.openrouter.ai/v1"
            },
            reasoning: {
              effort: "medium"
            }
            // otras opciones posibles: temperature, maxTokens, etc.
          });

          // 2) Definir tools (ejemplo simple). Reemplaza por llamadas reales a tu DB/servicios.
          const writeToDb = async (input: any) => {
            this.logger.log(`[tool:write_to_db] guardando`);
            await new Promise((r) => setTimeout(r, 120));
            return `Guardado: ${input}`;
          };

          // 3) Crear el agente. A veces TS se queja del tipo exacto del llm,
          // así que casteamos a any para evitar error de tipos en compile time.
          const agent = createAgent({
            // si 'llm' te da problemas, podrías usar llm: "openai:gpt-4o" (string id),
            // pero para poder pasar configuration usamos la instancia llm.
            model: llm as any,
            tools: [],
          });

          // 4) Ejecutar en modo streaming. agent.stream devuelve un async iterable.
          //    El primer argumento son los "inputs" del agente (mensajes para chat).
          //    El segundo arg controla modo de stream; "values" es una opción común.
          // construir referencia "ahora" en la zona del usuario
          const now = new Date();
          const refNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));

          const systemContext = {
            role: 'system',
            content: `Fecha actual (zona America/Argentina/Buenos_Aires): ${refNow.toISOString()}.
            Nota (solo referencia interna): hoy es ${refNow.toLocaleDateString('es-AR', { weekday: 'long' })}.
Por favor, cuando debas devolver fechas en JSON (por ejemplo para la tool create_event), usa ISO 8601 (ej: 2026-01-20T15:30:00-03:00 o en UTC 2026-01-20T18:30:00Z) y aclara la zona horaria. Si el usuario usa expresiones relativas (mañana, próximo lunes, el martes que viene), resuélvelas con respecto a la fecha actual indicada arriba.`
          };

          // prepende systemContext si no existe ya
          const finalMessages = Array.isArray(messages) ? [systemContext, ...messages] : [systemContext, { role: 'user', content: messages }];


          const stream = await agent.stream(
            { messages: finalMessages },
            { streamMode: "messages" }
          );

          // 5) Iterar el stream y emitir al subscriber.
          for await (const chunk of stream) {
            //console.log(JSON.stringify(chunk, null, 2))
            //const lastMessage = chunk?.messages[chunk?.messages?.length - 1]

            //console.log(chunk)
            const lastMessage = chunk[0]
            //console.log(lastMessage.type, lastMessage.content)
            if (!lastMessage?.content) continue;

            if (lastMessage.type !== 'ai') {
              continue;
            }


            try {
              // Best-effort: extraer texto desde distintas posibles formas de chunk.
              // La forma exacta del chunk cambia según versión; por eso hay varios checks.
              const raw = lastMessage?.content;
              // Normalizar a string y eliminar espacios al principio/fin
              const text = typeof raw === 'string' ? raw : String(raw ?? '');
              const trimmed = text.trim();

              // Emitir solo si hay algo útil (evita strings vacíos o solo espacios)
              subscriber.next(trimmed.length > 0 ? text : " ");
            } catch (parseErr) {
              // si falla parsear, envia representación cruda
              subscriber.next(JSON.stringify(chunk));
            }
          }

          // 6) completar si no se cerró
          if (!subscriber.closed) subscriber.complete();
        } catch (err) {
          if (!subscriber.closed) subscriber.error(err as Error);
        }
      })();

      // cleanup: ejecutar si el subscriber se desuscribe
      return () => {
        this.logger.log('Suscriptor cancelado - cleanup (si corresponde)');
        // aquí podrías abortar solicitudes si guardas controladores/handles
      };
    });
  }
}