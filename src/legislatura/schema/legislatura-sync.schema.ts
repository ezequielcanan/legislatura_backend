import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type LegislaturaSyncDocument = HydratedDocument<LegislaturaSync>;

export enum SyncStatus {
  IDLE = 'idle',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

@Schema({ timestamps: true })
export class LegislaturaSync {
  @Prop({ type: String, default: 'main', unique: true })
  syncKey: string;

  @Prop({ type: String, enum: Object.values(SyncStatus), default: SyncStatus.IDLE })
  status: SyncStatus;

  @Prop({ type: Date })
  lastSyncStartedAt: Date;

  @Prop({ type: Date })
  lastSyncCompletedAt: Date;

  @Prop({ type: Number, default: 0 })
  totalExpedientesFound: number;

  @Prop({ type: Number, default: 0 })
  newExpedientesDetected: number;

  @Prop({ type: Number, default: 0 })
  expedientesProcessed: number;

  @Prop({ type: Number, default: 0 })
  expedientesFailed: number;

  @Prop({ type: String })
  errorMessage: string;

  @Prop({ type: Number, default: 15 })
  syncIntervalMinutes: number;
}

export const LegislaturaSyncSchema = SchemaFactory.createForClass(LegislaturaSync);
