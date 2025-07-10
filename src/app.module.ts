import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TelegramModule } from './telegram/telegram.module';
import { MessagingModule } from './messaging/messaging.module';

@Module({
  imports: [TelegramModule, MessagingModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
