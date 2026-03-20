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
import { Bae, BaeDocument } from './schema/bae.schema';
import { Embedding, EmbeddingDocument, EmbeddingSourceType, VectorProvider, ChunkType } from '../embedding/schema/embedding.schema';
import { OpenRouterService } from '../openrouter/openrouter.service';
import { PythonRagService } from '../rag/python-rag.service';
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
import { LegislaturaProducer } from './legislatura.producer';
import { SearchExpedientesDto } from './dto/search-expedientes.dto';
import { th } from 'zod/v4/locales';

const API_BASE = 'https://parlamentaria.legislatura.gob.ar';

// Master list of all comisiones (static reference data)
export const COMISIONES_LIST = [
  { idComision: 36, nombre: 'Asuntos Constitucionales', url: 'comision/asuntosconstitucionales' },
  { idComision: 37, nombre: 'Comunicación Social, Medios De Comunicación Y Tecnologías De La Comunicación', url: 'comision/comunicacionsocial' },
  { idComision: 38, nombre: 'Cultura', url: 'comision/cultura' },
  { idComision: 39, nombre: 'Defensa De Consumidores Y Usuarios', url: 'comision/defensadeconsumidoresyusuarios' },
  { idComision: 40, nombre: 'Derechos Humanos, Garantías Y Antidiscriminación', url: 'comision/derechoshumanosgarantiasyantidiscriminacion' },
  { idComision: 41, nombre: 'Desarrollo Económico, Mercosur Y Políticas De Empleo', url: 'comision/desarrolloeconomicomercosurypoliticasdeempleo' },
  { idComision: 42, nombre: 'Descentralización Y Participación Ciudadana', url: 'comision/descentralizacionyparticipacionciudadana' },
  { idComision: 43, nombre: 'Ambiente', url: 'comision/ambiente' },
  { idComision: 44, nombre: 'Educación, Ciencia Y Tecnología', url: 'comision/educacioncienciaytecnologia' },
  { idComision: 45, nombre: 'Justicia', url: 'comision/justicia' },
  { idComision: 47, nombre: 'Mujeres, Géneros Y Diversidades', url: 'comision/mujeresgenerosydiversidades' },
  { idComision: 48, nombre: 'Obras Y Servicios Públicos', url: 'comision/obrasyserviciospublicos' },
  { idComision: 49, nombre: 'Planeamiento Urbano', url: 'comision/planeamientourbano' },
  { idComision: 50, nombre: 'Políticas De Promoción E Integración Social', url: 'comision/politicasdepromocioneintegracionsocial' },
  { idComision: 51, nombre: 'Presupuesto, Hacienda, Administración Financiera Y Política Tributaria', url: 'comision/presupuestohaciendaadministracionfinancieraypoliticatributaria' },
  { idComision: 52, nombre: 'Protección Y Uso Del Espacio Público', url: 'comision/proteccionyusodelespaciopublico' },
  { idComision: 53, nombre: 'Asuntos Metropolitanos Y Relaciones Interjurisdiccionales', url: 'comision/relacionesinterjurisdiccionales' },
  { idComision: 54, nombre: 'Salud', url: 'comision/salud' },
  { idComision: 55, nombre: 'Seguridad', url: 'comision/seguridad' },
  { idComision: 56, nombre: 'Tránsito Y Transporte', url: 'comision/transitoytransporte' },
  { idComision: 57, nombre: 'Turismo Y Deportes', url: 'comision/turismoydeportes' },
  { idComision: 58, nombre: 'Vivienda', url: 'comision/vivienda' },
  { idComision: 59, nombre: 'Junta De Ética, Acuerdos Y Organismos De Control', url: 'comision/juntadeeticaacuerdosyorganismosdecontrol' },
  { idComision: 60, nombre: 'Junta De Interpretación Y Reglamento', url: 'comision/juntadeinterpretacionyreglamento' },
  { idComision: 65, nombre: 'Legislacion General', url: 'comision/legislaciongeneral' },
  { idComision: 66, nombre: 'Legislacion Del Trabajo', url: 'comision/legislaciondeltrabajo' },
  { idComision: 69, nombre: 'Niñez, Adolescencia Y Juventud', url: 'comision/ninezadolescenciayjuventud' },
  { idComision: 70, nombre: 'Discapacidad', url: 'comision/discapacidad' },
  { idComision: 71, nombre: 'Personas Mayores', url: 'comision/personasmayores' },
];

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
    @InjectModel(Bae.name) private baeModel: Model<BaeDocument>,
    private httpService: HttpService,
    private configService: ConfigService,
    private openRouterService: OpenRouterService,
    private pythonRagService: PythonRagService,
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
    return this.bloqueModel.find().sort({ cantidad: -1 }).lean().exec();
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
          fechaNacimiento: d.fecha_nacimiento || '',
          activo: true,
        },
        { upsert: true, new: true },
      );
      synced++;
    }

    this.logger.log(`Synced ${synced} legisladores`);
    return { synced };
  }

  async getLegisladores(bloqueId?: number): Promise<LegisladorDocument[]> {
    const filter: any = { activo: true };
    if (bloqueId) filter.bloqueId = bloqueId;
    return this.legisladorModel.find(filter).sort({ apellido: 1 }).lean().exec();
  }

  async getLegisladoresActivos(): Promise<LegisladorDocument[]> {
    return this.legisladorModel.find({ activo: true }).sort({ apellido: 1 }).lean().exec();
  }

  async getLegisladoresInactivos(): Promise<LegisladorDocument[]> {
    return this.legisladorModel.find({ activo: { $ne: true } }).sort({ apellido: 1 }).lean().exec();
  }

  /**
   * Get distinct authors that have expedientes matching the given filters.
   * Returns a list of { legisladorId, nombre, apellido } for authors.
   */
  async getDistinctAutores(filters: SearchExpedientesDto): Promise<Array<{ legisladorId: number; nombre: string; apellido: string }>> {
    const baseQuery = await this.buildExpedienteQuery(filters, { skipAutorCoautor: true });
    const result = await this.expedienteModel.aggregate([
      { $match: baseQuery },
      { $match: { 'autor.legisladorId': { $exists: true, $ne: null } } },
      { $group: { _id: '$autor.legisladorId', nombre: { $first: '$autor.nombre' }, apellido: { $first: '$autor.apellido' } } },
      { $sort: { apellido: 1, nombre: 1 } },
    ]).exec();
    return result.map(r => ({ legisladorId: r._id, nombre: r.nombre, apellido: r.apellido }));
  }

  /**
   * Get distinct coauthors that have expedientes matching the given filters.
   */
  async getDistinctCoautores(filters: SearchExpedientesDto): Promise<Array<{ legisladorId: number; nombre: string; apellido: string }>> {
    const baseQuery = await this.buildExpedienteQuery(filters, { skipAutorCoautor: true });
    const result = await this.expedienteModel.aggregate([
      { $match: baseQuery },
      { $unwind: '$coautores' },
      { $match: { 'coautores.legisladorId': { $exists: true, $ne: null } } },
      { $group: { _id: '$coautores.legisladorId', nombre: { $first: '$coautores.nombre' }, apellido: { $first: '$coautores.apellido' } } },
      { $sort: { apellido: 1, nombre: 1 } },
    ]).exec();
    return result.map(r => ({ legisladorId: r._id, nombre: r.nombre, apellido: r.apellido }));
  }

  /**
   * Build a mongo query for expedientes from filters, optionally skipping autor/coautor conditions.
   */
  private async buildExpedienteQuery(
    filters: SearchExpedientesDto,
    options: { skipAutorCoautor?: boolean } = {},
  ): Promise<any> {
    const { query, tipo, estado, comisionUrl, bloqueId, tag, category, dateFrom, dateTo } = filters;
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
    if (comisionUrl) mongoQuery['comisiones.comisionUrl'] = comisionUrl;
    if (tag) mongoQuery.aiTags = tag;
    if (category) mongoQuery.aiCategory = category;

    if (!options.skipAutorCoautor && bloqueId) {
      const legsInBloque = await this.legisladorModel.find({ bloqueId }, { legisladorId: 1 }).lean();
      const legIds = legsInBloque.map((l) => l.legisladorId);
      if (legIds.length) {
        mongoQuery.$and = mongoQuery.$and || [];
        mongoQuery.$and.push({ $or: [{ 'autor.legisladorId': { $in: legIds } }, { 'coautores.legisladorId': { $in: legIds } }] });
      }
    }

    if (dateFrom || dateTo) {
      mongoQuery.fechaIngresoDate = {};
      if (dateFrom) mongoQuery.fechaIngresoDate.$gte = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setUTCHours(23, 59, 59, 999);
        mongoQuery.fechaIngresoDate.$lte = end;
      }
    }

    return mongoQuery;
  }

  /**
   * Ensure legisladors referenced in expedientes exist in the DB.
   * Inserts only those not already present, marking them as inactive.
   */
  async ensureLegisladoresFromExpedientes(): Promise<{ inserted: number }> {
    // Get all distinct legislador IDs from autor and coautores
    const [autores, coautores] = await Promise.all([
      this.expedienteModel.aggregate([
        { $match: { 'autor.legisladorId': { $exists: true, $ne: null } } },
        { $group: { _id: '$autor.legisladorId', nombre: { $first: '$autor.nombre' }, apellido: { $first: '$autor.apellido' } } },
      ]).exec(),
      this.expedienteModel.aggregate([
        { $unwind: '$coautores' },
        { $group: { _id: '$coautores.legisladorId', nombre: { $first: '$coautores.nombre' }, apellido: { $first: '$coautores.apellido' } } },
      ]).exec(),
    ]);

    // Merge into a map
    const allLegisladores = new Map<number, { nombre: string; apellido: string }>();
    for (const a of autores) {
      allLegisladores.set(a._id, { nombre: a.nombre, apellido: a.apellido });
    }
    for (const c of coautores) {
      if (!allLegisladores.has(c._id)) {
        allLegisladores.set(c._id, { nombre: c.nombre, apellido: c.apellido });
      }
    }

    // Find which ones are already in the DB
    const existingIds = new Set(
      (await this.legisladorModel.find({}, { legisladorId: 1 }).lean().exec()).map(l => l.legisladorId),
    );

    let inserted = 0;
    for (const [legId, { nombre, apellido }] of allLegisladores) {
      if (existingIds.has(legId)) continue;
      if (!nombre && !apellido) {
        this.logger.warn(`Skipping legislador ${legId}: missing nombre and apellido`);
        continue;
      }
      await this.legisladorModel.create({
        legisladorId: legId,
        nombre: nombre || 'Desconocido',
        apellido: apellido || 'Desconocido',
        activo: false,
        bloque: '',
        bloqueId: 0,
      });
      inserted++;
    }

    this.logger.log(`Inserted ${inserted} inactive legisladores from expedientes`);
    return { inserted };
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
    //const asd = await this.legislaturaProducer.getQueueMetrics()
    //console.log(asd)


    try {
      await this.syncModel.updateOne(
        { syncKey: 'main' },
        { $set: { status: SyncStatus.RUNNING, lastSyncStartedAt: new Date() } },
      );

      const today = new Date();
      //today.setDate(today.getDate() - 7);

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
        const numero = exp.nro_de_expediente && exp.nro_de_expediente.trim() !== ''
          ? exp.nro_de_expediente.trim()
          : `EXP-${expId}`;

        await this.expedienteModel.create({
          expedienteId: expId,
          numero: numero,
          titulo: exp.titulo || exp.sumario || '',
          sumario: exp.sumario || '',
          tipo: exp.tipo_proyecto_des || '',
          tipoId: exp.id_proyecto_tipo || 0,
          estado: exp.descripcion || '',
          estadoId: exp.id_estado || 0,
          ubicacion: exp.ubicacion_des || '',
          ubicacionId: exp.id_ubicacion || 0,
          fechaIngreso: exp.fch_inicio || '',
          fechaIngresoDate: this.parseDateString(exp.fch_inicio) as any,
          anioParlamentario: exp.anio_parlamentario || '',
          autor,
          coautores,
          url: exp.urlDoc || '',
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

      // Auto-insert legisladores from expedientes that don't exist in DB
      if (newCount > 0) {
        await this.ensureLegisladoresFromExpedientes();
      }

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
      const numero = exp.nro_de_expediente && exp.nro_de_expediente.trim() !== ''
        ? exp.nro_de_expediente.trim()
        : `EXP-${expId}`;

      await this.expedienteModel.create({
        expedienteId: expId,
        numero: numero,
        titulo: exp.titulo || exp.sumario || '',
        sumario: exp.sumario || '',
        tipo: exp.tipo_proyecto_des || '',
        tipoId: exp.id_proyecto_tipo || 0,
        estado: exp.descripcion || '',
        estadoId: exp.id_estado || 0,
        ubicacion: exp.ubicacion_des || '',
        ubicacionId: exp.id_ubicacion || 0,
        fechaIngreso: exp.fch_inicio || '',
        fechaIngresoDate: this.parseDateString(exp.fch_inicio) as any,
        anioParlamentario: exp.anio_parlamentario || '',
        autor,
        coautores,
        url: exp.urlDoc || '',
        status: ExpedienteStatus.PENDING,
      });

      // Enqueue for processing (download PDF, summarize, tag, embed)
      await this.legislaturaProducer.enqueueProcessExpediente(expId);
      newCount++;
    }

    // Auto-insert legisladores from expedientes that don't exist in DB
    if (newCount > 0) {
      await this.ensureLegisladoresFromExpedientes();
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

      // Fetch giros (comisiones)
      const giros = await this.fetchGirosExpediente(expedienteId);
      expediente.comisiones = giros;
      expediente.comisionesUpdatedAt = new Date();

      // Fetch ubicacion actual
      const ubicacionActual = await this.fetchUbicacionActual(expedienteId);
      if (ubicacionActual) {
        expediente.ubicacionActual = ubicacionActual;
        expediente.ubicacionActualUpdatedAt = new Date();
      }

      // Extract PDF text from first available document
      let fullText = '';
      /*for (const libro of libros) {
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
      }*/

      const text = await this.extractTextFromPDF(`${API_BASE}/pages/download.aspx?IdDoc=${expediente?.url}`);
      if (text && text.length > 50) {
        fullText += text + '\n\n';
      }

      //console.log("Snippet", fullText.substring(0, 100));

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

      // Step 3: Create embeddings — index into Qdrant via Python RAG (preferred)
      // or fallback to MongoDB embeddings if Python service is unavailable
      expediente.status = ExpedienteStatus.EMBEDDING;
      await expediente.save();

      let embeddingCount = 0;

      // Try Python RAG service first (indexes into Qdrant + BM25)
      if (this.pythonRagService.isAvailable) {
        try {
          const indexResult = await this.pythonRagService.indexExpediente({
            expedienteId: expediente.expedienteId,
            numero: expediente.numero,
            tipo: expediente.tipo,
            titulo: expediente.titulo || expediente.sumario || '',
            sumario: expediente.sumario || '',
            aiSummary: expediente.aiSummary || '',
            aiTags: expediente.aiTags || [],
            aiCategory: expediente.aiCategory || '',
            fechaIngreso: expediente.fechaIngreso || '',
            pdfText: fullText || '',
            baeSource: expediente.baeSource || false,
            autor: expediente.autor || null,
          });
          embeddingCount = indexResult.indexed;
          this.logger.log(
            `Expediente ${expedienteId} indexed via Python RAG: ${embeddingCount} chunks in ${indexResult.elapsed_ms}ms`,
          );
        } catch (err) {
          this.logger.warn(
            `Python RAG indexing failed for ${expedienteId}, falling back to MongoDB: ${err.message}`,
          );
          // Fallback to MongoDB embeddings below
          embeddingCount = await this.createMongoEmbeddings(expediente, fullText);
        }
      } else {
        // Python RAG not available — use MongoDB embeddings (legacy)
        embeddingCount = await this.createMongoEmbeddings(expediente, fullText);
      }

      expediente.embeddingCount = embeddingCount;

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
    const esTipoResolucion = (expediente.tipo || '').toUpperCase().includes('RESOLUCION');
    const restriccionResolucion = esTipoResolucion
      ? '\n- IMPORTANTE: Al tratarse de un proyecto de resolución, NO utilices expresiones como "el proyecto obliga al Poder Ejecutivo", "ordena al Poder Ejecutivo" ni formulaciones similares que impliquen imposición sobre el Ejecutivo. Usá en su lugar expresiones como "solicita", "insta", "recomienda" u otras apropiadas para resoluciones legislativas.'
      : '';

    const prompt = `Sos un abogado parlamentario senior especializado en técnica legislativa de la Ciudad Autónoma de Buenos Aires, con amplia experiencia en análisis de proyectos legislativos.

Tu tarea es analizar el siguiente proyecto legislativo y devolver una respuesta JSON estructurada con tres campos: summary, tags y category.

───────────────────────────────────────
DATOS DEL PROYECTO
───────────────────────────────────────
Número de expediente: ${expediente.numero}
Tipo de proyecto: ${expediente.tipo}
Sumario oficial: ${expediente.sumario}

Texto completo (puede estar truncado):
${text.substring(0, 4000)}
───────────────────────────────────────

INSTRUCCIONES PARA EL CAMPO "summary":

Redactá un resumen integral, claro y técnico en español que NO supere las 10 líneas y que cubra obligatoriamente los siguientes puntos en este orden:

1. **Objeto del proyecto**: Qué busca lograr o regular.
2. **Modificaciones que introduce**: Si modifica normativa vigente, indicá cuáles y en qué sentido. Si no modifica nada, omití este punto.
3. **Nuevas responsabilidades u obligaciones**: Si crea o introduce nuevas obligaciones, responsabilidades, derechos o cargas para algún sujeto (organismos públicos, ciudadanos, empresas, etc.), detallá cuáles son y a quiénes alcanzan. Si no las hay, omití este punto.
4. **Fundamentos principales**: Resumí las razones o motivaciones centrales que justifican la presentación del proyecto.${restriccionResolucion}

Reglas de redacción:
- Usá un registro formal, preciso y accesible.
- No repitas el número de expediente ni el tipo de proyecto dentro del resumen.
- No uses frases genéricas de relleno.
- Priorizá la información sustantiva por sobre la procedimental.

INSTRUCCIONES PARA EL CAMPO "tags":
- Incluí entre 3 y 8 palabras clave específicas y relevantes en español que permitan clasificar temáticamente el proyecto (por ejemplo: "transporte público", "código urbanístico", "licencia parental").

INSTRUCCIONES PARA EL CAMPO "category":
- Elegí UNA sola categoría de esta lista: seguridad, salud, educacion, transporte, vivienda, economia, cultura, ambiente, tecnologia, trabajo, justicia, servicios_publicos, presupuesto, gobierno, derechos_humanos, otro.

Respondé ÚNICAMENTE con JSON válido, sin markdown, sin explicaciones adicionales, en este formato exacto:
{
  "summary": "...",
  "tags": ["tag1", "tag2", "..."],
  "category": "..."
}`;

    try {
      const response = await this.openRouterService.createChatCompletion(
        [
          {
            role: 'system',
            content: 'Sos un abogado parlamentario senior especializado en técnica legislativa de la Ciudad Autónoma de Buenos Aires. Respondés ÚNICAMENTE con JSON válido, sin markdown ni explicaciones.',
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

  // ─── MONGO EMBEDDINGS FALLBACK ───────────────────────────

  /**
   * Legacy MongoDB DOCUMENT embedding creation (used when Python RAG service is unavailable).
   */
  private async createMongoEmbeddings(expediente: ExpedienteDocument, fullText: string): Promise<number> {
    const expedienteId = expediente.expedienteId;
    const metaPrefix = `Expediente ${expediente.numero} | ${expediente.tipo} | ${expediente.aiCategory || ''}\n${expediente.titulo || expediente.sumario}\n`;

    let embeddingCount = 0;

    // Summary embedding
    const summaryText = [
      metaPrefix,
      `Resumen: ${expediente.aiSummary || expediente.sumario || ''}`,
      expediente.aiTags?.length ? `Tags: ${expediente.aiTags.join(', ')}` : '',
    ].filter(Boolean).join('\n');

    if (summaryText.length > 30) {
      try {
        const vector = await this.openRouterService.generateEmbedding(summaryText);
        await this.embeddingModel.create({
          sourceType: EmbeddingSourceType.DOCUMENT,
          sourceId: expediente._id,
          vector,
          provider: VectorProvider.MONGO,
          model: 'text-embedding-3-small',
          dims: vector.length,
          chunkText: summaryText,
          chunkType: ChunkType.SUMMARY,
          snippet: summaryText.substring(0, 500),
          metadata: {
            expedienteId,
            numero: expediente.numero,
            tipo: expediente.tipo,
            aiTags: expediente.aiTags,
            aiCategory: expediente.aiCategory,
            chunkIndex: 0,
            totalChunks: 1,
            chunkType: 'summary',
            fechaIngreso: this.parseDateString(expediente.fechaIngreso) as any,
            baeSource: expediente.baeSource || false,
          },
          lastIndexedAt: new Date(),
        });
        embeddingCount++;
      } catch (err) {
        this.logger.warn(`Failed to create summary embedding for ${expedienteId}: ${err.message}`);
      }
    }

    // Content chunk embeddings
    if (fullText.length > 20) {
      const contentChunks = this.chunkText(fullText, 1500, 200);
      const totalChunks = contentChunks.length + 1;
      const autorStr = expediente.autor
        ? `${expediente.autor.nombre} ${expediente.autor.apellido}`
        : 'No especificado';

      for (let i = 0; i < contentChunks.length; i++) {
        try {
          const contextPrefix =
            `[Expediente ${expediente.numero} | ${expediente.tipo} | ${expediente.aiCategory || 'Sin categoría'}]\n` +
            `Título: ${(expediente.titulo || expediente.sumario || '').slice(0, 200)}\n` +
            `Autor: ${autorStr} | Fecha: ${expediente.fechaIngreso || ''}\n` +
            `Resumen: ${(expediente.aiSummary || expediente.sumario || '').slice(0, 300)}\n` +
            `[Sección ${i + 1} de ${contentChunks.length}]\n---\n`;

          const enrichedChunk = contextPrefix + contentChunks[i];
          const vector = await this.openRouterService.generateEmbedding(enrichedChunk);
          await this.embeddingModel.create({
            sourceType: EmbeddingSourceType.DOCUMENT,
            sourceId: expediente._id,
            vector,
            provider: VectorProvider.MONGO,
            model: 'text-embedding-3-small',
            dims: vector.length,
            chunkText: enrichedChunk,
            chunkType: ChunkType.CONTENT,
            snippet: contentChunks[i].substring(0, 500),
            metadata: {
              expedienteId,
              numero: expediente.numero,
              tipo: expediente.tipo,
              aiTags: expediente.aiTags,
              aiCategory: expediente.aiCategory,
              chunkIndex: i + 1,
              totalChunks,
              chunkType: 'content',
              fechaIngreso: this.parseDateString(expediente.fechaIngreso) as any,
              baeSource: expediente.baeSource || false,
            },
            lastIndexedAt: new Date(),
          });
          embeddingCount++;
        } catch (err) {
          throw new Error(`Failed to create embedding chunk ${i} for expediente ${expedienteId}: ${err.message}`);
        }
      }
    }

    return embeddingCount;
  }

  // ─── SEARCH & QUERY ─────────────────────────────────────

  async searchExpedientes(filters: SearchExpedientesDto): Promise<{
    expedientes: ExpedienteDocument[];
    total: number;
  }> {
    const {
      query,
      tipo,
      estado,
      comisionUrl,
      bloqueId,
      legisladorId,
      autorId,
      coautorId,
      tag,
      category,
      dateFrom,
      dateTo,
      limit = 50,
      skip = 0,
    } = filters;

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
    if (comisionUrl) mongoQuery['comisiones.comisionUrl'] = comisionUrl;
    if (tag) mongoQuery.aiTags = tag;
    if (category) mongoQuery.aiCategory = category;

    const authorOrConditions: any[] = [];

    if (legisladorId) {
      authorOrConditions.push({ $or: [{ 'autor.legisladorId': legisladorId }, { 'coautores.legisladorId': legisladorId }] });
    }

    if (autorId) {
      authorOrConditions.push({ 'autor.legisladorId': autorId });
    }

    if (coautorId) {
      authorOrConditions.push({ 'coautores.legisladorId': coautorId });
    }

    if (bloqueId) {
      const legsInBloque = await this.legisladorModel.find({ bloqueId }, { legisladorId: 1 }).lean();
      const legIds = legsInBloque.map((l) => l.legisladorId);

      if (legIds.length) {
        authorOrConditions.push({ $or: [{ 'autor.legisladorId': { $in: legIds } }, { 'coautores.legisladorId': { $in: legIds } }] });
      } else {
      }
    }

    if (authorOrConditions.length) {
      mongoQuery.$and = mongoQuery.$and || [];
      mongoQuery.$and = [...mongoQuery.$and, ...authorOrConditions];
    }

    if (dateFrom || dateTo) {
      mongoQuery.fechaIngresoDate = {};
      if (dateFrom) mongoQuery.fechaIngresoDate.$gte = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setUTCHours(23, 59, 59, 999);
        mongoQuery.fechaIngresoDate.$lte = end;

      }
    }

    const [expedientes, total] = await Promise.all([
      this.expedienteModel
        .find(mongoQuery)
        .sort({ fechaIngresoDate: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.expedienteModel.countDocuments(mongoQuery),
    ]);

    return { expedientes, total };
  }

  async getExpedienteById(expedienteId: number): Promise<ExpedienteDocument | null> {
    return this.expedienteModel.findOne({ expedienteId }).lean().exec();
  }

  async getExpedientesByLegislador(legisladorId: number): Promise<ExpedienteDocument[]> {
    return this.expedienteModel
      .find({ $or: [{ 'autor.legisladorId': legisladorId }, { 'coautores.legisladorId': legisladorId }] })
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
        idDoc: l.id_libro || 0,
        nombre: l.titulo || '',
        url: l.id_libroWS || '',
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

  async fetchUbicacionActual(expedienteId: number): Promise<string> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(
          `${API_BASE}/webservices/Json.asmx/GetExpedienteUbicacionActual?IdExpediente=${expedienteId}`,
          { timeout: 15000 },
        ),
      );
      const parsed = this.xmlParser.parse(response.data);
      const ubicaciones = this.ensureArray(parsed?.ArrayOfExpedienteUbicacionActual?.expedienteUbicacionActual);
      return ubicaciones[0]?.ubicacion_des || '';
    } catch (error) {
      this.logger.warn(`Failed to fetch ubicacion actual for expediente ${expedienteId}: ${error.message}`);
      return '';
    }
  }

  async fetchGirosExpediente(expedienteId: number): Promise<Array<{ idComision: number; comisionDes: string; comisionUrl: string; orden: number; giroTipoDes: string }>> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(
          `${API_BASE}/webservices/Json.asmx/GetExpedienteGiros?IdExpediente=${expedienteId}`,
          { timeout: 15000 },
        ),
      );
      const parsed = this.xmlParser.parse(response.data);
      const giros = this.ensureArray(parsed?.ArrayOfExpedienteGiros?.expedienteGiros);

      return giros.map((g: any) => ({
        idComision: parseInt(g.id_comision) || 0,
        comisionDes: g.comision_des || '',
        comisionUrl: g.comision_url || '',
        orden: parseInt(g.orden) || 0,
        giroTipoDes: g.expediente_giro_tipo_des || '',
      }));
    } catch (error) {
      this.logger.warn(`Failed to fetch giros for expediente ${expedienteId}: ${error.message}`);
      return [];
    }
  }

  getComisiones(): typeof COMISIONES_LIST {
    return COMISIONES_LIST;
  }

  /**
   * Re-sync giros (comisiones) and ubicacion actual for expedientes in a date window.
   * @param months - how many months of data to cover
   * @param offsetMonths - shift the window backwards by this many months (0 = up to now)
   */
  async syncGirosForRecentExpedientes(months: number = 6, offsetMonths: number = 0): Promise<{ updated: number; total: number }> {
    const endDate = new Date();
    if (offsetMonths > 0) {
      endDate.setMonth(endDate.getMonth() - offsetMonths);
    }
    const startDate = new Date(endDate);
    startDate.setMonth(startDate.getMonth() - months);

    const expedientes = await this.expedienteModel
      .find({ fechaIngresoDate: { $gte: startDate, $lte: endDate } }, { expedienteId: 1 })
      .lean()
      .exec();

    this.logger.log(`Syncing giros+ubicacion for ${expedientes.length} expedientes (${months}m window, ${offsetMonths}m offset)...`);

    let updated = 0;
    for (const exp of expedientes) {
      try {
        const [giros, ubicacionActual] = await Promise.all([
          this.fetchGirosExpediente(exp.expedienteId),
          this.fetchUbicacionActual(exp.expedienteId),
        ]);
        const updateFields: any = { comisiones: giros, comisionesUpdatedAt: new Date() };
        if (ubicacionActual) {
          updateFields.ubicacionActual = ubicacionActual;
          updateFields.ubicacionActualUpdatedAt = new Date();
        }
        await this.expedienteModel.updateOne(
          { expedienteId: exp.expedienteId },
          { $set: updateFields },
        );
        updated++;
      } catch (err) {
        this.logger.warn(`Failed to sync giros/ubicacion for expediente ${exp.expedienteId}: ${err.message}`);
      }
    }

    this.logger.log(`Giros+ubicacion sync completed: ${updated}/${expedientes.length} updated`);
    return { updated, total: expedientes.length };
  }

  private async extractTextFromPDF(url: string): Promise<string> {
    // First, try as PDF
    try {
      const parser = new PDFParse({ url });
      const result = await parser.getText({ global: true });
      await parser.destroy();
      return result.text;
    } catch (pdfError) {
      this.logger.warn(`PDF extraction failed for ${url}, trying Word format: ${pdfError.message}`);

      // Try as Word document
      try {
        const response = await firstValueFrom(
          this.httpService.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000,
          })
        );

        const result = await mammoth.extractRawText({ buffer: response.data });
        this.logger.log(`Successfully extracted text from Word document: ${url}`);
        return result.value;
      } catch (wordError) {
        throw new Error(`Failed to extract text from PDF: ${pdfError.message}. Also failed as Word: ${wordError.message}`);
      }
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
    dateStr = dateStr.split(' ')[0];
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

  // ─── BAE ─────────────────────────────────────────────────

  /**
   * Fetch BAE metadata (header) from the external API using GET.
   */
  private async fetchBaeHeader(nroOrden: number, anoParlamentario: number): Promise<any | null> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(
          `${API_BASE}/webservices/Json.asmx/GetBAENroAno?nroOrden=${nroOrden}&anoParlamentario=${anoParlamentario}`,
          { timeout: 30000, responseType: 'text' },
        ),
      );
      const parsed = this.xmlParser.parse(typeof response.data === 'string' ? response.data : String(response.data));
      const baes = this.ensureArray(parsed?.ArrayOfBae?.bae);
      return baes[0] || null;
    } catch (error) {
      this.logger.warn(`Failed to fetch BAE header ${nroOrden}-${anoParlamentario}: ${error.message}`);
      return null;
    }
  }

  /**
   * Fetch full expediente basic data from the external API using GetExpedienteDatosBasicos.
   */
  private async fetchExpedienteDatosBasicos(expedienteId: number): Promise<any | null> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(
          `${API_BASE}/webservices/Json.asmx/GetExpedienteDatosBasicos?IdExpediente=${expedienteId}&NumeroOrden=&AnoParlamentario=&IdExpedientes=`,
          { timeout: 30000, responseType: 'text' },
        ),
      );
      const parsed = this.xmlParser.parse(typeof response.data === 'string' ? response.data : String(response.data));
      const items = this.ensureArray(parsed?.ArrayOfExpedienteBasicos?.expedienteBasicos);
      return items[0] || null;
    } catch (error) {
      this.logger.warn(`Failed to fetch datos basicos for expediente ${expedienteId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Fetch BAE items (expedientes list) from the external API using GET.
   */
  private async fetchBaeItems(nroOrden: number, anoParlamentario: number): Promise<any[]> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(
          `${API_BASE}/webservices/Json.asmx/GetBAEDigitalNroAno?nroOrden=${nroOrden}&anoParlamentario=${anoParlamentario}`,
          { timeout: 30000, responseType: 'text' },
        ),
      );
      const parsed = this.xmlParser.parse(typeof response.data === 'string' ? response.data : String(response.data));
      return this.ensureArray(parsed?.ArrayOfBaeItems?.baeItems);
    } catch (error) {
      this.logger.warn(`Failed to fetch BAE items ${nroOrden}-${anoParlamentario}: ${error.message}`);
      return [];
    }
  }

  /**
   * Sync a single BAE by nroOrden and anoParlamentario.
   * Creates/updates the BAE record and processes new expedientes.
   */
  async syncBae(nroOrden: number, anoParlamentario: number): Promise<{ baeId: number; totalItems: number; newExpedientes: number }> {
    this.logger.log(`Syncing BAE ${nroOrden}-${anoParlamentario}...`);

    // Fetch header to confirm it exists
    const header = await this.fetchBaeHeader(nroOrden, anoParlamentario);
    if (!header) {
      throw new Error(`BAE ${nroOrden}-${anoParlamentario} not found`);
    }

    const baeId = parseInt(header.id_bae);

    // Fetch items
    const items = await this.fetchBaeItems(nroOrden, anoParlamentario);
    this.logger.log(`BAE ${nroOrden}-${anoParlamentario}: found ${items.length} items`);

    // Get existing expedientes — index by both expedienteId and numero
    const existingExpedientes = await this.expedienteModel.find(
      {},
      { expedienteId: 1, numero: 1, baeReferences: 1 },
    ).lean().exec();
    const existingByIdMap = new Map<number, any>();
    const existingByNumeroMap = new Map<string, any>();
    for (const e of existingExpedientes) {
      existingByIdMap.set(e.expedienteId, e);
      if (e.numero) existingByNumeroMap.set(e.numero.toUpperCase().replace(/\s+/g, ''), e);
    }

    let newCount = 0;
    for (const item of items) {
      const documentoId = parseInt(item.id_documento);
      if (!documentoId || isNaN(documentoId)) continue;

      const baeRef = { nroOrden, anoParlamentario };

      // Try matching by expedienteId first, then by numero as fallback
      let existing = existingByIdMap.get(documentoId);
      if (!existing && item.nro_de_expediente) {
        const normalizedNumero = String(item.nro_de_expediente).toUpperCase().replace(/\s+/g, '');
        existing = existingByNumeroMap.get(normalizedNumero);
      }

      if (existing) {
        // Expediente already exists — add BAE reference + update BAE metadata
        const alreadyReferenced = (existing.baeReferences || []).some(
          (r: any) => r.nroOrden === nroOrden && r.anoParlamentario === anoParlamentario,
        );
        const updateOps: any = {};
        if (!alreadyReferenced) {
          updateOps.$addToSet = { baeReferences: baeRef };
        }
        // Update BAE-specific fields on existing expedientes
        const setFields: any = {};
        if (item.bae_grupo_des) setFields.baeGrupo = item.bae_grupo_des;
        if (item.orden) setFields.baeOrden = parseInt(item.orden) || 0;
        if (item.descripcion_bae) setFields.baeDescripcion = item.descripcion_bae;
        if (Object.keys(setFields).length > 0) {
          updateOps.$set = setFields;
        }
        if (Object.keys(updateOps).length > 0) {
          await this.expedienteModel.updateOne(
            { _id: existing._id },
            updateOps,
          );
        }
        continue;
      }

      // New expediente from BAE — fetch full data first
      const basicos = await this.fetchExpedienteDatosBasicos(documentoId);

      // Parse autor
      let autor: { legisladorId: number; nombre: string; apellido: string } | undefined = undefined;
      const autorId = basicos?.autor_id ?? item.origen_des;
      const autorDes = basicos?.autor_des;
      if (autorId && autorDes) {
        const autorParsed = this.parseAutorName(String(autorDes));
        autor = {
          legisladorId: parseInt(String(autorId)) || 0,
          nombre: autorParsed.nombre,
          apellido: autorParsed.apellido,
        };
      }

      // Parse coautores — GetExpedienteDatosBasicos uses ';' for both IDs and names
      const coautores: Array<{ legisladorId: number; nombre: string; apellido: string }> = [];
      if (basicos?.coautores_id && basicos?.coautores_des) {
        const coautoresIds = String(basicos.coautores_id).split(';').map((s: string) => s.trim()).filter(Boolean);
        const coautoresNames = String(basicos.coautores_des).split(';').map((s: string) => s.trim()).filter(Boolean);
        for (let i = 0; i < coautoresIds.length && i < coautoresNames.length; i++) {
          const parsed = this.parseAutorName(coautoresNames[i]);
          coautores.push({
            legisladorId: parseInt(coautoresIds[i]) || 0,
            nombre: parsed.nombre,
            apellido: parsed.apellido,
          });
        }
      }

      // Prefer data from basicos, fall back to BAE item fields
      const numero = (basicos?.nro_de_expediente && String(basicos.nro_de_expediente).trim() !== '')
        ? String(basicos.nro_de_expediente).trim()
        : (item.nro_de_expediente && String(item.nro_de_expediente).trim() !== '')
          ? String(item.nro_de_expediente).trim()
          : `EXP-${documentoId}`;

      const sumario = basicos?.sumario || item.descripcion_bae || item.descripcion || '';
      const titulo = sumario;
      const tipo = basicos?.proyecto_tipo_des || this.mapBaeProyectoTipo(parseInt(item.id_proyecto_tipo));
      const fechaIngreso = basicos?.fch_inicio || item.fch_desde || '';
      const anioParlamentarioStr = basicos?.ano_parlamentario ? String(basicos.ano_parlamentario) : String(anoParlamentario);
      const urlDoc = basicos?.urlDoc ? String(basicos.urlDoc) : '';

      await this.expedienteModel.create({
        expedienteId: documentoId,
        numero,
        titulo,
        sumario,
        tipo,
        tipoId: parseInt(item.id_proyecto_tipo) || 0,
        estado: '',
        estadoId: 0,
        ubicacion: '',
        ubicacionId: 0,
        fechaIngreso,
        fechaIngresoDate: this.parseDateString(fechaIngreso) as any,
        anioParlamentario: anioParlamentarioStr,
        autor,
        coautores,
        url: urlDoc,
        status: ExpedienteStatus.PENDING,
        baeSource: true,
        baeReferences: [baeRef],
        baeGrupo: item.bae_grupo_des || '',
        baeOrden: parseInt(item.orden) || 0,
        baeDescripcion: item.descripcion_bae || '',
      });

      // Enqueue for processing using the same pipeline
      await this.legislaturaProducer.enqueueProcessExpediente(documentoId);
      newCount++;
    }

    // Save/update the BAE record
    await this.baeModel.findOneAndUpdate(
      { baeId },
      {
        baeId,
        nroOrden,
        anoParlamentario,
        fechaDesde: header.fch_desde || '',
        fechaDesdeDate: this.parseDateString(header.fch_desde) as any,
        fechaHasta: header.fch_hasta || '',
        fechaHastaDate: this.parseDateString(header.fch_hasta) as any,
        totalItems: items.length,
        newExpedientesAdded: newCount,
        syncedAt: new Date(),
      },
      { upsert: true, new: true },
    );

    this.logger.log(`BAE ${nroOrden}-${anoParlamentario} synced: ${newCount} new expedientes from ${items.length} items`);
    return { baeId, totalItems: items.length, newExpedientes: newCount };
  }

  /**
   * Check if a new BAE has been published for the current year and sync it.
   * Tries the next nroOrden after the latest known one.
   */
  async syncLatestBae(): Promise<{ synced: boolean; nroOrden?: number; anoParlamentario?: number; newExpedientes?: number }> {
    const currentYear = new Date().getFullYear();

    // Find latest BAE for this year
    const latestBae = await this.baeModel
      .findOne({ anoParlamentario: currentYear })
      .sort({ nroOrden: -1 })
      .lean()
      .exec();

    const nextNro = latestBae ? latestBae.nroOrden + 1 : 1;

    this.logger.log(`Checking for new BAE: ${nextNro}-${currentYear}...`);

    // Check if the next BAE exists
    const header = await this.fetchBaeHeader(nextNro, currentYear);
    if (!header) {
      this.logger.log(`No new BAE found (tried ${nextNro}-${currentYear})`);
      return { synced: false };
    }

    // New BAE found — sync it
    const result = await this.syncBae(nextNro, currentYear);
    return {
      synced: true,
      nroOrden: nextNro,
      anoParlamentario: currentYear,
      newExpedientes: result.newExpedientes,
    };
  }

  /**
   * Sync all BAEs for a specific year. Iterates from 1 until no more BAEs are found.
   */
  async syncBaesByYear(anoParlamentario: number): Promise<{ totalBaes: number; totalNewExpedientes: number }> {
    this.logger.log(`Syncing all BAEs for year ${anoParlamentario}...`);

    let nroOrden = 1;
    let totalBaes = 0;
    let totalNewExpedientes = 0;

    while (true) {
      const header = await this.fetchBaeHeader(nroOrden, anoParlamentario);
      if (!header) {
        this.logger.log(`No more BAEs found after ${nroOrden - 1} for year ${anoParlamentario}`);
        break;
      }

      try {
        const result = await this.syncBae(nroOrden, anoParlamentario);
        totalBaes++;
        totalNewExpedientes += result.newExpedientes;
      } catch (err) {
        this.logger.error(`Error syncing BAE ${nroOrden}-${anoParlamentario}: ${err.message}`);
      }

      nroOrden++;
    }

    this.logger.log(`Year ${anoParlamentario}: synced ${totalBaes} BAEs, ${totalNewExpedientes} new expedientes`);
    return { totalBaes, totalNewExpedientes };
  }

  /**
   * Get list of all synced BAEs, ordered by year desc, nroOrden desc.
   */
  async getBaes(anoParlamentario?: number): Promise<BaeDocument[]> {
    const filter: any = {};
    if (anoParlamentario) filter.anoParlamentario = anoParlamentario;
    return this.baeModel.find(filter).sort({ anoParlamentario: -1, nroOrden: -1 }).lean().exec();
  }

  /**
   * Get a single BAE with its associated expedientes.
   */
  async getBaeWithExpedientes(
    nroOrden: number,
    anoParlamentario: number,
    filters: SearchExpedientesDto = {},
  ): Promise<{ bae: BaeDocument | null; expedientes: ExpedienteDocument[]; total: number }> {
    const bae = await this.baeModel
      .findOne({ nroOrden, anoParlamentario })
      .lean()
      .exec();

    const { query, tipo, comisionUrl, bloqueId, legisladorId, autorId, coautorId, limit = 50, skip = 0 } = filters;
    const mongoQuery: any = {
      'baeReferences': { $elemMatch: { nroOrden, anoParlamentario } },
    };

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
    if (comisionUrl) mongoQuery['comisiones.comisionUrl'] = comisionUrl;

    if (legisladorId) {
      mongoQuery.$and = mongoQuery.$and || [];
      mongoQuery.$and.push({
        $or: [
          { 'autor.legisladorId': legisladorId },
          { 'coautores.legisladorId': legisladorId },
        ],
      });
    }

    if (autorId) {
      mongoQuery.$and = mongoQuery.$and || [];
      mongoQuery.$and.push({ 'autor.legisladorId': autorId });
    }

    if (coautorId) {
      mongoQuery.$and = mongoQuery.$and || [];
      mongoQuery.$and.push({ 'coautores.legisladorId': coautorId });
    }

    if (bloqueId) {
      const legsInBloque = await this.legisladorModel.find({ bloqueId }, { legisladorId: 1 }).lean();
      const legIds = legsInBloque.map((l) => l.legisladorId);
      if (legIds.length) {
        mongoQuery.$and = mongoQuery.$and || [];
        mongoQuery.$and.push({
          $or: [
            { 'autor.legisladorId': { $in: legIds } },
            { 'coautores.legisladorId': { $in: legIds } },
          ],
        });
      }
    }

    const [expedientes, total] = await Promise.all([
      this.expedienteModel
        .find(mongoQuery)
        .sort({ baeOrden: 1, fechaIngresoDate: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.expedienteModel.countDocuments(mongoQuery),
    ]);

    return { bae, expedientes, total };
  }

  /**
   * Map BAE id_proyecto_tipo to human-readable tipo string.
   */
  private mapBaeProyectoTipo(tipoId: number): string {
    const map: Record<number, string> = {
      1: 'LEY',
      2: 'RESOLUCION',
      3: 'DECLARACION',
      4: 'HACE CONSIDERACIONES',
      5: 'INTERNO',
      6: 'ESCUELAS',
      7: 'OFICIAL',
      8: 'PARTICULAR',
      9: 'REMITE ACTUACIONES',
    };
    return map[tipoId] || 'NO DEFINIDO';
  }
}
