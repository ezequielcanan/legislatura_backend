import { NestFactory, Reflector } from '@nestjs/core';
import { ValidationPipe, ClassSerializerInterceptor } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { join } from 'path';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService);

  // Security middleware
  app.use(helmet({
    crossOriginResourcePolicy: false,
  }));
  app.use(compression({
    filter: (req, res) => {
      // No comprimir respuestas SSE (text/event-stream) para permitir streaming real
      if (res.getHeader('Content-Type') === 'text/event-stream') {
        return false;
      }
      return compression.filter(req, res);
    },
  }));
  app.use(cookieParser());

  // CORS configuration
  app.enableCors({
    origin: "*",
    credentials: true,
  });

  // Global validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Global serialization
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));

  app.use('/uploads', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  });

  const storagePath = configService?.get('LOCAL_STORAGE_PATH', './storage');
  app.useStaticAssets(join(process.cwd(), storagePath), {
    prefix: '/uploads/',
  });

  // Swagger documentation
  const config = new DocumentBuilder()
    .setTitle('NestJS Auth API')
    .setDescription('Secure authentication API with Google OAuth and JWT')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  await app.listen(process.env.PORT || 3000);
}
bootstrap();