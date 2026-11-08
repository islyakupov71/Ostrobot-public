import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { createDatabase } from './client.js';
import { notificationRules, projectMembers, projects, users } from './schema.js';
import { DEFAULT_NOTIFICATION_RULES } from '@ostro/core';

/**
 * Первичное наполнение.
 *
 * Идемпотентен: повторный запуск ничего не ломает и не плодит дубли.
 * Это важно, потому что сиды запускаются и после деплоя тоже —
 * чтобы новые правила уведомлений доехали до боевой базы.
 */

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL не задан.');
  process.exit(1);
}

const db = createDatabase(url);

/* ---------------------------------------------------- Администратор */

const adminTelegramId = process.env.BOOTSTRAP_ADMIN_TELEGRAM_ID;

if (adminTelegramId) {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.telegramId, adminTelegramId))
    .limit(1);

  if (!existing) {
    await db.insert(users).values({
      telegramId: adminTelegramId,
      firstName: 'Администратор',
      role: 'admin',
      /**
       * Сразу active: администратор — единственный, кто не может ждать,
       * пока его кто-то подтвердит. Экран подтверждения личности
       * он всё равно увидит при первом /start.
       */
      status: 'active',
      confirmedAt: new Date(),
    });
    console.log(`Администратор создан: ${adminTelegramId}`);
  } else {
    console.log('Администратор уже существует.');
  }
} else {
  console.warn('BOOTSTRAP_ADMIN_TELEGRAM_ID не задан — администратор не создан.');
}

/* ------------------------------------------- Правила уведомлений */

const existingRules = await db.select().from(notificationRules);

if (existingRules.length === 0) {
  await db.insert(notificationRules).values(
    DEFAULT_NOTIFICATION_RULES.map((rule) => ({
      projectId: null,
      kind: rule.kind,
      offsetMinutes: rule.offsetMinutes,
      repeatEveryMinutes: rule.repeatEveryMinutes,
      maxRepeats: rule.maxRepeats,
      target: rule.target,
      respectQuietHours: rule.respectQuietHours,
      isEnabled: rule.isEnabled,
    })),
  );
  console.log(`Правила уведомлений созданы: ${DEFAULT_NOTIFICATION_RULES.length}`);
} else {
  console.log(`Правила уведомлений уже настроены: ${existingRules.length}`);
}

/* ------------------------------------------------ Тестовый проект */

if (process.env.NODE_ENV !== 'production') {
  const [demo] = await db.select().from(projects).where(eq(projects.key, 'DEMO')).limit(1);

  if (!demo) {
    const [project] = await db
      .insert(projects)
      .values({
        key: 'DEMO',
        name: 'Демо-проект',
        description: 'Песочница для проверки сценариев. В проде не создаётся.',
      })
      .returning();

    if (project && adminTelegramId) {
      const [admin] = await db
        .select()
        .from(users)
        .where(eq(users.telegramId, adminTelegramId))
        .limit(1);

      if (admin) {
        await db.insert(projectMembers).values({
          projectId: project.id,
          userId: admin.id,
          role: 'lead',
        });
      }
    }

    console.log('Демо-проект создан.');
  }
}

console.log('Готово.');
process.exit(0);
