export const CSV_PREVIEW_ROWS = 100;

export interface CsvPreviewData {
  rows: string[][];
  rawRecords: string[];
  totalRecords: number;
}

export function detectCsvDelimiter(text: string, fallback: string): string {
  const candidates = [',', '\t', ';', '|'];
  const counts = new Map(candidates.map((candidate) => [candidate, 0]));
  let inQuote = false;
  let records = 0;
  for (let i = 0; i < text.length && records < 5; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuote && text[i + 1] === '"') i++;
      else inQuote = !inQuote;
    } else if (!inQuote && (ch === '\n' || ch === '\r')) {
      records++;
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else if (!inQuote && counts.has(ch)) {
      counts.set(ch, counts.get(ch)! + 1);
    }
  }
  return candidates.reduce(
    (best, candidate) => counts.get(candidate)! > counts.get(best)! ? candidate : best,
    fallback,
  );
}

export function parseCsvPreview(text: string, delim: string): CsvPreviewData {
  const rows: string[][] = [];
  const rawRecords: string[] = [];
  let row: string[] = [];
  let field = '';
  let inQuote = false;
  let recordStart = 0;
  let totalRecords = 0;
  let lastNonEmptyRecord = 0;

  const finishRecord = (end: number) => {
    const rawRecord = text.slice(recordStart, end);
    totalRecords++;
    if (rawRecord.length > 0) lastNonEmptyRecord = totalRecords;
    if (rows.length < CSV_PREVIEW_ROWS) {
      row.push(field);
      rows.push(row);
      rawRecords.push(rawRecord);
    }
    row = [];
    field = '';
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuote && text[i + 1] === '"') {
        if (rows.length < CSV_PREVIEW_ROWS) field += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === delim && !inQuote) {
      if (rows.length < CSV_PREVIEW_ROWS) {
        row.push(field);
        field = '';
      }
    } else if (!inQuote && (ch === '\n' || ch === '\r')) {
      finishRecord(i);
      if (ch === '\r' && text[i + 1] === '\n') i++;
      recordStart = i + 1;
    } else if (rows.length < CSV_PREVIEW_ROWS) {
      if (inQuote && ch === '\r' && text[i + 1] === '\n') {
        field += '\n';
        i++;
      } else {
        field += ch;
      }
    } else if (inQuote && ch === '\r' && text[i + 1] === '\n') {
      i++;
    }
  }

  if (recordStart < text.length) {
    finishRecord(text.length);
  }

  const total = lastNonEmptyRecord;
  return {
    rows: rows.slice(0, total),
    rawRecords: rawRecords.slice(0, total),
    totalRecords: total,
  };
}
