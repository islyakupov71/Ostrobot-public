import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createMigrationClient } from './client.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL не задан. Скопируй .env.example в .env и заполни его.');
  process.exit(1);
}

const client = createMigrationClient(url);
await migrate(drizzle(client), { migrationsFolder: './migrations' });
await client.end();
console.log('Миграции применены.');
