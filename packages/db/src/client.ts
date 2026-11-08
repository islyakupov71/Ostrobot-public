import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Database = ReturnType<typeof createDatabase>;

/**
 * Пул подключений к Postgres.
 *
 * max: 10 с запасом хватает на команду до 20 человек — узкое место здесь
 * не база, а лимит Telegram на исходящие сообщения.
 */
export function createDatabase(connectionString: string) {
  const client = postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return drizzle(client, { schema });
}

/** Отдельное одиночное подключение — для миграций и разовых скриптов. */
export function createMigrationClient(connectionString: string) {
  return postgres(connectionString, { max: 1 });
}
