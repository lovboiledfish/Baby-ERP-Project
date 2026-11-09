/**
 * In-isolate JavaScript prelude.
 *
 * Captures `__host` and `__init` inside a private closure, deletes both from `globalThis`,
 * and installs the ServiceNow-style server scripting globals:
 *   - `gs` (GlideSystem)
 *   - `GlideRecord` (system context) and `GlideRecordSecure` (caller ACL context)
 *   - `GlideDateTime`
 *   - `Class.create()`
 *   - `current` and `previous` (when running a Business Rule or ACL script)
 *   - Lazy getters on `globalThis` (and `globalThis.global`) for every active Script Include
 */
export const SANDBOX_PRELUDE = `
(() => {
  const host = globalThis.__host;
  const init = globalThis.__init;
  delete globalThis.__host;
  delete globalThis.__init;

  const call = (op, payload) => host.applySyncPromise(undefined, [op, payload], { arguments: { copy: true } });

  const formatArg = (v) => {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  };

  const formatMsg = (args) => args.map(formatArg).join(' ');

  // --------------------------------------------------------------- Class.create
  globalThis.Class = Object.freeze({
    create() {
      return function ServiceNowClass(...args) {
        if (typeof this.initialize === 'function') {
          this.initialize(...args);
        }
      };
    },
  });

  // -------------------------------------------------------------- GlideDateTime
  class GlideDateTime {
    constructor(value) {
      this._date = value ? new Date(value instanceof GlideDateTime ? value.getNumericValue() : value) : new Date();
      if (Number.isNaN(this._date.getTime())) this._date = new Date(0);
    }
    getValue() {
      return this._date.toISOString();
    }
    getDisplayValue() {
      return this._date.toISOString();
    }
    getNumericValue() {
      return this._date.getTime();
    }
    setValue(value) {
      const d = new Date(value instanceof GlideDateTime ? value.getNumericValue() : value);
      this._date = Number.isNaN(d.getTime()) ? new Date(0) : d;
    }
    addSeconds(seconds) {
      this._date = new Date(this._date.getTime() + Number(seconds) * 1000);
    }
    addDaysUTC(days) {
      this._date = new Date(this._date.getTime() + Number(days) * 86400000);
    }
    compareTo(other) {
      const a = this.getNumericValue();
      const b = (other instanceof GlideDateTime ? other : new GlideDateTime(other)).getNumericValue();
      return a < b ? -1 : a > b ? 1 : 0;
    }
    before(other) {
      return this.compareTo(other) < 0;
    }
    after(other) {
      return this.compareTo(other) > 0;
    }
    equals(other) {
      return this.compareTo(other) === 0;
    }
    toString() {
      return this.getValue();
    }
  }
  globalThis.GlideDateTime = GlideDateTime;

  // ------------------------------------------------------------------------- gs
  const messages = [];
  const userObj = Object.freeze({
    getID: () => init.user.id,
    getName: () => init.user.userName,
    getDisplayName: () => init.user.displayName,
    hasRole: (role) => Boolean(call('gs:hasRole', { role: String(role ?? '') })),
    getMyGroups: () => [...init.user.groups],
    isMemberOf: (group) => Boolean(call('gs:isMemberOf', { group: String(group ?? '') })),
  });

  const gs = Object.freeze({
    info: (...args) => call('gs:log', { level: 'info', message: formatMsg(args) }),
    warn: (...args) => call('gs:log', { level: 'warn', message: formatMsg(args) }),
    error: (...args) => call('gs:log', { level: 'error', message: formatMsg(args) }),
    debug: (...args) => call('gs:log', { level: 'debug', message: formatMsg(args) }),
    print: (...args) => call('gs:log', { level: 'info', message: formatMsg(args) }),
    log: (message, source) =>
      call('gs:log', { level: 'info', message: formatArg(message), source: source !== undefined ? String(source) : undefined }),
    addInfoMessage: (msg) => {
      const m = formatArg(msg);
      messages.push({ type: 'info', message: m });
      call('gs:message', { type: 'info', message: m });
    },
    addErrorMessage: (msg) => {
      const m = formatArg(msg);
      messages.push({ type: 'error', message: m });
      call('gs:message', { type: 'error', message: m });
    },
    getMessages: (type) =>
      type ? messages.filter((m) => m.type === type).map((m) => m.message) : messages.map((m) => m.message),
    getUserID: () => init.user.id,
    getUserName: () => init.user.userName,
    getUserDisplayName: () => init.user.displayName,
    hasRole: (role) => Boolean(call('gs:hasRole', { role: String(role ?? '') })),
    getUser: () => userObj,
    getProperty: (name, alt = null) => {
      const val = call('gs:getProperty', { name: String(name ?? '') });
      return val === null || val === undefined ? alt : val;
    },
    setProperty: (name, value, description) =>
      call('gs:setProperty', {
        name: String(name ?? ''),
        value: value === null || value === undefined ? '' : String(value),
        description: description !== undefined ? String(description) : undefined,
      }),
    nil: (v) => v === null || v === undefined || v === '' || (typeof v === 'object' && typeof v.nil === 'function' && Boolean(v.nil())),
    now: () => new Date().toISOString().slice(0, 10),
    nowDateTime: () => new Date().toISOString(),
    generateGUID: () => String(call('gs:uuid', {})),
  });
  globalThis.gs = gs;

  // ---------------------------------------------------------------- GlideRecord
  const toCond = (field, opOrVal, val, argc) => {
    if (argc >= 3) {
      return { field: String(field), operator: String(opOrVal), value: val === null || val === undefined ? '' : String(val) };
    }
    return { field: String(field), operator: '=', value: opOrVal === null || opOrVal === undefined ? '' : String(opOrVal) };
  };

  function makeGlideRecordClass(secure) {
    return class SandboxGlideRecord {
      constructor(table, preloaded) {
        const t = String(table ?? '');
        if (!preloaded) {
          const meta = call('gr:init', { table: t });
          this._displayField = meta.displayField;
        } else {
          this._displayField = preloaded.displayField || 'sys_id';
        }
        this._table = t;
        this._secure = secure;
        this._clauses = [];
        this._encodedQueries = [];
        this._orderBy = [];
        this._limit = undefined;
        this._rows = [];
        this._index = -1;
        this._values = preloaded && preloaded.values ? { ...preloaded.values } : {};
        this._display = preloaded && preloaded.display ? { ...preloaded.display } : {};
        this._pending = {};
        this._isNew = Boolean(preloaded && preloaded.isNew);
        this._workflow = true;
        this._operation = preloaded && preloaded.operation ? preloaded.operation : null;
        this._previous = preloaded && preloaded.previous ? preloaded.previous : null;
        this._readOnly = Boolean(preloaded && preloaded.readOnly);
        this._aborted = false;

        return new Proxy(this, {
          get(target, prop, receiver) {
            if (typeof prop === 'symbol' || prop in target) {
              const v = Reflect.get(target, prop, receiver);
              return typeof v === 'function' ? v.bind(target) : v;
            }
            return target.getValue(prop);
          },
          set(target, prop, value, receiver) {
            if (typeof prop === 'symbol' || prop in target || (typeof prop === 'string' && prop.startsWith('_'))) {
              return Reflect.set(target, prop, value, receiver);
            }
            target.setValue(prop, value);
            return true;
          },
          has(target, prop) {
            return prop in target || (typeof prop === 'string' && (prop in target._pending || prop in target._values));
          },
        });
      }

      addQuery(field, opOrVal, val) {
        const clause = [toCond(field, opOrVal, val, arguments.length)];
        this._clauses.push(clause);
        const handle = {
          addOrCondition(f, o, v) {
            clause.push(toCond(f, o, v, arguments.length));
            return handle;
          },
        };
        return handle;
      }

      addEncodedQuery(query) {
        if (query !== null && query !== undefined && String(query).trim() !== '') {
          this._encodedQueries.push(String(query));
        }
      }

      addNullQuery(field) {
        this._clauses.push([{ field: String(field), operator: 'ISEMPTY', value: '' }]);
      }

      addNotNullQuery(field) {
        this._clauses.push([{ field: String(field), operator: 'ISNOTEMPTY', value: '' }]);
      }

      orderBy(field) {
        this._orderBy.push({ field: String(field), desc: false });
      }

      orderByDesc(field) {
        this._orderBy.push({ field: String(field), desc: true });
      }

      setLimit(n) {
        this._limit = Number(n);
      }

      setWorkflow(enable) {
        this._workflow = Boolean(enable);
      }

      query() {
        const res = call('gr:query', {
          table: this._table,
          secure: this._secure,
          clauses: this._clauses,
          encodedQueries: this._encodedQueries,
          orderBy: this._orderBy,
          limit: this._limit,
        });
        this._rows = res.rows;
        this._index = -1;
        this._isNew = false;
      }

      get(fieldOrSysId, value) {
        this._clauses = [];
        this._encodedQueries = [];
        this._orderBy = [];
        if (arguments.length === 1 || value === undefined) {
          this.addQuery('sys_id', fieldOrSysId);
        } else {
          this.addQuery(fieldOrSysId, value);
        }
        this.setLimit(1);
        this.query();
        return this.next();
      }

      next() {
        if (this._index + 1 >= this._rows.length) return false;
        this._index++;
        const row = this._rows[this._index];
        this._values = { ...row.values };
        this._display = { ...row.display };
        this._pending = {};
        return true;
      }

      hasNext() {
        return this._index + 1 < this._rows.length;
      }

      getRowCount() {
        return this._rows.length;
      }

      initialize() {
        this._values = {};
        this._display = {};
        this._pending = {};
        this._isNew = true;
      }

      newRecord() {
        this.initialize();
      }

      isNewRecord() {
        return this._isNew;
      }

      getTableName() {
        return this._table;
      }

      getRecordClassName() {
        return String(this.getValue('sys_class_name') || this._table);
      }

      getUniqueValue() {
        const id = this.getValue('sys_id');
        return id === null || id === undefined ? '' : String(id);
      }

      getValue(field) {
        const f = String(field);
        return f in this._pending ? this._pending[f] : (this._values[f] ?? null);
      }

      getDisplayValue(field) {
        const f = field ? String(field) : this._displayField;
        if (f in this._pending) {
          const v = this._pending[f];
          return v === null || v === undefined ? '' : String(v);
        }
        return this._display[f] ?? (this._values[f] != null ? String(this._values[f]) : '');
      }

      setValue(field, value) {
        if (this._readOnly) throw new Error('Record is read-only in this context');
        const f = String(field);
        const normalized = value instanceof GlideDateTime ? value.getValue() : value === undefined ? null : value;
        this._pending[f] = normalized;
      }

      operation() {
        return this._operation;
      }

      setAbortAction(flag) {
        this._aborted = Boolean(flag);
      }

      isActionAborted() {
        return this._aborted;
      }

      changes(field) {
        if (field !== undefined) {
          const f = String(field);
          const cur = this.getValue(f);
          if (!this._previous) return cur !== null && cur !== undefined;
          const prev = this._previous.getValue(f);
          return cur !== prev;
        }
        if (!this._previous) return true;
        const keys = new Set([...Object.keys(this._values), ...Object.keys(this._pending), ...Object.keys(this._previous._values)]);
        for (const k of keys) {
          if (k.startsWith('sys_')) continue;
          if (this.getValue(k) !== this._previous.getValue(k)) return true;
        }
        return false;
      }

      changesTo(field, value) {
        return this.changes(field) && String(this.getValue(field)) === String(value);
      }

      changesFrom(field, value) {
        return Boolean(this._previous) && this.changes(field) && String(this._previous.getValue(field)) === String(value);
      }

      getElement(field) {
        const f = String(field);
        return {
          getValue: () => this.getValue(f),
          setValue: (v) => this.setValue(f, v),
          getDisplayValue: () => this.getDisplayValue(f),
          changes: () => this.changes(f),
          changesTo: (v) => this.changesTo(f, v),
          changesFrom: (v) => this.changesFrom(f, v),
          nil: () => gs.nil(this.getValue(f)),
          toString: () => String(this.getValue(f) ?? ''),
        };
      }

      insert() {
        const res = call('gr:insert', {
          table: this._table,
          secure: this._secure,
          values: { ...this._values, ...this._pending },
          workflow: this._workflow,
        });
        this._values = { ...res.values };
        this._display = { ...res.display };
        this._pending = {};
        this._isNew = false;
        return this.getUniqueValue();
      }

      update() {
        const sysId = this._values.sys_id;
        if (this._isNew || !sysId) return this.insert();
        const res = call('gr:update', {
          table: this._table,
          secure: this._secure,
          sysId: String(sysId),
          values: { ...this._pending },
          workflow: this._workflow,
        });
        this._values = { ...res.values };
        this._display = { ...res.display };
        this._pending = {};
        this._isNew = false;
        return this.getUniqueValue();
      }

      deleteRecord() {
        const sysId = this.getValue('sys_id');
        if (!sysId) return false;
        return Boolean(
          call('gr:delete', {
            table: this._table,
            secure: this._secure,
            sysId: String(sysId),
            workflow: this._workflow,
          }),
        );
      }
    };
  }

  const GlideRecord = makeGlideRecordClass(false);
  const GlideRecordSecure = makeGlideRecordClass(true);
  globalThis.GlideRecord = GlideRecord;
  globalThis.GlideRecordSecure = GlideRecordSecure;

  // --------------------------------------------------------- Script Includes
  globalThis.global = globalThis;
  for (const name of init.includes || []) {
    if (name in globalThis) continue;
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: false,
      get() {
        const src = call('include:load', { name });
        delete globalThis[name];
        const loaded = (0, eval)(
          '(function(){\\n' +
            src +
            '\\n; return typeof ' +
            name +
            ' !== "undefined" ? ' +
            name +
            ' : globalThis[' +
            JSON.stringify(name) +
            '];\\n})()\\n//# sourceURL=sys_script_include/' +
            name +
            '.js',
        );
        Object.defineProperty(globalThis, name, {
          value: loaded,
          writable: true,
          configurable: true,
          enumerable: true,
        });
        return loaded;
      },
      set(val) {
        Object.defineProperty(globalThis, name, {
          value: val,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      },
    });
  }

  // ------------------------------------------------------ current & previous
  let currentRecord = null;
  let previousRecord = null;
  if (init.previous) {
    previousRecord = new GlideRecord(init.previous.table, {
      values: init.previous.values,
      display: init.previous.display || {},
      displayField: init.previous.displayField,
      isNew: false,
      readOnly: true,
    });
  }
  if (init.current) {
    currentRecord = new GlideRecord(init.current.table, {
      values: init.current.values,
      display: init.current.display || {},
      displayField: init.current.displayField,
      isNew: Boolean(init.current.isNew),
      operation: init.current.operation || null,
      previous: previousRecord,
      readOnly: Boolean(init.current.readOnly),
    });
  }
  globalThis.current = currentRecord;
  globalThis.previous = previousRecord;

  // Internal state reader used by the host right after script completion.
  Object.defineProperty(globalThis, '__steward_extract', {
    value: () => ({
      answer: globalThis.answer,
      pending: currentRecord ? { ...currentRecord._pending } : undefined,
      aborted: currentRecord ? Boolean(currentRecord._aborted) : false,
    }),
    enumerable: false,
    configurable: false,
    writable: false,
  });
})();
`;
