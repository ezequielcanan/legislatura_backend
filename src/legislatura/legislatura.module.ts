import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HttpModule } from '@nestjs/axios';
import { ScheduleModule } from '@nestjs/schedule';
import { Bloque, BloqueSchema } from './schema/bloque.schema';
import { Legislador, LegisladorSchema } from './schema/legislador.schema';
import { Expediente, ExpedienteSchema } from './schema/expediente.schema';
import { LegislaturaSync, LegislaturaSyncSchema } from './schema/legislatura-sync.schema';
import { Embedding, EmbeddingSchema } from '../embedding/schema/embedding.schema';
import { LegislaturaService } from './legislatura.service';
import { LegislaturaController } from './legislatura.controller';
import { LegislaturaProducer } from './legislatura.producer';
import { LegislaturaWorker } from './legislatura.worker';
import { LegislaturaScheduler } from './legislatura.scheduler';
import { OpenRouterService } from '../openrouter/openrouter.service';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Bloque.name, schema: BloqueSchema },
      { name: Legislador.name, schema: LegisladorSchema },
      { name: Expediente.name, schema: ExpedienteSchema },
      { name: LegislaturaSync.name, schema: LegislaturaSyncSchema },
      { name: Embedding.name, schema: EmbeddingSchema },
    ]),
    HttpModule.register({
      timeout: 30000,
      maxRedirects: 3,
    }),
    ScheduleModule.forRoot(),
  ],
  controllers: [LegislaturaController],
  providers: [
    LegislaturaService,
    LegislaturaProducer,
    LegislaturaWorker,
    LegislaturaScheduler,
    OpenRouterService,
  ],
  exports: [LegislaturaService],
})
export class LegislaturaModule {}
