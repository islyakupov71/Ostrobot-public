import { useMemo } from 'react';

/**
 * Профиль дня.
 *
 * Отвечает на вопрос, которого не видно в списке: как срок распределён
 * во времени. В списке всё выглядит одинаково срочным, а здесь сразу
 * читается, что до ближайшего дедлайна два часа, потом провал, а к вечеру
 * три штуки подряд.
 *
 * Первая версия этого не давала: окно было жёстко задано с 08:00 до 20:00,
 * и в два часа ночи метка «сейчас» прижималась к левому краю, показывая
 * восемь утра. Теперь окно считается из самих данных, у каждой отметки
 * стоит время, а нажатие ведёт к карточке — иначе непонятно, какой ромб
 * какая задача, и шкала добавляет работу вместо того, чтобы её убирать.
 */

export type ScaleTask = {
  id: string;
  title: string;
  deadlineAt: Date;
  status: 'overdue' | 'urgent' | 'normal' | 'done';
};

type Props = {
  tasks: ScaleTask[];
  now?: Date;
  /** Какая задача сейчас выделена — её отметка подсвечена. */
  selectedId?: string | null;
  onSelect?: (taskId: string) => void;
};

const STATUS_COLOR: Record<ScaleTask['status'], string> = {
  overdue: 'var(--color-overdue-500)',
  urgent: 'var(--color-signal-500)',
  normal: 'var(--color-survey-500)',
  done: 'var(--color-done-500)',
};

const HOUR = 3_600_000;

/** Минимальная ширина окна: на слишком узком шкала врёт о плотности. */
const MIN_SPAN = 4 * HOUR;

export function DayScale({ tasks, now = new Date(), selectedId, onSelect }: Props) {
  /**
   * Границы окна берутся из данных вместе с текущим моментом.
   * «Сейчас» обязано попасть внутрь — это опорная точка всего профиля.
   */
  const { start, end, ticks, step } = useMemo(() => {
    const stamps = [now.getTime(), ...tasks.map((t) => t.deadlineAt.getTime())];
    let from = Math.min(...stamps);
    let to = Math.max(...stamps);

    /** Поля по краям, чтобы крайние отметки не липли к границе. */
    const padding = Math.max(HOUR / 2, (to - from) * 0.08);
    from -= padding;
    to += padding;

    if (to - from < MIN_SPAN) {
      const center = (from + to) / 2;
      from = center - MIN_SPAN / 2;
      to = center + MIN_SPAN / 2;
    }

    /** Шаг засечек подбирается так, чтобы их было пять-восемь: больше — рябит. */
    const span = to - from;
    const candidates = [HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR];
    const chosen = candidates.find((c) => span / c <= 8) ?? 24 * HOUR;

    const marks: number[] = [];
    const first = Math.ceil(from / chosen) * chosen;
    for (let t = first; t <= to; t += chosen) marks.push(t);

    return { start: from, end: to, ticks: marks, step: chosen };
  }, [tasks, now]);

  const positionOf = (time: number) => ((time - start) / (end - start)) * 100;

  /**
   * Отметки, стоящие вплотную, разводятся по строкам — иначе три дедлайна
   * на один час сливаются в одну точку и врут о загрузке.
   */
  const laidOut = useMemo(() => {
    const sorted = [...tasks].sort((a, b) => a.deadlineAt.getTime() - b.deadlineAt.getTime());
    const occupied: number[] = [];

    return sorted.map((task) => {
      const pos = positionOf(task.deadlineAt.getTime());
      let row = 0;
      while (occupied[row] !== undefined && pos - occupied[row]! < 17) row++;
      occupied[row] = pos;
      return { task, pos, row };
    });
  }, [tasks, start, end]);

  const rows = laidOut.reduce((max, t) => Math.max(max, t.row), 0) + 1;
  const nowPos = positionOf(now.getTime());

  if (tasks.length === 0) return null;

  return (
    <section className="select-none px-4 pb-2 pt-4" aria-label="Профиль дня">
      <div className="t-eyebrow mb-3 flex items-baseline justify-between">
        <span>Профиль дня</span>
        <span className="t-mono" style={{ color: 'var(--text-muted)' }}>
          {formatTime(now)}
        </span>
      </div>

      <div className="relative" style={{ height: `${34 + rows * 40}px` }}>
        {/* Шкала времени с засечками */}
        <div className="absolute inset-x-0 top-0" style={{ height: '24px' }}>
          {ticks.map((t) => (
            <div
              key={t}
              className="absolute top-0"
              style={{ left: `${positionOf(t)}%`, transform: 'translateX(-50%)' }}
            >
              <div
                style={{
                  width: '1px',
                  height: '8px',
                  background: 'var(--line-strong)',
                  opacity: 0.55,
                  margin: '0 auto',
                }}
              />
              <div
                className="t-mono mt-1 whitespace-nowrap text-center"
                style={{ fontSize: '9px', color: 'var(--text-faint)' }}
              >
                {step >= 24 * HOUR ? formatDayShort(new Date(t)) : formatTime(new Date(t))}
              </div>
            </div>
          ))}
        </div>

        {/* Ось */}
        <div
          className="absolute inset-x-0"
          style={{ top: '8px', height: '1px', background: 'var(--line-strong)', opacity: 0.45 }}
        />

        {/* Сигнальная вертикаль «сейчас» */}
        <div
          className="absolute"
          style={{
            left: `${nowPos}%`,
            top: 0,
            bottom: 0,
            width: '2px',
            background: 'var(--color-signal-500)',
            transform: 'translateX(-1px)',
          }}
          aria-hidden
        >
          <div
            style={{
              position: 'absolute',
              top: '-4px',
              left: '-3.5px',
              width: '9px',
              height: '7px',
              background: 'var(--color-signal-500)',
              clipPath: 'polygon(50% 100%, 0 0, 100% 0)',
            }}
          />
        </div>

        {/* Отметки задач */}
        {laidOut.map(({ task, pos, row }) => {
          const active = selectedId === task.id;
          const color = STATUS_COLOR[task.status];

          return (
            <button
              key={task.id}
              type="button"
              onClick={() => onSelect?.(task.id)}
              className="absolute flex cursor-pointer flex-col items-center border-0 bg-transparent p-0"
              style={{
                left: `${pos}%`,
                top: `${28 + row * 40}px`,
                transform: 'translateX(-50%)',
                /** Область нажатия шире ромба: попасть пальцем в девять пикселей нельзя. */
                minWidth: '44px',
                paddingTop: '6px',
              }}
              aria-label={`${task.title}, срок ${formatTime(task.deadlineAt)}`}
              aria-pressed={active}
            >
              {/* Выноска от оси к отметке */}
              <div
                style={{
                  position: 'absolute',
                  left: '50%',
                  bottom: '100%',
                  width: '1px',
                  height: `${14 + row * 40}px`,
                  background: color,
                  opacity: active ? 0.7 : 0.3,
                }}
                aria-hidden
              />

              <div
                style={{
                  width: active ? '13px' : '10px',
                  height: active ? '13px' : '10px',
                  background: task.status === 'done' ? 'transparent' : color,
                  border: `1.5px solid ${color}`,
                  transform: 'rotate(45deg)',
                  transition: 'width .15s, height .15s',
                  boxShadow: active ? `0 0 0 4px color-mix(in srgb, ${color} 22%, transparent)` : 'none',
                }}
              />

              <span
                className="t-mono mt-2 whitespace-nowrap"
                style={{
                  fontSize: '10px',
                  fontWeight: active ? 700 : 500,
                  color: active ? color : 'var(--text-muted)',
                }}
              >
                {formatTime(task.deadlineAt)}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function formatTime(date: Date): string {
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(date);
}

function formatDayShort(date: Date): string {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(date);
}
