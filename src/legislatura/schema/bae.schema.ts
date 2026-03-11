import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type BaeDocument = HydratedDocument<Bae>;

@Schema({ timestamps: true })
export class Bae {
  @Prop({ type: Number, required: true, unique: true, index: true })
  baeId: number;

  @Prop({ type: Number, required: true })
  nroOrden: number;

  @Prop({ type: Number, required: true })
  anoParlamentario: number;

  @Prop({ type: String })
  fechaDesde: string;

  @Prop({ type: Date })
  fechaDesdeDate: Date;

  @Prop({ type: String })
  fechaHasta: string;

  @Prop({ type: Date })
  fechaHastaDate: Date;

  @Prop({ type: Number, default: 0 })
  totalItems: number;

  @Prop({ type: Number, default: 0 })
  newExpedientesAdded: number;

  @Prop({ type: Date })
  syncedAt: Date;
}

export const BaeSchema = SchemaFactory.createForClass(Bae);
BaeSchema.index({ nroOrden: 1, anoParlamentario: 1 }, { unique: true });
