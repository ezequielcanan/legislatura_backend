import { Worker, Job } from 'bullmq';
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MemoryService } from './memory.service';
import { BaseWorker } from 'src/queue/base.worker';

@Injectable()
export class MemoryWorker extends BaseWorker implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly memoryService: MemoryService,
    private readonly configService: ConfigService,
  ) {
    const connection = {
      host: configService.get('REDIS_HOST', 'localhost'),
      port: Number(configService.get('REDIS_PORT', 6379)),
      password: configService.get('REDIS_PASSWORD'),
      db: Number(configService.get('REDIS_DB', 0)),
    };
    // Opciones del worker (ejemplo)
    const opts = {
      concurrency: 3,
      limiter: { max: 5, duration: 1000 },
    };
    super('memory', connection, opts);
  }

  async onModuleInit() {
    // arrancar el worker al iniciar el módulo
    this.start(/* concurrency opcional si querés override */);
    this.worker.on('progress', (job: Job, progress: number | object) => {
      this.logger.debug(`Job ${job.id} progreso: ${progress}`);
    });

    this.worker.on('completed', (job: Job) => {
      this.logger.log(`Job ${job.id} completado exitosamente`);
    });

    this.worker.on('failed', (job: Job | undefined, error: Error) => {
      if (job) {
        this.logger.error(`Job ${job.id} falló: ${error.message}`, error.stack);
      } else {
        this.logger.error(`Job falló sin información: ${error.message}`, error.stack);
      }
    });
    this.logger.log('MemoryWorker iniciado (onModuleInit).');
  }

  async onModuleDestroy() {
    await this.stop();
    this.logger.log('MemoryWorker detenido (onModuleDestroy).');
  }

  protected async handle(job: Job) {
    // normalizar nombre de campo: aceptar ambos para resiliencia
    const { userId, message } = job.data;
    try {
      const result = await this.memoryService.evaluateAndSaveMemory(userId, message)
      return result;
    } catch (error) {
      this.logger.error(`Error procesando memoria ${message?._id}: ${error.message}`, error.stack);
      throw error;
    }
  }
  
}

