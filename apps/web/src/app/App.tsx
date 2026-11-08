import { useCallback, useEffect, useRef, useState } from 'react';
import { DayScale, type ScaleTask } from '@/features/today/DayScale';
import { groupByDeadline, todayOnly } from '@/features/today/groupTasks';
import { TaskCard, type TaskCardData, type Viewer } from '@/components/TaskCard';
import { AssignScreen } from '@/features/assign/AssignScreen';
import { ProjectSwitcher } from '@/features/projects/ProjectSwitcher';
import { NewProjectScreen } from '@/features/projects/NewProjectScreen';
import { api, ApiError, type Me, type ProjectSummary, type TaskDto } from '@/lib/api';
import { haptic } from '@/lib/telegram';
import type { TaskStatus } from '@ostro/shared';

/**
 * Главный экран.
 *
 * Три вида, между которыми переключаются вкладками: свои задачи, задачи
 * команды и очередь на принятие. Разделение не косметическое — это три
 * разные работы. Исполнитель ведёт своё, руководитель смотрит, что
 * происходит у людей, согласующий проходит по проверенному и принимает.
 *
 * Раньше был только первый вид, и руководитель мог поставить задачу,
 * но не мог посмотреть, что с ней стало.
 */

const LAST_PROJECT_KEY = 'ostro:project';

type Screen = 'list' | 'assign' | 'new-project';
type Tab = 'my' | 'team' | 'approval';

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('my');
  const [tasks, setTasks] = useState<TaskCardData[] | null>(null);
  const [approvalCount, setApprovalCount] = useState(0);
  const [screen, setScreen] = useState<Screen>('list');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const now = new Date();

  /* ------------------------------------------------------- Загрузка */

  const loadProfile = useCallback(async () => {
    const [profile, list] = await Promise.all([api.me(), api.projects.list()]);
    setMe(profile);
    setProjects(list);

    setProjectId((current) => {
      if (current && list.some((p) => p.id === current)) return current;
      const remembered = readRemembered();
      if (remembered && list.some((p) => p.id === remembered)) return remembered;
      return list[0]?.id ?? null;
    });

    /** Счётчик на вкладке согласующего — единственная причина её открыть. */
    if (profile.canApprove) {
      const pending = await api.tasks.awaitingApproval().catch(() => []);
      setApprovalCount(pending.length);
    }
  }, []);

  const loadTasks = useCallback(
    async (which: Tab, id: string | null) => {
      setTasks(null);

      if (which === 'approval') {
        const list = await api.tasks.awaitingApproval();
        setApprovalCount(list.length);
        setTasks(list.map(toCard));
        return;
      }

      if (!id) {
        setTasks([]);
        return;
      }

      const list = await api.tasks.list(which, id);
      setTasks(list.map(toCard));
    },
    [],
  );

  useEffect(() => {
    loadProfile()
      .then(() => setError(null))
      .catch((e: unknown) =>
        setError(
          e instanceof ApiError
            ? e.message
            : 'Не удалось связаться с сервером. Попробуй переоткрыть приложение.',
        ),
      );
  }, [loadProfile]);

  useEffect(() => {
    if (tab !== 'approval' && projectId === null) return;
    if (projectId) rememberProject(projectId);
    void loadTasks(tab, projectId).catch(() => setTasks([]));
  }, [tab, projectId, loadTasks]);

  /* -------------------------------------------------------- Действия */

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    cardRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  const changeStatus = useCallback(
    async (id: string, status: TaskStatus) => {
      haptic('tap');
      setNotice(null);

      try {
        const result = await api.tasks.setStatus(id, status);
        haptic('success');

        /**
         * Сервер мог перевести задачу не туда, куда просили: руководитель
         * без права принятия отправляет её согласующему. Об этом говорим
         * прямо, иначе статус меняется «непонятно почему».
         */
        if (result.notice) setNotice(result.notice);

        await loadTasks(tab, projectId);
        if (me?.canApprove) {
          const pending = await api.tasks.awaitingApproval().catch(() => []);
          setApprovalCount(pending.length);
        }
      } catch (e) {
        haptic('error');
        setError(e instanceof ApiError ? e.message : 'Не удалось сохранить статус');
        void loadTasks(tab, projectId);
      }
    },
    [loadTasks, tab, projectId, me],
  );

  /* --------------------------------------------------- Другие экраны */

  const current = projects.find((p) => p.id === projectId) ?? null;

  if (screen === 'assign' && current) {
    return (
      <AssignScreen
        projectId={current.id}
        projectName={current.name}
        onDone={() => {
          setScreen('list');
          void loadTasks(tab, current.id);
        }}
      />
    );
  }

  if (screen === 'new-project') {
    return (
      <NewProjectScreen
        onCancel={() => setScreen('list')}
        onCreated={(project) => {
          setProjects((prev) => [project, ...prev]);
          setProjectId(project.id);
          setScreen('list');
        }}
      />
    );
  }

  /* ------------------------------------------------------------ Вид */

  const canAssign = Boolean(me?.canAssign);
  const viewer: Viewer | undefined = me
    ? { id: me.id, role: me.role, canApprove: me.canApprove }
    : undefined;

  const scaleTasks: ScaleTask[] =
    tab === 'my'
      ? todayOnly(tasks ?? [], now).map((t) => ({
          id: t.id,
          title: t.title,
          deadlineAt: t.deadlineAt!,
          status: t.isOverdue
            ? 'overdue'
            : t.status === 'done'
              ? 'done'
              : t.priority === 'critical' || t.priority === 'high'
                ? 'urgent'
                : 'normal',
        }))
      : [];

  const overdueCount = (tasks ?? []).filter((t) => t.isOverdue).length;

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col">
      <header className="safe-top px-4 pb-2 pt-4">
        {projects.length > 0 && (
          <div className="mb-2">
            <ProjectSwitcher
              projects={projects}
              currentId={projectId}
              onSelect={setProjectId}
              onCreate={canAssign ? () => setScreen('new-project') : undefined}
            />
          </div>
        )}

        <div className="flex items-baseline justify-between gap-3">
          <h1
            className="t-display"
            style={{ fontSize: '25px', letterSpacing: '0.06em', color: 'var(--text)' }}
          >
            {tab === 'my' ? 'Мои задачи' : tab === 'team' ? 'Команда' : 'Ждут решения'}
          </h1>

          {canAssign && current && (
            <button
              type="button"
              onClick={() => {
                haptic('tap');
                setScreen('assign');
              }}
              className="t-mono shrink-0 cursor-pointer px-3 py-1.5"
              style={{
                fontSize: '11px',
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color: 'var(--accent)',
                border: '1px solid var(--accent)',
                background: 'transparent',
              }}
            >
              + Задача
            </button>
          )}
        </div>

        <p className="mt-1" style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
          {tasks === null
            ? 'Загружаю…'
            : tasks.length === 0
              ? emptyHint(tab)
              : `${tasks.length} ${plural(tasks.length, 'задача', 'задачи', 'задач')}`}
          {overdueCount > 0 && (
            <>
              {' · '}
              <span style={{ color: 'var(--color-overdue-500)', fontWeight: 600 }}>
                {overdueCount} {plural(overdueCount, 'просрочена', 'просрочены', 'просрочено')}
              </span>
            </>
          )}
        </p>

        {/* Вкладки появляются только у тех, кому есть между чем переключаться */}
        {canAssign && (
          <nav className="mt-3 flex gap-1">
            <TabButton active={tab === 'my'} onClick={() => setTab('my')} label="Мои" />
            <TabButton active={tab === 'team'} onClick={() => setTab('team')} label="Команда" />
            {me?.canApprove && (
              <TabButton
                active={tab === 'approval'}
                onClick={() => setTab('approval')}
                label="Ждут меня"
                badge={approvalCount}
              />
            )}
          </nav>
        )}
      </header>

      {notice && (
        <p
          className="mx-4 mt-2 px-3 py-2"
          style={{
            fontSize: '13px',
            color: 'var(--accent)',
            border: '1px solid var(--accent)',
            background: 'var(--accent-soft)',
          }}
        >
          {notice}
        </p>
      )}

      {error && (
        <p
          className="mx-4 mt-2 px-3 py-2"
          style={{
            fontSize: '13px',
            color: 'var(--color-overdue-500)',
            border: '1px solid var(--color-overdue-500)',
            background: 'var(--bg-elevated)',
          }}
        >
          {error}
        </p>
      )}

      {projects.length === 0 && me && (
        <div className="px-4 py-12 text-center" style={{ color: 'var(--text-faint)' }}>
          <p style={{ fontSize: '14px' }}>Пока нет ни одного проекта.</p>
          {canAssign && (
            <button
              type="button"
              onClick={() => setScreen('new-project')}
              className="t-mono mt-4 cursor-pointer px-4 py-2"
              style={{
                fontSize: '11px',
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color: 'var(--accent)',
                border: '1px solid var(--accent)',
                background: 'transparent',
              }}
            >
              Создать первый
            </button>
          )}
        </div>
      )}

      {scaleTasks.length > 0 && (
        <DayScale tasks={scaleTasks} now={now} selectedId={selectedId} onSelect={handleSelect} />
      )}

      <main className="flex flex-col px-4 pb-6 pt-2">
        {tasks !== null &&
          buildSections(tasks, tab, now).map((section) => (
            <section key={section.key} className="mb-5">
              <div
                className="t-eyebrow mb-2 flex items-baseline gap-2"
                style={
                  section.tone === 'overdue'
                    ? { color: 'var(--color-overdue-500)' }
                    : section.tone === 'today'
                      ? { color: 'var(--accent)' }
                      : undefined
                }
              >
                <span>{section.title}</span>
                <span style={{ opacity: 0.6 }}>{section.tasks.length}</span>
              </div>

              <div className="flex flex-col gap-2">
                {section.tasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    viewer={viewer}
                    highlighted={selectedId === task.id}
                    innerRef={(el) => {
                      cardRefs.current[task.id] = el;
                    }}
                    onOpen={() => setSelectedId(task.id)}
                    onStatus={(id, status) => void changeStatus(id, status)}
                  />
                ))}
              </div>
            </section>
          ))}

        {tasks?.length === 0 && projects.length > 0 && (
          <div
            className="px-4 py-10 text-center"
            style={{ color: 'var(--text-faint)', fontSize: '14px' }}
          >
            {emptyHint(tab)}
          </div>
        )}
      </main>

      <footer className="safe-bottom mt-auto px-4 pt-2">
        <p className="t-mono" style={{ fontSize: '10px', color: 'var(--text-faint)' }}>
          {me ? `${me.firstName}${me.position ? ` · ${me.position}` : ''}` : 'ОСТРО'}
        </p>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------ Вкладки */

function TabButton({
  active,
  onClick,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        haptic('tap');
        onClick();
      }}
      aria-pressed={active}
      className="t-mono flex cursor-pointer items-center gap-1.5 px-3 py-1.5"
      style={{
        fontSize: '11px',
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: active ? 'var(--text)' : 'var(--text-faint)',
        background: active ? 'var(--bg-elevated)' : 'transparent',
        border: `1px solid ${active ? 'var(--line-strong)' : 'transparent'}`,
      }}
    >
      {label}
      {badge !== undefined && badge > 0 && (
        <span
          style={{
            minWidth: '16px',
            height: '16px',
            padding: '0 4px',
            display: 'grid',
            placeItems: 'center',
            background: 'var(--accent)',
            color: '#fff',
            fontSize: '9px',
            fontWeight: 700,
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

/* --------------------------------------------------------- Группировка */

type Section = {
  key: string;
  title: string;
  tone: 'overdue' | 'today' | 'normal';
  tasks: TaskCardData[];
};

/**
 * Свои задачи группируются по срокам, чужие — по людям.
 *
 * Руководитель смотрит на команду вопросом «у кого что», а не «что когда»:
 * ему нужно увидеть, что у одного человека три просрочки, а другой свободен.
 */
function buildSections(tasks: TaskCardData[], tab: Tab, now: Date): Section[] {
  if (tab === 'my') return groupByDeadline(tasks, now);

  if (tab === 'approval') {
    return tasks.length > 0
      ? [{ key: 'approval', title: 'Проверено, ждёт решения', tone: 'today', tasks }]
      : [];
  }

  const byPerson = new Map<string, TaskCardData[]>();
  for (const task of tasks) {
    const key = task.assigneeName ?? 'Без исполнителя';
    const list = byPerson.get(key) ?? [];
    list.push(task);
    byPerson.set(key, list);
  }

  return [...byPerson.entries()]
    .map(([name, list]) => ({
      key: name,
      title: name,
      tone: list.some((t) => t.isOverdue) ? ('overdue' as const) : ('normal' as const),
      tasks: list,
    }))
    /** Сверху те, у кого горит: экран открывают, чтобы найти именно их. */
    .sort((a, b) => {
      const aOver = a.tasks.filter((t) => t.isOverdue).length;
      const bOver = b.tasks.filter((t) => t.isOverdue).length;
      if (aOver !== bOver) return bOver - aOver;
      return b.tasks.length - a.tasks.length;
    });
}

function emptyHint(tab: Tab): string {
  if (tab === 'approval') return 'Ничего не ждёт решения.';
  if (tab === 'team') return 'У команды нет открытых задач по этому проекту.';
  return 'Задач нет.';
}

/* -------------------------------------------------------------- Прочее */

function readRemembered(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

function rememberProject(id: string): void {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, id);
  } catch {
    /* не запомнили — не беда */
  }
}

function toCard(t: TaskDto): TaskCardData {
  const deadlineAt = t.deadlineAt ? new Date(t.deadlineAt) : null;
  return {
    id: t.id,
    ref: t.ref,
    title: t.title,
    status: t.status as TaskStatus,
    priority: t.priority as never,
    deadlineAt,
    projectName: t.projectName ?? '',
    assigneeName: t.assigneeName ?? null,
    assigneeId: t.assigneeId,
    isOverdue:
      deadlineAt !== null &&
      deadlineAt.getTime() < Date.now() &&
      t.status !== 'done' &&
      t.status !== 'cancelled',
  };
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
