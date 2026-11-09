import { EncodedQueryError, parseEncodedQuery, type QueryAst } from '@steward/shared';
import type { DataEngine, RecordValues } from '../data/data-engine';
import type { Operation } from '../data/hooks';
import type { Db } from '../db/db';
import { ForbiddenError, ValidationError } from '../errors';
import type { MetaService } from '../meta/meta-service';
import type { Session } from '../session';
import { matchesRecord } from './match-record';
import {
  ScriptRuntime,
  checkScriptSyntax,
  type ScriptExecResult,
  type ScriptLogEntry,
  type ScriptRuntimeOptions,
} from './sandbox';

export type RuleWhen = 'before' | 'after' | 'async';

export interface BusinessRule {
  sysId: string;
  name: string;
  collection: string;
  when: RuleWhen;
  order: number;
  operations: ReadonlySet<Operation>;
  filterCondition: QueryAst | null;
  condition: string | null;
  script: string;
  broken: boolean;
}

export interface ScriptInclude {
  sysId: string;
  name: string;
  apiName: string;
  script: string;
  clientCallable: boolean;
  broken: boolean;
}

interface RuleRow {
  sys_id: string;
  name: string;
  collection: string;
  when: string;
  order: number | null;
  action_insert: boolean | null;
  action_update: boolean | null;
  action_delete: boolean | null;
  filter_condition: string | null;
  condition: string | null;
  script: string | null;
}

interface IncludeRow {
  sys_id: string;
  name: string;
  api_name: string | null;
  script: string | null;
  client_callable: boolean | null;
}

const MAX_RECENT_LOGS = 500;

/**
 * In-memory cache and executor for Business Rules (`sys_script`), Script Includes
 * (`sys_script_include`), Scripted ACLs (`sys_security_acl.script`), and
 * Background Scripts.
 */
export class ScriptService {
  readonly runtime: ScriptRuntime;
  private rulesByTable = new Map<string, BusinessRule[]>();
  private includes = new Map<string, ScriptInclude>();
  private includeSources = new Map<string, string>();
  private readonly inFlightAsync = new Set<Promise<void>>();
  readonly recentLogs: ScriptLogEntry[] = [];
  version = 0;

  constructor(
    private readonly meta: MetaService,
    opts: ScriptRuntimeOptions = {},
  ) {
    this.runtime = new ScriptRuntime(opts);
  }

  async load(db: Db): Promise<void> {
    const ruleRows = await db.query<RuleRow>(
      `SELECT "sys_id", "name", "collection", "when", "order", "action_insert", "action_update", "action_delete",
              "filter_condition", "condition", "script"
         FROM "sys_script"
        WHERE "active" IS NOT FALSE
        ORDER BY COALESCE("order", 100) ASC, "sys_created_on" ASC, "sys_id" ASC`,
    );
    const includeRows = await db.query<IncludeRow>(
      `SELECT "sys_id", "name", "api_name", "script", "client_callable"
         FROM "sys_script_include"
        WHERE "active" IS NOT FALSE`,
    );

    const byTable = new Map<string, BusinessRule[]>();
    for (const r of ruleRows.rows) {
      if (r.when !== 'before' && r.when !== 'after' && r.when !== 'async') continue;
      const ops = new Set<Operation>();
      if (r.action_insert) ops.add('insert');
      if (r.action_update) ops.add('update');
      if (r.action_delete) ops.add('delete');

      let filterCondition: QueryAst | null = null;
      let broken = false;
      if (r.filter_condition && r.filter_condition.trim()) {
        try {
          filterCondition = parseEncodedQuery(r.filter_condition);
          if (filterCondition.groups.length === 0) filterCondition = null;
        } catch (e) {
          if (!(e instanceof EncodedQueryError)) throw e;
          broken = true;
        }
      }
      const condition = r.condition && r.condition.trim() ? r.condition.trim() : null;
      if (condition) {
        try {
          checkScriptSyntax(condition, { expression: true });
        } catch {
          broken = true;
        }
      }
      const script = r.script ?? '';
      if (!script.trim()) {
        broken = true;
      } else {
        try {
          checkScriptSyntax(script);
        } catch {
          broken = true;
        }
      }

      const rule: BusinessRule = {
        sysId: r.sys_id,
        name: r.name,
        collection: r.collection,
        when: r.when,
        order: r.order ?? 100,
        operations: ops,
        filterCondition,
        condition,
        script,
        broken,
      };
      byTable.set(rule.collection, [...(byTable.get(rule.collection) ?? []), rule]);
    }

    const includes = new Map<string, ScriptInclude>();
    const includeSources = new Map<string, string>();
    for (const inc of includeRows.rows) {
      const script = inc.script ?? '';
      let broken = !script.trim();
      if (!broken) {
        try {
          checkScriptSyntax(script);
        } catch {
          broken = true;
        }
      }
      const entry: ScriptInclude = {
        sysId: inc.sys_id,
        name: inc.name,
        apiName: inc.api_name ?? `global.${inc.name}`,
        script,
        clientCallable: Boolean(inc.client_callable),
        broken,
      };
      includes.set(entry.name, entry);
      if (!broken) includeSources.set(entry.name, entry.script);
    }

    this.rulesByTable = byTable;
    this.includes = includes;
    this.includeSources = includeSources;
    this.version++;
  }

  /** Active rules matching `(table or ancestor, when, operation)` in execution order. */
  matchingRules(table: string, when: RuleWhen, operation: Operation): BusinessRule[] {
    if (!this.meta.hasTable(table)) return [];
    const ancestors = this.meta.ancestors(table).map((t) => t.name);
    const matched: BusinessRule[] = [];
    for (const t of ancestors) {
      for (const r of this.rulesByTable.get(t) ?? []) {
        if (!r.broken && r.when === when && r.operations.has(operation)) matched.push(r);
      }
    }
    matched.sort((a, b) => a.order - b.order || a.sysId.localeCompare(b.sysId));
    return matched;
  }

  /** Run synchronous (`before` or `after`) business rules for a write operation. */
  async runRules(
    engine: DataEngine,
    when: 'before' | 'after',
    operation: Operation,
    table: string,
    current: RecordValues,
    session: Session,
    previous?: RecordValues,
  ): Promise<void> {
    const rules = this.matchingRules(table, when, operation);
    if (!rules.length) return;

    const fields = this.meta.fields(table);
    for (const rule of rules) {
      if (!(await this.shouldRunRule(engine, rule, table, operation, current, session, previous))) continue;

      const mutable = when === 'before' && operation !== 'delete';
      const res = await this.runtime.run(engine, {
        script: rule.script,
        sourceName: `sys_script/${rule.name}.js`,
        session,
        keepElevatedRoles: false,
        current: {
          table,
          values: current,
          isNew: operation === 'insert',
          operation,
          readOnly: !mutable,
        },
        previous: previous ? { table, values: previous } : undefined,
        includes: this.includeSources,
      });
      this.appendLogs(res.logs);

      if (when === 'before' && res.aborted) {
        const errMsgs = res.messages.filter((m) => m.type === 'error').map((m) => m.message);
        throw new ValidationError(errMsgs.length ? errMsgs.join('; ') : `Action aborted by business rule "${rule.name}"`);
      }

      if (mutable && res.pending) {
        for (const [key, val] of Object.entries(res.pending)) {
          const f = fields.get(key);
          if (!f) throw new ValidationError(`Unknown field ${table}.${key} set by business rule "${rule.name}"`);
          if (f.system) continue;
          current[key] = val;
        }
      }
    }
  }

  /**
   * Build a post-commit task for any matching `async` business rules on `(table, operation)`.
   * Returns null when no `async` rules exist for `(table, operation)`.
   */
  buildAsyncTask(
    operation: Operation,
    table: string,
    recordSnapshot: RecordValues,
    session: Session,
  ): ((rootEngine: DataEngine) => Promise<void>) | null {
    const rules = this.matchingRules(table, 'async', operation);
    if (!rules.length) return null;
    const snapshot = { ...recordSnapshot };
    const sysId = String(snapshot.sys_id ?? '');

    return async (rootEngine: DataEngine) => {
      const latest = operation !== 'delete' && sysId ? ((await rootEngine.get(table, sysId)) ?? snapshot) : snapshot;
      for (const rule of rules) {
        try {
          if (!(await this.shouldRunRule(rootEngine, rule, table, operation, latest, session, undefined))) continue;
          const res = await this.runtime.run(rootEngine, {
            script: rule.script,
            sourceName: `sys_script/${rule.name}.async.js`,
            session,
            keepElevatedRoles: false,
            current: {
              table,
              values: latest,
              isNew: false,
              operation,
              readOnly: true,
            },
            includes: this.includeSources,
          });
          this.appendLogs(res.logs);
        } catch (e) {
          this.appendLogs([
            {
              level: 'error',
              message: `Async business rule "${rule.name}" failed: ${(e as Error).message}`,
              source: `sys_script:${rule.name}`,
              timestamp: new Date().toISOString(),
            },
          ]);
        }
      }
    };
  }

  /** Schedule post-commit async tasks in the background. */
  enqueueAsync(tasks: ReadonlyArray<(rootEngine: DataEngine) => Promise<void>>, rootEngine: DataEngine): void {
    for (const task of tasks) {
      const p = Promise.resolve()
        .then(() => task(rootEngine))
        .finally(() => {
          this.inFlightAsync.delete(p);
        });
      this.inFlightAsync.add(p);
    }
  }

  /** Wait for all queued `async` business rules (including transitive ones) to finish. */
  async flush(): Promise<void> {
    while (this.inFlightAsync.size > 0) {
      await Promise.all([...this.inFlightAsync]);
    }
  }

  /**
   * Evaluate a scripted ACL (`sys_security_acl.script`) against `current`.
   * Runs in read-only mode and fails closed (`false`) if the script throws or times out.
   */
  async evalAcl(
    engine: DataEngine,
    table: string,
    current: RecordValues | null,
    script: string,
    session: Session,
    aclName: string,
  ): Promise<boolean> {
    try {
      const res = await this.runtime.run(engine, {
        script,
        sourceName: `sys_security_acl/${aclName}.js`,
        session,
        keepElevatedRoles: false,
        readOnly: true,
        current: current
          ? {
              table,
              values: current,
              readOnly: true,
            }
          : undefined,
        includes: this.includeSources,
      });
      this.appendLogs(res.logs);
      return Boolean(res.answer !== undefined ? res.answer : res.value);
    } catch (e) {
      this.appendLogs([
        {
          level: 'error',
          message: `ACL script "${aclName}" failed: ${(e as Error).message}`,
          source: `sys_security_acl:${aclName}`,
          timestamp: new Date().toISOString(),
        },
      ]);
      return false;
    }
  }

  /** Execute an ad-hoc Background Script (admin only). */
  async evalBackground(
    engine: DataEngine,
    script: string,
    session: Session,
    opts: { timeoutMs?: number } = {},
  ): Promise<ScriptExecResult> {
    if (!engine.acl.isAdmin(session)) {
      throw new ForbiddenError('Only administrators can run background scripts');
    }
    const res = await this.runtime.run(engine, {
      script,
      sourceName: 'background_script.js',
      session,
      keepElevatedRoles: true,
      includes: this.includeSources,
      timeoutMs: opts.timeoutMs,
    });
    this.appendLogs(res.logs);
    return res;
  }

  async close(): Promise<void> {
    await this.flush();
    this.runtime.close();
  }

  private async shouldRunRule(
    engine: DataEngine,
    rule: BusinessRule,
    table: string,
    operation: Operation,
    current: RecordValues,
    session: Session,
    previous?: RecordValues,
  ): Promise<boolean> {
    if (rule.filterCondition) {
      const matched = await matchesRecord(engine, table, current, rule.filterCondition, session);
      if (!matched) return false;
    }
    if (rule.condition) {
      const res = await this.runtime.run(engine, {
        script: rule.condition,
        expression: true,
        sourceName: `sys_script/${rule.name}.condition.js`,
        session,
        keepElevatedRoles: false,
        readOnly: true,
        current: {
          table,
          values: current,
          isNew: operation === 'insert',
          operation,
          readOnly: true,
        },
        previous: previous ? { table, values: previous } : undefined,
        includes: this.includeSources,
      });
      this.appendLogs(res.logs);
      if (!res.value) return false;
    }
    return true;
  }

  private appendLogs(entries: readonly ScriptLogEntry[]): void {
    for (const entry of entries) {
      if (this.recentLogs.length >= MAX_RECENT_LOGS) this.recentLogs.shift();
      this.recentLogs.push(entry);
    }
  }
}
