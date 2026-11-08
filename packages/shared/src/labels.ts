import type {
  KpStatus,
  NotificationKind,
  ProjectStatus,
  TaskPriority,
  TaskStatus,
  TaskType,
  UserRole,
} from './enums.js';

/**
 * Русские подписи для состояний.
 *
 * Живут в одном месте, потому что одна и та же формулировка показывается
 * в трёх интерфейсах: в сообщении бота, в карточке Mini App и в ячейке
 * Google-таблицы. Если статус называется по-разному в таблице и в боте,
 * команда перестаёт доверять и тому, и другому.
 */

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  new: 'Новая',
  acknowledged: 'Принята',
  in_progress: 'В работе',
  blocked: 'Заблокирована',
  submitted: 'На проверке',
  reviewed: 'Проверено',
  rework: 'На доработке',
  awaiting_approval: 'Ждёт принятия',
  done: 'Принято',
  cancelled: 'Отменена',
};

/** Короткие подписи для кнопок — в Telegram на кнопку помещается немного. */
export const TASK_STATUS_ACTION_LABEL: Partial<Record<TaskStatus, string>> = {
  acknowledged: 'Взял',
  in_progress: 'В работе',
  blocked: 'Застрял',
  submitted: 'Сдал',
  reviewed: 'Проверено',
  rework: 'На доработку',
  done: 'Принять',
};

export const TASK_TYPE_LABEL: Record<TaskType, string> = {
  task: 'Задача',
  kp: 'КП',
  report: 'Отчёт',
  routine: 'Регулярная',
};

export const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: 'Низкий',
  normal: 'Обычный',
  high: 'Высокий',
  critical: 'Критический',
};

/**
 * Подписи статусов КП.
 *
 * Формулировки повторяют то, что команда уже пишет в статус-таблице руками —
 * иначе после первой синхронизации бот переименует 195 строк и люди перестанут
 * узнавать собственную таблицу.
 */
export const KP_STATUS_LABEL: Record<KpStatus, string> = {
  new: 'Не связывались',
  contacted: 'Ожидаю ответ',
  awaiting_quote: 'Ожидаю КП',
  received: 'КП получено',
  shortlisted: 'В коротком списке',
  rejected: 'Не подходит',
  declined: 'Отказ в сотрудничестве',
  selected: 'Выбран',
};

export const USER_ROLE_LABEL: Record<UserRole, string> = {
  admin: 'Администратор',
  head: 'Главный согласующий',
  manager: 'Руководитель',
  employee: 'Сотрудник',
};

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  active: 'В работе',
  awaiting_edits: 'Ждём правки',
  closed: 'Закрыт',
};

/**
 * Как называется повод для уведомления в настройках.
 * Формулировки от лица пользователя, а не от лица системы:
 * человек настраивает «когда мне писать», а не «cron-триггер».
 */
export const NOTIFICATION_KIND_LABEL: Record<NotificationKind, string> = {
  task_assigned: 'Мне назначили задачу',
  task_no_reaction: 'Сотрудник не отреагировал на задачу',
  deadline_approaching: 'Дедлайн приближается',
  deadline_today: 'Дедлайн сегодня',
  task_overdue: 'Задача просрочена',
  task_status_stale: 'По задаче давно нет движения',
  kp_awaiting_receipt: 'КП отправлено, получение не подтверждено',
  kp_overdue: 'КП просрочено',
  report_due: 'Пора сдать отчёт',
  report_missing: 'Отчёт не сдан',
  status_table_unfilled: 'Статус-таблица не заполнена',
  manager_digest: 'Ежедневная сводка руководителю',
  escalation: 'Эскалация руководителю',
};
