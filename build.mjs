import { build } from 'esbuild';

/**
 * Сборка серверных приложений в один файл.
 *
 * Пакеты монорепозитория (@ostro/*) указывают в package.json на исходники
 * на TypeScript — это удобно в разработке, но Node такие импорты не понимает,
 * и обычный tsc оставляет их в сборке как есть. Поэтому свои пакеты
 * складываем внутрь бандла, а зависимости из npm оставляем снаружи:
 * fastify и pino грузят часть своих файлов динамически, и попытка
 * затащить их в бандл ломается на ровном месте.
 *
 * Запуск: node build.mjs api | node build.mjs worker
 */

const TARGETS = {
  api: { entry: 'apps/api/src/index.ts', out: 'apps/api/dist/server.mjs' },
  worker: { entry: 'apps/worker/src/index.ts', out: 'apps/worker/dist/server.mjs' },
  migrate: { entry: 'packages/db/src/migrate.ts', out: 'packages/db/dist/migrate.mjs' },
  seed: { entry: 'packages/db/src/seed.ts', out: 'packages/db/dist/seed.mjs' },
  /** Разовый импорт подрядчиков из статус-таблицы. */
  'import-vendors': {
    entry: 'apps/worker/src/scripts/import-vendors.ts',
    out: 'apps/worker/dist/import-vendors.mjs',
  },
  /** Заведение сотрудников по списку. */
  'add-people': {
    entry: 'apps/worker/src/scripts/add-people.ts',
    out: 'apps/worker/dist/add-people.mjs',
  },
  /** Схема одним файлом: drizzle-kit не умеет резолвить наши workspace-импорты. */
  schema: {
    entry: 'packages/db/src/schema.ts',
    out: 'packages/db/dist/schema.cjs',
    /** drizzle-kit подгружает схему через CommonJS, ESM он не принимает. */
    format: 'cjs',
  },
};

/** Внутрь бандла попадают только свои пакеты и относительные пути. */
const bundleOwnPackagesOnly = {
  name: 'externalize-npm',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === 'entry-point') return null;
      if (args.path.startsWith('.') || args.path.startsWith('/')) return null;
      if (args.path.startsWith('@ostro/')) return null;
      return { external: true };
    });
  },
};

const name = process.argv[2];
const target = TARGETS[name];

if (!target) {
  console.error(`Укажи, что собирать: ${Object.keys(TARGETS).join(' или ')}`);
  process.exit(1);
}

await build({
  entryPoints: [target.entry],
  outfile: target.out,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: target.format ?? 'esm',
  sourcemap: true,
  minify: false,
  /**
   * Некоторые зависимости внутри всё ещё зовут require(). В модуле ESM
   * его нет, поэтому создаём совместимый — иначе падение происходит
   * не при сборке, а в проде на первом же таком вызове.
   */
  banner: target.format === 'cjs' ? undefined : {
    js: [
      "import { createRequire as __createRequire } from 'module';",
      "import { fileURLToPath as __fileURLToPath } from 'url';",
      "import { dirname as __dirname_ } from 'path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __dirname_(__filename);',
    ].join('\n'),
  },
  plugins: [bundleOwnPackagesOnly],
  logLevel: 'info',
});

console.log(`Собрано: ${target.out}`);
