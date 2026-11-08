import type { TaskStatus, UserRole } from '@ostro/shared';
import { TASK_STATUS_LABEL } from '@ostro/shared';

/**
 * Машина состояний задачи.
 *
 * Правила переходов живут здесь, а не в обработчиках бота и не в маршрутах API,
 * потому что статус задачи меняется из четырёх мест сразу: кнопка в чате,
 * карточка в Mini App, правка строки в Google-таблице и автоматика планировщика.
 * Разъехавшиеся копии этих правил — самый дешёвый способ получить задачу,
 * которая «выполнена» в таблице и «новая» в боте.
 */

/** Куда можно перейти из каждого состояния. */
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  new: ['acknowledged', 'in_progress', 'cancelled'],
  acknowledged: ['in_progress', 'blocked', 'submitted', 'cancelled'],
  in_progress: ['blocked', 'submitted', 'cancelled'],
  blocked: ['in_progress', 'acknowledged', 'cancelled'],
  /** Сдано — дальше решает проверяющий. */
  submitted: ['reviewed', 'rework', 'awaiting_approval', 'done', 'cancelled'],
  /** Проверено — остаётся принять; принять может только согласующий. */
  reviewed: ['done', 'awaiting_approval', 'rework', 'cancelled'],
  /** Вернули с замечаниями — исполнитель доделывает. */
  rework: ['in_progress', 'submitted', 'cancelled'],
  /** Ждёт решения согласующего. */
  awaiting_approval: ['done', 'rework', 'cancelled'],
  /** Переоткрыть принятую задачу можно — это нормальная жизненная ситуация. */
  done: ['in_progress'],
  cancelled: ['new'],
};

/**
 * Кто вправе выполнить переход.
 *
 * Ключевое разделение: проверить работу может руководитель проекта,
 * а принять — только главный согласующий. Пока принимает кто угодно,
 * статус «принято» отражает не решение, а чью-то готовность нажать кнопку.
 */
const ALLOWED_ACTORS: Record<TaskStatus, readonly ('assignee' | 'manager' | 'head' | 'admin')[]> = {
  new: ['manager', 'head', 'admin'],
  acknowledged: ['assignee', 'manager', 'head', 'admin'],
  in_progress: ['assignee', 'manager', 'head', 'admin'],
  blocked: ['assignee', 'manager', 'head', 'admin'],
  submitted: ['assignee', 'manager', 'head', 'admin'],
  reviewed: ['manager', 'head', 'admin'],
  rework: ['manager', 'head', 'admin'],
  awaiting_approval: ['manager', 'head', 'admin'],
  /** Принимает работу только согласующий. */
  done: ['head', 'admin'],
  cancelled: ['manager', 'head', 'admin'],
};

export type TransitionActor = {
  role: UserRole;
  isAssignee: boolean;
  isAuthor: boolean;
};

export type TransitionResult =
  | { ok: true }
  | {
      ok: false;
      /** needs_approval — не отказ, а перенаправление к согласующему. */
      code: 'invalid_transition' | 'forbidden' | 'reason_required' | 'needs_approval';
      message: string;
    };

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function nextStatuses(from: TaskStatus): readonly TaskStatus[] {
  return TRANSITIONS[from];
}

/**
 * Полная проверка перехода: и допустимость по схеме, и права актора,
 * и обязательные поля вроде причины блокировки.
 */
export function checkTransition(
  from: TaskStatus,
  to: TaskStatus,
  actor: TransitionActor,
  opts: { comment?: string | null } = {},
): TransitionResult {
  if (from === to) {
    return { ok: false, code: 'invalid_transition', message: 'Задача уже в этом статусе' };
  }

  if (!canTransition(from, to)) {
    return {
      ok: false,
      code: 'invalid_transition',
      message: `Из статуса «${TASK_STATUS_LABEL[from]}» нельзя перейти в «${TASK_STATUS_LABEL[to]}»`,
    };
  }

  const allowed = ALLOWED_ACTORS[to];
  const actorKinds: string[] = [];
  if (actor.role === 'admin') actorKinds.push('admin', 'head', 'manager');
  if (actor.role === 'head') actorKinds.push('head', 'manager');
  if (actor.role === 'manager' || actor.isAuthor) actorKinds.push('manager');
  if (actor.isAssignee) actorKinds.push('assignee');

  if (!actorKinds.some((k) => allowed.includes(k as never))) {
    /**
     * Попытка принять задачу без права на это — не ошибка пользователя,
     * а обычная рабочая ситуация: руководитель проверил и считает, что готово.
     * Терять это движение нельзя, поэтому вызывающий код переводит задачу
     * в очередь к согласующему, а сюда возвращается объяснение почему.
     */
    if (to === 'done' && actorKinds.includes('manager')) {
      return {
        ok: false,
        code: 'needs_approval',
        message: 'Принять задачу может только главный согласующий — она уйдёт к нему на решение.',
      };
    }

    return {
      ok: false,
      code: 'forbidden',
      message:
        to === 'done'
          ? 'Принять задачу может только главный согласующий.'
          : 'Недостаточно прав для этого действия',
    };
  }

  /** Без причины «застрял» — это просто молчание, руководителю нечем помочь. */
  if (to === 'blocked' && !opts.comment?.trim()) {
    return {
      ok: false,
      code: 'reason_required',
      message: 'Опиши, что именно мешает — руководитель увидит это первым делом',
    };
  }

  return { ok: true };
}

/**
 * Поля, которые проставляются автоматически вместе со сменой статуса.
 * Возвращаем патч, а не мутируем — вызывающий код кладёт его в один UPDATE.
 */
export function statusSideEffects(to: TaskStatus, now: Date) {
  const patch: {
    acknowledgedAt?: Date;
    startedAt?: Date;
    completedAt?: Date | null;
    blockedReason?: null;
    lastActivityAt: Date;
  } = { lastActivityAt: now };

  switch (to) {
    case 'acknowledged':
      patch.acknowledgedAt = now;
      break;
    case 'in_progress':
      /** Взял в работу без явного подтверждения — считаем задачу принятой. */
      patch.acknowledgedAt = now;
      patch.startedAt = now;
      patch.completedAt = null;
      patch.blockedReason = null;
      break;
    case 'blocked':
      patch.acknowledgedAt = now;
      break;
    case 'reviewed':
    case 'awaiting_approval':
      /** Работа сделана, но не принята: срок закрывать рано. */
      patch.completedAt = null;
      break;
    case 'rework':
      patch.completedAt = null;
      break;
    case 'done':
      patch.completedAt = now;
      patch.blockedReason = null;
      break;
    case 'cancelled':
      patch.completedAt = now;
      break;
    default:
      break;
  }

  return patch;
}

/** Просрочена ли задача. Закрытые и отменённые не просрочены никогда. */
export function isOverdue(
  task: { status: TaskStatus; deadlineAt: Date | null },
  now: Date = new Date(),
): boolean {
  if (task.status === 'done' || task.status === 'cancelled') return false;
  return task.deadlineAt !== null && task.deadlineAt.getTime() < now.getTime();
}

/**
 * Задача, на которую сотрудник не отреагировал.
 * Именно это состояние руководитель видит в разделе «задачи без реакции».
 */
export function isUnacknowledged(task: {
  status: TaskStatus;
  acknowledgedAt: Date | null;
}): boolean {
  return task.status === 'new' && task.acknowledgedAt === null;
}

/**
 * Куда попадает задача, которую руководитель считает готовой.
 *
 * Не закрывается и не откатывается: встаёт в очередь к согласующему,
 * и он видит её в своём списке. Работа проверяющего при этом не пропадает.
 */
export const APPROVAL_QUEUE_STATUS: TaskStatus = 'awaiting_approval';
