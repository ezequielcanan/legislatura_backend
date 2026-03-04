// src/documents/document.scheduler.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DocumentService } from './document.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class DocumentScheduler {
  private readonly logger = new Logger(DocumentScheduler.name);
  private readonly enabled: boolean;

  constructor(
    private documentService: DocumentService,
    private configService: ConfigService,
  ) {
    this.enabled = this.configService.get<boolean>('DOCUMENT_SYNC_ENABLED', false);
  }

  /**
   * Ejecuta cada 15 minutos (configurable)
   */
  @Cron('0 0 5 * * *', {
    name: 'documentSync',
    timeZone: 'America/Argentina/Buenos_Aires', // opcional: asegura que sea 09:00 hora de Argentina
  })
  async handleDocumentSync() {
    if (!this.enabled) {
      this.logger.debug('Document sync is disabled');
      return;
    }

    try {
      this.logger.log('Starting scheduled document sync...');

      const syncStatus = await this.documentService.getSyncStatus();

      // Evitar ejecuciones concurrentes
      if (syncStatus.status === 'running') {
        this.logger.warn('Sync already running, skipping...');
        return;
      }

      const result = await this.documentService.detectChanges();

      this.logger.log(
        `Sync completed: ${result.newDocuments} new documents found, ` +
        `${result.totalFound} total documents`
      );

      if (result.newDocuments > 0) {
        this.logger.log(
          `Processing mode: ${result.shouldProcessAll ? 'ALL' : 'ONE'} document(s)`
        );
      }
    } catch (error) {
      this.logger.error('Scheduled document sync failed:');
    }
  }

  /**
   * Limpieza de documentos fallidos cada día
   */
  @Cron('*/5 * * * *') // 🆕 Cada 5 minutos, NO cada 10 segundos
  async handleFailedDocumentsRetry() {
    if (!this.enabled) return;

    try {
      this.logger.log('Checking for failed documents to retry...');

      const customMinutes = new Date(Date.now() - 30 * 60 * 1000); // 🆕 30 minutos

      const failedDocs = await this.documentService['documentModel']
        .find({
          status: 'failed',
          retryCount: { $lt: 3 },
          $or: [
            { lastRetryAt: { $exists: false } },
            { lastRetryAt: { $lt: customMinutes } }
          ]
        })
        .limit(5)
        .exec();

      if (failedDocs.length === 0) {
        this.logger.log('No failed documents to retry');
        return;
      }

      this.logger.log(`Retrying ${failedDocs.length} failed documents`);

      for (const doc of failedDocs) {
        const existingJob = await this.documentService['documentProducer']
          .getJobStatus(`document-${doc.idNorma}`);

        if (existingJob.status === 'active' || existingJob.status === 'waiting') {
          this.logger.log(`Document ${doc.idNorma} already in queue, skipping`);
          continue;
        }

        await this.documentService['documentProducer'].enqueueProcessDocument(
          doc.idNorma
        );
      }

      this.logger.log(`Enqueued ${failedDocs.length} documents for retry`);
    } catch (error) {
      this.logger.error('Failed documents retry failed:', error);
    }
  }

  /**
   * Estadísticas semanales
   */
  @Cron(CronExpression.EVERY_WEEK)
  async handleWeeklyStats() {
    if (!this.enabled) return;

    try {
      const stats = await this.documentService['documentModel'].aggregate([
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
      ]);

      const totalEmbeddings = await this.documentService['embeddingModel'].countDocuments({
        sourceType: 'document',
      });

      this.logger.log('=== Weekly Document Stats ===');
      stats.forEach((stat) => {
        this.logger.log(`${stat._id}: ${stat.count}`);
      });
      this.logger.log(`Total embeddings: ${totalEmbeddings}`);
      this.logger.log('============================');
    } catch (error) {
      this.logger.error('Weekly stats failed:', error);
    }
  }
}