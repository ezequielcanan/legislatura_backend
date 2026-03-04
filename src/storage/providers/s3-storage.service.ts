// storage/providers/s3-storage.service.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';
import { StorageService, UploadResult, ImageProcessingOptions } from '../storage.service';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class S3StorageService extends StorageService {
  private s3: S3 | any;
  private bucket: string | undefined;
  private region: string | undefined;
  private cdnUrl?: string;

  constructor(private configService: ConfigService) {
    super();

    const region = this.configService.get<string>('AWS_REGION');
    const accessKey = this.configService.get<string>('AWS_ACCESS_KEY_ID');
    const secretKey = this.configService.get<string>('AWS_SECRET_ACCESS_KEY');

    if (!region || !accessKey || !secretKey) {
      throw new Error('Missing AWS config: set AWS_REGION, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY');
    }
    
    this.s3 = new S3({
      region,
      credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
      },
      maxAttempts: 3,
    });
    
    this.bucket = this.configService.get('AWS_S3_BUCKET');
    this.region = this.configService.get('AWS_REGION');
    this.cdnUrl = this.configService.get('AWS_CLOUDFRONT_URL');
  }

  async upload(
    file: Express.Multer.File,
    path: string,
    options?: { contentType?: string; metadata?: Record<string, string>; public?: boolean }
  ): Promise<UploadResult> {
    const key = this.generateKey(path, file.originalname);
    
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: file.buffer,
      ContentType: options?.contentType || file.mimetype,
      Metadata: options?.metadata,
      ACL: options?.public ? 'public-read' : 'private',
    });

    const result = await this.s3.send(command);
    
    return {
      key,
      url: this.getUrl(key),
      size: file.size,
      mimeType: file.mimetype,
      etag: result.ETag,
      versionId: result.VersionId,
    };
  }

  async uploadBuffer(
    buffer: Buffer,
    path: string,
    options?: { contentType?: string; metadata?: Record<string, string>; public?: boolean }
  ): Promise<UploadResult> {
    const key = this.generateKey(path, `${uuidv4()}.${options?.contentType?.split('/')[1] || 'jpg'}`);
    
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: buffer,
      ContentType: options?.contentType || 'image/jpeg',
      Metadata: options?.metadata,
      ACL: options?.public ? 'public-read' : 'private',
    });

    const result = await this.s3.send(command);
    
    return {
      key,
      url: this.getUrl(key),
      size: buffer.length,
      mimeType: options?.contentType || 'image/jpeg',
      etag: result.ETag,
      versionId: result.VersionId,
    };
  }

  async getSignedUrl(key: string, expiresIn: number = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    return getSignedUrl(this.s3, command, { expiresIn });
  }

  async delete(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    await this.s3.send(command);
  }

  async processImage(
    input: Buffer | string,
    options: ImageProcessingOptions | any
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

    if (options.crop) {
      sharpInstance = sharpInstance.extract(options.crop);
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

  private generateKey(path: string, filename: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    const extension = filename.split('.').pop();
    
    return `${path}/${timestamp}-${random}.${extension}`.replace(/\/\//g, '/');
  }

  private getUrl(key: string): string {
    if (this.cdnUrl) {
      return `${this.cdnUrl}/${key}`;
    }
    
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
  }
}