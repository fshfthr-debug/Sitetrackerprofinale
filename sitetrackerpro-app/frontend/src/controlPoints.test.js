import { parseControlPointText, statusLabel } from './controlPoints';

describe('control-point file parser', () => {
  test('parses comma CSV with a BOM, quoted names and CRLF', () => {
    const text = '\uFEFFname,latitude,longitude,benchmark_elevation,vertical_datum,status,is_benchmark\r\n'
      + '"BM-01, primary",9.055607,38.972702,2361.24,Project benchmark,verified,yes\r\n';

    const result = parseControlPointText(text);

    expect(result.delimiter).toBe('comma');
    expect(result.rowsRead).toBe(1);
    expect(result.rows[0]).toMatchObject({
      row: 2,
      name: 'BM-01, primary',
      latitude: '9.055607',
      benchmarkElevation: '2361.24',
      status: 'verified',
      isBenchmark: 'yes'
    });
  });

  test('parses tab-delimited TXT exports', () => {
    const text = 'Point\tLat\tLon\tElevation\tDatum\nCP-05\t9.053797\t38.970882\t2362.510\tMSL';
    const result = parseControlPointText(text);

    expect(result.delimiter).toBe('tab');
    expect(result.rows[0]).toMatchObject({
      name: 'CP-05',
      latitude: '9.053797',
      longitude: '38.970882',
      benchmarkElevation: '2362.510',
      verticalDatum: 'MSL'
    });
  });

  test('parses semicolon-delimited files', () => {
    const text = 'control_point;latitude;longitude;benchmark\nBM-02;9.060129;38.977251;2358.88';
    const result = parseControlPointText(text);

    expect(result.delimiter).toBe('semicolon');
    expect(result.rows[0].name).toBe('BM-02');
  });

  test('normalises optional columns when they are absent', () => {
    const result = parseControlPointText('name,lat,lon,z\nBM-03,9.1,38.8,2360');

    expect(result.rows[0]).toMatchObject({
      verticalDatum: '',
      status: '',
      isBenchmark: ''
    });
  });

  test('rejects a file without required columns', () => {
    expect(() => parseControlPointText('name,latitude\nBM-01,9.05'))
      .toThrow(/Missing required column/);
  });

  test('rejects unsupported whitespace-only files and empty files', () => {
    expect(() => parseControlPointText('name latitude longitude\nBM-01 9.05 38.97'))
      .toThrow(/delimiter/);
    expect(() => parseControlPointText(''))
      .toThrow(/empty/);
  });

  test('presents readable status labels', () => {
    expect(statusLabel('submitted')).toBe('Submitted');
    expect(statusLabel('superseded')).toBe('Superseded');
    expect(statusLabel('')).toBe('Submitted');
  });
});
