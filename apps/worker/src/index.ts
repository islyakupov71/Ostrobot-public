import 'dotenv/config';
import PgBoss from 'pg-boss';
import pino from 'pino';
import { Bot } from 'grammy';
import { createDatabase } from '@ostro/db';
import { registerReminderJobs } from './jobs/reminders.js';
import { registerSheetsJobs } from './jobs/sheets-sync.js';
import { registerDigestJobs } from './jobs/digest.js';
import { registerResponseRateJob } from './jobs/response-rate.js';

/**
 * Фоновый воркер.
 *
 * Здесь живёт всё, что происходит без участия человека: напоминания,
 * эскалации, синхронизация с таблицей и утренние сводки. Вынесен из API
 * по одной причине — полный проход по листу на несколько тысяч строк
 * занимает секунды, и API в это время должен продолжать отвечать на нажатия.
 *
 * Очередь — pg-boss, то есть та же самая база. Отдельный Redis для команды
 * из двадцати человек был бы лишним сервисом, который надо поднимать,
 * мониторить и чинить.
 */

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
      : undefined,
});

const databaseUrl = process.env.DATABASE_URL;
const botToken = process.env.TELEGRAM_BOT_TOKEN;

if (!databaseUrl || !botToken) {
  logger.fatal('Нужны DATABASE_URL и TELEGRAM_BOT_TOKEN — сверься с .env.example');
  process.exit(1);
}

const db = createDatabase(databaseUrl);
const bot = new Bot(botToken);
const boss = new PgBoss({
  connectionString: databaseUrl,
  /** Очередь живёт в своей схеме и не мешается среди прикладных таблиц. */
  schema: 'pgboss',
  retryLimit: 3,
  retryBackoff: true,
});

boss.on('error', (error) => logger.error({ error }, 'Сбой очереди'));

export type JobContext = {
  db: typeof db;
  bot: typeof bot;
  boss: PgBoss;
  logger: typeof logger;
};

async function main() {
  await boss.start();
  const ctx: JobContext = { db, bot, boss, logger };

  await registerReminderJobs(ctx);
  await registerSheetsJobs(ctx);
  await registerDigestJobs(ctx);
  await registerResponseRateJob(ctx);

  logger.info('Воркер запущен');
}

const shutdown = async (signal: string) => {
  logger.info(`${signal}: останавливаюсь`);
  await boss.stop({ graceful: true, timeout: 30_000 });
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await main();
