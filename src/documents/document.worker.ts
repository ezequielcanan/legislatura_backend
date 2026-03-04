// src/documents/document.worker.ts (actualizado con más logging)
import { Worker, Job } from 'bullmq';
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentService } from './document.service';
import { BaseWorker } from '../queue/base.worker';

@Injectable()
export class DocumentWorker extends BaseWorker implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly documentService: DocumentService,
    private readonly configService: ConfigService,
  ) {
    const connection = {
      host: configService.get('REDIS_HOST', 'localhost'),
      port: Number(configService.get('REDIS_PORT', 6379)),
      password: configService.get('REDIS_PASSWORD'),
      db: Number(configService.get('REDIS_DB', 0)),
    };

    const opts = {
      concurrency: 8,
      limiter: { max: 48, duration: 20000 },
    };

    super('document', connection, opts);
  }

  async onModuleInit() {
    try {
      this.start(8); // Concurrency 2

      // Verificar que el worker está escuchando
      this.logger.log(`Worker listening on queue: ${this.worker.name}`);

      // Log de eventos del worker
      this.worker.on('progress', (job: Job, progress: number | object) => {
        this.logger.debug(`Job ${job.id} progress: ${JSON.stringify(progress)}`);
      });

      this.worker.on('completed', (job: Job, result: any) => {
        this.logger.log(`✅ Document ${job.data.idNorma} processed successfully`);
        this.logger.debug(`Result: ${JSON.stringify(result)}`);
      });

      this.worker.on('failed', (job: Job | undefined, error: Error) => {
        if (job) {
          this.logger.error(`❌ Document processing failed for ${job.data.idNorma}: ${error.message}`);
          this.logger.error(error.stack);
        } else {
          this.logger.error(`❌ Job failed without info: ${error.message}`);
        }
      });

      this.worker.on('active', (job: Job) => {
        this.logger.log(`🔄 Processing job ${job.id} (idNorma: ${job.data.idNorma})`);
      });

      this.worker.on('error', (err) => {
        this.logger.error('Worker error:', err);
      });

      // Verificar conexión Redis
      await this.worker.waitUntilReady();
      this.logger.log('✅ DocumentWorker connected to Redis and ready');

    } catch (error) {
      this.logger.error('❌ Failed to initialize DocumentWorker:', error);
      throw error;
    }
  }

  async onModuleDestroy() {
    await this.stop();
    this.logger.log('DocumentWorker stopped');
  }

  protected async handle(job: Job) {
    const { idNorma } = job.data;

    this.logger.log(`📥 Handling job ${job.id} for document ${idNorma}`);

    try {
      await job.updateProgress(10);

      if (job.attemptsMade > 1) {
        await this.documentService['documentModel'].updateOne(
          { idNorma },
          {
            $set: { lastRetryAt: new Date() },
            $inc: { retryCount: 1 }
          }
        );
      }

      const result = await this.documentService.processDocument(idNorma);

      await job.updateProgress(100);

      return {
        success: true,
        idNorma,
        embeddingCount: result.embeddingCount,
        processedAt: result.processedAt,
      };
    } catch (error) {
      this.logger.error(`Error processing document ${idNorma}:`, error);

      await this.documentService['documentModel'].updateOne(
        { idNorma },
        {
          $set: {
            lastRetryAt: new Date(),
            errorMessage: error.message
          }
        }
      );

      throw error;
    }
  }
}