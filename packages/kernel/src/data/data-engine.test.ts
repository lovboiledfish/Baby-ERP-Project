import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { Instance } from '../instance';
import { systemSession } from '../session';

const admin = systemSession('admin');
let inst: Instance;
const ids: Record<string, string> = {};

async function columnsOf(table: string): Promise<string[]> {
  const res = await inst.db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return res.rows.map((r) => r.column_name);
}

beforeAll(async () => {
  inst = await Instance.create();
  const { metaApi, engine } = inst;

  await metaApi.createTable(
    { name: 'cmn_department', label: 'Department', fields: [{ element: 'name', type: 'string', mandatory: true, display: true }] },
    admin,
  );
  await metaApi.addField('sys_user', { element: 'department', type: 'reference', reference: 'cmn_department' }, admin);

  await metaApi.createTable(
    {
      name: 'task',
      label: 'Task',
      fields: [
        { element: 'number', type: 'string', maxLength: 40 },
        { element: 'short_description', type: 'string', maxLength: 160, mandatory: true },
        { element: 'active', type: 'boolean', defaultValue: true },
        { element: 'priority', type: 'integer', defaultValue: 4 },
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
      ],
    },
    admin,
  );
  await metaApi.createTable(
    {
      name: 'incident',
      extends: 'task',
      numberPrefix: 'INC',
      fields: [
        { element: 'caller', type: 'reference', reference: 'sys_user' },
        { element: 'category', type: 'string', maxLength: 40 },
      ],
    },
    admin,
  );
  await metaApi.createTable(
    {
      name: 'problem',
      extends: 'task',
      numberPrefix: 'PRB',
      fields: [
        { element: 'category', type: 'integer' }, // same element as incident.category, different type
        { element: 'root_cause', type: 'text' },
      ],
    },
    admin,
  );

  const it = await engine.insert('cmn_department', { name: 'IT' }, admin);
  const hr = await engine.insert('cmn_department', { name: 'HR' }, admin);
  ids.alice = String((await engine.insert('sys_user', { user_name: 'alice', first_name: 'Alice', last_name: 'Ng', department: it.sys_id }, admin)).sys_id);
  ids.bob = String((await engine.insert('sys_user', { user_name: 'bob', first_name: 'Bob', last_name: 'Ruiz', department: hr.sys_id }, admin)).sys_id);
});

afterAll(async () => {
  await inst.close();
});

describe('dictionary and storage', () => {
  it('stores a whole hierarchy in the root physical table', async () => {
    expect(await columnsOf('incident')).toEqual([]);
    expect(await columnsOf('problem')).toEqual([]);
    const cols = await columnsOf('task');
    expect(cols).toEqual(expect.arrayContaining(['sys_id', 'sys_class_name', 'number', 'priority', 'caller', 'category', 'problem_category', 'root_cause']));
  });

  it('allocates a separate storage column when siblings reuse an element name', () => {
    const problem = inst.metaApi.describe('problem');
    expect(problem.fields.find((f) => f.element === 'category')).toMatchObject({ type: 'integer', column: 'problem_category', definedOn: 'problem' });
    expect(inst.metaApi.describe('incident').fields.find((f) => f.element === 'category')).toMatchObject({ type: 'string', column: 'category' });
  });

  it('describes inherited fields and hierarchy', () => {
    const d = inst.metaApi.describe('incident');
    expect(d).toMatchObject({ extends: 'task', root: 'task', physical: 'task', numberPrefix: 'INC' });
    expect(d.fields.find((f) => f.element === 'priority')).toMatchObject({ definedOn: 'task' });
    expect(inst.metaApi.describe('task').children.sort()).toEqual(['incident', 'problem']);
  });

  it('system tables are records too', async () => {
    const tables = await inst.engine.query('sys_db_object', { query: 'nameINtask,incident', fields: ['name', 'super_class.name', 'physical_name'] });
    expect(tables).toEqual(
      expect.arrayContaining([
        { name: 'task', 'super_class.name': null, physical_name: 'task' },
        { name: 'incident', 'super_class.name': 'task', physical_name: 'task' },
      ]),
    );
    expect(await inst.engine.count('sys_dictionary', 'name=task')).toBe(6);
  });

  it('rejects redefining an inherited field', async () => {
    await expect(inst.metaApi.addField('incident', { element: 'priority', type: 'integer' }, admin)).rejects.toThrow(/already defined on task/);
  });

  it('rejects adding a parent field that a child already defines', async () => {
    await expect(inst.metaApi.addField('task', { element: 'caller', type: 'string' }, admin)).rejects.toThrow(/child table incident/);
  });

  it('rejects extending a non-extensible table and reserved names', async () => {
    await expect(inst.metaApi.createTable({ name: 'my_audit', extends: 'sys_audit' }, admin)).rejects.toThrow(/not extensible/);
    await expect(inst.metaApi.addField('task', { element: 'sys_foo', type: 'string' }, admin)).rejects.toThrow(/reserved/);
  });

  it('rolls back the whole table definition when any field is invalid', async () => {
    const versionBefore = inst.meta.version;
    await expect(
      inst.metaApi.createTable(
        { name: 'broken', fields: [{ element: 'ok', type: 'string' }, { element: 'bad', type: 'reference', reference: 'nope' }] },
        admin,
      ),
    ).rejects.toThrow(ValidationError);
    expect(inst.meta.version).toBeGreaterThan(versionBefore); // resynced from committed state
    expect(inst.meta.hasTable('broken')).toBe(false);
    expect(await columnsOf('broken')).toEqual([]);
    expect(await inst.engine.count('sys_db_object', 'name=broken')).toBe(0);
  });

  it('protects immutable dictionary attributes and blocks deletes', async () => {
    const [dict] = await inst.engine.query('sys_dictionary', { query: 'name=task^element=priority' });
    await expect(inst.engine.update('sys_dictionary', String(dict!.sys_id), { internal_type: 'string' }, admin)).rejects.toThrow(/cannot be changed/);
    await expect(inst.engine.delete('sys_dictionary', String(dict!.sys_id), admin)).rejects.toThrow(/not supported/);
    const updated = await inst.engine.update('sys_dictionary', String(dict!.sys_id), { column_label: 'Prio' }, admin);
    expect(updated.column_label).toBe('Prio');
    expect(inst.meta.field('incident', 'priority').label).toBe('Prio');
  });
});

describe('records', () => {
  it('applies defaults, auto-numbers per class, and sets system fields', async () => {
    const inc1 = await inst.engine.insert('incident', { short_description: 'VPN down', caller: ids.alice, category: 'network' }, admin);
    const inc2 = await inst.engine.insert('incident', { short_description: 'Printer jam', caller: ids.bob, priority: 2 }, admin);
    const prb = await inst.engine.insert('problem', { short_description: 'Flaky VPN concentrator', category: 7 }, admin);
    const task = await inst.engine.insert('task', { short_description: 'Plain task' }, admin);
    ids.inc1 = String(inc1.sys_id);
    ids.inc2 = String(inc2.sys_id);
    ids.prb = String(prb.sys_id);
    ids.task = String(task.sys_id);

    expect(inc1).toMatchObject({ number: 'INC0001000', active: true, priority: 4, state: 'new', sys_class_name: 'incident', sys_mod_count: 0, sys_created_by: 'admin' });
    expect(inc2.number).toBe('INC0001001');
    expect(prb).toMatchObject({ number: 'PRB0001000', category: 7 });
    expect(task.number).toBeNull();
    expect(typeof inc1.sys_created_on).toBe('string');
  });

  it('queries polymorphically: parent sees children, children see only themselves', async () => {
    const all = await inst.engine.query('task', { fields: ['number', 'sys_class_name'] });
    expect(all.map((r) => r.sys_class_name).sort()).toEqual(['incident', 'incident', 'problem', 'task']);
    const incidents = await inst.engine.query('incident', { fields: ['number'] });
    expect(incidents.map((r) => r.number)).toEqual(['INC0001000', 'INC0001001']);
    expect(await inst.engine.count('problem')).toBe(1);
    expect(await inst.engine.count('task', 'sys_class_nameINSTANCEOFincident')).toBe(2);
    expect(await inst.engine.get('problem', ids.inc1)).toBeNull();
  });

  it('validates mandatory fields, types, choices and unknown fields', async () => {
    await expect(inst.engine.insert('incident', { caller: ids.alice }, admin)).rejects.toThrow(/Mandatory fields are missing: short_description/);
    await expect(inst.engine.insert('incident', { short_description: 'x', priority: 'high' }, admin)).rejects.toThrow(/must be an integer/);
    await expect(inst.engine.insert('incident', { short_description: 'x', state: 'bogus' }, admin)).rejects.toThrow(/Invalid choice/);
    await expect(inst.engine.insert('incident', { short_description: 'x', nope: 1 }, admin)).rejects.toThrow(/Unknown field incident.nope/);
    await expect(inst.engine.insert('incident', { short_description: 'x', caller: 'not-a-uuid' }, admin)).rejects.toThrow(/sys_id/);
    await expect(inst.engine.insert('incident', { short_description: 'x'.repeat(161) }, admin)).rejects.toThrow(/max length/);
  });

  it('evaluates encoded queries: OR, NQ, LIKE, IN, ISEMPTY, ordering', async () => {
    const numbers = async (table: string, query: string) => (await inst.engine.query(table, { query, fields: ['number'] })).map((r) => r.number);
    expect(await numbers('incident', 'priority=2^ORcategory=network^ORDERBYnumber')).toEqual(['INC0001000', 'INC0001001']);
    expect(await numbers('task', 'short_descriptionLIKEvpn^ORDERBYDESCnumber')).toEqual(['PRB0001000', 'INC0001000']);
    expect(await numbers('task', 'numberISEMPTY')).toEqual([null]);
    expect(await numbers('incident', 'priorityIN1,2,3')).toEqual(['INC0001001']);
    expect(await numbers('incident', 'priority=2^NQcategory=network^ORDERBYDESCnumber')).toEqual(['INC0001001', 'INC0001000']);
    expect(await numbers('incident', 'short_descriptionSTARTSWITHprint')).toEqual(['INC0001001']);
    expect(await numbers('incident', 'caller!=' + ids.alice)).toEqual(['INC0001001']);
    expect(await numbers('incident', 'caller=not-a-uuid')).toEqual([]);
    await expect(inst.engine.query('incident', { query: 'bogus=1' })).rejects.toThrow(/Unknown field incident.bogus/);
    await expect(inst.engine.query('incident', { query: 'priority=abc' })).rejects.toThrow(ValidationError);
  });

  it('dot-walks references in conditions and selected fields', async () => {
    const rows = await inst.engine.query('incident', {
      query: 'caller.department.name=IT',
      fields: ['number', 'caller.name', 'caller.department.name'],
    });
    expect(rows).toEqual([{ number: 'INC0001000', 'caller.name': 'Alice Ng', 'caller.department.name': 'IT' }]);
    await expect(inst.engine.query('incident', { query: 'short_description.name=x' })).rejects.toThrow(/non-reference/);
  });

  it('returns display values', async () => {
    const [shown] = await inst.engine.query('incident', { query: `sys_id=${ids.inc1}`, fields: ['caller', 'state', 'active'], displayValue: true });
    expect(shown).toEqual({ caller: 'Alice Ng', state: 'New', active: 'true' });
    const [both] = await inst.engine.query('incident', { query: `sys_id=${ids.inc1}`, fields: ['caller'], displayValue: 'all' });
    expect(both).toEqual({ caller: { value: ids.alice, display_value: 'Alice Ng' } });
  });

  it('updates with optimistic locking and audits field changes', async () => {
    const updated = await inst.engine.update('incident', ids.inc1, { priority: 1, state: 'in_progress' }, systemSession('alice'), { expectedModCount: 0 });
    expect(updated).toMatchObject({ priority: 1, state: 'in_progress', sys_mod_count: 1, sys_updated_by: 'alice' });

    await expect(inst.engine.update('incident', ids.inc1, { priority: 3 }, admin, { expectedModCount: 0 })).rejects.toThrow(ConflictError);

    const audit = await inst.engine.query('sys_audit', {
      query: `documentkey=${ids.inc1}^record_checkpoint=1^ORDERBYfieldname`,
      fields: ['fieldname', 'oldvalue', 'newvalue', 'user'],
    });
    expect(audit).toEqual([
      { fieldname: 'priority', oldvalue: '4', newvalue: '1', user: 'alice' },
      { fieldname: 'state', oldvalue: 'new', newvalue: 'in_progress', user: 'alice' },
    ]);
    expect(await inst.engine.count('sys_audit', `documentkey=${ids.inc1}^record_checkpoint=0`)).toBeGreaterThan(0);
  });

  it('does not bump sys_mod_count for no-op updates', async () => {
    const before = await inst.engine.get('incident', ids.inc1);
    const after = await inst.engine.update('incident', ids.inc1, { priority: before!.priority }, admin);
    expect(after.sys_mod_count).toBe(before!.sys_mod_count);
  });

  it('enforces class membership on update and delete', async () => {
    await expect(inst.engine.update('problem', ids.inc1, { priority: 2 }, admin)).rejects.toThrow(NotFoundError);
  });

  it('deletes records and records a deletion audit entry', async () => {
    await inst.engine.delete('task', ids.task, admin);
    expect(await inst.engine.get('task', ids.task)).toBeNull();
    const [entry] = await inst.engine.query('sys_audit', { query: `documentkey=${ids.task}^fieldname=DELETED`, fields: ['oldvalue'] });
    expect(JSON.parse(String(entry!.oldvalue))).toMatchObject({ short_description: 'Plain task' });
    await expect(inst.engine.delete('task', ids.task, admin)).rejects.toThrow(NotFoundError);
  });

  it('composes sys_user.name via a system hook', async () => {
    const user = await inst.engine.insert('sys_user', { user_name: 'cara', first_name: 'Cara', last_name: 'Diaz' }, admin);
    expect(user.name).toBe('Cara Diaz');
    const renamed = await inst.engine.update('sys_user', String(user.sys_id), { last_name: 'Diaz-Lee' }, admin);
    expect(renamed.name).toBe('Cara Diaz-Lee');
  });

  it('maps unique violations to conflicts', async () => {
    await expect(inst.engine.insert('sys_user', { user_name: 'alice' }, admin)).rejects.toThrow(ConflictError);
  });
});

describe('GlideRecord', () => {
  it('queries, iterates and reads display values', async () => {
    const gr = inst.glideRecord('incident', admin);
    gr.addQuery('active', true);
    gr.addQuery('priority', '<=', 2).addOrCondition('category', 'network');
    gr.orderBy('number');
    await gr.query();
    const seen: string[] = [];
    while (gr.next()) seen.push(`${String(gr.getValue('number'))}:${gr.getDisplayValue('caller')}`);
    expect(seen).toEqual(['INC0001000:Alice Ng', 'INC0001001:Bob Ruiz']);
  });

  it('inserts, updates and deletes', async () => {
    const gr = inst.glideRecord('incident', admin);
    gr.initialize();
    gr.setValue('short_description', 'Created by GlideRecord');
    gr.setValue('caller', ids.bob);
    const sysId = await gr.insert();
    expect(gr.getValue('number')).toBe('INC0001002');
    expect(gr.getDisplayValue()).toBe('INC0001002');

    const again = inst.glideRecord('incident', admin);
    expect(await again.get(sysId)).toBe(true);
    again.setValue('priority', 1);
    await again.update();
    expect(again.getValue('sys_mod_count')).toBe(1);

    const byField = inst.glideRecord('incident', admin);
    expect(await byField.get('number', 'INC0001002')).toBe(true);
    expect(await byField.deleteRecord()).toBe(true);
    expect(await inst.engine.get('incident', sysId)).toBeNull();
  });

  it('supports encoded queries with dot-walking', async () => {
    const gr = inst.glideRecord('incident');
    gr.addEncodedQuery('caller.department.name=HR');
    await gr.query();
    expect(gr.getRowCount()).toBe(1);
    expect(gr.next() && gr.getValue('number')).toBe('INC0001001');
  });
});
