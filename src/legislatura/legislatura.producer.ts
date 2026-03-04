import { Inject, Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

@Injectable()
export class LegislaturaProducer {
  private readonly logger = new Logger(LegislaturaProducer.name);

  constructor(@Inject('QUEUE_LEGISLATURA') private readonly queue: Queue) {
    if (!queue) throw new Error('QUEUE_LEGISLATURA not injected properly');
    this.logger.log(`LegislaturaProducer initialized with queue: ${queue.name}`);
  }

  async enqueueProcessExpediente(expedienteId: number) {
    try {
      this.logger.log(`Enqueueing expediente ${expedienteId} for processing`);
      const job = await this.queue.add(
        'process-expediente',
        { expedienteId },
        {
          jobId: `expediente-${expedienteId}`,
          priority: 1,
          removeOnComplete: { age: 3600 * 24 * 7 },
          removeOnFail: { age: 3600 * 24 * 30 },
          attempts: 3,
          backoff: { type: 'exponential', delay: 10000 },
        },
      );
      this.logger.log(`Job ${job.id} added to queue (expedienteId: ${expedienteId})`);
      return job;
    } catch (error) {
      this.logger.error(`Failed to enqueue expediente ${expedienteId}:`, error);
      throw error;
    }
  }

  async getJobStatus(jobId: string) {
    try {
      const job = await this.queue.getJob(jobId);
      if (!job) return { status: 'unknown', job: null };
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
      this.logger.error(`Error getting job status: ${error.message}`);
      throw error;
    }
  }

  async getQueueMetrics() {
    try {
      return await this.queue.getJobCounts();
    } catch (error) {
      this.logger.error(`Error getting queue metrics: ${error.message}`);
      throw error;
    }
  }
}
