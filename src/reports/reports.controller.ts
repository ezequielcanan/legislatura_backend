// src/reports/reports.controller.ts
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
  Res,
  NotFoundException,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiConsumes } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { Observable } from 'rxjs';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { User, UserRole } from '../users/schema/users.schema';
import { ReportsService } from './reports.service';
import { AgentService } from '../agent/agent.service';
import { CreateReportDto, PublishReportDto, UploadReportDto } from './dto/create-report.dto';
import type { Response } from 'express';
import { StorageService } from 'src/storage/storage.service';

@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly agentService: AgentService,
    private readonly storageService: StorageService
  ) { }
  /**
   * SSE: Genera un informe con streaming en tiempo real
   * Solo para administradores
   */
  @Sse('generate')
  @Roles(UserRole.ADMIN, UserRole.SECRETARY)
  @ApiOperation({ summary: 'Generate report with AI streaming (Admin only)' })
  @ApiResponse({ status: 200, description: 'SSE stream of report generation' })
  generateReport(
    @Query() dto: CreateReportDto,
    @Req() req: any,
  ): Observable<MessageEvent> {
    const userId = req.user.userId //"698e34fd91ca7ef6a45d22dc" //req.user.userId;

    if (!dto.userRequest || dto.userRequest.length < 20) {
      throw new HttpException(
        'La descripción debe tener al menos 20 caracteres',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Convertir Observable<string> a Observable<MessageEvent>
    return new Observable<MessageEvent>((subscriber) => {
      const stream = this.agentService.createReportStream(dto.userRequest, userId);

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
   * Sube un informe manualmente (sin IA)
   * Solo para administradores y secretarios
   */
  @Post('upload')
  @Roles(UserRole.ADMIN, UserRole.SECRETARY)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload report manually (Admin/Secretary only)' })
  @ApiResponse({ status: 201, description: 'Report uploaded successfully' })
  async uploadReport(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadReportDto,
    @Req() req: any,
  ) {
    if (!file) {
      throw new BadRequestException('Se requiere un archivo');
    }

    // Validar tipo de archivo
    const allowedMimeTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
    ];

    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException('Tipo de archivo no permitido. Solo PDF, DOC, DOCX');
    }

    // Validar tamaño (10MB máx)
    if (file.size > 10 * 1024 * 1024) {
      throw new BadRequestException('El archivo es muy grande. Máximo 10MB');
    }

    const userId = req.user.userId;

    // Procesar sources si viene como string JSON
    if (typeof dto.sources === 'string') {
      try {
        const parsed = JSON.parse(dto.sources as string);
        dto.sources = Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        dto.sources = [];
      }
    } else if (!Array.isArray(dto.sources)) {
      dto.sources = [];
    }

    const report = await this.reportsService.uploadManualReport(file, dto, userId);

    return {
      success: true,
      message: dto.isPublished ? 'Informe publicado' : 'Informe guardado como borrador',
      report,
    };
  }

  /**
   * Publica/despublica un informe (solo admins)
   */
  @Patch(':id/publish')
  @Roles(UserRole.ADMIN, UserRole.SECRETARY)
  @ApiOperation({ summary: 'Publish/unpublish report (Admin only)' })
  async publish(@Param('id') id: string, @Body() dto: PublishReportDto) {
    console.log('Publish DTO:', dto);
    const report = await this.reportsService.publish(id, dto);

    return {
      success: true,
      message: dto.isPublished ? 'Informe publicado' : 'Informe despublicado',
      report,
    };
  }

  /**
   * Elimina un informe (solo admins)
   */
  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Delete report (Admin only)' })
  async remove(@Param('id') id: string) {
    await this.reportsService.remove(id);

    return {
      success: true,
      message: 'Informe eliminado',
    };
  }

  /*@Get(':id/download')
  @Roles(UserRole.ADMIN, UserRole.USER)
  @ApiOperation({ summary: 'Download report as DOCX' })
  async downloadDocx(@Param('id') id: string, @Res() res: Response) {
    const report = await this.reportsService.findOne(id);

    if (!report.docxBuffer) {
      throw new HttpException('El informe no tiene archivo DOCX disponible', HttpStatus.NOT_FOUND);
    }

    const buffer = Buffer.from(report.docxBuffer);
    const filename = `${report.title.replace(/[^a-z0-9]/gi, '_')}.docx`;

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });

    res.send(buffer);
  }
*/

  /*@Sse(':id/modify')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Modify existing report with AI (Admin only)' })
  modifyReport(
    @Param('id') id: string,
    @Query('request') request: string,
    @Req() req: any,
  ): Observable<MessageEvent> {
    const userId = req.user.userId;

    if (!request || request.length < 10) {
      throw new HttpException(
        'La solicitud de modificación debe ser más específica',
        HttpStatus.BAD_REQUEST,
      );
    }

    return new Observable<MessageEvent>((subscriber) => {
      const stream = this.agentService.modifyReportStream(id, request, userId);

      stream.subscribe({
        next: (data) => {
          const event: MessageEvent = { data, type: 'message' } as MessageEvent;
          subscriber.next(event);
        },
        error: (err) => subscriber.error(err),
        complete: () => subscriber.complete(),
      });
    });
  }*/

  /**
   * Lista todos los informes (con filtros)
   */
  @Get()
  @Roles(UserRole.ADMIN, UserRole.SECRETARY, UserRole.USER, UserRole.UNKNOWN)
  @ApiOperation({ summary: 'Get all reports' })
  async findAll(
    @Query('category') category?: string,
    @Query('isPremium') isPremium?: string,
    @Query('isPublished') isPublished?: string,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
    @Req() req?: any,
  ) {
    const filters: any = {
      category,
      isPremium: isPremium === 'true' ? true : isPremium === 'false' ? false : undefined,
      isPublished: isPublished === 'true' ? true : isPublished === 'false' ? false : undefined,
      limit: limit ? parseInt(limit) : 20,
      skip: skip ? parseInt(skip) : 0,
    };

    // Usuarios no-admin solo ven publicados
    if (req?.user?.role !== UserRole.ADMIN && req?.user?.role !== UserRole.SECRETARY) {
      filters.isPublished = true;
    }

    const result = await this.reportsService.findAll(filters);

    return {
      success: true,
      ...result,
    };
  }

  /**
   * Obtiene un informe por ID
   */
  @Get(':id')
  @Roles(UserRole.ADMIN, UserRole.SECRETARY, UserRole.USER)
  @ApiOperation({ summary: 'Get report by ID' })
  async findOne(@Param('id') id: string, @Req() req: any) {
    const report = await this.reportsService.findOne(id);

    // Verificar acceso
    if (!report.isPublished && req.user.role !== UserRole.ADMIN) {
      throw new HttpException('Informe no disponible', HttpStatus.FORBIDDEN);
    }

    if (report.isPremium && !req.user.isPremium && req.user.role !== UserRole.ADMIN) {
      throw new HttpException('Requiere suscripción Premium', HttpStatus.FORBIDDEN);
    }

    return {
      success: true,
      report,
    };
  }


  @Get(':id/download')
  async getDownloadUrl(@Param('id') id: string) {
    const report = await this.reportsService.findOne(id);
    if (!report) throw new NotFoundException('Reporte no encontrado');
    if (!report.docxPath) throw new NotFoundException('Archivo DOCX no disponible');

    // Pedir URL firmada (o pública) al storage
    // expiracion en segundos (ej 300 = 5 minutos)
    const url = await this.storageService.getSignedUrl(report.docxPath, 300);

    return { url };
  }

  /**
   * Estadísticas de informes
   */
  @Get('stats/overview')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Get reports statistics (Admin only)' })
  async getStats() {
    const stats = await this.reportsService.getStats();

    return {
      success: true,
      stats,
    };
  }
}