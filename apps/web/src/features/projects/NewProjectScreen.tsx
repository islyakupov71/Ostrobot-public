import { useState } from 'react';
import { api, ApiError, type ProjectSummary } from '@/lib/api';
import { haptic } from '@/lib/telegram';

/**
 * Новый проект.
 *
 * Три поля, из которых обязательно одно. Всё, что можно вывести, выводится:
 * короткий код проекта собирается из названия и года мероприятия, категории
 * закупки берутся типовые. Спрашивать это у человека — плодить поля ради
 * данных, которые система знает сама.
 *
 * Ссылка на статус-таблицу принимается целиком, как её копируют из адресной
 * строки: просить «идентификатор книги» бессмысленно, его никто не видит.
 */

type Props = {
  onCreated: (project: ProjectSummary) => void;
  onCancel: () => void;
};

export function NewProjectScreen({ onCreated, onCancel }: Props) {
  const [name, setName] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [sheetUrl, setSheetUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = name.trim().length >= 2;

  async function create() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);

    try {
      const project = await api.projects.create({
        name: name.trim(),
        eventDate: eventDate ? new Date(eventDate).toISOString() : undefined,
        spreadsheetUrl: sheetUrl.trim() || undefined,
      });
      haptic('success');
      onCreated(project);
    } catch (e) {
      haptic('error');
      setError(e instanceof ApiError ? e.message : 'Не удалось создать проект');
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col">
      <header className="safe-top flex items-baseline justify-between px-4 pb-4 pt-4">
        <h1
          className="t-display"
          style={{ fontSize: '24px', letterSpacing: '0.06em', color: 'var(--text)' }}
        >
          Новый проект
        </h1>
        <button
          type="button"
          onClick={onCancel}
          className="t-mono cursor-pointer border-0 bg-transparent p-0"
          style={{ fontSize: '11px', color: 'var(--text-faint)', letterSpacing: '0.1em' }}
        >
          ОТМЕНА
        </button>
      </header>

      <main className="flex flex-col gap-5 px-4 pb-6">
        <Field label="Название мероприятия" hint="Например: Тендер НГ 2027">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            autoFocus
            placeholder="Тендер НГ 2027"
            style={inputStyle}
          />
        </Field>

        <Field label="Дата мероприятия" hint="Не обязательно. От неё считаются сроки закупки">
          <input
            type="date"
            value={eventDate}
            onChange={(e) => setEventDate(e.target.value)}
            className="t-mono"
            style={inputStyle}
          />
        </Field>

        <Field
          label="Ссылка на статус-таблицу"
          hint="Не обязательно. Можно привязать позже — тогда бот начнёт следить за подрядчиками"
        >
          <input
            value={sheetUrl}
            onChange={(e) => setSheetUrl(e.target.value)}
            placeholder="https://docs.google.com/spreadsheets/d/…"
            style={{ ...inputStyle, fontSize: '13px' }}
          />
        </Field>

        <div
          className="px-3 py-3"
          style={{
            background: 'var(--bg-sunken)',
            border: '1px solid var(--line)',
            fontSize: '13px',
            color: 'var(--text-muted)',
            lineHeight: 1.5,
          }}
        >
          Вместе с проектом заведутся типовые категории закупки — площадки,
          ведущие, кавер-группа, кейтеринг и остальные. Список можно поправить
          потом. Вся команда получит доступ сразу.
        </div>

        {error && (
          <p style={{ fontSize: '13px', color: 'var(--color-overdue-500)' }}>{error}</p>
        )}
      </main>

      <footer
        className="safe-bottom sticky bottom-0 mt-auto px-4 pt-3"
        style={{ background: 'var(--bg)', borderTop: '1px solid var(--line)' }}
      >
        <button
          type="button"
          disabled={!ready || busy}
          onClick={create}
          className="w-full cursor-pointer border-0 py-3.5"
          style={{
            background: ready ? 'var(--accent)' : 'var(--bg-sunken)',
            color: ready ? '#fff' : 'var(--text-faint)',
            fontFamily: 'var(--font-mono)',
            fontSize: '12px',
            fontWeight: 500,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
          }}
        >
          {busy ? 'Создаю…' : 'Создать проект'}
        </button>
      </footer>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius-card)',
  color: 'var(--text)',
  fontSize: '15px',
  fontFamily: 'inherit',
  padding: '12px',
};

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="t-eyebrow mb-2">{label}</div>
      {children}
      {hint && (
        <p className="mt-1.5" style={{ fontSize: '11px', color: 'var(--text-faint)' }}>
          {hint}
        </p>
      )}
    </div>
  );
}
