import { Injectable, Logger } from '@nestjs/common';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import * as dotenv from 'dotenv';
import * as input from 'input';
import * as fs from 'fs';

dotenv.config();

@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);
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

      this.logger.log('Messaging client initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize messaging client:', error.message);
      throw error;
    }
  }

  async sendMessage(chatId: string, text: string): Promise<boolean> {
    if (!this.client) {
      throw new Error('Telegram client not initialized');
    }

    try {
      this.logger.log(`📤 Sending message to chat ${chatId}: "${text}"`);
      
      const entity = await this.client.getEntity(chatId);
      await this.client.sendMessage(entity, { message: text });
      
      this.logger.log(`✅ Message sent successfully to ${chatId}`);
      return true;
    } catch (error) {
      this.logger.error(`❌ Failed to send message to ${chatId}: ${error.message}`);
      return false;
    }
  }

  async sendMessageWithLogging(chatId: string, text: string, logChatId: string): Promise<boolean | 'flood_wait'> {
    if (!this.client) {
      throw new Error('Telegram client not initialized');
    }

    try {
      this.logger.log(`📤 Sending message to chat ${chatId}`);
      
      const entity = await this.client.getEntity(chatId);
      const sentMessage = await this.client.sendMessage(entity, { message: text });
      
      // Формируем данные для лога
      const now = new Date();
      const timeString = now.toLocaleString('ru-RU', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      
      const chatTitle = this.getEntityTitle(entity);
      const postLink = this.getPostLink(entity, sentMessage.id);
      
      // Формируем лог сообщение
      const logMessage = `✅ MESSAGE SENT
⏰ Time: ${timeString}
💬 Group name: ${chatTitle}
🔗 Post link: ${postLink}`;
      
      await this.sendLogMessage(logChatId, logMessage);
      
      this.logger.log(`✅ Message sent successfully to ${chatId}`);
      return true;
    } catch (error) {
      const errorInfo = this.analyzeError(error);
      
      // Логируем ошибку отправки с подробностями
      const now = new Date();
      const timeString = now.toLocaleString('ru-RU', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      
      const logMessage = `❌ SEND FAILED
⏰ Time: ${timeString}
💬 Group: ${chatId}
🚫 Error: ${errorInfo.description}
⚠️ Action: ${errorInfo.action}`;
      
      await this.sendLogMessage(logChatId, logMessage);
      
      this.logger.error(`❌ ${errorInfo.description} for chat ${chatId}`);
      
      // Если это FloodWait - ждем и возвращаем специальный статус
      if (errorInfo.waitTime > 0) {
        this.logger.warn(`⏳ Need to wait ${errorInfo.waitTime} seconds due to flood control`);
        return 'flood_wait'; // Специальный статус для обработки в вызывающем коде
      }
      
      return false;
    }
  }

  private analyzeError(error: any): { description: string; action: string; waitTime: number } {
    const errorMessage = error.message || error.toString();
    
    // FloodWaitError - нужно подождать
    if (errorMessage.includes('FLOOD_WAIT') || errorMessage.includes('Too Many Requests')) {
      const waitMatch = errorMessage.match(/(\d+)/);
      const waitTime = waitMatch ? parseInt(waitMatch[1]) : 300; // default 5 минут
      
      return {
        description: `Flood control activated, need to wait ${waitTime} seconds`,
        action: 'Will pause bulk sending until flood control expires',
        waitTime: waitTime
      };
    }
    
    // Нет прав на отправку
    if (errorMessage.includes('CHAT_WRITE_FORBIDDEN') || errorMessage.includes('write access')) {
      return {
        description: 'No permission to send messages to this chat',
        action: 'Skip this chat and continue with others',
        waitTime: 0
      };
    }
    
    // Забанены в канале
    if (errorMessage.includes('USER_BANNED_IN_CHANNEL') || errorMessage.includes('banned')) {
      return {
        description: 'User is banned in this channel',
        action: 'Skip this chat permanently',
        waitTime: 0
      };
    }
    
    // Канал стал приватным
    if (errorMessage.includes('CHANNEL_PRIVATE') || errorMessage.includes('private')) {
      return {
        description: 'Channel became private or was deleted',
        action: 'Skip this chat permanently',
        waitTime: 0
      };
    }
    
    // Нужны права админа
    if (errorMessage.includes('CHAT_ADMIN_REQUIRED') || errorMessage.includes('admin')) {
      return {
        description: 'Admin rights required to send messages',
        action: 'Skip this chat and continue with others',
        waitTime: 0
      };
    }
    
    // Чат не найден
    if (errorMessage.includes('PEER_ID_INVALID') || errorMessage.includes('Could not find')) {
      return {
        description: 'Chat not found or not accessible',
        action: 'Skip this chat permanently',
        waitTime: 0
      };
    }
    
    // Неизвестная ошибка
    return {
      description: `Unknown error: ${errorMessage}`,
      action: 'Skip this chat and continue with others',
      waitTime: 0
    };
  }

  private getPostLink(entity: any, messageId: number): string {
    // Если у канала/группы есть username - используем t.me ссылку
    if (entity?.username) {
      return `https://t.me/${entity.username}/${messageId}`;
    }
    
    // Если нет username, используем приватную ссылку для каналов
    if (entity?.className === 'Channel') {
      // Для приватных каналов ссылка выглядит как t.me/c/CHANNEL_ID/MESSAGE_ID
      // Убираем префикс -100 из ID канала для ссылки
      const channelId = entity.id.toString().replace('-100', '');
      return `https://t.me/c/${channelId}/${messageId}`;
    }
    
    // Для обычных групп без username - возвращаем информацию об ID
    return `Private group (ID: ${entity.id}, Message: ${messageId})`;
  }

  private async sendLogMessage(logChatId: string, message: string): Promise<void> {
    try {
      const logEntity = await this.client.getEntity(logChatId);
      await this.client.sendMessage(logEntity, { message });
    } catch (error) {
      this.logger.error(`Failed to send log message: ${error.message}`);
    }
  }

  private getEntityTitle(entity: any): string {
    return entity?.title || entity?.firstName || 'Unknown';
  }

  private getEntityLink(entity: any): string {
    if (entity?.username) {
      return `https://t.me/${entity.username}`;
    }
    return `Chat ID: ${entity?.id || 'Unknown'}`;
  }

  async sendBulkMessagesWithInterval(
    chatIds: string[], 
    text: string, 
    logChatId: string,
    intervalSeconds: number = 90
  ): Promise<void> {
    this.logger.log(`📤 Starting infinite bulk messaging to ${chatIds.length} chats with ${intervalSeconds}s interval...`);
    
    let totalSuccessCount = 0;
    let totalFailCount = 0;
    let totalFloodWaitCount = 0;
    let roundNumber = 1;

    // Бесконечный цикл рассылки
    while (true) {
      // Логируем начало нового круга
      const roundStartMessage = `🔄 NEW ROUND STARTED
⏰ Time: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}
🎯 Round #${roundNumber}
📝 Chats in round: ${chatIds.length}
📊 Total stats: ✅${totalSuccessCount} ❌${totalFailCount} ⏸️${totalFloodWaitCount}`;
      
      await this.sendLogMessage(logChatId, roundStartMessage);
      this.logger.log(`🔄 Starting round #${roundNumber}`);

      let roundSuccessCount = 0;
      let roundFailCount = 0;
      let roundFloodWaitCount = 0;
      let roundStopped = false;

      // Рассылка по всем чатам в текущем круге
      for (let i = 0; i < chatIds.length; i++) {
        const chatId = chatIds[i];
        
        this.logger.log(`📊 Round ${roundNumber} - Progress: ${i + 1}/${chatIds.length} chats`);
        
        const result = await this.sendMessageWithLogging(chatId, text, logChatId);
        
        if (result === true) {
          roundSuccessCount++;
          totalSuccessCount++;
        } else if (result === 'flood_wait') {
          roundFloodWaitCount++;
          totalFloodWaitCount++;
          roundStopped = true;
          
          // При FloodWait приостанавливаем текущий круг
          this.logger.warn('🚫 FloodWait detected! Pausing current round...');
          
          const pauseMessage = `⏸️ ROUND PAUSED (FLOOD WAIT)
⏰ Time: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}
🎯 Round #${roundNumber} paused
🚫 Reason: Telegram flood control activated
📊 Round progress: ${i + 1}/${chatIds.length} chats processed
✅ Round sent: ${roundSuccessCount} | ❌ Round failed: ${roundFailCount}
⏳ Will start new round after flood control expires`;
          
          await this.sendLogMessage(logChatId, pauseMessage);
          break; // Прерываем текущий круг
        } else {
          roundFailCount++;
          totalFailCount++;
        }
        
        // Задержка между отправками (кроме последнего сообщения в круге)
        if (i < chatIds.length - 1) {
          this.logger.log(`⏳ Waiting ${intervalSeconds} seconds before next message...`);
          await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
        }
      }

      // Отчет по завершении круга
      if (!roundStopped) {
        const roundCompleteMessage = `✅ ROUND COMPLETED
⏰ Time: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}
🎯 Round #${roundNumber} finished
✅ Round sent: ${roundSuccessCount}
❌ Round failed: ${roundFailCount}
📊 Total stats: ✅${totalSuccessCount} ❌${totalFailCount} ⏸️${totalFloodWaitCount}
🔄 Starting next round in ${intervalSeconds} seconds...`;
        
        await this.sendLogMessage(logChatId, roundCompleteMessage);
        this.logger.log(`✅ Round #${roundNumber} completed: ${roundSuccessCount} sent, ${roundFailCount} failed`);
        
        // Пауза перед следующим кругом
        this.logger.log(`⏳ Waiting ${intervalSeconds} seconds before next round...`);
        await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
      }

      roundNumber++;
      
      // Защита от бесконечного цикла при постоянных FloodWait
      if (roundFloodWaitCount > 0 && !roundStopped) {
        this.logger.warn('⚠️ FloodWait detected but round completed. Adding extra delay...');
        await new Promise(resolve => setTimeout(resolve, 300 * 1000)); // 5 минут дополнительной паузы
      }
    }
  }

  async disconnect() {
    if (this.client) {
      await this.client.disconnect();
      this.logger.log('Messaging client disconnected');
    }
  }
}
