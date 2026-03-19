import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { BaseWorker } from '../queue/base.worker';
import { LegislaturaService } from './legislatura.service';

@Injectable()
export class LegislaturaWorker extends BaseWorker implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly legislaturaService: LegislaturaService,
    private readonly configService: ConfigService,
  ) {
    const connection = {
      host: configService.get('REDIS_HOST', 'localhost'),
      port: Number(configService.get('REDIS_PORT', 6379)),
      password: configService.get('REDIS_PASSWORD'),
      db: Number(configService.get('REDIS_DB', 0)),
    };
    super('legislatura', connection, {
      concurrency: 16,
      limiter: { max: 256, duration: 20000 },
    });
  }

  async onModuleInit() {
    try {
      this.start(16);
      this.logger.log(`Worker listening on queue: ${this.worker.name}`);

      this.worker.on('completed', (job: Job) => {
        this.logger.log(`Expediente ${job.data.expedienteId} processed successfully`);
      });

      this.worker.on('failed', (job: Job | undefined, error: Error) => {
        if (job) {
          this.logger.error(`Expediente processing failed for ${job.data.expedienteId}: ${error.message}`);
        } else {
          this.logger.error(`Job failed without info: ${error.message}`);
        }
      });

      this.worker.on('active', (job: Job) => {
        this.logger.log(`Processing job ${job.id} (expedienteId: ${job.data.expedienteId})`);
      });

      this.worker.on('error', (err) => {
        this.logger.error('Worker error:', err);
      });

      await this.worker.waitUntilReady();
      this.logger.log('LegislaturaWorker connected to Redis and ready');
    } catch (error) {
      this.logger.error('Failed to initialize LegislaturaWorker:', error);
      throw error;
    }
  }

  async onModuleDestroy() {
    await this.stop();
    this.logger.log('LegislaturaWorker stopped');
  }

  protected async handle(job: Job): Promise<any> {
    const { expedienteId } = job.data;
    this.logger.log(`Handling job ${job.id} for expediente ${expedienteId}`);

    try {
      await job.updateProgress(10);
      const result = await this.legislaturaService.processExpediente(expedienteId);
      await job.updateProgress(100);

      return {
        success: true,
        expedienteId,
        embeddingCount: result.embeddingCount,
        processedAt: result.processedAt,
      };
    } catch (error) {
      this.logger.error(`Error processing expediente ${expedienteId}:`, error);
      throw error;
    }
  }
}
