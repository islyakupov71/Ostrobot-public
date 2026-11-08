import type { TaskPriority, TaskStatus, TaskType } from '@ostro/shared';
import { SheetsClient } from './client.js';
import {
  DEFAULT_TASK_COLUMNS,
  columnToIndex,
  indexToColumn,
  parseTaskRow,
  rowHash,
  taskToRow,
  type ParsedTaskRow,
  type TaskColumnMap,
} from './mapping.js';

/**
 * Двусторонняя синхронизация задач с Google-таблицей.
 *
 * Главная опасность двустороннего синка — эхо: бот пишет строку в таблицу,
 * Apps Script видит правку и присылает webhook, бот принимает собственную
 * запись за правку человека и пишет снова. Защита здесь построена на хеше:
 * записывая строку, мы запоминаем её отпечаток, и входящее изменение с тем же
 * отпечатком распознаётся как своё собственное и игнорируется.
 *
 * Пакет намеренно ничего не знает про Drizzle — работа с базой описана
 * интерфейсом TaskSyncStore, который реализует вызывающая сторона.
 * Благодаря этому алгоритм синка тестируется без поднятого Postgres.
 */

export type SyncTask = {
  id: string;
  ref: string;
  title: string;
  description: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  type: TaskType;
  deadlineAt: Date | null;
  acknowledgedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
  sheetRow: number | null;
  sheetHash: string | null;
  sheetSyncedAt: Date | null;
};

export type SyncPatch = {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  type?: TaskType;
  deadlineAt?: Date | null;
  assigneeId?: string | null;
};

/** Порт к базе. Реализуется в приложении, здесь описан только контракт. */
export interface TaskSyncStore {
  listTasksForProject(projectId: string): Promise<SyncTask[]>;
  findUserIdByName(name: string): Promise<string | null>;
  applyPatchFromSheet(taskId: string, patch: SyncPatch, sheetHash: string): Promise<void>;
  createFromSheet(
    projectId: string,
    row: ParsedTaskRow,
    assigneeId: string | null,
  ): Promise<SyncTask>;
  markPushed(taskId: string, sheetRow: number, sheetHash: string): Promise<void>;
  recordSyncIssue(projectId: string, message: string): Promise<void>;
}

export type SyncOptions = {
  projectId: string;
  sheetName: string;
  columns?: TaskColumnMap;
  timezone?: string;
  /** Первая строка с данными: обычно 2, потому что в первой лежат заголовки. */
  firstDataRow?: number;
};

export type SyncReport = {
  pulledUpdated: number;
  pulledCreated: number;
  pushed: number;
  skippedEcho: number;
  conflicts: number;
  warnings: string[];
};

const LAST_COLUMN = 'K';

/**
 * Таблица → база.
 *
 * Читает лист целиком одним запросом и разбирает только те строки,
 * чей отпечаток изменился с прошлого раза.
 */
export async function pullFromSheet(
  client: SheetsClient,
  store: TaskSyncStore,
  options: SyncOptions,
): Promise<SyncReport> {
  const columns = options.columns ?? DEFAULT_TASK_COLUMNS;
  const firstDataRow = options.firstDataRow ?? 2;
  const report: SyncReport = {
    pulledUpdated: 0,
    pulledCreated: 0,
    pushed: 0,
    skippedEcho: 0,
    conflicts: 0,
    warnings: [],
  };

  const values = await client.readRange(
    `${options.sheetName}!A${firstDataRow}:${LAST_COLUMN}`,
  );

  const tasks = await store.listTasksForProject(options.projectId);
  const byRef = new Map(tasks.map((t) => [t.ref, t]));
  const byRow = new Map(tasks.filter((t) => t.sheetRow).map((t) => [t.sheetRow!, t]));

  for (const [offset, rawRow] of values.entries()) {
    const rowNumber = firstDataRow + offset;
    const parsed = parseTaskRow(rowNumber, rawRow, columns);
    if (!parsed) continue;

    report.warnings.push(...parsed.warnings.map((w) => `Строка ${rowNumber}: ${w}`));

    const existing = (parsed.ref && byRef.get(parsed.ref)) || byRow.get(rowNumber) || null;

    /* --- Новой строки в таблице ещё нет в базе: заводим задачу --- */
    if (!existing) {
      const assigneeId = parsed.assigneeRaw
        ? await store.findUserIdByName(parsed.assigneeRaw)
        : null;

      if (parsed.assigneeRaw && !assigneeId) {
        report.warnings.push(
          `Строка ${rowNumber}: сотрудник «${parsed.assigneeRaw}» не найден в системе`,
        );
      }

      await store.createFromSheet(options.projectId, parsed, assigneeId);
      report.pulledCreated++;
      continue;
    }

    /**
     * Отпечаток совпал с сохранённым — значит строку не меняли с момента
     * последнего синка, либо это эхо нашей собственной записи.
     */
    if (existing.sheetHash === parsed.hash) {
      report.skippedEcho++;
      continue;
    }

    /**
     * Разошлись обе стороны: и строку правили, и задачу меняли в боте
     * после последней синхронизации. Побеждает более поздняя правка —
     * но факт конфликта попадает в отчёт, чтобы расхождения не копились молча.
     */
    const dbChangedSinceSync =
      existing.sheetSyncedAt !== null && existing.updatedAt > existing.sheetSyncedAt;

    if (dbChangedSinceSync) {
      report.conflicts++;
      await store.recordSyncIssue(
        options.projectId,
        `Конфликт по задаче ${existing.ref} (строка ${rowNumber}): правки есть и в таблице, и в боте. Оставлена версия из бота.`,
      );
      continue;
    }

    const patch: SyncPatch = {};
    if (parsed.title !== existing.title) patch.title = parsed.title;
    if (parsed.description !== existing.description) patch.description = parsed.description;
    if (parsed.status && parsed.status !== existing.status) patch.status = parsed.status;
    if (parsed.priority && parsed.priority !== existing.priority) patch.priority = parsed.priority;
    if (parsed.type && parsed.type !== existing.type) patch.type = parsed.type;

    const deadlineChanged =
      (parsed.deadlineAt?.getTime() ?? null) !== (existing.deadlineAt?.getTime() ?? null);
    if (deadlineChanged) patch.deadlineAt = parsed.deadlineAt;

    if (parsed.assigneeRaw) {
      const assigneeId = await store.findUserIdByName(parsed.assigneeRaw);
      if (assigneeId && assigneeId !== existing.assigneeId) patch.assigneeId = assigneeId;
    }

    if (Object.keys(patch).length > 0) {
      await store.applyPatchFromSheet(existing.id, patch, parsed.hash);
      report.pulledUpdated++;
    }
  }

  return report;
}

/**
 * База → таблица.
 *
 * Отправляет одним batchUpdate все задачи, изменившиеся с последнего пуша.
 * Задачи, которых в таблице ещё нет, дописываются в конец листа.
 */
export async function pushToSheet(
  client: SheetsClient,
  store: TaskSyncStore,
  options: SyncOptions,
): Promise<SyncReport> {
  const timezone = options.timezone ?? 'Europe/Moscow';
  const report: SyncReport = {
    pulledUpdated: 0,
    pulledCreated: 0,
    pushed: 0,
    skippedEcho: 0,
    conflicts: 0,
    warnings: [],
  };

  const tasks = await store.listTasksForProject(options.projectId);

  const updates: { range: string; values: unknown[][] }[] = [];
  const pending: { task: SyncTask; row: string[] }[] = [];
  const appends: { task: SyncTask; row: string[] }[] = [];

  for (const task of tasks) {
    const needsPush = task.sheetSyncedAt === null || task.updatedAt > task.sheetSyncedAt;
    if (!needsPush) continue;

    const row = taskToRow(task, timezone);

    if (task.sheetRow) {
      const firstCol = indexToColumn(columnToIndex(DEFAULT_TASK_COLUMNS.ref));
      updates.push({
        range: `${options.sheetName}!${firstCol}${task.sheetRow}:${LAST_COLUMN}${task.sheetRow}`,
        values: [row],
      });
      pending.push({ task, row });
    } else {
      appends.push({ task, row });
    }
  }

  if (updates.length > 0) {
    await client.batchUpdate(updates);
    for (const { task, row } of pending) {
      await store.markPushed(task.id, task.sheetRow!, rowHash(row));
      report.pushed++;
    }
  }

  if (appends.length > 0) {
    const firstRow = await client.appendRows(
      options.sheetName,
      appends.map((a) => a.row),
    );

    if (firstRow !== null) {
      for (const [index, { task, row }] of appends.entries()) {
        await store.markPushed(task.id, firstRow + index, rowHash(row));
        report.pushed++;
      }
    } else {
      report.warnings.push('Не удалось определить номера добавленных строк — синк повторится.');
    }
  }

  return report;
}

/**
 * Полный цикл: сначала забираем правки людей, потом отдаём изменения бота.
 * Порядок важен — так правка человека, сделанная только что, не будет
 * затёрта нашей записью в том же проходе.
 */
export async function syncProject(
  client: SheetsClient,
  store: TaskSyncStore,
  options: SyncOptions,
): Promise<SyncReport> {
  const pulled = await pullFromSheet(client, store, options);
  const pushed = await pushToSheet(client, store, options);

  return {
    pulledUpdated: pulled.pulledUpdated,
    pulledCreated: pulled.pulledCreated,
    pushed: pushed.pushed,
    skippedEcho: pulled.skippedEcho,
    conflicts: pulled.conflicts,
    warnings: [...pulled.warnings, ...pushed.warnings],
  };
}
