import { describe, expect, it } from 'vitest';
import { EncodedQueryError, parseEncodedQuery, stringifyEncodedQuery } from './encoded-query';

describe('parseEncodedQuery', () => {
  it('parses AND / OR / NQ structure', () => {
    const ast = parseEncodedQuery('active=true^priority<=2^ORpriority=5^NQshort_descriptionLIKEvpn');
    expect(ast.groups).toEqual([
      [
        [{ field: 'active', operator: '=', value: 'true' }],
        [
          { field: 'priority', operator: '<=', value: '2' },
          { field: 'priority', operator: '=', value: '5' },
        ],
      ],
      [[{ field: 'short_description', operator: 'LIKE', value: 'vpn' }]],
    ]);
  });

  it('parses every operator, longest match first', () => {
    const q = [
      'a=1', 'b!=2', 'c<3', 'd<=4', 'e>5', 'f>=6', 'gLIKEx', 'hNOT LIKEy', 'iSTARTSWITHab', 'jENDSWITHcd',
      'kIN1,2,3', 'lNOT IN4,5', 'mISEMPTY', 'nISNOTEMPTY', 'sys_class_nameINSTANCEOFtask',
    ].join('^');
    const ops = parseEncodedQuery(q).groups[0]!.map((clause) => clause[0]!.operator);
    expect(ops).toEqual([
      '=', '!=', '<', '<=', '>', '>=', 'LIKE', 'NOT LIKE', 'STARTSWITH', 'ENDSWITH', 'IN', 'NOT IN', 'ISEMPTY', 'ISNOTEMPTY', 'INSTANCEOF',
    ]);
  });

  it('supports dot-walked fields and ORDERBY', () => {
    const ast = parseEncodedQuery('caller.department.name=IT^ORDERBYDESCsys_created_on^ORDERBYnumber');
    expect(ast.groups[0]![0]![0]!.field).toBe('caller.department.name');
    expect(ast.orderBy).toEqual([
      { field: 'sys_created_on', desc: true },
      { field: 'number', desc: false },
    ]);
  });

  it('treats ^^ as a literal caret', () => {
    const ast = parseEncodedQuery('short_description=a^^b^priority=1');
    expect(ast.groups[0]).toEqual([
      [{ field: 'short_description', operator: '=', value: 'a^b' }],
      [{ field: 'priority', operator: '=', value: '1' }],
    ]);
  });

  it('allows empty values and ignores EQ / empty terms', () => {
    const ast = parseEncodedQuery('assigned_to=^^EQ');
    // "assigned_to=^^EQ" -> value "^EQ" because ^^ is an escape
    expect(ast.groups[0]![0]![0]!.value).toBe('^EQ');
    expect(parseEncodedQuery('assigned_to=^EQ').groups[0]![0]![0]!.value).toBe('');
    expect(parseEncodedQuery('')).toEqual({ groups: [], orderBy: [] });
  });

  it('rejects malformed queries', () => {
    expect(() => parseEncodedQuery('^ORa=1')).toThrow(EncodedQueryError);
    expect(() => parseEncodedQuery('Priority=1')).toThrow(EncodedQueryError);
    expect(() => parseEncodedQuery('priority~1')).toThrow(EncodedQueryError);
    expect(() => parseEncodedQuery('activeISEMPTYx')).toThrow(EncodedQueryError);
  });
});

describe('stringifyEncodedQuery', () => {
  const canonical = [
    'active=true',
    'active=true^priority<=2^ORpriority=5^NQshort_descriptionLIKEvpn',
    'caller.department.name=IT^stateINnew,in_progress^ORDERBYDESCsys_created_on',
    'short_description=a^^b^assigned_toISEMPTY',
    'ORDERBYnumber',
  ];

  it.each(canonical)('round-trips %s', (q) => {
    const ast = parseEncodedQuery(q);
    expect(stringifyEncodedQuery(ast)).toBe(q);
    expect(parseEncodedQuery(stringifyEncodedQuery(ast))).toEqual(ast);
  });
});
