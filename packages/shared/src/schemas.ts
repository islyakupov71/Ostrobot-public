import { z } from 'zod';
import {
  KP_STATUSES,
  NOTIFICATION_KINDS,
  NOTIFICATION_TARGETS,
  PROJECT_ROLES,
  REPORT_CADENCES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  USER_ROLES,
  USER_STATUSES,
} from './enums.js';

/**
 * Контракт HTTP-API.
 *
 * Fastify валидирует вход этими же схемами, а Mini App выводит из них типы —
 * поэтому расхождения между фронтом и бэком ловятся компилятором,
 * а не пользователем в проде.
 */

export const uuid = z.string().uuid();
export const isoDateTime = z.string().datetime({ offset: true });

/* ---------------------------------------------------------------- Пользователи */

export const userSchema = z.object({
  id: uuid,
  telegramId: z.string().nullable(),
  telegramUsername: z.string().nullable(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  position: z.string().nullable(),
  role: z.enum(USER_ROLES),
  status: z.enum(USER_STATUSES),
  timezone: z.string(),
  createdAt: isoDateTime,
});
export type User = z.infer<typeof userSchema>;

export const createUserSchema = z.object({
  firstName: z.string().min(1, 'Имя обязательно').max(80),
  lastName: z.string().max(80).optional(),
  position: z.string().max(120).optional(),
  role: z.enum(USER_ROLES).default('employee'),
  /**
   * Telegram ID знать заранее необязательно — админ редко его видит.
   * Достаточно @username, а сопоставление произойдёт при первом /start.
   * Если нет и username, сотрудник войдёт по одноразовому коду приглашения.
   */
  telegramId: z.string().regex(/^\d+$/, 'Telegram ID — это только цифры').optional(),
  telegramUsername: z
    .string()
    .regex(/^@?[A-Za-z0-9_]{5,32}$/, 'Похоже, это не username Telegram')
    .transform((v) => v.replace(/^@/, ''))
    .optional(),
  timezone: z.string().default('Europe/Moscow'),
  projectIds: z.array(uuid).default([]),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = createUserSchema.partial().extend({
  status: z.enum(USER_STATUSES).optional(),
});

/* ------------------------------------------------------------------- Проекты */

export const projectSchema = z.object({
  id: uuid,
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  spreadsheetId: z.string().nullable(),
  driveFolderUrl: z.string().nullable(),
  eventDate: isoDateTime.nullable(),
  isArchived: z.boolean(),
  createdAt: isoDateTime,
});
export type Project = z.infer<typeof projectSchema>;

export const createProjectSchema = z.object({
  /** Короткий код проекта — из него собирается номер задачи: DEMO-42. */
  key: z
    .string()
    .min(2)
    .max(8)
    .regex(/^[A-ZА-Я0-9]+$/i, 'Код проекта — буквы и цифры без пробелов, например DEMO'),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  /** Дата мероприятия: от неё считаются сроки закупки. */
  eventDate: isoDateTime.optional(),

  /**
   * Что делать с рабочими файлами.
   * create — бот копирует шаблон таблицы и создаёт папку с подпапками категорий;
   * link — привязать уже существующие;
   * none — пока без файлов, привязать позже.
   */
  workspace: z
    .discriminatedUnion('mode', [
      z.object({
        mode: z.literal('create'),
        /** Категории закупки для нового проекта; по умолчанию берётся типовой набор. */
        categories: z.array(z.string().min(1).max(80)).optional(),
      }),
      z.object({
        mode: z.literal('link'),
        spreadsheetId: z.string().min(10),
        driveFolderId: z.string().min(10).optional(),
      }),
      z.object({ mode: z.literal('none') }),
    ])
    .default({ mode: 'create' }),
});

export const projectMemberSchema = z.object({
  projectId: uuid,
  userId: uuid,
  role: z.enum(PROJECT_ROLES),
});

/* -------------------------------------------------------------------- Задачи */

export const taskSchema = z.object({
  id: uuid,
  projectId: uuid,
  /** Человекочитаемый номер вида ROM-42 — им удобно ссылаться в переписке. */
  ref: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  type: z.enum(TASK_TYPES),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES),
  assigneeId: uuid.nullable(),
  authorId: uuid.nullable(),
  deadlineAt: isoDateTime.nullable(),
  acknowledgedAt: isoDateTime.nullable(),
  completedAt: isoDateTime.nullable(),
  blockedReason: z.string().nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type Task = z.infer<typeof taskSchema>;

export const createTaskSchema = z.object({
  projectId: uuid,
  title: z.string().min(1, 'Без названия задачу не найти').max(200),
  description: z.string().max(4000).optional(),
  type: z.enum(TASK_TYPES).default('task'),
  priority: z.enum(TASK_PRIORITIES).default('normal'),
  assigneeId: uuid.optional(),
  deadlineAt: isoDateTime.optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  assigneeId: uuid.nullable().optional(),
  deadlineAt: isoDateTime.nullable().optional(),
});

export const changeTaskStatusSchema = z.object({
  status: z.enum(TASK_STATUSES),
  /** Для статуса blocked причина обязательна, иначе руководитель не поймёт, чем помочь. */
  comment: z.string().max(1000).optional(),
});

export const taskListQuerySchema = z.object({
  projectId: uuid.optional(),
  assigneeId: uuid.optional(),
  status: z.array(z.enum(TASK_STATUSES)).optional(),
  type: z.enum(TASK_TYPES).optional(),
  /** Готовые срезы под вкладки Mini App. */
  scope: z.enum(['my', 'today', 'week', 'overdue', 'unacknowledged', 'team']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

/* --------------------------------------------------- Подрядчики и запросы КП */

export const vendorSchema = z.object({
  id: uuid,
  name: z.string(),
  website: z.string().nullable(),
  contacts: z.string().nullable(),
  address: z.string().nullable(),
  kind: z.string().nullable(),
  isBlacklisted: z.boolean(),
});
export type Vendor = z.infer<typeof vendorSchema>;

export const procurementCategorySchema = z.object({
  id: uuid,
  projectId: uuid,
  name: z.string(),
  sortOrder: z.number().int(),
  driveFolderId: z.string().nullable(),
  targetQuotes: z.number().int().nullable(),
});

export const quoteRequestSchema = z.object({
  id: uuid,
  projectId: uuid,
  categoryId: uuid.nullable(),
  vendor: vendorSchema,
  status: z.enum(KP_STATUSES),
  responsibleId: uuid.nullable(),
  amount: z.number().nullable(),
  currency: z.string(),
  terms: z.string().nullable(),
  note: z.string().nullable(),
  requestedAt: isoDateTime.nullable(),
  respondedAt: isoDateTime.nullable(),
  receivedAt: isoDateTime.nullable(),
  driveFileUrl: z.string().nullable(),
  /** Сколько дней подрядчик молчит. Считается на сервере — по нему сортируется список. */
  silentDays: z.number().int().nullable(),
  createdAt: isoDateTime,
});
export type QuoteRequest = z.infer<typeof quoteRequestSchema>;

export const createQuoteRequestSchema = z.object({
  projectId: uuid,
  categoryId: uuid.optional(),
  /** Либо существующий подрядчик из справочника, либо новый — тогда нужно имя. */
  vendorId: uuid.optional(),
  vendorName: z.string().min(1).max(200).optional(),
  vendorContacts: z.string().max(2000).optional(),
  responsibleId: uuid.optional(),
});

export const changeQuoteStatusSchema = z.object({
  status: z.enum(KP_STATUSES),
  amount: z.number().nonnegative().optional(),
  terms: z.string().max(2000).optional(),
  note: z.string().max(2000).optional(),
});

export const quoteListQuerySchema = z.object({
  projectId: uuid.optional(),
  categoryId: uuid.optional(),
  responsibleId: uuid.optional(),
  status: z.array(z.enum(KP_STATUSES)).optional(),
  /** Готовые срезы: «молчат дольше недели», «мои», «есть КП без цены». */
  scope: z.enum(['mine', 'silent', 'received', 'no_price', 'all']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Сводка по категории — то, что руководитель хочет видеть первым. */
export const categoryProgressSchema = z.object({
  categoryId: uuid,
  name: z.string(),
  total: z.number().int(),
  received: z.number().int(),
  pending: z.number().int(),
  declined: z.number().int(),
  /** Самое долгое молчание в категории, в днях. */
  worstSilentDays: z.number().int().nullable(),
  minAmount: z.number().nullable(),
  maxAmount: z.number().nullable(),
});
export type CategoryProgress = z.infer<typeof categoryProgressSchema>;

/* --------------------------------------------------------------- Отчётность */

export const reportTemplateSchema = z.object({
  id: uuid,
  projectId: uuid.nullable(),
  name: z.string(),
  cadence: z.enum(REPORT_CADENCES),
  /** Локальное время дедлайна сдачи в часовом поясе сотрудника, HH:mm. */
  dueTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** Дни недели для weekly: 1 — понедельник, 7 — воскресенье. */
  weekdays: z.array(z.number().int().min(1).max(7)).default([]),
  /** День месяца для monthly. */
  monthDay: z.number().int().min(1).max(31).nullable(),
  isActive: z.boolean(),
});

export const submitReportSchema = z.object({
  templateId: uuid,
  /** Свободная форма: что сделано, что мешает, что дальше. */
  payload: z.record(z.string(), z.unknown()),
});

/* ---------------------------------------------- Правила уведомлений (админ) */

export const notificationRuleSchema = z.object({
  id: uuid,
  projectId: uuid.nullable(),
  kind: z.enum(NOTIFICATION_KINDS),
  /**
   * Сдвиг относительно опорного момента, в минутах.
   * Отрицательный — до дедлайна (-1440 = за сутки),
   * положительный — после (60 = через час после просрочки).
   */
  offsetMinutes: z.number().int(),
  /** Для повторяющихся напоминаний: раз в сколько минут повторять. 0 — однократно. */
  repeatEveryMinutes: z.number().int().min(0).default(0),
  maxRepeats: z.number().int().min(0).default(0),
  target: z.enum(NOTIFICATION_TARGETS),
  respectQuietHours: z.boolean(),
  isEnabled: z.boolean(),
});
export type NotificationRule = z.infer<typeof notificationRuleSchema>;

export const upsertNotificationRuleSchema = notificationRuleSchema.omit({ id: true }).partial({
  projectId: true,
  repeatEveryMinutes: true,
  maxRepeats: true,
});

/* -------------------------------------------------------------------- Сводки */

export const teamMemberSummarySchema = z.object({
  user: userSchema,
  openTasks: z.number().int(),
  overdueTasks: z.number().int(),
  /** Сколько задач висит непринятыми — главный индикатор, что человек не в контакте. */
  unacknowledgedTasks: z.number().int(),
  dueTodayTasks: z.number().int(),
  lastActivityAt: isoDateTime.nullable(),
});
export type TeamMemberSummary = z.infer<typeof teamMemberSummarySchema>;

export const projectSummarySchema = z.object({
  project: projectSchema,
  totalOpen: z.number().int(),
  overdue: z.number().int(),
  dueToday: z.number().int(),
  unacknowledged: z.number().int(),
  doneLast7Days: z.number().int(),
  /** Доля задач, закрытых в срок за последние 30 дней, 0..1 — здоровье проекта. */
  onTimeRate: z.number().min(0).max(1).nullable(),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

/* ---------------------------------------------------------------- Авторизация */

export const authResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  user: userSchema,
});

/** Стандартная форма ошибки — одна на всё API, чтобы фронт разбирал её в одном месте. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
