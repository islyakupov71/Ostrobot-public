import { and, count, eq, gte, inArray, isNull, sql } from '@ostro/db';
import { notificationLog, tasks, users } from '@ostro/db';
import { ensureQueue } from '../lib/queue.js';
import type { JobContext } from '../index.js';

/**
 * Контроль реакции на задачи.
 *
 * Считает долю задач, на которые никто не отреагировал, за последние двое
 * суток. Когда она переваливает за порог, дело уже не в конкретном человеке:
 * либо задачи ставят не так, либо команда перестала открывать бота. И то
 * и другое видно только в совокупности — по отдельной задаче не заметно.
 *
 * Сообщение уходит согласующему: это его зона, а не разработчика.
 */

const QUEUE = 'stats.response-rate';

/** Доля непринятых задач, выше которой стоит вмешаться. */
const THRESHOLD = 0.8;

/**
 * Меньше пяти задач за двое суток — не выборка.
 * Три непринятых из четырёх дают 75% и означают ровно ничего.
 */
const MIN_SAMPLE = 5;

/** Сколько висящих задач у одного человека, чтобы написать лично. */
const PERSONAL_THRESHOLD = 3;

export async function registerResponseRateJob(ctx: JobContext) {
  const { boss, db, bot, logger } = ctx;

  await ensureQueue(boss, QUEUE);

  await boss.work(QUEUE, async () => {
    const since = new Date(Date.now() - 48 * 3600_000);

    const [totals] = await db
      .select({
        total: count(),
        waiting: sql<number>`count(*) filter (where ${tasks.status} = 'new' and ${tasks.acknowledgedAt} is null)::int`,
      })
      .from(tasks)
      .where(gte(tasks.createdAt, since));

    if (!totals || totals.total < MIN_SAMPLE) {
      logger.debug({ total: totals?.total ?? 0 }, 'Задач за двое суток мало — доля не считается');
      return;
    }

    const share = totals.waiting / totals.total;
    logger.info(
      { total: totals.total, waiting: totals.waiting, share: Math.round(share * 100) },
      'Доля задач без реакции',
    );

    if (share <= THRESHOLD) return;

    /* ------------------------------------------- Кто именно не отвечает */

    const laggards = await db
      .select({
        id: users.id,
        firstName: users.firstName,
        telegramId: users.telegramId,
        waiting: count(),
      })
      .from(tasks)
      .innerJoin(users, eq(tasks.assigneeId, users.id))
      .where(
        and(
          gte(tasks.createdAt, since),
          eq(tasks.status, 'new'),
          isNull(tasks.acknowledgedAt),
          eq(users.status, 'active'),
        ),
      )
      .groupBy(users.id, users.firstName, users.telegramId)
      .orderBy(sql`count(*) desc`);

    /* ------------------------------------------- Сообщение согласующему */

    const heads = await db
      .select({ id: users.id, telegramId: users.telegramId })
      .from(users)
      .where(and(inArray(users.role, ['head', 'admin']), eq(users.status, 'active')));

    const percent = Math.round(share * 100);
    const lines = [
      '⚠️ <b>Задачи повисли без ответа</b>',
      '',
      `За двое суток поставлено ${totals.total}, не принято ${totals.waiting} — это ${percent}%.`,
      '',
    ];

    for (const person of laggards.slice(0, 6)) {
      lines.push(`· ${escape(person.firstName)} — ${person.waiting}`);
    }

    lines.push('', 'Обычно это значит, что люди перестали открывать бота.');

    /**
     * Ключ дедупликации привязан к суткам: сигнал повторяется каждый день,
     * пока ситуация не выправится, но не чаще — иначе он превращается в фон,
     * который перестают читать.
     */
    const day = new Date().toISOString().slice(0, 10);

    for (const head of heads) {
      if (!head.telegramId) continue;
      const key = `${head.id}:response_rate:${day}`;

      try {
        await db.insert(notificationLog).values({
          recipientId: head.id,
          kind: 'escalation',
          targetType: 'stats',
          dedupeKey: key,
        });
      } catch (error) {
        /** Уже писали сегодня — второй раз не нужно. */
        if ((error as { code?: string }).code === '23505') continue;
        throw error;
      }

      try {
        await bot.api.sendMessage(head.telegramId, lines.join('\n'), { parse_mode: 'HTML' });
        await db
          .update(notificationLog)
          .set({ sentAt: new Date() })
          .where(eq(notificationLog.dedupeKey, key));
      } catch (error) {
        logger.error({ error }, 'Не удалось отправить сигнал о зависших задачах');
      }
    }

    /* --------------------------------- Личное напоминание исполнителям */

    for (const person of laggards) {
      if (!person.telegramId || person.waiting < PERSONAL_THRESHOLD) continue;

      const key = `${person.id}:response_rate_personal:${day}`;
      try {
        await db.insert(notificationLog).values({
          recipientId: person.id,
          kind: 'task_no_reaction',
          targetType: 'stats',
          dedupeKey: key,
        });
      } catch (error) {
        if ((error as { code?: string }).code === '23505') continue;
        throw error;
      }

      try {
        await bot.api.sendMessage(
          person.telegramId,
          [
            `👀 У тебя ${person.waiting} ${plural(person.waiting, 'задача', 'задачи', 'задач')} без ответа.`,
            '',
            'Нажми «Взял» на тех, что берёшь — руководитель перестанет уточнять.',
            'Если что-то не берёшь, скажи об этом: висящая задача хуже отказа.',
          ].join('\n'),
        );
        await db
          .update(notificationLog)
          .set({ sentAt: new Date() })
          .where(eq(notificationLog.dedupeKey, key));
      } catch (error) {
        logger.warn({ error, userId: person.id }, 'Личное напоминание не доставлено');
      }
    }
  });

  /** Дважды в рабочий день: утром и после обеда. */
  await boss.schedule(QUEUE, '0 10,16 * * 1-5', {}, { tz: 'Europe/Moscow' });

  logger.info('Контроль реакции на задачи: расписание настроено');
}

const escape = (v: string) =>
  v.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
