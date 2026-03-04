// base.worker.ts
import { Worker, Job } from 'bullmq';
import { Logger } from '@nestjs/common';

export abstract class BaseWorker {
  protected worker: Worker;
  protected readonly logger = new Logger(this.constructor.name);

  constructor(protected queueName: string, protected connection: any, protected opts: any = {}) { }

  start(concurrency = 1) {
    this.worker = new Worker(
      this.queueName,
      async (job: Job) => this.handle(job),
      { connection: this.connection, concurrency, ...this.opts },
    );

    this.worker.on('completed', job => this.onCompleted(job));
    this.worker.on('failed', (job, err) => this.onFailed(job, err));
    this.worker.on('progress', (job, prog: string | number) => this.onProgress(job, Number(prog)));
    this.worker.on('error', err => this.logger.error('Worker error', err));
  }

  async stop() {
    if (this.worker) await this.worker.close();
  }

  protected onCompleted(job: Job) {
    this.logger.log(`Job ${job.id} completed`);
    // Default: update DB status, emit event to notifier service (no direct gateway use here).
  }

  protected onFailed(job: Job | undefined, err: Error) {
    if (job) {
      this.logger.error(`Job ${job.id} failed: ${err.message}`, err.stack);
      // default dead-letter / store failure reason
    } else {
      this.logger.error(`Failed without job: ${err.message}`);
    }
  }

  protected onProgress(job: Job, progress: number | object) {
    this.logger.debug(`Job ${job.id} progress ${JSON.stringify(progress)}`);
  }

  private async stopWorker() {
    if (this.worker) {
      await this.worker.close();
      this.logger.log('Worker de avatares detenido');
    }
  }

  async pauseWorker() {
    if (this.worker) {
      await this.worker.pause();
      this.logger.log('Worker pausado');
    }
  }

  async resumeWorker() {
    if (this.worker) {
      await this.worker.resume();
      this.logger.log('Worker reanudado');
    }
  }

  async getWorkerStatus() {
    if (!this.worker) {
      return { isRunning: false };
    }

    const isPaused = await this.worker.isPaused();

    return {
      isRunning: true,
      isPaused,
      name: this.worker.name,
      opts: this.worker.opts,
    };
  }

  // override this
  protected abstract handle(job: Job): Promise<any>;
}
