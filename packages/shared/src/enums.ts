/**
 * Единый словарь состояний системы.
 *
 * Значения этих enum'ов уезжают в три места сразу: в колонки Postgres,
 * в ячейки Google Sheets и в кнопки Telegram. Поэтому строки менять нельзя
 * без миграции — заводи новое значение вместо переименования старого.
 */

/**
 * Роль определяет, что человек может делать во всей системе.
 *
 * head — главный согласующий. Отличается от manager единственным, но
 * решающим правом: только он окончательно принимает работу. Руководители
 * проектов задачи ставят и проверяют, а закрывает их один человек —
 * иначе «выполнено» перестаёт что-либо значить.
 */
export const USER_ROLES = ['admin', 'head', 'manager', 'employee'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Состояние учётной записи. */
export const USER_STATUSES = [
  /** Админ завёл карточку, но человек ещё не нажал /start и не подтвердил личность. */
  'pending',
  'active',
  /** Уволился или временно отключён: задачи сохраняются, уведомления не шлём. */
  'disabled',
] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Роль внутри конкретного проекта — уже, чем глобальная. */
export const PROJECT_ROLES = ['lead', 'member', 'observer'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/**
 * Жизненный цикл задачи.
 *
 * Ключевой для ТЗ переход — new → acknowledged: именно он означает
 * «сотрудник увидел задачу и взял её в работу». Пока задача висит в new,
 * бот считает это отсутствием реакции и в какой-то момент эскалирует руководителю.
 */
export const TASK_STATUSES = [
  'new',
  'acknowledged',
  'in_progress',
  'blocked',
  /** Исполнитель закончил и отдал на проверку. */
  'submitted',
  /** Руководитель проверил работу, но принять её может только согласующий. */
  'reviewed',
  /** Проверка не пройдена: вернули с замечаниями. */
  'rework',
  /**
   * Руководитель попытался закрыть задачу, но такого права у него нет.
   * Задача не закрывается и не теряется — она встаёт в очередь к согласующему.
   */
  'awaiting_approval',
  'done',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Задачи, которые ещё требуют действий. Просрочка считается только для них. */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = [
  'new',
  'acknowledged',
  'in_progress',
  'blocked',
  'submitted',
  'reviewed',
  'rework',
  'awaiting_approval',
];

/** Ждут решения согласующего — из этого собирается его личный список. */
export const APPROVAL_PENDING_STATUSES: readonly TaskStatus[] = ['reviewed', 'awaiting_approval'];

/**
 * Состояние проекта целиком.
 * Отображается рядом с названием: по нему видно, куда ещё можно ставить задачи.
 */
export const PROJECT_STATUSES = ['active', 'awaiting_edits', 'closed'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const TASK_TYPES = ['task', 'kp', 'report', 'routine'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/**
 * Воронка запроса коммерческого предложения у подрядчика.
 *
 * Значения взяты из рабочей статус-таблицы агентства, где эти формулировки
 * уже прижились: «Ожидаю ответ», «Ожидаю кп», «КП получено»,
 * «Отказ в сотрудничестве». Три состояния добавлены сверх — таблица их
 * не различает, и из-за этого «КП получено» стоит и у подходящих площадок,
 * и у тех, что уже отсеяны по вместимости, а в чём разница видно только
 * из заметки в колонке ВАЖНО.
 */
export const KP_STATUSES = [
  /** Подрядчик найден, но ещё никто не писал. */
  'new',
  /** Написали — ответа нет. Именно здесь запросы и виснут дольше всего. */
  'contacted',
  /** Ответили, обещали прислать смету. */
  'awaiting_quote',
  'received',
  /** Подходит по условиям, ушёл в короткий список. */
  'shortlisted',
  /** КП есть, но подрядчик не подходит: вместимость, дата, формат. */
  'rejected',
  /** Отказался сам: занят, не работает, не тот профиль. */
  'declined',
  /** Выбран для мероприятия. */
  'selected',
] as const;
export type KpStatus = (typeof KP_STATUSES)[number];

/** Запросы, которые ещё чего-то ждут от подрядчика — по ним бот и напоминает. */
export const PENDING_KP_STATUSES: readonly KpStatus[] = ['contacted', 'awaiting_quote'];

/** Поводы, по которым бот пишет человеку. Каждый можно выключить в настройках. */
export const NOTIFICATION_KINDS = [
  'task_assigned',
  'task_no_reaction',
  'deadline_approaching',
  'deadline_today',
  'task_overdue',
  'task_status_stale',
  'kp_awaiting_receipt',
  'kp_overdue',
  'report_due',
  'report_missing',
  'status_table_unfilled',
  'manager_digest',
  'escalation',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Кому уходит уведомление, когда правило срабатывает. */
export const NOTIFICATION_TARGETS = ['assignee', 'manager', 'both'] as const;
export type NotificationTarget = (typeof NOTIFICATION_TARGETS)[number];

export const REPORT_CADENCES = ['daily', 'weekly', 'biweekly', 'monthly'] as const;
export type ReportCadence = (typeof REPORT_CADENCES)[number];

export const REPORT_STATUSES = ['pending', 'submitted', 'late', 'missed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** Откуда прилетела запись — нужно, чтобы синк с Sheets не зациклился сам на себе. */
export const RECORD_SOURCES = ['bot', 'web', 'sheets', 'system'] as const;
export type RecordSource = (typeof RECORD_SOURCES)[number];

/** Типы событий в истории задачи. Это же — лента активности в Mini App. */
export const TASK_EVENT_TYPES = [
  'created',
  'assigned',
  'acknowledged',
  'status_changed',
  'deadline_changed',
  'commented',
  'reminder_sent',
  'escalated',
  'synced_from_sheets',
  'synced_to_sheets',
] as const;
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];
