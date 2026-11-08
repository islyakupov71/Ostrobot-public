import { and, eq, inArray, isNull, lte, sql } from '@ostro/db';
import { notificationLog, scheduledReminders, tasks, users, projects } from '@ostro/db';
import {
  DEFAULT_NOTIFICATION_RULES,
  DEFAULT_QUIET_HOURS,
  dedupeKey,
  isQuietTime,
  nextDeliverableTime,
  planReminders,
  shouldTrack,
} from '@ostro/core';
import * as msg from '../lib/messages.js';
import { ensureQueue } from '../lib/queue.js';
import type { JobContext } from '../index.js';

/**
 * Напоминания.
 *
 * Работает в две фазы. Планировщик разворачивает правила в конкретные строки
 * scheduled_reminders в момент, когда задача создана или у неё поменялся срок.
 * Диспетчер раз в минуту забирает то, чему пришло время, и отправляет.
 *
 * Разделение важно: пересчитывать все правила для всех задач на каждом тике
 * дорого и, что хуже, недетерминированно — сдвинулось время тика, и человек
 * получил напоминание на две минуты позже или не получил вовсе.
 */

const DISPATCH_QUEUE = 'reminders.dispatch';
const PLAN_QUEUE = 'reminders.plan';

/** За раз отправляем ограниченную пачку: у Telegram лимит около 30 сообщений в секунду. */
const BATCH_SIZE = 25;

export async function registerReminderJobs(ctx: JobContext) {
  const { boss, db, bot, logger } = ctx;

  /** Очереди объявляются до подписки: pg-boss 10 не создаёт их на лету. */
  await ensureQueue(boss, PLAN_QUEUE);
  await ensureQueue(boss, DISPATCH_QUEUE);

  /* ------------------------------------------------- Планирование */

  await boss.work<{ taskId: string }>(PLAN_QUEUE, async (jobs) => {
    const job = jobs[0];
    if (!job) return;
    const { taskId } = job.data;

    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!task || !task.assigneeId) return;

    /**
     * Перепланирование начинается с отмены старого расписания.
     * Иначе перенос дедлайна на неделю вперёд оставил бы в очереди
     * напоминания по старому сроку — и человек получил бы «дедлайн завтра»
     * на задачу, у которой срок в следующую пятницу.
     */
    await db
      .update(scheduledReminders)
      .set({ cancelledAt: new Date() })
      .where(
        and(
          eq(scheduledReminders.targetType, 'task'),
          eq(scheduledReminders.targetId, taskId),
          isNull(scheduledReminders.sentAt),
          isNull(scheduledReminders.cancelledAt),
        ),
      );

    if (!shouldTrack(task.status)) return;

    const planned = planReminders(DEFAULT_NOTIFICATION_RULES, 'task', {
      deadlineAt: task.deadlineAt,
      assignedAt: task.createdAt,
      lastActivityAt: task.lastActivityAt,
    });

    if (planned.length === 0) return;

    await db.insert(scheduledReminders).values(
      planned.map((p) => ({
        kind: p.kind,
        targetType: 'task',
        targetId: taskId,
        recipientId: task.assigneeId!,
        fireAt: p.fireAt,
      })),
    );

    logger.debug({ taskId, count: planned.length }, 'Расписание напоминаний обновлено');
  });

  /* --------------------------------------------------- Отправка */

  await boss.work(DISPATCH_QUEUE, async () => {
    const now = new Date();

    const due = await db
      .select({
        reminder: scheduledReminders,
        recipient: users,
        task: tasks,
        projectName: projects.name,
        projectKey: projects.key,
      })
      .from(scheduledReminders)
      .innerJoin(users, eq(scheduledReminders.recipientId, users.id))
      .leftJoin(tasks, eq(scheduledReminders.targetId, tasks.id))
      .leftJoin(projects, eq(tasks.projectId, projects.id))
      .where(
        and(
          lte(scheduledReminders.fireAt, now),
          isNull(scheduledReminders.sentAt),
          isNull(scheduledReminders.cancelledAt),
        ),
      )
      .limit(BATCH_SIZE);

    for (const row of due) {
      const { reminder, recipient, task } = row;

      /** Задачу закрыли или отменили, пока напоминание ждало своей минуты. */
      if (task && !shouldTrack(task.status)) {
        await db
          .update(scheduledReminders)
          .set({ cancelledAt: now })
          .where(eq(scheduledReminders.id, reminder.id));
        continue;
      }

      /** Сотрудник уволен или отключён — молчим, но напоминание не теряем. */
      if (recipient.status !== 'active' || !recipient.telegramId) {
        await db
          .update(scheduledReminders)
          .set({ cancelledAt: now })
          .where(eq(scheduledReminders.id, reminder.id));
        continue;
      }

      const quiet = {
        start: recipient.quietHoursStart ?? DEFAULT_QUIET_HOURS.start,
        end: recipient.quietHoursEnd ?? DEFAULT_QUIET_HOURS.end,
        timezone: recipient.timezone,
      };

      const rule = DEFAULT_NOTIFICATION_RULES.find((r) => r.kind === reminder.kind);
      const respectQuiet = rule?.respectQuietHours ?? true;

      /**
       * Тихие часы: сдвигаем на утро вместо отправки.
       * Просрочка проходит сквозь тишину — если срок горит ночью,
       * человек должен об этом узнать ночью.
       */
      if (respectQuiet && isQuietTime(now, quiet)) {
        await db
          .update(scheduledReminders)
          .set({ fireAt: nextDeliverableTime(now, quiet) })
          .where(eq(scheduledReminders.id, reminder.id));
        continue;
      }

      const key = dedupeKey({
        recipientId: recipient.id,
        kind: reminder.kind,
        targetType: reminder.targetType,
        targetId: reminder.targetId,
        repeatIndex: 0,
      });

      try {
        const text = msg.buildReminderText(reminder.kind, {
          task,
          projectName: row.projectName,
          ref: task && row.projectKey ? `${row.projectKey}-${task.number}` : null,
          timezone: recipient.timezone,
        });

        if (!text) {
          await db
            .update(scheduledReminders)
            .set({ cancelledAt: now })
            .where(eq(scheduledReminders.id, reminder.id));
          continue;
        }

        /**
         * Запись в журнал идёт до отправки: уникальный dedupeKey не даст
         * второй попытке уйти повторно, если процесс упадёт между
         * отправкой в Telegram и обновлением статуса.
         */
        await db.insert(notificationLog).values({
          recipientId: recipient.id,
          kind: reminder.kind,
          targetType: reminder.targetType,
          targetId: reminder.targetId,
          dedupeKey: key,
        });

        const sent = await bot.api.sendMessage(recipient.telegramId, text, {
          parse_mode: 'HTML',
          reply_markup: task ? msg.reminderKeyboard(task.id, task.status, process.env.WEB_APP_URL ?? '') : undefined,
        });

        await db.transaction(async (tx) => {
          await tx
            .update(scheduledReminders)
            .set({ sentAt: now })
            .where(eq(scheduledReminders.id, reminder.id));

          await tx
            .update(notificationLog)
            .set({ sentAt: now, telegramMessageId: sent.message_id })
            .where(eq(notificationLog.dedupeKey, key));
        });
      } catch (error) {
        const code = (error as { error_code?: number }).error_code;

        /** 403 — бот заблокирован получателем. Долбить бессмысленно, помечаем и идём дальше. */
        if (code === 403) {
          await db
            .update(scheduledReminders)
            .set({ cancelledAt: now, lastError: 'Пользователь заблокировал бота' })
            .where(eq(scheduledReminders.id, reminder.id));

          logger.warn({ userId: recipient.id }, 'Бот заблокирован пользователем');
          continue;
        }

        /** Дубль по dedupeKey означает, что это сообщение уже отправлялось. */
        if ((error as { code?: string }).code === '23505') {
          await db
            .update(scheduledReminders)
            .set({ sentAt: now })
            .where(eq(scheduledReminders.id, reminder.id));
          continue;
        }

        await db
          .update(scheduledReminders)
          .set({
            attempt: sql`${scheduledReminders.attempt} + 1`,
            lastError: (error as Error).message,
            /** Следующая попытка через пять минут — Telegram мог быть недоступен. */
            fireAt: new Date(now.getTime() + 5 * 60_000),
          })
          .where(eq(scheduledReminders.id, reminder.id));

        logger.error({ error, reminderId: reminder.id }, 'Не удалось отправить напоминание');
      }
    }

    if (due.length > 0) {
      logger.info({ processed: due.length }, 'Напоминания разосланы');
    }
  });

  /** Тик диспетчера. Минута — достаточная точность для напоминаний о сроках. */
  await boss.schedule(DISPATCH_QUEUE, '* * * * *');

  logger.info('Напоминания: обработчики зарегистрированы');
}

/** Ставится из API после создания задачи или изменения её срока. */
export async function schedulePlanning(boss: JobContext['boss'], taskId: string) {
  await boss.send(PLAN_QUEUE, { taskId }, { singletonKey: taskId, singletonSeconds: 5 });
}
