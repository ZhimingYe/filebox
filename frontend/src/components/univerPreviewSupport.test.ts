import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  getUniverPreviewKind,
  importXlsxSnapshot,
  isUniverPreviewExt,
} from './univerPreviewSupport';

describe('Univer preview format registry', () => {
  it('only advertises formats with a browser-side snapshot adapter', () => {
    expect(getUniverPreviewKind('DOCX')).toBe('document');
    expect(getUniverPreviewKind('xlsx')).toBe('spreadsheet');
    expect(isUniverPreviewExt('pptx')).toBe(false);
    expect(isUniverPreviewExt('ods')).toBe(false);
  });
});

describe('XLSX snapshot adapter', () => {
  it('converts workbook sheets and formulas into Univer cell data', async () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Name', 'Value', 'Total'],
      ['alpha', 2, { f: 'B2*2' }],
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, 'Report');
    const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });

    const file = Object.assign(new File([bytes], 'report.xlsx'), {
      arrayBuffer: async () => bytes,
    }) as File;
    const snapshot = await importXlsxSnapshot(file);
    const sheetId = snapshot.sheetOrder[0];
    const converted = snapshot.sheets[sheetId];
    const cells = converted.cellData as Record<string, Record<string, { v?: unknown; f?: string }>>;

    expect(snapshot.sheetOrder).toHaveLength(1);
    expect(converted.name).toBe('Report');
    expect(cells['1']['0'].v).toBe('alpha');
    expect(cells['1']['2'].f).toBe('=B2*2');
  });
});
