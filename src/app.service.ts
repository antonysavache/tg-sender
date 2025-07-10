import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TelegramService } from './telegram/telegram.service';
import { MessagingService } from './messaging/messaging.service';

@Injectable()
export class AppService implements OnModuleInit {
  private readonly logger = new Logger(AppService.name);

  constructor(
    private readonly telegramService: TelegramService,
    private readonly messagingService: MessagingService,
  ) {}

  async onModuleInit() {
    try {
      // Проверяем все необходимые переменные окружения
      const requiredEnvVars = [
        'TELEGRAM_API_ID',
        'TELEGRAM_API_HASH', 
        'BULK_MESSAGE_TEXT',
        'LOG_CHAT_ID',
        'TARGET_CHATS'
      ];

      const missingVars = requiredEnvVars.filter(varName => {
        const value = process.env[varName];
        return !value || value.trim().length === 0;
      });

      if (missingVars.length > 0) {
        this.logger.error('❌ Missing required environment variables:');
        missingVars.forEach(varName => {
          this.logger.error(`   - ${varName}`);
        });
        this.logger.log('💡 Please fill all required variables in .env file');
        return;
      }

      // Проверяем наличие session string или возможность авторизации
      const sessionString = process.env.TELEGRAM_SESSION_STRING;
      if (!sessionString || sessionString.trim().length === 0) {
        this.logger.warn('⚠️ TELEGRAM_SESSION_STRING not found in .env file');
        this.logger.log('📋 First run: will require phone authentication');
        this.logger.log('💡 Copy session string from logs to .env for server deployment');
        this.logger.log('');
      }

      // Запускаем тестовую рассылку с логированием
      await this.sendTestMessage();
      
    } catch (error) {
      this.logger.error('Application error:', error.message);
    }
  }

  private async collectStatistics() {
    this.logger.log('📊 Starting statistics collection...');
    
    await this.telegramService.initializeClient();
    const groupsStats = await this.telegramService.getGroupsStatistics();
    this.printGroupsStatistics(groupsStats);
    await this.telegramService.disconnect();
  }

  private async sendTestMessage() {
    this.logger.log('📤 Starting bulk message sending with env config...');
    
    await this.messagingService.initializeClient();
    
    // Настройки рассылки из .env файла
    const messageText = (process.env.BULK_MESSAGE_TEXT || 'Default test message').replace(/\\n/g, '\n');
    const logChatId = process.env.LOG_CHAT_ID || '-4872735777';
    const intervalSeconds = parseInt(process.env.BULK_INTERVAL_SECONDS || '90');
    
    // Список чатов из .env файла
    const targetChatsEnv = process.env.TARGET_CHATS || '';
    const targetChats = targetChatsEnv
      .split(',')
      .map(chat => chat.trim())
      .filter(chat => chat.length > 0);
    
    if (targetChats.length === 0) {
      this.logger.error('❌ No target chats found in TARGET_CHATS env variable');
      this.logger.log('💡 Please set TARGET_CHATS in .env file like:');
      this.logger.log('   TARGET_CHATS=-1001234567890,-1001234567891,-1001234567892');
      return;
    }

    if (!messageText || messageText.trim().length === 0) {
      this.logger.error('❌ No message text found in BULK_MESSAGE_TEXT env variable');
      this.logger.log('💡 Please set BULK_MESSAGE_TEXT in .env file');
      return;
    }
    
    this.logger.log(`📋 Configuration loaded from .env:`);
    this.logger.log(`📝 Message: "${messageText}"`);
    this.logger.log(`📊 Log chat: ${logChatId}`);
    this.logger.log(`⏱️ Interval: ${intervalSeconds} seconds`);
    this.logger.log(`🎯 Target chats: ${targetChats.length} chats`);
    this.logger.log(`📋 Chat list: ${targetChats.join(', ')}`);
    
    // Запускаем массовую рассылку
    await this.messagingService.sendBulkMessagesWithInterval(
      targetChats,
      messageText,
      logChatId,
      intervalSeconds
    );
    
    await this.messagingService.disconnect();
  }

  private async leaveChats() {
    this.logger.log('🚪 Starting to leave chats...');
    
    await this.telegramService.initializeClient();
    
    const chatsToLeave = [
      // Добавить ID чатов для выхода
    ];
    
    if (chatsToLeave.length > 0) {
      await this.telegramService.leaveChats(chatsToLeave);
    } else {
      this.logger.log('No chats specified for leaving');
    }
    
    await this.telegramService.disconnect();
  }

  private printGroupsStatistics(groups: any[]) {
    console.log('\n' + '='.repeat(80));
    console.log('📊 TELEGRAM GROUPS STATISTICS');
    console.log('='.repeat(80));
    
    if (groups.length === 0) {
      console.log('❌ No groups found or failed to retrieve data');
      return;
    }

    // Простая сортировка по количеству участников
    const sortedGroups = groups.sort((a, b) => b.participantsCount - a.participantsCount);

    console.log(`📈 Total groups found: ${groups.length}\n`);

    sortedGroups.forEach((group, index) => {
      console.log(`${index + 1}. 💬 ${group.title}`);
      console.log(`   🆔 Chat ID: ${group.id}`);
      console.log(`   👥 Members: ${group.participantsCount.toLocaleString()}`);
      
      if (group.username) {
        console.log(`   🔗 https://t.me/${group.username}`);
      }
      
      console.log('');
    });

    // Статистика
    const totalMembers = sortedGroups.reduce((sum, group) => sum + group.participantsCount, 0);
    const avgMembersPerGroup = Math.round(totalMembers / groups.length);

    console.log('📊 SUMMARY:');
    console.log(`   Total members across all groups: ${totalMembers.toLocaleString()}`);
    console.log(`   Average members per group: ${avgMembersPerGroup.toLocaleString()}`);
    
    console.log('='.repeat(80));
  }

  getHello(): string {
    return 'Telegram Automation System';
  }
}
