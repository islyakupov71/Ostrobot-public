import type { ProjectRole, UserRole } from '@ostro/shared';

/**
 * Права доступа.
 *
 * Три роли плюс роль внутри проекта. Проверка идёт в одну сторону:
 * сначала глобальная роль, потом принадлежность к проекту.
 *
 * Сотрудник видит только свои задачи. Руководитель ведёт свои проекты
 * целиком и сам набирает в них людей. Администратор отвечает за саму
 * систему — интеграции, правила напоминаний, журнал; при этом он обычно
 * ещё и рядовой исполнитель со своими задачами.
 */

export const PERMISSIONS = [
  /* Задачи */
  'task:read:own',
  'task:read:project',
  'task:read:all',
  'task:create',
  'task:update',
  'task:delete',
  'task:assign',
  'task:change_deadline',
  'task:transition:own',
  'task:review', // проверка работы: submitted → reviewed | rework
  'task:approve', // окончательное принятие: только главный согласующий

  /* КП */
  'kp:read:own',
  'kp:read:project',
  'kp:create',
  'kp:update',
  'kp:mark_received',

  /* Команда и отчётность */
  'team:read',
  'team:summary',
  'report:submit',
  'report:read:own',
  'report:read:team',

  /* Администрирование */
  'user:manage',
  'role:assign',
  'project:manage',
  'notification_rule:manage',
  'integration:manage',
  'audit:read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const EMPLOYEE: readonly Permission[] = [
  'task:read:own',
  'task:transition:own',
  'kp:read:own',
  'kp:mark_received',
  'report:submit',
  'report:read:own',
];

/**
 * Руководитель ведёт команду и сам её набирает.
 *
 * Заводить сотрудников, создавать тендеры и подключать под них таблицы —
 * это ежедневная работа, а не настройка системы. Если для каждого нового
 * человека нужно идти к разработчику, система умирает на второй неделе.
 */
const MANAGER: readonly Permission[] = [
  ...EMPLOYEE,
  'task:read:project',
  'task:create',
  'task:update',
  'task:assign',
  'task:change_deadline',
  'task:review',
  'kp:read:project',
  'kp:create',
  'kp:update',
  'team:read',
  'team:summary',
  'report:read:team',

  /* --- повседневное администрирование --- */
  'user:manage',
  'role:assign',
  'project:manage',
];

/**
 * Администратор отвечает за саму систему, а не за команду.
 *
 * Это техническая роль: подключение Google, правила напоминаний,
 * системный журнал. Носитель этой роли обычно ещё и обычный исполнитель
 * со своими задачами — одно другому не мешает.
 */
const ADMIN: readonly Permission[] = [
  ...MANAGER,
  'task:read:all',
  'task:delete',
  'notification_rule:manage',
  'integration:manage',
  'audit:read',
];

/**
 * Главный согласующий — руководитель плюс единственное дополнительное право:
 * окончательно принять работу. Ради него роль и заведена.
 */
const HEAD: readonly Permission[] = [...MANAGER, 'task:approve'];

const ADMIN_FULL: readonly Permission[] = [...ADMIN, 'task:approve'];

const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  employee: EMPLOYEE,
  manager: MANAGER,
  head: HEAD,
  admin: ADMIN_FULL,
};

export function can(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsOf(role: UserRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export type AccessContext = {
  role: UserRole;
  userId: string;
  /** Проекты пользователя и его роль в каждом. */
  projectRoles: ReadonlyMap<string, ProjectRole>;
};

/**
 * Видит ли пользователь конкретную задачу.
 *
 * Сотруднику доступны только его собственные задачи — по ТЗ он работает
 * со своим списком, а не с доской всей компании. Наблюдатель в проекте
 * видит задачи, но менять их не может: это отдельная проверка через can().
 */
export function canSeeTask(
  ctx: AccessContext,
  task: { assigneeId: string | null; authorId: string | null; projectId: string },
): boolean {
  if (ctx.role === 'admin') return true;
  if (task.assigneeId === ctx.userId || task.authorId === ctx.userId) return true;

  const projectRole = ctx.projectRoles.get(task.projectId);
  if (!projectRole) return false;

  return ctx.role !== 'employee' || projectRole === 'lead' || projectRole === 'observer';
}

/** Может ли пользователь управлять задачами проекта: создавать, назначать, двигать сроки. */
export function canManageProject(ctx: AccessContext, projectId: string): boolean {
  if (ctx.role === 'admin') return true;
  const projectRole = ctx.projectRoles.get(projectId);
  return ctx.role !== 'employee' && (projectRole === 'lead' || projectRole === 'member');
}

/**
 * Может ли пользователь заводить людей и проекты.
 *
 * Вынесено отдельной функцией, потому что это право не привязано
 * к конкретному проекту: новый тендер ещё не существует в момент,
 * когда его создают.
 */
export function canAdminister(ctx: AccessContext): boolean {
  return ctx.role === 'manager' || ctx.role === 'head' || ctx.role === 'admin';
}

/** Может ли пользователь окончательно принимать работу. */
export function canApprove(role: UserRole): boolean {
  return role === 'head' || role === 'admin';
}

/**
 * Кому уходит эскалация по задаче.
 * Ищем ведущего проекта; если его нет — любого руководителя проекта.
 */
export function escalationRecipients(
  members: readonly { userId: string; role: ProjectRole; globalRole: UserRole }[],
): string[] {
  const leads = members.filter((m) => m.role === 'lead').map((m) => m.userId);
  if (leads.length > 0) return leads;
  return members
    .filter((m) => m.globalRole !== 'employee')
    .map((m) => m.userId);
}
