// src/documents/document.producer.ts (actualizado)
import { Inject, Injectable, Logger } from "@nestjs/common";
import { Queue } from "bullmq";

@Injectable()
export class DocumentProducer {
  private readonly logger = new Logger(DocumentProducer.name);

  constructor(@Inject('QUEUE_DOCUMENT') private readonly documentQueue: Queue) {
    // Verificar que la cola existe
    if (!documentQueue) {
      throw new Error('QUEUE_DOCUMENT not injected properly');
    }
    this.logger.log(`DocumentProducer initialized with queue: ${documentQueue.name}`);
  }

  async enqueueProcessDocument(idNorma: number) {
    try {
      this.logger.log(`📬 Enqueueing document ${idNorma} for processing`);

      const job = await this.documentQueue.add(
        'process-document',
        { idNorma },
        {
          jobId: `document-${idNorma}`,
          priority: 1,
          removeOnComplete: { age: 3600 * 24 * 7 },
          removeOnFail: { age: 3600 * 24 * 30 },
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 10000,
          },
        }
      );

      this.logger.log(`✅ Job ${job.id} added to queue (idNorma: ${idNorma})`);
      
      // Verificar estado del job
      const state = await this.getJobStatus(job.id as string);
      //this.logger.debug(`Job state: ${state}`, state);

      return job;
    } catch (error) {
      this.logger.error(`❌ Failed to enqueue document ${idNorma}:`, error);
      throw error;
    }
  }

  async getJobStatus(jobId: string) {
    try {
      const job = await this.documentQueue.getJob(jobId);

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
      this.logger.error(`Error getting job status: ${error.message}`);
      throw error;
    }
  }

  async getQueueMetrics() {
    try {
      const counts = await this.documentQueue.getJobCounts();
      
      this.logger.log(`📊 Queue metrics: ${JSON.stringify(counts)}`);

      return counts;
    } catch (error) {
      this.logger.error(`Error getting queue metrics: ${error.message}`);
      throw error;
    }
  }
}