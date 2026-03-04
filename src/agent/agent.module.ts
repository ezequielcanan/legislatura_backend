// src/agent/agent.module.ts
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HttpModule } from '@nestjs/axios';
import { AgentService } from './agent.service';
import { Report, ReportSchema } from '../reports/schema/report.schema';
import { Survey, SurveySchema } from '../surveys/schema/survey.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Report.name, schema: ReportSchema },
      { name: Survey.name, schema: SurveySchema },
    ]),
    HttpModule,
  ],
  providers: [AgentService],
  exports: [AgentService],
})
export class AgentModule {}