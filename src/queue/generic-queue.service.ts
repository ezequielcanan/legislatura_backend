// generic-queue.service.ts
import { Injectable, Inject, Logger } from '@nestjs/common';
import { Queue, JobsOptions } from 'bullmq';

@Injectable()
export class GenericQueueService<T = any> {
  private readonly logger = new Logger(GenericQueueService.name);

  constructor(@Inject('QUEUE_TARGET') private readonly queue: Queue) {}

  async add(name: string, data: T, opts?: JobsOptions) {
    try {
      const job = await this.queue.add(name, data, opts);
      this.logger.log(`Job ${job.id} en cola ${this.queue.name} (${name})`);
      return job;
    } catch (error) {
      this.logger.error('Error adding job', error);
      throw error;
    }
  }

  async getJob(jobId: string) {
    return this.queue.getJob(jobId);
  }

  // metrics helpers...
}
