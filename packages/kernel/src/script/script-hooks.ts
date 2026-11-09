import { EncodedQueryError, parseEncodedQuery } from '@steward/shared';
import type { HookRegistry, SystemHook } from '../data/hooks';
import { compileSelect } from '../data/query-compiler';
import { StewardError, ValidationError } from '../errors';
import { resolveDynamic } from '../security/dynamic';
import { SYSTEM_SESSION } from '../session';
import { checkScriptSyntax } from './sandbox';

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/;

const RESERVED_GLOBALS: ReadonlySet<string> = new Set([
  'gs',
  'GlideRecord',
  'GlideRecordSecure',
  'GlideDateTime',
  'Class',
  'current',
  'previous',
  'answer',
  'globalThis',
  'global',
  'eval',
  'undefined',
  'NaN',
  'Infinity',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Date',
  'Math',
  'JSON',
  'RegExp',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Promise',
  'Proxy',
  'Reflect',
  'Symbol',
]);

/**
 * Hooks that validate Business Rules (`sys_script`) and Script Includes (`sys_script_include`)
 * on save and keep `ScriptService` in sync within the same transaction.
 */
export function scriptHooks(): SystemHook[] {
  const reload: SystemHook['run'] = async ({ engine }) => {
    await engine.scripts?.load(engine.db);
  };

  return [
    {
      name: 'sys_script: validate',
      table: 'sys_script',
      when: 'before',
      operations: ['insert', 'update'],
      run({ engine, current }) {
        const { meta } = engine;
        const name = String(current.name ?? '').trim();
        if (!name) throw new ValidationError('Business rule name is required');
        current.name = name;

        const collection = String(current.collection ?? '').trim();
        if (!meta.hasTable(collection)) {
          throw new ValidationError(`Business rule "${name}": table "${collection}" does not exist`);
        }
        current.collection = collection;

        const filterCond = typeof current.filter_condition === 'string' ? current.filter_condition.trim() : '';
        if (filterCond) {
          try {
            const ast = resolveDynamic(parseEncodedQuery(filterCond), SYSTEM_SESSION);
            compileSelect(meta, { table: collection, query: ast, fields: ['sys_id'] });
          } catch (e) {
            if (e instanceof EncodedQueryError || e instanceof StewardError) {
              throw new ValidationError(`Business rule "${name}": invalid filter condition`, e.message);
            }
            throw e;
          }
          current.filter_condition = filterCond;
        } else {
          current.filter_condition = null;
        }

        const cond = typeof current.condition === 'string' ? current.condition.trim() : '';
        if (cond) {
          checkScriptSyntax(cond, { expression: true, label: `Business rule "${name}"` });
          current.condition = cond;
        } else {
          current.condition = null;
        }

        const script = typeof current.script === 'string' ? current.script : '';
        if (!script.trim()) throw new ValidationError(`Business rule "${name}": script is required`);
        checkScriptSyntax(script, { label: `Business rule "${name}"` });
      },
    },
    {
      name: 'sys_script: reload cache',
      table: 'sys_script',
      when: 'after',
      operations: ['insert', 'update', 'delete'],
      run: reload,
    },
    {
      name: 'sys_script_include: validate',
      table: 'sys_script_include',
      when: 'before',
      operations: ['insert', 'update'],
      run({ current }) {
        const name = String(current.name ?? '').trim();
        if (!IDENT_RE.test(name)) {
          throw new ValidationError(`Invalid script include name "${name}"`, 'Must be a valid JavaScript identifier');
        }
        if (RESERVED_GLOBALS.has(name)) {
          throw new ValidationError(`Script include name "${name}" is reserved by the platform`);
        }
        current.name = name;
        current.api_name = `global.${name}`;

        const script = typeof current.script === 'string' ? current.script : '';
        if (!script.trim()) throw new ValidationError(`Script include "${name}": script is required`);
        checkScriptSyntax(script, { label: `Script include "${name}"` });
      },
    },
    {
      name: 'sys_script_include: reload cache',
      table: 'sys_script_include',
      when: 'after',
      operations: ['insert', 'update', 'delete'],
      run: reload,
    },
  ];
}

export function registerScriptHooks(registry: HookRegistry): void {
  registry.register(...scriptHooks());
}
