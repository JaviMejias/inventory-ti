import console from 'node:console';
import { readFile, stat, writeFile } from 'node:fs/promises';
import process from 'node:process';

import { buildWorkbookPreview, previewDate } from '../imports/preview.js';
import { readPreviewAssets } from '../imports/snapshot.js';
import { previewBodyLimit, workbookPreviewSchema } from '../imports/schemas.js';

async function main() {
  const arguments_ = process.argv.slice(2);
  const inputPath = arguments_[0];
  const knownOptions = new Set(['--database', '--summary', '--output', '--as-of']);
  if (!inputPath || inputPath.startsWith('--')) throw new Error('Usage: preview-inventory-workbook.ts extracted.json [--database] [--summary] [--output new.json] [--as-of YYYY-MM-DD]');
  let outputPath: string | undefined;
  let asOf = previewDate();
  let useDatabase = false;
  let summaryOnly = false;
  for (let index = 1; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (!knownOptions.has(option)) throw new Error('Unknown preview option');
    if (option === '--database') useDatabase = true;
    if (option === '--summary') summaryOnly = true;
    if (option === '--output' || option === '--as-of') {
      const value = arguments_[++index];
      if (!value || value.startsWith('--')) throw new Error('Missing option value');
      if (option === '--output') outputPath = value;
      else asOf = value;
    }
  }
  const date = new Date(asOf + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== asOf) throw new Error('Invalid review date');
  if ((await stat(inputPath)).size > previewBodyLimit) throw new Error('Preview input exceeds 16 MiB');
  const parsed = workbookPreviewSchema.safeParse(JSON.parse(await readFile(inputPath, 'utf8')));
  if (!parsed.success) throw new Error('Invalid extracted workbook envelope');
  let assets: Awaited<ReturnType<typeof readPreviewAssets>> = [];
  if (useDatabase) {
    const { prisma } = await import('../config/database.js');
    try {
      assets = await readPreviewAssets(prisma);
    } finally {
      await prisma.$disconnect();
    }
  }
  const preview = buildWorkbookPreview(parsed.data, assets, asOf, useDatabase ? 'DATABASE' : 'SOURCE_ONLY');
  const output = summaryOnly ? {
    previewId: preview.previewId, mode: preview.mode, canApply: preview.canApply, comparisonMode: preview.comparisonMode,
    rulesVersion: preview.rulesVersion, asOf, summary: preview.summary, sheets: preview.sheets,
    issueCounts: Object.fromEntries([...new Set(preview.issues.map((issue) => issue.code))].sort().map((code) => [code, preview.issues.filter((issue) => issue.code === code).length]))
  } : preview;
  const serialized = JSON.stringify(output, null, summaryOnly ? 2 : undefined);
  if (outputPath) await writeFile(outputPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  else console.log(serialized);
}

main().catch(() => {
  // Do not log workbook contents, absolute paths, credentials or database errors.
  console.error('Preview failed. Check arguments, extraction limits and database connectivity. No import was applied.');
  process.exitCode = 1;
});
