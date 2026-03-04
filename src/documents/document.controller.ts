// src/documents/document.controller.ts
import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  HttpStatus,
  HttpException,
  Logger,
  Res,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { DocumentService } from './document.service';
import { RagService } from '../rag/rag.service';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ExportPdfDto, SearchDocumentsDto } from './dto/search-documents.dto';
import type { Response } from 'express';
import { Roles } from 'src/common/decorators/roles.decorator';
import { UserRole } from 'src/users/schema/users.schema';

@ApiTags('documents')
@ApiBearerAuth()
@Controller('documents')
@UseGuards(JwtAuthGuard)
@Roles(UserRole.ADMIN, UserRole.USER)
export class DocumentController {
  private readonly logger = new Logger(DocumentController.name);

  constructor(
    private readonly documentService: DocumentService,
    private readonly ragService: RagService,
  ) { }

  @Get('sync/status')
  @ApiOperation({ summary: 'Get synchronization status' })
  async getSyncStatus() {
    return this.documentService.getSyncStatus();
  }

  @Post('sync/trigger')
  @ApiOperation({ summary: 'Trigger manual synchronization' })
  async triggerSync() {
    try {
      const result = await this.documentService.detectChanges();
      return {
        success: true,
        ...result,
      };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Patch('sync/full-processing')
  @ApiOperation({ summary: 'Enable/disable full document processing' })
  async setFullProcessing(@Body() body: { enabled: boolean }) {
    const result = await this.documentService.setFullProcessing(body.enabled);
    return {
      success: true,
      enableFullProcessing: result.enableFullProcessing,
    };
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get RAG statistics' })
  async getStats() {
    return this.ragService.getStats();
  }

  /*@Get('search')
  @ApiOperation({ summary: 'Search documents by query' })
  async searchDocuments(
    @Query('q') query: string,
    @Query('limit') limit: string = '5',
  ) {
    if (!query) {
      throw new HttpException('Query parameter is required', HttpStatus.BAD_REQUEST);
    }

    try {
      const queryVector = await this.documentService['openRouterService'].generateEmbedding(
        query,
      );
      const results = await this.ragService.searchRelevantDocuments(
        query,
        queryVector,
        parseInt(limit),
      );

      return {
        query,
        results,
        count: results.length,
      };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }*/
  @Get('system/stats')
  @ApiOperation({ summary: 'Get system statistics' })
  async getSystemStats() {
    try {
      const stats = await this.documentService.getSystemStats();
      return {
        success: true,
        data: stats,
      };
    } catch (error) {
      throw new HttpException(
        error.message,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get('search')
  @ApiOperation({ summary: 'Search and filter documents' })
  @ApiResponse({
    status: 200,
    description: 'Documents found successfully',
  })
  async searchDocuments(@Query() filters: SearchDocumentsDto) {
    try {
      const result = await this.documentService.searchDocuments(filters);
      return {
        success: true,
        ...result,
      };
    } catch (error) {
      throw new HttpException(
        error.message,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get(':idNorma')
  @ApiOperation({ summary: 'Get document by idNorma' })
  async getDocument(@Param('idNorma') idNorma: string) {
    try {
      const document = await this.documentService.getDocument(
        parseInt(idNorma)
      );
      return {
        success: true,
        document,
      };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.NOT_FOUND);
    }
  }

  @Post(':idNorma/summary')
  @ApiOperation({ summary: 'Generate colloquial summary for document' })
  async generateSummary(@Param('idNorma') idNorma: string) {
    try {
      const result = await this.documentService.generateDocumentSummary(
        parseInt(idNorma)
      );
      return {
        success: true,
        ...result,
      };
    } catch (error) {
      throw new HttpException(
        error.message,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Post('export-pdf')
  @ApiOperation({ summary: 'Export filtered documents as PDF' })
  @ApiResponse({
    status: 200,
    description: 'PDF generated successfully',
    content: {
      'application/pdf': {
        schema: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  async exportPdf(
    @Body() filters: ExportPdfDto,
    @Res() res: Response
  ) {
    try {
      this.logger.log('Generating PDF report...');
      const pdfBuffer = await this.documentService.generatePdfReport(filters);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename=reporte-${Date.now()}.pdf`
      );
      res.setHeader('Content-Length', pdfBuffer.length);

      res.send(pdfBuffer);
    } catch (error) {
      this.logger.error('Error generating PDF:', error);
      throw new HttpException(
        error.message,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }
}