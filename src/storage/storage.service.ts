// storage/storage.service.ts
import { Injectable } from '@nestjs/common';

export interface UploadResult {
  key: string;
  url: string;
  size: number;
  mimeType: string;
  etag?: string;
  versionId?: string;
}

export interface ImageProcessingOptions {
  resize?: {
    width: number;
    height: number;
    fit?: 'cover' | 'contain' | 'fill';
  };
  quality?: number;
  format?: 'jpeg' | 'png' | 'webp';
  crop?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

@Injectable()
export abstract class StorageService {
  abstract upload(
    file: Express.Multer.File,
    path: string,
    options?: {
      contentType?: string;
      metadata?: Record<string, string>;
      public?: boolean;
    }
  ): Promise<UploadResult>;

  abstract uploadBuffer(
    buffer: Buffer,
    path: string,
    options?: {
      contentType?: string;
      metadata?: Record<string, string>;
      public?: boolean;
    }
  ): Promise<UploadResult>;

  abstract getSignedUrl(
    key: string,
    expiresIn?: number
  ): Promise<string>;

  abstract delete(key: string): Promise<void>;

  abstract processImage(
    input: Buffer | string,
    options: ImageProcessingOptions
  ): Promise<Buffer>;
}