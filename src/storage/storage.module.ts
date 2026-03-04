// storage/storage.module.ts
import { Module, Global } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';
import { LocalStorageService } from './providers/local-storage.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: StorageService,
      useFactory: (configService: ConfigService) => {
        const provider = configService.get('STORAGE_PROVIDER', 'local');
        
        // Solo implementamos local por ahora, pero mantenemos la estructura para el futuro
        if (provider === 'local') {
          return new LocalStorageService(configService);
        }
        
        throw new Error(`Unsupported storage provider: ${provider}`);
      },
      inject: [ConfigService]
    }
  ],
  exports: [StorageService]
})
export class StorageModule {}