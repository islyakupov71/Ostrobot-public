import { useMemo, useState } from 'react';
import { haptic } from '@/lib/telegram';

/**
 * Выбор срока.
 *
 * Сначала четыре готовых варианта, календарь — вторым слоем. Задачи ставятся
 * каждый день, и почти все попадают в «сегодня к вечеру», «завтра» или
 * «к концу недели». Заставлять ради этого каждый раз листать календарь —
 * значит превратить минутное дело в утомительное, а утомительное перестают
 * делать вовсе.
 *
 * Точная дата открывается системным выбором даты и времени: он привычен
 * человеку и работает на любом телефоне лучше самописного календаря.
 */

type Props = {
  value: Date | null;
  onChange: (value: Date | null) => void;
};

/** Конец рабочего дня — умолчание для всех быстрых вариантов. */
const WORK_DAY_END = 18;

function atHour(daysAhead: number, hour: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/** Ближайшая пятница; если сегодня уже пятница — следующая. */
function endOfWeek(): Date {
  const d = new Date();
  const daysToFriday = (5 - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + daysToFriday);
  d.setHours(WORK_DAY_END, 0, 0, 0);
  return d;
}

export function DeadlinePicker({ value, onChange }: Props) {
  const [calendarOpen, setCalendarOpen] = useState(false);

  const presets = useMemo(() => {
    const now = new Date();
    const items: { label: string; hint: string; at: Date }[] = [];

    /** «Сегодня» показываем, только если до конца дня ещё есть время. */
    const todayEvening = atHour(0, WORK_DAY_END);
    if (todayEvening.getTime() - now.getTime() > 30 * 60_000) {
      items.push({ label: 'Сегодня', hint: '18:00', at: todayEvening });
    }

    items.push({ label: 'Завтра', hint: '18:00', at: atHour(1, WORK_DAY_END) });
    items.push({ label: 'До пятницы', hint: fmtDay(endOfWeek()), at: endOfWeek() });
    items.push({ label: 'Через неделю', hint: fmtDay(atHour(7, WORK_DAY_END)), at: atHour(7, WORK_DAY_END) });

    return items;
  }, []);

  const matchedPreset = presets.find((p) => value && sameMinute(p.at, value));

  return (
    <div>
      <div className="t-eyebrow mb-3">Срок</div>

      <div className="grid grid-cols-2 gap-2">
        {presets.map((preset) => {
          const active = matchedPreset === preset;
          return (
            <button
              key={preset.label}
              type="button"
              onClick={() => {
                haptic('tap');
                setCalendarOpen(false);
                onChange(preset.at);
              }}
              aria-pressed={active}
              className="cursor-pointer px-3 py-2.5 text-left"
              style={{
                background: active ? 'var(--accent-soft)' : 'var(--bg-elevated)',
                border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
                borderRadius: 'var(--radius-card)',
                transition: 'border-color .15s, background .15s',
              }}
            >
              <div
                style={{
                  fontSize: '13px',
                  fontWeight: 600,
                  color: active ? 'var(--accent)' : 'var(--text)',
                }}
              >
                {preset.label}
              </div>
              <div className="t-mono" style={{ fontSize: '10px', color: 'var(--text-faint)' }}>
                {preset.hint}
              </div>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => {
          haptic('tap');
          setCalendarOpen((open) => !open);
        }}
        className="mt-2 w-full cursor-pointer px-3 py-2.5 text-left"
        style={{
          background: 'var(--bg-elevated)',
          border: `1px solid ${!matchedPreset && value ? 'var(--accent)' : 'var(--line)'}`,
          borderRadius: 'var(--radius-card)',
        }}
      >
        <div className="flex items-center justify-between">
          <span
            style={{
              fontSize: '13px',
              fontWeight: 600,
              color: !matchedPreset && value ? 'var(--accent)' : 'var(--text)',
            }}
          >
            {!matchedPreset && value ? fmtFull(value) : 'Другая дата и время'}
          </span>
          <span className="t-mono" style={{ fontSize: '11px', color: 'var(--text-faint)' }}>
            {calendarOpen ? '−' : '+'}
          </span>
        </div>
      </button>

      {calendarOpen && (
        <input
          type="datetime-local"
          className="t-mono mt-2 w-full px-3 py-3"
          value={value ? toLocalInput(value) : ''}
          min={toLocalInput(new Date())}
          onChange={(e) => {
            const next = e.target.value ? new Date(e.target.value) : null;
            onChange(next && !Number.isNaN(next.getTime()) ? next : null);
          }}
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--accent)',
            borderRadius: 'var(--radius-card)',
            color: 'var(--text)',
            fontSize: '15px',
            colorScheme: 'inherit',
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------ Форматы */

function sameMinute(a: Date, b: Date): boolean {
  return Math.abs(a.getTime() - b.getTime()) < 60_000;
}

function fmtDay(d: Date): string {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(d);
}

function fmtFull(d: Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

/**
 * Значение для datetime-local должно быть в местном времени без смещения.
 * toISOString даёт UTC и сдвинул бы выбранное время на часовой пояс.
 */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
