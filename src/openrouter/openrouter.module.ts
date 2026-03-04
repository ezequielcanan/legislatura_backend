// openrouter/openrouter.module.ts
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { OpenRouterService } from './openrouter.service';

@Module({
  imports: [
    ConfigModule,
    HttpModule.registerAsync({
      useFactory: () => ({
        timeout: 30000,
        maxRedirects: 5,
      }),
    }),
  ],
  providers: [OpenRouterService],
  exports: [OpenRouterService],
})
export class OpenRouterModule {}