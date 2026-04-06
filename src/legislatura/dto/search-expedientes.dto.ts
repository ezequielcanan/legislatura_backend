import { IsOptional, IsString, IsDateString, IsInt, IsBoolean, IsIn, Min, Max } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class SearchExpedientesDto {
  @ApiProperty({ required: false, description: 'Text search query' })
  @IsOptional()
  @IsString()
  query?: string;

  @ApiProperty({ required: false, description: 'Filter by project type (e.g. Ley, Resolución)' })
  @IsOptional()
  @IsString()
  tipo?: string;

  @ApiProperty({ required: false, description: 'Filter by state' })
  @IsOptional()
  @IsString()
  estado?: string;

  @ApiProperty({ required: false, description: 'Filter by comision URL (e.g. comision/salud)' })
  @IsOptional()
  @IsString()
  comisionUrl?: string;

  @ApiProperty({ required: false, description: 'Filter by bloque ID' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  bloqueId?: number;

  @ApiProperty({ required: false, description: 'Filter by legislador ID (autor or coautor)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  legisladorId?: number;

  @ApiProperty({ required: false, description: 'Filter by autor legislador ID' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  autorId?: number;

  @ApiProperty({ required: false, description: 'Filter by coautor legislador ID' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  coautorId?: number;

  @ApiProperty({ required: false, description: 'Filter by AI tag' })
  @IsOptional()
  @IsString()
  tag?: string;

  @ApiProperty({ required: false, description: 'Filter by AI category' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiProperty({ required: false, description: 'Date from (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiProperty({ required: false, description: 'Date to (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiProperty({ required: false, description: 'Filter by BAE nroOrden (used to scope distinct autores/coautores to a specific BAE)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  nroOrden?: number;

  @ApiProperty({ required: false, description: 'Filter by BAE anoParlamentario (used together with nroOrden)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  anoParlamentario?: number;

  @ApiProperty({ required: false, description: 'Comma-separated BAE refs for combined endpoint (nroOrden-anoParlamentario, e.g. 5-2025,4-2025)' })
  @IsOptional()
  @IsString()
  baes?: string;

  @ApiProperty({ required: false, description: 'Search mode: text (default regex) or exact (match numero exactly)' })
  @IsOptional()
  @IsString()
  @IsIn(['text', 'exact'])
  searchMode?: string;

  @ApiProperty({ required: false, description: 'Filter only expedientes that are propio del BAE (baeSource=true)' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  baeSourceOnly?: boolean;

  @ApiProperty({ required: false, default: 50, minimum: 1, maximum: 2000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2000)
  limit?: number = 50;

  @ApiProperty({ required: false, default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number = 0;
}
