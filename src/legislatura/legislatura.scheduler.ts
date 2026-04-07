import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { LegislaturaService } from './legislatura.service';
import { LegislaturaProducer } from './legislatura.producer';
import { Expediente, ExpedienteDocument, ExpedienteStatus } from './schema/expediente.schema';
import { LegislaturaSync, LegislaturaSyncDocument } from './schema/legislatura-sync.schema';

@Injectable()
export class LegislaturaScheduler {
  private readonly logger = new Logger(LegislaturaScheduler.name);
  private readonly enabled: boolean;

  constructor(
    private readonly legislaturaService: LegislaturaService,
    private readonly legislaturaProducer: LegislaturaProducer,
    private readonly configService: ConfigService,
    @InjectModel(Expediente.name) private readonly expedienteModel: Model<ExpedienteDocument>,
    @InjectModel(LegislaturaSync.name) private readonly syncModel: Model<LegislaturaSyncDocument>,
  ) {
    this.enabled = this.configService.get<boolean>('LEGISLATURA_SYNC_ENABLED', true);
  }

  /**
   * Sync today's expedientes every 15 minutes
   */
  //@Cron('*/15 * * * *', {
    //name: 'legislaturaTodaySync',
    //timeZone: 'America/Argentina/Buenos_Aires',
  //})
  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleTodaySync() {
    if (!this.enabled) {
      this.logger.debug('Legislatura sync disabled');
      return;
    }

    try {
      this.logger.log('Starting scheduled sync of today expedientes...');

      const syncStatus = await this.syncModel.findOne({ syncKey: 'main' }).lean().exec();
      if (syncStatus?.status === 'running') {
        this.logger.warn('Sync already running, skipping...');
        return;
      }

      const result = await this.legislaturaService.syncTodayExpedientes();
      this.logger.log(
        `Today sync completed: ${result.newExpedientes} new, ${result.totalFound} total found`,
      );
    } catch (error) {
      this.logger.error('Scheduled today sync failed:', error);
    }
  }

  /**
   * Sync bloques and legisladores daily at 05:00 AM Buenos Aires time
   */
  //@Cron(CronExpression.EVERY_10_SECONDS)
  @Cron('0 5 * * *', {
    name: 'legislaturaFullSync',
    timeZone: 'America/Argentina/Buenos_Aires',
  })
  async handleDailyFullSync() {
    if (!this.enabled) return;

    try {
      this.logger.log('Starting daily full sync (bloques + legisladores)...');

      const bloquesResult = await this.legislaturaService.syncBloques();
      this.logger.log(`Bloques synced: ${bloquesResult.synced} bloques`);

      const legisladoresResult = await this.legislaturaService.syncLegisladores();
      this.logger.log(`Legisladores synced: ${legisladoresResult.synced} legisladores`);
    } catch (error) {
      this.logger.error('Daily full sync failed:', error.message);
    }
  }

  /**
   * Retry failed expedientes every 5 minutes
   */
  @Cron('*/5 * * * *', {
    name: 'legislaturaRetryFailed',
    timeZone: 'America/Argentina/Buenos_Aires',
  })
  async handleRetryFailed() {
    if (!this.enabled) return;

    try {
      const retryThreshold = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago

      const failedExpedientes = await this.expedienteModel
        .find({
          status: ExpedienteStatus.FAILED,
          retryCount: { $lt: 3 },
          $or: [
            { lastRetryAt: { $exists: false } },
            { lastRetryAt: { $lt: retryThreshold } },
          ],
        })
        .limit(10)
        .exec();

      if (failedExpedientes.length === 0) return;

      this.logger.log(`Retrying ${failedExpedientes.length} failed expedientes...`);

      for (const exp of failedExpedientes) {
        const jobStatus = await this.legislaturaProducer.getJobStatus(
          `expediente-${exp.expedienteId}`,
        );

        if (jobStatus.status === 'active' || jobStatus.status === 'waiting') {
          this.logger.debug(`Expediente ${exp.expedienteId} already in queue, skipping`);
          continue;
        }

        await exp.updateOne({
          $inc: { retryCount: 1 },
          $set: { lastRetryAt: new Date(), status: ExpedienteStatus.PENDING },
        });

        await this.legislaturaProducer.enqueueProcessExpediente(exp.expedienteId);
      }

      this.logger.log(`Enqueued ${failedExpedientes.length} expedientes for retry`);
    } catch (error) {
      this.logger.error('Retry failed expedientes error:', error);
    }
  }

  /**
   * Weekly stats logging
   */
  @Cron('0 6 * * 1', {
    name: 'legislaturaWeeklyStats',
    timeZone: 'America/Argentina/Buenos_Aires',
  })
  async handleWeeklyStats() {
    if (!this.enabled) return;

    try {
      const stats = await this.legislaturaService.getStats();
      this.logger.log('=== Weekly Legislatura Stats ===');
      this.logger.log(`Expedientes: ${stats.totalExpedientes} total, ${stats.completedExpedientes} completed, ${stats.failedExpedientes} failed`);
      this.logger.log(`Legisladores: ${stats.totalLegisladores} | Bloques: ${stats.totalBloques}`);
      this.logger.log(`Embeddings: ${stats.totalEmbeddings}`);
      this.logger.log('================================');
    } catch (error) {
      this.logger.error('Weekly stats failed:', error);
    }
  }

  /**
   * Sync giros (comisiones) for recent expedientes daily at 03:00 AM Buenos Aires time.
   * Re-fetches commission assignments for expedientes from the last 6 months so the
   * filter-by-comision always reflects the latest data from the external API.
   */
  @Cron('0 3 * * *', {
    name: 'legislaturaGirosSync',
    timeZone: 'America/Argentina/Buenos_Aires',
  })
  async handleGirosSync() {
    if (!this.enabled) return;

    try {
      this.logger.log('Starting daily giros+ubicacion sync...');
      const girosResult = await this.legislaturaService.syncGirosForRecentExpedientes(6, 0);
      this.logger.log(`Giros+ubicacion sync completed: ${girosResult.updated}/${girosResult.total} expedientes updated`);

      this.logger.log('Starting missing sumario re-sync...');
      const sumarioResult = await this.legislaturaService.syncMissingSumariosForRecentExpedientes(6, 0);
      this.logger.log(`Missing sumario sync completed: ${sumarioResult.updated}/${sumarioResult.total} expedientes updated`);
    } catch (error: any) {
      this.logger.error('Daily giros+ubicacion sync failed:', error.message);
    }
  }

  /**
   * Check for new BAE every day at 08:00 AM Buenos Aires time.
   * BAEs are published roughly every 1-2 weeks.
   */
  @Cron('0 8 * * *', {
    name: 'legislaturaBaeSync',
    timeZone: 'America/Argentina/Buenos_Aires',
  })
  async handleBaeSync() {
    if (!this.enabled) return;

    try {
      this.logger.log('Checking for new BAE...');
      const result = await this.legislaturaService.syncLatestBae();
      if (result.synced) {
        this.logger.log(`New BAE found and synced: ${result.nroOrden}-${result.anoParlamentario}, ${result.newExpedientes} new expedientes`);
      } else {
        this.logger.log('No new BAE found');
      }
    } catch (error) {
      this.logger.error('BAE sync failed:', error.message);
    }
  }
}
