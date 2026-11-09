import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, bootstrapVersion, BOOTSTRAP_VERSION } from '../bootstrap/system-tables';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { Instance } from '../instance';
import { systemSession, type Session } from '../session';

let inst: Instance;
const sys = systemSession('setup');
const ids: Record<string, string> = {};
let alice: Session;
let carol: Session;
let admin: Session;

const insert = async (table: string, values: Record<string, unknown>, session: Session = sys) => String((await inst.engine.insert(table, values, session)).sys_id);

beforeAll(async () => {
  inst = await Instance.create({ adminPassword: 'admin-pw' });
  await inst.metaApi.createTable(
    {
      name: 'ticket',
      extendable: true,
      fields: [
        { element: 'title', type: 'string', mandatory: true, display: true },
        { element: 'priority', type: 'choice', defaultValue: '3', choices: [{ value: '1', label: 'High' }, { value: '2', label: 'Medium' }, { value: '3', label: 'Low' }] },
        { element: 'opened_by', type: 'reference', reference: 'sys_user' },
        { element: 'secret', type: 'string' },
        { element: 'description', type: 'text' },
        { element: 'work_notes', type: 'journal' },
        { element: 'comments', type: 'journal', mandatory: true },
      ],
    },
    sys,
  );
  await inst.metaApi.createTable({ name: 'ticket_child', extends: 'ticket', fields: [{ element: 'extra', type: 'string' }] }, sys);
  await inst.metaApi.createTable({ name: 'ticket_task', fields: [{ element: 'ticket', type: 'reference', reference: 'ticket' }, { element: 'name', type: 'string' }] }, sys);

  ids.agent = await insert('sys_user_role', { name: 'agent' });
  ids.manager = await insert('sys_user_role', { name: 'manager' });
  ids.alice = await insert('sys_user', { user_name: 'alice', first_name: 'Alice', user_password: 'pw' });
  ids.carol = await insert('sys_user', { user_name: 'carol', first_name: 'Carol', user_password: 'pw' });
  await insert('sys_user_has_role', { user: ids.alice, role: ids.agent });

  const acl = async (name: string, operation: string, condition: string | null, roles: string[]) => {
    const id = await insert('sys_security_acl', { name, operation, condition });
    for (const r of roles) await insert('sys_security_acl_role', { sys_security_acl: id, sys_user_role: r });
  };
  await acl('ticket', 'read', null, [ids.agent]);
  await acl('ticket', 'read', 'opened_by=javascript:gs.getUserID()', []);
  await acl('ticket', 'write', null, [ids.agent]);
  await acl('ticket', 'create', null, []);
  await acl('ticket.secret', 'read', null, [ids.agent]);
  await acl('ticket.secret', 'write', null, [ids.agent]);
  await acl('ticket.work_notes', 'read', null, [ids.agent]);
  await acl('ticket.work_notes', 'write', null, [ids.agent]);
  await acl('ticket.comments', 'write', null, [ids.manager]);
  await acl('ticket.priority', 'write', 'opened_by=javascript:gs.getUserID()', []);

  ids.t1 = await insert('ticket', { title: 'Carol printer', opened_by: ids.carol, secret: 's1', comments: 'opened' });
  ids.t2 = await insert('ticket', { title: 'Other', comments: 'x' });
  ids.t3 = await insert('ticket', { title: 'Alice laptop', opened_by: ids.alice, comments: 'x' });
  ids.c1 = await insert('ticket_child', { title: 'Child', opened_by: ids.carol, comments: 'x' });

  alice = await inst.sessionFor('alice');
  carol = await inst.sessionFor('carol');
  admin = await inst.sessionFor('admin');
});

afterAll(async () => {
  await inst.close();
});

describe('journal fields', () => {
  it('stores entries in sys_journal_field, never in the column', async () => {
    const raw = await inst.db.query<{ work_notes: string | null; comments: string | null }>(`SELECT work_notes, comments FROM ticket WHERE sys_id = $1`, [ids.t1]);
    expect(raw.rows[0]).toEqual({ work_notes: null, comments: null });
    const entries = await inst.engine.query('sys_journal_field', { query: `element_id=${ids.t1}` });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'ticket', element: 'comments', value: 'opened', sys_created_by: 'setup' });
  });

  it('a journal-only update writes the entry and bumps sys_mod_count; blank notes are ignored', async () => {
    const before = (await inst.engine.get('ticket', ids.t3))!;
    await inst.engine.update('ticket', ids.t3, { work_notes: 'checked the laptop' }, alice);
    const after = (await inst.engine.get('ticket', ids.t3))!;
    expect(after.sys_mod_count).toBe((before.sys_mod_count as number) + 1);
    expect(after.sys_updated_by).toBe('alice');
    expect(after.work_notes).toBeNull();
    const notes = await inst.engine.query('sys_journal_field', { query: `element_id=${ids.t3}^element=work_notes` });
    expect(notes.map((n) => [n.value, n.sys_created_by])).toEqual([['checked the laptop', 'alice']]);

    await inst.engine.update('ticket', ids.t3, { work_notes: '   ' }, alice);
    expect((await inst.engine.get('ticket', ids.t3))!.sys_mod_count).toBe(after.sys_mod_count);
  });

  it('enforces field write ACLs on journal fields and mandatory journals only on insert', async () => {
    await expect(inst.engine.update('ticket', ids.t3, { comments: 'hi' }, alice)).rejects.toThrow(ForbiddenError);
    await expect(insert('ticket', { title: 'no comment' })).rejects.toThrow(/Mandatory fields are missing: comments/);
    await expect(insert('ticket', { title: 'blank comment', comments: '   ' })).rejects.toThrow(/Mandatory fields are missing: comments/);
    await expect(inst.engine.update('ticket', ids.t3, { title: 'Alice laptop (2)' }, alice)).resolves.toBeTruthy();
  });

  it('journal entries roll back with a failed write', async () => {
    const count = await inst.engine.count('sys_journal_field');
    await expect(inst.engine.update('ticket', ids.t3, { work_notes: 'x', priority: '9' }, alice)).rejects.toThrow(ValidationError);
    expect(await inst.engine.count('sys_journal_field')).toBe(count);
  });
});

describe('list layouts', () => {
  it('generates default columns from the dictionary, filtered by field ACLs', async () => {
    const a = await inst.ui.listLayout('ticket', undefined, alice);
    expect(a.layoutId).toBeNull();
    expect(a.columns.map((c) => c.path)).toEqual(['title', 'priority', 'opened_by', 'secret', 'sys_updated_on']);
    const c = await inst.ui.listLayout('ticket', undefined, carol);
    expect(c.columns.map((x) => x.path)).toEqual(['title', 'priority', 'opened_by', 'sys_updated_on']);
    expect(c.fields.map((f) => f.element)).not.toContain('secret');
    expect(c.fields.map((f) => f.element)).not.toContain('work_notes');
    expect(c.canCreate).toBe(true);
    expect(c.table.displayField).toBe('title');
    expect(c.fields.find((f) => f.element === 'opened_by')!.referenceDisplayField).toBe('name');
  });

  it('uses sys_ui_list records (inherited by child tables, view falls back to default)', async () => {
    const id = await insert('sys_ui_list', { name: 'ticket', elements: ' title , opened_by.name,secret,title ' }, admin);
    const row = (await inst.engine.get('sys_ui_list', id))!;
    expect(row).toMatchObject({ elements: 'title,opened_by.name,secret', view: 'default' });

    const a = await inst.ui.listLayout('ticket', 'mobile', alice);
    expect(a).toMatchObject({ layoutId: id, layoutTable: 'ticket', layoutView: 'default', view: 'mobile' });
    expect(a.columns.map((c) => c.path)).toEqual(['title', 'opened_by.name', 'secret']);
    expect(a.columns[1]).toMatchObject({ label: 'Opened By . Name', type: 'string' });
    const c = await inst.ui.listLayout('ticket_child', undefined, carol);
    expect(c.layoutTable).toBe('ticket');
    expect(c.columns.map((x) => x.path)).toEqual(['title', 'opened_by.name']);
  });

  it('rejects invalid layouts', async () => {
    await expect(insert('sys_ui_list', { name: 'ticket', view: 'v2', elements: 'title,nope' })).rejects.toThrow(/unknown fields on ticket: nope/);
    await expect(insert('sys_ui_list', { name: 'ticket', view: 'v3', elements: 'title.name' })).rejects.toThrow(ValidationError);
    await expect(insert('sys_ui_list', { name: 'nope', elements: 'x' })).rejects.toThrow(/does not exist/);
    await expect(insert('sys_ui_list', { name: 'ticket', view: 'Bad View', elements: 'title' })).rejects.toThrow(/invalid view/);
    await expect(insert('sys_ui_list', { name: 'ticket', view: 'v4', elements: ' , ' })).rejects.toThrow(/at least one field/);
    await expect(insert('sys_ui_form', { name: 'ticket', view: 'v5', related_lists: 'sys_user.name' })).rejects.toThrow(/invalid related list/);
  });

  it('is unavailable for unreadable tables', async () => {
    await expect(inst.ui.listLayout('ticket_task', undefined, carol)).rejects.toThrow(ForbiddenError);
    await expect(inst.ui.listLayout('nope', undefined, carol)).rejects.toThrow(NotFoundError);
  });
});

describe('form layouts', () => {
  it('describes a new record with defaults and create access per field', async () => {
    const f = await inst.ui.formLayout('ticket', '-1', undefined, carol);
    expect(f.isNew).toBe(true);
    expect(f.record.priority).toEqual({ value: '3', display_value: 'Low' });
    expect(f.access.canCreate).toBe(true);
    expect(f.access.fields.title).toEqual({ write: true });
    expect(f.access.fields.secret).toBeUndefined(); // not even readable
    expect(f.sections).toHaveLength(1);
    expect(f.sections[0]!.elements).toEqual(['title', 'priority', 'opened_by', 'description', 'comments']);
    expect(f.relatedLists).toEqual([]);

    const a = await inst.ui.formLayout('ticket', null, undefined, alice);
    expect(a.access.fields.secret).toEqual({ write: true });
    expect(a.access.fields.comments).toEqual({ write: false });
    expect(a.sections[0]!.elements).toEqual(['title', 'priority', 'opened_by', 'secret', 'description', 'work_notes', 'comments']);
  });

  it('evaluates write ACLs (including conditional field rules) against the record', async () => {
    const a1 = await inst.ui.formLayout('ticket', ids.t1, undefined, alice);
    expect(a1.access).toMatchObject({ canWrite: true, canDelete: false });
    expect(a1.access.fields.title).toEqual({ write: true });
    expect(a1.access.fields.priority).toEqual({ write: false }); // alice did not open t1
    expect(a1.access.fields.sys_created_on).toEqual({ write: false }); // system field
    const a3 = await inst.ui.formLayout('ticket', ids.t3, undefined, alice);
    expect(a3.access.fields.priority).toEqual({ write: true });

    const c1 = await inst.ui.formLayout('ticket', ids.t1, undefined, carol);
    expect(c1.access.canWrite).toBe(false);
    expect(Object.values(c1.access.fields).every((x) => !x.write)).toBe(true);
    expect(c1.record.opened_by).toEqual({ value: ids.carol, display_value: 'Carol' });
    expect(c1.record).not.toHaveProperty('secret');
    await expect(inst.ui.formLayout('ticket', ids.t2, undefined, carol)).rejects.toThrow(NotFoundError);
    await expect(inst.ui.formLayout('ticket', 'not-a-uuid', undefined, admin)).rejects.toThrow(NotFoundError);
  });

  it('uses sys_ui_form + sys_ui_section and hides unreadable fields', async () => {
    const form = await insert('sys_ui_form', { name: 'ticket' }, admin);
    await insert('sys_ui_section', { form, caption: 'Notes', position: 200, elements: 'secret,work_notes,comments' }, admin);
    await insert('sys_ui_section', { form, caption: 'Main', position: 100, elements: 'title,opened_by' }, admin);
    await expect(insert('sys_ui_section', { form, caption: 'Bad', elements: 'nope' })).rejects.toThrow(/unknown fields/);

    const a = await inst.ui.formLayout('ticket', ids.t1, undefined, alice);
    expect(a.sections).toEqual([
      { caption: 'Main', elements: ['title', 'opened_by'] },
      { caption: 'Notes', elements: ['secret', 'work_notes', 'comments'] },
    ]);
    const c = await inst.ui.formLayout('ticket', ids.t1, undefined, carol);
    expect(c.sections[1]).toEqual({ caption: 'Notes', elements: ['comments'] });
    const child = await inst.ui.formLayout('ticket_child', ids.c1, undefined, carol);
    expect(child.layoutTable).toBe('ticket');
  });

  it('reports the actual class of a record opened through a parent table only when the caller can read the child table', async () => {
    const f = await inst.ui.formLayout('ticket', ids.c1, undefined, admin);
    expect(f.recordClass).toBe('ticket_child');
    expect((await inst.ui.formLayout('ticket_child', ids.c1, undefined, admin)).recordClass).toBeNull();

    // Restrict ticket_child read to manager role (carol can still read parent ticket via opened_by=gs.getUserID()).
    const childAcl = await insert('sys_security_acl', { name: 'ticket_child', operation: 'read' });
    await insert('sys_security_acl_role', { sys_security_acl: childAcl, sys_user_role: ids.manager });
    await inst.engine.update('ticket_child', ids.c1, { extra: 'child-only' }, sys);
    try {
      const asCarol = await inst.ui.formLayout('ticket', ids.c1, undefined, carol);
      expect(asCarol.recordClass).toBeNull();
      expect(asCarol.record.title).toEqual({ value: 'Child', display_value: 'Child' });

      const actCarol = await inst.ui.activity('ticket', ids.c1, carol);
      expect(actCarol.some((e) => e.field === 'comments')).toBe(true);
      expect(actCarol.some((e) => e.field === 'extra')).toBe(false);

      const actAdmin = await inst.ui.activity('ticket', ids.c1, admin);
      expect(actAdmin.some((e) => e.field === 'extra' && e.type === 'audit' && e.new_value === 'child-only')).toBe(true);
    } finally {
      await inst.engine.delete('sys_security_acl', childAcl, sys);
    }
  });

  it('derives related lists from incoming references, filtered by ACLs', async () => {
    const asAdmin = await inst.ui.formLayout('sys_user', ids.carol, undefined, admin);
    const names = asAdmin.relatedLists.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['ticket.opened_by', 'sys_user_has_role.user', 'sys_user_grmember.user']));
    const asCarol = await inst.ui.formLayout('sys_user', ids.carol, undefined, carol);
    expect(asCarol.relatedLists.map((r) => r.name).sort()).toEqual(['sys_user_group.manager', 'ticket.opened_by']);
    expect(asCarol.relatedLists.find((r) => r.table === 'ticket')).toMatchObject({ field: 'opened_by', parentField: 'sys_id', label: 'Ticket' });

    const t = await inst.ui.formLayout('ticket', ids.t1, undefined, admin);
    expect(t.relatedLists.map((r) => r.name)).toEqual(['ticket_task.ticket']);
    expect((await inst.ui.formLayout('ticket', ids.t1, undefined, alice)).relatedLists).toEqual([]);

    const tableRec = (await inst.engine.query('sys_db_object', { query: 'name=ticket' }))[0]!;
    const dbo = await inst.ui.formLayout('sys_db_object', String(tableRec.sys_id), undefined, admin);
    expect(dbo.relatedLists.map((r) => r.name)).toEqual(expect.arrayContaining(['sys_dictionary.name=name', 'sys_choice.name=name', 'sys_db_object.super_class']));
  });

  it('uses configured related lists when the form layout lists them', async () => {
    await insert('sys_ui_form', { name: 'sys_user', related_lists: 'sys_user_has_role.user, ticket.opened_by' }, admin);
    const f = await inst.ui.formLayout('sys_user', ids.carol, undefined, admin);
    expect(f.relatedLists.map((r) => r.name)).toEqual(['sys_user_has_role.user', 'ticket.opened_by']);
    expect(f.relatedListConfig).toEqual(['sys_user_has_role.user', 'ticket.opened_by']);
  });
});

describe('activity stream', () => {
  it('merges journal entries and audit rows, filtered by field read ACLs', async () => {
    await inst.engine.update('ticket', ids.t1, { work_notes: 'internal note', secret: 's2', priority: '1', opened_by: ids.alice }, sys);
    const a = await inst.ui.activity('ticket', ids.t1, alice);
    expect(a.some((e) => e.type === 'journal' && e.field === 'work_notes' && e.value === 'internal note')).toBe(true);
    expect(a.some((e) => e.type === 'audit' && e.field === 'secret' && e.new_value === 's2')).toBe(true);
    const prio = a.find((e) => e.type === 'audit' && e.field === 'priority' && e.new_value === '1');
    expect(prio).toMatchObject({ old_display: 'Low', new_display: 'High' });
    const ref = a.find((e) => e.type === 'audit' && e.field === 'opened_by' && e.new_value === ids.alice);
    expect(ref).toMatchObject({ old_display: 'Carol', new_display: 'Alice' });
    // newest first
    const times = a.map((e) => e.created_on);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('hides the record entirely from users who cannot read it', async () => {
    // t1 no longer belongs to carol after the previous update
    await expect(inst.ui.activity('ticket', ids.t1, carol)).rejects.toThrow(NotFoundError);
    await inst.engine.update('ticket', ids.t1, { opened_by: ids.carol }, sys);
    const c = await inst.ui.activity('ticket', ids.t1, carol);
    expect(c.some((e) => e.field === 'work_notes' || e.field === 'secret')).toBe(false);
    expect(c.some((e) => e.type === 'journal' && e.field === 'comments')).toBe(true);
    await expect(inst.ui.activity('ticket', ids.t2, carol)).rejects.toThrow(NotFoundError);
  });

  it('never shows password values', async () => {
    await inst.engine.update('sys_user', ids.carol, { user_password: 'new-pw' }, sys);
    const a = await inst.ui.activity('sys_user', ids.carol, admin);
    const pw = a.find((e) => e.type === 'audit' && e.field === 'user_password');
    expect(pw).toMatchObject({ old_value: null, new_value: null, old_display: null, new_display: null });
  });
});

describe('bootstrap v3 upgrade', () => {
  it('adds the UI and journal tables to a Phase 2 (v2) instance', async () => {
    const old = await Instance.create({ adminPassword: 'x' });
    try {
      const v3 = ['sys_ui_list', 'sys_ui_form', 'sys_ui_section', 'sys_journal_field'];
      const list = v3.map((t) => `'${t}'`).join(',');
      await old.db.transaction(async (tx) => {
        for (const t of v3) await tx.exec(`DROP TABLE "${t}"`);
        await tx.exec(`DELETE FROM sys_db_object WHERE name IN (${list})`);
        await tx.exec(`DELETE FROM sys_dictionary WHERE name IN (${list})`);
        await tx.exec(`UPDATE sys_properties SET value = '2' WHERE name = 'glide.steward.bootstrap_version'`);
      });
      expect(await bootstrapVersion(old.db)).toBe(2);
      await bootstrap(old.db);
      expect(await bootstrapVersion(old.db)).toBe(BOOTSTRAP_VERSION);
      await old.meta.load(old.db);
      for (const t of v3) expect(old.meta.hasTable(t)).toBe(true);
      expect(await old.engine.count('sys_ui_list', 'name=sys_user')).toBe(1);
      const idx = await old.db.query(`SELECT 1 FROM pg_indexes WHERE tablename = 'sys_journal_field' AND indexdef LIKE '%element_id%'`);
      expect(idx.rows).toHaveLength(1);
    } finally {
      await old.close();
    }
  });
});
