import {
  appPackageSchema,
  describeIssues,
  type AppPackage,
  type FieldType,
} from '@steward/shared';
import { createHash } from 'node:crypto';
import type { DataEngine, RecordValues } from '../data/data-engine';
import type { Operation } from '../data/hooks';
import type { Db } from '../db/db';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors';
import type { MetaService } from '../meta/meta-service';
import { SYSTEM_SESSION, withScope, type Session } from '../session';

export interface InstalledApp {
  sysId: string;
  scope: string;
  name: string;
  version: string;
  vendor: string | null;
  description: string | null;
  active: boolean;
}

export interface ScopePrivilege {
  sysId: string;
  sourceScope: string;
  targetScope: string;
  targetName: string;
  targetType: 'sys_db_object' | 'sys_script_include';
  operation: 'read' | 'write' | 'create' | 'delete' | 'execute';
  status: 'allowed' | 'requested' | 'denied';
}

export interface MetadataFileRecord {
  sysId: string;
  scope: string;
  tableName: string;
  recordSysId: string;
  artifactKey: string;
  version: string;
  checksum: string;
  customerModified: boolean;
}

export interface DeployResult {
  scope: string;
  name: string;
  version: string;
  action: 'install' | 'upgrade';
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  skippedCustomizations: string[];
}

export interface UninstallResult {
  scope: string;
  removedArtifacts: number;
  deactivatedFields: number;
}

export interface UpdateSetEntry {
  name: string;
  tableName: string;
  recordSysId: string;
  action: 'insert' | 'update' | 'delete';
  payload: RecordValues;
}

export interface UpdateSetBundle {
  name: string;
  scope: string;
  description?: string | null;
  entries: UpdateSetEntry[];
}

interface ScopeRow {
  sys_id: string;
  scope: string;
  name: string;
  version: string;
  vendor: string | null;
  description: string | null;
  active: boolean | null;
}

interface PrivilegeRow {
  sys_id: string;
  source_scope: string;
  target_scope: string;
  target_name: string;
  target_type: string;
  operation: string;
  status: string;
}

interface MetadataFileRow {
  sys_id: string;
  scope: string;
  table_name: string;
  record_sys_id: string;
  artifact_key: string;
  version: string | null;
  checksum: string | null;
  customer_modified: boolean | null;
}

/**
 * Tables that any scoped script may read for identity/metadata lookup without requiring
 * an explicit `sys_scope_privilege` row.
 */
const ALWAYS_READABLE_GLOBAL_TABLES: ReadonlySet<string> = new Set([
  'sys_user',
  'sys_user_group',
  'sys_user_role',
  'sys_user_grmember',
  'sys_choice',
  'sys_journal_field',
  'sys_scope',
]);

/**
 * Metadata tables whose admin edits are captured into `sys_update_xml` and mark
 * `sys_metadata_file.customer_modified = true` when edited outside package deployment.
 */
export const TRACKED_METADATA_TABLES: ReadonlySet<string> = new Set([
  'sys_db_object',
  'sys_dictionary',
  'sys_choice',
  'sys_user_role',
  'sys_security_acl',
  'sys_security_acl_role',
  'sys_script',
  'sys_script_include',
  'sys_script_client',
  'sys_ui_policy',
  'sys_ui_policy_action',
  'sysevent_email_action',
  'sys_scope_privilege',
  'sys_hub_flow',
  'contract_sla',
]);

/**
 * Deterministic RFC 4122 v5-formatted UUID derived from `(scope, table, artifactKey)`.
 * Ensures the same logical artifact gets the same `sys_id` across instances and upgrades.
 */
export function deterministicSysId(scope: string, table: string, artifactKey: string): string {
  const bytes = Buffer.from(
    createHash('sha256').update(`steward:${scope}:${table}:${artifactKey}`).digest().subarray(0, 16),
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function stableStringify(val: unknown): string {
  if (val === null || val === undefined || typeof val !== 'object') return JSON.stringify(val);
  if (Array.isArray(val)) return `[${val.map(stableStringify).join(',')}]`;
  const entries = Object.entries(val as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function computeChecksum(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/**
 * Manages Scoped Applications (`sys_scope`), Cross-Scope Access Control (`sys_scope_privilege`),
 * Application Package Deployment (`deployPackage` / `uninstallApp`), Update Sets (`sys_update_set`),
 * and TypeScript `.d.ts` schema generation.
 */
export class AppService {
  private apps = new Map<string, InstalledApp>();
  private privileges = new Map<string, ScopePrivilege>();
  private metadataByRecord = new Map<string, MetadataFileRecord>();
  private deployingDepth = 0;
  version = 0;

  constructor(private readonly meta: MetaService) {}

  get isDeploying(): boolean {
    return this.deployingDepth > 0;
  }

  async withDeploymentContext<T>(fn: () => Promise<T>): Promise<T> {
    this.deployingDepth++;
    try {
      return await fn();
    } finally {
      this.deployingDepth--;
    }
  }

  async load(db: Db): Promise<void> {
    if (!this.meta.hasTable('sys_scope')) return;
    const [scopeRes, privRes, metaFileRes] = [
      await db.query<ScopeRow>(
        `SELECT "sys_id", "scope", "name", "version", "vendor", "description", "active" FROM "sys_scope" ORDER BY "scope"`,
      ),
      await db.query<PrivilegeRow>(
        `SELECT "sys_id", "source_scope", "target_scope", "target_name", "target_type", "operation", "status"
           FROM "sys_scope_privilege"`,
      ),
      await db.query<MetadataFileRow>(
        `SELECT "sys_id", "scope", "table_name", "record_sys_id", "artifact_key", "version", "checksum", "customer_modified"
           FROM "sys_metadata_file"`,
      ),
    ];

    const apps = new Map<string, InstalledApp>();
    for (const r of scopeRes.rows) {
      apps.set(r.scope, {
        sysId: r.sys_id,
        scope: r.scope,
        name: r.name,
        version: r.version,
        vendor: r.vendor ?? null,
        description: r.description ?? null,
        active: r.active !== false,
      });
    }

    const privileges = new Map<string, ScopePrivilege>();
    for (const p of privRes.rows) {
      const entry: ScopePrivilege = {
        sysId: p.sys_id,
        sourceScope: p.source_scope,
        targetScope: p.target_scope,
        targetName: p.target_name,
        targetType: p.target_type as ScopePrivilege['targetType'],
        operation: p.operation as ScopePrivilege['operation'],
        status: p.status as ScopePrivilege['status'],
      };
      const key = `${entry.sourceScope}:${entry.targetType}:${entry.targetName}:${entry.operation}`;
      privileges.set(key, entry);
    }

    const metadataByRecord = new Map<string, MetadataFileRecord>();
    for (const m of metaFileRes.rows) {
      metadataByRecord.set(`${m.table_name}:${m.record_sys_id}`, {
        sysId: m.sys_id,
        scope: m.scope,
        tableName: m.table_name,
        recordSysId: m.record_sys_id,
        artifactKey: m.artifact_key,
        version: m.version ?? '1.0.0',
        checksum: m.checksum ?? '',
        customerModified: Boolean(m.customer_modified),
      });
    }

    this.apps = apps;
    this.privileges = privileges;
    this.metadataByRecord = metadataByRecord;
    this.version++;
  }

  listApps(): InstalledApp[] {
    return [...this.apps.values()];
  }

  getApp(scope: string): InstalledApp | undefined {
    return this.apps.get(scope);
  }

  getMetadataFileForRecord(table: string, sysId: string): MetadataFileRecord | undefined {
    return this.metadataByRecord.get(`${table}:${sysId}`);
  }

  hasPrivilege(
    sourceScope: string,
    targetType: 'sys_db_object' | 'sys_script_include',
    targetName: string,
    operation: 'read' | 'write' | 'create' | 'delete' | 'execute',
  ): boolean {
    const exact = this.privileges.get(`${sourceScope}:${targetType}:${targetName}:${operation}`);
    if (exact && exact.status === 'allowed') return true;
    const wildcard = this.privileges.get(`${sourceScope}:${targetType}:*:${operation}`);
    return Boolean(wildcard && wildcard.status === 'allowed');
  }

  /**
   * Enforce cross-scope table access when `session.scope` is a non-global application scope.
   */
  assertTableScopeAccess(
    session: Session,
    table: string,
    operation: 'read' | 'write' | 'create' | 'delete',
  ): void {
    if (this.isDeploying) return;
    const callerScope = session.scope ?? 'global';
    if (callerScope === 'global') return;
    if (!this.meta.hasTable(table)) return;

    const tableMeta = this.meta.getTable(table);
    const targetScope = tableMeta.scope || 'global';
    if (targetScope === callerScope) return;

    if (operation === 'read' && ALWAYS_READABLE_GLOBAL_TABLES.has(table)) return;

    if (this.hasPrivilege(callerScope, 'sys_db_object', table, operation)) return;

    throw new ForbiddenError(
      `Scope "${callerScope}" is not authorized to ${operation} table "${table}" in scope "${targetScope}" (missing sys_scope_privilege)`,
    );
  }

  /**
   * Enforce cross-scope ScriptInclude execution when a script in `sourceScope` loads a ScriptInclude in `targetScope`.
   */
  assertScriptIncludeScopeAccess(
    sourceScope: string | undefined,
    targetScope: string,
    includeName: string,
    apiName: string,
  ): void {
    const callerScope = sourceScope ?? 'global';
    if (callerScope === 'global' || callerScope === targetScope) return;
    if (
      this.hasPrivilege(callerScope, 'sys_script_include', includeName, 'execute') ||
      this.hasPrivilege(callerScope, 'sys_script_include', apiName, 'execute')
    ) {
      return;
    }
    throw new ForbiddenError(
      `Scope "${callerScope}" is not authorized to execute ScriptInclude "${includeName}" in scope "${targetScope}" (missing sys_scope_privilege)`,
    );
  }

  /**
   * Deploy (install or upgrade) a scoped application package transactionally.
   */
  async deployPackage(
    engine: DataEngine,
    input: AppPackage | unknown,
    session: Session = SYSTEM_SESSION,
  ): Promise<DeployResult> {
    if (!session.system && !engine.acl.isAdmin(session)) {
      throw new ForbiddenError('Only administrators can deploy application packages');
    }
    const parsed = appPackageSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError('Invalid application package manifest', describeIssues(parsed.error));
    }
    const pkg = parsed.data;
    const scopeSession = withScope(
      session.system ? session : { ...session, system: true },
      pkg.scope,
    );

    return this.withDeploymentContext(() =>
      engine.transaction(async (tx) => {
        const existingApp = this.apps.get(pkg.scope);
        const action: 'install' | 'upgrade' = existingApp ? 'upgrade' : 'install';

        // 1. Upsert sys_scope row
        const scopeSysId =
          pkg.scope === 'global'
            ? (existingApp?.sysId ?? deterministicSysId('global', 'sys_scope', 'global'))
            : (existingApp?.sysId ?? deterministicSysId(pkg.scope, 'sys_scope', pkg.scope));
        const existingScopeRow = await tx.get('sys_scope', scopeSysId);
        if (existingScopeRow) {
          await tx.update(
            'sys_scope',
            scopeSysId,
            {
              name: pkg.name,
              version: pkg.version,
              vendor: pkg.vendor ?? null,
              description: pkg.description ?? null,
              active: true,
            },
            scopeSession,
            { workflow: false },
          );
        } else {
          await tx.insert(
            'sys_scope',
            {
              sys_id: scopeSysId,
              scope: pkg.scope,
              name: pkg.name,
              version: pkg.version,
              vendor: pkg.vendor ?? null,
              description: pkg.description ?? null,
              active: true,
              sys_scope: pkg.scope,
            },
            scopeSession,
            { workflow: false },
          );
        }

        let created = 0;
        let updated = 0;
        let unchanged = 0;
        let removed = 0;
        const skippedCustomizations: string[] = [];
        const deployedKeys = new Set<string>();

        const upsertArtifact = async (
          table: string,
          artifactKey: string,
          values: RecordValues,
          opts: { immutableOnUpdate?: string[] } = {},
        ): Promise<string> => {
          const trackKey = `${table}:${artifactKey}`;
          deployedKeys.add(trackKey);

          const sysId = deterministicSysId(pkg.scope, table, artifactKey);
          const checksum = computeChecksum(values);

          const metaRows = await tx.query('sys_metadata_file', {
            query: `scope=${pkg.scope}^table_name=${table}^artifact_key=${artifactKey}`,
            limit: 1,
          });
          const metaFile = metaRows[0];
          if (metaFile && metaFile.customer_modified === true) {
            skippedCustomizations.push(trackKey);
            return String(metaFile.record_sys_id ?? sysId);
          }

          const existing = await tx.get(table, sysId);
          if (!existing) {
            await tx.insert(
              table,
              {
                ...values,
                sys_id: sysId,
                sys_scope: pkg.scope,
              },
              scopeSession,
              { workflow: false },
            );
            created++;
          } else if (metaFile && metaFile.checksum === checksum) {
            unchanged++;
          } else {
            const updateVals: RecordValues = { ...values };
            for (const imm of opts.immutableOnUpdate ?? []) {
              delete updateVals[imm];
            }
            await tx.update(table, sysId, updateVals, scopeSession, { workflow: false });
            updated++;
          }

          if (metaFile) {
            await tx.update(
              'sys_metadata_file',
              String(metaFile.sys_id),
              {
                record_sys_id: sysId,
                version: pkg.version,
                checksum,
                customer_modified: false,
              },
              scopeSession,
              { workflow: false },
            );
          } else {
            await tx.insert(
              'sys_metadata_file',
              {
                sys_id: deterministicSysId(pkg.scope, 'sys_metadata_file', trackKey),
                scope: pkg.scope,
                table_name: table,
                record_sys_id: sysId,
                artifact_key: artifactKey,
                version: pkg.version,
                checksum,
                customer_modified: false,
                sys_scope: pkg.scope,
              },
              scopeSession,
              { workflow: false },
            );
          }
          return sysId;
        };

        // Helper to resolve role name -> sys_id
        const resolveRoleId = async (roleName: string): Promise<string> => {
          const rows = await tx.query('sys_user_role', {
            query: `name=${roleName}`,
            fields: ['sys_id'],
            limit: 1,
          });
          if (rows[0]?.sys_id) return String(rows[0].sys_id);
          return upsertArtifact('sys_user_role', roleName, { name: roleName });
        };

        // 2. Roles & role inheritance
        for (const role of pkg.roles ?? []) {
          await upsertArtifact('sys_user_role', role.name, {
            name: role.name,
            description: role.description ?? null,
            elevated_privilege: role.elevatedPrivilege ?? false,
          });
        }
        for (const role of pkg.roles ?? []) {
          if (!role.contains?.length) continue;
          const parentId = await resolveRoleId(role.name);
          for (const childName of role.contains) {
            const childId = await resolveRoleId(childName);
            await upsertArtifact('sys_user_role_contains', `${role.name}->${childName}`, {
              role: parentId,
              contains: childId,
            });
          }
        }

        // 3. Tables & their fields / choices / layouts
        const deployField = async (tableName: string, f: NonNullable<AppPackage['fields']>[number]) => {
          await upsertArtifact(
            'sys_dictionary',
            `${tableName}.${f.element}`,
            {
              name: tableName,
              element: f.element,
              column_label: f.label ?? f.element,
              internal_type: f.type,
              reference: f.reference ?? null,
              max_length: f.maxLength ?? (f.type === 'string' ? 40 : null),
              mandatory: f.mandatory ?? false,
              default_value: f.defaultValue === undefined ? null : String(f.defaultValue),
              display: f.display ?? false,
              read_only: f.readOnly ?? false,
              active: true,
            },
            { immutableOnUpdate: ['name', 'element', 'internal_type', 'reference', 'column_name'] },
          );
          for (const [i, c] of (f.choices ?? []).entries()) {
            await upsertArtifact('sys_choice', `${tableName}.${f.element}.${c.value}`, {
              name: tableName,
              element: f.element,
              value: c.value,
              label: c.label,
              sequence: c.sequence ?? (i + 1) * 100,
              inactive: false,
            });
          }
        };

        for (const tbl of pkg.tables ?? []) {
          let superSysId: string | null = null;
          if (tbl.extends) {
            if (!tx.meta.hasTable(tbl.extends)) {
              throw new ValidationError(`Cannot extend unknown table ${tbl.extends}`);
            }
            superSysId = tx.meta.getTable(tbl.extends).sysId;
          }
          await upsertArtifact(
            'sys_db_object',
            tbl.name,
            {
              name: tbl.name,
              label: tbl.label ?? tbl.name,
              super_class: superSysId,
              is_extendable: tbl.extendable ?? false,
              number_prefix: tbl.numberPrefix ?? null,
              audit: tbl.audit ?? true,
            },
            { immutableOnUpdate: ['name', 'super_class', 'physical_name'] },
          );

          for (const f of tbl.fields ?? []) {
            await deployField(tbl.name, { ...f, table: tbl.name });
          }

          if (tbl.listLayout?.length) {
            await upsertArtifact('sys_ui_list', `${tbl.name}:default`, {
              name: tbl.name,
              view: 'default',
              elements: tbl.listLayout.join(','),
            });
          }

          if (tbl.formSections?.length) {
            const formId = await upsertArtifact('sys_ui_form', `${tbl.name}:default`, {
              name: tbl.name,
              view: 'default',
              related_lists: tbl.relatedLists?.join(',') ?? null,
            });
            for (const [sIdx, sec] of tbl.formSections.entries()) {
              await upsertArtifact(
                'sys_ui_section',
                `${tbl.name}:default:${sIdx}:${sec.caption ?? ''}`,
                {
                  form: formId,
                  caption: sec.caption ?? '',
                  position: sec.position ?? sIdx * 10,
                  elements: sec.elements.join(','),
                },
              );
            }
          }
        }

        // 4. Scoped field extensions on existing tables (e.g. extending `task` or `incident`)
        for (const f of pkg.fields ?? []) {
          await deployField(f.table, f);
        }

        // 5. Cross-scope privileges
        for (const priv of pkg.crossScopePrivileges ?? []) {
          const targetScope =
            priv.targetScope ??
            (priv.targetType === 'sys_db_object' && tx.meta.hasTable(priv.targetName)
              ? tx.meta.getTable(priv.targetName).scope
              : 'global');
          await upsertArtifact(
            'sys_scope_privilege',
            `${priv.targetType}:${priv.targetName}:${priv.operation}`,
            {
              source_scope: pkg.scope,
              target_scope: targetScope,
              target_name: priv.targetName,
              target_type: priv.targetType,
              operation: priv.operation,
              status: priv.status ?? 'allowed',
            },
          );
        }

        // 6. ACLs
        for (const acl of pkg.acls ?? []) {
          const aclKey = acl.key ?? `${acl.name}:${acl.operation}:${(acl.roles ?? []).join(',')}`;
          const aclId = await upsertArtifact('sys_security_acl', aclKey, {
            name: acl.name,
            operation: acl.operation,
            admin_overrides: acl.adminOverrides ?? true,
            condition: acl.condition ?? null,
            script: acl.script ?? null,
            description: acl.description ?? null,
            active: acl.active ?? true,
          });
          for (const roleName of acl.roles ?? []) {
            const roleId = await resolveRoleId(roleName);
            await upsertArtifact('sys_security_acl_role', `${aclKey}->${roleName}`, {
              sys_security_acl: aclId,
              sys_user_role: roleId,
            });
          }
        }

        // 7. Script Includes
        for (const inc of pkg.scriptIncludes ?? []) {
          const apiName = inc.apiName ?? `${pkg.scope}.${inc.name}`;
          await upsertArtifact('sys_script_include', inc.name, {
            name: inc.name,
            api_name: apiName,
            script: inc.script,
            client_callable: inc.clientCallable ?? false,
            description: inc.description ?? null,
            active: inc.active ?? true,
          });
        }

        // 8. Business Rules
        for (const br of pkg.businessRules ?? []) {
          await upsertArtifact('sys_script', `${br.table}:${br.name}`, {
            name: br.name,
            collection: br.table,
            when: br.when,
            order: br.order ?? 100,
            action_insert: br.actionInsert ?? true,
            action_update: br.actionUpdate ?? false,
            action_delete: br.actionDelete ?? false,
            filter_condition: br.filterCondition ?? null,
            condition: br.condition ?? null,
            script: br.script,
            active: br.active ?? true,
          });
        }

        // 9. Client Scripts
        for (const cs of pkg.clientScripts ?? []) {
          await upsertArtifact('sys_script_client', `${cs.table}:${cs.name}`, {
            name: cs.name,
            table: cs.table,
            type: cs.type,
            field_name: cs.fieldName ?? null,
            order: cs.order ?? 100,
            script: cs.script,
            active: cs.active ?? true,
          });
        }

        // 10. UI Policies & Actions
        for (const up of pkg.uiPolicies ?? []) {
          const policyId = await upsertArtifact('sys_ui_policy', `${up.table}:${up.shortDescription}`, {
            short_description: up.shortDescription,
            table: up.table,
            conditions: up.conditions ?? null,
            on_load: up.onLoad ?? true,
            reverse_if_false: up.reverseIfFalse ?? true,
            order: up.order ?? 100,
            active: up.active ?? true,
          });
          for (const act of up.actions ?? []) {
            const toChoice = (val: string | undefined) => (val === 'leave' || !val ? 'ignore' : val);
            await upsertArtifact(
              'sys_ui_policy_action',
              `${up.table}:${up.shortDescription}:${act.fieldName}`,
              {
                ui_policy: policyId,
                field: act.fieldName,
                mandatory: toChoice(act.mandatory),
                visible: toChoice(act.visible),
                disabled: toChoice(act.disabled),
              },
            );
          }
        }

        // 11. Email Notifications
        for (const notif of pkg.emailNotifications ?? []) {
          await upsertArtifact('sysevent_email_action', notif.name, {
            name: notif.name,
            collection: notif.table,
            when_to_send: notif.whenToSend ?? 'record',
            action_insert: notif.actionInsert ?? true,
            action_update: notif.actionUpdate ?? false,
            event_name: notif.eventName ?? null,
            filter_condition: notif.filterCondition ?? null,
            condition: notif.condition ?? null,
            recipient_fields: notif.recipientFields?.join(', ') ?? null,
            recipient_users: notif.recipientUsers?.join(', ') ?? null,
            event_parm_1: notif.eventParm1 ?? false,
            subject: notif.subject,
            message_text: notif.messageText,
            active: notif.active ?? true,
          });
        }

        // 12. Flows (`sys_hub_flow`)
        for (const flow of pkg.flows ?? []) {
          await upsertArtifact('sys_hub_flow', flow.name, {
            name: flow.name,
            description: flow.description ?? null,
            trigger_type: flow.triggerType,
            table: flow.table ?? null,
            event_name: flow.eventName ?? null,
            condition: flow.condition ?? null,
            run_as: flow.runAs ?? 'system',
            steps: flow.steps,
            active: flow.active ?? true,
          });
        }

        // 13. SLAs (`contract_sla`)
        for (const sla of pkg.slas ?? []) {
          await upsertArtifact('contract_sla', sla.name, {
            name: sla.name,
            collection: sla.table,
            duration_seconds: sla.durationSeconds,
            start_condition: sla.startCondition,
            pause_condition: sla.pauseCondition ?? null,
            stop_condition: sla.stopCondition,
            reset_condition: sla.resetCondition ?? null,
            active: sla.active ?? true,
          });
        }

        // 14. Prune obsolete artifacts from previous versions of this scope
        const allScopeMeta = await tx.query('sys_metadata_file', {
          query: `scope=${pkg.scope}`,
        });
        for (const m of allScopeMeta) {
          const tName = String(m.table_name);
          const aKey = String(m.artifact_key);
          const recId = String(m.record_sys_id);
          const trackKey = `${tName}:${aKey}`;
          if (deployedKeys.has(trackKey)) continue;
          if (m.customer_modified === true) {
            skippedCustomizations.push(trackKey);
            continue;
          }
          if (tName === 'sys_db_object') continue;
          if (tName === 'sys_dictionary') {
            const existingDict = await tx.get('sys_dictionary', recId);
            if (existingDict && existingDict.active !== false) {
              await tx.update('sys_dictionary', recId, { active: false }, scopeSession, { workflow: false });
            }
          } else {
            const existingRec = await tx.get(tName, recId);
            if (existingRec) {
              await tx.delete(tName, recId, scopeSession, { workflow: false });
            }
          }
          await tx.delete('sys_metadata_file', String(m.sys_id), scopeSession, { workflow: false });
          removed++;
        }

        // 15. Record deployment history in sys_app_version
        await tx.insert(
          'sys_app_version',
          {
            scope: pkg.scope,
            version: pkg.version,
            action,
            manifest: pkg as unknown as Record<string, unknown>,
            installed_by: session.userName,
            installed_on: new Date().toISOString(),
            sys_scope: pkg.scope,
          },
          scopeSession,
          { workflow: false },
        );

        await this.reloadAllCaches(tx);

        return {
          scope: pkg.scope,
          name: pkg.name,
          version: pkg.version,
          action,
          created,
          updated,
          unchanged,
          removed,
          skippedCustomizations,
        };
      }),
    );
  }

  /**
   * Uninstall a scoped application: removes active scripts, rules, ACLs, flows, SLAs,
   * and privileges while preserving physical tables and columns (`active = false`).
   */
  async uninstallApp(
    engine: DataEngine,
    scope: string,
    session: Session = SYSTEM_SESSION,
  ): Promise<UninstallResult> {
    if (!session.system && !engine.acl.isAdmin(session)) {
      throw new ForbiddenError('Only administrators can uninstall applications');
    }
    if (scope === 'global') {
      throw new ValidationError('The global scope cannot be uninstalled');
    }
    const app = this.apps.get(scope);
    if (!app) {
      throw new NotFoundError(`Application scope "${scope}" is not installed`);
    }

    const scopeSession = withScope(
      session.system ? session : { ...session, system: true },
      scope,
    );

    return this.withDeploymentContext(() =>
      engine.transaction(async (tx) => {
        const metaFiles = await tx.query('sys_metadata_file', {
          query: `scope=${scope}`,
        });

        let removedArtifacts = 0;
        let deactivatedFields = 0;

        const DELETABLE_TABLES = new Set([
          'sys_security_acl_role',
          'sys_security_acl',
          'sys_script',
          'sys_script_include',
          'sys_script_client',
          'sys_ui_policy_action',
          'sys_ui_policy',
          'sysevent_email_action',
          'sys_scope_privilege',
          'sys_hub_flow',
          'contract_sla',
          'sys_user_role_contains',
          'sys_ui_list',
          'sys_ui_section',
          'sys_ui_form',
        ]);

        // Delete child/link tables first before parent records
        const sortedFiles = [...metaFiles].sort((a, b) => {
          const priority = (t: string) =>
            t === 'sys_security_acl_role' || t === 'sys_ui_policy_action' || t === 'sys_user_role_contains'
              ? 0
              : 1;
          return priority(String(a.table_name)) - priority(String(b.table_name));
        });

        for (const m of sortedFiles) {
          const tName = String(m.table_name);
          const recId = String(m.record_sys_id);
          if (tName === 'sys_dictionary') {
            const dict = await tx.get('sys_dictionary', recId);
            if (dict && dict.active !== false) {
              await tx.update('sys_dictionary', recId, { active: false }, scopeSession, { workflow: false });
              deactivatedFields++;
            }
          } else if (DELETABLE_TABLES.has(tName)) {
            const existing = await tx.get(tName, recId);
            if (existing) {
              await tx.delete(tName, recId, scopeSession, { workflow: false });
              removedArtifacts++;
            }
          }
          await tx.delete('sys_metadata_file', String(m.sys_id), scopeSession, { workflow: false });
        }

        await tx.update('sys_scope', app.sysId, { active: false }, scopeSession, { workflow: false });

        await tx.insert(
          'sys_app_version',
          {
            scope,
            version: app.version,
            action: 'uninstall',
            manifest: null,
            installed_by: session.userName,
            installed_on: new Date().toISOString(),
            sys_scope: scope,
          },
          scopeSession,
          { workflow: false },
        );

        await this.reloadAllCaches(tx);

        return {
          scope,
          removedArtifacts,
          deactivatedFields,
        };
      }),
    );
  }

  /**
   * Capture a customer/admin metadata edit into the active Update Set and mark any
   * package-tracked `sys_metadata_file` entry as `customer_modified = true`.
   */
  async captureMetadataChange(
    engine: DataEngine,
    operation: Operation,
    table: string,
    current: RecordValues,
    session: Session,
  ): Promise<void> {
    if (this.isDeploying) return;
    if (!TRACKED_METADATA_TABLES.has(table)) return;
    if (!this.meta.hasTable('sys_metadata_file') || !this.meta.hasTable('sys_update_set')) return;

    const sysId = String(current.sys_id ?? '');
    if (!sysId) return;

    await this.withDeploymentContext(async () => {
      // 1. If this record belongs to a deployed package, mark customer_modified = true
      const tracked = await engine.query('sys_metadata_file', {
        query: `table_name=${table}^record_sys_id=${sysId}`,
        limit: 1,
      });
      if (tracked[0] && tracked[0].customer_modified !== true) {
        await engine.update(
          'sys_metadata_file',
          String(tracked[0].sys_id),
          { customer_modified: true },
          SYSTEM_SESSION,
          { workflow: false },
        );
        const cached = this.metadataByRecord.get(`${table}:${sysId}`);
        if (cached) cached.customerModified = true;
      }

      // 2. Record in the active `in_progress` Update Set
      const recordScope = String(
        tracked[0]?.scope ?? current.sys_scope ?? session.scope ?? 'global',
      );
      let updateSets = await engine.query('sys_update_set', {
        query: `state=in_progress^scope=${recordScope}`,
        limit: 1,
      });
      if (!updateSets.length) {
        updateSets = await engine.query('sys_update_set', {
          query: `state=in_progress`,
          limit: 1,
        });
      }
      const activeSet = updateSets[0];
      if (!activeSet?.sys_id) return;

      const updateName = `${table}_${sysId}`;
      const existingXml = await engine.query('sys_update_xml', {
        query: `update_set=${String(activeSet.sys_id)}^name=${updateName}`,
        limit: 1,
      });

      const payload: RecordValues = { ...current };
      if (existingXml[0]?.sys_id) {
        await engine.update(
          'sys_update_xml',
          String(existingXml[0].sys_id),
          {
            action: operation,
            payload,
          },
          SYSTEM_SESSION,
          { workflow: false },
        );
      } else {
        await engine.insert(
          'sys_update_xml',
          {
            name: updateName,
            update_set: String(activeSet.sys_id),
            table_name: table,
            record_sys_id: sysId,
            action: operation,
            payload,
            sys_scope: recordScope,
          },
          SYSTEM_SESSION,
          { workflow: false },
        );
      }
    });
  }

  /** Export an Update Set (`sys_update_set` + its `sys_update_xml` entries) as a portable JSON bundle. */
  async exportUpdateSet(
    engine: DataEngine,
    updateSetSysId: string,
    session: Session = SYSTEM_SESSION,
  ): Promise<UpdateSetBundle> {
    if (!session.system && !engine.acl.isAdmin(session)) {
      throw new ForbiddenError('Only administrators can export update sets');
    }
    const setRow = await engine.get('sys_update_set', updateSetSysId);
    if (!setRow) throw new NotFoundError(`Update set ${updateSetSysId} not found`);

    const xmlRows = await engine.query('sys_update_xml', {
      query: `update_set=${updateSetSysId}^ORDERBYsys_created_on`,
    });

    return {
      name: String(setRow.name ?? 'Default'),
      scope: String(setRow.scope ?? 'global'),
      description: setRow.description != null ? String(setRow.description) : null,
      entries: xmlRows.map((r) => ({
        name: String(r.name),
        tableName: String(r.table_name),
        recordSysId: String(r.record_sys_id),
        action: (r.action as 'insert' | 'update' | 'delete') ?? 'update',
        payload: (r.payload as RecordValues) ?? {},
      })),
    };
  }

  /** Apply an exported Update Set bundle transactionally. */
  async applyUpdateSet(
    engine: DataEngine,
    bundle: UpdateSetBundle,
    session: Session = SYSTEM_SESSION,
  ): Promise<{ applied: number }> {
    if (!session.system && !engine.acl.isAdmin(session)) {
      throw new ForbiddenError('Only administrators can apply update sets');
    }
    return this.withDeploymentContext(() =>
      engine.transaction(async (tx) => {
        let applied = 0;
        for (const entry of bundle.entries ?? []) {
          const { tableName, recordSysId, action, payload } = entry;
          if (!tx.meta.hasTable(tableName)) continue;
          const existing = await tx.get(tableName, recordSysId);
          if (action === 'delete') {
            if (existing) {
              await tx.delete(tableName, recordSysId, SYSTEM_SESSION, { workflow: false });
              applied++;
            }
          } else if (!existing) {
            await tx.insert(
              tableName,
              { ...payload, sys_id: recordSysId },
              SYSTEM_SESSION,
              { workflow: false },
            );
            applied++;
          } else {
            const updateVals: RecordValues = { ...payload };
            delete updateVals.sys_id;
            delete updateVals.sys_created_on;
            delete updateVals.sys_created_by;
            delete updateVals.sys_updated_on;
            delete updateVals.sys_updated_by;
            delete updateVals.sys_mod_count;
            await tx.update(tableName, recordSysId, updateVals, SYSTEM_SESSION, { workflow: false });
            applied++;
          }
        }
        await this.reloadAllCaches(tx);
        return { applied };
      }),
    );
  }

  /**
   * Generate TypeScript `.d.ts` definitions from the live dictionary (`sys_db_object` + `sys_dictionary`).
   * Optionally filter to tables owned by or extended in `scope` (plus core base tables).
   */
  generateTypes(scope?: string): string {
    const tables = this.meta.listTables().filter((t) => {
      if (!scope || scope === 'global') return true;
      if (t.scope === scope) return true;
      for (const f of t.ownFields.values()) {
        if (f.scope === scope) return true;
      }
      return t.name === 'task' || t.name === 'sys_user' || t.name === 'sys_user_group';
    });

    const tsTypeFor = (type: FieldType, choices: Array<{ value: string }>): string => {
      if (type === 'choice' && choices.length > 0) {
        return choices.map((c) => JSON.stringify(c.value)).join(' | ');
      }
      switch (type) {
        case 'integer':
        case 'decimal':
          return 'number';
        case 'boolean':
          return 'boolean';
        case 'json':
          return 'Record<string, unknown>';
        default:
          return 'string';
      }
    };

    const pascal = (s: string): string =>
      s
        .split('_')
        .filter(Boolean)
        .map((p) => p[0]!.toUpperCase() + p.slice(1))
        .join('');

    const lines: string[] = [
      '// Auto-generated by Steward TypeScript SDK (`steward types`) — DO NOT EDIT',
      '',
    ];

    for (const t of tables) {
      const ifaceName = `${pascal(t.name)}Record`;
      lines.push(`/** Table: \`${t.name}\` (${t.label}) — Scope: \`${t.scope}\` */`);
      lines.push(`export interface ${ifaceName} {`);
      for (const f of this.meta.fields(t.name).values()) {
        const tsType = tsTypeFor(f.type, f.choices);
        const nullable = f.system && f.element === 'sys_id' ? '' : ' | null';
        lines.push(`  /** ${f.label} (${f.type}${f.reference ? ` -> ${f.reference}` : ''}) */`);
        lines.push(`  ${f.element}${f.mandatory || f.system ? '' : '?'}: ${tsType}${nullable};`);
      }
      lines.push('}');
      lines.push('');
    }

    lines.push('export interface StewardTableMap {');
    for (const t of tables) {
      lines.push(`  ${JSON.stringify(t.name)}: ${pascal(t.name)}Record;`);
    }
    lines.push('}');
    lines.push('');
    return lines.join('\n');
  }

  private async reloadAllCaches(engine: DataEngine): Promise<void> {
    await engine.meta.load(engine.db);
    await engine.acl.load(engine.db);
    if (engine.scripts) await engine.scripts.load(engine.db);
    if (engine.events) await engine.events.load(engine.db);
    if (engine.flows) await engine.flows.load(engine.db);
    if (engine.slas) await engine.slas.load(engine.db);
    await this.load(engine.db);
  }
}
