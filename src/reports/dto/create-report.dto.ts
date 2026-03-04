// src/reports/dto/create-report.dto.ts
import { IsString, IsNotEmpty, MinLength, IsBoolean, IsOptional, IsNumber, IsArray } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class CreateReportDto {
  @ApiProperty({
    description: 'Descripción coloquial del informe deseado',
    example: 'Quiero un informe sobre el impacto de las nuevas políticas educativas en zonas rurales',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  userRequest: string;
}

export class PublishReportDto {
  @ApiProperty({ description: 'Hacer público el informe' })
  @IsOptional()
  @IsBoolean()
  isPublished: boolean;

  @ApiProperty({ description: 'Marcar como contenido premium' })
  @IsOptional()
  @IsBoolean()
  isPremium: boolean;
}

export class UploadReportDto {
  @ApiProperty({ description: 'Título del informe' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ description: 'Resumen del informe' })
  @IsString()
  @IsNotEmpty()
  summary: string;

  @ApiProperty({ description: 'Categoría del informe' })
  @IsString()
  @IsNotEmpty()
  category: string;

  @ApiProperty({ description: 'Contenido Premium', required: false })
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  isPremium?: boolean;

  @ApiProperty({ description: 'Publicar inmediatamente', required: false })
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  isPublished?: boolean;

  @ApiProperty({ description: 'Tiempo de lectura estimado', required: false })
  @IsOptional()
  @IsString()
  readTime?: string;

  @ApiProperty({ description: 'Número de páginas', required: false })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  pages?: number;

  @ApiProperty({ description: 'Fuentes y referencias (puede ser string JSON o array)', required: false })
  @IsOptional()
  sources?: string | string[];
}