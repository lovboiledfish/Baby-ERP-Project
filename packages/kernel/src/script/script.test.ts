import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOOTSTRAP_VERSION, bootstrap, bootstrapVersion } from '../bootstrap/system-tables';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { Instance } from '../instance';
import { systemSession, type Session } from '../session';

const sys = systemSession('setup');
let inst: Instance;
const ids: Record<string, string> = {};
const s: Record<string, Session> = {};

async function insert(table: string, values: Record<string, unknown>, session: Session = sys): Promise<string> {
  return String((await inst.engine.insert(table, values, session)).sys_id);
}

beforeAll(async () => {
  inst = await Instance.create({
    adminPassword: 'admin-pw',
    script: { timeoutMs: 500, memoryLimitMb: 32, maxHostCalls: 200 },
  });

  await inst.metaApi.createTable(
    {
      name: 'task',
      extendable: true,
      fields: [
        { element: 'short_description', type: 'string', maxLength: 160, mandatory: true, display: true },
        { element: 'priority', type: 'integer', defaultValue: 5 },
        {
          element: 'state',
          type: 'choice',
          defaultValue: 'new',
          choices: [
            { value: 'new', label: 'New' },
            { value: 'in_progress', label: 'In Progress' },
            { value: 'closed', label: 'Closed' },
          ],
        },
        { element: 'assigned_to', type: 'reference', reference: 'sys_user' },
        { element: 'work_notes', type: 'journal' },
      ],
    },
    sys,
  );

  await inst.metaApi.createTable(
    {
      name: 'incident',
      extends: 'task',
      numberPrefix: 'INC',
      fields: [
        { element: 'impact', type: 'integer', defaultValue: 3 },
        { element: 'urgency', type: 'integer', defaultValue: 3 },
        { element: 'caller', type: 'reference', reference: 'sys_user' },
        { element: 'secret_notes', type: 'string' },
      ],
    },
    sys,
  );

  for (const r of await inst.engine.query('sys_user_role', { fields: ['sys_id', 'name'] })) {
    ids[`role:${String(r.name)}`] = String(r.sys_id);
  }
  ids['role:itil'] = await insert('sys_user_role', { name: 'itil' });
  ids['role:triage'] = await insert('sys_user_role', { name: 'triage' });

  ids.netGroup = await insert('sys_user_group', { name: 'Network Support' });

  ids.alice = await insert('sys_user', { user_name: 'alice', first_name: 'Alice', last_name: 'Agent', user_password: 'pw' });
  ids.bob = await insert('sys_user', { user_name: 'bob', first_name: 'Bob', last_name: 'Caller', user_password: 'pw' });
  ids.admin2 = await insert('sys_user', { user_name: 'admin2', first_name: 'Second', last_name: 'Admin', user_password: 'pw' });

  await insert('sys_user_has_role', { user: ids.alice, role: ids['role:itil'] });
  await insert('sys_user_has_role', { user: ids.admin2, role: ids['role:admin'] });
  await insert('sys_user_grmember', { user: ids.alice, group: ids.netGroup });

  // Base ACLs on task/incident: itil can read/create/write tasks, priority field is not directly writable by itil.
  const acl = async (name: string, operation: string, roles: string[], extra: Record<string, unknown> = {}) => {
    const id = await insert('sys_security_acl', { name, operation, ...extra });
    for (const r of roles) await insert('sys_security_acl_role', { sys_security_acl: id, sys_user_role: ids[`role:${r}`] });
    return id;
  };
  await acl('task', 'read', ['itil']);
  await acl('task', 'create', ['itil']);
  await acl('task', 'write', ['itil']);
  await acl('task.priority', 'write', ['triage']);

  for (const name of ['admin', 'alice', 'bob', 'admin2']) {
    s[name] = await inst.sessionFor(name);
  }
});

afterAll(async () => {
  await inst.close();
});

describe('sandbox runtime, gs, GlideDateTime, and Script Includes', () => {
  it('exposes gs user/group/role/property/logging helpers and GlideDateTime', async () => {
    const res = await inst.scripts.evalBackground(
      inst.engine,
      `
        gs.info('user=' + gs.getUserName() + ' (' + gs.getUserDisplayName() + ')');
        gs.warn('warn message');
        gs.log('custom log', 'test-source');
        gs.addInfoMessage('hello info');
        gs.addErrorMessage('hello error');
        gs.setProperty('x.test.greeting', 'howdy', 'test prop');

        const u = gs.getUser();
        const dt = new GlideDateTime('2026-01-01T00:00:00.000Z');
        dt.addDaysUTC(2);
        dt.addSeconds(60);

        ({
          userId: gs.getUserID(),
          hasAdmin: gs.hasRole('admin'),
          hasSecurityAdmin: u.hasRole('security_admin'),
          prop: gs.getProperty('x.test.greeting'),
          fallbackProp: gs.getProperty('x.test.missing', 'default-val'),
          nilEmpty: gs.nil(''),
          nilVal: gs.nil('ok'),
          guidLen: gs.generateGUID().length,
          dtIso: dt.getValue(),
          dtAfter: dt.after('2026-01-02T00:00:00.000Z'),
          messages: gs.getMessages(),
        });
      `,
      s.admin!,
    );

    expect(res.logs.map((l) => [l.level, l.message, l.source])).toEqual([
      ['info', 'user=admin (System Administrator)', undefined],
      ['warn', 'warn message', undefined],
      ['info', 'custom log', 'test-source'],
    ]);
    expect(res.messages).toEqual([
      { type: 'info', message: 'hello info' },
      { type: 'error', message: 'hello error' },
    ]);
    expect(res.value).toMatchObject({
      hasAdmin: true,
      hasSecurityAdmin: true,
      prop: 'howdy',
      fallbackProp: 'default-val',
      nilEmpty: true,
      nilVal: false,
      guidLen: 36,
      dtIso: '2026-01-03T00:01:00.000Z',
      dtAfter: true,
      messages: ['hello info', 'hello error'],
    });

    // Check group membership helpers for alice (member of Network Support):
    const groupCheck = await inst.scripts.evalBackground(
      inst.engine,
      `({
        byName: gs.getUser().isMemberOf('Network Support'),
        byId: gs.getUser().isMemberOf(${JSON.stringify(ids.netGroup)}),
        other: gs.getUser().isMemberOf('Nonexistent'),
        myGroups: gs.getUser().getMyGroups(),
      })`,
      { ...s.alice!, roles: new Set(['admin', 'itil']) },
    );
    expect(groupCheck.value).toEqual({
      byName: true,
      byId: true,
      other: false,
      myGroups: [ids.netGroup],
    });
  });

  it('supports synchronous GlideRecord and GlideRecordSecure (queries, display values, CRUD, setWorkflow)', async () => {
    const res = await inst.scripts.evalBackground(
      inst.engine,
      `
        const inc = new GlideRecord('incident');
        inc.initialize();
        inc.short_description = 'Sandbox CRUD A';
        inc.impact = 1;
        inc.caller = ${JSON.stringify(ids.bob)};
        const idA = inc.insert();

        const incB = new GlideRecord('incident');
        incB.newRecord();
        incB.setValue('short_description', 'Sandbox CRUD B');
        incB.setValue('impact', 2);
        const idB = incB.insert();

        // Update via get() + direct property assignment:
        const up = new GlideRecord('incident');
        const found = up.get(idA);
        const callerDisplay = up.getDisplayValue('caller');
        up.short_description = 'Sandbox CRUD A (updated)';
        up.update();

        // Query with addQuery + addOrCondition + orderByDesc:
        const q = new GlideRecord('incident');
        q.addQuery('sys_id', idA).addOrCondition('sys_id', idB);
        q.orderByDesc('impact');
        q.query();
        const titles = [];
        while (q.next()) {
          titles.push(q.getValue('short_description'));
        }

        // Delete both:
        const del = new GlideRecord('incident');
        del.get(idA);
        del.deleteRecord();
        del.get(idB);
        del.deleteRecord();

        ({ found, callerDisplay, count: q.getRowCount(), titles });
      `,
      s.admin!,
    );
    expect(res.value).toEqual({
      found: true,
      callerDisplay: 'Bob Caller',
      count: 2,
      titles: ['Sandbox CRUD B', 'Sandbox CRUD A (updated)'],
    });
  });

  it('loads Script Includes lazily (both Class.create() and ES6 class styles, including chained includes)', async () => {
    const inc1 = await insert('sys_script_include', {
      name: 'PriorityMatrix',
      script: `
        var PriorityMatrix = Class.create();
        PriorityMatrix.prototype = {
          initialize: function() {
            this.matrix = [
              [1, 2, 3],
              [2, 3, 4],
              [3, 4, 5],
            ];
          },
          compute: function(impact, urgency) {
            const i = Math.min(3, Math.max(1, Number(impact || 3))) - 1;
            const u = Math.min(3, Math.max(1, Number(urgency || 3))) - 1;
            return this.matrix[i][u];
          }
        };
      `,
    });
    const inc2 = await insert('sys_script_include', {
      name: 'TriageHelper',
      script: `
        class TriageHelper {
          static priorityFor(impact, urgency) {
            return new PriorityMatrix().compute(impact, urgency);
          }
        }
      `,
    });

    const row = (await inst.engine.get('sys_script_include', inc1))!;
    expect(row.api_name).toBe('global.PriorityMatrix');

    const res = await inst.scripts.evalBackground(
      inst.engine,
      `TriageHelper.priorityFor(1, 2)`,
      s.admin!,
    );
    expect(res.value).toBe(2);

    // Rejects invalid or reserved Script Include names and syntax errors.
    await expect(insert('sys_script_include', { name: '123bad', script: 'var x = 1;' })).rejects.toThrow(/Invalid script include name/);
    await expect(insert('sys_script_include', { name: 'GlideRecord', script: 'var x = 1;' })).rejects.toThrow(/reserved/);
    await expect(insert('sys_script_include', { name: 'BrokenInclude', script: 'function (' })).rejects.toThrow(/Syntax error/);

    await inst.engine.delete('sys_script_include', inc2, sys);
  });

  it('isolates scripts from Node globals and terminates infinite loops and memory bombs cleanly', async () => {
    const probe = await inst.scripts.evalBackground(
      inst.engine,
      `({
        hasProcess: typeof process !== 'undefined',
        hasRequire: typeof require !== 'undefined',
        hasFetch: typeof fetch !== 'undefined',
        hasHost: '__host' in globalThis,
      })`,
      s.admin!,
    );
    expect(probe.value).toEqual({
      hasProcess: false,
      hasRequire: false,
      hasFetch: false,
      hasHost: false,
    });

    // Infinite CPU loop is killed at timeout.
    await expect(
      inst.scripts.evalBackground(inst.engine, `while (true) {}`, s.admin!, { timeoutMs: 60 }),
    ).rejects.toThrow(/timed out/i);

    // Infinite host call loop is killed by maxHostCalls.
    await expect(
      inst.scripts.evalBackground(inst.engine, `while (true) { gs.getProperty('x'); }`, s.admin!),
    ).rejects.toThrow(/Maximum script host calls/i);

    // Memory bomb is killed by V8 heap limit and the pool recovers with a fresh isolate.
    await expect(
      inst.scripts.evalBackground(
        inst.engine,
        `const leak = []; while (true) leak.push('x'.repeat(250000));`,
        s.admin!,
      ),
    ).rejects.toThrow(/memory limit|timed out/i);

    // Instance is completely healthy afterward.
    const after = await inst.scripts.evalBackground(inst.engine, `20 + 22`, s.admin!);
    expect(after.value).toBe(42);
  });
});

describe('business rules (before, after, async, setWorkflow, recursion guard)', () => {
  it('before rule computes priority via Script Include even when caller cannot write priority directly', async () => {
    const ruleId = await insert('sys_script', {
      name: 'Calculate priority',
      collection: 'incident',
      when: 'before',
      order: 100,
      action_insert: true,
      action_update: true,
      condition: `current.isNewRecord() || current.changes('impact') || current.changes('urgency')`,
      script: `
        const pm = new PriorityMatrix();
        current.priority = pm.compute(current.impact, current.urgency);
        if (current.priority === 1) {
          current.work_notes = 'Auto-escalated to P1';
        }
      `,
    });

    // Alice (itil, not triage) cannot set priority directly via the API:
    await expect(
      inst.engine.insert('incident', { short_description: 'Direct priority', priority: 1 }, s.alice!),
    ).rejects.toThrow(ForbiddenError);

    // But when Alice sets impact=1, urgency=1, the before rule computes priority=1 and writes a journal note!
    const created = await inst.engine.insert(
      'incident',
      { short_description: 'Core router down', impact: 1, urgency: 1, caller: ids.bob },
      s.alice!,
    );
    expect(created.priority).toBe(1);
    const notes = await inst.engine.query('sys_journal_field', { query: `element_id=${created.sys_id}^element=work_notes` });
    expect(notes.map((n) => n.value)).toEqual(['Auto-escalated to P1']);

    // Updating impact from 1 -> 3 recalculates priority to 3:
    const updated = await inst.engine.update('incident', String(created.sys_id), { impact: 3, urgency: 2 }, s.alice!);
    expect(updated.priority).toBe(4);

    // setWorkflow(false) skips business rules:
    const noWf = await inst.engine.insert(
      'incident',
      { short_description: 'No workflow', impact: 1, urgency: 1 },
      s.alice!,
      { workflow: false },
    );
    expect(noWf.priority).toBe(5); // default priority, rule did not run

    await inst.engine.delete('sys_script', ruleId, sys);
  });

  it('runs inherited parent-table rules in order, evaluates filter_condition against in-memory mutations, and supports setAbortAction', async () => {
    let r1 = '';
    let r2 = '';
    let rAbort = '';
    try {
      r1 = await insert('sys_script', {
        name: 'Step 1 (task base)',
        collection: 'task',
        when: 'before',
        order: 50,
        action_insert: true,
        script: `current.short_description = '[TASK] ' + current.short_description;`,
      });
      r2 = await insert('sys_script', {
        name: 'Step 2 (incident child, sees Step 1 mutation in filter_condition)',
        collection: 'incident',
        when: 'before',
        order: 100,
        action_insert: true,
        filter_condition: 'short_descriptionSTARTSWITH[TASK]',
        script: `current.short_description = current.short_description + ' [INC]';`,
      });
      rAbort = await insert('sys_script', {
        name: 'Block forbidden title',
        collection: 'incident',
        when: 'before',
        order: 200,
        action_insert: true,
        action_update: true,
        filter_condition: 'short_descriptionLIKEFORBIDDEN',
        script: `
          gs.addErrorMessage('Forbidden keyword in short description');
          current.setAbortAction(true);
        `,
      });

      const ok = await inst.engine.insert('incident', { short_description: 'VPN issue', caller: ids.bob }, s.alice!);
      expect(ok.short_description).toBe('[TASK] VPN issue [INC]');

      const beforeCount = await inst.engine.count('incident');
      await expect(
        inst.engine.insert('incident', { short_description: 'FORBIDDEN change' }, s.alice!),
      ).rejects.toThrow('Forbidden keyword in short description');
      expect(await inst.engine.count('incident')).toBe(beforeCount);
    } finally {
      if (r1) await inst.engine.delete('sys_script', r1, sys);
      if (r2) await inst.engine.delete('sys_script', r2, sys);
      if (rAbort) await inst.engine.delete('sys_script', rAbort, sys);
    }
  });

  it('validates business rules on save, supports dot-walk filter_condition on before insert, and rolls back cache on failed tx', async () => {
    await expect(insert('sys_script', { name: 'Bad Table', collection: 'nope', script: '1;' })).rejects.toThrow(/does not exist/);
    await expect(
      insert('sys_script', { name: 'Bad Filter', collection: 'incident', filter_condition: 'nope=1', script: '1;' }),
    ).rejects.toThrow(/invalid filter condition/);
    await expect(
      insert('sys_script', { name: 'Bad Cond', collection: 'incident', condition: 'if (', script: '1;' }),
    ).rejects.toThrow(/Syntax error in condition/);
    await expect(
      insert('sys_script', { name: 'Bad Script', collection: 'incident', script: 'function (' }),
    ).rejects.toThrow(/Syntax error in script/);

    // Dot-walk filter_condition on before insert (`caller.last_name=Caller`):
    const dotRule = await insert('sys_script', {
      name: 'Tag VIP caller by dot-walk',
      collection: 'incident',
      when: 'before',
      action_insert: true,
      filter_condition: 'caller.last_name=Caller',
      script: `current.short_description = '[CALLER] ' + current.short_description;`,
    });
    try {
      const tagged = await inst.engine.insert('incident', { short_description: 'Dot-walk test', caller: ids.bob }, s.alice!);
      expect(tagged.short_description).toBe('[CALLER] Dot-walk test');
    } finally {
      await inst.engine.delete('sys_script', dotRule, sys);
    }

    // Cache rolls back when a transaction adding a business rule fails:
    const beforeRules = inst.scripts.matchingRules('incident', 'before', 'insert').length;
    await expect(
      inst.engine.transaction(async (tx) => {
        await tx.insert(
          'sys_script',
          { name: 'Temp Rule', collection: 'incident', when: 'before', action_insert: true, script: '1;' },
          sys,
        );
        expect(inst.scripts.matchingRules('incident', 'before', 'insert')).toHaveLength(beforeRules + 1);
        throw new ValidationError('abort rule tx');
      }),
    ).rejects.toThrow('abort rule tx');
    expect(inst.scripts.matchingRules('incident', 'before', 'insert')).toHaveLength(beforeRules);
  });

  it('after rules run in the same transaction (with SAVEPOINT isolation for caught errors) and async rules run only after commit', async () => {
    const afterRule = await insert('sys_script', {
      name: 'Create follow-up task on P1',
      collection: 'incident',
      when: 'after',
      order: 100,
      action_insert: true,
      filter_condition: 'impact=1',
      script: `
        // Caught bad insert must roll back its savepoint without aborting the outer transaction:
        try {
          const bad = new GlideRecord('task');
          bad.initialize();
          // missing mandatory short_description
          bad.insert();
        } catch (e) {
          gs.info('caught expected validation error');
        }

        const followUp = new GlideRecord('task');
        followUp.initialize();
        followUp.short_description = 'Follow-up for ' + current.number;
        followUp.insert();
      `,
    });

    const asyncRule = await insert('sys_script', {
      name: 'Async audit property on incident insert',
      collection: 'incident',
      when: 'async',
      order: 100,
      action_insert: true,
      script: `
        gs.setProperty('x.last.async.incident', current.number + ':' + (previous === null));
      `,
    });

    try {
      const inc = await inst.engine.insert('incident', { short_description: 'Outage', impact: 1 }, s.alice!);
      const tasks = await inst.engine.query('task', { query: `short_description=Follow-up for ${inc.number}` });
      expect(tasks).toHaveLength(1);

      await inst.scripts.flush();
      const prop = await inst.engine.query('sys_properties', { query: 'name=x.last.async.incident' });
      expect(prop[0]?.value).toBe(`${inc.number}:true`);

      // If a transaction rolls back after an insert, neither the after-rule's task nor the async rule persists:
      await expect(
        inst.engine.transaction(async (txEngine) => {
          await txEngine.insert('incident', { short_description: 'Rolled back outage', impact: 1 }, s.alice!);
          throw new ValidationError('force outer rollback');
        }),
      ).rejects.toThrow('force outer rollback');

      await inst.scripts.flush();
      const propAfterRollback = await inst.engine.query('sys_properties', { query: 'name=x.last.async.incident' });
      expect(propAfterRollback[0]?.value).toBe(`${inc.number}:true`);
    } finally {
      await inst.engine.delete('sys_script', afterRule, sys);
      await inst.engine.delete('sys_script', asyncRule, sys);
    }
  });

  it('stops infinite business rule recursion at MAX_HOOK_DEPTH', async () => {
    const loopRule = await insert('sys_script', {
      name: 'Infinite recursion',
      collection: 'task',
      when: 'after',
      action_insert: true,
      filter_condition: 'short_description=loop-me',
      script: `
        const gr = new GlideRecord('task');
        gr.initialize();
        gr.short_description = 'loop-me';
        gr.insert();
      `,
    });
    try {
      await expect(inst.engine.insert('task', { short_description: 'loop-me' }, s.alice!)).rejects.toThrow(
        /Maximum hook recursion depth/,
      );
      expect(await inst.engine.count('task', 'short_description=loop-me')).toBe(0);
    } finally {
      await inst.engine.delete('sys_script', loopRule, sys);
    }
  });
});

describe('scripted ACLs (row, field, write/create/delete, UI integration, fail-closed)', () => {
  it('enforces scripted row and field read ACLs across query, count, get, formLayout, and activity', async () => {
    await inst.metaApi.createTable(
      {
        name: 'u_deal',
        fields: [
          { element: 'name', type: 'string', mandatory: true, display: true },
          { element: 'amount', type: 'integer', defaultValue: 100 },
          { element: 'owner', type: 'reference', reference: 'sys_user' },
          { element: 'commission', type: 'integer' },
        ],
      },
      sys,
    );

    const d1 = await insert('u_deal', { name: 'Small Alice', amount: 100, owner: ids.alice, commission: 10 });
    const d2 = await insert('u_deal', { name: 'Small Bob', amount: 200, owner: ids.bob, commission: 20 });
    const d3 = await insert('u_deal', { name: 'Huge Bob', amount: 5000, owner: ids.bob, commission: 500 });

    // Row read ACL: owner is current user OR amount <= 200 (via script)
    const rowAcl = await insert('sys_security_acl', {
      name: 'u_deal',
      operation: 'read',
      script: `answer = (current.owner == gs.getUserID()) || (current.amount <= 200);`,
    });
    // Field read ACL on commission: only the deal's owner may read commission
    const fieldReadAcl = await insert('sys_security_acl', {
      name: 'u_deal.commission',
      operation: 'read',
      script: `return current.owner == gs.getUserID();`,
    });
    // Table write ACL: only owner may update, and only while amount < 1000
    const writeAcl = await insert('sys_security_acl', {
      name: 'u_deal',
      operation: 'write',
      condition: 'owner=javascript:gs.getUserID()',
      script: `current.amount < 1000`,
    });
    // Table create ACL: script requires amount <= 1000 for non-admins
    const createAcl = await insert('sys_security_acl', {
      name: 'u_deal',
      operation: 'create',
      script: `current.amount <= 1000`,
    });

    try {
      // Alice sees d1 (owner) and d2 (amount <= 200), but NOT d3 (owner=bob, amount=5000).
      const aliceDeals = await inst.engine.query('u_deal', {
        session: s.alice,
        orderBy: [{ field: 'amount', desc: false }],
      });
      expect(aliceDeals.map((d) => [d.name, d.commission])).toEqual([
        ['Small Alice', 10],
        ['Small Bob', null], // commission masked on Bob's deal!
      ]);
      expect(await inst.engine.count('u_deal', undefined, s.alice)).toBe(2);

      // Paging (offset/limit) works accurately after scripted row filtering:
      const page2 = await inst.engine.query('u_deal', {
        session: s.alice,
        orderBy: [{ field: 'amount', desc: false }],
        limit: 1,
        offset: 1,
      });
      expect(page2.map((d) => d.name)).toEqual(['Small Bob']);

      // Alice cannot probe Bob's hidden commission=20 via a query filter:
      const probe = await inst.engine.query('u_deal', {
        query: 'commission=20',
        session: s.alice,
      });
      expect(probe).toEqual([]);

      // Unreadable d3 returns null from get() and 404 on update:
      expect(await inst.engine.get('u_deal', d3, { session: s.alice })).toBeNull();
      await expect(inst.engine.update('u_deal', d3, { name: 'x' }, s.alice!)).rejects.toThrow(NotFoundError);

      // Readable d2 is not writable by Alice (403):
      await expect(inst.engine.update('u_deal', d2, { name: 'x' }, s.alice!)).rejects.toThrow(ForbiddenError);

      // Alice can update d1:
      await expect(inst.engine.update('u_deal', d1, { amount: 150 }, s.alice!)).resolves.toMatchObject({ amount: 150 });

      // Scripted create ACL allows amount <= 1000 and rolls back amount > 1000:
      const d4 = await inst.engine.insert('u_deal', { name: 'Ok Deal', amount: 500, owner: ids.alice }, s.alice!);
      expect(d4.name).toBe('Ok Deal');
      await expect(inst.engine.insert('u_deal', { name: 'Too Big', amount: 9000, owner: ids.alice }, s.alice!)).rejects.toThrow(
        ForbiddenError,
      );
      expect(await inst.engine.count('u_deal', 'name=Too Big')).toBe(0);

      // UI formLayout & activity respect scripted field/table ACLs per record:
      const formD1 = await inst.ui.formLayout('u_deal', d1, undefined, s.alice!);
      expect(formD1.access.canWrite).toBe(true);
      expect(formD1.fields.some((f) => f.element === 'commission')).toBe(true);

      const formD2 = await inst.ui.formLayout('u_deal', d2, undefined, s.alice!);
      expect(formD2.access.canWrite).toBe(false);
      expect(formD2.fields.some((f) => f.element === 'commission')).toBe(false);
      expect(formD2.record).not.toHaveProperty('commission');

      // A throwing or attempting-to-write ACL script fails closed (denies access):
      await inst.engine.update(
        'sys_security_acl',
        rowAcl,
        { script: `const gr = new GlideRecord('u_deal'); gr.initialize(); gr.name = 'hack'; gr.insert(); return true;` },
        s.admin!,
      );
      await expect(inst.engine.query('u_deal', { session: s.alice })).resolves.toEqual([]);
    } finally {
      await inst.engine.delete('sys_security_acl', rowAcl, sys);
      await inst.engine.delete('sys_security_acl', fieldReadAcl, sys);
      await inst.engine.delete('sys_security_acl', writeAcl, sys);
      await inst.engine.delete('sys_security_acl', createAcl, sys);
    }
  });
});

describe('elevated privilege boundaries in scripts (admin without security_admin)', () => {
  it('prevents non-security_admin background scripts and business rules from escalating privileges', async () => {
    const saRole = ids['role:security_admin']!;

    // 1. admin2 (has admin, NOT security_admin) cannot use GlideRecord in a background script to modify ACLs:
    await expect(
      inst.scripts.evalBackground(
        inst.engine,
        `
          const gr = new GlideRecord('sys_security_acl');
          gr.initialize();
          gr.name = 'task';
          gr.operation = 'delete';
          gr.insert();
        `,
        s.admin2!,
      ),
    ).rejects.toThrow(ForbiddenError);

    // 2. admin2 cannot grant security_admin to themselves via a background script:
    await expect(
      inst.scripts.evalBackground(
        inst.engine,
        `
          const gr = new GlideRecord('sys_user_has_role');
          gr.initialize();
          gr.user = ${JSON.stringify(ids.admin2)};
          gr.role = ${JSON.stringify(saRole)};
          gr.insert();
        `,
        s.admin2!,
      ),
    ).rejects.toThrow(ForbiddenError);

    // 3. Neither admin nor admin2 can forge a sys_user_session row from a script:
    await expect(
      inst.scripts.evalBackground(
        inst.engine,
        `
          const gr = new GlideRecord('sys_user_session');
          gr.initialize();
          gr.user = ${JSON.stringify(ids.admin2)};
          gr.token_hash = 'f'.repeat(64);
          gr.expires = '2030-01-01T00:00:00.000Z';
          gr.insert();
        `,
        s.admin!,
      ),
    ).rejects.toThrow(ForbiddenError);

    // 4. Even if admin2 plants a Business Rule and `admin` (who DOES hold security_admin) triggers it,
    //    the Business Rule runs without elevated roles and cannot grant security_admin!
    const trojanRule = await insert(
      'sys_script',
      {
        name: 'Trojan escalation attempt',
        collection: 'task',
        when: 'after',
        action_insert: true,
        filter_condition: 'short_description=trigger-trojan',
        script: `
          const gr = new GlideRecord('sys_user_has_role');
          gr.initialize();
          gr.user = ${JSON.stringify(ids.admin2)};
          gr.role = ${JSON.stringify(saRole)};
          gr.insert();
        `,
      },
      s.admin2!,
    );
    try {
      await expect(
        inst.engine.insert('task', { short_description: 'trigger-trojan' }, s.admin!),
      ).rejects.toThrow(ForbiddenError);
      expect(inst.acl.hasRole(await inst.sessionFor('admin2'), 'security_admin')).toBe(false);
    } finally {
      await inst.engine.delete('sys_script', trojanRule, sys);
    }

    // 5. Non-admin cannot run background scripts at all:
    await expect(inst.scripts.evalBackground(inst.engine, `1 + 1`, s.alice!)).rejects.toThrow(ForbiddenError);
  });
});

describe('bootstrap v4 upgrade', () => {
  it('adds sys_script, sys_script_include, and sys_security_acl.script to a Phase 3 (v3) instance', async () => {
    const old = await Instance.create({ adminPassword: 'x' });
    try {
      await old.db.transaction(async (tx) => {
        await tx.exec(`DROP TABLE "sys_script", "sys_script_include"`);
        await tx.exec(`ALTER TABLE "sys_security_acl" DROP COLUMN "script"`);
        await tx.exec(`DELETE FROM sys_db_object WHERE name IN ('sys_script', 'sys_script_include')`);
        await tx.exec(
          `DELETE FROM sys_dictionary WHERE name IN ('sys_script', 'sys_script_include') OR (name = 'sys_security_acl' AND element = 'script')`,
        );
        await tx.exec(`DELETE FROM sys_choice WHERE name = 'sys_script'`);
        await tx.exec(`DELETE FROM sys_ui_list WHERE name IN ('sys_script', 'sys_script_include')`);
        await tx.exec(`UPDATE sys_properties SET value = '3' WHERE name = 'glide.steward.bootstrap_version'`);
      });
      expect(await bootstrapVersion(old.db)).toBe(3);

      await bootstrap(old.db);
      expect(await bootstrapVersion(old.db)).toBe(BOOTSTRAP_VERSION);
      await old.meta.load(old.db);
      await old.acl.load(old.db);
      await old.scripts.load(old.db);

      expect(old.meta.hasTable('sys_script')).toBe(true);
      expect(old.meta.hasTable('sys_script_include')).toBe(true);
      expect(old.meta.field('sys_security_acl', 'script').type).toBe('script');
      expect(await old.engine.count('sys_ui_list', 'name=sys_script')).toBe(1);
    } finally {
      await old.close();
    }
  });
});
