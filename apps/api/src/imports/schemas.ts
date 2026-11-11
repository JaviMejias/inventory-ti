import { z } from 'zod';

export const previewBodyLimit = 16 * 1024 * 1024;

const scalar = z.union([z.string().max(8192), z.number().finite(), z.boolean(), z.null()]);
export const sourceCellSchema = z.object({
  type: z.enum(['text', 'number', 'date', 'formula', 'boolean', 'error']),
  value: scalar,
  numberFormat: z.string().max(256).optional(),
  cachedValue: scalar.optional(),
  rawValue: z.string().max(8192).optional(),
  formulaAttributes: z.record(z.string().max(256)).optional()
}).strict().superRefine((cell, context) => {
  const valid = cell.type === 'number' ? typeof cell.value === 'number'
    : cell.type === 'boolean' ? typeof cell.value === 'boolean' : typeof cell.value === 'string';
  if (!valid || (cell.type === 'formula' && !String(cell.value).startsWith('='))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Cell type does not match its value' });
  }
});

const rowSchema = z.object({
  row: z.number().int().min(1).max(1048576),
  hidden: z.boolean().default(false),
  cells: z.record(z.string().regex(/^[A-Z]{1,3}$/), sourceCellSchema)
}).strict().superRefine((row, context) => {
  if (Object.keys(row.cells).length > 64) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Row exceeds 64 populated columns' });
});

export const workbookPreviewSchema = z.object({
  formatVersion: z.literal(1),
  source: z.object({
    fileName: z.string().min(1).max(255).regex(/^[^/\\]+\.xlsx$/i).refine((name) => [...name].every((character) => character.charCodeAt(0) >= 32), 'Invalid file name'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict(),
  sheets: z.array(z.object({
    name: z.string().min(1).max(100),
    hidden: z.boolean().default(false),
    filterRange: z.string().max(100).nullable().optional(),
    rows: z.array(rowSchema).max(15000)
  }).strict()).min(1).max(32)
}).strict().superRefine((workbook, context) => {
  const names = new Set<string>();
  let rows = 0;
  let cells = 0;
  for (const sheet of workbook.sheets) {
    if (names.has(sheet.name)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate worksheet name' });
    names.add(sheet.name);
    const positions = new Set<number>();
    for (const row of sheet.rows) {
      if (positions.has(row.row)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate row position' });
      positions.add(row.row);
      rows += 1;
      cells += Object.keys(row.cells).length;
    }
  }
  if (rows > 15000 || cells > 150000) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Workbook exceeds populated row/cell limits' });
});

export type WorkbookPreviewInput = z.infer<typeof workbookPreviewSchema>;
export type SourceRow = WorkbookPreviewInput['sheets'][number]['rows'][number];
export type SourceCell = SourceRow['cells'][string];
