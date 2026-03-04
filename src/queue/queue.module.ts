// queue.module.ts
import { Module, DynamicModule } from '@nestjs/common';
import { createClient } from 'redis';
import { Queue } from 'bullmq';

export interface QueueDefinition {
  name: string;
  defaultJobOptions?: any;
}

@Module({})
export class QueueModule {
  static register(queues: QueueDefinition[], redisOpts: any): DynamicModule {
    const providers = queues.map(q => ({
      provide: `QUEUE_${q.name.toUpperCase()}`,
      useFactory: () => {
        const connection = {
          ...redisOpts,
        };
        return new Queue(q.name, { connection, defaultJobOptions: q.defaultJobOptions });
      },
    }));

    return {
      module: QueueModule,
      providers: [
        ...providers,
        { provide: 'REDIS_CONNECTION_OPTS', useValue: redisOpts },
      ],
      exports: [...providers, 'REDIS_CONNECTION_OPTS'],
    };
  }
}
