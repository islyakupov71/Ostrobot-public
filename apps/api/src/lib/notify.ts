import PgBoss from 'pg-boss';
import { eq } from '@ostro/db';
import { notificationLog, projects, tasks, users, type Database } from '@ostro/db';
import { dedupeKey } from '@ostro/core';
import * as msg from '../bot/messages.js';
import { taskActions } from '../bot/keyboards.js';

/**
 * Немедленное уведомление о новой задаче.
 *
 * Остальные напоминания расставляет планировщик, но это одно уходит прямо
 * в момент постановки: руководитель нажимает «Отправить» и ожидает, что
 * человек узнает сейчас, а не в течение ближайшей минуты. Ждать тика здесь
 * значит подрывать доверие к системе на самом заметном её действии.
 *
 * Отправка пишется в общий журнал тем же ключом, каким пользуется
 * планировщик, поэтому запланированное «задача назначена» увидит дубль
 * и промолчит.
 */

type BotApi = {
  api: {
    sendMessage: (
      chatId: string,
      text: string,
      other?: Record<string, unknown>,
    ) => Promise<{ message_id: number }>;
  };
};

export type Notifier = {
  /** Сообщить исполнителю о новой задаче. Возвращает false, если не дошло. */
  taskAssigned: (taskId: string) => Promise<boolean>;
  /** Поставить задачу в очередь планировщика напоминаний. */
  planReminders: (taskId: string) => Promise<void>;
  stop: () => Promise<void>;
};

export async function createNotifier(params: {
  db: Database;
  bot: BotApi;
  connectionString: string;
  webAppUrl: string;
}): Promise<Notifier> {
  const { db, bot, webAppUrl } = params;

  const boss = new PgBoss({ connectionString: params.connectionString, schema: 'pgboss' });
  await boss.start();

  return {
    async planReminders(taskId: string) {
      await boss.send('reminders.plan', { taskId }, { singletonKey: taskId, singletonSeconds: 5 });
    },

    async taskAssigned(taskId: string): Promise<boolean> {
      const [row] = await db
        .select({
          task: tasks,
          projectKey: projects.key,
          projectName: projects.name,
          telegramId: users.telegramId,
          timezone: users.timezone,
          recipientId: users.id,
          recipientStatus: users.status,
        })
        .from(tasks)
        .innerJoin(projects, eq(tasks.projectId, projects.id))
        .innerJoin(users, eq(tasks.assigneeId, users.id))
        .where(eq(tasks.id, taskId))
        .limit(1);

      /**
       * Исполнителя нет, он ещё не открывал бота или отключён — это не сбой.
       * Карточка заведена по юзернейму, идентификатор появится при первом
       * входе, и тогда напоминания начнут доходить.
       */
      if (!row?.telegramId || row.recipientStatus === 'disabled') return false;

      const key = dedupeKey({
        recipientId: row.recipientId,
        kind: 'task_assigned',
        targetType: 'task',
        targetId: taskId,
        repeatIndex: 0,
      });

      const [author] = row.task.authorId
        ? await db
            .select({ firstName: users.firstName, lastName: users.lastName })
            .from(users)
            .where(eq(users.id, row.task.authorId))
            .limit(1)
        : [];

      const body = msg.taskCard({
        ref: `${row.projectKey}-${row.task.number}`,
        title: row.task.title,
        description: row.task.description,
        status: row.task.status,
        priority: row.task.priority,
        deadlineAt: row.task.deadlineAt,
        projectName: row.projectName,
        authorName: author ? [author.firstName, author.lastName].filter(Boolean).join(' ') : null,
        timezone: row.timezone,
      });

      try {
        /**
         * Запись в журнал идёт до отправки. Если процесс упадёт между
         * обращением к Telegram и обновлением статуса, уникальный ключ
         * не даст второй попытке уйти повторно.
         */
        await db.insert(notificationLog).values({
          recipientId: row.recipientId,
          kind: 'task_assigned',
          targetType: 'task',
          targetId: taskId,
          dedupeKey: key,
        });
      } catch (error) {
        /** Такое уведомление уже отправлено — значит всё в порядке. */
        if ((error as { code?: string }).code === '23505') return true;
        throw error;
      }

      try {
        const sent = await bot.api.sendMessage(row.telegramId, msg.newTaskNotification(body), {
          parse_mode: 'HTML',
          reply_markup: taskActions(taskId, row.task.status, {
            isAssignee: true,
            canAccept: false,
            webAppUrl,
          }),
        });

        await db
          .update(notificationLog)
          .set({ sentAt: new Date(), telegramMessageId: sent.message_id })
          .where(eq(notificationLog.dedupeKey, key));

        return true;
      } catch (error) {
        await db
          .update(notificationLog)
          .set({ error: (error as Error).message })
          .where(eq(notificationLog.dedupeKey, key));

        /**
         * Не роняем создание задачи из-за недоступного Telegram: задача уже
         * в базе, а планировщик повторит попытку своим чередом.
         */
        return false;
      }
    },

    async stop() {
      await boss.stop({ graceful: true, timeout: 5000 });
    },
  };
}
