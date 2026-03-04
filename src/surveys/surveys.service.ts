// src/surveys/surveys.service.ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Survey, SurveyDocument, SurveyStatus } from './schema/survey.schema';
import { PublishSurveyDto } from './dto/create-survey.dto';

@Injectable()
export class SurveysService {
  private readonly logger = new Logger(SurveysService.name);

  constructor(
    @InjectModel(Survey.name) private surveyModel: Model<SurveyDocument>,
  ) {}

  /**
   * Busca encuestas con filtros
   */
  async findAll(filters: {
    category?: string;
    isPremium?: boolean;
    isPublished?: boolean;
    limit?: number;
    skip?: number;
  }): Promise<{ surveys: SurveyDocument[]; total: number }> {
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

    const [surveys, total] = await Promise.all([
      this.surveyModel
        .find(query)
        .sort({ generatedAt: -1 })
        .skip(filters.skip || 0)
        .limit(filters.limit || 20)
        .populate('generatedBy', 'name email')
        .lean()
        .exec(),
      this.surveyModel.countDocuments(query),
    ]);

    return { surveys, total };
  }

  /**
   * Obtiene una encuesta por ID
   */
  async findOne(id: string): Promise<SurveyDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('ID de encuesta inválido');
    }

    const survey = await this.surveyModel
      .findOne({ _id: id, deleted: { $ne: true } })
      .populate('generatedBy', 'name email')
      .exec();

    if (!survey) {
      throw new NotFoundException(`Encuesta ${id} no encontrada`);
    }

    // Incrementar contador de vistas
    survey.viewCount += 1;
    await survey.save();

    return survey;
  }

  /**
   * Publica/despublica una encuesta
   */
  async publish(id: string, dto: PublishSurveyDto): Promise<SurveyDocument> {
    const survey = await this.surveyModel.findOne({
      _id: id,
      deleted: { $ne: true },
    });

    if (!survey) {
      throw new NotFoundException(`Encuesta ${id} no encontrada`);
    }

    survey.isPublished = dto.isPublished;
    survey.isPremium = dto.isPremium;
    survey.status = dto.isPublished ? SurveyStatus.PUBLISHED : SurveyStatus.DRAFT;

    if (dto.isPublished && !survey.publishedAt) {
      survey.publishedAt = new Date();
    }

    await survey.save();

    this.logger.log(`Encuesta ${id} actualizada: published=${dto.isPublished}, premium=${dto.isPremium}`);

    return survey;
  }

  /**
   * Elimina (soft delete) una encuesta
   */
  async remove(id: string): Promise<void> {
    const result = await this.surveyModel.updateOne(
      { _id: id },
      { $set: { deleted: true } }
    );

    if (result.modifiedCount === 0) {
      throw new NotFoundException(`Encuesta ${id} no encontrada`);
    }

    this.logger.log(`Encuesta ${id} eliminada`);
  }

  /**
   * Estadísticas de encuestas
   */
  async getStats(): Promise<any> {
    const [total, published, premium, byCategory] = await Promise.all([
      this.surveyModel.countDocuments({ deleted: { $ne: true } }),
      this.surveyModel.countDocuments({ isPublished: true, deleted: { $ne: true } }),
      this.surveyModel.countDocuments({ isPremium: true, deleted: { $ne: true } }),
      this.surveyModel.aggregate([
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