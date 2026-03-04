// src/messages/dto/message.dto.ts
import { IsString, IsEnum, IsOptional, IsObject } from 'class-validator';
import { MessageRole } from '../schema/message.schema';
import { ApiProperty } from '@nestjs/swagger';

export class CreateMessageDto {
  @ApiProperty()
  @IsString()
  conversationId: string;

  @ApiProperty({ required: false, enum: MessageRole })
  @IsEnum(MessageRole)
  @IsOptional()
  role?: MessageRole;

  @ApiProperty()
  @IsString()
  text: string;

  @ApiProperty({ required: false })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, any>;
}