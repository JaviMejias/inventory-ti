import { sheetDictionary } from '../../src/imports/dictionary.js';
import { workbookPreviewSchema } from '../../src/imports/schemas.js';

export const textCell = (value) => ({ type: 'text', value });
export const numberCell = (value) => ({ type: 'number', value });
export const dateCell = (value) => ({ type: 'date', value });

export function workbook(sheetName = 'Recepción', rows = [], options = {}) {
  const mapping = sheetDictionary[sheetName];
  const header = { row: mapping.headerRow, cells: Object.fromEntries(Object.entries(mapping.columns).map(([column, definition]) => [column, textCell(definition.header)])) };
  return workbookPreviewSchema.parse({ formatVersion: 1, source: { fileName: 'Fixture.xlsx', sha256: 'a'.repeat(64) }, sheets: [{ name: sheetName, rows: [header, ...rows], ...options }] });
}

export function receptionRow(row, serialNumber, extra = {}) {
  return { row, cells: { C: textCell('Notebook'), D: textCell('HP'), E: textCell('Model G9'), F: textCell(serialNumber), ...extra } };
}

export function retirementRow(sheetName, row, serialNumber, extra = {}) {
  const values = { equipmentType: 'Notebook', brand: 'HP', model: 'Model G9', serialNumber };
  return { row, cells: { ...Object.fromEntries(Object.entries(sheetDictionary[sheetName].columns)
    .filter(([, definition]) => values[definition.field]).map(([column, definition]) => [column, textCell(values[definition.field])])), ...extra } };
}

export function mergeWorkbooks(...inputs) {
  return { ...inputs[0], sheets: inputs.flatMap((input) => input.sheets) };
}
