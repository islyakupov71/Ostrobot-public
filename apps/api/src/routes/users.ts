import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, isNull, ne, or, sql } from '@ostro/db';
import { projectMembers, projects, tasks, users } from '@ostro/db';
import { canAdminister, canApprove } from '@ostro/core';
import { OPEN_TASK_STATUSES } from '@ostro/shared';
import { z } from 'zod';
import { authenticate } from '../plugins/authenticate.js';
import { avatarUrl, hasAvatar } from '../lib/avatars.js';

/**
 * Люди.
 *
 * Главный потребитель — экран постановки задачи: руководитель выбирает
 * исполнителя, нажимая на лицо, а не разбирая список имён. Поэтому вместе
 * с человеком отдаётся его аватарка и текущая загрузка: ставить пятую
 * срочную задачу тому, у кого уже две просрочки, — решение, которое стоит
 * принимать осознанно.
 */
export async function registerUserRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  /**
   * Кому можно поставить задачу.
   *
   * Возвращает участников проектов, доступных текущему пользователю.
   * Отключённые сотрудники не показываются: назначить задачу человеку,
   * который уже не работает, — ошибка, которую проще не дать совершить,
   * чем потом искать.
   */
  app.get(
    '/assignees',
    { schema: { querystring: z.object({ projectId: z.string().uuid().optional() }) } },
    async (request, reply) => {
      const access = request.access!;
      if (!canAdminister(access)) {
        return reply
          .code(403)
          .send({ error: { code: 'forbidden', message: 'Ставить задачи может руководитель' } });
      }

      const { projectId } = request.query as { projectId?: string };
      const scope = projectId ? [projectId] : [...access.projectRoles.keys()];

      const rows = await app.db
        .selectDistinctOn([users.id], {
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          position: users.position,
          username: users.telegramUsername,
          role: users.role,
          status: users.status,
        })
        .from(users)
        .leftJoin(projectMembers, eq(projectMembers.userId, users.id))
        .where(
          and(
            ne(users.status, 'disabled'),
            scope.length > 0
              ? or(inArray(projectMembers.projectId, scope), isNull(projectMembers.projectId))
              : undefined,
          ),
        );

      /**
       * Загрузка считается одним запросом на всех, а не по человеку в цикле:
       * на экране их пятеро сейчас и три десятка потом, и N+1 запрос здесь
       * превратится в заметную задержку ровно там, где её меньше всего ждут.
       */
      const load = await app.db
        .select({
          assigneeId: tasks.assigneeId,
          open: sql<number>`count(*)::int`,
          overdue: sql<number>`count(*) filter (where ${tasks.deadlineAt} < now())::int`,
        })
        .from(tasks)
        .where(inArray(tasks.status, [...OPEN_TASK_STATUSES]))
        .groupBy(tasks.assigneeId);

      const loadById = new Map(load.map((l) => [l.assigneeId, l]));

      const items = await Promise.all(
        rows.map(async (u) => {
          const stats = loadById.get(u.id);
          return {
            id: u.id,
            firstName: u.firstName,
            lastName: u.lastName,
            fullName: [u.firstName, u.lastName].filter(Boolean).join(' '),
            position: u.position,
            username: u.username,
            role: u.role,
            /** Ждёт первого входа: задачу поставить можно, дойдёт после «Начать». */
            isPending: u.status === 'pending',
            avatar: (await hasAvatar(u.id)) ? avatarUrl(u.id) : null,
            /** Две буквы для кружка, когда фотографии нет. */
            initials: initialsOf(u.firstName, u.lastName),
            openTasks: stats?.open ?? 0,
            overdueTasks: stats?.overdue ?? 0,
          };
        }),
      );

      /** Руководителя показываем последним: чаще всего задачу ставят не себе. */
      items.sort((a, b) => {
        if (a.role !== b.role) return a.role === 'employee' ? -1 : 1;
        return a.firstName.localeCompare(b.firstName, 'ru');
      });

      return { items };
    },
  );

  /** Профиль текущего пользователя — приложение показывает его в шапке. */
  app.get('/me', async (request) => {
    const user = request.currentUser!;
    const access = request.access!;

    /**
     * Проекты отдаются здесь же, а не отдельным запросом: приложение
     * запрашивает их сразу после входа и всегда вместе с профилем,
     * а лишний круг к серверу на старте заметен.
     */
    const memberOf = [...access.projectRoles.keys()];
    const myProjects = memberOf.length
      ? await app.db
          .select({ id: projects.id, key: projects.key, name: projects.name })
          .from(projects)
          .where(inArray(projects.id, memberOf))
      : [];

    return {
      projects: myProjects,
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      position: user.position,
      role: user.role,
      timezone: user.timezone,
      avatar: (await hasAvatar(user.id)) ? avatarUrl(user.id) : null,
      initials: initialsOf(user.firstName, user.lastName),
      canAssign: canAdminister(request.access!),
      /** Может окончательно принять работу — от этого зависит набор кнопок. */
      canApprove: canApprove(user.role),
    };
  });
}

function initialsOf(first: string, last: string | null): string {
  const a = first.trim().charAt(0).toUpperCase();
  const b = last?.trim().charAt(0).toUpperCase() ?? '';
  return (a + b) || '?';
}
