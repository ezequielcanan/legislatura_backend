// src/mail/email.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    private mailerService: MailerService,
    private configService: ConfigService,
  ) {}

  async sendPasswordResetEmail(to: string, token: string) {
    const route = `reset-password?reset_token=${encodeURIComponent(token)}`
    const webLink = `${this.configService.get('WEB_DEEP_LINK')}${route}`;
    this.logger.log(`Sending password reset to ${to}`);

    await this.mailerService.sendMail({
      to,
      subject: 'Restablecer contraseña',
      template: 'reset-password',
      context: {
        webLink,
        expiresIn: '1 hora',
      },
    });
  }

  async sendVerificationEmail(to: string, token: string) {
    const deepLink = `${this.configService.get('WEB_DEEP_LINK')}?verify_token=${encodeURIComponent(token)}`;
    this.logger.log(`Sending verification email to ${to}`);

    await this.mailerService.sendMail({
      to,
      subject: 'Verifica tu correo',
      template: 'verify-email',
      context: { deepLink },
    });
  }
}
