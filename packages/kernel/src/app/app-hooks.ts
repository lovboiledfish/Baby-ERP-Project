import { scopeNameSchema } from '@steward/shared';
import type { HookRegistry, SystemHook } from '../data/hooks';
import { ValidationError } from '../errors';
import { TRACKED_METADATA_TABLES } from './app-service';

export function appHooks(): SystemHook[] {
  const hooks: SystemHook[] = [
    {
      name: 'sys_scope: validate',
      table: 'sys_scope',
      when: 'before',
      operations: ['insert', 'update'],
      run({ current, previous, operation }) {
        const scope = String(current.scope ?? '').trim();
        const parsed = scopeNameSchema.safeParse(scope);
        if (!parsed.success) {
          throw new ValidationError(`Invalid application scope "${scope}"`, parsed.error.issues[0]?.message);
        }
        current.scope = scope;
        if (operation === 'update' && previous && previous.scope !== current.scope) {
          throw new ValidationError('sys_scope.scope cannot be changed once created');
        }
        if (!String(current.name ?? '').trim()) {
          throw new ValidationError('Application name is required');
        }
        current.version ??= '1.0.0';
      },
    },
    {
      name: 'sys_scope: reload cache',
      table: 'sys_scope',
      when: 'after',
      operations: ['insert', 'update', 'delete'],
      async run({ engine }) {
        if (engine.apps) await engine.apps.load(engine.db);
      },
    },
    {
      name: 'sys_scope_privilege: reload cache',
      table: 'sys_scope_privilege',
      when: 'after',
      operations: ['insert', 'update', 'delete'],
      async run({ engine }) {
        if (engine.apps) await engine.apps.load(engine.db);
      },
    },
  ];

  // Register Update Set & customization-protection capture hooks for tracked metadata tables
  for (const table of TRACKED_METADATA_TABLES) {
    hooks.push({
      name: `${table}: capture update set & customization`,
      table,
      when: 'after',
      operations: ['insert', 'update', 'delete'],
      async run({ engine, operation, current, session }) {
        if (engine.apps) {
          await engine.apps.captureMetadataChange(engine, operation, table, current, session);
        }
      },
    });
  }

  return hooks;
}

export function registerAppHooks(registry: HookRegistry): void {
  registry.register(...appHooks());
}
