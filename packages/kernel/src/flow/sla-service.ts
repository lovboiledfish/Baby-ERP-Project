import { EncodedQueryError, parseEncodedQuery, type QueryAst } from '@steward/shared';
import type { DataEngine, RecordValues } from '../data/data-engine';
import type { Operation } from '../data/hooks';
import type { Db } from '../db/db';
import type { MetaService } from '../meta/meta-service';
import { matchesRecord } from '../script/match-record';
import { SYSTEM_SESSION } from '../session';

export interface SlaDefinition {
  sysId: string;
  name: string;
  collection: string;
  durationSeconds: number;
  startCondition: QueryAst | null;
  pauseCondition: QueryAst | null;
  stopCondition: QueryAst | null;
  resetCondition: QueryAst | null;
  scope: string;
  broken: boolean;
}

interface SlaRow {
  sys_id: string;
  name: string;
  collection: string;
  duration_seconds: number | null;
  start_condition: string | null;
  pause_condition: string | null;
  stop_condition: string | null;
  reset_condition: string | null;
  sys_scope: string | null;
}

/**
 * SLA Engine (`contract_sla`, `task_sla`).
 *
 * Evaluates start, pause, resume, stop, and reset conditions on record writes,
 * shifts `planned_end_time` by accumulated pause durations on resume, and evaluates
 * timer breaches during worker ticks (emitting `sla.breached` events).
 */
export class SlaService {
  private slasByTable = new Map<string, SlaDefinition[]>();
  version = 0;

  constructor(private readonly meta: MetaService) {}

  async load(db: Db): Promise<void> {
    if (!this.meta.hasTable('contract_sla')) return;
    const res = await db.query<SlaRow>(
      `SELECT "sys_id", "name", "collection", "duration_seconds", "start_condition",
              "pause_condition", "stop_condition", "reset_condition", "sys_scope"
         FROM "contract_sla"
        WHERE "active" IS NOT FALSE
        ORDER BY "sys_created_on" ASC, "sys_id" ASC`,
    );

    const parseCond = (raw: string | null): { ast: QueryAst | null; broken: boolean } => {
      if (!raw || !raw.trim()) return { ast: null, broken: false };
      try {
        const ast = parseEncodedQuery(raw);
        return { ast: ast.groups.length > 0 ? ast : null, broken: false };
      } catch (e) {
        if (!(e instanceof EncodedQueryError)) throw e;
        return { ast: null, broken: true };
      }
    };

    const byTable = new Map<string, SlaDefinition[]>();
    for (const r of res.rows) {
      const start = parseCond(r.start_condition);
      const pause = parseCond(r.pause_condition);
      const stop = parseCond(r.stop_condition);
      const reset = parseCond(r.reset_condition);
      const durationSeconds = Math.max(1, r.duration_seconds ?? 3600);
      const broken =
        !r.collection?.trim() ||
        !start.ast ||
        !stop.ast ||
        start.broken ||
        pause.broken ||
        stop.broken ||
        reset.broken;

      const def: SlaDefinition = {
        sysId: r.sys_id,
        name: r.name,
        collection: r.collection,
        durationSeconds,
        startCondition: start.ast,
        pauseCondition: pause.ast,
        stopCondition: stop.ast,
        resetCondition: reset.ast,
        scope: r.sys_scope ?? 'global',
        broken,
      };
      byTable.set(def.collection, [...(byTable.get(def.collection) ?? []), def]);
    }

    this.slasByTable = byTable;
    this.version++;
  }

  matchingSlas(table: string): SlaDefinition[] {
    if (!this.meta.hasTable(table)) return [];
    const ancestors = this.meta.ancestors(table).map((t) => t.name);
    const out: SlaDefinition[] = [];
    for (const t of ancestors) {
      for (const s of this.slasByTable.get(t) ?? []) {
        if (!s.broken) out.push(s);
      }
    }
    return out;
  }

  /**
   * Evaluate all active `contract_sla` definitions for `(table, current)` on record insert/update.
   */
  async onRecordWrite(
    engine: DataEngine,
    operation: Operation,
    table: string,
    current: RecordValues,
    now: Date = new Date(),
  ): Promise<void> {
    if (operation !== 'insert' && operation !== 'update') return;
    if (table === 'task_sla' || table === 'contract_sla') return;
    const slas = this.matchingSlas(table);
    if (!slas.length) return;

    const taskId = String(current.sys_id ?? '');
    if (!taskId) return;
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    for (const sla of slas) {
      const startMatch = sla.startCondition
        ? await matchesRecord(engine, table, current, sla.startCondition, SYSTEM_SESSION)
        : false;
      const pauseMatch = sla.pauseCondition
        ? await matchesRecord(engine, table, current, sla.pauseCondition, SYSTEM_SESSION)
        : false;
      const stopMatch = sla.stopCondition
        ? await matchesRecord(engine, table, current, sla.stopCondition, SYSTEM_SESSION)
        : false;
      const resetMatch = sla.resetCondition
        ? await matchesRecord(engine, table, current, sla.resetCondition, SYSTEM_SESSION)
        : false;

      const existingRows = await engine.query('task_sla', {
        query: `task=${taskId}^sla=${sla.sysId}^active=true`,
        limit: 1,
      });
      const existing = existingRows[0];

      if (existing) {
        const existingId = String(existing.sys_id);
        const startTimeMs = existing.start_time ? new Date(String(existing.start_time)).getTime() : nowMs;
        const plannedEndMs = existing.planned_end_time
          ? new Date(String(existing.planned_end_time)).getTime()
          : startTimeMs + sla.durationSeconds * 1000;
        const pauseDurationSec = Number(existing.pause_duration ?? 0);

        if (stopMatch) {
          // Calculate final pause & business duration
          let finalPauseSec = pauseDurationSec;
          if (existing.stage === 'paused' && existing.pause_time) {
            const pausedAtMs = new Date(String(existing.pause_time)).getTime();
            finalPauseSec += Math.max(0, Math.round((nowMs - pausedAtMs) / 1000));
          }
          const totalElapsedSec = Math.max(
            0,
            Math.round((nowMs - startTimeMs) / 1000) - finalPauseSec,
          );
          const pct = Math.min(999, Math.round((totalElapsedSec / sla.durationSeconds) * 100 * 10) / 10);
          const breached = Boolean(existing.has_breached) || nowMs > plannedEndMs;

          await engine.update(
            'task_sla',
            existingId,
            {
              stage: breached ? 'breached' : 'completed',
              active: false,
              end_time: nowIso,
              pause_time: null,
              pause_duration: finalPauseSec,
              business_duration: totalElapsedSec,
              percentage: pct,
              has_breached: breached,
            },
            SYSTEM_SESSION,
            { workflow: false },
          );
          continue;
        }

        if (resetMatch) {
          await engine.update(
            'task_sla',
            existingId,
            {
              stage: 'cancelled',
              active: false,
              end_time: nowIso,
              pause_time: null,
            },
            SYSTEM_SESSION,
            { workflow: false },
          );
          if (startMatch) {
            await this.attachNewSla(engine, sla, table, taskId, pauseMatch, nowMs, nowIso);
          }
          continue;
        }

        if (!startMatch && !pauseMatch) {
          // Condition no longer applies (e.g. priority downgraded before completion)
          await engine.update(
            'task_sla',
            existingId,
            {
              stage: 'cancelled',
              active: false,
              end_time: nowIso,
              pause_time: null,
            },
            SYSTEM_SESSION,
            { workflow: false },
          );
          continue;
        }

        if (pauseMatch && existing.stage === 'in_progress') {
          const totalElapsedSec = Math.max(
            0,
            Math.round((nowMs - startTimeMs) / 1000) - pauseDurationSec,
          );
          const pct = Math.min(999, Math.round((totalElapsedSec / sla.durationSeconds) * 100 * 10) / 10);
          await engine.update(
            'task_sla',
            existingId,
            {
              stage: 'paused',
              pause_time: nowIso,
              business_duration: totalElapsedSec,
              percentage: pct,
            },
            SYSTEM_SESSION,
            { workflow: false },
          );
          continue;
        }

        if (!pauseMatch && existing.stage === 'paused') {
          const pausedAtMs = existing.pause_time ? new Date(String(existing.pause_time)).getTime() : nowMs;
          const deltaPauseSec = Math.max(0, Math.round((nowMs - pausedAtMs) / 1000));
          const newPauseDurationSec = pauseDurationSec + deltaPauseSec;
          const newPlannedEndIso = new Date(plannedEndMs + deltaPauseSec * 1000).toISOString();

          await engine.update(
            'task_sla',
            existingId,
            {
              stage: 'in_progress',
              pause_time: null,
              pause_duration: newPauseDurationSec,
              planned_end_time: newPlannedEndIso,
            },
            SYSTEM_SESSION,
            { workflow: false },
          );
        }
      } else if (startMatch && !stopMatch) {
        await this.attachNewSla(engine, sla, table, taskId, pauseMatch, nowMs, nowIso);
      }
    }
  }

  /**
   * Evaluate all active `in_progress` `task_sla` records as of `now`, updating their
   * elapsed duration / percentage and marking any overdue timers as `breached`
   * (emitting an `sla.breached` event).
   */
  async evaluateBreaches(engine: DataEngine, now: Date = new Date()): Promise<number> {
    if (!this.meta.hasTable('task_sla')) return 0;
    const activeRows = await engine.query('task_sla', {
      query: `active=true^stage=in_progress`,
    });
    if (!activeRows.length) return 0;

    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    let breachedCount = 0;

    for (const row of activeRows) {
      const sysId = String(row.sys_id);
      const startTimeMs = row.start_time ? new Date(String(row.start_time)).getTime() : nowMs;
      const plannedEndMs = row.planned_end_time ? new Date(String(row.planned_end_time)).getTime() : nowMs;
      const pauseDurationSec = Number(row.pause_duration ?? 0);
      const totalDurationSec = Math.max(1, Math.round((plannedEndMs - startTimeMs) / 1000) - pauseDurationSec);
      const elapsedSec = Math.max(0, Math.round((nowMs - startTimeMs) / 1000) - pauseDurationSec);
      const pct = Math.min(999, Math.round((elapsedSec / totalDurationSec) * 100 * 10) / 10);

      if (nowMs >= plannedEndMs && row.has_breached !== true) {
        breachedCount++;
        await engine.update(
          'task_sla',
          sysId,
          {
            stage: 'breached',
            has_breached: true,
            business_duration: elapsedSec,
            percentage: Math.max(100, pct),
          },
          SYSTEM_SESSION,
          { workflow: false },
        );

        await engine.insert(
          'sys_event',
          {
            name: 'sla.breached',
            table: typeof row.task_table === 'string' && row.task_table ? row.task_table : 'task_sla',
            instance: typeof row.task === 'string' && row.task ? row.task : sysId,
            parm1: sysId,
            parm2: String(row.sla ?? ''),
            state: 'ready',
            claimed_by: 'system',
            sys_scope: String(row.sys_scope ?? 'global'),
          },
          SYSTEM_SESSION,
          { workflow: false },
        );
      } else {
        await engine.update(
          'task_sla',
          sysId,
          {
            business_duration: elapsedSec,
            percentage: pct,
          },
          SYSTEM_SESSION,
          { workflow: false },
        );
      }
    }

    return breachedCount;
  }

  private async attachNewSla(
    engine: DataEngine,
    sla: SlaDefinition,
    table: string,
    taskId: string,
    paused: boolean,
    nowMs: number,
    nowIso: string,
  ): Promise<void> {
    const plannedEndIso = new Date(nowMs + sla.durationSeconds * 1000).toISOString();
    await engine.insert(
      'task_sla',
      {
        task: taskId,
        task_table: table,
        sla: sla.sysId,
        stage: paused ? 'paused' : 'in_progress',
        start_time: nowIso,
        planned_end_time: plannedEndIso,
        pause_time: paused ? nowIso : null,
        pause_duration: 0,
        business_duration: 0,
        percentage: 0,
        has_breached: false,
        active: true,
        sys_scope: sla.scope,
      },
      SYSTEM_SESSION,
      { workflow: false },
    );
  }
}
