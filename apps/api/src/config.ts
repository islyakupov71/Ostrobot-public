import 'dotenv/config';
import { z } from 'zod';

/**
 * Конфигурация приложения.
 *
 * Проверяется один раз при старте: лучше не подняться с внятным сообщением,
 * чем принять первый запрос и упасть внутри обработчика через полчаса.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  TELEGRAM_BOT_TOKEN: z.string().min(20, 'Токен бота не похож на настоящий'),
  TELEGRAM_WEBHOOK_URL: z.string().url().optional().or(z.literal('')),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16).optional().or(z.literal('')),
  BOOTSTRAP_ADMIN_TELEGRAM_ID: z.string().regex(/^\d*$/).optional(),

  DATABASE_URL: z.string().url(),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().default(3000),
  WEB_APP_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET должен быть не короче 32 символов'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().email().optional().or(z.literal('')),
  GOOGLE_PRIVATE_KEY: z.string().optional(),
  GOOGLE_SPREADSHEET_ID: z.string().optional(),
  SHEETS_WEBHOOK_SECRET: z.string().optional(),
  SHEETS_POLL_INTERVAL_SEC: z.coerce.number().int().default(300),

  DEFAULT_TIMEZONE: z.string().default('Europe/Moscow'),
  QUIET_HOURS_START: z.string().default('22:00'),
  QUIET_HOURS_END: z.string().default('08:00'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Конфигурация не прошла проверку:\n');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  console.error('\nСверься с .env.example.');
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;

/** Google подключён только если заданы все три обязательные части. */
export const isSheetsConfigured =
  Boolean(config.GOOGLE_SERVICE_ACCOUNT_EMAIL) &&
  Boolean(config.GOOGLE_PRIVATE_KEY) &&
  Boolean(config.GOOGLE_SPREADSHEET_ID);
