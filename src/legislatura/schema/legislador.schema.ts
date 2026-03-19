import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type LegisladorDocument = HydratedDocument<Legislador>;

@Schema({ timestamps: true })
export class Legislador {
  @Prop({ type: Number, required: true, unique: true, index: true })
  legisladorId: number;

  @Prop({ type: String, required: true })
  apellido: string;

  @Prop({ type: String, required: true })
  nombre: string;

  @Prop({ type: String })
  urlLegislador: string;

  @Prop({ type: String })
  sexo: string;

  @Prop({ type: String })
  bloque: string;

  @Prop({ type: String })
  urlBloque: string;

  @Prop({ type: Number, index: true })
  bloqueId: number;

  @Prop({ type: String })
  bloqueColor: string;

  @Prop({ type: String })
  foto: string;

  @Prop({ type: String })
  fotoS: string;

  @Prop({ type: String })
  fotoM: string;

  @Prop({ type: String })
  bloqueLogo: string;

  @Prop({ type: String })
  bloqueLogoS: string;

  @Prop({ type: String })
  bloqueLogoM: string;

  @Prop({ type: Number })
  idAutor: number;

  @Prop({ type: String })
  fechaInicioMandato: string;

  @Prop({ type: String })
  fechaFinMandato: string;

  @Prop({ type: String })
  cargoRecinto: string;

  @Prop({ type: Number, default: 0 })
  idCargoRecinto: number;

  @Prop({ type: String })
  fechaNacimiento: string;

  @Prop({ type: String })
  telefono: string;

  @Prop({ type: String })
  oficina: string;

  @Prop({ type: Boolean, default: true })
  activo: boolean;

  @Prop({ type: [String], default: [] })
  comisiones: string[];

  @Prop({ type: Object, default: {} })
  metadata: Record<string, any>;
}

export const LegisladorSchema = SchemaFactory.createForClass(Legislador);
LegisladorSchema.index({ legisladorId: 1 }, { unique: true });
LegisladorSchema.index({ bloqueId: 1 });
LegisladorSchema.index({ apellido: 1, nombre: 1 });
LegisladorSchema.index({ activo: 1 });
