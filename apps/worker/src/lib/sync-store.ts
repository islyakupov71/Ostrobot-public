import type PgBoss from 'pg-boss';
import { and, eq, ilike, or, sql } from '@ostro/db';
import { projects, taskEvents, tasks, users, type Database } from '@ostro/db';
import type { ParsedTaskRow, SyncPatch, SyncTask, TaskSyncStore } from '@ostro/sheets';

/**
 * Реализация порта синхронизации поверх Drizzle.
 *
 * Пакет @ostro/sheets описывает алгоритм и ничего не знает о базе;
 * вся работа с таблицами собрана здесь, чтобы алгоритм можно было
 * протестировать на подставном хранилище без Postgres.
 */
export function createSyncStore(db: Database, boss: PgBoss): TaskSyncStore {
  return {
    async listTasksForProject(projectId: string): Promise<SyncTask[]> {
      const rows = await db
        .select({
          task: tasks,
          projectKey: projects.key,
          firstName: users.firstName,
          lastName: users.lastName,
        })
        .from(tasks)
        .innerJoin(projects, eq(tasks.projectId, projects.id))
        .leftJoin(users, eq(tasks.assigneeId, users.id))
        .where(eq(tasks.projectId, projectId));

      return rows.map(({ task, projectKey, firstName, lastName }) => ({
        id: task.id,
        ref: `${projectKey}-${task.number}`,
        title: task.title,
        description: task.description,
        assigneeId: task.assigneeId,
        assigneeName: firstName ? [firstName, lastName].filter(Boolean).join(' ') : null,
        status: task.status,
        priority: task.priority,
        type: task.type,
        deadlineAt: task.deadlineAt,
        acknowledgedAt: task.acknowledgedAt,
        completedAt: task.completedAt,
        updatedAt: task.updatedAt,
        sheetRow: task.sheetRow,
        sheetHash: task.sheetHash,
        sheetSyncedAt: task.sheetSyncedAt,
      }));
    },

    /**
     * Поиск сотрудника по тому, как его записали в таблице.
     *
     * В ячейке может стоять что угодно: «Сотрудник 01», «Демо Сотрудник», «@demo_user».
     * Проверяем все три написания; если не нашли — задача создастся
     * без исполнителя, а строка попадёт в предупреждения синка.
     */
    async findUserIdByName(name: string): Promise<string | null> {
      const cleaned = name.trim().replace(/^@/, '');
      if (!cleaned) return null;

      const [found] = await db
        .select({ id: users.id })
        .from(users)
        .where(
          or(
            ilike(users.telegramUsername, cleaned),
            ilike(users.firstName, cleaned),
            sql`lower(${users.firstName} || ' ' || coalesce(${users.lastName}, '')) = lower(${cleaned})`,
          ),
        )
        .limit(1);

      return found?.id ?? null;
    },

    async applyPatchFromSheet(taskId: string, patch: SyncPatch, sheetHash: string) {
      const now = new Date();

      await db.transaction(async (tx) => {
        await tx
          .update(tasks)
          .set({
            ...patch,
            sheetHash,
            sheetSyncedAt: now,
            lastActivityAt: now,
            updatedAt: now,
            /** Помечаем источник, чтобы следующий проход не принял это за правку человека в боте. */
            updatedSource: 'sheets',
          })
          .where(eq(tasks.id, taskId));

        await tx.insert(taskEvents).values({
          taskId,
          type: 'synced_from_sheets',
          payload: patch as Record<string, unknown>,
          source: 'sheets',
        });
      });

      /** Срок мог измениться — расписание напоминаний нужно пересобрать. */
      if ('deadlineAt' in patch || 'status' in patch) {
        await boss.send('reminders.plan', { taskId }, { singletonKey: taskId, singletonSeconds: 5 });
      }
    },

    async createFromSheet(projectId: string, row: ParsedTaskRow, assigneeId: string | null) {
      const now = new Date();

      const created = await db.transaction(async (tx) => {
        const [project] = await tx
          .update(projects)
          .set({ taskCounter: sql`${projects.taskCounter} + 1` })
          .where(eq(projects.id, projectId))
          .returning({ key: projects.key, counter: projects.taskCounter });

        if (!project) throw new Error('Проект не найден');

        const [task] = await tx
          .insert(tasks)
          .values({
            projectId,
            number: project.counter,
            title: row.title,
            description: row.description,
            status: row.status ?? 'new',
            priority: row.priority ?? 'normal',
            type: row.type ?? 'task',
            assigneeId,
            deadlineAt: row.deadlineAt,
            sheetRow: row.rowNumber,
            sheetHash: row.hash,
            sheetSyncedAt: now,
            updatedSource: 'sheets',
          })
          .returning();

        await tx.insert(taskEvents).values({
          taskId: task!.id,
          type: 'synced_from_sheets',
          payload: { row: row.rowNumber },
          source: 'sheets',
        });

        return { task: task!, ref: `${project.key}-${project.counter}` };
      });

      await boss.send('reminders.plan', { taskId: created.task.id });

      return {
        id: created.task.id,
        ref: created.ref,
        title: created.task.title,
        description: created.task.description,
        assigneeId: created.task.assigneeId,
        assigneeName: null,
        status: created.task.status,
        priority: created.task.priority,
        type: created.task.type,
        deadlineAt: created.task.deadlineAt,
        acknowledgedAt: created.task.acknowledgedAt,
        completedAt: created.task.completedAt,
        updatedAt: created.task.updatedAt,
        sheetRow: created.task.sheetRow,
        sheetHash: created.task.sheetHash,
        sheetSyncedAt: created.task.sheetSyncedAt,
      };
    },

    async markPushed(taskId: string, sheetRow: number, sheetHash: string) {
      await db
        .update(tasks)
        .set({ sheetRow, sheetHash, sheetSyncedAt: new Date() })
        .where(eq(tasks.id, taskId));
    },

    async recordSyncIssue(projectId: string, message: string) {
      /** Конфликты не теряем: они видны администратору в системном журнале. */
      await db.execute(
        sql`insert into audit_log (action, entity_type, entity_id, payload, source)
            values ('sync_conflict', 'project', ${projectId}, ${JSON.stringify({ message })}::jsonb, 'sheets')`,
      );
    },
  };
}
