import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HttpModule } from '@nestjs/axios';
import { Embedding, EmbeddingSchema } from './schema/embedding.schema';
import { EmbeddingService } from './embedding.service';
import { OpenRouterService } from '../openrouter/openrouter.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Embedding.name, schema: EmbeddingSchema },
    ]),
    HttpModule,
  ],
  providers: [EmbeddingService, OpenRouterService],
  exports: [EmbeddingService],
})
export class EmbeddingModule {}
