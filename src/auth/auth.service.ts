import { Injectable, UnauthorizedException, ConflictException, BadRequestException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { LoginUserDto } from '../users/dto/login-user.dto';
import { UserRole } from '../users/schema/users.schema';
import { EmailService } from 'src/email/email.service';
import * as crypto from 'crypto';

interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  isEmailVerified: boolean;
}


@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private emailService: EmailService
  ) { }

  async register(createUserDto: CreateUserDto) {
    const user = await this.usersService.create({...createUserDto, role: UserRole.UNKNOWN});

    const tokens = await this.generateTokens(user);
    await this.usersService.updateRefreshToken((user as any)._id.toString(), tokens.refreshToken);

    return {
      user: this.sanitizeUser(user),
      ...tokens,
    };
  }

  async login(loginUserDto: LoginUserDto) {
    const user = await this.usersService.validateUser(loginUserDto.email, loginUserDto.password);

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = await this.generateTokens(user);
    await this.usersService.updateRefreshToken(user._id.toString(), tokens.refreshToken);

    return {
      user: this.sanitizeUser(user),
      ...tokens,
    };
  }

  async googleLogin(profile: any) {
    let user = await this.usersService.findByEmail(profile.email);

    if (!user) {
      user = await this.usersService.createGoogleUser(profile);
    } else if (!user.googleId) {
      // Link Google account to existing user
      user.googleId = profile.id;
      user.googleAccessToken = profile.accessToken;
      await user.save();
    }

    const tokens = await this.generateTokens(user);
    await this.usersService.updateRefreshToken(user._id.toString(), tokens.refreshToken);

    return {
      user: this.sanitizeUser(user),
      ...tokens,
    };
  }

  async logout(userId: string) {
    await this.usersService.removeRefreshToken(userId);
  }

  async refreshTokens(userId: string, refreshToken: string) {
    const user = await this.usersService.findById(userId);

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const isValid = await this.usersService.validateRefreshToken(userId, refreshToken);

    if (!isValid) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const tokens = await this.generateTokens(user);
    await this.usersService.updateRefreshToken(userId, tokens.refreshToken);

    return tokens;
  }

  async validateUser(email: string, password: string) {
    return this.usersService.validateUser(email, password);
  }

  private async generateTokens(user: any) {
    const payload: JwtPayload = {
      sub: user._id.toString(),
      email: user.email,
      role: user.role,
      isEmailVerified: user.isEmailVerified,
    };

    const accessToken = this.jwtService.sign(payload as any, {
      expiresIn: this.configService.get<string>('JWT_EXPIRATION', '15m') as any,
    });

    const refreshToken = this.jwtService.sign(
      { sub: user._id.toString() } as any,
      {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: this.configService.get<string>('JWT_REFRESH_EXPIRATION', '7d') as any,
      },
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: 15 * 60, // 15 minutes in seconds
    };
  }

  private sanitizeUser(user: any) {
    const { password, refreshToken, ...sanitizedUser } = user.toObject ? user.toObject() : user;
    return sanitizedUser;
  }

  async getProfile(userId: string) {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    return this.sanitizeUser(user);
  }

  async requestPasswordReset(email: string): Promise<{ message: string; token?: string | undefined }> {
    const user = await this.usersService.findByEmail(email);

    if (!user) {
      // Por seguridad, no revelamos si el email existe o no
      return { message: 'If an account exists, you will receive a reset email' };
    }

    // Generar token de reset
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hora

    await this.usersService.setPasswordResetToken(
      user._id.toString(),
      resetToken,
      resetTokenExpiry,
    );

    // Enviar email
    await this.emailService.sendPasswordResetEmail(email, resetToken);

    return {
      message: 'If an account exists, you will receive a reset email',
      // En desarrollo, puedes devolver el token (NO en producción)
      token: this.configService.get('NODE_ENV') === 'development' ? resetToken : undefined,
    };
  }

  async resetPassword(token: string, newPassword: string): Promise<{ message: string }> {
    const user = await this.usersService.findByResetToken(token);

    if (!user) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    await this.usersService.updatePassword(user._id.toString(), newPassword);
    await this.usersService.clearPasswordResetToken(user._id.toString());

    return { message: 'Password has been reset successfully' };
  }

  async verifyEmail(token: string): Promise<{ message: string }> {
    const user = await this.usersService.findByEmailVerificationToken(token);

    if (!user) {
      throw new BadRequestException('Invalid or expired verification token');
    }

    await this.usersService.verifyEmail(user._id.toString());

    return { message: 'Email verified successfully' };
  }

  async resendVerificationEmail(email: string): Promise<{ message: string }> {
    const user = await this.usersService.findByEmail(email);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.isEmailVerified) {
      throw new BadRequestException('Email already verified');
    }

    const verificationToken = crypto.randomBytes(32).toString('hex');
    const tokenExpiry = new Date(Date.now() + 86400000); // 24 horas

    await this.usersService.setEmailVerificationToken(
      user._id.toString(),
      verificationToken,
      tokenExpiry,
    );

    await this.emailService.sendVerificationEmail(email, verificationToken);

    return { message: 'Verification email sent' };
  }

  async googleMobileLogin(idToken: string) {
    // Verificar el token de Google usando la API de Google
    const { OAuth2Client } = require('google-auth-library');
    const client = new OAuth2Client(this.configService.get('GOOGLE_CLIENT_ID'));

    try {
      const ticket = await client.verifyIdToken({
        idToken,
        audience: this.configService.get('GOOGLE_CLIENT_ID'),
      });

      const payload = ticket.getPayload();

      // Buscar o crear usuario
      let user = await this.usersService.findByEmail(payload.email);

      if (!user) {
        user = await this.usersService.createGoogleUser({
          id: payload.sub,
          email: payload.email,
          name: payload.name,
          picture: payload.picture,
          email_verified: payload.email_verified,
        });
      } else if (!user.googleId) {
        // Vincular cuenta de Google a usuario existente
        user.googleId = payload.sub;
        await user.save();
      }

      const tokens = await this.generateTokens(user);
      await this.usersService.updateRefreshToken(user._id.toString(), tokens.refreshToken);
      return {
        user: this.sanitizeUser(user),
        ...tokens,
      };
    } catch (error) {
      console.error('verifyIdToken failed:', error); // <-- ver mensaje real
      throw new UnauthorizedException('Invalid Google token');
      throw new UnauthorizedException('Invalid Google token');
    }
  }
}