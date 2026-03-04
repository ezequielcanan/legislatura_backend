// src/documents/documents.module.ts (actualizado)
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HttpModule } from '@nestjs/axios';
import { ScheduleModule } from '@nestjs/schedule';
import { Document, DocumentSchema } from './schema/document.schema';
import { DocumentSync, DocumentSyncSchema } from './schema/document-sync.schema';
import { Embedding, EmbeddingSchema } from '../embedding/schema/embedding.schema';
import { DocumentService } from './document.service';
import { DocumentController } from './document.controller';
import { DocumentProducer } from './document.producer';
import { DocumentWorker } from './document.worker';
import { DocumentScheduler } from './document.scheduler';
import { OpenRouterService } from '../openrouter/openrouter.service';
import { QueueModule } from '../queue/queue.module';
import { RagModule } from '../rag/rag.module';

@Module({
  imports: [
    QueueModule.register([{ name: 'document', defaultJobOptions: { /* ... */ } }], { host: process.env.REDIS_HOST, port: process.env.REDIS_PORT }),
    MongooseModule.forFeature([
      { name: Document.name, schema: DocumentSchema },
      { name: DocumentSync.name, schema: DocumentSyncSchema },
      { name: Embedding.name, schema: EmbeddingSchema },
    ]),
    HttpModule,
    ScheduleModule.forRoot(),
    RagModule,
  ],
  controllers: [DocumentController],
  providers: [
    DocumentService,
    DocumentProducer,
    DocumentWorker,
    DocumentScheduler,
    OpenRouterService,
  ],
  exports: [DocumentService, DocumentProducer],
})
export class DocumentsModule {}