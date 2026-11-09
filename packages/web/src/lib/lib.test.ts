import { describe, expect, it } from 'vitest';
import {
  andQueries,
  astToBuilder,
  blankRow,
  breadcrumbs,
  builderToAst,
  describeCondition,
  newRow,
  operatorsFor,
  prefillFromQuery,
  safeParse,
  withOrder,
  type CondField,
} from './conditions';
import { formUrl, listUrl, parseRoute, resolveRoute, scriptsUrl, tableBuilderUrl } from './routes';
import { fromInputValue, InputError, isEmptyInput, toInputValue } from './values';
import { parseEncodedQuery, stringifyEncodedQuery } from '@steward/shared';
import { withQuery } from './api';
import { fieldSpec, parseChoices } from '../components/TableBuilder';

const fields: CondField[] = [
  { element: 'title', label: 'Title', type: 'string', reference: null, choices: [] },
  { element: 'priority', label: 'Priority', type: 'choice', reference: null, choices: [{ value: '1', label: 'High' }, { value: '3', label: 'Low' }] },
  { element: 'opened_by', label: 'Opened by', type: 'reference', reference: 'sys_user', choices: [] },
  { element: 'secret', label: 'Secret', type: 'password', reference: null, choices: [] },
];

describe('routes', () => {
  it('parses ServiceNow-style URLs', () => {
    expect(parseRoute('/now/nav', '')).toEqual({ kind: 'home' });
    expect(parseRoute('/', '')).toEqual({ kind: 'home' });
    expect(parseRoute('/incident_list.do', '?sysparm_query=active%3Dtrue%5Epriority%3D1&sysparm_offset=20')).toEqual({
      kind: 'list',
      table: 'incident',
      query: 'active=true^priority=1',
      offset: 20,
      view: '',
    });
    expect(parseRoute('/incident_list.do', '?sysparm_offset=-5')).toMatchObject({ offset: 0 });
    expect(parseRoute('/incident_list.do', '?sysparm_offset=abc')).toMatchObject({ offset: 0 });
    expect(parseRoute('/incident.do', '?sys_id=abc&sysparm_view=mobile')).toEqual({ kind: 'form', table: 'incident', sysId: 'abc', query: '', view: 'mobile' });
    expect(parseRoute('/incident.do', '')).toMatchObject({ kind: 'form', sysId: '-1' });
    expect(parseRoute('/now/table_builder', '?table=u_x')).toEqual({ kind: 'table_builder', table: 'u_x' });
    expect(parseRoute('/sys.scripts.do', '')).toEqual({ kind: 'scripts' });
    expect(parseRoute('/now/scripts', '')).toEqual({ kind: 'scripts' });
    expect(scriptsUrl()).toBe('/sys.scripts.do');
    expect(parseRoute('/Incident.do', '')).toEqual({ kind: 'not_found', path: '/Incident.do' });
    expect(parseRoute('/../etc.do', '')).toMatchObject({ kind: 'not_found' });
  });

  it('resolves /x_list.do to the form of table x_list when x does not exist', () => {
    const r = parseRoute('/u_x_list.do', '');
    expect(resolveRoute(r, new Set(['u_x_list']))).toMatchObject({ kind: 'form', table: 'u_x_list' });
    expect(resolveRoute(r, new Set(['u_x', 'u_x_list']))).toMatchObject({ kind: 'list', table: 'u_x' });
  });

  it('builds URLs that round-trip', () => {
    const url = listUrl('incident', { query: 'short_descriptionLIKEa&b^ORDERBYnumber', offset: 40 });
    const u = new URL(url, 'http://x');
    expect(parseRoute(u.pathname, u.search)).toMatchObject({ table: 'incident', query: 'short_descriptionLIKEa&b^ORDERBYnumber', offset: 40 });
    expect(listUrl('incident')).toBe('/incident_list.do');
    expect(formUrl('incident', '-1', { query: 'caller=abc' })).toBe('/incident.do?sys_id=-1&sysparm_query=caller%3Dabc');
    expect(tableBuilderUrl()).toBe('/now/table_builder');
    expect(withQuery('/api/x', { a: 'b c', skip: undefined, empty: '', n: 0 })).toBe('/api/x?a=b+c&n=0');
  });
});

describe('condition builder model', () => {
  it('offers operators per type', () => {
    expect(operatorsFor('string')).toContain('LIKE');
    expect(operatorsFor('integer')).toContain('<=');
    expect(operatorsFor('integer')).not.toContain('LIKE');
    expect(operatorsFor('boolean')).toEqual(['=', '!=']);
    expect(operatorsFor('reference')).not.toContain('<');
    expect(operatorsFor('sys_class_name')).toContain('INSTANCEOF');
  });

  it('round-trips queries through the builder', () => {
    const q = 'priority=1^ORpriority=3^titleLIKEvpn^NQopened_byISEMPTY^ORDERBYDESCtitle';
    const ast = parseEncodedQuery(q);
    const b = astToBuilder(ast);
    expect(b).toHaveLength(2);
    expect(b[0]![0]).toHaveLength(2);
    expect(stringifyEncodedQuery(builderToAst(b, ast.orderBy))).toBe(q);
  });

  it('drops incomplete rows instead of turning them into "is empty"', () => {
    const b = [[[blankRow(fields)], [newRow({ field: 'title', operator: 'LIKE', value: 'x' })]], [[newRow({ field: 'opened_by', operator: 'ISEMPTY', value: 'junk' })]]];
    expect(stringifyEncodedQuery(builderToAst(b))).toBe('titleLIKEx^NQopened_byISEMPTY');
    expect(stringifyEncodedQuery(builderToAst([[[blankRow(fields)]]]))).toBe('');
  });

  it('escapes ^ in values', () => {
    const b = [[[newRow({ field: 'title', operator: '=', value: 'a^b' })]]];
    const q = stringifyEncodedQuery(builderToAst(b));
    expect(q).toBe('title=a^^b');
    expect(parseEncodedQuery(q).groups[0]![0]![0]!.value).toBe('a^b');
  });

  it('sorts, composes and survives garbage', () => {
    expect(withOrder('title=a^ORDERBYpriority', 'title', true)).toBe('title=a^ORDERBYDESCtitle');
    expect(safeParse('Bad Query!!')).toEqual({ groups: [], orderBy: [] });
    expect(andQueries('ref=1', '')).toBe('ref=1');
    expect(andQueries('', 'a=1^ORDERBYa')).toBe('a=1^ORDERBYa');
    expect(andQueries('ref=1', 'a=1^NQb=2')).toBe('ref=1^a=1^NQref=1^b=2');
  });

  it('describes conditions and builds breadcrumbs', () => {
    expect(describeCondition({ field: 'priority', operator: 'IN', value: '1,3' }, fields)).toBe('Priority is one of High, Low');
    expect(describeCondition({ field: 'title', operator: 'ISEMPTY', value: '' }, fields)).toBe('Title is empty');
    const crumbs = breadcrumbs('priority=1^titleLIKEx^ORtitleLIKEy^ORDERBYtitle', fields);
    expect(crumbs.map((c) => c.label)).toEqual(['Priority is High', 'Title contains x or Title contains y']);
    expect(crumbs[0]!.query).toBe('priority=1^ORDERBYtitle');
    expect(breadcrumbs('a=1^NQb=2', fields)).toHaveLength(1);
    expect(breadcrumbs('', fields)).toEqual([]);
  });

  it('extracts prefill values from simple equality queries only', () => {
    expect(prefillFromQuery('opened_by=abc^title=x')).toEqual({ opened_by: 'abc', title: 'x' });
    expect(prefillFromQuery('opened_by=abc^ORopened_by=def')).toEqual({});
    expect(prefillFromQuery('a=1^NQb=2')).toEqual({});
    expect(prefillFromQuery('caller.name=x^titleLIKEy')).toEqual({});
  });
});

describe('form values', () => {
  it('converts between API values and inputs', () => {
    expect(toInputValue('boolean', true)).toBe(true);
    expect(toInputValue('boolean', null)).toBe(false);
    expect(toInputValue('string', null)).toBe('');
    expect(toInputValue('json', { a: 1 })).toBe('{\n  "a": 1\n}');
    const local = toInputValue('datetime', '2026-01-02T03:04:05.000Z') as string;
    expect(fromInputValue('datetime', local)).toBe('2026-01-02T03:04:05.000Z');
    expect(toInputValue('datetime', 'garbage')).toBe('');
    expect(fromInputValue('integer', '42')).toBe(42);
    expect(fromInputValue('integer', '')).toBeNull();
    expect(() => fromInputValue('integer', '4.2', 'Count')).toThrow(InputError);
    expect(() => fromInputValue('json', '{', 'Data')).toThrow(/valid JSON/);
    expect(fromInputValue('boolean', false)).toBe(false);
    expect(fromInputValue('string', '')).toBeNull();
    expect(fromInputValue('string', '  x ')).toBe('  x ');
    expect(isEmptyInput('  ')).toBe(true);
    expect(isEmptyInput(false)).toBe(false);
  });
});

describe('table builder specs', () => {
  it('parses choices and builds Meta API field specs', () => {
    expect(parseChoices('1=High\n 2 = Medium \n\nlow')).toEqual([
      { value: '1', label: 'High' },
      { value: '2', label: 'Medium' },
      { value: 'low', label: 'low' },
    ]);
    const base = { key: 1, label: '', reference: '', mandatory: false, display: false, maxLength: '', defaultValue: '', choices: '' };
    expect(fieldSpec({ ...base, element: ' model ', type: 'string', maxLength: '20', mandatory: true })).toEqual({ element: 'model', type: 'string', maxLength: 20, mandatory: true });
    expect(fieldSpec({ ...base, element: 'owner', type: 'reference', reference: 'sys_user', maxLength: '20' })).toEqual({ element: 'owner', type: 'reference', reference: 'sys_user' });
    expect(fieldSpec({ ...base, element: 's', type: 'choice', choices: 'a=A' })).toEqual({ element: 's', type: 'choice', choices: [{ value: 'a', label: 'A' }] });
  });
});
