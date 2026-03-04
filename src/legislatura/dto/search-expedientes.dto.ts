import { IsOptional, IsString, IsDateString, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
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

  @ApiProperty({ required: false, description: 'Filter by bloque ID' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  bloqueId?: number;

  @ApiProperty({ required: false, description: 'Filter by legislador ID' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  legisladorId?: number;

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

  @ApiProperty({ required: false, default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;

  @ApiProperty({ required: false, default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number = 0;
}
