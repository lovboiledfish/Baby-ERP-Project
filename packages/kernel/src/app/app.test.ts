import { describe, expect, it } from 'vitest';
import { createItsmApp, itsmApp } from '../../../../apps/itsm/src/index';
import { StringColumn, buildAppPackage } from '../../../sdk/src/index';
import { BOOTSTRAP_VERSION, PgliteDb, bootstrapVersion } from '../index';
import { Instance } from '../instance';
import { SYSTEM_SESSION } from '../session';

describe('Phase 6: Scoped Applications, Pro-Code SDK & Update Sets', () => {
  it('bootstraps to v6 with sys_scope and Default sys_update_set seeded', async () => {
    const inst = await Instance.create();
    try {
      expect(await bootstrapVersion(inst.db)).toBe(BOOTSTRAP_VERSION);
      expect(BOOTSTRAP_VERSION).toBe(6);

      const globalScope = inst.apps.getApp('global');
      expect(globalScope).toBeDefined();
      expect(globalScope?.active).toBe(true);

      const updateSets = await inst.engine.query('sys_update_set', {
        query: 'name=Default^state=in_progress',
      });
      expect(updateSets.length).toBe(1);
    } finally {
      await inst.close();
    }
  });

  it('prefixes physical storage columns when a scoped app adds a field to a global table', async () => {
    const inst = await Instance.create();
    try {
      await inst.metaApi.createTable(
        {
          name: 'task',
          label: 'Task',
          extendable: true,
          fields: [{ element: 'short_description', type: 'string', label: 'Short description' }],
        },
        SYSTEM_SESSION,
      );

      const fieldDesc = await inst.metaApi.addField(
        'task',
        {
          element: 'cost_center',
          label: 'Cost Center',
          type: 'string',
          scope: 'x_acme_fin',
        },
        SYSTEM_SESSION,
      );

      expect(fieldDesc.scope).toBe('x_acme_fin');
      expect(fieldDesc.column).toBe('x_acme_fin_cost_center');

      // Writing and reading via logical element name `cost_center` transparently maps to `x_acme_fin_cost_center`
      const rec = await inst.engine.insert(
        'task',
        { short_description: 'Invoice review', cost_center: 'CC-900' },
        SYSTEM_SESSION,
      );
      expect(rec.cost_center).toBe('CC-900');

      const raw = await inst.db.query<{ x_acme_fin_cost_center: string }>(
        `SELECT "x_acme_fin_cost_center" FROM "task" WHERE "sys_id" = $1`,
        [rec.sys_id],
      );
      expect(raw.rows[0]?.x_acme_fin_cost_center).toBe('CC-900');
    } finally {
      await inst.close();
    }
  });

  it('enforces cross-scope table & ScriptInclude access until sys_scope_privilege is granted', async () => {
    const inst = await Instance.create();
    try {
      // Create a global table `incident` and a scoped table `x_acme_sec_alert`
      await inst.metaApi.createTable(
        {
          name: 'incident',
          label: 'Incident',
          scope: 'global',
          fields: [{ element: 'short_description', type: 'string' }],
        },
        SYSTEM_SESSION,
      );
      await inst.engine.insert('incident', { short_description: 'Global outage' }, SYSTEM_SESSION);

      // Global ScriptInclude
      await inst.engine.insert(
        'sys_script_include',
        {
          name: 'GlobalAuditUtil',
          api_name: 'global.GlobalAuditUtil',
          script: `class GlobalAuditUtil { static ping() { return 'pong-from-global'; } } globalThis.GlobalAuditUtil = GlobalAuditUtil;`,
          active: true,
          sys_scope: 'global',
        },
        SYSTEM_SESSION,
      );

      await inst.metaApi.createTable(
        {
          name: 'x_acme_sec_alert',
          label: 'Security Alert',
          scope: 'x_acme_sec',
          fields: [
            { element: 'summary', type: 'string' },
            { element: 'probe_result', type: 'string' },
          ],
        },
        SYSTEM_SESSION,
      );

      // Scoped Business Rule on x_acme_sec_alert that tries to read global `incident`
      const br = await inst.engine.insert(
        'sys_script',
        {
          name: 'CrossScopeReader',
          collection: 'x_acme_sec_alert',
          when: 'before',
          order: 100,
          action_insert: true,
          script: `
            const gr = new GlideRecord('incident');
            gr.query();
            if (gr.next()) {
              current.setValue('probe_result', gr.getValue('short_description'));
            }
          `,
          active: true,
          sys_scope: 'x_acme_sec',
        },
        SYSTEM_SESSION,
      );

      // Without sys_scope_privilege, inserting into x_acme_sec_alert fails with ForbiddenError
      await expect(
        inst.engine.insert('x_acme_sec_alert', { summary: 'Test 1' }, SYSTEM_SESSION),
      ).rejects.toThrow(/Scope "x_acme_sec" is not authorized to read table "incident"/);

      // Grant read privilege on `incident` to `x_acme_sec`
      await inst.engine.insert(
        'sys_scope_privilege',
        {
          source_scope: 'x_acme_sec',
          target_scope: 'global',
          target_name: 'incident',
          target_type: 'sys_db_object',
          operation: 'read',
          status: 'allowed',
          sys_scope: 'x_acme_sec',
        },
        SYSTEM_SESSION,
      );

      const alert1 = await inst.engine.insert('x_acme_sec_alert', { summary: 'Test 2' }, SYSTEM_SESSION);
      expect(alert1.probe_result).toBe('Global outage');

      // Now update the scoped Business Rule to call global ScriptInclude `GlobalAuditUtil`
      await inst.engine.update(
        'sys_script',
        String(br.sys_id),
        {
          script: `current.setValue('probe_result', GlobalAuditUtil.ping());`,
        },
        SYSTEM_SESSION,
      );

      await expect(
        inst.engine.insert('x_acme_sec_alert', { summary: 'Test 3' }, SYSTEM_SESSION),
      ).rejects.toThrow(/Scope "x_acme_sec" is not authorized to execute ScriptInclude "GlobalAuditUtil"/);

      // Grant execute privilege on `GlobalAuditUtil`
      await inst.engine.insert(
        'sys_scope_privilege',
        {
          source_scope: 'x_acme_sec',
          target_scope: 'global',
          target_name: 'GlobalAuditUtil',
          target_type: 'sys_script_include',
          operation: 'execute',
          status: 'allowed',
          sys_scope: 'x_acme_sec',
        },
        SYSTEM_SESSION,
      );

      const alert2 = await inst.engine.insert('x_acme_sec_alert', { summary: 'Test 4' }, SYSTEM_SESSION);
      expect(alert2.probe_result).toBe('pong-from-global');
    } finally {
      await inst.close();
    }
  });

  it('deploys, upgrades (preserving customer customizations), generates .d.ts types, and uninstalls the dogfood ITSM app', async () => {
    const inst = await Instance.create();
    try {
      const jsonManifest = buildAppPackage(itsmApp);
      const parsedManifest = JSON.parse(jsonManifest);
      expect(parsedManifest.scope).toBe('x_steward_itsm');

      // 1. Deploy v1.0.0
      const deploy1 = await inst.apps.deployPackage(inst.engine, itsmApp, SYSTEM_SESSION);
      expect(deploy1.action).toBe('install');
      expect(deploy1.version).toBe('1.0.0');
      expect(deploy1.created).toBeGreaterThan(10);
      expect(deploy1.skippedCustomizations).toEqual([]);

      // Verify table, numbering, ScriptInclude, and BusinessRule work together
      const tkt = await inst.engine.insert(
        'x_steward_itsm_ticket',
        { short_description: 'VPN down', priority: '1' },
        SYSTEM_SESSION,
      );
      expect(String(tkt.number)).toMatch(/^TKT000100\d$/);
      expect(tkt.sys_scope).toBe('x_steward_itsm');
      expect(
        inst.scripts.recentLogs.some((l) => l.message.includes('Critical escalation triggered for TKT')),
      ).toBe(true);

      // 2. Customer modifies the deployed Business Rule outside of package deployment
      const brRows = await inst.engine.query('sys_script', {
        query: 'name=Triage Critical Ticket^collection=x_steward_itsm_ticket',
      });
      expect(brRows.length).toBe(1);
      const brId = String(brRows[0]!.sys_id);

      const customScript = `gs.info('Customer customized triage rule for ' + current.getValue('number'));`;
      await inst.engine.update('sys_script', brId, { script: customScript }, SYSTEM_SESSION);

      // Verify sys_metadata_file flagged customer_modified = true AND sys_update_xml captured the change
      const metaFile = inst.apps.getMetadataFileForRecord('sys_script', brId);
      expect(metaFile?.customerModified).toBe(true);

      const updateXml = await inst.engine.query('sys_update_xml', {
        query: `table_name=sys_script^record_sys_id=${brId}`,
      });
      expect(updateXml.length).toBe(1);
      expect(updateXml[0]?.action).toBe('update');

      // 3. Upgrade app to v1.1.0 adding a new field `resolution_code`
      const itsmV11 = createItsmApp({
        version: '1.1.0',
        extraColumns: {
          resolution_code: StringColumn({ label: 'Resolution Code', maxLength: 80 }),
        },
      });
      const deploy2 = await inst.apps.deployPackage(inst.engine, itsmV11, SYSTEM_SESSION);
      expect(deploy2.action).toBe('upgrade');
      expect(deploy2.version).toBe('1.1.0');
      expect(deploy2.skippedCustomizations).toContain('sys_script:x_steward_itsm_ticket:Triage Critical Ticket');

      // Customer's customized script was NOT overwritten by v1.1.0
      const brAfterUpgrade = await inst.engine.get('sys_script', brId);
      expect(brAfterUpgrade?.script).toBe(customScript);

      // New field `resolution_code` is active on x_steward_itsm_ticket
      expect(inst.meta.fields('x_steward_itsm_ticket').has('resolution_code')).toBe(true);

      // 4. Generate TypeScript .d.ts types for x_steward_itsm
      const dts = inst.apps.generateTypes('x_steward_itsm');
      expect(dts).toContain('export interface XStewardItsmTicketRecord');
      expect(dts).toContain('resolution_code?: string | null;');
      expect(dts).toContain('"1" | "2" | "3" | "4"');

      // 5. Export Update Set
      const defaultSet = (await inst.engine.query('sys_update_set', { query: 'name=Default' }))[0]!;
      const bundle = await inst.apps.exportUpdateSet(inst.engine, String(defaultSet.sys_id), SYSTEM_SESSION);
      expect(bundle.entries.some((e) => e.tableName === 'sys_script' && e.recordSysId === brId)).toBe(true);

      // 6. Uninstall x_steward_itsm: active artifacts removed, fields deactivated, physical table + data retained
      const uninstallRes = await inst.apps.uninstallApp(inst.engine, 'x_steward_itsm', SYSTEM_SESSION);
      expect(uninstallRes.removedArtifacts).toBeGreaterThan(0);
      expect(uninstallRes.deactivatedFields).toBeGreaterThan(0);
      expect(inst.apps.getApp('x_steward_itsm')?.active).toBe(false);

      // Physical table still holds the ticket record!
      const rawTickets = await inst.db.query<{ sys_id: string }>(
        `SELECT "sys_id" FROM "x_steward_itsm_ticket" WHERE "sys_id" = $1`,
        [tkt.sys_id],
      );
      expect(rawTickets.rows.length).toBe(1);
    } finally {
      await inst.close();
    }
  });
});
