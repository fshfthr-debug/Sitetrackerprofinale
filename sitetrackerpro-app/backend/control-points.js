'use strict';

// Statuses agreed for survey control points. The database stores lowercase keys;
// the interface presents the labels.
const CONTROL_POINT_STATUSES = Object.freeze([
  'draft',
  'submitted',
  'verified',
  'rejected',
  'suspect',
  'disturbed',
  'destroyed',
  'superseded'
]);

const STATUS_SET = new Set(CONTROL_POINT_STATUSES);

const normaliseStatus = (value, fallback = 'submitted') => {
  const text = value === undefined || value === null ? '' : String(value).trim().toLowerCase();
  if (!text) return STATUS_SET.has(fallback) ? fallback : 'submitted';
  return STATUS_SET.has(text) ? text : null;
};

const normaliseBenchmark = (value) => {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value === undefined || value === null) return false;
  return /^(true|yes|y|1|benchmark|bm)$/i.test(String(value).trim());
};

const numberOrNull = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

// Validates and normalises every row before a single atomic insert. Invalid rows
// are reported and skipped; valid rows can still be imported.
function validateControlPointRows(rows, {
  defaultVerticalDatum = '',
  defaultStatus = 'submitted',
  existingNames = []
} = {}) {
  const errors = [];
  const points = [];
  const seenNames = new Set(existingNames.map(name => String(name).trim().toLowerCase()).filter(Boolean));

  const fallbackStatus = normaliseStatus(defaultStatus, 'submitted') || 'submitted';
  const fallbackDatum = typeof defaultVerticalDatum === 'string'
    ? defaultVerticalDatum.trim().slice(0, 80)
    : '';

  rows.forEach((row, index) => {
    const rowNumber = Number.isFinite(Number(row.row)) && Number(row.row) > 0
      ? Number(row.row)
      : index + 2;

    const name = typeof row.name === 'string' ? row.name.trim().slice(0, 120) : '';
    if (!name) {
      errors.push({ row: rowNumber, message: 'Control point name is required.' });
      return;
    }

    const key = name.toLowerCase();
    if (seenNames.has(key)) {
      errors.push({ row: rowNumber, message: `Control point "${name}" already exists in this project or in this file.` });
      return;
    }

    const latitude = numberOrNull(row.latitude);
    const longitude = numberOrNull(row.longitude);
    const benchmarkElevation = numberOrNull(row.benchmarkElevation);

    if (latitude === null || latitude < -90 || latitude > 90) {
      errors.push({ row: rowNumber, message: 'Latitude must be a number between -90 and 90.' });
      return;
    }
    if (longitude === null || longitude < -180 || longitude > 180) {
      errors.push({ row: rowNumber, message: 'Longitude must be a number between -180 and 180.' });
      return;
    }
    if (benchmarkElevation === null || benchmarkElevation < -1000 || benchmarkElevation > 10000) {
      errors.push({ row: rowNumber, message: 'Benchmark elevation must be a number between -1000 and 10000 m.' });
      return;
    }

    const verticalDatum = typeof row.verticalDatum === 'string' && row.verticalDatum.trim()
      ? row.verticalDatum.trim().slice(0, 80)
      : fallbackDatum;

    if (!verticalDatum) {
      errors.push({ row: rowNumber, message: 'Vertical datum is required for every point, or provide a default for the import.' });
      return;
    }

    const status = normaliseStatus(row.status, fallbackStatus);
    if (!status) {
      errors.push({
        row: rowNumber,
        message: `Unknown status. Use one of: ${CONTROL_POINT_STATUSES.join(', ')}.`
      });
      return;
    }

    seenNames.add(key);
    points.push({
      row: rowNumber,
      name,
      latitude,
      longitude,
      benchmarkElevation,
      verticalDatum,
      status,
      isBenchmark: normaliseBenchmark(row.isBenchmark)
    });
  });

  return { points, errors };
}

module.exports = {
  CONTROL_POINT_STATUSES,
  normaliseStatus,
  validateControlPointRows
};
