import { escapeCsvCell, buildCsv, safeFilePart } from './csv';

describe('CSV export helpers', () => {
  test('leaves ordinary values untouched', () => {
    expect(escapeCsvCell('Concrete')).toBe('Concrete');
    expect(escapeCsvCell(42)).toBe('42');
    expect(escapeCsvCell(null)).toBe('');
  });

  test('quotes commas, quotes and line breaks', () => {
    expect(escapeCsvCell('Wall, external')).toBe('"Wall, external"');
    expect(escapeCsvCell('12" pipe')).toBe('"12"" pipe"');
    expect(escapeCsvCell('line one\nline two')).toBe('"line one\nline two"');
  });

  test('builds Excel-friendly CRLF rows', () => {
    expect(buildCsv(['Material', 'Amount'], [
      ['Concrete', 1610100],
      ['Wall, external', '12" pipe']
    ])).toBe('Material,Amount\r\nConcrete,1610100\r\n"Wall, external","12"" pipe"');
  });

  test('creates a stable filename fragment', () => {
    expect(safeFilePart('Bole Tower Phase 1')).toBe('bole-tower-phase-1');
    expect(safeFilePart('  ***  ')).toBe('project');
    expect(safeFilePart(null)).toBe('project');
  });
});
