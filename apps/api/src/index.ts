import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { webhookCallback } from 'grammy';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { createDatabase } from '@ostro/db';
import { config } from './config.js';
import { createBot } from './bot/index.js';
import { createJwtTools } from './auth/jwt.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerUserRoutes } from './routes/users.js';
import { registerProjectRoutes } from './routes/projects.js';
import { createNotifier } from './lib/notify.js';
import { registerSheetsWebhook } from './routes/sheets-webhook.js';

/**
 * HTTP-слой ОСТРО.
 *
 * Один процесс обслуживает три вещи: REST для Mini App, webhook Telegram
 * и webhook от Apps Script. Для команды до двадцати человек разносить это
 * по сервисам незачем — а вот фоновые задания живут отдельно (apps/worker),
 * чтобы долгая синхронизация с Google не задерживала ответ на нажатие кнопки.
 */

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    transport:
      config.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
        : undefined,
  },
  trustProxy: true,
});

app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

const db = createDatabase(config.DATABASE_URL);
const jwt = createJwtTools(config.JWT_SECRET, config.JWT_ACCESS_TTL, config.JWT_REFRESH_TTL);
const bot = createBot(config.TELEGRAM_BOT_TOKEN, { db, webAppUrl: config.WEB_APP_URL });

await app.register(helmet, {
  /** Mini App грузится внутри iframe Telegram — стандартный CSP его ломает. */
  contentSecurityPolicy: false,
});

await app.register(cors, {
  origin: [config.WEB_APP_URL, 'https://web.telegram.org'],
  credentials: true,
});

await app.register(rateLimit, {
  max: 120,
  timeWindow: '1 minute',
  /** Лимит считаем по пользователю, а не по IP: вся команда может сидеть за одним NAT. */
  keyGenerator: (req) => (req.headers.authorization ?? req.ip).slice(-32),
});

/**
 * Отправитель уведомлений держит собственное подключение к очереди:
 * сообщение о новой задаче уходит сразу, а не ждёт тика планировщика.
 */
const notifier = await createNotifier({
  db,
  bot: bot as never,
  connectionString: config.DATABASE_URL,
  webAppUrl: config.WEB_APP_URL,
});

app.decorate('db', db);
app.decorate('jwt', jwt);
app.decorate('bot', bot);
app.decorate('notifier', notifier);

/* ------------------------------------------------------------- Маршруты */

app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

await app.register(registerAuthRoutes, { prefix: '/api/auth' });
await app.register(registerTaskRoutes, { prefix: '/api/tasks' });
await app.register(registerUserRoutes, { prefix: '/api/users' });
await app.register(registerProjectRoutes, { prefix: '/api/projects' });
await app.register(registerSheetsWebhook, { prefix: '/hooks' });

/**
 * Webhook Telegram.
 *
 * Секрет в заголовке проверяет сам grammY: без него на этот адрес мог бы
 * писать кто угодно, а мы бы обрабатывали чужие апдейты как настоящие.
 */
if (config.TELEGRAM_WEBHOOK_URL && config.TELEGRAM_WEBHOOK_SECRET) {
  app.post(
    '/hooks/telegram',
    webhookCallback(bot, 'fastify', { secretToken: config.TELEGRAM_WEBHOOK_SECRET }),
  );
}

/* --------------------------------------------------------------- Старт */

const start = async () => {
  try {
    await app.listen({ host: config.API_HOST, port: config.API_PORT });

    if (config.TELEGRAM_WEBHOOK_URL && config.TELEGRAM_WEBHOOK_SECRET) {
      await bot.api.setWebhook(`${config.TELEGRAM_WEBHOOK_URL}/hooks/telegram`, {
        secret_token: config.TELEGRAM_WEBHOOK_SECRET,
        drop_pending_updates: false,
      });
      app.log.info('Telegram: webhook установлен');
    } else {
      /** В разработке публичного адреса нет — забираем апдейты опросом. */
      await bot.api.deleteWebhook();
      void bot.start({ onStart: () => app.log.info('Telegram: long polling запущен') });
    }
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

const shutdown = async (signal: string) => {
  app.log.info(`${signal}: останавливаюсь`);
  await notifier.stop();
  await bot.stop();
  await app.close();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await start();

declare module 'fastify' {
  interface FastifyInstance {
    db: ReturnType<typeof createDatabase>;
    jwt: ReturnType<typeof createJwtTools>;
    bot: ReturnType<typeof createBot>;
    notifier: Awaited<ReturnType<typeof createNotifier>>;
  }
}
