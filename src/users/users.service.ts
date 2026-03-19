import { Injectable, ConflictException, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { User, UserDocument, UserRole } from './schema/users.schema';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  private readonly SALT_ROUNDS = 12;
  private readonly MAX_FAILED_ATTEMPTS = 5;
  private readonly LOCK_DURATION = 15 * 60 * 1000; // 15 minutes

  constructor(
    @InjectModel(User.name) private usersModel: Model<UserDocument>,
  ) { }

  async create(createUserDto: CreateUserDto): Promise<UserDocument | User> {
    const existingUser = await this.findByEmail(createUserDto.email);
    if (existingUser) {
      throw new ConflictException('Ya existe una cuenta con ese correo electrónico');
    }

    const hashedPassword = await bcrypt.hash(createUserDto.password, this.SALT_ROUNDS);

    const user = new this.usersModel({
      ...createUserDto,
      password: hashedPassword
    });

    await user.save()

    await this.updateLastLogin(user?._id?.toString())

    return user;
  }

  async createGoogleUser(profile: any): Promise<UserDocument> {
    // Extraer campos soportando ambos formatos:
    // - verifyIdToken payload: profile.email, profile.picture, profile.sub, profile.email_verified
    // - passport/google: profile.emails[0].value, profile.photos[0].value, profile.id, profile.accessToken
    const email =
      profile?.email ??
      profile?.emails?.[0]?.value ??
      profile?._json?.email ??
      undefined;

    if (!email) {
      // No podemos crear usuario sin email
      throw new BadRequestException('Google profile missing email');
    }

    const googleId =
      profile?.id ??
      profile?.sub ??
      profile?._json?.sub ??
      undefined;

    const googleAccessToken =
      profile?.accessToken ??
      profile?.token ??
      profile?._json?.access_token ??
      undefined;

    const rawEmailVerified =
      profile?.email_verified ??
      profile?.emails?.[0]?.verified ??
      profile?._json?.email_verified ??
      false;

    const isEmailVerified = Boolean(rawEmailVerified);

    const emailVerifiedAt = isEmailVerified ? new Date() : null;

    // Nombre de usuario: preferir displayName, sino parte local del email, sino fallback aleatorio
    const usernameFromDisplay = profile?.displayName ?? profile?._json?.name;
    const usernameFromEmail = email.split('@')[0];
    const username =
      usernameFromDisplay ||
      usernameFromEmail ||
      `user-${Math.random().toString(36).slice(2, 9)}`;

    const user = new this.usersModel({
      username,
      email,
      googleId,
      googleAccessToken,
      isEmailVerified,
      emailVerifiedAt,
    });

    return user.save();
  }

  async findByEmail(email: string): Promise<UserDocument | null> {
    return this.usersModel.findOne({ email }).exec();
  }

  async findById(id: string): Promise<UserDocument | null> {
    return this.usersModel.findById(id).exec();
  }

  async findByGoogleId(googleId: string): Promise<UserDocument | null> {
    return this.usersModel.findOne({ googleId }).exec();
  }

  async validateUser(email: string, password: string): Promise<UserDocument | null> {
    const user = await this.findByEmail(email);

    if (!user) {
      return null;
    }

    // Check if account is locked
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new ForbiddenException('La cuenta está temporalmente bloqueada por demasiados intentos fallidos');
    }

    // Check if user has password (Google users might not have one)
    if (!user.password) {
      return null;
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (isPasswordValid) {
      // Reset failed attempts on successful login
      await this.resetFailedAttempts(user._id.toString());
      await this.updateLastLogin(user._id.toString());
      return user;
    } else {
      // Increment failed attempts
      await this.incrementFailedAttempts(user._id.toString());
      return null;
    }
  }

  async update(id: string, updateUserDto: UpdateUserDto): Promise<UserDocument> {
    if (updateUserDto.password) {
      updateUserDto.password = await bcrypt.hash(updateUserDto.password, this.SALT_ROUNDS);
    }

    const user = await this.usersModel
      .findByIdAndUpdate(id, updateUserDto, { new: true })
      .lean()
      .exec();

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async updateRefreshToken(id: string, refreshToken: string): Promise<void> {
    const hashedToken = await bcrypt.hash(refreshToken, this.SALT_ROUNDS);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

    await this.usersModel.findByIdAndUpdate(id, {
      refreshToken: hashedToken,
      refreshTokenExpires: expiresAt,
    });
  }

  async removeRefreshToken(id: string): Promise<void> {
    await this.usersModel.findByIdAndUpdate(id, {
      refreshToken: null,
      refreshTokenExpires: null,
    });
  }

  async validateRefreshToken(id: string, refreshToken: string): Promise<boolean> {
    const user = await this.findById(id);

    if (!user || !user.refreshToken || !user.refreshTokenExpires) {
      return false;
    }

    if (new Date() > user.refreshTokenExpires) {
      return false;
    }

    return bcrypt.compare(refreshToken, user.refreshToken);
  }

  async promoteToAdmin(id: string): Promise<UserDocument> {
    const user = await this.usersModel
      .findByIdAndUpdate(
        id,
        { role: UserRole.ADMIN },
        { new: true }
      )
      .exec();

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async demoteToUser(id: string): Promise<UserDocument> {
    const user = await this.usersModel
      .findByIdAndUpdate(
        id,
        { role: UserRole.USER },
        { new: true }
      )
      .exec();

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  private async incrementFailedAttempts(id: string): Promise<void> {
    const user = await this.findById(id);
    if (!user) return;

    const newAttempts = user.failedLoginAttempts + 1;
    const updateData: any = { failedLoginAttempts: newAttempts };

    if (newAttempts >= this.MAX_FAILED_ATTEMPTS) {
      updateData.lockedUntil = new Date(Date.now() + this.LOCK_DURATION);
    }

    await this.usersModel.findByIdAndUpdate(id, updateData);
  }

  private async resetFailedAttempts(id: string): Promise<void> {
    await this.usersModel.findByIdAndUpdate(id, {
      failedLoginAttempts: 0,
      lockedUntil: null,
    });
  }

  private async updateLastLogin(id: string): Promise<void> {
    const now = new Date();
    await this.usersModel.findByIdAndUpdate(id, {
      lastLoginAt: now,
      $push: { loginHistory: { $each: [now], $slice: -10 } }, // Keep last 10 logins
    });
  }

  async findAll(skip = 0, limit = 10): Promise<{ users: User[]; total: number }> {
    const [users, total] = await Promise.all([
      this.usersModel
        .find()
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.usersModel.countDocuments(),
    ]);

    const usersWithStringId = users.map(user => ({
      ...user,
      _id: user._id.toString(),
    }));

    return { users: usersWithStringId, total };
  }

  async findAllForAdmin(params: {
    page?: number;
    limit?: number;
    search?: string;
  }): Promise<{ users: User[]; total: number; page: number; limit: number; totalPages: number }> {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 10));
    const skip = (page - 1) * limit;
    const search = params.search?.trim();

    const query: any = {};

    if (search) {
      const regex = new RegExp(search, 'i');
      query.$or = [{ email: regex }, { username: regex }, { fullName: regex }];
    }

    const [users, total] = await Promise.all([
      this.usersModel.find(query).lean().exec(),
      this.usersModel.countDocuments(query),
    ]);

    const rolePriority: Record<string, number> = {
      [UserRole.ADMIN]: 0,
      [UserRole.SECRETARY]: 1,
      [UserRole.USER]: 2,
      [UserRole.UNKNOWN]: 3,
    };

    const sortedUsers = users.sort((a, b) => {
      const roleDiff = (rolePriority[a.role] ?? 99) - (rolePriority[b.role] ?? 99);
      if (roleDiff !== 0) return roleDiff;

      const nameA = (a.fullName || a.username || a.email || '').toLowerCase();
      const nameB = (b.fullName || b.username || b.email || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });

    const paginatedUsers = sortedUsers.slice(skip, skip + limit);

    return {
      users: paginatedUsers.map((user) => ({
        ...user,
        _id: user._id.toString(),
      })),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async assignRole(id: string, role: UserRole): Promise<UserDocument> {
    const user = await this.usersModel
      .findByIdAndUpdate(id, { role }, { new: true })
      .exec();

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }


  async setPasswordResetToken(userId: string, token: string, expires: Date): Promise<void> {
    await this.usersModel.findByIdAndUpdate(userId, {
      resetPasswordToken: token,
      resetPasswordExpires: expires,
    });
  }

  async clearPasswordResetToken(userId: string): Promise<void> {
    await this.usersModel.findByIdAndUpdate(userId, {
      resetPasswordToken: null,
      resetPasswordExpires: null,
    });
  }

  async findByResetToken(token: string): Promise<UserDocument | null> {
    return this.usersModel.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: new Date() },
    }).exec();
  }

  async updatePassword(userId: string, newPassword: string): Promise<void> {
    const hashedPassword = await bcrypt.hash(newPassword, this.SALT_ROUNDS);

    await this.usersModel.findByIdAndUpdate(userId, {
      password: hashedPassword,
      failedLoginAttempts: 0, // Reset failed attempts
      lockedUntil: null,
    });
  }

  async setEmailVerificationToken(userId: string, token: string, expires: Date): Promise<void> {
    await this.usersModel.findByIdAndUpdate(userId, {
      emailVerificationToken: token,
      emailVerificationExpires: expires,
    });
  }

  async findByEmailVerificationToken(token: string): Promise<UserDocument | null> {
    return this.usersModel.findOne({
      emailVerificationToken: token,
      emailVerificationExpires: { $gt: new Date() },
    }).exec();
  }

  async verifyEmail(userId: string): Promise<void> {
    await this.usersModel.findByIdAndUpdate(userId, {
      isEmailVerified: true,
      emailVerifiedAt: new Date(),
      emailVerificationToken: null,
      emailVerificationExpires: null,
    });
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.findById(userId);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (!user.password) {
      throw new BadRequestException('User does not have a password set');
    }

    const isValid = await bcrypt.compare(currentPassword, user.password);

    if (!isValid) {
      throw new BadRequestException('Current password is incorrect');
    }

    await this.updatePassword(userId, newPassword);
  }
}