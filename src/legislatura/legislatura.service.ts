import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { XMLParser } from 'fast-xml-parser';
import { Bloque, BloqueDocument } from './schema/bloque.schema';
import { Legislador, LegisladorDocument } from './schema/legislador.schema';
import { Expediente, ExpedienteDocument, ExpedienteStatus } from './schema/expediente.schema';
import { LegislaturaSync, LegislaturaSyncDocument, SyncStatus } from './schema/legislatura-sync.schema';
import { Embedding, EmbeddingDocument, EmbeddingSourceType, VectorProvider } from '../embedding/schema/embedding.schema';
import { OpenRouterService } from '../openrouter/openrouter.service';
import { LegislaturaProducer } from './legislatura.producer';
import { SearchExpedientesDto } from './dto/search-expedientes.dto';

const API_BASE = 'https://parlamentaria.legislatura.gob.ar';

@Injectable()
export class LegislaturaService {
  private readonly logger = new Logger(LegislaturaService.name);
  private readonly xmlParser: XMLParser;

  constructor(
    @InjectModel(Bloque.name) private bloqueModel: Model<BloqueDocument>,
    @InjectModel(Legislador.name) private legisladorModel: Model<LegisladorDocument>,
    @InjectModel(Expediente.name) private expedienteModel: Model<ExpedienteDocument>,
    @InjectModel(LegislaturaSync.name) private syncModel: Model<LegislaturaSyncDocument>,
    @InjectModel(Embedding.name) private embeddingModel: Model<EmbeddingDocument>,
    private httpService: HttpService,
    private configService: ConfigService,
    private openRouterService: OpenRouterService,
    private legislaturaProducer: LegislaturaProducer,
  ) {
    this.xmlParser = new XMLParser({
      ignoreAttributes: false,
      removeNSPrefix: true,
      trimValues: true,
    });
  }

  // ─── BLOQUES ────────────────────────────────────────────

  async syncBloques(): Promise<{ synced: number }> {
    this.logger.log('Syncing bloques...');
    const response = await this.postXml(`${API_BASE}/webservices/Json.asmx/GetBloquesActivos`, 'id_bloque=');
    const parsed = this.xmlParser.parse(response);
    const bloques = this.ensureArray(parsed?.ArrayOfBloques?.bloques);

    let synced = 0;
    for (const b of bloques) {
      await this.bloqueModel.findOneAndUpdate(
        { bloqueId: b.bloque_id },
        {
          bloqueId: b.bloque_id,
          nombre: b.bloque,
          url: b.bloque_url || '',
          logo: b.bloque_logo || '',
          logoS: b.bloque_logoS || '',
          logoM: b.bloque_logoM || '',
          cantidad: parseInt(b.bloque_cantidad) || 0,
          color: b.bloque_color || '',
        },
        { upsert: true, new: true },
      );
      synced++;
    }

    this.logger.log(`Synced ${synced} bloques`);
    return { synced };
  }

  async getBloques(): Promise<BloqueDocument[]> {
    return this.bloqueModel.find().sort({ cantidad: -1 }).exec();
  }

  async getBloquesWithCounts(): Promise<any[]> {
    const response = await this.postXml(`${API_BASE}/webservices/Json.asmx/GetBloquesCantidades`, 'id_bloque=');
    const parsed = this.xmlParser.parse(response);
    const bloques = this.ensureArray(parsed?.ArrayOfBloquesCantidades?.bloquesCantidades);

    return bloques.map((b: any) => ({
      bloqueId: b.bloque_id,
      nombre: b.bloque,
      url: b.bloque_url,
      total: parseInt(b.bloque_total) || 0,
      percent: parseFloat(String(b.bloque_percent).replace(',', '.')) || 0,
      color: b.bloque_color,
    }));
  }

  // ─── LEGISLADORES ───────────────────────────────────────

  async syncLegisladores(): Promise<{ synced: number }> {
    this.logger.log('Syncing legisladores...');
    const response = await this.postXml(
      `${API_BASE}/webservices/Json.asmx/GetDiputadosyCargosActivosNuevo`,
      'id_bloque=',
    );
    const parsed = this.xmlParser.parse(response);
    const diputados = this.ensureArray(parsed?.ArrayOfDiputados?.diputados);

    let synced = 0;
    for (const d of diputados) {
      await this.legisladorModel.findOneAndUpdate(
        { legisladorId: d.id_legislador },
        {
          legisladorId: d.id_legislador,
          apellido: d.apellido,
          nombre: d.nombre,
          urlLegislador: d.url_legislador || '',
          sexo: d.sexo || '',
          bloque: d.bloque || '',
          urlBloque: d.url_bloque || '',
          bloqueId: d.id_bloque,
          bloqueColor: d.bloque_color || '',
          foto: d.foto || '',
          fotoS: d.fotoS || '',
          fotoM: d.fotoM || '',
          bloqueLogo: d.bloque_logo || '',
          bloqueLogoS: d.bloque_logoS || '',
          bloqueLogoM: d.bloque_logoM || '',
          idAutor: d.id_autor,
          fechaInicioMandato: d.fecha_inicio_mandato || '',
          fechaFinMandato: d.fecha_fin_mandato || '',
          cargoRecinto: d.cargo_recinto || '',
          idCargoRecinto: d.id_cargo_recinto || 0,
        },
        { upsert: true, new: true },
      );
      synced++;
    }

    this.logger.log(`Synced ${synced} legisladores`);
    return { synced };
  }

  async getLegisladores(bloqueId?: number): Promise<LegisladorDocument[]> {
    const filter: any = {};
    if (bloqueId) filter.bloqueId = bloqueId;
    return this.legisladorModel.find(filter).sort({ apellido: 1 }).lean().exec();
  }

  async getLegisladorById(legisladorId: number): Promise<LegisladorDocument | null> {
    return this.legisladorModel.findOne({ legisladorId }).lean().exec();
  }

  async getLegisladorDetail(legisladorId: number): Promise<any> {
    const response = await this.postXml(
      `${API_BASE}/webservices/Json.asmx/GetDiputadoDatos`,
      `id_legislador=${legisladorId}`,
    );
    const parsed = this.xmlParser.parse(response);
    const diputados = this.ensureArray(parsed?.ArrayOfDiputados?.diputados);
    const d = diputados[0];
    if (!d) return null;

    // Also fetch comisiones
    const comResponse = await this.postXml(
      `${API_BASE}/webservices/Json.asmx/GetComisionesPorDiputado`,
      `id_legislador=${legisladorId}`,
    );
    const comParsed = this.xmlParser.parse(comResponse);
    const comisiones = this.ensureArray(comParsed?.ArrayOfComisioncargos?.comisioncargos);

    // Update stored comisiones
    if (comisiones.length > 0) {
      const comNames = comisiones.map((c: any) => c.comision || c.nombre || '').filter(Boolean);
      await this.legisladorModel.updateOne(
        { legisladorId },
        { $set: { comisiones: comNames } },
      );
    }

    return {
      ...d,
      comisiones: comisiones.map((c: any) => ({
        nombre: c.comision || c.nombre || '',
        cargo: c.cargo || '',
        id: c.id_comision || 0,
      })),
    };
  }

  // ─── EXPEDIENTES ────────────────────────────────────────

  async syncTodayExpedientes(): Promise<{ newExpedientes: number; totalFound: number }> {
    const syncRecord = await this.getOrCreateSyncRecord();

    try {
      await this.syncModel.updateOne(
        { syncKey: 'main' },
        { $set: { status: SyncStatus.RUNNING, lastSyncStartedAt: new Date() } },
      );

      const today = new Date();
      const dateStr = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;

      this.logger.log(`Fetching expedientes for date: ${dateStr}`);

      const body = [
        'IdProyectoTipo=',
        'IdAutoresInternos=',
        'IdUbicacion=',
        'IdEstado=',
        'Sumario=',
        'SumarioExacto=0',
        `FechaDesde=${dateStr}`,
        `FechaHasta=${dateStr}`,
        'AnioParlamentario=',
        'Limite=',
      ].join('&');

      const response = await this.postXml(
        `${API_BASE}/webservices/Json.asmx/GetExpedienteAvanzada`,
        body,
      );
      const parsed = this.xmlParser.parse(response);
      const expedientes = this.ensureArray(parsed?.ArrayOfExpedienteAvanzado?.expedienteAvanzado);

      this.logger.log(`Found ${expedientes.length} expedientes for today`);

      const existingIds = new Set(
        (await this.expedienteModel.find({}, { expedienteId: 1 }).lean().exec()).map(
          (d) => d.expedienteId,
        ),
      );

      let newCount = 0;
      for (const exp of expedientes) {
        const expId = parseInt(exp.id_expediente);
        
        if (existingIds.has(expId)) continue;

        // Parse autor
        let autor: { legisladorId: number; nombre: string; apellido: string } | undefined = undefined;
        if (exp.autor_id && exp.autor_des) {
          const autorParsed = this.parseAutorName(exp.autor_des);
          autor = {
            legisladorId: parseInt(exp.autor_id),
            nombre: autorParsed.nombre,
            apellido: autorParsed.apellido,
          };
        }

        // Parse coautores
        const coautores: Array<{ legisladorId: number; nombre: string; apellido: string }> = [];
        if (exp.coautores_id && exp.coautores_des) {
          const coautoresIdsStr = String(exp.coautores_id);
          const coautoresDesStr = String(exp.coautores_des);
          const coautoresIds = coautoresIdsStr.split(',').map((id: string) => id.trim());
          const coautoresNames = coautoresDesStr.split(';').map((name: string) => name.trim());
          
          for (let i = 0; i < coautoresIds.length && i < coautoresNames.length; i++) {
            const coautorParsed = this.parseAutorName(coautoresNames[i]);
            coautores.push({
              legisladorId: parseInt(coautoresIds[i]),
              nombre: coautorParsed.nombre,
              apellido: coautorParsed.apellido,
            });
          }
        }

        // Validate numero field - use expedienteId as fallback if empty
        const numero = exp.numero && exp.numero.trim() !== '' 
          ? exp.numero.trim() 
          : `EXP-${expId}`;

        await this.expedienteModel.create({
          expedienteId: expId,
          numero: numero,
          titulo: exp.titulo || exp.sumario || '',
          sumario: exp.sumario || '',
          tipo: exp.tipo || '',
          tipoId: exp.id_tipo || 0,
          estado: exp.estado || '',
          estadoId: exp.id_estado || 0,
          ubicacion: exp.ubicacion || '',
          ubicacionId: exp.id_ubicacion || 0,
          fechaIngreso: exp.fecha || '',
          fechaIngresoDate: this.parseDateString(exp.fecha) as any,
          anioParlamentario: exp.anio_parlamentario || '',
          autor,
          coautores,
          status: ExpedienteStatus.PENDING,
        });

        // Enqueue for processing (download PDF, summarize, tag, embed)
        await this.legislaturaProducer.enqueueProcessExpediente(expId);
        newCount++;
      }

      await this.syncModel.updateOne(
        { syncKey: 'main' },
        {
          $set: {
            status: SyncStatus.COMPLETED,
            lastSyncCompletedAt: new Date(),
            totalExpedientesFound: expedientes.length,
            newExpedientesDetected: newCount,
          },
        },
      );

      this.logger.log(`Sync completed: ${newCount} new expedientes`);
      return { newExpedientes: newCount, totalFound: expedientes.length };
    } catch (error) {
      this.logger.error('Error syncing expedientes:', error.message);
      await this.syncModel.updateOne(
        { syncKey: 'main' },
        { $set: { status: SyncStatus.FAILED, errorMessage: error.message } },
      );
      throw error;
    }
  }

  async syncExpedientesByDateRange(from: string, to: string): Promise<{ newExpedientes: number; totalFound: number }> {
    const body = [
      'IdProyectoTipo=',
      'IdAutoresInternos=',
      'IdUbicacion=',
      'IdEstado=',
      'Sumario=',
      'SumarioExacto=0',
      `FechaDesde=${from}`,
      `FechaHasta=${to}`,
      'AnioParlamentario=',
      'Limite=',
    ].join('&');

    const response = await this.postXml(
      `${API_BASE}/webservices/Json.asmx/GetExpedienteAvanzada`,
      body,
    );
    const parsed = this.xmlParser.parse(response);
    const expedientes = this.ensureArray(parsed?.ArrayOfExpedienteAvanzado?.expedienteAvanzado);

    const existingIds = new Set(
      (await this.expedienteModel.find({}, { expedienteId: 1 }).lean().exec()).map(
        (d) => d.expedienteId,
      ),
    );

    let newCount = 0;
    for (const exp of expedientes) {
      const expId = parseInt(exp.id_expediente);
      if (existingIds.has(expId)) continue;

      // Parse autor
      let autor: { legisladorId: number; nombre: string; apellido: string } | undefined = undefined;
      if (exp.autor_id && exp.autor_des) {
        const autorParsed = this.parseAutorName(exp.autor_des);
        autor = {
          legisladorId: parseInt(exp.autor_id),
          nombre: autorParsed.nombre,
          apellido: autorParsed.apellido,
        };
      }

      // Parse coautores
      const coautores: Array<{ legisladorId: number; nombre: string; apellido: string }> = [];
      if (exp.coautores_id && exp.coautores_des) {
        const coautoresIdsStr = String(exp.coautores_id);
        const coautoresDesStr = String(exp.coautores_des);
        const coautoresIds = coautoresIdsStr.split(',').map((id: string) => id.trim());
        const coautoresNames = coautoresDesStr.split(';').map((name: string) => name.trim());
        
        for (let i = 0; i < coautoresIds.length && i < coautoresNames.length; i++) {
          const coautorParsed = this.parseAutorName(coautoresNames[i]);
          coautores.push({
            legisladorId: parseInt(coautoresIds[i]),
            nombre: coautorParsed.nombre,
            apellido: coautorParsed.apellido,
          });
        }
      }

      // Validate numero field - use expedienteId as fallback if empty
      const numero = exp.numero && exp.numero.trim() !== '' 
        ? exp.numero.trim() 
        : `EXP-${expId}`;

      await this.expedienteModel.create({
        expedienteId: expId,
        numero: numero,
        titulo: exp.titulo || exp.sumario || '',
        sumario: exp.sumario || '',
        tipo: exp.tipo || '',
        tipoId: exp.id_tipo || 0,
        estado: exp.estado || '',
        estadoId: exp.id_estado || 0,
        ubicacion: exp.ubicacion || '',
        ubicacionId: exp.id_ubicacion || 0,
        fechaIngreso: exp.fecha || '',
        fechaIngresoDate: this.parseDateString(exp.fecha) as any,
        anioParlamentario: exp.anio_parlamentario || '',
        autor,
        coautores,
        status: ExpedienteStatus.PENDING,
      });

      await this.legislaturaProducer.enqueueProcessExpediente(expId);
      newCount++;
    }

    return { newExpedientes: newCount, totalFound: expedientes.length };
  }

  async processExpediente(expedienteId: number): Promise<ExpedienteDocument> {
    const expediente = await this.expedienteModel.findOne({ expedienteId });
    if (!expediente) throw new Error(`Expediente ${expedienteId} not found`);

    try {
      // Step 1: Download PDF documents (libros)
      expediente.status = ExpedienteStatus.DOWNLOADING;
      await expediente.save();

      const libros = await this.fetchLibrosExpediente(expedienteId);
      expediente.libros = libros;

      // Also fetch votaciones
      const votaciones = await this.fetchVotacionesExpediente(expedienteId);
      expediente.votaciones = votaciones;

      // Extract PDF text from first available document
      let fullText = '';
      for (const libro of libros) {
        if (libro.url) {
          try {
            const text = await this.extractTextFromPdf(libro.url);
            if (text && text.length > 50) {
              fullText += text + '\n\n';
            }
          } catch (err) {
            this.logger.warn(`Failed to extract text from libro ${libro.idDoc}: ${err.message}`);
          }
        }
      }

      expediente.pdfText = fullText || '';

      // Step 2: AI Summarization and tagging
      expediente.status = ExpedienteStatus.SUMMARIZING;
      await expediente.save();

      const textForAI = fullText || expediente.sumario || '';
      if (textForAI.length > 10) {
        const { summary, tags, category } = await this.generateSummaryAndTags(expediente, textForAI);
        expediente.aiSummary = summary;
        expediente.aiTags = tags;
        expediente.aiCategory = category;
      }

      // Step 3: Create embeddings
      expediente.status = ExpedienteStatus.EMBEDDING;
      await expediente.save();

      const textToEmbed = [
        expediente.sumario,
        expediente.aiSummary || '',
        fullText.substring(0, 8000),
      ].filter(Boolean).join('\n\n');

      if (textToEmbed.length > 20) {
        const chunks = this.chunkText(textToEmbed, 6000, 1000);
        let embeddingCount = 0;

        for (let i = 0; i < chunks.length; i++) {
          try {
            const vector = await this.openRouterService.generateEmbedding(chunks[i]);
            await this.embeddingModel.create({
              sourceType: EmbeddingSourceType.DOCUMENT,
              sourceId: expediente._id,
              vector,
              provider: VectorProvider.MONGO,
              model: 'text-embedding-3-small',
              dims: vector.length,
              snippet: chunks[i].substring(0, 500),
              metadata: {
                expedienteId: expediente.expedienteId,
                numero: expediente.numero,
                tipo: expediente.tipo,
                aiTags: expediente.aiTags,
                aiCategory: expediente.aiCategory,
                chunkIndex: i,
                totalChunks: chunks.length,
                fechaIngreso: expediente.fechaIngreso,
              },
              lastIndexedAt: new Date(),
            });
            embeddingCount++;
          } catch (err) {
            this.logger.warn(`Failed to create embedding chunk ${i} for expediente ${expedienteId}: ${err.message}`);
          }
        }
        expediente.embeddingCount = embeddingCount;
      }

      // Done
      expediente.status = ExpedienteStatus.COMPLETED;
      expediente.processedAt = new Date();
      expediente.errorMessage = undefined;
      expediente.retryCount = 0;
      await expediente.save();

      this.logger.log(`Expediente ${expedienteId} processed successfully`);
      return expediente;
    } catch (error) {
      this.logger.error(`Error processing expediente ${expedienteId}:`, error.message);
      expediente.status = ExpedienteStatus.FAILED;
      expediente.errorMessage = error.message;
      expediente.retryCount += 1;
      expediente.lastRetryAt = new Date();
      await expediente.save();
      throw error;
    }
  }

  async generateSummaryAndTags(
    expediente: ExpedienteDocument,
    text: string,
  ): Promise<{ summary: string; tags: string[]; category: string }> {
    const prompt = `Analyze the following legislative project (expediente) from the Buenos Aires City Legislature and provide a structured JSON response.

Project Number: ${expediente.numero}
Type: ${expediente.tipo}
Official Summary: ${expediente.sumario}

Full text (truncated):
${text.substring(0, 4000)}

Respond ONLY with valid JSON in this exact format:
{
  "summary": "A clear, concise summary in Spanish (3-5 sentences) explaining what this project does in simple terms, who it affects, and its key provisions",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "category": "one of: seguridad, salud, educacion, transporte, vivienda, economia, cultura, ambiente, tecnologia, trabajo, justicia, servicios_publicos, presupuesto, gobierno, derechos_humanos, otro"
}

Tags should be specific and relevant keywords in Spanish. Choose the single most fitting category.`;

    try {
      const response = await this.openRouterService.createChatCompletion(
        [
          {
            role: 'system',
            content: 'You are an expert legislative analyst. You respond ONLY with valid JSON, no markdown, no explanation.',
          },
          { role: 'user', content: prompt },
        ],
        { max_tokens: 500, temperature: 0.3 },
      );

      const content = response.choices?.[0]?.message?.content?.trim() || '';
      // Try to parse JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          summary: parsed.summary || expediente.sumario,
          tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 10) : [],
          category: parsed.category || 'otro',
        };
      }
      return { summary: expediente.sumario, tags: [], category: 'otro' };
    } catch (error) {
      this.logger.warn(`AI summary/tag generation failed for ${expediente.expedienteId}: ${error.message}`);
      return { summary: expediente.sumario, tags: [], category: 'otro' };
    }
  }

  // ─── SEARCH & QUERY ─────────────────────────────────────

  async searchExpedientes(filters: SearchExpedientesDto): Promise<{
    expedientes: ExpedienteDocument[];
    total: number;
  }> {
    const { query, tipo, estado, bloqueId, legisladorId, tag, category, dateFrom, dateTo, limit = 50, skip = 0 } = filters;

    const mongoQuery: any = {};

    if (query && query.trim()) {
      const searchRegex = new RegExp(query.trim(), 'i');
      mongoQuery.$or = [
        { numero: searchRegex },
        { titulo: searchRegex },
        { sumario: searchRegex },
        { aiSummary: searchRegex },
        { aiTags: searchRegex },
      ];
    }

    if (tipo) mongoQuery.tipo = tipo;
    if (estado) mongoQuery.estado = estado;
    if (tag) mongoQuery.aiTags = tag;
    if (category) mongoQuery.aiCategory = category;

    if (legisladorId) {
      mongoQuery['autores.legisladorId'] = legisladorId;
    }

    if (bloqueId) {
      // Find legisladores for that bloque, then filter by their IDs
      const legsInBloque = await this.legisladorModel.find({ bloqueId }, { legisladorId: 1 }).lean();
      const legIds = legsInBloque.map((l) => l.legisladorId);
      mongoQuery['autores.legisladorId'] = { $in: legIds };
    }

    if (dateFrom || dateTo) {
      mongoQuery.fechaIngresoDate = {};
      if (dateFrom) mongoQuery.fechaIngresoDate.$gte = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        mongoQuery.fechaIngresoDate.$lte = end;
      }
    }

    const [expedientes, total] = await Promise.all([
      this.expedienteModel.find(mongoQuery).sort({ fechaIngresoDate: -1 }).skip(skip).limit(limit).lean().exec(),
      this.expedienteModel.countDocuments(mongoQuery),
    ]);

    return { expedientes, total };
  }

  async getExpedienteById(expedienteId: number): Promise<ExpedienteDocument | null> {
    return this.expedienteModel.findOne({ expedienteId }).lean().exec();
  }

  async getExpedientesByLegislador(legisladorId: number): Promise<ExpedienteDocument[]> {
    return this.expedienteModel
      .find({ 'autores.legisladorId': legisladorId })
      .sort({ fechaIngresoDate: -1 })
      .lean()
      .exec();
  }

  async getExpedientesGroupedByDate(dateFrom?: string, dateTo?: string): Promise<any[]> {
    const match: any = {};
    if (dateFrom || dateTo) {
      match.fechaIngresoDate = {};
      if (dateFrom) match.fechaIngresoDate.$gte = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        match.fechaIngresoDate.$lte = end;
      }
    }

    return this.expedienteModel.aggregate([
      { $match: match },
      { $sort: { fechaIngresoDate: -1 } },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$fechaIngresoDate' },
          },
          proyectos: { $push: '$$ROOT' },
          totalProyectos: { $sum: 1 },
        },
      },
      { $sort: { _id: -1 } },
      { $project: { _id: 0, fecha: '$_id', proyectos: 1, totalProyectos: 1 } },
    ]).exec();
  }

  async getSyncStatus(): Promise<LegislaturaSyncDocument> {
    return this.getOrCreateSyncRecord();
  }

  async getStats(): Promise<any> {
    const [totalExpedientes, totalLegisladores, totalBloques, totalEmbeddings, byStatus, byTipo, byCategory] =
      await Promise.all([
        this.expedienteModel.countDocuments(),
        this.legisladorModel.countDocuments(),
        this.bloqueModel.countDocuments(),
        this.embeddingModel.countDocuments({ sourceType: EmbeddingSourceType.DOCUMENT }),
        this.expedienteModel.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
        this.expedienteModel.aggregate([
          { $match: { status: ExpedienteStatus.COMPLETED } },
          { $group: { _id: '$tipo', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]),
        this.expedienteModel.aggregate([
          { $match: { status: ExpedienteStatus.COMPLETED, aiCategory: { $ne: null } } },
          { $group: { _id: '$aiCategory', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ]),
      ]);

    return {
      overview: { totalExpedientes, totalLegisladores, totalBloques, totalEmbeddings },
      byStatus: byStatus.reduce((acc, s) => ({ ...acc, [s._id]: s.count }), {}),
      byTipo: byTipo.map((t) => ({ tipo: t._id, count: t.count })),
      byCategory: byCategory.map((c) => ({ category: c._id, count: c.count })),
    };
  }

  // ─── HELPER METHODS ─────────────────────────────────────

  private async fetchLibrosExpediente(expedienteId: number): Promise<Array<{ idDoc: number; nombre: string; url: string; tipo: string }>> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(
          `${API_BASE}/webservices/json.asmx/GetLibrosExpediente?IdExpediente=${expedienteId}`,
          { timeout: 15000 },
        ),
      );
      const parsed = this.xmlParser.parse(response.data);
      const listado = this.ensureArray(
        parsed?.RespuestaOfexpedienteLibros?.Listado?.expedienteLibros,
      );

      return listado.map((l: any) => ({
        idDoc: l.id_doc || 0,
        nombre: l.nombre || '',
        url: l.id_doc ? `${API_BASE}/pages/download.aspx?IdDoc=${l.id_doc}` : '',
        tipo: l.tipo || '',
      }));
    } catch (error) {
      this.logger.warn(`Failed to fetch libros for expediente ${expedienteId}: ${error.message}`);
      return [];
    }
  }

  private async fetchVotacionesExpediente(expedienteId: number): Promise<any> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(
          `${API_BASE}/webservices/json.asmx/GetVotacionesExpediente?IdExpediente=${expedienteId}`,
          { timeout: 15000 },
        ),
      );
      const parsed = this.xmlParser.parse(response.data);
      return parsed?.RespuestaOfVotacionExpediente?.Listado || null;
    } catch (error) {
      this.logger.warn(`Failed to fetch votaciones for expediente ${expedienteId}: ${error.message}`);
      return null;
    }
  }

  private async extractTextFromPdf(url: string): Promise<string> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(url, { responseType: 'arraybuffer', timeout: 30000 }),
      );
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(Buffer.from(response.data));
      return data.text || '';
    } catch (error) {
      this.logger.warn(`Failed to extract text from PDF: ${error.message}`);
      return '';
    }
  }

  private async postXml(url: string, body: string): Promise<string> {
    const response = await firstValueFrom(
      this.httpService.post(url, body, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 30000,
        responseType: 'text',
      }),
    );
    return typeof response.data === 'string' ? response.data : String(response.data);
  }

  private ensureArray(val: any): any[] {
    if (!val) return [];
    if (Array.isArray(val)) return val;
    return [val];
  }

  private parseDateString(dateStr: string): Date | null {
    if (!dateStr) return null;
    // Handle dd/mm/yyyy format
    const parts = dateStr.split('/');
    if (parts.length === 3) {
      const [day, month, year] = parts.map(Number);
      return new Date(year, month - 1, day);
    }
    // Try standard parsing
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d;
  }

  private parseAutorName(fullName: string): { nombre: string; apellido: string } {
    if (!fullName) return { nombre: '', apellido: '' };
    
    // Format: "APELLIDO, NOMBRE" or "APELLIDO, NOMBRE1 NOMBRE2"
    const parts = fullName.split(',').map((part) => part.trim());
    
    if (parts.length >= 2) {
      return {
        apellido: parts[0],
        nombre: parts.slice(1).join(' '),
      };
    }
    
    // If no comma, treat entire string as apellido
    return {
      apellido: fullName.trim(),
      nombre: '',
    };
  }

  private chunkText(text: string, chunkSize: number = 6000, overlap: number = 1000): string[] {
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length);
      chunks.push(text.slice(start, end));
      if (end === text.length) break;
      start += chunkSize - overlap;
    }
    return chunks;
  }

  private async getOrCreateSyncRecord(): Promise<LegislaturaSyncDocument> {
    let record = await this.syncModel.findOne({ syncKey: 'main' });
    if (!record) {
      record = await this.syncModel.create({
        syncKey: 'main',
        status: SyncStatus.IDLE,
        syncIntervalMinutes: 15,
      });
    }
    return record;
  }
}
