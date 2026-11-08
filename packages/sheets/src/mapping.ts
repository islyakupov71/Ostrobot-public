import { createHash } from 'node:crypto';
import {
  KP_STATUS_LABEL,
  TASK_PRIORITY_LABEL,
  TASK_STATUS_LABEL,
  TASK_TYPE_LABEL,
  type KpStatus,
  type TaskPriority,
  type TaskStatus,
  type TaskType,
} from '@ostro/shared';

/**
 * Мост между строкой Google-таблицы и записью в базе.
 *
 * Люди в таблице пишут по-русски и не всегда одинаково: «в работе», «В работе»,
 * «в рабо­те » с лишним пробелом. База же хранит строгий enum. Весь разбор этой
 * разницы собран здесь, чтобы синхронизация оставалась предсказуемой,
 * а таблицу не пришлось запрещать редактировать руками.
 */

/**
 * Какая колонка листа за что отвечает.
 * Значения — буквы столбцов, как их видит человек в таблице.
 * Настраивается под конкретную книгу, а не зашивается в код.
 */
export type TaskColumnMap = {
  ref: string;
  title: string;
  description: string;
  assignee: string;
  status: string;
  priority: string;
  type: string;
  deadline: string;
  acknowledgedAt: string;
  completedAt: string;
  comment: string;
};

export const DEFAULT_TASK_COLUMNS: TaskColumnMap = {
  ref: 'A',
  title: 'B',
  description: 'C',
  assignee: 'D',
  status: 'E',
  priority: 'F',
  type: 'G',
  deadline: 'H',
  acknowledgedAt: 'I',
  completedAt: 'J',
  comment: 'K',
};

/** Заголовки, которые бот пишет в первую строку листа при первичной настройке. */
export const TASK_HEADERS: Record<keyof TaskColumnMap, string> = {
  ref: 'Номер',
  title: 'Задача',
  description: 'Описание',
  assignee: 'Исполнитель',
  status: 'Статус',
  priority: 'Приоритет',
  type: 'Тип',
  deadline: 'Дедлайн',
  acknowledgedAt: 'Принято',
  completedAt: 'Выполнено',
  comment: 'Комментарий',
};

export function columnToIndex(letter: string): number {
  let index = 0;
  for (const char of letter.toUpperCase()) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

export function indexToColumn(index: number): string {
  let result = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

/* ------------------------------------------------------ Разбор значений */

function normalize(value: unknown): string {
  return String(value ?? '')
    .replace(/­/g, '') // мягкий перенос, который иногда приезжает из копипаста
    .trim()
    .toLowerCase();
}

/** Обратные словари: русская подпись из таблицы → значение enum. */
function buildReverse<T extends string>(labels: Record<T, string>): Map<string, T> {
  const map = new Map<string, T>();
  for (const [key, label] of Object.entries(labels) as [T, string][]) {
    map.set(normalize(label), key);
    map.set(normalize(key), key);
  }
  return map;
}

const STATUS_FROM_LABEL = buildReverse(TASK_STATUS_LABEL);
const PRIORITY_FROM_LABEL = buildReverse(TASK_PRIORITY_LABEL);
const TYPE_FROM_LABEL = buildReverse(TASK_TYPE_LABEL);

/**
 * Синонимы, которыми команда пользуется в таблице на практике.
 * Список пополняется по мере того, как в логах синка всплывают неразобранные значения.
 */
const STATUS_SYNONYMS: Record<string, TaskStatus> = {
  'принял': 'acknowledged',
  'принята': 'acknowledged',
  'взял': 'acknowledged',
  'в работе': 'in_progress',
  'делаю': 'in_progress',
  'застрял': 'blocked',
  'блок': 'blocked',
  'на проверке': 'submitted',
  'сдал': 'submitted',
  'готово': 'done',
  'сделано': 'done',
  'выполнено': 'done',
  'отменено': 'cancelled',
  'отмена': 'cancelled',
  '': 'new',
};

export function parseTaskStatus(value: unknown): TaskStatus | null {
  const key = normalize(value);
  return STATUS_SYNONYMS[key] ?? STATUS_FROM_LABEL.get(key) ?? null;
}

export function parseTaskPriority(value: unknown): TaskPriority | null {
  const key = normalize(value);
  if (key === '') return 'normal';
  if (key === 'срочно' || key === 'горит') return 'critical';
  return PRIORITY_FROM_LABEL.get(key) ?? null;
}

export function parseTaskType(value: unknown): TaskType | null {
  const key = normalize(value);
  if (key === '') return 'task';
  return TYPE_FROM_LABEL.get(key) ?? null;
}

/**
 * Статусы КП разбираются в status-table.ts — там же, где живёт остальная
 * логика листа подрядчиков со своими синонимами и заголовками категорий.
 * Здесь остаётся только словарь подписей для обратной записи в таблицу.
 */
export function kpStatusLabel(status: KpStatus): string {
  return KP_STATUS_LABEL[status];
}

/**
 * Разбор даты из ячейки.
 *
 * Google отдаёт даты по-разному в зависимости от формата ячейки: либо строкой
 * «12.04.2026 18:00», либо серийным числом от 30.12.1899. Поддерживаем оба,
 * плюс ISO — на случай, если значение положил туда сам бот.
 */
export function parseSheetDate(value: unknown, timezoneOffsetHours = 3): Date | null {
  if (value == null || value === '') return null;

  if (typeof value === 'number') {
    /** Серийная дата Google Sheets: дни с 30 декабря 1899 года. */
    const epoch = Date.UTC(1899, 11, 30);
    return new Date(epoch + Math.round(value * 86_400_000));
  }

  const raw = String(value).trim();

  const ru = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})(?:[ ,]+(\d{1,2}):(\d{2}))?$/.exec(raw);
  if (ru) {
    const [, d, m, y, hh = '0', mm = '0'] = ru;
    const utcMillis = Date.UTC(
      Number(y),
      Number(m) - 1,
      Number(d),
      Number(hh) - timezoneOffsetHours,
      Number(mm),
    );
    return new Date(utcMillis);
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Формат, в котором бот пишет даты обратно в таблицу — привычный человеку. */
export function formatSheetDate(date: Date | null, timezone = 'Europe/Moscow'): string {
  if (!date) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/* ------------------------------------------------------------ Хеширование */

/**
 * Отпечаток строки таблицы.
 *
 * Синхронизатор сравнивает его с сохранённым sheetHash: совпал — в таблице
 * с прошлого раза ничего не трогали, и строку можно пропустить, не разбирая.
 * На листе в несколько тысяч строк это разница между секундой и минутой работы.
 */
export function rowHash(values: readonly unknown[]): string {
  const payload = values.map((v) => String(v ?? '').trim()).join('');
  return createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

/** Значения строки в порядке колонок — то, что уходит в rowHash и в таблицу. */
export function taskToRow(
  task: {
    ref: string;
    title: string;
    description: string | null;
    assigneeName: string | null;
    status: TaskStatus;
    priority: TaskPriority;
    type: TaskType;
    deadlineAt: Date | null;
    acknowledgedAt: Date | null;
    completedAt: Date | null;
  },
  timezone = 'Europe/Moscow',
): string[] {
  return [
    task.ref,
    task.title,
    task.description ?? '',
    task.assigneeName ?? '',
    TASK_STATUS_LABEL[task.status],
    TASK_PRIORITY_LABEL[task.priority],
    TASK_TYPE_LABEL[task.type],
    formatSheetDate(task.deadlineAt, timezone),
    formatSheetDate(task.acknowledgedAt, timezone),
    formatSheetDate(task.completedAt, timezone),
  ];
}

export type ParsedTaskRow = {
  rowNumber: number;
  ref: string | null;
  title: string;
  description: string | null;
  assigneeRaw: string | null;
  status: TaskStatus | null;
  priority: TaskPriority | null;
  type: TaskType | null;
  deadlineAt: Date | null;
  hash: string;
  /** Значения, которые не удалось разобрать — уходят в лог синка, а не теряются молча. */
  warnings: string[];
};

export function parseTaskRow(
  rowNumber: number,
  values: readonly unknown[],
  columns: TaskColumnMap = DEFAULT_TASK_COLUMNS,
): ParsedTaskRow | null {
  const at = (col: string) => values[columnToIndex(col)];
  const title = String(at(columns.title) ?? '').trim();

  /** Пустая строка — не ошибка, просто конец данных или разделитель. */
  if (!title) return null;

  const warnings: string[] = [];

  const status = parseTaskStatus(at(columns.status));
  if (status === null && normalize(at(columns.status)) !== '') {
    warnings.push(`Не понял статус «${String(at(columns.status))}»`);
  }

  const priority = parseTaskPriority(at(columns.priority));
  if (priority === null) warnings.push(`Не понял приоритет «${String(at(columns.priority))}»`);

  const type = parseTaskType(at(columns.type));
  if (type === null) warnings.push(`Не понял тип «${String(at(columns.type))}»`);

  return {
    rowNumber,
    ref: String(at(columns.ref) ?? '').trim() || null,
    title,
    description: String(at(columns.description) ?? '').trim() || null,
    assigneeRaw: String(at(columns.assignee) ?? '').trim() || null,
    status,
    priority,
    type,
    deadlineAt: parseSheetDate(at(columns.deadline)),
    hash: rowHash(values),
    warnings,
  };
}
