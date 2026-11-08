import { and, count, desc, eq, inArray, isNull, lt, lte, sql, type Database } from '@ostro/db';
import { projectMembers, projects, quoteRequests, tasks, users } from '@ostro/db';
import { OPEN_TASK_STATUSES, TASK_STATUS_LABEL } from '@ostro/shared';

/**
 * Ответы на кнопки меню.
 *
 * Раньше каждая кнопка просто открывала мини-приложение, и все восемь вели
 * на один и тот же экран — то есть меню было бутафорией. Теперь бот отвечает
 * в чат: посмотреть свой список должно быть возможно, не выходя из переписки.
 *
 * Сообщения короткие и без разметки сверх необходимого: их читают
 * на телефоне между делом, а не изучают.
 */

const MAX_LINES = 12;

const escape = (v: string) =>
  v.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);

function when(deadline: Date | null, timezone: string): string {
  if (!deadline) return 'без срока';

  const now = new Date();
  const diffHours = (deadline.getTime() - now.getTime()) / 3_600_000;
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(deadline);

  if (diffHours < 0) {
    const days = Math.floor(-diffHours / 24);
    return days >= 1 ? `просрочено на ${days} дн.` : `просрочено · ${time}`;
  }

  const sameDay = new Date(deadline).toDateString() === now.toDateString();
  if (sameDay) return `сегодня ${time}`;
  if (diffHours < 48) return `завтра ${time}`;

  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(deadline);
}

type TaskRow = {
  ref: string;
  title: string;
  status: string;
  deadlineAt: Date | null;
  isOverdue: boolean;
};

async function fetchTasks(
  db: Database,
  userId: string,
  opts: { until?: Date; onlyOverdue?: boolean } = {},
): Promise<TaskRow[]> {
  const filters = [
    eq(tasks.assigneeId, userId),
    inArray(tasks.status, [...OPEN_TASK_STATUSES]),
  ];

  if (opts.until) filters.push(lte(tasks.deadlineAt, opts.until));
  if (opts.onlyOverdue) filters.push(lt(tasks.deadlineAt, new Date()));

  const rows = await db
    .select({
      number: tasks.number,
      title: tasks.title,
      status: tasks.status,
      deadlineAt: tasks.deadlineAt,
      key: projects.key,
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(...filters))
    .orderBy(sql`${tasks.deadlineAt} asc nulls last`)
    .limit(40);

  const now = Date.now();
  return rows.map((r) => ({
    ref: `${r.key}-${r.number}`,
    title: r.title,
    status: r.status,
    deadlineAt: r.deadlineAt,
    isOverdue: r.deadlineAt !== null && r.deadlineAt.getTime() < now,
  }));
}

function renderList(rows: TaskRow[], timezone: string): string {
  return rows
    .slice(0, MAX_LINES)
    .map((t) => {
      const mark = t.isOverdue ? '🔴' : '·';
      return (
        `${mark} <b>${escape(t.title)}</b>\n` +
        `   <code>${t.ref}</code> · ${when(t.deadlineAt, timezone)} · ${TASK_STATUS_LABEL[t.status as never]}`
      );
    })
    .join('\n\n');
}

/* ------------------------------------------------------------ Мои задачи */

export async function myTasks(db: Database, userId: string, timezone: string): Promise<string> {
  const rows = await fetchTasks(db, userId);

  if (rows.length === 0) {
    return ['📋 <b>Мои задачи</b>', '', 'Открытых задач нет.'].join('\n');
  }

  const overdue = rows.filter((t) => t.isOverdue).length;
  const head = [
    `📋 <b>Мои задачи — ${rows.length}</b>`,
    overdue > 0 ? `🔴 Просрочено: ${overdue}` : '',
    '',
  ].filter(Boolean);

  const tail = rows.length > MAX_LINES ? [`\n…и ещё ${rows.length - MAX_LINES}`] : [];

  return [...head, renderList(rows, timezone), ...tail].join('\n');
}

/* --------------------------------------------------------------- Сегодня */

export async function todayTasks(db: Database, userId: string, timezone: string): Promise<string> {
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const rows = await fetchTasks(db, userId, { until: endOfDay });

  if (rows.length === 0) {
    return ['🔥 <b>Сегодня</b>', '', 'На сегодня ничего не горит.'].join('\n');
  }

  return [`🔥 <b>Сегодня — ${rows.length}</b>`, '', renderList(rows, timezone)].join('\n');
}

/* -------------------------------------------------------------- Дедлайны */

export async function deadlines(db: Database, userId: string, timezone: string): Promise<string> {
  const weekAhead = new Date();
  weekAhead.setDate(weekAhead.getDate() + 7);

  const rows = await fetchTasks(db, userId, { until: weekAhead });

  if (rows.length === 0) {
    return ['📅 <b>Дедлайны</b>', '', 'На ближайшую неделю сроков нет.'].join('\n');
  }

  return [
    `📅 <b>Ближайшая неделя — ${rows.length}</b>`,
    '',
    renderList(rows, timezone),
  ].join('\n');
}

/* --------------------------------------------------------------- Команда */

export async function teamSummary(
  db: Database,
  userId: string,
  timezone: string,
): Promise<string> {
  const memberOf = await db
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, userId));

  const ids = memberOf.map((m) => m.projectId);
  if (ids.length === 0) {
    return ['👥 <b>Команда</b>', '', 'Пока нет проектов.'].join('\n');
  }

  const rows = await db
    .select({
      firstName: users.firstName,
      open: count(),
      overdue: sql<number>`count(*) filter (where ${tasks.deadlineAt} < now())::int`,
      waiting: sql<number>`count(*) filter (where ${tasks.status} = 'new')::int`,
    })
    .from(tasks)
    .innerJoin(users, eq(tasks.assigneeId, users.id))
    .where(and(inArray(tasks.projectId, ids), inArray(tasks.status, [...OPEN_TASK_STATUSES])))
    .groupBy(users.firstName)
    .orderBy(desc(count()));

  if (rows.length === 0) {
    return ['👥 <b>Команда</b>', '', 'Открытых задач ни у кого нет.'].join('\n');
  }

  const lines = rows.map((r) => {
    const marks = [
      `${r.open} в работе`,
      r.overdue > 0 ? `🔴 ${r.overdue} просрочено` : '',
      r.waiting > 0 ? `👀 ${r.waiting} без реакции` : '',
    ].filter(Boolean);
    return `<b>${escape(r.firstName)}</b>\n   ${marks.join(' · ')}`;
  });

  return ['👥 <b>Команда</b>', '', lines.join('\n\n')].join('\n');
}

/* ------------------------------------------------------- Статус проектов */

export async function projectsStatus(db: Database, userId: string): Promise<string> {
  const memberOf = await db
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, userId));

  const ids = memberOf.map((m) => m.projectId);
  if (ids.length === 0) {
    return ['📈 <b>Статус проектов</b>', '', 'Пока нет проектов.'].join('\n');
  }

  const rows = await db
    .select({ id: projects.id, key: projects.key, name: projects.name })
    .from(projects)
    .where(and(inArray(projects.id, ids), eq(projects.isArchived, false)));

  if (rows.length === 0) {
    return ['📈 <b>Статус проектов</b>', '', 'Активных проектов нет.'].join('\n');
  }

  const taskStats = await db
    .select({
      projectId: tasks.projectId,
      open: count(),
      overdue: sql<number>`count(*) filter (where ${tasks.deadlineAt} < now())::int`,
    })
    .from(tasks)
    .where(and(inArray(tasks.projectId, ids), inArray(tasks.status, [...OPEN_TASK_STATUSES])))
    .groupBy(tasks.projectId);

  const kpStats = await db
    .select({
      projectId: quoteRequests.projectId,
      total: count(),
      waiting: sql<number>`count(*) filter (where ${quoteRequests.status} in ('contacted','awaiting_quote'))::int`,
    })
    .from(quoteRequests)
    .where(inArray(quoteRequests.projectId, ids))
    .groupBy(quoteRequests.projectId);

  const byTasks = new Map(taskStats.map((s) => [s.projectId, s]));
  const byKp = new Map(kpStats.map((s) => [s.projectId, s]));

  const lines = rows.map((p) => {
    const t = byTasks.get(p.id);
    const k = byKp.get(p.id);
    const parts = [
      `${t?.open ?? 0} задач`,
      t?.overdue ? `🔴 ${t.overdue} просрочено` : '',
      k?.total ? `${k.waiting ?? 0} из ${k.total} подрядчиков ждут КП` : '',
    ].filter(Boolean);

    return `<b>${escape(p.name)}</b>\n   <code>${p.key}</code> · ${parts.join(' · ')}`;
  });

  return ['📈 <b>Статус проектов</b>', '', lines.join('\n\n')].join('\n');
}

/* ------------------------------------------------------------ Отчётность */

export function reports(): string {
  return [
    '📊 <b>Отчётность</b>',
    '',
    'Регулярные отчёты ещё не настроены.',
    '',
    'Когда договоримся, какие отчёты и к какому времени сдавать,',
    'бот будет напоминать заранее и отмечать сданные.',
  ].join('\n');
}

/* ---------------------------------------------------------- Уведомления */

export async function notificationSettings(db: Database, userId: string): Promise<string> {
  const [user] = await db
    .select({ quietStart: users.quietHoursStart, quietEnd: users.quietHoursEnd })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return [
    '🔔 <b>Уведомления</b>',
    '',
    'Сейчас бот пишет:',
    '· когда тебе поставили задачу — сразу',
    '· за час до срока',
    '· через 15 минут после срока и дальше, пока задача не закрыта',
    '',
    `Тихие часы: ${user?.quietStart ?? '22:00'} — ${user?.quietEnd ?? '08:00'}.`,
    'Ночью рутина копится до утра, о просрочке бот пишет сразу.',
    '',
    'Настройки частоты меняет администратор.',
  ].join('\n');
}
