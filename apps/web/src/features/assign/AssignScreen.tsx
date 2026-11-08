import { useEffect, useRef, useState } from 'react';
import { PersonPicker, type Person } from './PersonPicker';
import { DeadlinePicker } from './DeadlinePicker';
import { api, ApiError, type Assignee } from '@/lib/api';
import { haptic } from '@/lib/telegram';

/**
 * Постановка задачи.
 *
 * Всё на одном экране, без шагов и кнопок «Далее»: руководитель заводит
 * задачи каждый день по несколько штук, и мастер из трёх экранов на таком
 * потоке превращается в мучение. Здесь видно сразу, что уже выбрано,
 * а что осталось.
 *
 * Порядок полей повторяет порядок мысли: кому — что — к какому сроку.
 */

type Props = {
  projectId: string;
  projectName: string;
  onDone: () => void;
};

type Stage = 'idle' | 'sending' | 'sent';

export function AssignScreen({ projectId, projectName, onDone }: Props) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [deadline, setDeadline] = useState<Date | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState<string | null>(null);

  const titleRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api
      .assignees(projectId)
      .then((items: Assignee[]) => setPeople(items))
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Не удалось загрузить команду'),
      );
  }, [projectId]);

  /** После выбора человека сразу ставим курсор в текст — на один тап меньше. */
  useEffect(() => {
    if (assigneeId && !title) titleRef.current?.focus();
  }, [assigneeId, title]);

  const ready = Boolean(assigneeId) && title.trim().length > 2 && deadline !== null;
  const chosen = people?.find((p) => p.id === assigneeId) ?? null;

  async function send() {
    if (!ready || !assigneeId || !deadline) return;

    setStage('sending');
    setError(null);

    try {
      const task = await api.tasks.create({
        projectId,
        assigneeId,
        title: title.trim(),
        deadlineAt: deadline.toISOString(),
        priority: urgent ? 'critical' : 'normal',
      });

      haptic('success');
      setStage('sent');

      /**
       * Задача создана, но уведомление могло не дойти — например, человек
       * ещё ни разу не открывал бота. Про это нужно сказать прямо, иначе
       * руководитель будет ждать реакции, которой не будет.
       */
      if (!task.notified) {
        setError(`${chosen?.firstName ?? 'Исполнитель'} ещё не открывал бота — сообщение придёт после первого входа`);
      }

      setTimeout(() => {
        setTitle('');
        setDeadline(null);
        setUrgent(false);
        setStage('idle');
      }, 1600);
    } catch (e) {
      haptic('error');
      setStage('idle');
      setError(e instanceof ApiError ? e.message : 'Не удалось отправить задачу');
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col">
      <header className="safe-top flex items-baseline justify-between px-4 pb-4 pt-4">
        <h1
          className="t-display"
          style={{ fontSize: '24px', letterSpacing: '0.06em', color: 'var(--text)' }}
        >
          Новая задача
        </h1>
        <button
          type="button"
          onClick={onDone}
          className="t-mono cursor-pointer border-0 bg-transparent p-0"
          style={{ fontSize: '11px', color: 'var(--text-faint)', letterSpacing: '0.1em' }}
        >
          ЗАКРЫТЬ
        </button>
      </header>

      <main className="flex flex-col gap-6 px-4 pb-6">
        {people === null ? (
          <p style={{ fontSize: '14px', color: 'var(--text-faint)' }}>Загружаю команду…</p>
        ) : people.length === 0 ? (
          <p style={{ fontSize: '14px', color: 'var(--text-faint)' }}>
            В проекте пока нет исполнителей.
          </p>
        ) : (
          <PersonPicker people={people} selectedId={assigneeId} onSelect={setAssigneeId} />
        )}

        <div>
          <div className="t-eyebrow mb-3">Что сделать</div>
          <textarea
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            rows={3}
            maxLength={200}
            placeholder="Например: дожать Crystal Ballroom, КП обещали вчера"
            className="w-full resize-none px-3 py-3"
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-card)',
              color: 'var(--text)',
              fontSize: '15px',
              lineHeight: 1.45,
              fontFamily: 'inherit',
            }}
          />
          <div className="mt-1.5 flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                haptic('tap');
                setUrgent((v) => !v);
              }}
              aria-pressed={urgent}
              className="t-mono cursor-pointer px-2 py-1"
              style={{
                fontSize: '10px',
                letterSpacing: '0.1em',
                color: urgent ? 'var(--accent)' : 'var(--text-faint)',
                border: `1px solid ${urgent ? 'var(--accent)' : 'var(--line)'}`,
                background: urgent ? 'var(--accent-soft)' : 'transparent',
              }}
            >
              ГОРИТ
            </button>
            <span className="t-mono" style={{ fontSize: '10px', color: 'var(--text-faint)' }}>
              {title.length}/200
            </span>
          </div>
        </div>

        <DeadlinePicker value={deadline} onChange={setDeadline} />

        {error && (
          <p
            style={{
              fontSize: '13px',
              color: stage === 'sent' ? 'var(--text-muted)' : 'var(--color-overdue-500)',
              lineHeight: 1.45,
            }}
          >
            {error}
          </p>
        )}
      </main>

      {/*
        Кнопка отправки прижата к низу и всегда на виду: это единственное
        завершающее действие экрана, и искать его не должно приходиться.
      */}
      <footer
        className="safe-bottom sticky bottom-0 mt-auto px-4 pt-3"
        style={{ background: 'var(--bg)', borderTop: '1px solid var(--line)' }}
      >
        {chosen && deadline && (
          <p className="mb-2" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {chosen.firstName} · {projectName} · до{' '}
            {new Intl.DateTimeFormat('ru-RU', {
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            }).format(deadline)}
          </p>
        )}

        <button
          type="button"
          disabled={!ready || stage !== 'idle'}
          onClick={send}
          className="w-full cursor-pointer border-0 py-3.5"
          style={{
            background: stage === 'sent' ? 'var(--color-done-500)' : ready ? 'var(--accent)' : 'var(--bg-sunken)',
            color: ready || stage === 'sent' ? '#fff' : 'var(--text-faint)',
            fontFamily: 'var(--font-mono)',
            fontSize: '12px',
            fontWeight: 500,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            transition: 'background .2s',
          }}
        >
          {stage === 'sending' ? 'Отправляю…' : stage === 'sent' ? 'Отправлено' : 'Отправить задачу'}
        </button>
      </footer>
    </div>
  );
}
