// src/reports/reports.service.ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Report, ReportDocument, ReportStatus } from './schema/report.schema';
import { PublishReportDto, UploadReportDto } from './dto/create-report.dto';
import { StorageService } from '../storage/storage.service';

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    @InjectModel(Report.name) private reportModel: Model<ReportDocument>,
    private readonly storageService: StorageService,
  ) {}

  /**
   * Sube un informe manualmente (sin IA)
   */
  async uploadManualReport(
    file: Express.Multer.File,
    dto: UploadReportDto,
    userId: string,
  ): Promise<ReportDocument> {
    try {
      // 1. Subir el archivo al storage
      const timestamp = Date.now();
      const sanitizedTitle = dto.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const filePath = `reports/${sanitizedTitle}_${timestamp}.${file.originalname.split('.').pop()}`;

      const uploadResult = await this.storageService.upload(file, filePath, {
        contentType: file.mimetype,
        metadata: {
          title: dto.title,
          category: dto.category,
          uploadedBy: userId,
        },
        public: true,
      });

      // 2. Crear el documento del informe
      const report = new this.reportModel({
        title: dto.title,
        summary: dto.summary,
        content: `# ${dto.title}\n\n${dto.summary}\n\n_Este es un informe cargado manualmente. Para ver el contenido completo, descarga el documento._`,
        category: dto.category,
        readTime: dto.readTime || 'N/A',
        pages: dto.pages || 0,
        sources: dto.sources || [],
        docxPath: uploadResult.key,
        docxMeta: {
          url: uploadResult.url,
          size: uploadResult.size,
          mimeType: uploadResult.mimeType,
        },
        isPremium: dto.isPremium || false,
        isPublished: dto.isPublished || false,
        status: dto.isPublished ? ReportStatus.PUBLISHED : ReportStatus.DRAFT,
        generatedBy: new Types.ObjectId(userId),
        generatedAt: new Date(),
        publishedAt: dto.isPublished ? new Date() : undefined,
        viewCount: 0,
      });

      await report.save();

      this.logger.log(
        `Informe manual "${dto.title}" subido por usuario ${userId}. Status: ${report.status}`,
      );

      return report.toObject();
    } catch (error) {
      this.logger.error('Error subiendo informe manual:', error);
      throw error;
    }
  }

  /**
   * Busca informes con filtros
   */
  async findAll(filters: {
    category?: string;
    isPremium?: boolean;
    isPublished?: boolean;
    limit?: number;
    skip?: number;
  }): Promise<{ reports: ReportDocument[] | any; total: number }> {
    const query: any = { deleted: { $ne: true } };

    if (filters.category) {
      query.category = filters.category;
    }

    if (filters.isPremium !== undefined) {
      query.isPremium = filters.isPremium;
    }

    if (filters.isPublished !== undefined) {
      query.isPublished = filters.isPublished;
    }

    const [reports, total] = await Promise.all([
      this.reportModel
        .find(query)
        .sort({ generatedAt: -1 })
        .skip(filters.skip || 0)
        .limit(filters.limit || 20)
        .populate('generatedBy', 'name email')
        .lean()
        .exec(),
      this.reportModel.countDocuments(query),
    ]);

    return { reports: reports.map(r => ({...r, _id: r?._id?.toString()})), total };
  }

  /**
   * Obtiene un informe por ID
   */
  async findOne(id: string): Promise<ReportDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('ID de informe inválido');
    }

    const report = await this.reportModel
      .findOne({ _id: id, deleted: { $ne: true } })
      .populate('generatedBy', 'name email')
      .exec();

    if (!report) {
      throw new NotFoundException(`Informe ${id} no encontrado`);
    }

    // Incrementar contador de vistas
    report.viewCount += 1;
    await report.save();

    return report?.toObject();
  }

  /**
   * Publica/despublica un informe
   */
  async publish(id: string, dto: PublishReportDto): Promise<ReportDocument> {
    const report = await this.reportModel.findOne({
      _id: id,
      deleted: { $ne: true },
    });

    if (!report) {
      throw new NotFoundException(`Informe ${id} no encontrado`);
    }

    report.isPublished = dto.isPublished;
    report.isPremium = dto.isPremium;
    report.status = dto.isPublished ? ReportStatus.PUBLISHED : ReportStatus.DRAFT;

    if (dto.isPublished && !report.publishedAt) {
      report.publishedAt = new Date();
    }

    await report.save();

    this.logger.log(`Informe ${id} actualizado: published=${dto.isPublished}, premium=${dto.isPremium}`);

    return report?.toObject();
  }

  /**
   * Elimina (soft delete) un informe
   */
  async remove(id: string): Promise<void> {
    const result = await this.reportModel.updateOne(
      { _id: id },
      { $set: { deleted: true } }
    );

    if (result.modifiedCount === 0) {
      throw new NotFoundException(`Informe ${id} no encontrado`);
    }

    this.logger.log(`Informe ${id} eliminado`);
  }

  /**
   * Estadísticas de informes
   */
  async getStats(): Promise<any> {
    const [total, published, premium, byCategory] = await Promise.all([
      this.reportModel.countDocuments({ deleted: { $ne: true } }),
      this.reportModel.countDocuments({ isPublished: true, deleted: { $ne: true } }),
      this.reportModel.countDocuments({ isPremium: true, deleted: { $ne: true } }),
      this.reportModel.aggregate([
        { $match: { deleted: { $ne: true } } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
    ]);

    return {
      total,
      published,
      premium,
      draft: total - published,
      byCategory: byCategory.map((c) => ({ category: c._id, count: c.count })),
    };
  }
}