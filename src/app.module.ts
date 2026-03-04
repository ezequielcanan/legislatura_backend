import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { StorageModule } from './storage/storage.module';
import { OpenRouterModule } from './openrouter/openrouter.module';
import { ConversationModule } from './conversation/conversation.module';
import { MessageModule } from './message/message.module';
import { MemoryModule } from './memory/memory.module';
import { EmbeddingModule } from './embedding/embedding.module';
import { BullModule } from '@nestjs/bullmq';
import { ChatModule } from './chat/chat.module';
import { QueueModule } from './queue/queue.module';
import { RagModule } from './rag/rag.module';
import { AgentModule } from './agent/agent.module';
import { LegislaturaModule } from './legislatura/legislatura.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ThrottlerModule.forRoot({
      throttlers: [
        {
          ttl: 60000,
          limit: 10,
        },
      ],
    }),
    ScheduleModule.forRoot(),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD,
        db: parseInt(process.env.REDIS_DB || '0', 10),
      },
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 500,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
      },
    }),
    QueueModule.register(
      [
        { name: 'email' },
        { name: 'legislatura' },
      ],
      { host: process.env.REDIS_HOST, port: process.env.REDIS_PORT }
    ),
    MongooseModule.forRoot(process.env.MONGODB_URI || 'mongodb://localhost:27017/legislatura-caba'),
    UsersModule,
    AuthModule,
    StorageModule,
    OpenRouterModule,
    ChatModule,
    RagModule,
    AgentModule,
    LegislaturaModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule { }