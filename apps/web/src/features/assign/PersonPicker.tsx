import { useState } from 'react';
import { haptic } from '@/lib/telegram';

/**
 * Выбор исполнителя.
 *
 * Лента лиц, а не выпадающий список: руководитель заводит задачи каждый
 * день и знает команду в лицо. Узнать нужного человека по фотографии
 * быстрее, чем прочитать пять имён и найти среди них своё.
 *
 * Когда фотографии нет — Telegram отдаёт её не всегда, зависит от настроек
 * приватности — на её месте инициалы. Пустой серый кружок был бы хуже:
 * по нему человека не опознать вовсе.
 */

export type Person = {
  id: string;
  firstName: string;
  fullName: string;
  position: string | null;
  avatar: string | null;
  initials: string;
  isPending: boolean;
  openTasks: number;
  overdueTasks: number;
};

type Props = {
  people: Person[];
  selectedId: string | null;
  onSelect: (id: string) => void;
};

export function PersonPicker({ people, selectedId, onSelect }: Props) {
  return (
    <div>
      <div className="t-eyebrow mb-3">Кому</div>

      <div
        className="flex gap-3 overflow-x-auto pb-2"
        style={{ scrollbarWidth: 'none', marginInline: '-16px', paddingInline: '16px' }}
      >
        {people.map((person) => (
          <PersonTile
            key={person.id}
            person={person}
            selected={selectedId === person.id}
            onSelect={() => {
              haptic('tap');
              onSelect(person.id);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function PersonTile({
  person,
  selected,
  onSelect,
}: {
  person: Person;
  selected: boolean;
  onSelect: () => void;
}) {
  /** Картинка может не загрузиться — тогда молча показываем инициалы. */
  const [broken, setBroken] = useState(false);
  const showPhoto = person.avatar && !broken;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className="flex shrink-0 cursor-pointer flex-col items-center border-0 bg-transparent p-0"
      style={{ width: '72px' }}
    >
      <div className="relative">
        <div
          style={{
            width: '58px',
            height: '58px',
            overflow: 'hidden',
            background: 'var(--bg-sunken)',
            border: selected ? '2px solid var(--accent)' : '1px solid var(--line)',
            boxShadow: selected
              ? '0 0 0 4px color-mix(in srgb, var(--accent) 18%, transparent)'
              : 'none',
            transition: 'border-color .15s, box-shadow .15s',
            display: 'grid',
            placeItems: 'center',
          }}
        >
          {showPhoto ? (
            <img
              src={person.avatar!}
              alt=""
              onError={() => setBroken(true)}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <span
              className="t-display"
              style={{
                fontSize: '20px',
                color: selected ? 'var(--accent)' : 'var(--text-muted)',
                letterSpacing: '0.04em',
              }}
            >
              {person.initials}
            </span>
          )}
        </div>

        {/*
          Метка просрочек. Ставить пятую срочную задачу тому, у кого уже
          две горящие, — решение, которое стоит принимать с открытыми глазами.
        */}
        {person.overdueTasks > 0 && (
          <span
            className="t-mono absolute"
            style={{
              top: '-4px',
              right: '-4px',
              minWidth: '18px',
              height: '18px',
              padding: '0 4px',
              background: 'var(--color-overdue-500)',
              color: '#fff',
              fontSize: '10px',
              fontWeight: 700,
              display: 'grid',
              placeItems: 'center',
            }}
            title={`Просрочено: ${person.overdueTasks}`}
          >
            {person.overdueTasks}
          </span>
        )}
      </div>

      <span
        className="mt-2 w-full truncate text-center"
        style={{
          fontSize: '12px',
          fontWeight: selected ? 700 : 500,
          color: selected ? 'var(--text)' : 'var(--text-muted)',
        }}
      >
        {person.firstName}
      </span>

      <span
        className="t-mono w-full truncate text-center"
        style={{ fontSize: '9px', color: 'var(--text-faint)' }}
      >
        {person.isPending ? 'не заходил' : `${person.openTasks} в работе`}
      </span>
    </button>
  );
}
