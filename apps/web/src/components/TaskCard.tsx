import type { TaskPriority, TaskStatus, UserRole } from '@ostro/shared';
import { TASK_STATUS_LABEL } from '@ostro/shared';

/**
 * Карточка задачи.
 *
 * Устроена как строка в журнале работ: слева корешок цвета состояния,
 * сверху моноширинные метки времени и кода, ниже — название набором для чтения.
 *
 * Набор кнопок зависит от того, кто смотрит. Исполнитель ведёт свою задачу,
 * руководитель проверяет чужую, согласующий принимает проверенную —
 * и каждому видны только его действия. Кнопка, отвечающая «нельзя»,
 * хуже отсутствующей.
 */

export type TaskCardData = {
  id: string;
  ref: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  deadlineAt: Date | null;
  projectName: string;
  assigneeName?: string | null;
  assigneeId?: string | null;
  isOverdue: boolean;
};

export type Viewer = {
  id: string;
  role: UserRole;
  /** Может окончательно принять работу. */
  canApprove: boolean;
};

type Props = {
  task: TaskCardData;
  viewer?: Viewer;
  highlighted?: boolean;
  innerRef?: (el: HTMLDivElement | null) => void;
  onOpen?: (id: string) => void;
  onStatus?: (id: string, status: TaskStatus) => void;
};

/** Цвет корешка. Просрочка перебивает любой статус — это главное, что нужно увидеть. */
function edgeColor(task: TaskCardData): string {
  if (task.isOverdue) return 'var(--color-overdue-500)';
  switch (task.status) {
    case 'new':
      return 'var(--color-signal-500)';
    case 'in_progress':
    case 'acknowledged':
      return 'var(--color-survey-500)';
    case 'blocked':
    case 'rework':
      return 'var(--color-signal-600)';
    case 'submitted':
    case 'reviewed':
    case 'awaiting_approval':
      return 'var(--color-survey-400)';
    case 'done':
      return 'var(--color-done-500)';
    default:
      return 'var(--line-strong)';
  }
}

type Action = { label: string; to: TaskStatus; primary?: boolean };

/**
 * Что можно сделать с задачей прямо сейчас.
 *
 * Порядок ролей важен: сначала действия исполнителя, потом проверяющего.
 * Один человек может быть и тем и другим — например, руководитель,
 * поставивший задачу себе.
 */
function actionsFor(task: TaskCardData, viewer?: Viewer): Action[] {
  if (!viewer) return [];

  const isAssignee = task.assigneeId === viewer.id;
  const isManager = viewer.role !== 'employee';
  const actions: Action[] = [];

  if (isAssignee) {
    switch (task.status) {
      case 'new':
        actions.push({ label: 'Взял', to: 'acknowledged', primary: true });
        break;
      case 'acknowledged':
      case 'in_progress':
        actions.push({ label: 'Сдал', to: 'submitted', primary: true });
        actions.push({ label: 'Застрял', to: 'blocked' });
        break;
      case 'rework':
        actions.push({ label: 'Взял в работу', to: 'in_progress', primary: true });
        break;
      case 'blocked':
        actions.push({ label: 'Разблокировался', to: 'in_progress', primary: true });
        break;
      default:
        break;
    }
  }

  if (isManager && !isAssignee) {
    if (task.status === 'submitted') {
      actions.push({ label: 'Проверено', to: 'reviewed', primary: true });
      actions.push({ label: 'На доработку', to: 'rework' });
    }
    /**
     * «Принять» показывается и тем, кто не вправе закрыть: сервер переведёт
     * задачу в очередь к согласующему и объяснит это. Прятать кнопку значило бы
     * лишить руководителя способа сказать «с моей стороны готово».
     */
    if (task.status === 'reviewed' || task.status === 'awaiting_approval') {
      actions.push({
        label: viewer.canApprove ? 'Принять' : 'Готово, к принятию',
        to: 'done',
        primary: true,
      });
      actions.push({ label: 'На доработку', to: 'rework' });
    }
  }

  return actions;
}

export function TaskCard({ task, viewer, highlighted, innerRef, onOpen, onStatus }: Props) {
  const edge = edgeColor(task);
  const actions = actionsFor(task, viewer);

  return (
    <article
      ref={innerRef}
      className="relative overflow-hidden"
      style={{
        background: 'var(--bg-elevated)',
        border: `1px solid ${highlighted ? edge : 'var(--line)'}`,
        borderRadius: 'var(--radius-card)',
        boxShadow: highlighted
          ? `0 0 0 3px color-mix(in srgb, ${edge} 16%, transparent)`
          : 'var(--shadow-card)',
        transition: 'border-color .2s, box-shadow .2s',
        scrollMarginTop: '96px',
      }}
    >
      <div
        aria-hidden
        style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '3px', background: edge }}
      />

      <button
        type="button"
        onClick={() => onOpen?.(task.id)}
        className="block w-full cursor-pointer border-0 bg-transparent px-4 py-3 text-left"
      >
        <header className="mb-2 flex items-center gap-2">
          <span className="t-mono" style={{ fontSize: '11px', color: 'var(--text-faint)' }}>
            {task.ref}
          </span>

          {task.assigneeName && (
            <>
              <span style={{ fontSize: '11px', color: 'var(--text-faint)' }}>·</span>
              <span className="truncate" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                {task.assigneeName}
              </span>
            </>
          )}

          {task.priority === 'critical' && (
            <span
              className="t-mono ml-auto shrink-0"
              style={{
                fontSize: '9px',
                letterSpacing: '0.1em',
                padding: '2px 6px',
                color: 'var(--color-signal-500)',
                border: '1px solid var(--color-signal-500)',
              }}
            >
              ГОРИТ
            </span>
          )}
        </header>

        <h3
          className="mb-2"
          style={{ fontSize: '15px', fontWeight: 600, lineHeight: 1.35, color: 'var(--text)' }}
        >
          {task.title}
        </h3>

        <footer className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {task.deadlineAt && (
            <time
              className="t-mono"
              dateTime={task.deadlineAt.toISOString()}
              style={{
                fontSize: '12px',
                fontWeight: 500,
                color: task.isOverdue ? 'var(--color-overdue-500)' : 'var(--text-muted)',
              }}
            >
              {formatDeadline(task.deadlineAt, task.isOverdue)}
            </time>
          )}

          {/* Статус — метка, а не строка текста: его читают взглядом, не глазами по слогам */}
          <span
            className="t-mono"
            style={{
              fontSize: '9.5px',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              padding: '2px 6px',
              color: statusColor(task.status),
              border: `1px solid ${statusColor(task.status)}`,
              opacity: 0.9,
            }}
          >
            {TASK_STATUS_LABEL[task.status]}
          </span>
        </footer>
      </button>

      {actions.length > 0 && (
        <div
          className="flex gap-px"
          style={{ borderTop: '1px solid var(--line)', background: 'var(--line)' }}
        >
          {actions.map((a) => (
            <button
              key={a.to + a.label}
              type="button"
              onClick={() => onStatus?.(task.id, a.to)}
              className="flex-1 cursor-pointer border-0 py-2.5"
              style={{
                background: 'var(--bg-elevated)',
                color: a.primary ? 'var(--accent)' : 'var(--text-muted)',
                fontFamily: 'var(--font-mono)',
                fontSize: '11px',
                fontWeight: 500,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}

function statusColor(status: TaskStatus): string {
  switch (status) {
    case 'new':
      return 'var(--color-signal-500)';
    case 'blocked':
    case 'rework':
      return 'var(--color-signal-600)';
    case 'submitted':
    case 'reviewed':
    case 'awaiting_approval':
      return 'var(--color-survey-500)';
    case 'done':
      return 'var(--color-done-500)';
    default:
      return 'var(--text-faint)';
  }
}

function formatDeadline(date: Date, isOverdue: boolean): string {
  const now = new Date();
  const diffHours = (date.getTime() - now.getTime()) / 3_600_000;
  const time = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(date);

  if (isOverdue) {
    const overdueDays = Math.floor(-diffHours / 24);
    return overdueDays >= 1 ? `просрочено на ${overdueDays} дн.` : `просрочено · ${time}`;
  }

  if (diffHours < 24 && date.getDate() === now.getDate()) return `сегодня ${time}`;
  if (diffHours < 48) return `завтра ${time}`;

  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
