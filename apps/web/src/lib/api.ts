import { getInitData } from './telegram';

/**
 * Клиент API.
 *
 * Токен живёт в памяти, а не в localStorage: Mini App переоткрывается при
 * каждом запуске и всё равно входит заново по initData, а лежащий на диске
 * токен — это только лишний способ его потерять.
 *
 * Вход происходит лениво: первый же запрос, получивший отказ, сам сходит
 * за токеном и повторится. Экранам не нужно знать, авторизованы мы или нет.
 */

const BASE = import.meta.env.VITE_API_URL ?? '/api';

let accessToken: string | null = null;
let loginPromise: Promise<void> | null = null;

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function login(): Promise<void> {
  const initData = getInitData();
  if (!initData) {
    throw new ApiError('no_init_data', 'Приложение открыто не из Telegram', 401);
  }

  const response = await fetch(`${BASE}/auth/telegram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: { code: string; message: string } }
      | null;
    throw new ApiError(
      body?.error?.code ?? 'unauthorized',
      body?.error?.message ?? 'Не удалось войти',
      response.status,
    );
  }

  const data = (await response.json()) as { accessToken: string };
  accessToken = data.accessToken;
}

/** Несколько одновременных запросов не должны логиниться каждый сам по себе. */
function ensureLogin(): Promise<void> {
  loginPromise ??= login().finally(() => {
    loginPromise = null;
  });
  return loginPromise;
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  if (!accessToken) await ensureLogin();

  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...init.headers,
    },
  });

  /** Токен протух — входим заново и повторяем ровно один раз. */
  if (response.status === 401 && retry) {
    accessToken = null;
    return request<T>(path, init, false);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: { code: string; message: string } }
      | null;
    throw new ApiError(
      body?.error?.code ?? 'unknown',
      body?.error?.message ?? 'Что-то пошло не так',
      response.status,
    );
  }

  return response.json() as Promise<T>;
}

/* ------------------------------------------------------------------ Типы */

export type Me = {
  id: string;
  firstName: string;
  lastName: string | null;
  position: string | null;
  role: 'employee' | 'manager' | 'admin';
  timezone: string;
  avatar: string | null;
  initials: string;
  canAssign: boolean;
  canApprove: boolean;
  /** Проекты приходят вместе с профилем — на старте это экономит запрос. */
  projects: Project[];
};

export type Assignee = {
  id: string;
  firstName: string;
  lastName: string | null;
  fullName: string;
  position: string | null;
  username: string | null;
  role: string;
  isPending: boolean;
  avatar: string | null;
  initials: string;
  openTasks: number;
  overdueTasks: number;
};

export type TaskDto = {
  id: string;
  ref: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  deadlineAt: string | null;
  projectName?: string;
  assigneeName?: string | null;
  assigneeId: string | null;
};

export type Project = { id: string; key: string; name: string };

/** Проект вместе со счётчиками — по ним выбирают, куда идти разбираться. */
export type ProjectSummary = {
  id: string;
  key: string;
  name: string;
  eventDate: string | null;
  hasSpreadsheet: boolean;
  openTasks: number;
  overdueTasks: number;
  vendorsTotal: number;
  vendorsWaiting: number;
  vendorsReceived: number;
};

/* --------------------------------------------------------------- Методы */

export const api = {
  me: () => request<Me>('/users/me'),

  assignees: (projectId?: string) =>
    request<{ items: Assignee[] }>(
      `/users/assignees${projectId ? `?projectId=${projectId}` : ''}`,
    ).then((r) => r.items),

  projects: {
    list: () => request<{ items: ProjectSummary[] }>('/projects').then((r) => r.items),

    create: (input: { name: string; eventDate?: string; spreadsheetUrl?: string }) =>
      request<ProjectSummary>('/projects', { method: 'POST', body: JSON.stringify(input) }),
  },

  tasks: {
    list: (scope: string, projectId?: string) =>
      request<{ items: TaskDto[] }>(
        `/tasks?scope=${scope}${projectId ? `&projectId=${projectId}` : ''}`,
      ).then((r) => r.items),

    create: (input: {
      projectId: string;
      title: string;
      description?: string;
      assigneeId: string;
      deadlineAt?: string;
      priority?: 'low' | 'normal' | 'high' | 'critical';
    }) =>
      request<TaskDto & { notified: boolean }>('/tasks', {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    setStatus: (id: string, status: string, comment?: string) =>
      request<TaskDto & { notice: string | null }>(`/tasks/${id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status, comment }),
      }),

    /** Очередь согласующего: проверенное, что ждёт окончательного решения. */
    awaitingApproval: () =>
      request<{ items: TaskDto[] }>('/tasks/awaiting-approval').then((r) => r.items),
  },
};
