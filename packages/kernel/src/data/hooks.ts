import type { MetaService } from '../meta/meta-service';
import type { Session } from '../session';
import type { DataEngine, RecordValues } from './data-engine';

export type Operation = 'insert' | 'update' | 'delete';
export type HookWhen = 'before' | 'after';

export interface HookContext {
  /** Transaction-bound engine; writes made here join the current transaction. */
  readonly engine: DataEngine;
  readonly session: Session;
  readonly table: string;
  readonly operation: Operation;
  /** Mutable in "before" hooks for insert/update. */
  readonly current: RecordValues;
  readonly previous?: Readonly<RecordValues>;
}

/**
 * Platform-internal hooks. Phase 4 generalizes this into user-defined
 * business rules (sys_script) executed in a sandbox; the pipeline stays the same.
 */
export interface SystemHook {
  name: string;
  /** Matches this table and all tables extending it. */
  table: string;
  when: HookWhen;
  operations: Operation[];
  run(ctx: HookContext): void | Promise<void>;
}

export class HookRegistry {
  private readonly hooks: SystemHook[] = [];

  register(...hooks: SystemHook[]): void {
    this.hooks.push(...hooks);
  }

  async run(meta: MetaService, when: HookWhen, ctx: HookContext): Promise<void> {
    const chain = new Set(meta.ancestors(ctx.table).map((t) => t.name));
    for (const hook of this.hooks) {
      if (hook.when === when && hook.operations.includes(ctx.operation) && chain.has(hook.table)) {
        await hook.run(ctx);
      }
    }
  }
}
