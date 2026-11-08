import { and, count, eq, inArray, isNull, lt, sql } from '@ostro/db';
import { projectMembers, projects, tasks, users } from '@ostro/db';
import { OPEN_TASK_STATUSES } from '@ostro/shared';
import { ensureQueue } from '../lib/queue.js';
import type { JobContext } from '../index.js';

/**
 * Утренняя сводка руководителю.
 *
 * Отвечает на единственный вопрос из ТЗ — «где есть просрочки и где нужна
 * реакция». Сводка приходит одним сообщением раз в день, а не потоком
 * уведомлений: руководителю нужна картина, а не лента событий.
 */

const DIGEST_QUEUE = 'digest.manager';

export async function registerDigestJobs(ctx: JobContext) {
  const { boss, db, bot, logger } = ctx;

  await ensureQueue(boss, DIGEST_QUEUE);

  await boss.work(DIGEST_QUEUE, async () => {
    const now = new Date();

    const managers = await db
      .select()
      .from(users)
      .where(and(inArray(users.role, ['manager', 'admin']), eq(users.status, 'active')));

    for (const manager of managers) {
      if (!manager.telegramId) continue;

      const memberships = await db
        .select({ projectId: projectMembers.projectId })
        .from(projectMembers)
        .where(eq(projectMembers.userId, manager.id));

      const projectIds = memberships.map((m) => m.projectId);
      if (projectIds.length === 0) continue;

      const [stats] = await db
        .select({
          overdue: count(sql`case when ${tasks.deadlineAt} < ${now} then 1 end`),
          unacknowledged: count(
            sql`case when ${tasks.acknowledgedAt} is null and ${tasks.status} = 'new' then 1 end`,
          ),
          blocked: count(sql`case when ${tasks.status} = 'blocked' then 1 end`),
          total: count(),
        })
        .from(tasks)
        .where(
          and(inArray(tasks.projectId, projectIds), inArray(tasks.status, [...OPEN_TASK_STATUSES])),
        );

      if (!stats) continue;

      /** Всё спокойно — молчим. Ежедневное «всё хорошо» приучает не читать сводку. */
      if (stats.overdue === 0 && stats.unacknowledged === 0 && stats.blocked === 0) continue;

      const overdueList = await db
        .select({
          title: tasks.title,
          key: projects.key,
          number: tasks.number,
          assignee: users.firstName,
          deadlineAt: tasks.deadlineAt,
        })
        .from(tasks)
        .innerJoin(projects, eq(tasks.projectId, projects.id))
        .leftJoin(users, eq(tasks.assigneeId, users.id))
        .where(
          and(
            inArray(tasks.projectId, projectIds),
            inArray(tasks.status, [...OPEN_TASK_STATUSES]),
            lt(tasks.deadlineAt, now),
          ),
        )
        .limit(5);

      const noReaction = await db
        .select({
          title: tasks.title,
          key: projects.key,
          number: tasks.number,
          assignee: users.firstName,
        })
        .from(tasks)
        .innerJoin(projects, eq(tasks.projectId, projects.id))
        .leftJoin(users, eq(tasks.assigneeId, users.id))
        .where(
          and(
            inArray(tasks.projectId, projectIds),
            eq(tasks.status, 'new'),
            isNull(tasks.acknowledgedAt),
          ),
        )
        .limit(5);

      const lines = ['☀️ <b>Сводка на утро</b>', ''];

      if (stats.overdue > 0) {
        lines.push(`🔴 <b>Просрочено: ${stats.overdue}</b>`);
        for (const t of overdueList) {
          lines.push(`· ${t.key}-${t.number} ${t.title} — ${t.assignee ?? 'без исполнителя'}`);
        }
        if (stats.overdue > overdueList.length) {
          lines.push(`· …и ещё ${stats.overdue - overdueList.length}`);
        }
        lines.push('');
      }

      if (stats.unacknowledged > 0) {
        lines.push(`👀 <b>Без реакции: ${stats.unacknowledged}</b>`);
        for (const t of noReaction) {
          lines.push(`· ${t.key}-${t.number} ${t.title} — ${t.assignee ?? 'без исполнителя'}`);
        }
        lines.push('');
      }

      if (stats.blocked > 0) {
        lines.push(`🚧 <b>Заблокировано: ${stats.blocked}</b>`);
      }

      try {
        await bot.api.sendMessage(manager.telegramId, lines.join('\n'), { parse_mode: 'HTML' });
      } catch (error) {
        logger.error({ error, managerId: manager.id }, 'Не удалось отправить сводку');
      }
    }
  });

  /**
   * Девять утра по Москве. Один тик на всех: разослать двадцати руководителям
   * дешевле, чем держать персональное расписание под каждый часовой пояс.
   */
  await boss.schedule(DIGEST_QUEUE, '0 9 * * 1-5', {}, { tz: 'Europe/Moscow' });

  logger.info('Сводка руководителю: расписание настроено');
}
