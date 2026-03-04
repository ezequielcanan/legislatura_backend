// src/rag/rag.module.ts
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HttpModule } from '@nestjs/axios';
import { Embedding, EmbeddingSchema } from '../embedding/schema/embedding.schema';
import { Expediente, ExpedienteSchema } from '../legislatura/schema/expediente.schema';
import { RagService } from './rag.service';
import { OpenRouterService } from '../openrouter/openrouter.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Embedding.name, schema: EmbeddingSchema },
      { name: Expediente.name, schema: ExpedienteSchema },
    ]),
    HttpModule,
  ],
  providers: [RagService, OpenRouterService],
  exports: [RagService],
})
export class RagModule {}