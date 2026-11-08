import type PgBoss from 'pg-boss';

/**
 * Объявление очередей.
 *
 * В pg-boss 10 очередь стала самостоятельной записью в базе: повесить на неё
 * обработчик или расписание можно только после того, как она создана.
 * Раньше это происходило само, и на переходе легко получить падение воркера
 * с невнятным нарушением внешнего ключа schedule_name_fkey — что и случилось.
 *
 * Вызов идемпотентен: при повторном запуске существующая очередь не считается
 * ошибкой, иначе каждый рестарт сервиса заканчивался бы падением.
 */
export async function ensureQueue(boss: PgBoss, name: string): Promise<void> {
  try {
    await boss.createQueue(name);
  } catch (error) {
    const message = (error as Error).message ?? '';
    /** Гонка двух воркеров или обычный повторный старт — это не ошибка. */
    if (message.includes('already exists') || message.includes('duplicate key')) return;
    throw error;
  }
}

/** Удобная обёртка: объявить очередь и сразу подписать на неё обработчик. */
export async function workOn<T extends object>(
  boss: PgBoss,
  name: string,
  handler: Parameters<PgBoss['work']>[1],
): Promise<void> {
  await ensureQueue(boss, name);
  await boss.work<T>(name, handler as never);
}
