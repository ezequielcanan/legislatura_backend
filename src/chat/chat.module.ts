// src/chat/chat.module.ts
import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConversationSchema } from '../conversation/schema/conversation.schema';
import { MessageSchema } from '../message/schema/message.schema';
import { EmbeddingSchema } from '../embedding/schema/embedding.schema';
import { MemorySchema } from '../memory/schema/memory.schema';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ConversationService } from '../conversation/conversation.service';
import { MessageService } from '../message/message.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { OpenRouterService } from '../openrouter/openrouter.service';
import { HttpModule } from '@nestjs/axios';
import { ChatGateway } from './chat.gateway';
import { AuthModule } from '../auth/auth.module';
import { MemoryService } from '../memory/memory.service';
import { MemoryModule } from '../memory/memory.module';
import { AgentModule } from '../agent/agent.module';
import { AgentService } from '../agent/agent.service';
import { RagModule } from '../rag/rag.module';
import { RagService } from '../rag/rag.service';
import { SurveysModule } from 'src/surveys/surveys.module';
import { ReportsModule } from 'src/reports/reports.module';
import { Report, ReportSchema } from 'src/reports/schema/report.schema';
import { Survey, SurveySchema } from 'src/surveys/schema/survey.schema';

@Module({
  imports: [
    forwardRef(() => AuthModule),
    HttpModule,
    MongooseModule.forFeature([
      { name: 'Conversation', schema: ConversationSchema },
      { name: 'Message', schema: MessageSchema },
      { name: 'Embedding', schema: EmbeddingSchema },
      { name: Survey.name, schema: SurveySchema },
      { name: Report.name, schema: ReportSchema },
    ]),
    forwardRef(() => MemoryModule),
    RagModule,
    SurveysModule,
    ReportsModule
  ],
  controllers: [ChatController],
  providers: [
    ChatService,
    ConversationService,
    MessageService,
    EmbeddingService,
    OpenRouterService,
    ChatGateway,
    AgentService,
  ],
  exports: [ChatService, ChatGateway],
})
export class ChatModule {}