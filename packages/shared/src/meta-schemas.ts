import { z } from 'zod';

/** Every field type the platform understands. */
export const FIELD_TYPES = [
  'string',
  'text',
  'integer',
  'decimal',
  'boolean',
  'date',
  'datetime',
  'choice',
  'reference',
  'json',
  'guid',
  'script',
  'sys_class_name',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Types that may be used for user-defined fields (sys_class_name is platform-owned). */
export const CREATABLE_FIELD_TYPES = [
  'string',
  'text',
  'integer',
  'decimal',
  'boolean',
  'date',
  'datetime',
  'choice',
  'reference',
  'json',
  'guid',
  'script',
] as const satisfies readonly FieldType[];

export const identifier = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,79}$/, 'must be lowercase snake_case, start with a letter, max 80 chars');

export const choiceSpecSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  sequence: z.number().int().optional(),
});

export const fieldSpecSchema = z.object({
  element: identifier,
  label: z.string().min(1).optional(),
  type: z.enum(CREATABLE_FIELD_TYPES),
  reference: identifier.optional(),
  maxLength: z.number().int().positive().max(65_000).optional(),
  mandatory: z.boolean().optional(),
  defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  display: z.boolean().optional(),
  choices: z.array(choiceSpecSchema).optional(),
});

export const tableSpecSchema = z.object({
  name: identifier,
  label: z.string().min(1).optional(),
  extends: identifier.optional(),
  extendable: z.boolean().optional(),
  numberPrefix: z
    .string()
    .regex(/^[A-Z]{2,6}$/, 'must be 2-6 uppercase letters')
    .optional(),
  audit: z.boolean().optional(),
  fields: z.array(fieldSpecSchema).optional(),
});

export type ChoiceSpec = z.infer<typeof choiceSpecSchema>;
export type FieldSpec = z.infer<typeof fieldSpecSchema>;
export type TableSpec = z.infer<typeof tableSpecSchema>;

/** Flatten zod issues into a single human readable string. */
export function describeIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`).join('; ');
}
