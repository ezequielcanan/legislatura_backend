// src/surveys/dto/create-survey.dto.ts
import { IsString, IsNotEmpty, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateSurveyDto {
  @ApiProperty({
    description: 'Descripción coloquial de la encuesta deseada',
    example: 'Genera una encuesta sobre la percepción de seguridad ciudadana en Buenos Aires',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(20)
  userRequest: string;
}

export class PublishSurveyDto {
  @ApiProperty({ description: 'Hacer pública la encuesta' })
  isPublished: boolean;

  @ApiProperty({ description: 'Marcar como contenido premium' })
  isPremium: boolean;
}