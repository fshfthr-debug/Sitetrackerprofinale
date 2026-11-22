// Control-point import parser.
//
// Survey exports arrive as comma CSV, tab-delimited TXT or semicolon CSV. This
// reads any of those into the same row shape the API validates. It deliberately
// does not decide engineering validity: the server re-checks ranges, duplicates,
// status and vertical datum before anything is stored.

export const CONTROL_POINT_STATUSES = [
  'draft',
  'submitted',
  'verified',
  'rejected',
  'suspect',
  'disturbed',
  'destroyed',
  'superseded'
];

export const INITIAL_CONTROL_POINT_STATUSES = ['draft', 'submitted'];

export const CONTROL_POINT_STATUS_LABELS = {
  draft: 'Draft',
  submitted: 'Submitted',
  verified: 'Verified',
  rejected: 'Rejected',
  suspect: 'Suspect',
  disturbed: 'Disturbed',
  destroyed: 'Destroyed',
  superseded: 'Superseded'
};

export const statusLabel = (status) =>
  CONTROL_POINT_STATUS_LABELS[String(status || '').toLowerCase()] || 'Submitted';

const HEADER_ALIASES = {
  name: ['name', 'point', 'point_name', 'control_point', 'control_point_name'],
  latitude: ['latitude', 'lat', 'lat_deg', 'latitude_deg', 'y'],
  longitude: ['longitude', 'lon', 'lng', 'long', 'lon_deg', 'longitude_deg', 'x'],
  benchmarkElevation: [
    'benchmark_elevation', 'benchmark', 'elevation', 'elevation_m',
    'benchmark_elevation_m', 'rl', 'reduced_level', 'level', 'z'
  ],
  verticalDatum: ['vertical_datum', 'datum', 'vertical_datum_name'],
  status: ['status', 'state'],
  isBenchmark: ['is_benchmark', 'benchmark_point', 'control_benchmark']
};

const normaliseHeader = (value) =>
  String(value || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

const detectDelimiter = (line) => {
  if (line.includes('\t')) return '\t';
  if (line.includes(';') && !line.includes(',')) return ';';
  if (line.includes(',')) return ',';
  throw new Error('Could not find a delimiter. Use comma, semicolon or tab-separated text.');
};

const parseDelimited = (text, delimiter) => {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }

  row.push(cell);
  rows.push(row);

  return rows.filter(cells => cells.some(value => String(value).trim() !== ''));
};

const findHeader = (index, aliases) => {
  for (const alias of aliases) {
    if (index.has(alias)) return index.get(alias);
  }
  return -1;
};

export function parseControlPointText(text) {
  const clean = String(text || '').replace(/^\uFEFF/, '');
  const firstLine = clean.split(/\r?\n/).find(line => line.trim() !== '');

  if (!firstLine) throw new Error('The file is empty.');

  const delimiter = detectDelimiter(firstLine);
  const table = parseDelimited(clean, delimiter);

  if (table.length < 2) {
    throw new Error('The file needs a header row and at least one control point.');
  }

  const index = new Map();
  table[0].forEach((header, position) => {
    const key = normaliseHeader(header);
    if (key && !index.has(key)) index.set(key, position);
  });

  const columns = {
    name: findHeader(index, HEADER_ALIASES.name),
    latitude: findHeader(index, HEADER_ALIASES.latitude),
    longitude: findHeader(index, HEADER_ALIASES.longitude),
    benchmarkElevation: findHeader(index, HEADER_ALIASES.benchmarkElevation),
    verticalDatum: findHeader(index, HEADER_ALIASES.verticalDatum),
    status: findHeader(index, HEADER_ALIASES.status),
    isBenchmark: findHeader(index, HEADER_ALIASES.isBenchmark)
  };

  const missing = [
    ['name', columns.name],
    ['latitude', columns.latitude],
    ['longitude', columns.longitude],
    ['benchmark elevation', columns.benchmarkElevation]
  ].filter(([, position]) => position < 0).map(([label]) => label);

  if (missing.length > 0) {
    throw new Error(`Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`);
  }

  const rows = table.slice(1).map((cells, offset) => {
    const value = (position) => position >= 0 ? String(cells[position] ?? '').trim() : '';
    return {
      row: offset + 2,
      name: value(columns.name),
      latitude: value(columns.latitude),
      longitude: value(columns.longitude),
      benchmarkElevation: value(columns.benchmarkElevation),
      verticalDatum: value(columns.verticalDatum),
      status: value(columns.status),
      isBenchmark: value(columns.isBenchmark)
    };
  }).filter(point => Object.keys(point).some(key => key !== 'row' && String(point[key]).trim() !== ''));

  if (rows.length === 0) throw new Error('The file contains no control point rows.');
  if (rows.length > 1000) throw new Error('Import at most 1,000 control points at a time.');

  return {
    rows,
    delimiter: delimiter === '\t' ? 'tab' : delimiter === ';' ? 'semicolon' : 'comma',
    rowsRead: rows.length
  };
}
