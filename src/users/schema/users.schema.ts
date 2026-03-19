import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";

export enum UserRole {
  USER = 'user',
  ADMIN = 'admin',
  SECRETARY = 'secretary',
  UNKNOWN = 'unknown'
}

@Schema({
  timestamps: true
})
export class User {
  @Prop({ required: true })
  username: string;
  
  @Prop({ type: String, unique: true, required: true, index: true })
  email: string;

  @Prop({ required: function() { return !this.googleId; } })
  password?: string;

  @Prop({ 
    type: String, 
    enum: UserRole, 
    default: UserRole.USER,
    index: true 
  })
  role: UserRole;

  @Prop({ type: String })
  googleId?: string;

  @Prop({ type: String, default: null })
  googleAccessToken?: string;

  @Prop({ type: String, default: null })
  refreshToken?: string;

  @Prop({ type: Date, default: null })
  refreshTokenExpires?: Date;

  @Prop({ type: Boolean, default: false })
  isEmailVerified: boolean;

  @Prop({ type: Date, default: null })
  emailVerifiedAt?: Date;

  @Prop({ type: Date, default: null })
  lastLoginAt?: Date;

  @Prop({ type: [Date], default: [] })
  loginHistory: Date[];

  @Prop({ type: Number, default: 0 })
  failedLoginAttempts: number;

  @Prop({ type: Date, default: null })
  lockedUntil?: Date;

  @Prop({ type: String, default: null })
  resetPasswordToken?: string;

  @Prop({ type: Date, default: null })
  resetPasswordExpires?: Date;

  @Prop({ type: String, default: null })
  emailVerificationToken?: string;

  @Prop({ type: Date, default: null })
  emailVerificationExpires?: Date;

  @Prop({ type: String, default: null, index: true })
  fullName?: string | null;
}

export const UserSchema = SchemaFactory.createForClass(User);
export type UserDocument = HydratedDocument<User>;

UserSchema.virtual('age').get(function(this: any) {
  if (!this.birthDate) return null;
  const today = new Date();
  const birth = new Date(this.birthDate);
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) {
    age--;
  }
  return age;
});

UserSchema.set('toJSON', {
  transform: (_doc, ret: any) => {
    delete ret.password;
    delete ret.refreshToken;
    delete ret.resetPasswordToken;
    delete ret.resetPasswordExpires;

    return ret;
  },
});

UserSchema.index({ email: 1, role: 1 });
UserSchema.index({ googleId: 1 }, { sparse: true });


UserSchema.index({
  fullName: "text",
});