// src/rag/rag.module.ts
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HttpModule } from '@nestjs/axios';
import { Embedding, EmbeddingSchema } from '../embedding/schema/embedding.schema';
import { Expediente, ExpedienteSchema } from '../legislatura/schema/expediente.schema';
import { RagService } from './rag.service';
import { PythonRagService } from './python-rag.service';
import { OpenRouterService } from '../openrouter/openrouter.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Embedding.name, schema: EmbeddingSchema },
      { name: Expediente.name, schema: ExpedienteSchema },
    ]),
    HttpModule,
  ],
  providers: [RagService, PythonRagService, OpenRouterService],
  exports: [RagService, PythonRagService],
})
export class RagModule {}