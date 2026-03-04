// src/surveys/surveys.controller.ts
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Patch,
  Delete,
  UseGuards,
  Req,
  Sse,
  HttpStatus,
  HttpException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../users/schema/users.schema';
import { SurveysService } from './surveys.service';
import { AgentService } from '../agent/agent.service';
import { CreateSurveyDto, PublishSurveyDto } from './dto/create-survey.dto';

@ApiTags('surveys')
@ApiBearerAuth()
@Controller('surveys')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SurveysController {
  constructor(
    private readonly surveysService: SurveysService,
    private readonly agentService: AgentService,
  ) {}

  /**
   * SSE: Genera una encuesta con streaming en tiempo real
   * Solo para administradores
   */
  @Sse('generate')
  @Roles(UserRole.ADMIN, UserRole.SECRETARY)
  @ApiOperation({ summary: 'Generate survey with AI streaming (Admin only)' })
  @ApiResponse({ status: 200, description: 'SSE stream of survey generation' })
  generateSurvey(
    @Query() dto: CreateSurveyDto,
    @Req() req: any,
  ): Observable<MessageEvent> {
    const userId = req.user.userId;

    if (!dto.userRequest || dto.userRequest.length < 20) {
      throw new HttpException(
        'La descripción debe tener al menos 20 caracteres',
        HttpStatus.BAD_REQUEST,
      );
    }

    return new Observable<MessageEvent>((subscriber) => {
      const stream = this.agentService.createSurveyStream(dto.userRequest, userId);

      stream.subscribe({
        next: (data) => {
          const event: MessageEvent = {
            data,
            type: 'message',
          } as MessageEvent;
          subscriber.next(event);
        },
        error: (err) => subscriber.error(err),
        complete: () => subscriber.complete(),
      });
    });
  }

  /**
   * Lista todas las encuestas (con filtros)
   */
  @Get()
  @Roles(UserRole.ADMIN, UserRole.SECRETARY, UserRole.USER)
  @ApiOperation({ summary: 'Get all surveys' })
  async findAll(
    @Query('category') category?: string,
    @Query('isPremium') isPremium?: string,
    @Query('isPublished') isPublished?: string,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
  ) {
    const filters = {
      category,
      isPremium: isPremium === 'true' ? true : isPremium === 'false' ? false : undefined,
      isPublished: isPublished === 'true' ? true : isPublished === 'false' ? false : undefined,
      limit: limit ? parseInt(limit) : 20,
      skip: skip ? parseInt(skip) : 0,
    };

    const result = await this.surveysService.findAll(filters);

    return {
      success: true,
      ...result,
    };
  }

  /**
   * Obtiene una encuesta por ID
   */
  @Get(':id')
  @Roles(UserRole.ADMIN, UserRole.SECRETARY, UserRole.USER)
  @ApiOperation({ summary: 'Get survey by ID' })
  async findOne(@Param('id') id: string) {
    const survey = await this.surveysService.findOne(id);

    return {
      success: true,
      survey,
    };
  }

  /**
   * Publica/despublica una encuesta (solo admins)
   */
  @Patch(':id/publish')
  @Roles(UserRole.ADMIN, UserRole.SECRETARY)
  @ApiOperation({ summary: 'Publish/unpublish survey (Admin only)' })
  async publish(@Param('id') id: string, @Body() dto: PublishSurveyDto) {
    const survey = await this.surveysService.publish(id, dto);

    return {
      success: true,
      message: dto.isPublished ? 'Encuesta publicada' : 'Encuesta despublicada',
      survey,
    };
  }

  /**
   * Elimina una encuesta (solo admins)
   */
  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Delete survey (Admin only)' })
  async remove(@Param('id') id: string) {
    await this.surveysService.remove(id);

    return {
      success: true,
      message: 'Encuesta eliminada',
    };
  }

  /**
   * Estadísticas de encuestas
   */
  @Get('stats/overview')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Get surveys statistics (Admin only)' })
  async getStats() {
    const stats = await this.surveysService.getStats();

    return {
      success: true,
      stats,
    };
  }
}