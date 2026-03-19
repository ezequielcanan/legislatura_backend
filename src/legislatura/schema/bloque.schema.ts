import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type BloqueDocument = HydratedDocument<Bloque>;

@Schema({ timestamps: true })
export class Bloque {
  @Prop({ type: Number, required: true })
  bloqueId: number;

  @Prop({ type: String, required: true })
  nombre: string;

  @Prop({ type: String })
  url: string;

  @Prop({ type: String })
  logo: string;

  @Prop({ type: String })
  logoS: string;

  @Prop({ type: String })
  logoM: string;

  @Prop({ type: Number, default: 0 })
  cantidad: number;

  @Prop({ type: String })
  color: string;

  @Prop({ type: Number, default: 0 })
  percent: number;
}

export const BloqueSchema = SchemaFactory.createForClass(Bloque);
BloqueSchema.index({ bloqueId: 1 }, { unique: true });
BloqueSchema.index({ nombre: 1 });
