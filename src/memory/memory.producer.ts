import { Inject, Injectable, Logger } from "@nestjs/common";
import { Queue } from "bullmq";
import { Types } from "mongoose";

@Injectable()
export class MemoryProducer {
  private readonly logger = new Logger(MemoryProducer.name);

  constructor(@Inject('QUEUE_MEMORY') private readonly memoryQueue: Queue) { }

  async enqueueGenerate(userId: Types.ObjectId, message: any) {
    return this.memoryQueue.add('save-memory', { userId, message }, {
      jobId: `memory-${message?._id}`,
      priority: 1,
      removeOnComplete: { age: 3600 * 24 * 7 },
    });
  }

  async getJobStatus(jobId: string) {
    try {
      const job = await this.memoryQueue.getJob(jobId);

      if (!job) {
        return { status: 'unknown', job: null };
      }

      const state = await job.getState();

      return {
        status: state,
        job: {
          id: job.id,
          data: job.data,
          progress: job.progress,
          attemptsMade: job.attemptsMade,
          failedReason: job.failedReason,
          timestamp: job.timestamp,
          processedOn: job.processedOn,
          finishedOn: job.finishedOn,
        },
      };
    } catch (error) {
      this.logger.error(`Error obteniendo estado del job: ${error.message}`);
      throw error;
    }
  }

  async cleanOldJobs() {
    try {
      // Limpiar jobs completados hace más de 7 días
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      await this.memoryQueue.clean(sevenDays, 1000, 'completed');

      // Limpiar jobs fallidos hace más de 30 días
      await this.memoryQueue.clean(30 * 24 * 60 * 60 * 1000, 1000, 'failed');

      this.logger.log('Jobs antiguos limpiados exitosamente');
    } catch (error) {
      this.logger.warn(`Error limpiando jobs antiguos: ${error.message}`);
    }
  }

  async getQueueMetrics() {
    try {
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        this.memoryQueue.getWaitingCount(),
        this.memoryQueue.getActiveCount(),
        this.memoryQueue.getCompletedCount(),
        this.memoryQueue.getFailedCount(),
        this.memoryQueue.getDelayedCount(),
      ]);

      return {
        waiting,
        active,
        completed,
        failed,
        delayed,
        total: waiting + active + completed + failed + delayed,
      };
    } catch (error) {
      this.logger.error(`Error obteniendo métricas: ${error.message}`);
      throw error;
    }
  }
}
