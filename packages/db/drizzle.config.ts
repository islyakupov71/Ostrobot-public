import type { Config } from 'drizzle-kit';

export default {
  /**
   * Собранная схема, а не исходник: drizzle-kit загружает файл сам,
   * через CommonJS, и не понимает импорт @ostro/shared, который
   * указывает на TypeScript. Файл готовится командой `node build.mjs schema`.
   */
  schema: './dist/schema.cjs',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
  verbose: true,
  strict: true,
} satisfies Config;
