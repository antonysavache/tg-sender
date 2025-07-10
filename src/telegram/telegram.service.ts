import { Injectable, Logger } from '@nestjs/common';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl';
import * as dotenv from 'dotenv';
import * as input from 'input';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

interface GroupStats {
  id: string;
  title: string;
  username: string | null;
  type: string;
  participantsCount: number;
  messagesCount24h: number;
}

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private client: TelegramClient;
  private readonly apiId: number;
  private readonly apiHash: string;
  private readonly sessionFile = 'telegram-session.json';

  constructor() {
    const apiIdStr = process.env.TELEGRAM_API_ID;
    const apiHashStr = process.env.TELEGRAM_API_HASH;
    
    if (!apiIdStr || !apiHashStr) {
      throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in .env file');
    }
    
    this.apiId = parseInt(apiIdStr);
    this.apiHash = apiHashStr;
  }

  private loadSession(): string {
    // Сначала пробуем загрузить из .env файла
    const envSession = process.env.TELEGRAM_SESSION_STRING;
    if (envSession && envSession.trim().length > 0) {
      this.logger.log('Loaded session from .env variable');
      return envSession.trim();
    }

    // Если в .env нет, загружаем из файла
    try {
      if (fs.existsSync(this.sessionFile)) {
        const sessionData = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
        this.logger.log('Loaded session from file');
        return sessionData.session;
      }
    } catch (error) {
      this.logger.warn('Failed to load session file:', error.message);
    }
    
    this.logger.log('No existing session found, will require authentication');
    return '';
  }

  private saveSession(session: string) {
    try {
      fs.writeFileSync(this.sessionFile, JSON.stringify({ session }));
      this.logger.log('Session saved successfully');
    } catch (error) {
      this.logger.error('Failed to save session:', error.message);
    }
  }

  async initializeClient() {
    try {
      const savedSession = this.loadSession();
      const session = new StringSession(savedSession);
      
      this.client = new TelegramClient(session, this.apiId, this.apiHash, {
        connectionRetries: 5,
      });

      await this.client.start({
        phoneNumber: async () => {
          this.logger.log('First time authentication required');
          return await input.text('Please enter your phone number (with country code, e.g. +1234567890): ');
        },
        password: async () => {
          return await input.text('Please enter your 2FA password: ');
        },
        phoneCode: async () => {
          return await input.text('Please enter the code you received: ');
        },
        onError: (err) => {
          this.logger.error('Authentication error:', err);
        },
      });

      // Сохраняем сессию после успешной авторизации
      const sessionString = this.client.session.save() as unknown as string;
      this.saveSession(sessionString);

      // Выводим session string для использования на сервере
      this.logger.log('✅ Authentication successful!');
      this.logger.log('📋 Session string for server deployment:');
      this.logger.log('TELEGRAM_SESSION_STRING=' + sessionString);
      this.logger.log('💡 Copy this line to your .env file on the server');

      this.logger.log('Telegram client initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize Telegram client:', error.message);
      throw error;
    }
  }

  async getGroupsStatistics(): Promise<GroupStats[]> {
    if (!this.client) {
      throw new Error('Telegram client not initialized');
    }

    try {
      // Получаем все диалоги (чаты)
      const dialogs = await this.client.getDialogs();
      
      const groupsStats: GroupStats[] = [];
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      for (const dialog of dialogs) {        
        // Строгая фильтрация: только группы и каналы
        if (dialog.isGroup || dialog.isChannel) {
          const entity = dialog.entity;
          
          if (!entity) {
            continue;
          }
          
          // Проверяем что это точно группа или канал, а НЕ пользователь
          if (entity.className === 'User' || entity.className === 'UserEmpty') {
            continue;
          }
          
          if (entity.className !== 'Chat' && entity.className !== 'Channel') {
            continue;
          }
          
          let participantsCount = 0;

          // Получаем количество участников
          try {
            if (entity.className === 'Chat' || entity.className === 'Channel') {
              // Проверяем наличие свойства participantsCount
              if ('participantsCount' in entity && entity.participantsCount) {
                participantsCount = entity.participantsCount as number;
              } else {
                try {
                  // Для небольших групп получаем точное количество
                  const participants = await this.client.getParticipants(entity);
                  participantsCount = participants.length;
                } catch (participantsError) {
                  this.logger.warn(`Failed to get exact participants count for ${this.getEntityTitle(entity)}`);
                  participantsCount = 0;
                }
              }
            }
          } catch (error) {
            this.logger.warn(`Failed to get participants for ${this.getEntityTitle(entity)}: ${error.message}`);
          }

          groupsStats.push({
            id: (dialog.id || entity.id).toString(),
            title: this.getEntityTitle(entity),
            username: this.getEntityUsername(entity),
            type: entity.className,
            participantsCount,
            messagesCount24h: 0,
          });
        }
      }

      return groupsStats;
    } catch (error) {
      this.logger.error('Failed to get groups statistics:', error.message);
      throw error;
    }
  }

  async leaveChats(chatIds: string[]): Promise<void> {
    if (!this.client) {
      throw new Error('Telegram client not initialized');
    }

    this.logger.log(`Starting to leave ${chatIds.length} chats...`);

    for (const chatId of chatIds) {
      try {
        const entity = await this.client.getEntity(chatId);
        
        if (entity.className === 'Channel') {
          // Покидаем канал
          await this.client.invoke(
            new Api.channels.LeaveChannel({
              channel: entity,
            })
          );
          this.logger.log(`✅ Left channel: ${this.getEntityTitle(entity)} (${chatId})`);
        } else if (entity.className === 'Chat') {
          // Покидаем группу
          const me = await this.client.getMe();
          await this.client.invoke(
            new Api.messages.DeleteChatUser({
              chatId: entity.id,
              userId: me.id,
            })
          );
          this.logger.log(`✅ Left group: ${this.getEntityTitle(entity)} (${chatId})`);
        }

        // Небольшая задержка между запросами
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        this.logger.error(`❌ Failed to leave chat ${chatId}: ${error.message}`);
      }
    }

    this.logger.log('Finished leaving chats');
  }

  private getEntityTitle(entity: any): string {
    return entity?.title || entity?.firstName || 'Unknown';
  }

  private getEntityUsername(entity: any): string | null {
    return entity?.username || null;
  }

  async disconnect() {
    if (this.client) {
      await this.client.disconnect();
      this.logger.log('Telegram client disconnected');
    }
  }
}
