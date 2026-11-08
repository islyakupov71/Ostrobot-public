import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import {
  KP_STATUSES,
  NOTIFICATION_KINDS,
  NOTIFICATION_TARGETS,
  PROJECT_ROLES,
  PROJECT_STATUSES,
  RECORD_SOURCES,
  REPORT_CADENCES,
  REPORT_STATUSES,
  TASK_EVENT_TYPES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  USER_ROLES,
  USER_STATUSES,
} from '@ostro/shared';

/**
 * Схема базы данных ОСТРО.
 *
 * Postgres здесь — источник правды. Google-таблица остаётся рабочим листом
 * для людей и синхронизируется в обе стороны; поля sheetRow / sheetHash /
 * sheetSyncedAt в каждой синхронизируемой таблице — это вся механика,
 * которая для этого нужна.
 */

/** Drizzle ожидает изменяемый кортеж, а словари в @ostro/shared объявлены как const. */
const values = <T extends readonly [string, ...string[]]>(v: T) =>
  v as unknown as [T[number], ...T[number][]];

/* ============================================================ Перечисления */

export const userRoleEnum = pgEnum('user_role', values(USER_ROLES));
export const userStatusEnum = pgEnum('user_status', values(USER_STATUSES));
export const projectRoleEnum = pgEnum('project_role', values(PROJECT_ROLES));
export const projectStatusEnum = pgEnum('project_status', values(PROJECT_STATUSES));
export const taskStatusEnum = pgEnum('task_status', values(TASK_STATUSES));
export const taskTypeEnum = pgEnum('task_type', values(TASK_TYPES));
export const taskPriorityEnum = pgEnum('task_priority', values(TASK_PRIORITIES));
export const taskEventTypeEnum = pgEnum('task_event_type', values(TASK_EVENT_TYPES));
export const kpStatusEnum = pgEnum('kp_status', values(KP_STATUSES));
export const notificationKindEnum = pgEnum('notification_kind', values(NOTIFICATION_KINDS));
export const notificationTargetEnum = pgEnum('notification_target', values(NOTIFICATION_TARGETS));
export const reportCadenceEnum = pgEnum('report_cadence', values(REPORT_CADENCES));
export const reportStatusEnum = pgEnum('report_status', values(REPORT_STATUSES));
export const recordSourceEnum = pgEnum('record_source', values(RECORD_SOURCES));

/* ============================================================ Пользователи */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * Telegram ID — уникальный идентификатор пользователя по ТЗ.
     * Nullable сознательно: администратор заводит карточку сотрудника заранее,
     * а ID становится известен только когда человек впервые нажмёт /start.
     * До этого момента сопоставление идёт по username или коду приглашения.
     */
    telegramId: text('telegram_id').unique(),
    telegramUsername: text('telegram_username'),

    /** Одноразовый код на случай, когда неизвестны ни ID, ни username. */
    inviteCode: text('invite_code').unique(),
    inviteExpiresAt: timestamp('invite_expires_at', { withTimezone: true }),

    firstName: text('first_name').notNull(),
    lastName: text('last_name'),
    position: text('position'),

    role: userRoleEnum('role').notNull().default('employee'),
    status: userStatusEnum('status').notNull().default('pending'),

    timezone: text('timezone').notNull().default('Europe/Moscow'),
    /** Персональные тихие часы; NULL — берём общесистемные из настроек. */
    quietHoursStart: text('quiet_hours_start'),
    quietHoursEnd: text('quiet_hours_end'),

    /** Момент, когда человек нажал «Да, это я» на экране подтверждения личности. */
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('users_status_idx').on(t.status),
    index('users_role_idx').on(t.role),
    uniqueIndex('users_username_lower_idx')
      .on(sql`lower(${t.telegramUsername})`)
      .where(sql`${t.telegramUsername} is not null`),
  ],
);

/* ================================================================= Проекты */

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Код проекта, из которого собирается номер задачи: ROM-42. */
    key: text('key').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),

    /**
     * Каждый тендер живёт в своей книге и своей папке на Drive — их создаёт
     * бот при заведении проекта, копируя шаблон. Ручное «создай таблицу,
     * скопируй шапку, раздай доступы, заведи двенадцать подпапок»
     * занимает полдня и делается по-разному каждый раз.
     */
    spreadsheetId: text('spreadsheet_id'),
    statusSheetName: text('status_sheet_name').default('Статус-таблица'),
    /**
     * Лист задач синхронизируется, только если он назван явно.
     * Обычно задачи в таблице не ведутся — умолчание здесь заставляло бы
     * бота искать несуществующий лист у каждого проекта.
     */
    tasksSheetName: text('tasks_sheet_name'),

    /** Корневая папка мероприятия на Google Drive; внутри — подпапки категорий. */
    driveFolderId: text('drive_folder_id'),
    driveFolderUrl: text('drive_folder_url'),

    /** Дата самого мероприятия. От неё считаются все сроки закупки. */
    eventDate: timestamp('event_date', { withTimezone: true }),

    /** Счётчик для номеров задач внутри проекта; инкрементируется в транзакции. */
    taskCounter: integer('task_counter').notNull().default(0),
    kpCounter: integer('kp_counter').notNull().default(0),

    /**
     * Состояние проекта целиком: в работе, ждём правки от заказчика, закрыт.
     * Видно рядом с названием — по нему понятно, куда ещё ставить задачи,
     * а куда уже нет.
     */
    status: projectStatusEnum('status').notNull().default('active'),

    isArchived: boolean('is_archived').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('projects_archived_idx').on(t.isArchived), index('projects_status_idx').on(t.status)],
);

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: projectRoleEnum('role').notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index('project_members_user_idx').on(t.userId),
  ],
);

/* ================================================================== Задачи */

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Порядковый номер внутри проекта; вместе с projects.key даёт ROM-42. */
    number: integer('number').notNull(),

    title: text('title').notNull(),
    description: text('description'),

    type: taskTypeEnum('type').notNull().default('task'),
    status: taskStatusEnum('status').notNull().default('new'),
    priority: taskPriorityEnum('priority').notNull().default('normal'),

    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),

    deadlineAt: timestamp('deadline_at', { withTimezone: true }),

    /**
     * Момент подтверждения получения задачи сотрудником.
     * Пока NULL и задача не в терминальном статусе — бот считает,
     * что реакции не было, и по правилу task_no_reaction эскалирует руководителю.
     */
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),

    blockedReason: text('blocked_reason'),

    /** Когда по задаче последний раз был содержательный ход — для правила «нет движения». */
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),

    /* --- синхронизация с Google Sheets --- */
    sheetRow: integer('sheet_row'),
    /** Хеш значений строки на момент последнего синка: отличается — значит в таблице правили. */
    sheetHash: text('sheet_hash'),
    sheetSyncedAt: timestamp('sheet_synced_at', { withTimezone: true }),
    /** Кто последним менял запись — решает исход конфликта при двустороннем синке. */
    updatedSource: recordSourceEnum('updated_source').notNull().default('system'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('tasks_project_number_idx').on(t.projectId, t.number),
    index('tasks_assignee_status_idx').on(t.assigneeId, t.status),
    index('tasks_project_status_idx').on(t.projectId, t.status),
    /**
     * Частичный индекс только по незакрытым задачам с дедлайном.
     * Планировщик и все сводки ходят именно этим путём, а закрытые задачи
     * со временем составят основную массу таблицы и только мешали бы.
     */
    index('tasks_open_deadline_idx')
      .on(t.deadlineAt)
      .where(sql`${t.status} not in ('done', 'cancelled')`),
    index('tasks_unacknowledged_idx')
      .on(t.createdAt)
      .where(sql`${t.acknowledgedAt} is null and ${t.status} = 'new'`),
    index('tasks_sheet_row_idx').on(t.projectId, t.sheetRow),
  ],
);

/** История задачи: и аудит для админа, и лента активности в карточке Mini App. */
export const taskEvents = pgTable(
  'task_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    type: taskEventTypeEnum('type').notNull(),
    /** Что именно изменилось: { from: 'new', to: 'acknowledged' } и т. п. */
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    comment: text('comment'),
    source: recordSourceEnum('source').notNull().default('bot'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('task_events_task_idx').on(t.taskId, t.createdAt)],
);

/* ============================================== Закупка: подрядчики и КП */

/**
 * Категория закупки внутри мероприятия: площадки, ведущие, кейтеринг,
 * печатная продукция и так далее.
 *
 * Не enum, а данные: у каждого тендера свой набор. В новогоднем это крио-десерты
 * и голографические билеты, в следующем будет что-то другое. Порядок хранится
 * явно, чтобы категории в приложении шли так же, как в таблице.
 */
export const procurementCategories = pgTable(
  'procurement_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),

    /** Подпапка на Google Drive, куда складываются файлы КП этой категории. */
    driveFolderId: text('drive_folder_id'),

    /** Сколько подрядчиков нужно закрыть, чтобы категория считалась проработанной. */
    targetQuotes: integer('target_quotes').default(3),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('procurement_categories_project_name_idx').on(t.projectId, t.name)],
);

/**
 * Справочник подрядчиков.
 *
 * Живёт над проектами, а не внутри них. Площадка, у которой в этом году
 * запрашивали смету, участвует и в следующем тендере — и тогда видно
 * всю историю: сколько просили, чем закончилось, кто вёл переговоры.
 * Ради этого справочник и вынесен отдельно от запросов.
 */
export const vendors = pgTable(
  'vendors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),

    /** Ссылка на сайт и контакты — в таблице они свалены в одну ячейку. */
    website: text('website'),
    contacts: text('contacts'),
    address: text('address'),

    /** Чем занимается: площадка, ведущий, кейтеринг. Для поиска по справочнику. */
    kind: text('kind'),
    notes: text('notes'),

    /** Подрядчик отказал или показал себя плохо — не предлагать в новых тендерах. */
    isBlacklisted: boolean('is_blacklisted').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('vendors_name_lower_idx').on(sql`lower(${t.name})`),
    index('vendors_kind_idx').on(t.kind),
  ],
);

/**
 * Запрос коммерческого предложения: подрядчик в рамках конкретного проекта.
 *
 * Это центральная сущность рабочего дня менеджера. В статус-таблице ей
 * соответствует одна строка, и именно здесь копится главная проблема:
 * из 195 строк 70 месяцами висят в состоянии «написали — тишина»,
 * потому что вручную помнить, кому пора напомнить, невозможно.
 */
export const quoteRequests = pgTable(
  'quote_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').references(() => procurementCategories.id, {
      onDelete: 'set null',
    }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),

    status: kpStatusEnum('status').notNull().default('new'),

    /** Кто ведёт переговоры. В таблице это колонка «Ответственный». */
    responsibleId: uuid('responsible_id').references(() => users.id, { onDelete: 'set null' }),

    /** Сумма из КП. Заполнена далеко не всегда — сравнивать предложения без неё нельзя. */
    amount: numeric('amount', { precision: 14, scale: 2 }),
    currency: text('currency').notNull().default('RUB'),
    /** Условия: налог, предоплата, что входит в цену. */
    terms: text('terms'),
    /** Колонка «ВАЖНО» из таблицы: почему не подходит, что уточнить. */
    note: text('note'),

    /* --- воронка --- */
    requestedAt: timestamp('requested_at', { withTimezone: true }),
    /** Подрядчик как-то отозвался. Разрыв с requestedAt — это и есть время тишины. */
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),

    /* --- файл КП на Google Drive --- */
    driveFileId: text('drive_file_id'),
    driveFileUrl: text('drive_file_url'),
    driveFileName: text('drive_file_name'),

    /* --- синхронизация со статус-таблицей --- */
    sheetRow: integer('sheet_row'),
    sheetHash: text('sheet_hash'),
    sheetSyncedAt: timestamp('sheet_synced_at', { withTimezone: true }),
    updatedSource: recordSourceEnum('updated_source').notNull().default('system'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** Один подрядчик — один запрос в проекте. Дубли в таблице синк схлопнет. */
    uniqueIndex('quote_requests_project_vendor_idx').on(t.projectId, t.vendorId),
    index('quote_requests_responsible_idx').on(t.responsibleId, t.status),
    index('quote_requests_category_idx').on(t.categoryId, t.status),
    /**
     * Рабочий индекс напоминаний: запросы, где ждём ответа.
     * По нему воркер каждое утро находит тех, кто молчит дольше положенного.
     */
    index('quote_requests_pending_idx')
      .on(t.requestedAt)
      .where(sql`${t.status} in ('contacted', 'awaiting_quote')`),
    index('quote_requests_sheet_row_idx').on(t.projectId, t.sheetRow),
  ],
);

/** История переговоров с подрядчиком: что менялось, кто менял, когда. */
export const quoteEvents = pgTable(
  'quote_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    quoteRequestId: uuid('quote_request_id')
      .notNull()
      .references(() => quoteRequests.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    comment: text('comment'),
    source: recordSourceEnum('source').notNull().default('bot'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('quote_events_request_idx').on(t.quoteRequestId, t.createdAt)],
);

/* ============================================================== Отчётность */

/**
 * Шаблон регулярной отчётности: «еженедельный отчёт по пятницам до 18:00»,
 * «заполнить статус-таблицу каждый день до 10:00».
 * projectId = NULL означает, что правило действует во всех проектах.
 */
export const reportTemplates = pgTable(
  'report_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    cadence: reportCadenceEnum('cadence').notNull(),
    /** Локальное время дедлайна в часовом поясе сотрудника, HH:mm. */
    dueTime: text('due_time').notNull().default('18:00'),
    /** Для weekly: 1 — понедельник … 7 — воскресенье. */
    weekdays: smallint('weekdays').array(),
    monthDay: smallint('month_day'),
    /** Какие поля просить заполнить: описание формы отчёта. */
    fields: jsonb('fields').$type<Array<{ key: string; label: string; required: boolean }>>(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('report_templates_active_idx').on(t.isActive)],
);

/** Конкретный экземпляр отчёта за период — сдан или не сдан. */
export const reportSubmissions = pgTable(
  'report_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => reportTemplates.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    status: reportStatusEnum('status').notNull().default('pending'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** Один отчёт на человека за период: защищает от дублей при перезапуске планировщика. */
    uniqueIndex('report_submission_unique_idx').on(t.templateId, t.userId, t.periodStart),
    index('report_submissions_due_idx').on(t.dueAt, t.status),
  ],
);

/* =================================================== Правила и напоминания */

/**
 * Настраиваемые администратором правила: когда, кому и по какому поводу писать.
 * projectId = NULL — правило по умолчанию для всех проектов;
 * запись с тем же kind и конкретным projectId переопределяет его точечно.
 */
export const notificationRules = pgTable(
  'notification_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    kind: notificationKindEnum('kind').notNull(),
    /** Минуты относительно опорного момента: −1440 = за сутки до, +60 = через час после. */
    offsetMinutes: integer('offset_minutes').notNull().default(0),
    repeatEveryMinutes: integer('repeat_every_minutes').notNull().default(0),
    maxRepeats: integer('max_repeats').notNull().default(0),
    target: notificationTargetEnum('target').notNull().default('assignee'),
    respectQuietHours: boolean('respect_quiet_hours').notNull().default(true),
    isEnabled: boolean('is_enabled').notNull().default(true),
    /** Переопределение текста сообщения; NULL — берём шаблон по умолчанию. */
    messageTemplate: text('message_template'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('notification_rules_scope_idx').on(t.projectId, t.kind, t.offsetMinutes)],
);

/**
 * Запланированные отправки. Каждое напоминание материализуется здесь заранее,
 * поэтому перенос дедлайна — это отмена старых строк и постановка новых,
 * а не пересчёт всего мира в момент срабатывания.
 */
export const scheduledReminders = pgTable(
  'scheduled_reminders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ruleId: uuid('rule_id').references(() => notificationRules.id, { onDelete: 'set null' }),
    kind: notificationKindEnum('kind').notNull(),

    /** На что ссылается напоминание: 'task' | 'kp' | 'report'. */
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    fireAt: timestamp('fire_at', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    attempt: integer('attempt').notNull().default(0),
    lastError: text('last_error'),
    /** ID задания в pg-boss — по нему снимаем отложенную отправку при отмене. */
    jobId: text('job_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** Рабочий индекс воркера: выбрать всё, что пора отправить. */
    index('reminders_due_idx')
      .on(t.fireAt)
      .where(sql`${t.sentAt} is null and ${t.cancelledAt} is null`),
    index('reminders_target_idx').on(t.targetType, t.targetId),
  ],
);

/**
 * Журнал фактических отправок.
 * dedupeKey не даёт отправить одно и то же дважды после рестарта воркера
 * или повторной доставки задания очередью.
 */
export const notificationLog = pgTable(
  'notification_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: notificationKindEnum('kind').notNull(),
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    dedupeKey: text('dedupe_key').notNull().unique(),
    telegramMessageId: integer('telegram_message_id'),
    /** Отложено тихими часами: отправим, когда наступит утро получателя. */
    deferredUntil: timestamp('deferred_until', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notification_log_recipient_idx').on(t.recipientId, t.createdAt)],
);

/* ============================================== Синхронизация и служебное */

/** Состояние синхронизации с конкретным листом: докуда дочитали, когда писали. */
export const syncState = pgTable(
  'sync_state',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    /** Какая сущность синхронизируется: 'tasks' | 'kp' | 'status_table'. */
    entity: text('entity').notNull(),
    lastPulledAt: timestamp('last_pulled_at', { withTimezone: true }),
    lastPushedAt: timestamp('last_pushed_at', { withTimezone: true }),
    /** Последняя строка, до которой дочитан лист — чтобы не перечитывать всё. */
    lastRow: integer('last_row'),
    lastError: text('last_error'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('sync_state_scope_idx').on(t.projectId, t.entity)],
);

/** Системный журнал для администратора: кто что сделал. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    source: recordSourceEnum('source').notNull().default('bot'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_actor_idx').on(t.actorId, t.createdAt),
    index('audit_log_entity_idx').on(t.entityType, t.entityId),
  ],
);

/** Refresh-токены сессий Mini App. Храним только хеш — сам токен живёт у клиента. */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    refreshTokenHash: text('refresh_token_hash').notNull().unique(),
    userAgent: text('user_agent'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auth_sessions_user_idx').on(t.userId)],
);

/* ================================================================== Связи */

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(projectMembers),
  assignedTasks: many(tasks),
}));

export const projectsRelations = relations(projects, ({ many }) => ({
  members: many(projectMembers),
  tasks: many(tasks),
  categories: many(procurementCategories),
  quotes: many(quoteRequests),
}));

export const projectMembersRelations = relations(projectMembers, ({ one }) => ({
  project: one(projects, { fields: [projectMembers.projectId], references: [projects.id] }),
  user: one(users, { fields: [projectMembers.userId], references: [users.id] }),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
  assignee: one(users, { fields: [tasks.assigneeId], references: [users.id] }),
  author: one(users, { fields: [tasks.authorId], references: [users.id] }),
  events: many(taskEvents),
}));

export const taskEventsRelations = relations(taskEvents, ({ one }) => ({
  task: one(tasks, { fields: [taskEvents.taskId], references: [tasks.id] }),
  actor: one(users, { fields: [taskEvents.actorId], references: [users.id] }),
}));

export const quoteRequestsRelations = relations(quoteRequests, ({ one, many }) => ({
  project: one(projects, { fields: [quoteRequests.projectId], references: [projects.id] }),
  vendor: one(vendors, { fields: [quoteRequests.vendorId], references: [vendors.id] }),
  category: one(procurementCategories, {
    fields: [quoteRequests.categoryId],
    references: [procurementCategories.id],
  }),
  responsible: one(users, { fields: [quoteRequests.responsibleId], references: [users.id] }),
  events: many(quoteEvents),
}));

export const vendorsRelations = relations(vendors, ({ many }) => ({
  quotes: many(quoteRequests),
}));

/* ================================================================== Типы */

export type UserRow = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type ProjectRow = typeof projects.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type VendorRow = typeof vendors.$inferSelect;
export type QuoteRequestRow = typeof quoteRequests.$inferSelect;
export type NewQuoteRequest = typeof quoteRequests.$inferInsert;
export type ProcurementCategoryRow = typeof procurementCategories.$inferSelect;
export type ReminderRow = typeof scheduledReminders.$inferSelect;
export type NotificationRuleRow = typeof notificationRules.$inferSelect;
