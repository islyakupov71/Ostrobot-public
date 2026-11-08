import { useEffect, useRef, useState } from 'react';
import { haptic } from '@/lib/telegram';
import type { ProjectSummary } from '@/lib/api';

/**
 * Переключатель проектов.
 *
 * У агентства несколько тендеров одновременно, и почти всё в приложении —
 * задачи, подрядчики, сроки — показывается в разрезе одного из них.
 * Поэтому выбор проекта стоит в шапке, а не спрятан в настройках:
 * это не настройка, а контекст, в котором человек находится.
 *
 * Рядом с каждым проектом видно число просрочек и молчащих подрядчиков —
 * по ним и выбирают, куда идти разбираться.
 */

type Props = {
  projects: ProjectSummary[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onCreate?: () => void;
};

export function ProjectSwitcher({ projects, currentId, onSelect, onCreate }: Props) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  /** Список закрывается по нажатию вне его — иначе он перекрывает контент. */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const current = projects.find((p) => p.id === currentId) ?? projects[0] ?? null;
  if (!current) return null;

  const single = projects.length <= 1 && !onCreate;

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        disabled={single}
        onClick={() => {
          haptic('tap');
          setOpen((v) => !v);
        }}
        className="flex max-w-full items-center gap-1.5 border-0 bg-transparent p-0"
        style={{ cursor: single ? 'default' : 'pointer' }}
        aria-expanded={open}
      >
        <span
          className="t-mono truncate"
          style={{ fontSize: '11px', letterSpacing: '0.08em', color: 'var(--text-muted)' }}
        >
          {current.key}
        </span>
        <span className="truncate" style={{ fontSize: '12px', color: 'var(--text-faint)' }}>
          {current.name}
        </span>
        {!single && (
          <span style={{ fontSize: '9px', color: 'var(--text-faint)' }}>{open ? '▲' : '▼'}</span>
        )}
      </button>

      {open && (
        <div
          className="absolute left-0 z-20 mt-2 overflow-hidden"
          style={{
            minWidth: '260px',
            maxWidth: 'calc(100vw - 32px)',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--line-strong)',
            boxShadow: 'var(--shadow-lift)',
          }}
        >
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                haptic('tap');
                onSelect(p.id);
                setOpen(false);
              }}
              className="block w-full cursor-pointer border-0 px-3 py-2.5 text-left"
              style={{
                background: p.id === current.id ? 'var(--bg-sunken)' : 'transparent',
                borderBottom: '1px solid var(--line)',
              }}
            >
              <div className="flex items-baseline gap-2">
                <span
                  className="t-mono shrink-0"
                  style={{
                    fontSize: '10px',
                    color: p.id === current.id ? 'var(--accent)' : 'var(--text-faint)',
                  }}
                >
                  {p.key}
                </span>
                <span
                  className="truncate"
                  style={{
                    fontSize: '13px',
                    fontWeight: p.id === current.id ? 700 : 500,
                    color: 'var(--text)',
                  }}
                >
                  {p.name}
                </span>
              </div>

              <div className="mt-0.5 flex gap-3" style={{ fontSize: '10px' }}>
                {p.overdueTasks > 0 && (
                  <span style={{ color: 'var(--color-overdue-500)', fontWeight: 600 }}>
                    {p.overdueTasks} просрочено
                  </span>
                )}
                {p.vendorsWaiting > 0 && (
                  <span style={{ color: 'var(--accent)' }}>{p.vendorsWaiting} ждут КП</span>
                )}
                {p.overdueTasks === 0 && p.vendorsWaiting === 0 && (
                  <span style={{ color: 'var(--text-faint)' }}>
                    {p.openTasks} задач · {p.vendorsTotal} подрядчиков
                  </span>
                )}
              </div>
            </button>
          ))}

          {onCreate && (
            <button
              type="button"
              onClick={() => {
                haptic('tap');
                setOpen(false);
                onCreate();
              }}
              className="t-mono block w-full cursor-pointer border-0 px-3 py-3 text-left"
              style={{
                background: 'transparent',
                color: 'var(--accent)',
                fontSize: '11px',
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
              }}
            >
              + Новый проект
            </button>
          )}
        </div>
      )}
    </div>
  );
}
