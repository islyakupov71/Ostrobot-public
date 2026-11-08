import type { TaskCardData } from '@/components/TaskCard';

/**
 * Группировка задач по срокам.
 *
 * Плоский список из двадцати задач не отвечает на вопрос «что горит»:
 * просроченное в нём соседствует с тем, что нужно к пятнице, и выглядит
 * одинаково. Группы дают этому форму, а порядок групп — приоритет.
 *
 * Задачи без срока идут последними, но не прячутся: срок могли просто
 * забыть поставить, и это само по себе стоит увидеть.
 */

export type TaskGroup = {
  key: string;
  title: string;
  /** Просроченное и сегодняшнее подсвечиваются — остальное набрано спокойно. */
  tone: 'overdue' | 'today' | 'normal';
  tasks: TaskCardData[];
};

export function groupByDeadline(tasks: TaskCardData[], now = new Date()): TaskGroup[] {
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);

  const endOfTomorrow = new Date(endOfToday);
  endOfTomorrow.setDate(endOfTomorrow.getDate() + 1);

  const endOfWeek = new Date(endOfToday);
  endOfWeek.setDate(endOfWeek.getDate() + 7);

  const overdue: TaskCardData[] = [];
  const today: TaskCardData[] = [];
  const tomorrow: TaskCardData[] = [];
  const thisWeek: TaskCardData[] = [];
  const later: TaskCardData[] = [];
  const noDeadline: TaskCardData[] = [];

  for (const task of tasks) {
    if (!task.deadlineAt) {
      noDeadline.push(task);
      continue;
    }

    const at = task.deadlineAt.getTime();
    if (task.isOverdue) overdue.push(task);
    else if (at <= endOfToday.getTime()) today.push(task);
    else if (at <= endOfTomorrow.getTime()) tomorrow.push(task);
    else if (at <= endOfWeek.getTime()) thisWeek.push(task);
    else later.push(task);
  }

  const groups: TaskGroup[] = [
    { key: 'overdue', title: 'Просрочено', tone: 'overdue', tasks: overdue },
    { key: 'today', title: 'Сегодня', tone: 'today', tasks: today },
    { key: 'tomorrow', title: 'Завтра', tone: 'normal', tasks: tomorrow },
    { key: 'week', title: 'На этой неделе', tone: 'normal', tasks: thisWeek },
    { key: 'later', title: 'Позже', tone: 'normal', tasks: later },
    { key: 'none', title: 'Без срока', tone: 'normal', tasks: noDeadline },
  ];

  return groups.filter((g) => g.tasks.length > 0);
}

/** Задачи на сегодня — только они имеют смысл на шкале дня. */
export function todayOnly(tasks: TaskCardData[], now = new Date()): TaskCardData[] {
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);

  return tasks.filter(
    (t) => t.deadlineAt !== null && t.deadlineAt.getTime() <= endOfToday.getTime(),
  );
}
