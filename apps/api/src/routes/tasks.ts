import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from '@ostro/db';
import { projects, taskEvents, tasks, users } from '@ostro/db';
import {
  APPROVAL_QUEUE_STATUS,
  canApprove,
  canManageProject,
  canSeeTask,
  checkTransition,
  statusSideEffects,
} from '@ostro/core';
import {
  APPROVAL_PENDING_STATUSES,
  OPEN_TASK_STATUSES,
  changeTaskStatusSchema,
  createTaskSchema,
  taskListQuerySchema,
  updateTaskSchema,
} from '@ostro/shared';
import { z } from 'zod';
import { authenticate } from '../plugins/authenticate.js';

/**
 * Задачи: чтение списков и смена статусов.
 *
 * Срезы (scope) намеренно считаются на сервере, а не собираются фильтрами
 * на клиенте: «сегодня» и «просрочено» зависят от часового пояса сотрудника
 * и от текущего времени, и разъезжаться между ботом и приложением им нельзя.
 */
export async function registerTaskRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  /* ------------------------------------------------------------- Список */

  app.get('/', { schema: { querystring: taskListQuerySchema } }, async (request) => {
    const query = request.query as z.infer<typeof taskListQuerySchema>;
    const access = request.access!;
    const now = new Date();

    const filters = [];

    /** Сотрудник видит только свои задачи — это прямо следует из ТЗ. */
    if ((access.role === 'employee' && query.scope !== 'team') || query.scope === 'my') {
      filters.push(eq(tasks.assigneeId, access.userId));
    } else if (query.assigneeId) {
      filters.push(eq(tasks.assigneeId, query.assigneeId));
    }

    /**
     * «Мои» — это всё незакрытое, а не сегодняшнее.
     *
     * Раньше главный экран спрашивал срез «сегодня», и задача, поставленная
     * на завтра, просто не показывалась: исполнитель её не видел, а тот, кто
     * ставил, считал, что она не дошла. Отбор по дате остаётся у срезов,
     * которые про даты и заведены.
     */
    if (query.scope === 'my' || query.scope === undefined) {
      filters.push(inArray(tasks.status, [...OPEN_TASK_STATUSES]));
    }

    if (query.projectId) filters.push(eq(tasks.projectId, query.projectId));
    if (query.type) filters.push(eq(tasks.type, query.type));
    if (query.status?.length) filters.push(inArray(tasks.status, query.status));

    switch (query.scope) {
      case 'today': {
        /** Всё, что должно быть закрыто до конца текущих суток, плюс уже просроченное. */
        const endOfDay = new Date(now);
        endOfDay.setHours(23, 59, 59, 999);
        filters.push(lte(tasks.deadlineAt, endOfDay));
        filters.push(inArray(tasks.status, [...OPEN_TASK_STATUSES]));
        break;
      }
      case 'week': {
        const weekAhead = new Date(now.getTime() + 7 * 86_400_000);
        filters.push(gte(tasks.deadlineAt, now));
        filters.push(lte(tasks.deadlineAt, weekAhead));
        filters.push(inArray(tasks.status, [...OPEN_TASK_STATUSES]));
        break;
      }
      case 'overdue':
        filters.push(lt(tasks.deadlineAt, now));
        filters.push(inArray(tasks.status, [...OPEN_TASK_STATUSES]));
        break;
      case 'unacknowledged':
        filters.push(isNull(tasks.acknowledgedAt));
        filters.push(eq(tasks.status, 'new'));
        break;
      case 'team':
        /**
         * Задачи всей команды по проекту.
         *
         * Руководителю этот срез нужнее собственного списка: его работа —
         * видеть, что происходит у людей, а не выполнять задачи самому.
         * Сотруднику срез сужается до своих — чужие задачи ему не показываем.
         */
        if (access.role === 'employee') {
          filters.push(eq(tasks.assigneeId, access.userId));
        } else if (!query.projectId && access.projectRoles.size > 0) {
          filters.push(inArray(tasks.projectId, [...access.projectRoles.keys()]));
        }
        filters.push(inArray(tasks.status, [...OPEN_TASK_STATUSES]));
        break;
      default:
        break;
    }

    const rows = await app.db
      .select({
        task: tasks,
        projectKey: projects.key,
        projectName: projects.name,
        assigneeFirstName: users.firstName,
        assigneeLastName: users.lastName,
      })
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .leftJoin(users, eq(tasks.assigneeId, users.id))
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(
        /**
         * Сортировка по смыслу, а не по дате создания: сначала то, у чего
         * ближе срок, задачи без срока — в конце, чтобы не вытесняли срочное.
         * Просроченное оказывается сверху само собой — его срок в прошлом.
         */
        sql`${tasks.deadlineAt} asc nulls last`,
        desc(tasks.priority),
      )
      .limit(query.limit);

    return {
      items: rows
        .filter((r) => canSeeTask(access, r.task))
        .map((r) => ({
          ...serializeTask(r.task),
          ref: `${r.projectKey}-${r.task.number}`,
          projectName: r.projectName,
          assigneeName: r.assigneeFirstName
            ? [r.assigneeFirstName, r.assigneeLastName].filter(Boolean).join(' ')
            : null,
        })),
    };
  });

  /* ------------------------------------------------------------ Создание */

  app.post('/', { schema: { body: createTaskSchema } }, async (request, reply) => {
    const body = request.body as z.infer<typeof createTaskSchema>;
    const access = request.access!;

    if (!canManageProject(access, body.projectId)) {
      return reply
        .code(403)
        .send({ error: { code: 'forbidden', message: 'Нет прав создавать задачи в этом проекте' } });
    }

    const created = await app.db.transaction(async (tx) => {
      /**
       * Номер выдаётся инкрементом счётчика проекта внутри той же транзакции.
       * Считать max(number) было бы проще, но два одновременных создания
       * получили бы один и тот же номер.
       */
      const [project] = await tx
        .update(projects)
        .set({ taskCounter: sql`${projects.taskCounter} + 1` })
        .where(eq(projects.id, body.projectId))
        .returning({ key: projects.key, counter: projects.taskCounter });

      if (!project) throw new Error('Проект не найден');

      const [task] = await tx
        .insert(tasks)
        .values({
          projectId: body.projectId,
          number: project.counter,
          title: body.title,
          description: body.description ?? null,
          type: body.type,
          priority: body.priority,
          assigneeId: body.assigneeId ?? null,
          authorId: access.userId,
          deadlineAt: body.deadlineAt ? new Date(body.deadlineAt) : null,
          updatedSource: 'web',
        })
        .returning();

      await tx.insert(taskEvents).values({
        taskId: task!.id,
        actorId: access.userId,
        type: 'created',
        source: 'web',
      });

      return { task: task!, ref: `${project.key}-${project.counter}` };
    });

    /**
     * Уведомление уходит немедленно, расписание напоминаний ставится в очередь.
     *
     * Ответ на запрос при этом не ждёт Telegram: если тот недоступен,
     * задача всё равно создана, а планировщик повторит попытку.
     */
    let notified = false;
    if (created.task.assigneeId) {
      notified = await app.notifier.taskAssigned(created.task.id).catch(() => false);
    }
    await app.notifier.planReminders(created.task.id).catch((error: unknown) => {
      request.log.error({ error }, 'Не удалось поставить напоминания в очередь');
    });

    reply.code(201);
    return { ...serializeTask(created.task), ref: created.ref, notified };
  });

  /* ----------------------------------------------------- Смена статуса */

  app.post(
    '/:id/status',
    { schema: { params: z.object({ id: z.string().uuid() }), body: changeTaskStatusSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as z.infer<typeof changeTaskStatusSchema>;
      const access = request.access!;

      const [task] = await app.db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
      if (!task || !canSeeTask(access, task)) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Задача не найдена' } });
      }

      const verdict = checkTransition(
        task.status,
        body.status,
        {
          role: access.role,
          isAssignee: task.assigneeId === access.userId,
          isAuthor: task.authorId === access.userId,
        },
        { comment: body.comment },
      );

      /**
       * Руководитель проверил работу и считает её готовой, но принимать
       * не вправе. Отказать значит потерять его решение: он уже посмотрел
       * задачу и больше к ней не вернётся. Поэтому вместо отказа задача
       * встаёт в очередь к согласующему, а в ответе объясняется почему.
       */
      let target = body.status;
      let redirected = false;

      if (!verdict.ok) {
        if (verdict.code === 'needs_approval') {
          target = APPROVAL_QUEUE_STATUS;
          redirected = true;
        } else {
          return reply.code(422).send({ error: { code: verdict.code, message: verdict.message } });
        }
      }

      const now = new Date();
      const [updated] = await app.db.transaction(async (tx) => {
        const result = await tx
          .update(tasks)
          .set({
            status: target,
            ...statusSideEffects(target, now),
            blockedReason: target === 'blocked' ? (body.comment ?? null) : null,
            updatedAt: now,
            updatedSource: 'web',
          })
          .where(eq(tasks.id, id))
          .returning();

        await tx.insert(taskEvents).values({
          taskId: id,
          actorId: access.userId,
          type: target === 'acknowledged' ? 'acknowledged' : 'status_changed',
          payload: {
            from: task.status,
            to: target,
            ...(redirected ? { requested: body.status, reason: 'needs_approval' } : {}),
          },
          comment: body.comment ?? null,
          source: 'web',
        });

        return result;
      });

      return {
        ...serializeTask(updated!),
        /** Клиент показывает это предупреждение вместо ошибки. */
        notice: redirected
          ? 'Задача ушла на принятие согласующему — закрыть её может только он.'
          : null,
      };
    },
  );

  /* ------------------------------------------- Очередь согласующего */

  /**
   * Задачи, ждущие решения.
   *
   * Отдельный список нужен, потому что для согласующего это единственная
   * работа в системе: пройти по проверенному и принять или вернуть.
   * Искать такие задачи среди своих он не должен.
   */
  app.get('/awaiting-approval', async (request, reply) => {
    const access = request.access!;
    if (!canApprove(access.role)) {
      return reply
        .code(403)
        .send({ error: { code: 'forbidden', message: 'Принимать работу может только согласующий' } });
    }

    const rows = await app.db
      .select({
        task: tasks,
        projectKey: projects.key,
        projectName: projects.name,
        assigneeFirstName: users.firstName,
        assigneeLastName: users.lastName,
      })
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .leftJoin(users, eq(tasks.assigneeId, users.id))
      .where(inArray(tasks.status, [...APPROVAL_PENDING_STATUSES]))
      .orderBy(asc(tasks.updatedAt))
      .limit(100);

    return {
      items: rows.map((r) => ({
        ...serializeTask(r.task),
        ref: `${r.projectKey}-${r.task.number}`,
        projectName: r.projectName,
        assigneeName: r.assigneeFirstName
          ? [r.assigneeFirstName, r.assigneeLastName].filter(Boolean).join(' ')
          : null,
      })),
    };
  });

  /* -------------------------------------------------------- Обновление */

  app.patch(
    '/:id',
    { schema: { params: z.object({ id: z.string().uuid() }), body: updateTaskSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as z.infer<typeof updateTaskSchema>;
      const access = request.access!;

      const [task] = await app.db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
      if (!task) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Задача не найдена' } });
      }

      if (!canManageProject(access, task.projectId)) {
        return reply
          .code(403)
          .send({ error: { code: 'forbidden', message: 'Менять задачу может постановщик' } });
      }

      const deadlineChanged =
        body.deadlineAt !== undefined &&
        (body.deadlineAt === null ? task.deadlineAt !== null : true);

      const [updated] = await app.db.transaction(async (tx) => {
        const result = await tx
          .update(tasks)
          .set({
            ...(body.title !== undefined && { title: body.title }),
            ...(body.description !== undefined && { description: body.description }),
            ...(body.priority !== undefined && { priority: body.priority }),
            ...(body.assigneeId !== undefined && { assigneeId: body.assigneeId }),
            ...(body.deadlineAt !== undefined && {
              deadlineAt: body.deadlineAt ? new Date(body.deadlineAt) : null,
            }),
            lastActivityAt: new Date(),
            updatedAt: new Date(),
            updatedSource: 'web',
          })
          .where(eq(tasks.id, id))
          .returning();

        if (deadlineChanged) {
          await tx.insert(taskEvents).values({
            taskId: id,
            actorId: access.userId,
            type: 'deadline_changed',
            payload: { from: task.deadlineAt?.toISOString() ?? null, to: body.deadlineAt ?? null },
            source: 'web',
          });
        }

        return result;
      });

      /** Сдвинулся срок или сменился исполнитель — старое расписание недействительно. */
      if (deadlineChanged || body.assigneeId !== undefined) {
        await app.notifier.planReminders(id).catch(() => undefined);
      }

      return serializeTask(updated!);
    },
  );

  /* ----------------------------------------------------------- История */

  app.get(
    '/:id/events',
    { schema: { params: z.object({ id: z.string().uuid() }) } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = request.access!;

      const [task] = await app.db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
      if (!task || !canSeeTask(access, task)) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Задача не найдена' } });
      }

      return app.db
        .select()
        .from(taskEvents)
        .where(eq(taskEvents.taskId, id))
        .orderBy(asc(taskEvents.createdAt));
    },
  );
}

function serializeTask(task: typeof tasks.$inferSelect) {
  return {
    ...task,
    deadlineAt: task.deadlineAt?.toISOString() ?? null,
    acknowledgedAt: task.acknowledgedAt?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}
