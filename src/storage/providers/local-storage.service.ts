// storage/providers/local-storage.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';
import { StorageService, UploadResult, ImageProcessingOptions } from '../storage.service';
import mime from 'mime-types';


@Injectable()
export class LocalStorageService extends StorageService {
  private readonly logger = new Logger(LocalStorageService.name);
  private readonly storagePath: string;
  private readonly baseUrl: string;

  constructor(private configService: ConfigService) {
    super();

    // Usar path relativo al proyecto o absoluto desde variables de entorno
    this.storagePath = this.configService.get('LOCAL_STORAGE_PATH', './storage');
    this.baseUrl = this.configService.get('LOCAL_STORAGE_BASE_URL', 'http://localhost:3000/uploads');

    // Crear directorios base si no existen
    this.ensureDirectoryExists(this.storagePath);
  }

  async upload(
    file: Express.Multer.File,
    path: string,
    options?: { contentType?: string; metadata?: Record<string, string>; public?: boolean }
  ): Promise<UploadResult> {
    const key = this.generateKey(path, file.originalname);
    const fullPath = this.getFullPath(key);

    // Crear directorio si no existe
    this.ensureDirectoryExists(dirname(fullPath));

    // Guardar archivo
    writeFileSync(fullPath, file.buffer);

    const url = this.getUrl(key);

    return {
      key,
      url,
      size: file.size,
      mimeType: file.mimetype,
    };
  }

  async uploadBuffer(
    buffer: Buffer,
    path: string,
    options?: { contentType?: string; metadata?: Record<string, string>; public?: boolean }
  ): Promise<UploadResult> {
    const ext = mime.extension(options?.contentType || '') || 'bin';
    const key = this.generateKey(path, `${uuidv4()}.${ext}`);
    const fullPath = this.getFullPath(key);

    this.ensureDirectoryExists(dirname(fullPath));

    writeFileSync(fullPath, buffer);

    const url = this.getUrl(key);

    return {
      key,
      url,
      size: buffer.length,
      mimeType: options?.contentType || 'image/jpeg',
    };
  }

  async getSignedUrl(key: string, expiresIn: number = 3600): Promise<string> {
    // En almacenamiento local, no necesitamos firmar URLs
    // Podemos devolver la URL directa o implementar un endpoint protegido
    return this.getUrl(key);
  }

  async delete(key: string): Promise<void> {
    const fullPath = this.getFullPath(key);
    if (existsSync(fullPath)) {
      unlinkSync(fullPath);
    }
  }

  async processImage(
    input: Buffer | string,
    options: ImageProcessingOptions
  ): Promise<Buffer> {
    let sharpInstance = typeof input === 'string'
      ? sharp(input)
      : sharp(input);

    if (options.resize) {
      sharpInstance = sharpInstance.resize({
        width: options.resize.width,
        height: options.resize.height,
        fit: options.resize.fit || 'cover',
        withoutEnlargement: true,
      });
    }


    if (options?.crop) {
      const cropRegion = {
        left: Math.round(options.crop.x),
        top: Math.round(options.crop.y),
        width: Math.round(options.crop.width),
        height: Math.round(options.crop.height),
      };

      // Opcional: validar que width/height > 0
      if (cropRegion.width > 0 && cropRegion.height > 0) {
        sharpInstance = sharpInstance.extract(cropRegion as any);
      } else {
        // manejar caso inválido si corresponde
      }
    }


    if (options.format) {
      sharpInstance = sharpInstance.toFormat(options.format, {
        quality: options.quality || 80,
      });
    } else if (options.quality) {
      sharpInstance = sharpInstance.jpeg({ quality: options.quality });
    }

    return sharpInstance.toBuffer();
  }

  async readFile(key: string): Promise<Buffer> {
    const fullPath = this.getFullPath(key);
    if (!existsSync(fullPath)) {
      throw new Error(`File not found: ${key}`);
    }
    return readFileSync(fullPath);
  }

  private generateKey(path: string, filename: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    const extension = filename.split('.').pop();

    return `${path}/${timestamp}-${random}.${extension}`.replace(/\/\//g, '/');
  }

  private getFullPath(key: string): string {
    return join(this.storagePath, key);
  }

  private getUrl(key: string): string {
    // En desarrollo, podemos servir archivos estáticos
    return `${this.baseUrl}/${key}`;
  }

  private ensureDirectoryExists(dirPath: string): void {
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
  }
}