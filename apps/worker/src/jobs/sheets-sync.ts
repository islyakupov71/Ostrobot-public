import { eq, isNotNull } from '@ostro/db';
import { projects, syncState } from '@ostro/db';
import { SheetsClient, syncProject } from '@ostro/sheets';
import { createSyncStore } from '../lib/sync-store.js';
import { ensureQueue } from '../lib/queue.js';
import type { JobContext } from '../index.js';

/**
 * Синхронизация с Google-таблицами.
 *
 * Полный проход по всем проектам идёт по расписанию и служит страховкой:
 * основной путь — webhook от Apps Script, но он работает на квотах Google
 * и может молча отвалиться. Расхождение, которое переживёт один тик,
 * не переживёт следующий.
 */

const SYNC_QUEUE = 'sheets.sync';
const ROW_QUEUE = 'sheets.row-changed';

export async function registerSheetsJobs(ctx: JobContext) {
  const { boss, db, logger } = ctx;

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY;

  if (!email || !key) {
    logger.warn('Google Sheets не настроен — синхронизация выключена');
    return;
  }

  await ensureQueue(boss, SYNC_QUEUE);
  await ensureQueue(boss, ROW_QUEUE);

  await boss.work(SYNC_QUEUE, async () => {
    const rows = await db.select().from(projects).where(isNotNull(projects.spreadsheetId));

    for (const project of rows) {
      if (project.isArchived || !project.spreadsheetId) continue;

      /**
       * Лист задач синхронизируется, только если он явно назван.
       *
       * У этой команды задачи в таблицах не ведутся вовсе — они живут
       * в системе. Пытаться читать несуществующий лист значит каждые пять
       * минут получать отказ и засорять журнал так, что настоящие ошибки
       * в нём теряются.
       */
      if (!project.tasksSheetName) continue;

      const client = new SheetsClient({
        serviceAccountEmail: email,
        privateKey: key,
        spreadsheetId: project.spreadsheetId,
      });

      try {
        const report = await syncProject(client, createSyncStore(db, ctx.boss), {
          projectId: project.id,
          sheetName: project.tasksSheetName,
        });

        await db
          .insert(syncState)
          .values({
            projectId: project.id,
            entity: 'tasks',
            lastPulledAt: new Date(),
            lastPushedAt: new Date(),
            consecutiveFailures: 0,
          })
          .onConflictDoUpdate({
            target: [syncState.projectId, syncState.entity],
            set: {
              lastPulledAt: new Date(),
              lastPushedAt: new Date(),
              consecutiveFailures: 0,
              lastError: null,
              updatedAt: new Date(),
            },
          });

        if (report.warnings.length > 0) {
          logger.warn({ project: project.key, warnings: report.warnings }, 'Синк с замечаниями');
        }

        logger.info(
          {
            project: project.key,
            created: report.pulledCreated,
            updated: report.pulledUpdated,
            pushed: report.pushed,
            conflicts: report.conflicts,
          },
          'Синхронизация завершена',
        );
      } catch (error) {
        const message = (error as Error).message ?? '';

        /**
         * Листа с таким именем в книге нет. Повторять бессмысленно —
         * сам он не появится, а отказ будет приходить каждые пять минут.
         * Отвязываем лист и говорим об этом один раз.
         */
        if (message.includes('Unable to parse range') || message.includes('not found')) {
          await db
            .update(projects)
            .set({ tasksSheetName: null })
            .where(eq(projects.id, project.id));

          logger.warn(
            { project: project.key, sheet: project.tasksSheetName },
            'Листа задач нет в книге — синхронизация задач для проекта отключена',
          );
          continue;
        }

        logger.error({ error, project: project.key }, 'Синхронизация не удалась');

        await db
          .update(syncState)
          .set({
            lastError: message,
            consecutiveFailures: 1,
            updatedAt: new Date(),
          })
          .where(eq(syncState.projectId, project.id));
      }
    }
  });

  /**
   * Точечная обработка одной правки из webhook.
   * singletonKey по строке склеивает серию быстрых правок одной ячейки
   * в одну обработку — иначе редактирование строки давало бы десяток заданий.
   */
  await boss.work<{ sheetName: string; row: number }>(ROW_QUEUE, async (jobs) => {
    const job = jobs[0];
    if (!job) return;
    logger.debug({ row: job.data.row }, 'Обработка правки строки');
    await boss.send(SYNC_QUEUE, {});
  });

  const intervalSec = Number(process.env.SHEETS_POLL_INTERVAL_SEC ?? 300);
  const minutes = Math.max(1, Math.round(intervalSec / 60));
  await boss.schedule(SYNC_QUEUE, `*/${minutes} * * * *`);

  logger.info({ everyMinutes: minutes }, 'Синхронизация с Sheets настроена');
}
