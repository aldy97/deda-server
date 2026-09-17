import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import appConfig from './config/app.config';
import databaseConfig from './config/database.config';
import redisConfig from './config/redis.config';
import { UsersModule } from './modules/users/users.module';
import { DevicesModule } from './modules/devices/devices.module';
import { ChildProfilesModule } from './modules/child-profiles/child-profiles.module';
import { TextbooksModule } from './modules/textbooks/textbooks.module';
import { DeviceConfigsModule } from './modules/device-configs/device-configs.module';
import { ConversationsModule } from './modules/conversations/conversations.module';
import { LearningStatsModule } from './modules/learning-stats/learning-stats.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { ManufacturerModule } from './modules/manufacturer/manufacturer.module';
import { VendorModule } from './modules/vendor/vendor.module';
import { MusicModule } from './modules/music/music.module';
import { RedisModule } from './common/redis/redis.module';
import { PrismaModule } from './common/prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, redisConfig],
      envFilePath: ['.env'],
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL || 'info',
        transport:
          process.env.NODE_ENV === 'development'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
      },
    }),
    PrismaModule,
    RedisModule,
    UsersModule,
    DevicesModule,
    ChildProfilesModule,
    TextbooksModule,
    DeviceConfigsModule,
    ConversationsModule,
    LearningStatsModule,
    WebhooksModule,
    ManufacturerModule,
    VendorModule,
    MusicModule,
  ],
})
export class AppModule {}
