// src/chat/dto/chat.dto.ts
import { IsString, IsNumber, IsOptional, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SendMessageDto {
  @ApiProperty()
  @IsString()
  text: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  model?: string;

  @ApiProperty({ required: false })
  @IsNumber()
  @Min(0)
  @Max(2)
  @IsOptional()
  temperature?: number;

  @ApiProperty({ required: false })
  @IsNumber()
  @Min(1)
  @Max(4000)
  @IsOptional()
  maxTokens?: number;
}