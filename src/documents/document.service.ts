// src/documents/document.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Document, DocumentDocument, DocumentStatus, DocumentType, DocumentArea } from './schema/document.schema';
import { DocumentSync, DocumentSyncDocument, SyncStatus } from './schema/document-sync.schema';
import { Embedding, EmbeddingDocument, EmbeddingSourceType, VectorProvider } from '../embedding/schema/embedding.schema';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { OpenRouterService } from '../openrouter/openrouter.service';
import { DocumentProducer } from './document.producer';
const { PDFParse } = require('pdf-parse');
import PDFDocument from 'pdfkit';
import { Readable } from 'stream';
import { DocumentWithRelevance, ExportPdfDto, SearchDocumentsDto } from './dto/search-documents.dto';

@Injectable()
export class DocumentService {
  private readonly logger = new Logger(DocumentService.name);
  private readonly apiUrl: string;

  constructor(
    @InjectModel(Document.name) private documentModel: Model<DocumentDocument>,
    @InjectModel(DocumentSync.name) private syncModel: Model<DocumentSyncDocument>,
    @InjectModel(Embedding.name) private embeddingModel: Model<EmbeddingDocument>,
    private httpService: HttpService,
    private configService: ConfigService,
    private openRouterService: OpenRouterService,
    private documentProducer: DocumentProducer,
  ) {
    this.apiUrl = this.configService.get<string>(
      'BOLETIN_API_URL',
      'https://api-restboletinoficial.buenosaires.gob.ar/obtenerBoletin/0/true'
    );
  }

  /**
   * Detecta cambios en la API y encola documentos nuevos para procesamiento
   */
  async detectChanges(): Promise<{
    newDocuments: number;
    totalFound: number;
    shouldProcessAll: boolean;
  }> {
    const syncRecord = await this.getOrCreateSyncRecord();

    try {
      await this.syncModel.updateOne(
        { syncKey: 'main' },
        {
          $set: {
            status: SyncStatus.RUNNING,
            lastSyncStartedAt: new Date(),
          },
        },
      );

      this.logger.log('Fetching data from API...');
      const response = await firstValueFrom(
        this.httpService.get(this.apiUrl, {
          timeout: 30000,
        }),
      );
      const data = response.data;
      const normasData = data?.normas?.normas;

      if (!normasData) {
        throw new Error('Invalid API response structure');
      }

      const allDocuments = this.flattenNormasStructure(normasData);
      this.logger.log(`Found ${allDocuments.length} documents from API`);

      const existingIds = new Set(
        (await this.documentModel.find({}, { idNorma: 1 }).lean().exec())
          .map(d => d.idNorma)
      );

      const newDocs = allDocuments.filter(doc => !existingIds.has(doc.idNorma));
      this.logger.log(`Detected ${newDocs.length} new documents`);

      if (newDocs.length > 0) {
        await this.documentModel.insertMany(
          newDocs.map(doc => ({
            ...doc,
            status: DocumentStatus.PENDING,
            lastSyncedAt: new Date(),
            publicationDate: new Date(),
          })),
          { ordered: false }
        ).catch(err => {
          if (err.code !== 11000) throw err;
        });

        const shouldProcessAll = syncRecord.enableFullProcessing;
        const docsToProcess = shouldProcessAll ? newDocs : newDocs.slice(0, 10);

        this.logger.log(
          `Enqueueing ${docsToProcess.length} documents (full processing: ${shouldProcessAll})`
        );

        for (const doc of docsToProcess) {
          await this.documentProducer.enqueueProcessDocument(doc.idNorma);
        }
      }

      await this.syncModel.updateOne(
        { syncKey: 'main' },
        {
          $set: {
            status: SyncStatus.COMPLETED,
            lastSyncCompletedAt: new Date(),
            totalDocumentsFound: allDocuments.length,
            newDocumentsDetected: newDocs.length,
            lastResponse: data,
          },
        },
      );

      return {
        newDocuments: newDocs.length,
        totalFound: allDocuments.length,
        shouldProcessAll: syncRecord.enableFullProcessing,
      };

    } catch (error) {
      this.logger.error('Error detecting changes:', Object.getOwnPropertyNames(error));

      await this.syncModel.updateOne(
        { syncKey: 'main' },
        {
          $set: {
            status: SyncStatus.FAILED,
            errorMessage: error.message,
          },
        },
      );

      throw error;
    }
  }

  /**
   * Procesa un documento: descarga PDF, extrae texto, crea embeddings
   */
  async processDocument(idNorma: number): Promise<DocumentDocument> {
    const document = await this.documentModel.findOne({ idNorma });

    if (!document) {
      throw new Error(`Document ${idNorma} not found`);
    }

    try {
      document.status = DocumentStatus.PROCESSING;
      await document.save();

      // 1. Descargar PDF
      this.logger.log(`Downloading PDF for document ${idNorma}`);
      //const pdfBuffer = await this.downloadPDF(document.urlNorma);

      // 2. Extraer texto del PDF
      this.logger.log(`Extracting text from PDF ${idNorma}`);
      const pdfText = await this.extractTextFromPDF(document.urlNorma);

      document.pdfText = pdfText;

      // 🆕 3. Extraer fecha del header
      this.logger.log(`Extracting document date from PDF ${idNorma}`);
      const documentDate = this.extractDocumentDate(pdfText);
      if (documentDate) {
        document.documentDate = documentDate;
        this.logger.log(`Document date extracted: ${documentDate.toISOString()}`);
      } else {
        this.logger.warn(`Could not extract date from document ${idNorma}`);
      }

      document.status = DocumentStatus.EMBEDDING;
      await document.save();

      // 4. Crear chunks y embeddings
      this.logger.log(`Creating embeddings for document ${idNorma}`);
      const chunks = this.chunkText(pdfText, 8191, 2000);

      let embeddingCount = 0;
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const vector = await this.openRouterService.generateEmbedding(chunk);

        const embedding = new this.embeddingModel({
          sourceType: EmbeddingSourceType.DOCUMENT,
          sourceId: document._id,
          vector,
          provider: VectorProvider.MONGO,
          model: 'text-embedding-3-small',
          dims: vector.length,
          snippet: chunk,
          metadata: {
            documentId: document._id.toString(),
            idNorma: document.idNorma,
            chunkIndex: i,
            totalChunks: chunks.length,
            area: document.area,
            type: document.type,
            documentDate: document.documentDate, // 🆕 Incluir fecha en metadata
          },
          lastIndexedAt: new Date(),
        });

        await embedding.save();
        embeddingCount++;
      }

      // Marcar como completado
      document.status = DocumentStatus.COMPLETED;
      document.embeddingCount = embeddingCount;
      document.processedAt = new Date();
      document.errorMessage = undefined;
      document.retryCount = 0;
      document.lastRetryAt = undefined

      await document.save();

      this.logger.log(`Document ${idNorma} processed successfully with ${embeddingCount} embeddings`);

      return document;

    } catch (error) {
      this.logger.error(`Error processing document ${idNorma}:`, error);

      document.status = DocumentStatus.FAILED;
      document.errorMessage = error.message;
      document.retryCount += 1;
      document.lastRetryAt = new Date();

      if (document.retryCount >= 3) {
        this.logger.error(`Document ${idNorma} marked as PERMANENTLY FAILED after ${document.retryCount} attempts`);
        document.status = DocumentStatus.FAILED;
      }

      await document.save();

      throw error;
    }
  }

  // 🆕 Método para extraer la fecha del documento
  /**
   * Extrae la fecha del header del documento
   * Busca patrones como: "Buenos Aires, 3 de febrero de 2026"
   */
  private extractDocumentDate(text: string): Date | null {
    try {
      // Primero, tomamos solo las primeras 2000 caracteres donde suele estar el header
      const headerText = text.substring(0, 2000);

      // Regex para capturar: "Buenos Aires, [día] de [mes] de [año]"
      const datePattern = /Buenos\s+Aires,\s+(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})/i;
      const match = headerText.match(datePattern);

      if (!match) {
        return null;
      }

      const [, day, monthName, year] = match;
      const month = this.parseSpanishMonth(monthName);

      if (month === -1) {
        this.logger.warn(`Could not parse month: ${monthName}`);
        return null;
      }

      // Crear fecha (mes es 0-indexed en JavaScript)
      const date = new Date(parseInt(year), month, parseInt(day));

      // Validar que la fecha es válida
      if (isNaN(date.getTime())) {
        this.logger.warn(`Invalid date: ${day}/${month + 1}/${year}`);
        return null;
      }

      return date;
    } catch (error) {
      this.logger.error('Error extracting document date:', error);
      return null;
    }
  }

  // 🆕 Método auxiliar para convertir mes en español a número
  /**
   * Convierte nombre de mes en español a número (0-11)
   */
  private parseSpanishMonth(monthName: string): number {
    const months: Record<string, number> = {
      'enero': 0,
      'febrero': 1,
      'marzo': 2,
      'abril': 3,
      'mayo': 4,
      'junio': 5,
      'julio': 6,
      'agosto': 7,
      'septiembre': 8,
      'setiembre': 8, // Variante
      'octubre': 9,
      'noviembre': 10,
      'diciembre': 11,
    };

    return months[monthName.toLowerCase()] ?? -1;
  }

  /**
   * Aplana la estructura jerárquica de normas
   */
  private flattenNormasStructure(normasData: any): Array<{
    nombre: string;
    sumario: string;
    idNorma: number;
    urlNorma: string;
    type: DocumentType;
    area: DocumentArea;
    subarea?: string;
    anexos: any[];
    idSdin: string;
    publicationDate?: Date; // 🆕
  }> {
    const result: Array<{
      nombre: string;
      sumario: string;
      idNorma: number;
      urlNorma: string;
      type: DocumentType;
      area: DocumentArea;
      subarea?: string;
      anexos: any[];
      idSdin: string;
      publicationDate?: Date; // 🆕
    }> = [];

    for (const [area, tipos] of Object.entries(normasData)) {
      for (const [tipo, subareas] of Object.entries(tipos as object)) {
        for (const [subarea, documentos] of Object.entries(subareas as object)) {
          if (Array.isArray(documentos)) {
            for (const doc of documentos) {
              result.push({
                nombre: doc.nombre,
                sumario: doc.sumario,
                idNorma: doc.id_norma,
                urlNorma: doc.url_norma,
                type: this.mapDocumentType(tipo),
                area: this.mapDocumentArea(area),
                subarea: this.mapDocumentArea(subarea),
                anexos: (doc.anexos || []).map((a: any) => ({
                  filenetFirmado: a.filenet_firmado,
                  nombreAnexo: a.nombre_anexo,
                  processed: false,
                  url: a.filenet_firmado,
                })),
                idSdin: doc.id_sdin || '',
                publicationDate: doc.fecha_publicacion
                  ? new Date(doc.fecha_publicacion)
                  : undefined,
              });
            }
          }
        }
      }
    }

    return result;
  }

  private mapDocumentType(tipo: string): DocumentType {
    const typeMap: Record<string, DocumentType> = {
      'Decreto': DocumentType.DECRETO,
      'Resolución': DocumentType.RESOLUCION,
      'Disposición': DocumentType.DISPOSICION,
    };
    return typeMap[tipo] || DocumentType.OTHER;
  }

  private mapDocumentArea(area: string): DocumentArea {
    const areaMap: Record<string, DocumentArea> = {
      'Poder Ejecutivo': DocumentArea.PODER_EJECUTIVO,
      'Área Jefe de Gobierno': DocumentArea.JEFATURA_GOBIERNO,
      'Vicejefatura de Gobierno': DocumentArea.VICEJEFATURA,
      'Jefatura de Gabinete de Ministros': DocumentArea.JEFATURA_GABINETE,
      'Ministerio de Hacienda y Finanzas': DocumentArea.HACIENDA,
      'Ministerio de Salud': DocumentArea.SALUD,
      'Ministerio de Seguridad': DocumentArea.SEGURIDAD,
      'Ministerio de Educación': DocumentArea.EDUCACION,
    };
    return areaMap[area] || DocumentArea.OTHER;
  }

  /**
   * Descarga un PDF desde una URL
   */
  private async downloadPDF(url: string): Promise<Buffer> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(url, {
          responseType: 'arraybuffer',
          timeout: 60000,
        }),
      );
      return Buffer.from(response.data);
    } catch (error) {
      throw new Error(`Failed to download PDF: ${error.message}`);
    }
  }

  /**
   * Extrae texto de un PDF usando pdf-parse
   */
  private async extractTextFromPDF(url: string): Promise<string> {
    try {
      const parser = new PDFParse({ url });
      const result = await parser.getText({ global: true });
      await parser.destroy();
      return result.text;
    } catch (error) {
      throw new Error(`Failed to extract text from PDF: ${error.message}`);
    }
  }

  /**
   * Divide texto en chunks con overlap
   */
  private chunkText(text: string, chunkSize: number = 1000, overlap: number = 200): string[] {
    const chunks: string[] = [];
    let startIndex = 0;

    while (startIndex < text.length) {
      const endIndex = Math.min(startIndex + chunkSize, text.length);
      const chunk = text.slice(startIndex, endIndex);
      chunks.push(chunk);

      if (endIndex === text.length) break;
      startIndex += (chunkSize - overlap);
    }

    return chunks;
  }

  /**
   * Obtiene o crea el registro de sincronización
   */
  private async getOrCreateSyncRecord(): Promise<DocumentSyncDocument> {
    let record = await this.syncModel.findOne({ syncKey: 'main' });

    if (!record) {
      record = new this.syncModel({
        syncKey: 'main',
        status: SyncStatus.IDLE,
        enableFullProcessing: true,
        syncIntervalMinutes: 15,
        apiUrl: this.apiUrl,
      });
      await record.save();
    }

    return record;
  }

  /**
   * Actualiza la flag de procesamiento completo
   */
  async setFullProcessing(enabled: boolean): Promise<DocumentSyncDocument> {
    return this.syncModel.findOneAndUpdate(
      { syncKey: 'main' },
      { $set: { enableFullProcessing: enabled } },
      { new: true, upsert: true },
    );
  }

  /**
   * Obtiene el estado de sincronización
   */
  async getSyncStatus(): Promise<DocumentSyncDocument> {
    return this.getOrCreateSyncRecord();
  }

  // 🆕 Métodos para filtrar por fecha
  /**
   * Busca documentos por rango de fechas
   */
  async findByDateRange(startDate: Date, endDate: Date): Promise<DocumentDocument[]> {
    return this.documentModel.find({
      documentDate: {
        $gte: startDate,
        $lte: endDate,
      },
    }).sort({ documentDate: -1 }).exec();
  }

  /**
   * Busca documentos por mes y año
   */
  async findByMonth(year: number, month: number): Promise<DocumentDocument[]> {
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59, 999);

    return this.findByDateRange(startDate, endDate);
  }

  /**
   * Busca documentos por año
   */
  async findByYear(year: number): Promise<DocumentDocument[]> {
    const startDate = new Date(year, 0, 1);
    const endDate = new Date(year, 11, 31, 23, 59, 59, 999);

    return this.findByDateRange(startDate, endDate);
  }

  /**
   * Obtiene estadísticas de documentos por fecha
   */
  async getDocumentStatsByDate(): Promise<any[]> {
    return this.documentModel.aggregate([
      {
        $match: {
          documentDate: { $ne: null },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: '$documentDate' },
            month: { $month: '$documentDate' },
          },
          count: { $sum: 1 },
          types: { $addToSet: '$type' },
          areas: { $addToSet: '$area' },
        },
      },
      {
        $sort: {
          '_id.year': -1,
          '_id.month': -1,
        },
      },
    ]).exec();
  }

  async searchDocuments(filters: SearchDocumentsDto, ai_enabled: boolean = false): Promise<{
    documents: DocumentWithRelevance[];
    total: number;
  }> {
    const {
      query,
      area,
      type,
      dateFrom, // alias de documentDateFrom
      dateTo,   // alias de documentDateTo
      documentDateFrom,
      documentDateTo,
      publicationDateFrom,
      publicationDateTo,
      limit = 50,
      skip = 0,
    } = filters;

    const mongoQuery: any = {
      status: DocumentStatus.COMPLETED,
      deleted: { $ne: true },
    };

    if (area) {
      mongoQuery.subarea = area;
    }

    if (type) {
      mongoQuery.type = type;
    }

    // 🆕 Filtro por fecha del documento
    const docDateFrom = documentDateFrom || dateFrom;
    const docDateTo = documentDateTo || dateTo;

    if (docDateFrom || docDateTo) {
      mongoQuery.documentDate = {};
      if (docDateFrom) {
        mongoQuery.documentDate.$gte = new Date(docDateFrom);
      }
      if (docDateTo) {
        const endDate = new Date(docDateTo);
        endDate.setHours(23, 59, 59, 999);
        mongoQuery.documentDate.$lte = endDate;
      }
    }

    // 🆕 Filtro por fecha de publicación
    if (publicationDateFrom || publicationDateTo) {
      mongoQuery.publicationDate = {};
      if (publicationDateFrom) {
        mongoQuery.publicationDate.$gte = new Date(publicationDateFrom);
      }
      if (publicationDateTo) {
        const endDate = new Date(publicationDateTo);
        endDate.setHours(23, 59, 59, 999);
        mongoQuery.publicationDate.$lte = endDate;
      }
    }

    if (query && query.trim().length > 0) {
      const searchRegex = new RegExp(query.trim(), 'i');
      mongoQuery.$or = [
        { nombre: searchRegex },
        { sumario: searchRegex },
      ];
    }

    const [documents, total] = await Promise.all([
      this.documentModel
        .find(mongoQuery)
        .sort({ documentDate: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.documentModel.countDocuments(mongoQuery),
    ]);
    // Calcular relevancia política
    if (ai_enabled) {
      const documentsWithRelevance = await Promise.all(
        documents.map(async (doc) => {
          const relevance = await this.calculateAIPoliticalRelevance(doc);
          return {
            ...doc,
            _id: doc._id.toString(),
            politicalRelevance: relevance,
          };
        })
      );

      // Ordenar por relevancia (de mayor a menor)
      documentsWithRelevance.sort((a, b) => b.politicalRelevance - a.politicalRelevance);

      return {
        documents: documentsWithRelevance,
        total,
      };
    } else {
      const documentsWithRelevance = documents.map((doc) => ({
        ...doc,
        _id: doc._id.toString(),
        politicalRelevance: this.calculateSimpleRelevance(doc),
      }));

      documentsWithRelevance.sort(
        (a, b) => b.politicalRelevance - a.politicalRelevance
      );

      return {
        documents: documentsWithRelevance,
        total,
      };
    }
  }

  /**
   * Calcula la relevancia política de un documento (0-100)
   * Basado en área y tipo de documento
   */
  private async calculateAIPoliticalRelevance(document: any): Promise<number> {
    const prompt = `Analiza la relevancia política del siguiente documento oficial y responde SOLO con un número del 0 al 100:

Título: ${document.nombre}
Área: ${document.area}
Tipo: ${document.type}
Sumario: ${document.sumario.substring(0, 300)}

Criterios:
- Poder Ejecutivo/Jefatura: 80-100
- Ministerios importantes (Hacienda, Salud, Seguridad): 60-80
- Decretos: +20 puntos
- Resoluciones/Disposiciones: puntos base del área
- Impacto en múltiples ciudadanos: +10-20
- Temas administrativos internos: -20

Responde SOLO con el número (ej: 75):`;

    try {
      const response = await this.openRouterService.createChatCompletion(
        [
          {
            role: 'system',
            content: 'Eres un analista político experto. Responde SOLO con números.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        {
          max_tokens: 10,
          temperature: 0.3,
        }
      );

      const content = response.choices[0]?.message?.content?.trim();
      const score = parseInt(content || '50');

      // Validar rango
      const validScore = Math.min(100, Math.max(0, isNaN(score) ? 50 : score));

      this.logger.debug(`Relevancia calculada para ${document.idNorma}: ${validScore}`);

      return validScore;
    } catch (error) {
      this.logger.warn(`Error calculando relevancia IA para ${document.idNorma}: ${error.message}`);
      // Fallback: usar criterio simple
      return this.calculateSimpleRelevance(document);
    }
  }

  /**
   * Fallback: relevancia simple sin IA
   */
  private calculateSimpleRelevance(document: any): number {
    let score = 50;

    const areaWeights: Record<string, number> = {
      [DocumentArea.PODER_EJECUTIVO]: 25,
      [DocumentArea.JEFATURA_GOBIERNO]: 25,
      [DocumentArea.VICEJEFATURA]: 20,
      [DocumentArea.JEFATURA_GABINETE]: 20,
      [DocumentArea.HACIENDA]: 15,
      [DocumentArea.SALUD]: 15,
      [DocumentArea.SEGURIDAD]: 15,
      [DocumentArea.EDUCACION]: 15,
      [DocumentArea.OTHER]: 5,
    };

    const typeWeights: Record<string, number> = {
      [DocumentType.DECRETO]: 25,
      [DocumentType.RESOLUCION]: 15,
      [DocumentType.DISPOSICION]: 10,
      [DocumentType.OTHER]: 0,
    };

    score += areaWeights[document.area] || 5;
    score += typeWeights[document.type] || 0;

    return Math.min(100, Math.max(0, score));
  }

  /**
   * Genera resumen coloquial con IA
   * 🆕 CORREGIDO: Manejo de errores mejorado
   */
  async generateDocumentSummary(idNorma: number): Promise<{
    summary: string;
    document: DocumentDocument;
  }> {
    const document = await this.documentModel.findOne({
      idNorma,
      status: DocumentStatus.COMPLETED,
    })

    if (!document) {
      throw new Error(`Documento ${idNorma} no encontrado o no procesado`);
    }

    if (document?.aiSummary) {
      return { summary: document.aiSummary, document: document?.toObject() }
    }

    const prompt = `Genera un resumen breve y coloquial (máximo 3-4 oraciones) del siguiente documento oficial:

Título: ${document.nombre}
Área: ${document.area}
Tipo: ${document.type}
Sumario oficial: ${document.sumario}

${document.pdfText ? `Contenido: ${document.pdfText.substring(0, 3000)}...` : ''}

El resumen debe:
- Ser informal y fácil de entender
- Explicar qué hace el documento en lenguaje simple
- Mencionar a quiénes afecta o beneficia
- Ser conciso (3-4 oraciones máximo)`;

    try {
      const response = await this.openRouterService.createChatCompletion(
        [
          {
            role: 'system',
            content: 'Eres un asistente que explica documentos oficiales en lenguaje simple y coloquial.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        {
          max_tokens: 300,
          temperature: 0.7,
        }
      );

      const summary = response.choices[0]?.message?.content?.trim();

      if (!summary || summary.length < 10) {
        throw new Error('Resumen vacío o muy corto');
      }

      document.aiSummary = summary
      await document.save()

      const docObj = document.toObject();

      /*if (docObj.pdfText && typeof docObj.pdfText === 'string') {
        docObj.pdfText = docObj.pdfText.substring(0, 500);
      }*/

      return {
        summary,
        document: docObj,
      };
    } catch (error) {
      this.logger.error(`Error generando resumen para ${idNorma}:`, error);
      // Fallback: retornar el sumario oficial
      return {
        summary: document.sumario,
        document,
      };
    }
  }

  /**
   * 🆕 Obtener estadísticas del sistema
   */
  async getSystemStats(): Promise<any> {
    const [
      totalDocs,
      byStatus,
      byArea,
      byType,
      recentDocs,
      syncStatus,
      embeddings,
    ] = await Promise.all([
      this.documentModel.countDocuments({ deleted: { $ne: true } }),
      this.documentModel.aggregate([
        { $match: { deleted: { $ne: true } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      this.documentModel.aggregate([
        { $match: { deleted: { $ne: true }, status: DocumentStatus.COMPLETED } },
        { $group: { _id: '$area', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      this.documentModel.aggregate([
        { $match: { deleted: { $ne: true }, status: DocumentStatus.COMPLETED } },
        { $group: { _id: '$type', count: { $sum: 1 } } },
      ]),
      this.documentModel
        .find({ status: DocumentStatus.COMPLETED })
        .sort({ processedAt: -1 })
        .limit(7)
        .select('nombre area type processedAt documentDate')
        .lean(),
      this.syncModel.findOne({ syncKey: 'main' }).lean(),
      this.embeddingModel.countDocuments({ sourceType: EmbeddingSourceType.DOCUMENT }),
    ]);

    // Estadísticas por mes (últimos 6 meses)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const byMonth = await this.documentModel.aggregate([
      {
        $match: {
          documentDate: { $gte: sixMonthsAgo },
          status: DocumentStatus.COMPLETED,
        },
      },
      {
        $group: {
          _id: {
            year: { $year: '$documentDate' },
            month: { $month: '$documentDate' },
          },
          count: { $sum: 1 },
        },
      },
      {
        $sort: { '_id.year': 1, '_id.month': 1 },
      },
    ]);

    return {
      overview: {
        total: totalDocs,
        processed: byStatus.find((s) => s._id === DocumentStatus.COMPLETED)?.count || 0,
        pending: byStatus.find((s) => s._id === DocumentStatus.PENDING)?.count || 0,
        failed: byStatus.find((s) => s._id === DocumentStatus.FAILED)?.count || 0,
        embeddings,
      },
      byStatus: byStatus.reduce((acc, curr) => {
        acc[curr._id] = curr.count;
        return acc;
      }, {}),
      byArea: byArea.map((a) => ({ area: a._id, count: a.count })),
      byType: byType.map((t) => ({ type: t._id, count: t.count })),
      byMonth: byMonth.map((m) => ({
        month: `${m._id.year}-${String(m._id.month).padStart(2, '0')}`,
        count: m.count,
      })),
      recentDocuments: recentDocs,
      sync: {
        status: syncStatus?.status || 'unknown',
        lastSync: syncStatus?.lastSyncCompletedAt,
        totalFound: syncStatus?.totalDocumentsFound || 0,
        newDetected: syncStatus?.newDocumentsDetected || 0,
      },
    };
  }

  /**
   * Genera un PDF con resúmenes de documentos filtrados
   */
  async generatePdfReport(filters: ExportPdfDto): Promise<Buffer> {
    // Buscar documentos con los filtros
    const { documents } = await this.searchDocuments({
      ...filters,
      limit: 500, // Máximo 100 documentos en PDF
      skip: 0,
    });

    if (documents.length === 0) {
      throw new Error('No se encontraron documentos para exportar');
    }

    this.logger.log(
      `Generando PDF con ${documents.length} documentos...`
    );

    // Generar resúmenes coloquiales
    const summaries = await Promise.all(
      documents.map(async (doc) => {
        try {
          const { summary } = await this.generateDocumentSummary(doc.idNorma);
          return {
            ...doc,
            colloquialSummary: summary,
          };
        } catch (error) {
          this.logger.warn(
            `No se pudo generar resumen para ${doc.idNorma}: ${error.message}`
          );
          return {
            ...doc,
            colloquialSummary: doc.sumario,
          };
        }
      })
    );

    // Crear PDF
    return this.createPdfDocument(summaries);
  }

  /**
   * Crea el documento PDF
   */
  private async createPdfDocument(
    documents: Array<DocumentWithRelevance & { colloquialSummary: string }>
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 50, bottom: 50, left: 50, right: 50 },
        bufferPages: true
      });

      const chunks: Buffer[] = [];

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Header
      doc
        .fillColor("#7c3aed")
        .fontSize(20)
        .font('Helvetica-Bold')
        .text('Reporte de Documentos Oficiales', { align: 'center' });

      /*doc
        .fontSize(12)
        .font('Helvetica')
        .text(`Fecha de generación: ${new Date().toLocaleDateString('es-AR')}`, {
          align: 'center',
        });*/

      doc
        .fontSize(12)
        .text(`Catidad de documentos: ${documents.length}`, {
          align: 'center',
        });

      doc.moveDown(2);

      // Documentos ordenados por relevancia
      documents.forEach((document, index) => {
        // Evitar romper página en medio de un documento
        if (doc.y > 650) {
          //doc.addPage();
        }

        // Número y relevancia
        doc
          .fontSize(14)
          .font('Helvetica-Bold')
          .fillColor('#7c3aed')
          .text(`${index + 1}. ${document.nombre}`, {
            continued: false,
          });

        doc.moveDown(0.3);

        // Metadata
        doc
          .fontSize(9)
          .font('Helvetica')
          .fillColor('#6b7280')
          .text(
            `Área: ${document.area} | Tipo: ${document.type}`,
            { continued: false }
          );

        if (document.documentDate) {
          doc.text(
            `Fecha: ${new Date(document.documentDate).toLocaleDateString('es-AR')}`,
            { continued: false }
          );
        }

        doc.moveDown(0.5);

        // Resumen coloquial
        doc
          .fontSize(10)
          .font('Helvetica')
          .fillColor('#000000')
          .text(document.colloquialSummary, {
            align: 'justify',
            lineGap: 2,
          });

        doc.moveDown(0.5);

        // URL
        doc
          .fontSize(8)
          .fillColor('#2563eb')
          .text(`LINK OFICIAL`, {
            link: document.urlNorma,
            underline: true,
          });

        doc.moveDown(1.5);

        // Separador
        if (index < documents.length - 1) {
          doc
            .strokeColor('#e5e7eb')
            .lineWidth(1)
            .moveTo(50, doc.y)
            .lineTo(545, doc.y)
            .stroke();

          doc.moveDown(1);
        }
      });

      // Footer
      /*const pages = doc.bufferedPageRange();
      for (let i = 0; i < pages.count; i++) {
        doc.switchToPage(i);
        doc
          .fontSize(8)
          .fillColor('#6b7280')
          .text(
            `Página ${i + 1} de ${pages.count}`,
            50,
            doc.page.height - 50,
            { align: 'center' }
          );
      }*/

      doc.end();
    });
  }

  /**
   * Obtiene un documento por ID
   */
  async getDocument(idNorma: number): Promise<DocumentDocument> {
    const document = await this.documentModel.findOne({ idNorma });

    if (!document) {
      throw new Error(`Documento ${idNorma} no encontrado`);
    }

    return document;
  }
}