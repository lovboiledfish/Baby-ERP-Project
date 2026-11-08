import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, bootstrapVersion, BOOTSTRAP_VERSION } from '../bootstrap/system-tables';
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '../errors';
import { Instance } from '../instance';
import { systemSession, type Session } from '../session';
import { isPasswordHash } from './password';

const sys = systemSession('setup');
let inst: Instance;
const ids: Record<string, string> = {};
const s: Record<string, Session> = {};

async function insert(table: string, values: Record<string, unknown>): Promise<string> {
  return String((await inst.engine.insert(table, values, sys)).sys_id);
}

async function role(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (ids[`role:${name}`] = await insert('sys_user_role', { name, ...extra }));
}

async function acl(name: string, operation: string, opts: { roles?: string[]; condition?: string; adminOverrides?: boolean } = {}): Promise<string> {
  const id = await insert('sys_security_acl', { name, operation, condition: opts.condition ?? null, admin_overrides: opts.adminOverrides ?? true });
  for (const r of opts.roles ?? []) await insert('sys_security_acl_role', { sys_security_acl: id, sys_user_role: ids[`role:${r}`] });
  return id;
}

async function user(userName: string, roles: string[] = [], extra: Record<string, unknown> = {}): Promise<string> {
  const id = (ids[userName] = await insert('sys_user', { user_name: userName, first_name: userName, user_password: `${userName}-pw`, ...extra }));
  for (const r of roles) await insert('sys_user_has_role', { user: id, role: ids[`role:${r}`] });
  return id;
}

const numbers = (rows: Array<Record<string, unknown>>) => rows.map((r) => r.number).sort();

beforeAll(async () => {
  inst = await Instance.create({ adminPassword: 'admin-pw' });
  const { metaApi } = inst;

  await metaApi.createTable({ name: 'u_vendor', fields: [{ element: 'name', type: 'string', display: true }] }, sys);
  await metaApi.createTable(
    {
      name: 'task',
      fields: [
        { element: 'number', type: 'string' },
        { element: 'short_description', type: 'string', maxLength: 160, mandatory: true },
        { element: 'priority', type: 'integer', defaultValue: 4 },
        { element: 'state', type: 'choice', defaultValue: 'new', choices: [{ value: 'new', label: 'New' }, { value: 'closed', label: 'Closed' }] },
        { element: 'assigned_to', type: 'reference', reference: 'sys_user' },
        { element: 'assignment_group', type: 'reference', reference: 'sys_user_group' },
        { element: 'caller', type: 'reference', reference: 'sys_user' },
      ],
    },
    sys,
  );
  await metaApi.createTable(
    {
      name: 'incident',
      extends: 'task',
      numberPrefix: 'INC',
      fields: [
        { element: 'work_notes', type: 'text' },
        { element: 'vendor', type: 'reference', reference: 'u_vendor' },
      ],
    },
    sys,
  );
  await metaApi.createTable({ name: 'u_secret', fields: [{ element: 'name', type: 'string' }] }, sys);

  // Roles: itil; network_tech contains itil (role hierarchy); vendor_manager; priority_setter.
  for (const r of await inst.engine.query('sys_user_role', { fields: ['sys_id', 'name'] })) ids[`role:${String(r.name)}`] = String(r.sys_id);
  await role('itil');
  await role('network_tech');
  await role('vendor_manager');
  await role('priority_setter');
  await insert('sys_user_role_contains', { role: ids['role:network_tech'], contains: ids['role:itil'] });

  ids.network = await insert('sys_user_group', { name: 'Network' });
  ids.retired = await insert('sys_user_group', { name: 'Retired', active: false });
  await insert('sys_group_has_role', { group: ids.network, role: ids['role:network_tech'] });
  await insert('sys_group_has_role', { group: ids.retired, role: ids['role:priority_setter'] });

  await user('alice', ['itil']);
  await user('bob', ['itil']);
  await user('carol');
  await user('dave'); // itil only via Network -> network_tech -> itil
  await user('eve', ['itil'], { active: false });
  await user('mallory', ['itil'], { locked_out: true });
  await user('admin2', ['admin']);
  await user('imp', ['impersonator']);
  await insert('sys_user_grmember', { user: ids.dave, group: ids.network });
  await insert('sys_user_grmember', { user: ids.carol, group: ids.retired });

  // ACLs on task are inherited by incident (most specific level wins).
  await acl('task', 'read', { roles: ['itil'] });
  await acl('task', 'read', { condition: 'caller=javascript:gs.getUserID()' }); // anyone: their own tickets
  await acl('task', 'create', { roles: ['itil'] });
  await acl('task', 'write', { roles: ['itil'], condition: 'assigned_to=javascript:gs.getUserID()^ORassignment_group=javascript:getMyGroups()' });
  await acl('incident.work_notes', 'read', { roles: ['itil'], condition: 'assigned_to=javascript:gs.getUserID()' });
  await acl('task.priority', 'write', { roles: ['priority_setter'] });
  await acl('u_vendor', 'read', { roles: ['vendor_manager'] });

  ids.acme = await insert('u_vendor', { name: 'Acme' });
  const inc = async (key: string, values: Record<string, unknown>) => {
    ids[key] = await insert('incident', { work_notes: `secret ${key}`, vendor: ids.acme, ...values });
  };
  await inc('i1', { short_description: 'Alice ticket', assigned_to: ids.alice, caller: ids.carol });
  await inc('i2', { short_description: 'Bob ticket', assigned_to: ids.bob, caller: ids.bob });
  await inc('i3', { short_description: 'Network ticket', assignment_group: ids.network, caller: ids.bob });
  ids.t1 = await insert('task', { short_description: 'Plain task' });

  for (const name of ['admin', 'alice', 'bob', 'carol', 'dave', 'admin2', 'imp']) s[name] = await inst.sessionFor(name);
});

afterAll(async () => {
  await inst.close();
});

describe('identity', () => {
  it('builds effective roles from direct grants, active groups and role containment', () => {
    expect([...s.alice!.roles]).toEqual(['itil']);
    expect([...s.dave!.roles].sort()).toEqual(['itil', 'network_tech']);
    expect(s.dave!.groups.has(ids.network!)).toBe(true);
    // Retired group is inactive: no membership, no role.
    expect(s.carol!.roles.size).toBe(0);
    expect(s.carol!.groups.size).toBe(0);
    expect([...s.admin!.roles].sort()).toEqual(['admin', 'security_admin']);
  });

  it('admin has every role except elevated ones', () => {
    expect(inst.acl.hasRole(s.admin2!, 'itil')).toBe(true);
    expect(inst.acl.hasRole(s.admin2!, 'security_admin')).toBe(false);
    expect(inst.acl.hasRole(s.alice!, 'vendor_manager')).toBe(false);
  });

  it('stores passwords as one-way hashes that can never be read or queried', async () => {
    const raw = await inst.db.query<{ user_password: string }>(`SELECT user_password FROM sys_user WHERE user_name = 'alice'`);
    expect(isPasswordHash(raw.rows[0]!.user_password)).toBe(true);
    expect(raw.rows[0]!.user_password).not.toContain('alice-pw');

    const [row] = await inst.engine.query('sys_user', { query: 'user_name=alice' });
    expect(row).not.toHaveProperty('user_password');
    await expect(inst.engine.query('sys_user', { fields: ['user_password'] })).rejects.toThrow(ValidationError);
    await expect(inst.engine.query('sys_user', { query: 'user_passwordSTARTSWITHscrypt' })).rejects.toThrow(ValidationError);
  });

  it('redacts password changes in the audit trail', async () => {
    await inst.engine.update('sys_user', ids.bob!, { user_password: 'bob-pw-2' }, sys);
    const audit = await inst.engine.query('sys_audit', { query: `documentkey=${ids.bob}^fieldname=user_password`, fields: ['oldvalue', 'newvalue'] });
    expect(audit).toEqual([{ oldvalue: null, newvalue: '********' }]);
    await expect(inst.auth.authenticate('bob', 'bob-pw')).rejects.toThrow(UnauthorizedError);
    await inst.auth.authenticate('bob', 'bob-pw-2');
    await inst.engine.update('sys_user', ids.bob!, { user_password: 'bob-pw' }, sys);
  });
});

describe('row-level read ACLs: same query, different rows', () => {
  it('returns different rows for different users', async () => {
    const q = { fields: ['number'] };
    expect(numbers(await inst.engine.query('incident', { ...q, session: s.admin }))).toEqual(['INC0001000', 'INC0001001', 'INC0001002']);
    expect(numbers(await inst.engine.query('incident', { ...q, session: s.alice }))).toEqual(['INC0001000', 'INC0001001', 'INC0001002']);
    // carol has no itil: only the ticket where she is the caller (condition with dynamic value).
    expect(numbers(await inst.engine.query('incident', { ...q, session: s.carol }))).toEqual(['INC0001000']);
    expect(await inst.engine.count('incident', undefined, s.carol)).toBe(1);
    expect(await inst.engine.count('task', undefined, s.carol)).toBe(1);
    expect(await inst.engine.count('task', undefined, s.alice)).toBe(4);
  });

  it('get() of an unreadable record behaves like a missing one', async () => {
    expect(await inst.engine.get('incident', ids.i2!, { session: s.carol })).toBeNull();
    expect(await inst.engine.get('incident', ids.i1!, { session: s.carol })).not.toBeNull();
  });

  it('denies tables without any ACL to non-admins (default deny) but not to admins', async () => {
    await expect(inst.engine.query('u_secret', { session: s.alice })).rejects.toThrow(ForbiddenError);
    await expect(inst.engine.count('u_secret', undefined, s.alice)).rejects.toThrow(ForbiddenError);
    await expect(inst.engine.query('u_secret', { session: s.admin2 })).resolves.toEqual([]);
    await expect(inst.engine.query('sys_audit', { session: s.alice })).rejects.toThrow(ForbiddenError);
  });

  it('GlideRecord with a user session enforces the same ACLs', async () => {
    const gr = inst.glideRecord('incident', s.carol);
    await gr.query();
    expect(gr.getRowCount()).toBe(1);
  });
});

describe('field-level read ACLs', () => {
  it('omits fields the user can never read and masks conditionally readable ones per row', async () => {
    const fields = ['number', 'work_notes'];
    const forAdmin = await inst.engine.query('incident', { fields, session: s.admin, orderBy: [{ field: 'number', desc: false }] });
    expect(forAdmin.map((r) => r.work_notes)).toEqual(['secret i1', 'secret i2', 'secret i3']);

    // alice: work_notes only where assigned_to = alice.
    const forAlice = await inst.engine.query('incident', { fields, session: s.alice, orderBy: [{ field: 'number', desc: false }] });
    expect(forAlice.map((r) => r.work_notes)).toEqual(['secret i1', null, null]);

    // carol: no rule passes for work_notes at all -> the column is not returned.
    const forCarol = await inst.engine.query('incident', { session: s.carol });
    expect(forCarol).toHaveLength(1);
    expect(forCarol[0]).not.toHaveProperty('work_notes');
    expect(forCarol[0]).toHaveProperty('short_description', 'Alice ticket');
  });

  it('rejects filtering or sorting on unreadable fields, and filters conditionally readable ones safely', async () => {
    await expect(inst.engine.query('incident', { query: 'work_notesLIKEsecret', session: s.carol })).rejects.toThrow(ForbiddenError);
    await expect(inst.engine.query('incident', { query: 'ORDERBYwork_notes', session: s.carol })).rejects.toThrow(ForbiddenError);
    // alice can only match on rows where she can see the field (no oracle on hidden values).
    expect(numbers(await inst.engine.query('incident', { query: 'work_notesLIKEsecret', fields: ['number'], session: s.alice }))).toEqual(['INC0001000']);
    expect(numbers(await inst.engine.query('incident', { query: 'work_notes!=secret i1', fields: ['number'], session: s.alice }))).toEqual([]);
  });

  it('applies the target table ACLs to dot-walks and display values', async () => {
    const rows = await inst.engine.query('incident', { query: `sys_id=${ids.i1}`, fields: ['vendor', 'vendor.name'], session: s.alice });
    expect(rows).toEqual([{ vendor: ids.acme, 'vendor.name': null }]);
    expect(await inst.engine.query('incident', { query: 'vendor.name=Acme', fields: ['number'], session: s.alice })).toEqual([]);
    const [shown] = await inst.engine.query('incident', { query: `sys_id=${ids.i1}`, fields: ['vendor', 'caller'], session: s.alice, displayValue: true });
    expect(shown).toEqual({ vendor: '', caller: 'carol' });

    const [asAdmin] = await inst.engine.query('incident', { query: `sys_id=${ids.i1}`, fields: ['vendor.name'], session: s.admin });
    expect(asAdmin).toEqual({ 'vendor.name': 'Acme' });
  });

  it('supports dot-walks inside ACL conditions (row and field level), alongside the caller\'s own dot-walks', async () => {
    await role('net_viewer');
    await user('frank', ['net_viewer']);
    const rowAcl = await acl('task', 'read', { roles: ['net_viewer'], condition: 'assignment_group.name=Network' });
    const fieldAcl = await acl('incident.work_notes', 'read', { roles: ['net_viewer'], condition: 'assignment_group.name=Network' });
    try {
      const frank = await inst.sessionFor('frank');
      const rows = await inst.engine.query('incident', {
        query: 'assignment_group.nameSTARTSWITHNet^ORassigned_to.user_name=alice',
        fields: ['number', 'work_notes', 'assignment_group.name'],
        session: frank,
      });
      expect(rows).toEqual([{ number: 'INC0001002', work_notes: 'secret i3', 'assignment_group.name': 'Network' }]);
      expect(await inst.engine.count('task', undefined, frank)).toBe(1);
      // alice (itil) can read the row but not this field: the net_viewer field rule doesn't apply to her.
      const [forAlice] = await inst.engine.query('incident', { query: `sys_id=${ids.i3}`, fields: ['work_notes'], session: s.alice });
      expect(forAlice).toEqual({ work_notes: null });
      // A select where every requested column is denied still returns the (empty) rows.
      expect(await inst.engine.query('incident', { fields: ['work_notes'], session: s.carol })).toEqual([{}]);
    } finally {
      await inst.engine.delete('sys_security_acl', rowAcl, sys);
      await inst.engine.delete('sys_security_acl', fieldAcl, sys);
    }
  });

  it('filters schema inspection', () => {
    expect(inst.metaApi.describe('incident', s.carol).fields.map((f) => f.element)).not.toContain('work_notes');
    expect(inst.metaApi.describe('incident', s.alice).fields.map((f) => f.element)).toContain('work_notes');
    expect(() => inst.metaApi.describe('u_secret', s.alice)).toThrow(ForbiddenError);
    const listed = inst.metaApi.list(s.carol).map((t) => t.name);
    expect(listed).toEqual(expect.arrayContaining(['incident', 'task', 'sys_user']));
    expect(listed).not.toContain('u_secret');
    expect(listed).not.toContain('sys_security_acl');
  });
});

describe('write ACLs', () => {
  it('create: requires the table create ACL; field write rules also apply to inserts', async () => {
    await expect(inst.engine.insert('incident', { short_description: 'nope' }, s.carol)).rejects.toThrow(ForbiddenError);
    const created = await inst.engine.insert('incident', { short_description: 'Alice created', assigned_to: ids.alice }, s.alice);
    expect(created).toMatchObject({ short_description: 'Alice created', priority: 4, sys_created_by: 'alice' });
    // priority write requires priority_setter; inserts fall back to write rules for fields.
    await expect(inst.engine.insert('incident', { short_description: 'x', priority: 1 }, s.alice)).rejects.toThrow(/task.*priority|incident.priority/);
    await inst.engine.delete('incident', String(created.sys_id), sys);
  });

  it('create: conditional create ACLs are checked against the inserted row and roll back on failure', async () => {
    await user('victor', ['vendor_manager']);
    const id = await acl('u_vendor', 'create', { roles: ['vendor_manager'], condition: 'nameSTARTSWITHA' });
    try {
      const victor = await inst.sessionFor('victor');
      await expect(inst.engine.insert('u_vendor', { name: 'Apex' }, victor)).resolves.toMatchObject({ name: 'Apex' });
      await expect(inst.engine.insert('u_vendor', { name: 'Globex' }, victor)).rejects.toThrow(ForbiddenError);
      expect(await inst.engine.count('u_vendor', 'name=Globex')).toBe(0);
    } finally {
      await inst.engine.delete('sys_security_acl', id, sys);
    }
  });

  it('update: conditional write ACL is evaluated against the record', async () => {
    await expect(inst.engine.update('incident', ids.i1!, { short_description: 'Alice edit' }, s.alice)).resolves.toMatchObject({ short_description: 'Alice edit' });
    await expect(inst.engine.update('incident', ids.i2!, { short_description: 'hijack' }, s.alice)).rejects.toThrow(ForbiddenError);
    // dave gets write through his group (getMyGroups) and itil through the role hierarchy.
    await expect(inst.engine.update('incident', ids.i3!, { short_description: 'Dave edit' }, s.dave)).resolves.toMatchObject({ short_description: 'Dave edit' });
    await expect(inst.engine.update('incident', ids.i2!, { short_description: 'nope' }, s.dave)).rejects.toThrow(ForbiddenError);
  });

  it('update: unreadable records are 404, readable-but-not-writable are 403', async () => {
    await expect(inst.engine.update('incident', ids.i2!, { short_description: 'x' }, s.carol)).rejects.toThrow(NotFoundError);
    await expect(inst.engine.update('incident', ids.i1!, { short_description: 'x' }, s.carol)).rejects.toThrow(ForbiddenError);
    await expect(inst.engine.delete('incident', ids.i2!, s.carol)).rejects.toThrow(NotFoundError);
  });

  it('update: field-level write only applies to fields the caller actually changes', async () => {
    const current = (await inst.engine.get('incident', ids.i1!))!;
    await expect(inst.engine.update('incident', ids.i1!, { priority: 1 }, s.alice)).rejects.toThrow(ForbiddenError);
    // Echoing the unchanged value (e.g. a PUT of the whole record) is fine.
    await expect(inst.engine.update('incident', ids.i1!, { priority: current.priority, state: 'closed' }, s.alice)).resolves.toMatchObject({ state: 'closed' });
    await expect(inst.engine.update('incident', ids.i1!, { priority: 1 }, s.admin)).resolves.toMatchObject({ priority: 1 });
  });

  it('delete: no delete ACL means admin only', async () => {
    await expect(inst.engine.delete('incident', ids.i1!, s.alice)).rejects.toThrow(ForbiddenError);
    const tmp = await insert('incident', { short_description: 'to delete' });
    await inst.engine.delete('incident', tmp, s.admin2);
    expect(await inst.engine.get('incident', tmp)).toBeNull();
  });

  it('a write returns the record as the caller may read it', async () => {
    const updated = await inst.engine.update('incident', ids.i3!, { short_description: 'Dave again' }, s.dave);
    expect(updated).toHaveProperty('short_description', 'Dave again');
    expect(updated.work_notes).toBeNull(); // dave is not assigned_to -> masked
  });

  it('metadata writes are ACL-checked too (no ACL on sys_db_object -> admin only)', async () => {
    await expect(inst.metaApi.createTable({ name: 'u_by_alice' }, s.alice)).rejects.toThrow(ForbiddenError);
    await expect(inst.metaApi.createTable({ name: 'u_by_admin', numberPrefix: 'UBA' }, s.admin2)).resolves.toMatchObject({ name: 'u_by_admin' });
    expect(inst.meta.hasTable('u_by_alice')).toBe(false);
  });
});

describe('ACL administration', () => {
  it('only security_admin (elevated, not implied by admin) can manage ACLs', async () => {
    await expect(inst.engine.insert('sys_security_acl', { name: 'u_secret', operation: 'read' }, s.admin2)).rejects.toThrow(ForbiddenError);
    await expect(inst.engine.query('sys_security_acl', { session: s.admin2 })).rejects.toThrow(ForbiddenError);
    const id = String((await inst.engine.insert('sys_security_acl', { name: 'u_secret', operation: 'read', description: 'open' }, s.admin)).sys_id);
    try {
      // The cache reloads immediately: a role-less ACL opens u_secret to everyone.
      await expect(inst.engine.query('u_secret', { session: s.alice })).resolves.toEqual([]);
    } finally {
      await inst.engine.delete('sys_security_acl', id, s.admin);
    }
    await expect(inst.engine.query('u_secret', { session: s.alice })).rejects.toThrow(ForbiddenError);
  });

  it('admin cannot grant itself an elevated role (directly, via groups, or by unflagging it)', async () => {
    const sa = ids['role:security_admin']!;
    await expect(inst.engine.insert('sys_user_has_role', { user: ids.admin2, role: sa }, s.admin2)).rejects.toThrow(ForbiddenError);
    const g = String((await inst.engine.insert('sys_user_group', { name: 'Sec' }, s.admin2)).sys_id);
    await expect(inst.engine.insert('sys_group_has_role', { group: g, role: sa }, s.admin2)).rejects.toThrow(ForbiddenError);
    await expect(inst.engine.insert('sys_user_role_contains', { role: ids['role:itil'], contains: sa }, s.admin2)).rejects.toThrow(ForbiddenError);
    await expect(inst.engine.update('sys_user_role', sa, { elevated_privilege: false }, s.admin2)).rejects.toThrow(ForbiddenError);
    // A security_admin can.
    const grant = String((await inst.engine.insert('sys_group_has_role', { group: g, role: sa }, s.admin)).sys_id);
    await expect(inst.engine.insert('sys_user_grmember', { user: ids.admin2, group: g }, s.admin2)).rejects.toThrow(ForbiddenError);
    await inst.engine.delete('sys_group_has_role', grant, s.admin);
    expect(inst.acl.hasRole(await inst.sessionFor('admin2'), 'security_admin')).toBe(false);
  });

  it('admin_overrides=false makes admins pass the condition like everyone else', async () => {
    // Admin implicitly holds non-elevated roles, so only the condition can stop them here.
    const id = await acl('u_vendor', 'write', { roles: ['vendor_manager'], condition: 'name=Globex', adminOverrides: false });
    try {
      await expect(inst.engine.update('u_vendor', ids.acme!, { name: 'Acme 2' }, s.admin2)).rejects.toThrow(ForbiddenError);
      await inst.db.query(`UPDATE sys_security_acl SET admin_overrides = true WHERE sys_id = $1`, [id]);
      await inst.acl.load(inst.db);
      await expect(inst.engine.update('u_vendor', ids.acme!, { name: 'Acme 2' }, s.admin2)).resolves.toMatchObject({ name: 'Acme 2' });
    } finally {
      await inst.engine.delete('sys_security_acl', id, sys);
    }
    await expect(inst.engine.update('u_vendor', ids.acme!, { name: 'Acme' }, s.admin2)).resolves.toMatchObject({ name: 'Acme' });
  });

  it('validates ACL definitions', async () => {
    const bad = async (values: Record<string, unknown>) => inst.engine.insert('sys_security_acl', values, s.admin);
    await expect(bad({ name: 'nope', operation: 'read' })).rejects.toThrow(/does not exist/);
    await expect(bad({ name: 'incident.nope', operation: 'read' })).rejects.toThrow(/does not exist/);
    await expect(bad({ name: 'Incident', operation: 'read' })).rejects.toThrow(/Invalid ACL name/);
    await expect(bad({ name: 'incident', operation: 'execute' })).rejects.toThrow(/Invalid choice/);
    await expect(bad({ name: 'incident', operation: 'read', condition: 'bogus=1' })).rejects.toThrow(/invalid condition/);
    await expect(bad({ name: 'incident', operation: 'read', condition: 'priority=javascript:gs.nope()' })).rejects.toThrow(/invalid condition/);
    await expect(bad({ name: '*', operation: 'read', condition: 'sys_id=x' })).rejects.toThrow(/not supported/);
  });

  it('rolls back the ACL cache when the transaction that changed it fails', async () => {
    const before = inst.acl.version;
    await expect(
      inst.engine.transaction(async (e) => {
        await e.insert('sys_security_acl', { name: 'u_secret', operation: 'read' }, s.admin);
        expect(inst.acl.rulesFor('u_secret', 'read')).toHaveLength(1);
        throw new ValidationError('abort');
      }),
    ).rejects.toThrow('abort');
    expect(inst.acl.version).toBeGreaterThan(before);
    expect(inst.acl.rulesFor('u_secret', 'read')).toHaveLength(0);
  });

  it('fails closed on a broken stored condition', async () => {
    const id = await insert('sys_security_acl', { name: 'u_secret', operation: 'read' });
    try {
      await inst.db.query(`UPDATE sys_security_acl SET condition = 'Not A Query' WHERE sys_id = $1`, [id]);
      await inst.acl.load(inst.db);
      expect(inst.acl.rulesFor('u_secret', 'read')[0]!.broken).toBe(true);
      await expect(inst.engine.query('u_secret', { session: s.alice })).rejects.toThrow(ForbiddenError);
    } finally {
      await inst.engine.delete('sys_security_acl', id, sys);
    }
  });
});

describe('dynamic query values', () => {
  it('resolves supported javascript: values for user queries', async () => {
    expect(numbers(await inst.engine.query('incident', { query: 'assigned_to=javascript:gs.getUserID()', fields: ['number'], session: s.alice }))).toEqual(['INC0001000']);
    expect(numbers(await inst.engine.query('incident', { query: 'assignment_group=javascript:getMyGroups()', fields: ['number'], session: s.dave }))).toEqual(['INC0001002']);
    await expect(inst.engine.query('incident', { query: 'caller=javascript:new Evil()', session: s.alice })).rejects.toThrow(ValidationError);
  });
});

describe('authentication and impersonation', () => {
  it('logs in with a password, resolves and revokes tokens', async () => {
    const { token, session } = await inst.auth.login('alice', 'alice-pw');
    expect(session.userName).toBe('alice');
    const stored = await inst.db.query<{ token_hash: string }>(`SELECT token_hash FROM sys_user_session WHERE "user" = $1`, [ids.alice]);
    expect(stored.rows.map((r) => r.token_hash)).not.toContain(token); // only the hash is stored
    expect((await inst.auth.resolveToken(token)).userId).toBe(ids.alice);
    await inst.auth.logout(token);
    await expect(inst.auth.resolveToken(token)).rejects.toThrow(UnauthorizedError);
  });

  it('rejects bad passwords, unknown, inactive and locked-out users', async () => {
    await expect(inst.auth.login('alice', 'wrong')).rejects.toThrow(UnauthorizedError);
    await expect(inst.auth.login('nobody', 'x')).rejects.toThrow(UnauthorizedError);
    await expect(inst.auth.login('eve', 'eve-pw')).rejects.toThrow(UnauthorizedError);
    await expect(inst.auth.login('mallory', 'mallory-pw')).rejects.toThrow(UnauthorizedError);
    await expect(inst.auth.resolveToken('garbage')).rejects.toThrow(UnauthorizedError);
  });

  it('expires tokens and invalidates sessions of deactivated users', async () => {
    const { token } = await inst.auth.login('bob', 'bob-pw');
    await inst.db.query(`UPDATE sys_user_session SET expires = now() - interval '1 minute' WHERE "user" = $1`, [ids.bob]);
    await expect(inst.auth.resolveToken(token)).rejects.toThrow(UnauthorizedError);

    const second = await inst.auth.login('bob', 'bob-pw');
    await inst.engine.update('sys_user', ids.bob!, { active: false }, sys);
    try {
      await expect(inst.auth.resolveToken(second.token)).rejects.toThrow(UnauthorizedError);
    } finally {
      await inst.engine.update('sys_user', ids.bob!, { active: true }, sys);
    }
  });

  it('admin impersonation switches identity and ACLs, and is audited', async () => {
    const { token } = await inst.auth.login('admin', 'admin-pw');
    const as = await inst.auth.impersonate(token, 'carol');
    expect(as).toMatchObject({ userName: 'carol', impersonator: { userName: 'admin' } });

    const resolved = await inst.auth.resolveToken(token);
    expect(resolved.userName).toBe('carol');
    expect(numbers(await inst.engine.query('incident', { fields: ['number'], session: resolved }))).toEqual(['INC0001000']);

    const back = await inst.auth.endImpersonation(token);
    expect(back.userName).toBe('admin');
    expect((await inst.auth.resolveToken(token)).userName).toBe('admin');

    const audit = await inst.engine.query('sys_audit', {
      query: `fieldname=impersonation^documentkey=${ids.carol}^ORDERBYreason`,
      fields: ['user', 'oldvalue', 'newvalue', 'reason'],
    });
    expect(audit).toEqual([
      { user: 'admin', oldvalue: 'carol', newvalue: 'admin', reason: 'impersonation ended' },
      { user: 'admin', oldvalue: 'admin', newvalue: 'carol', reason: 'impersonation started' },
    ]);
  });

  it('restricts who can impersonate whom', async () => {
    const alice = await inst.auth.login('alice', 'alice-pw');
    await expect(inst.auth.impersonate(alice.token, 'bob')).rejects.toThrow(ForbiddenError);

    const imp = await inst.auth.login('imp', 'imp-pw');
    await expect(inst.auth.impersonate(imp.token, 'admin')).rejects.toThrow(ForbiddenError);
    await expect(inst.auth.impersonate(imp.token, 'admin2')).rejects.toThrow(ForbiddenError);
    await expect(inst.auth.impersonate(imp.token, 'bob')).resolves.toMatchObject({ userName: 'bob' });
    await expect(inst.auth.impersonate(imp.token, 'eve')).rejects.toThrow(ValidationError);
  });

  it('records writes made while impersonating under the impersonated user', async () => {
    const { token } = await inst.auth.login('admin', 'admin-pw');
    const asAlice = await inst.auth.impersonate(token, 'alice');
    const updated = await inst.engine.update('incident', ids.i1!, { short_description: 'Edited as alice' }, asAlice);
    expect(updated.sys_updated_by).toBe('alice');
  });
});

describe('elevated privilege boundaries (admin without security_admin)', () => {
  const adminId = () => ids.adminUser!;
  beforeAll(async () => {
    ids.adminUser = String((await inst.engine.query('sys_user', { query: 'user_name=admin', fields: ['sys_id'] }))[0]!.sys_id);
    await role('secops');
    await insert('sys_user_role_contains', { role: ids['role:secops'], contains: ids['role:security_admin'] });
  });

  it('cannot grant or contain a role that transitively contains security_admin', async () => {
    await expect(inst.engine.insert('sys_user_has_role', { user: ids.admin2, role: ids['role:secops'] }, s.admin2!)).rejects.toThrow(ForbiddenError);
    await expect(inst.engine.insert('sys_group_has_role', { group: ids.network, role: ids['role:secops'] }, s.admin2!)).rejects.toThrow(ForbiddenError);
    const wrapper = String((await inst.engine.insert('sys_user_role', { name: 'wrapper' }, s.admin2!)).sys_id);
    await expect(inst.engine.insert('sys_user_role_contains', { role: wrapper, contains: ids['role:secops'] }, s.admin2!)).rejects.toThrow(ForbiddenError);
    // A security admin may.
    const grant = await inst.engine.insert('sys_user_role_contains', { role: wrapper, contains: ids['role:secops'] }, s.admin!);
    await inst.engine.delete('sys_user_role_contains', String(grant.sys_id), s.admin!);
  });

  it('cannot reactivate or join a group whose roles contain security_admin', async () => {
    const g = await insert('sys_user_group', { name: 'Dormant SecOps', active: false });
    await insert('sys_group_has_role', { group: g, role: ids['role:secops'] });
    await expect(inst.engine.update('sys_user_group', g, { active: true }, s.admin2!)).rejects.toThrow(ForbiddenError);
    await expect(inst.engine.insert('sys_user_grmember', { user: ids.admin2, group: g }, s.admin2!)).rejects.toThrow(ForbiddenError);
    await expect(inst.engine.update('sys_user_group', g, { description: 'still editable' }, s.admin2!)).resolves.toBeTruthy();
  });

  it('cannot change the credentials of a security_admin user', async () => {
    await expect(inst.engine.update('sys_user', adminId(), { user_password: 'pwned' }, s.admin2!)).rejects.toThrow(ForbiddenError);
    await expect(inst.engine.update('sys_user', adminId(), { user_name: 'renamed' }, s.admin2!)).rejects.toThrow(ForbiddenError);
    await expect(inst.engine.update('sys_user', adminId(), { email: 'ok@example.com' }, s.admin2!)).resolves.toBeTruthy();
    await expect(inst.auth.login('admin', 'admin-pw')).resolves.toBeTruthy();
  });

  it('cannot forge or redirect session tokens', async () => {
    const expires = new Date(Date.now() + 60_000).toISOString();
    await expect(inst.engine.insert('sys_user_session', { user: adminId(), token_hash: 'a'.repeat(64), expires }, s.admin2!)).rejects.toThrow(ForbiddenError);
    const { token } = await inst.auth.login('admin2', 'admin2-pw');
    const row = (await inst.engine.query('sys_user_session', { query: `user=${ids.admin2}`, fields: ['sys_id'], session: s.admin2 }))[0]!;
    await expect(inst.engine.update('sys_user_session', String(row.sys_id), { impersonating: adminId() }, s.admin2!)).rejects.toThrow(ForbiddenError);
    expect((await inst.auth.resolveToken(token)).userName).toBe('admin2');
  });

  it('cannot impersonate a holder of an elevated role it does not hold', async () => {
    const { token } = await inst.auth.login('admin2', 'admin2-pw');
    await expect(inst.auth.impersonate(token, 'admin')).rejects.toThrow(ForbiddenError);
    await expect(inst.auth.impersonate(token, 'alice')).resolves.toMatchObject({ userName: 'alice' });
  });

  it('drops an impersonation whose target later becomes privileged', async () => {
    await user('grace');
    const { token } = await inst.auth.login('imp', 'imp-pw');
    await inst.auth.impersonate(token, 'grace');
    expect((await inst.auth.resolveToken(token)).userName).toBe('grace');
    await insert('sys_user_has_role', { user: ids.grace, role: ids['role:admin'] });
    const resolved = await inst.auth.resolveToken(token);
    expect(resolved.userName).toBe('imp');
    expect(resolved.roles.has('admin')).toBe(false);
  });
});

describe('bootstrap upgrade', () => {
  it('upgrades a Phase 1 (v1) instance in place', async () => {
    const old = await Instance.create({ adminPassword: 'x' });
    try {
      const v2Tables = [
        'sys_user_role',
        'sys_user_role_contains',
        'sys_user_group',
        'sys_user_grmember',
        'sys_user_has_role',
        'sys_group_has_role',
        'sys_security_acl',
        'sys_security_acl_role',
        'sys_user_session',
      ];
      // Rewind the database to what Phase 1 created.
      await old.db.transaction(async (tx) => {
        for (const t of v2Tables) await tx.exec(`DROP TABLE "${t}"`);
        await tx.exec(`ALTER TABLE sys_user DROP COLUMN user_password, DROP COLUMN locked_out`);
        const list = v2Tables.map((t) => `'${t}'`).join(',');
        await tx.exec(`DELETE FROM sys_db_object WHERE name IN (${list})`);
        await tx.exec(`DELETE FROM sys_dictionary WHERE name IN (${list}) OR (name = 'sys_user' AND element IN ('user_password', 'locked_out'))`);
        await tx.exec(`DELETE FROM sys_choice WHERE name = 'sys_security_acl'`);
        await tx.exec(`UPDATE sys_properties SET value = '1' WHERE name = 'glide.steward.bootstrap_version'`);
      });
      expect(await bootstrapVersion(old.db)).toBe(1);

      await bootstrap(old.db);
      expect(await bootstrapVersion(old.db)).toBe(BOOTSTRAP_VERSION);
      await old.meta.load(old.db);
      await old.acl.load(old.db);
      expect(old.meta.hasTable('sys_security_acl')).toBe(true);
      expect(old.meta.field('sys_user', 'user_password').type).toBe('password');
      expect(old.acl.rulesFor('sys_security_acl', 'write')).toHaveLength(1);
      const admin = await old.auth.sessionFor({ userName: 'admin' });
      expect([...admin.roles].sort()).toEqual(['admin', 'security_admin']);

      // Running it again is a no-op.
      await bootstrap(old.db);
      expect(await old.engine.count('sys_user_role', 'name=admin')).toBe(1);
    } finally {
      await old.close();
    }
  });
});
