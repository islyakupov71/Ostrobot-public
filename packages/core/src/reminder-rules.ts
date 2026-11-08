import type { NotificationKind, NotificationTarget, TaskStatus } from '@ostro/shared';

/**
 * Правила напоминаний — сердце бота.
 *
 * ТЗ требует следить за шестью вещами: приближением дедлайна, просрочкой,
 * отсутствием статуса, незаполненной статус-таблицей, регулярной отчётностью
 * и отсутствием реакции на новую задачу. Все шесть описаны здесь данными,
 * а не кодом: администратор меняет их через интерфейс, и планировщик
 * начинает работать иначе без единой правки в исходниках.
 */

/** К чему применимо правило: у задач, КП и отчётов свои наборы. */
export type ReminderScope = 'task' | 'kp' | 'report';

export type ReminderRule = {
  kind: NotificationKind;
  /**
   * Без этого поля правила смешиваются: опорным моментом и у задачи,
   * и у КП служит дедлайн, поэтому по задаче планировалось напоминание
   * о просроченном КП.
   */
  appliesTo: ReminderScope;
  /**
   * Сдвиг в минутах от опорного момента.
   * Опорный момент зависит от вида: для дедлайновых правил это дедлайн,
   * для task_no_reaction — момент назначения, для kp_awaiting_receipt — отправка КП.
   */
  offsetMinutes: number;
  /** 0 — напомнить один раз и замолчать. */
  repeatEveryMinutes: number;
  maxRepeats: number;
  target: NotificationTarget;
  respectQuietHours: boolean;
  isEnabled: boolean;
};

/**
 * Набор по умолчанию.
 *
 * Подобран так, чтобы бот был полезным, а не назойливым: до дедлайна человек
 * слышит бота трижды, после просрочки — с нарастающей частотой и уже вместе
 * с руководителем. Молчащий бот бесполезен, но бот, которого замьютили, — вреден.
 */
export const DEFAULT_NOTIFICATION_RULES: readonly ReminderRule[] = [
  /* --- Задача назначена: сотрудник должен подтвердить получение --- */
  {
    kind: 'task_assigned',
    appliesTo: 'task',
    offsetMinutes: 0,
    repeatEveryMinutes: 0,
    maxRepeats: 0,
    target: 'assignee',
    /** Новую задачу показываем сразу: человек должен знать о ней, а не узнать утром. */
    respectQuietHours: false,
    isEnabled: true,
  },
  {
    kind: 'task_no_reaction',
    appliesTo: 'task',
    /** Два часа тишины после назначения — напоминаем самому сотруднику. */
    offsetMinutes: 120,
    repeatEveryMinutes: 0,
    maxRepeats: 0,
    target: 'assignee',
    respectQuietHours: true,
    isEnabled: true,
  },
  {
    kind: 'task_no_reaction',
    appliesTo: 'task',
    /** Восемь часов тишины — это уже сигнал руководителю, а не сотруднику. */
    offsetMinutes: 480,
    repeatEveryMinutes: 0,
    maxRepeats: 0,
    target: 'both',
    respectQuietHours: true,
    isEnabled: true,
  },

  /* --- Приближение дедлайна --- */
  {
    kind: 'deadline_approaching',
    appliesTo: 'task',
    /**
     * За час до срока.
     *
     * Сутки, стоявшие здесь раньше, для этой команды бессмысленны: задачи
     * ставятся утром на вечер того же дня, и напоминание «за сутки» либо
     * не наступает вовсе, либо приходит раньше самой задачи.
     */
    offsetMinutes: -60,
    repeatEveryMinutes: 0,
    maxRepeats: 0,
    target: 'assignee',
    respectQuietHours: true,
    isEnabled: true,
  },
  {
    kind: 'deadline_today',
    /** За полчаса. Выключено по умолчанию — включается в настройках проекта. */
    appliesTo: 'task',
    offsetMinutes: -30,
    repeatEveryMinutes: 0,
    maxRepeats: 0,
    target: 'assignee',
    respectQuietHours: true,
    isEnabled: false,
  },

  /* --- Просрочка --- */
  {
    kind: 'task_overdue',
    /**
     * Через пятнадцать минут после срока и дальше с тем же шагом, пока
     * задача не закрыта. Молчать здесь нельзя: именно в эти минуты
     * решается, вспомнят о задаче сегодня или она уедет на завтра.
     */
    appliesTo: 'task',
    offsetMinutes: 15,
    repeatEveryMinutes: 15,
    maxRepeats: 3,
    target: 'assignee',
    respectQuietHours: false,
    isEnabled: true,
  },
  {
    kind: 'task_overdue',
    /** Через час просрочки подключается руководитель. */
    appliesTo: 'task',
    offsetMinutes: 60,
    repeatEveryMinutes: 1440,
    maxRepeats: 3,
    target: 'both',
    respectQuietHours: true,
    isEnabled: true,
  },

  /* --- Задача принята, но по ней ничего не происходит --- */
  {
    kind: 'task_status_stale',
    appliesTo: 'task',
    /** Трое суток без единого события в задаче. */
    offsetMinutes: 4320,
    repeatEveryMinutes: 4320,
    maxRepeats: 3,
    target: 'assignee',
    respectQuietHours: true,
    isEnabled: true,
  },

  /* --- Коммерческие предложения --- */
  {
    kind: 'kp_awaiting_receipt',
    appliesTo: 'kp',
    /** Сутки после отправки клиенту, а получение так и не подтверждено. */
    offsetMinutes: 1440,
    repeatEveryMinutes: 1440,
    maxRepeats: 3,
    target: 'assignee',
    respectQuietHours: true,
    isEnabled: true,
  },
  {
    kind: 'kp_overdue',
    appliesTo: 'kp',
    offsetMinutes: 0,
    repeatEveryMinutes: 1440,
    maxRepeats: 3,
    target: 'both',
    respectQuietHours: true,
    isEnabled: true,
  },

  /* --- Отчётность --- */
  {
    kind: 'report_due',
    appliesTo: 'report',
    offsetMinutes: -120,
    repeatEveryMinutes: 0,
    maxRepeats: 0,
    target: 'assignee',
    respectQuietHours: true,
    isEnabled: true,
  },
  {
    kind: 'report_missing',
    appliesTo: 'report',
    offsetMinutes: 60,
    repeatEveryMinutes: 240,
    maxRepeats: 2,
    target: 'both',
    respectQuietHours: true,
    isEnabled: true,
  },
  {
    kind: 'status_table_unfilled',
    appliesTo: 'report',
    offsetMinutes: 30,
    repeatEveryMinutes: 120,
    maxRepeats: 2,
    target: 'assignee',
    respectQuietHours: true,
    isEnabled: true,
  },

  /* --- Сводка руководителю --- */
  {
    kind: 'manager_digest',
    appliesTo: 'report',
    offsetMinutes: 0,
    repeatEveryMinutes: 0,
    maxRepeats: 0,
    target: 'manager',
    respectQuietHours: true,
    isEnabled: true,
  },
];

export type PlannedReminder = {
  kind: NotificationKind;
  fireAt: Date;
  target: NotificationTarget;
  respectQuietHours: boolean;
  /** Номер повтора: 0 — первое срабатывание. Входит в ключ дедупликации. */
  repeatIndex: number;
};

/** К какому моменту привязано правило. */
type Anchors = {
  deadlineAt?: Date | null;
  assignedAt?: Date | null;
  lastActivityAt?: Date | null;
  sentAt?: Date | null;
  dueAt?: Date | null;
};

const ANCHOR_BY_KIND: Record<NotificationKind, keyof Anchors> = {
  task_assigned: 'assignedAt',
  task_no_reaction: 'assignedAt',
  deadline_approaching: 'deadlineAt',
  deadline_today: 'deadlineAt',
  task_overdue: 'deadlineAt',
  task_status_stale: 'lastActivityAt',
  kp_awaiting_receipt: 'sentAt',
  kp_overdue: 'deadlineAt',
  report_due: 'dueAt',
  report_missing: 'dueAt',
  status_table_unfilled: 'dueAt',
  manager_digest: 'dueAt',
  escalation: 'deadlineAt',
};

/**
 * Допуск на опоздание.
 *
 * Правила с нулевым сдвигом (например, «задача назначена») привязаны
 * к моменту, который на долю секунды в прошлом уже в момент планирования.
 * Без допуска они отсеивались бы все до единого.
 */
const LATE_TOLERANCE_MS = 5 * 60_000;

/**
 * Разворачивает правила в конкретные моменты отправки.
 *
 * Давно прошедшие срабатывания не материализуются: если задачу завели
 * с дедлайном «через час», напоминание «за сутки» уже бессмысленно,
 * и бот не станет писать о том, что прошло. А вот только что наступившие
 * попадают в план и уходят на ближайшем тике диспетчера.
 */
export function planReminders(
  rules: readonly ReminderRule[],
  scope: ReminderScope,
  anchors: Anchors,
  now: Date = new Date(),
): PlannedReminder[] {
  const planned: PlannedReminder[] = [];

  for (const rule of rules) {
    if (!rule.isEnabled) continue;
    if (rule.appliesTo !== scope) continue;

    const anchorValue = anchors[ANCHOR_BY_KIND[rule.kind]];
    if (!anchorValue) continue;

    const base = anchorValue.getTime() + rule.offsetMinutes * 60_000;
    const repeats = rule.repeatEveryMinutes > 0 ? rule.maxRepeats : 0;

    for (let i = 0; i <= repeats; i++) {
      const fireAt = new Date(base + i * rule.repeatEveryMinutes * 60_000);
      if (fireAt.getTime() < now.getTime() - LATE_TOLERANCE_MS) continue;

      planned.push({
        kind: rule.kind,
        fireAt,
        target: rule.target,
        respectQuietHours: rule.respectQuietHours,
        repeatIndex: i,
      });
    }
  }

  return planned.sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());
}

/**
 * Нужно ли вообще что-то планировать по задаче в этом статусе.
 * Закрытые и отменённые задачи молчат.
 */
export function shouldTrack(status: TaskStatus): boolean {
  return status !== 'done' && status !== 'cancelled';
}

/**
 * Ключ дедупликации отправки.
 *
 * Складывается из получателя, повода, объекта и номера повтора, поэтому
 * повторная доставка задания очередью или перезапуск воркера посреди рассылки
 * не приводят ко второму одинаковому сообщению.
 */
export function dedupeKey(parts: {
  recipientId: string;
  kind: NotificationKind;
  targetType: string;
  targetId: string;
  repeatIndex: number;
}): string {
  return [parts.recipientId, parts.kind, parts.targetType, parts.targetId, parts.repeatIndex].join(
    ':',
  );
}
