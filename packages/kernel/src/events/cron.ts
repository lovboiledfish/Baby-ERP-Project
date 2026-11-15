import { ValidationError } from '../errors';

export interface ParsedCron {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
}

function parseCronField(raw: string, min: number, max: number, label: string, mapSunday7 = false): ReadonlySet<number> {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const token = part.trim();
    if (!token) throw new ValidationError(`Invalid ${label} in cron expression "${raw}"`);

    const [rangePart, stepPart, extra] = token.split('/');
    if (extra !== undefined) throw new ValidationError(`Invalid step syntax "${token}" in cron ${label}`);

    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step <= 0) {
        throw new ValidationError(`Invalid step "${stepPart}" in cron ${label}`);
      }
    }

    let start = min;
    let end = max;
    if (rangePart !== '*') {
      const bounds = rangePart!.split('-');
      if (bounds.length === 1) {
        const n = Number(bounds[0]);
        if (!Number.isInteger(n) || n < min || n > max) {
          throw new ValidationError(`Value "${bounds[0]}" out of range (${min}-${max}) in cron ${label}`);
        }
        start = stepPart !== undefined ? n : n;
        end = stepPart !== undefined ? max : n;
      } else if (bounds.length === 2) {
        start = Number(bounds[0]);
        end = Number(bounds[1]);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
          throw new ValidationError(`Invalid range "${rangePart}" in cron ${label}`);
        }
      } else {
        throw new ValidationError(`Invalid range "${rangePart}" in cron ${label}`);
      }
    }

    for (let v = start; v <= end; v += step) {
      out.add(mapSunday7 && v === 7 ? 0 : v);
    }
  }
  return out;
}

/**
 * Parse a standard 5-field cron expression (`minute hour day-of-month month day-of-week`)
 * evaluated in UTC.
 */
export function parseCron(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new ValidationError(`Cron expression "${expression}" must have 5 fields (minute hour day-of-month month day-of-week)`);
  }
  return {
    minutes: parseCronField(parts[0]!, 0, 59, 'minute'),
    hours: parseCronField(parts[1]!, 0, 23, 'hour'),
    daysOfMonth: parseCronField(parts[2]!, 1, 31, 'day-of-month'),
    months: parseCronField(parts[3]!, 1, 12, 'month'),
    daysOfWeek: parseCronField(parts[4]!, 0, 7, 'day-of-week', true),
  };
}

/**
 * Compute the next UTC timestamp strictly after `after` (at minute granularity)
 * matching the 5-field cron expression.
 */
export function nextCronDate(expression: string, after: Date = new Date()): Date {
  const cron = parseCron(expression);
  const candidate = new Date(after.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  // Search up to 4 years ahead (2,102,400 minutes) to cover Feb 29 schedules.
  const maxIterations = 4 * 366 * 24 * 60;
  for (let i = 0; i < maxIterations; i++) {
    const month = candidate.getUTCMonth() + 1;
    if (!cron.months.has(month)) {
      candidate.setUTCMonth(candidate.getUTCMonth() + 1, 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }
    const dom = candidate.getUTCDate();
    const dow = candidate.getUTCDay();
    if (!cron.daysOfMonth.has(dom) || !cron.daysOfWeek.has(dow)) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }
    const hour = candidate.getUTCHours();
    if (!cron.hours.has(hour)) {
      candidate.setUTCHours(candidate.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    const minute = candidate.getUTCMinutes();
    if (!cron.minutes.has(minute)) {
      candidate.setUTCMinutes(candidate.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return candidate;
  }
  throw new ValidationError(`Cron expression "${expression}" did not match any date within 4 years`);
}
