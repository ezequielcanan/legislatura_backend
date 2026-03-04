// src/documents/dto/search-documents.dto.ts
import { IsOptional, IsString, IsDateString, IsEnum, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { DocumentType, DocumentArea } from '../schema/document.schema';

export class SearchDocumentsDto {
  @ApiProperty({ required: false, description: 'Texto de búsqueda' })
  @IsOptional()
  @IsString()
  query?: string;

  @ApiProperty({ required: false, enum: DocumentArea })
  @IsOptional()
  @IsEnum(DocumentArea)
  area?: DocumentArea;

  @ApiProperty({ required: false, enum: DocumentType })
  @IsOptional()
  @IsEnum(DocumentType)
  type?: DocumentType;

  @ApiProperty({ required: false, description: 'Fecha documento desde (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  documentDateFrom?: string;

  @ApiProperty({ required: false, description: 'Fecha documento hasta (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  documentDateTo?: string;

  // 🆕 Agregar filtros de fecha de publicación
  @ApiProperty({ required: false, description: 'Fecha publicación desde (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  publicationDateFrom?: string;

  @ApiProperty({ required: false, description: 'Fecha publicación hasta (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  publicationDateTo?: string;

  // Mantener dateFrom/dateTo por compatibilidad (mapear a documentDate)
  @ApiProperty({ required: false, description: 'Fecha desde (YYYY-MM-DD) - alias de documentDateFrom' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiProperty({ required: false, description: 'Fecha hasta (YYYY-MM-DD) - alias de documentDateTo' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiProperty({ required: false, default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;

  @ApiProperty({ required: false, default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number = 0;
}

export class ExportPdfDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  query?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsEnum(DocumentArea)
  area?: DocumentArea;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsEnum(DocumentType)
  type?: DocumentType;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  documentDateFrom?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  documentDateTo?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  publicationDateFrom?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  publicationDateTo?: string;
}

export interface DocumentWithRelevance {
  _id: string;
  nombre: string;
  sumario: string;
  idNorma: number;
  urlNorma: string;
  type: DocumentType;
  area: DocumentArea;
  subarea?: string;
  documentDate?: Date;
  politicalRelevance: number; // 0-100
  status: string;
}