import { forwardRef, Module } from '@nestjs/common';
import { QueueModule } from 'src/queue/queue.module';
import { MemoryService } from './memory.service';
import { MemoryProducer } from './memory.producer';
import { MemoryWorker } from './memory.worker';
import { ChatModule } from 'src/chat/chat.module';
import { MongooseModule } from '@nestjs/mongoose';
import { MemorySchema } from './schema/memory.schema';
import { EmbeddingSchema } from 'src/embedding/schema/embedding.schema';
import { MessageSchema } from 'src/message/schema/message.schema';
import { ConversationSchema } from 'src/conversation/schema/conversation.schema';
import { OpenRouterModule } from 'src/openrouter/openrouter.module';

@Module({
  imports: [
    QueueModule.register([{ name: 'memory', defaultJobOptions: { /* ... */ } }], { host: process.env.REDIS_HOST, port: process.env.REDIS_PORT }),
    forwardRef(() => ChatModule),
    MongooseModule.forFeature([
      { name: 'Conversation', schema: ConversationSchema },
      { name: 'Message', schema: MessageSchema },
      { name: 'Embedding', schema: EmbeddingSchema },
      { name: 'Memory', schema: MemorySchema },
    ]),
    OpenRouterModule
  ],
  providers: [MemoryService, MemoryWorker, MemoryProducer],
  exports: [MemoryService, MemoryProducer],
})
export class MemoryModule {

}
