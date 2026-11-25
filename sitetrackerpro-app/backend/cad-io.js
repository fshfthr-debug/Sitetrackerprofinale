/**
 * CAD and interchange I/O for SiteTrackerPro.
 *
 * Every writer and reader here is plain JavaScript with no native or GPL dependency, so the
 * same code runs inside the Render container and inside the unit tests:
 *
 *   DXF      R2000 (AC1015) ASCII. Layers, closed polylines, lines, points and TEXT labels.
 *   KML      OGC KML 2.2, always EPSG:4326 as the specification requires.
 *   SHP      ESRI Shapefile set (.shp/.shx/.dbf/.prj) packed into one .zip. Points, lines and
 *            polygons are written as separate shapefiles inside the archive, because a
 *            shapefile can only hold one geometry type.
 *
 * Coordinates arrive already transformed into the CRS the caller wants to write, so this module
 * never guesses a projection. The one exception is KML: because KML is defined in EPSG:4326 the
 * caller must hand over geographic coordinates, and `looksGeographic` guards that mistake.
 */

const zlib = require('zlib');

// --------------------------------------------------------------------------- geometry

const GEOMETRY_CLASS = {
  Point: 'point',
  MultiPoint: 'point',
  LineString: 'line',
  MultiLineString: 'line',
  Polygon: 'polygon',
  MultiPolygon: 'polygon'
};

function geometryClass(geometry) {
  if (!geometry || !geometry.type) return null;
  return GEOMETRY_CLASS[geometry.type] || null;
}

function positionList(geometry) {
  if (!geometry) return [];
  switch (geometry.type) {
    case 'Point': return geometry.coordinates ? [geometry.coordinates] : [];
    case 'MultiPoint': return geometry.coordinates || [];
    case 'LineString': return geometry.coordinates || [];
    case 'MultiLineString': return (geometry.coordinates || []).flat();
    case 'Polygon': return (geometry.coordinates || []).flat();
    case 'MultiPolygon': return (geometry.coordinates || []).flat(2);
    default: return [];
  }
}

// A shapefile ring must be closed. GeoJSON requires that too, but imported data is not always
// well formed, so close it here rather than shipping a file AutoCAD refuses to draw.
function closeRing(ring) {
  if (!ring || ring.length < 3) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) return [...ring, [first[0], first[1]]];
  return ring;
}

function collectionBbox(featureCollection) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  (featureCollection.features || []).forEach(feature => {
    positionList(feature.geometry).forEach(([x, y]) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      west = Math.min(west, x); east = Math.max(east, x);
      south = Math.min(south, y); north = Math.max(north, y);
    });
  });
  if (west === Infinity) return null;
  return [west, south, east, north];
}

// Decimal places to keep for a coordinate pair. Degrees keep far more precision than metres.
function precisionFor(bbox, crs) {
  const geographic = /^EPSG:(4326|4258|4269|4322)$/i.test(String(crs || ''));
  if (geographic) return 7;
  if (!bbox) return 3;
  const span = Math.max(Math.abs(bbox[2] - bbox[0]), Math.abs(bbox[3] - bbox[1]));
  return span > 1e6 ? 2 : 3;
}

function roundTo(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function fixed(value, places) {
  if (!Number.isFinite(value)) return '0';
  return roundTo(value, places).toFixed(places);
}

// --------------------------------------------------------------------------- DXF

const DXF_LAYER_COLOURS = [1, 2, 3, 4, 5, 6, 30, 40, 50, 90, 130, 150, 170, 190, 210, 230];

function dxfSafeName(name, fallback) {
  const cleaned = String(name || '')
    .replace(/[<>\/*:?"|=\\,;]/g, '-')   // characters AutoCAD and DXF group codes dislike
    .replace(/\s+/g, '_')
    .trim();
  return (cleaned || fallback).slice(0, 31).toUpperCase();
}

function dxfTextValue(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[€…–—’“”]/g, char => ({
      '€': 'EUR', '…': '...', '–': '-', '—': '-', '’': "'", '“': '"', '”': '"'
    }[char] || '?'))
    // DXF R2000 text is not Unicode; keep the writer honest rather than emitting mojibake.
    .replace(/[^\x20-\x7E]/g, '?')
    .slice(0, 250);
}

function pair(code, value) {
  return `${code}\n${value}\n`;
}

/**
 * Write a FeatureCollection as a DXF drawing.
 *
 * Options:
 *   layerName  layer the entities are created on (up to 31 characters, upper-cased)
 *   crs        the CRS the coordinates are already in; only used for the header note and units
 *   units      4 = millimetres, 6 = metres, 0 = unitless (degrees)
 *   labelFrom  property used for TEXT labels next to points; defaults to 'name'
 */
function featureCollectionToDxf(featureCollection, options = {}) {
  const features = (featureCollection && featureCollection.features) || [];
  const bbox = options.bbox || collectionBbox(featureCollection);
  const places = precisionFor(bbox, options.crs);
  const crs = String(options.crs || 'EPSG:4326');
  const geographic = /^EPSG:(4326|4258|4269|4322)$/i.test(crs);
  const units = options.units !== undefined
    ? Number(options.units)
    : (geographic ? 0 : 6);
  const layer = dxfSafeName(options.layerName || featureCollection.name || 'GIS_LAYER', 'GIS_LAYER');

  // One layer per logical group of features. Features may carry a 'layer' property (written by
  // the CAD importer), and that name is preserved so a round trip keeps the drawing structure.
  const layers = new Map([[layer, 0]]);
  features.forEach(feature => {
    const own = feature.properties && feature.properties.layer;
    if (own) {
      const name = dxfSafeName(own, layer);
      if (!layers.has(name)) layers.set(name, layers.size);
    }
  });

  const body = [];
  let handle = 0x100;
  const nextHandle = () => (handle++).toString(16).toUpperCase();

  const point = (x, y) => pair(10, fixed(x, places)) + pair(20, fixed(y, places));

  features.forEach(feature => {
    const geometry = feature && feature.geometry;
    const kind = geometry ? String(geometry.type) : '';
    const own = feature.properties && feature.properties.layer
      ? dxfSafeName(feature.properties.layer, layer)
      : layer;
    const label = dxfTextValue(
      (feature.properties && (feature.properties[options.labelFrom || 'name']
        || feature.properties.label
        || feature.properties.Name
        || feature.properties.NAME))
        || (options.labelPoints ? `${feature.properties?.point_id || ''}` : '')
    );

    if (kind === 'Point' && geometry.coordinates) {
      body.push(pair(0, 'POINT') + pair(5, nextHandle()) + pair(8, own) + pair(100, 'AcDbEntity')
        + pair(100, 'AcDbPoint') + point(geometry.coordinates[0], geometry.coordinates[1]));
      if (label) {
        body.push(pair(0, 'TEXT') + pair(5, nextHandle()) + pair(8, own) + pair(100, 'AcDbEntity')
          + pair(100, 'AcDbText')
          + pair(10, fixed(geometry.coordinates[0], places))
          + pair(20, fixed(geometry.coordinates[1], places))
          + pair(30, '0.0') + pair(40, '2.5') + pair(1, label));
      }
      return;
    }

    if (kind === 'LineString' || kind === 'MultiLineString') {
      const parts = kind === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
      (parts || []).forEach(part => {
        if (!part || part.length < 2) return;
        body.push(pair(0, 'LWPOLYLINE') + pair(5, nextHandle()) + pair(8, own)
          + pair(100, 'AcDbEntity') + pair(100, 'AcDbPolyline')
          + pair(90, part.length) + pair(70, 0));
        part.forEach(([x, y]) => { body.push(point(x, y)); });
      });
      return;
    }

    if (kind === 'Polygon' || kind === 'MultiPolygon') {
      const polygons = kind === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
      (polygons || []).forEach(rings => {
        (rings || []).forEach(ring => {
          const closed = closeRing(ring || []);
          if (!closed || closed.length < 4) return;
          body.push(pair(0, 'LWPOLYLINE') + pair(5, nextHandle()) + pair(8, own)
            + pair(100, 'AcDbEntity') + pair(100, 'AcDbPolyline')
            + pair(90, closed.length) + pair(70, 1));
          closed.forEach(([x, y]) => { body.push(point(x, y)); });
          if (label) {
            body.push(pair(0, 'TEXT') + pair(5, nextHandle()) + pair(8, own) + pair(100, 'AcDbEntity')
              + pair(100, 'AcDbText')
              + pair(10, fixed(closed[0][0], places))
              + pair(20, fixed(closed[0][1], places))
              + pair(30, '0.0') + pair(40, '2.5') + pair(1, label));
          }
        });
      });
    }
  });

  const table = [];
  layers.forEach((index, name) => {
    table.push(pair(0, 'LAYER') + pair(2, name) + pair(70, 0)
      + pair(62, DXF_LAYER_COLOURS[index % DXF_LAYER_COLOURS.length])
      + pair(6, 'CONTINUOUS'));
  });

  const header = [
    pair(0, 'SECTION') + pair(2, 'HEADER'),
    pair(9, '$ACADVER') + pair(1, 'AC1015'),
    pair(9, '$INSUNITS') + pair(70, units),
    pair(9, '$EXTMIN') + point(bbox ? bbox[0] : 0, bbox ? bbox[1] : 0),
    pair(9, '$EXTMAX') + point(bbox ? bbox[2] : 0, bbox ? bbox[3] : 0),
    pair(0, 'ENDSEC')
  ].join('');

  const tables = pair(0, 'SECTION') + pair(2, 'TABLES')
    + pair(0, 'TABLE') + pair(2, 'LTYPE') + pair(70, 1)
    + pair(0, 'LTYPE') + pair(2, 'CONTINUOUS') + pair(70, 0) + pair(3, 'Solid line')
    + pair(72, 65) + pair(73, 0) + pair(40, '0.0')
    + pair(0, 'ENDTAB')
    + pair(0, 'TABLE') + pair(2, 'LAYER') + pair(70, layers.size)
    + table.join('')
    + pair(0, 'ENDTAB')
    + pair(0, 'ENDSEC');

  const entities = pair(0, 'SECTION') + pair(2, 'ENTITIES') + body.join('') + pair(0, 'ENDSEC');

  // A comment line records provenance without inventing a non-standard entity.
  const trailer = pair(999, `SiteTrackerPro DXF export | CRS ${crs} | ${features.length} features`);

  return `${trailer}${header}${tables}${entities}${pair(0, 'EOF')}`;
}

// --------------------------------------------------------------------------- KML

function escapeXml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function kmlCoordinates(ring, places) {
  return ring.map(([x, y]) => `${fixed(x, places)},${fixed(y || 0, places)},0`).join(' ');
}

function kmlGeometry(geometry, places) {
  if (!geometry) return '';
  switch (geometry.type) {
    case 'Point':
      return `<Point><coordinates>${kmlCoordinates([geometry.coordinates], places)}</coordinates></Point>`;
    case 'MultiPoint':
      return geometry.coordinates.map(c => kmlGeometry({ type: 'Point', coordinates: c }, places)).join('');
    case 'LineString':
      return `<LineString><tessellate>1</tessellate><coordinates>${kmlCoordinates(geometry.coordinates, places)}</coordinates></LineString>`;
    case 'MultiLineString':
      return `<MultiGeometry>${geometry.coordinates.map(c => kmlGeometry({ type: 'LineString', coordinates: c }, places)).join('')}</MultiGeometry>`;
    case 'Polygon':
      return `<Polygon><outerBoundaryIs><LinearRing><coordinates>${kmlCoordinates(closeRing(geometry.coordinates[0] || []), places)}</coordinates></LinearRing></outerBoundaryIs>`
        + (geometry.coordinates.slice(1).map(ring =>
          `<innerBoundaryIs><LinearRing><coordinates>${kmlCoordinates(closeRing(ring), places)}</coordinates></LinearRing></innerBoundaryIs>`
        ).join(''))
        + '</Polygon>';
    case 'MultiPolygon':
      return `<MultiGeometry>${geometry.coordinates.map(c => kmlGeometry({ type: 'Polygon', coordinates: c }, places)).join('')}</MultiGeometry>`;
    default:
      return '';
  }
}

/** Write a FeatureCollection as KML. Coordinates must already be EPSG:4326. */
function featureCollectionToKml(featureCollection, options = {}) {
  const features = (featureCollection && featureCollection.features) || [];
  const name = String(options.name || featureCollection.name || 'SiteTrackerPro export');
  const places = 7;
  const placemarks = features.map((feature, index) => {
    const properties = feature.properties || {};
    const title = properties.name || properties.Name || properties.NAME
      || properties.label || properties.point_id || `Feature ${index + 1}`;
    const data = Object.entries(properties)
      .filter(([, value]) => value !== null && value !== undefined && typeof value !== 'object')
      .slice(0, 40)
      .map(([key, value]) => `<Data name="${escapeXml(key)}"><value>${escapeXml(value)}</value></Data>`)
      .join('');
    return `<Placemark><name>${escapeXml(title)}</name>`
      + (data ? `<ExtendedData>${data}</ExtendedData>` : '')
      + kmlGeometry(feature.geometry, places)
      + '</Placemark>';
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(name)}</name>
    <description>Exported from SiteTrackerPro. Coordinates in WGS 84 (EPSG:4326).</description>
    ${placemarks}
  </Document>
</kml>
`;
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

function parseKmlCoordinates(text) {
  return String(text || '')
    .trim()
    .split(/\s+/)
    .map(token => token.split(',').map(Number))
    .filter(parts => Number.isFinite(parts[0]) && Number.isFinite(parts[1]))
    .map(parts => [parts[0], parts[1]]);
}

function parseKmlGeometry(xml) {
  const geometries = [];
  const polygonPattern = /<Polygon\b[^>]*>([\s\S]*?)<\/Polygon>/gi;
  let match;
  while ((match = polygonPattern.exec(xml)) !== null) {
    const block = match[1];
    const outer = /<outerBoundaryIs\b[^>]*>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/i.exec(block);
    if (!outer) continue;
    const rings = [parseKmlCoordinates(outer[1])];
    const innerPattern = /<innerBoundaryIs\b[^>]*>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/gi;
    let inner;
    while ((inner = innerPattern.exec(block)) !== null) {
      const ring = parseKmlCoordinates(inner[1]);
      if (ring.length >= 3) rings.push(ring);
    }
    if (rings[0].length >= 3) geometries.push({ type: 'Polygon', coordinates: rings });
  }
  if (geometries.length) return geometries.length === 1 ? geometries[0] : { type: 'MultiPolygon', coordinates: geometries.map(g => g.coordinates) };

  const linePattern = /<LineString\b[^>]*>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/LineString>/gi;
  const lines = [];
  while ((match = linePattern.exec(xml)) !== null) {
    const line = parseKmlCoordinates(match[1]);
    if (line.length >= 2) lines.push(line);
  }
  if (lines.length) return lines.length === 1 ? { type: 'LineString', coordinates: lines[0] } : { type: 'MultiLineString', coordinates: lines };

  const pointPattern = /<Point\b[^>]*>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/Point>/gi;
  const points = [];
  while ((match = pointPattern.exec(xml)) !== null) {
    const point = parseKmlCoordinates(match[1])[0];
    if (point) points.push(point);
  }
  if (points.length) return points.length === 1 ? { type: 'Point', coordinates: points[0] } : { type: 'MultiPoint', coordinates: points };

  return null;
}

/** Read KML (or KMZ after it has been unzipped) into a FeatureCollection in EPSG:4326. */
function parseKml(text) {
  const placemarkPattern = /<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/gi;
  const features = [];
  let match;
  while ((match = placemarkPattern.exec(text)) !== null) {
    const block = match[1];
    const geometry = parseKmlGeometry(block);
    if (!geometry) continue;
    const properties = {};
    const name = /<name>([\s\S]*?)<\/name>/i.exec(block);
    if (name) properties.name = decodeXmlEntities(name[1]).trim();
    const description = /<description>([\s\S]*?)<\/description>/i.exec(block);
    if (description) properties.description = decodeXmlEntities(description[1]).trim().slice(0, 500);
    const dataPattern = /<Data\s+name="([^"]*)"\s*>[\s\S]*?<value>([\s\S]*?)<\/value>/gi;
    let data;
    while ((data = dataPattern.exec(block)) !== null) {
      properties[decodeXmlEntities(data[1])] = decodeXmlEntities(data[2]).trim();
    }
    const simpleDataPattern = /<SimpleData\s+name="([^"]*)"\s*>([\s\S]*?)<\/SimpleData>/gi;
    while ((data = simpleDataPattern.exec(block)) !== null) {
      properties[decodeXmlEntities(data[1])] = decodeXmlEntities(data[2]).trim();
    }
    features.push({ type: 'Feature', geometry, properties });
  }
  return { type: 'FeatureCollection', features };
}

// --------------------------------------------------------------------------- ZIP

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** Build a ZIP archive with stored (uncompressed) entries. */
function zipStore(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)) & 0xFFFF;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

  files.forEach(file => {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);           // UTF-8 file names
    local.writeUInt16LE(0, 8);                // stored
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
  });

  const centralBuffer = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuffer, end]);
}

/** Read a ZIP archive (stored or deflated entries). Returns a Map of name -> Buffer. */
function unzip(buffer) {
  const files = new Map();
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return files;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65558); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return files;
  const count = buffer.readUInt16LE(eocd + 10);
  let pointer = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i += 1) {
    if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.slice(pointer + 46, pointer + 46 + nameLength).toString('utf8');

    if (buffer.readUInt32LE(localOffset) === 0x04034b50) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const raw = buffer.slice(start, start + compressedSize);
      try {
        files.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
      } catch (err) {
        // A corrupt member must not take the whole import down; the caller reports what is missing.
      }
    }
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

// --------------------------------------------------------------------------- Shapefile

const SHP_TYPE = { point: 1, line: 3, polygon: 5 };

function shapefileRecords(geometryClass, geometries) {
  // Returns [{ bbox, content }] in shapefile record format.
  return geometries.map(geometry => {
    if (geometryClass === 'point') {
      const [x, y] = geometry;
      const content = Buffer.alloc(20);
      content.writeInt32LE(SHP_TYPE.point, 0);
      content.writeDoubleLE(x, 4);
      content.writeDoubleLE(y, 12);
      return { bbox: [x, y, x, y], content };
    }

    const parts = geometryClass === 'polygon'
      ? [geometry.coordinates[0] ? closeRing(geometry.coordinates[0]) : []]
      : [geometry.coordinates];
    const flat = parts.flat();
    if (!flat.length) return null;
    const xs = flat.map(p => p[0]);
    const ys = flat.map(p => p[1]);
    const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];

    const content = Buffer.alloc(44 + 4 * parts.length + 16 * flat.length);
    content.writeInt32LE(SHP_TYPE[geometryClass], 0);
    content.writeDoubleLE(bbox[0], 4);
    content.writeDoubleLE(bbox[1], 12);
    content.writeDoubleLE(bbox[2], 20);
    content.writeDoubleLE(bbox[3], 28);
    content.writeInt32LE(parts.length, 36);
    content.writeInt32LE(flat.length, 40);
    let cursor = 44;
    let pointIndex = 0;
    parts.forEach(part => {
      content.writeInt32LE(pointIndex, cursor);
      cursor += 4;
      pointIndex += part.length;
    });
    parts.flat().forEach(([x, y]) => {
      content.writeDoubleLE(x, cursor);
      content.writeDoubleLE(y, cursor + 8);
      cursor += 16;
    });
    return { bbox, content };
  }).filter(Boolean);
}

function shapefileBundle(geometryClass, records) {
  const base = 100;
  const shpRecords = [];
  let shpLength = 0;
  let fit = 1;
  records.forEach((record, index) => {
    const header = Buffer.alloc(8);
    header.writeInt32LE(index + 1, 0);
    header.writeInt32LE(record.content.length / 2, 4);
    shpRecords.push(header, record.content);
    shpLength += 8 + record.content.length;
  });

  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  records.forEach(record => {
    west = Math.min(west, record.bbox[0]); south = Math.min(south, record.bbox[1]);
    east = Math.max(east, record.bbox[2]); north = Math.max(north, record.bbox[3]);
  });
  if (!Number.isFinite(west)) { west = 0; south = 0; east = 0; north = 0; }

  const shpHeader = Buffer.alloc(base);
  shpHeader.writeInt32LE(9994, 0);
  shpHeader.writeInt32LE((base + shpLength) / 2, 24);
  shpHeader.writeInt32LE(1000, 28);
  shpHeader.writeInt32LE(SHP_TYPE[geometryClass], 32);
  shpHeader.writeDoubleLE(west, 36);
  shpHeader.writeDoubleLE(south, 44);
  shpHeader.writeDoubleLE(east, 52);
  shpHeader.writeDoubleLE(north, 60);
  const shp = Buffer.concat([shpHeader, ...shpRecords]);

  const shxEntries = [];
  let offsetWords = base / 2;
  records.forEach((record, index) => {
    const entry = Buffer.alloc(8);
    entry.writeInt32LE(offsetWords, 0);
    entry.writeInt32LE(record.content.length / 2, 4);
    shxEntries.push(entry);
    offsetWords += (8 + record.content.length) / 2;
    fit = index + 2;
  });
  const shxHeader = Buffer.from(shpHeader);
  shxHeader.writeInt32LE((base + shxEntries.length * 8) / 2, 24);
  const shx = Buffer.concat([shxHeader, ...shxEntries]);

  return { shp, shx, recordCount: fit - 1 };
}

function dbfFieldName(key, index) {
  const cleaned = String(key).replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
  return (cleaned || `FIELD${index + 1}`).slice(0, 10);
}

function dbfBundle(fieldNames, features) {
  const fields = fieldNames.map((name, index) => ({ name: dbfFieldName(name, index), source: name }));
  const recordLength = 1 + fields.reduce((total, field) => total + Math.max(1, field.name.length > 0 ? 80 : 1), 0);
  const headerLength = 32 + fields.length * 32 + 1;
  const buffer = Buffer.alloc(headerLength + features.length * recordLength + 1);
  const now = new Date();

  buffer.writeUInt8(0x03, 0);
  buffer.writeUInt8(now.getFullYear() - 1900, 1);
  buffer.writeUInt8(now.getMonth() + 1, 2);
  buffer.writeUInt8(now.getDate(), 3);
  buffer.writeUInt32LE(features.length, 4);
  buffer.writeUInt16LE(headerLength, 8);
  buffer.writeUInt16LE(recordLength, 10);

  let cursor = 32;
  fields.forEach(field => {
    buffer.write(field.name, cursor, 10, 'ascii');
    buffer.writeUInt8('C'.charCodeAt(0), cursor + 11);
    buffer.writeUInt32LE(0, cursor + 12);
    buffer.writeUInt8(80, cursor + 16);
    buffer.writeUInt8(0, cursor + 17);
    cursor += 32;
  });
  buffer.writeUInt8(0x0D, cursor);
  cursor += 1;

  features.forEach(feature => {
    buffer.write(' ', cursor, 1, 'ascii');
    cursor += 1;
    fields.forEach(field => {
      const raw = feature.properties ? feature.properties[field.source] : '';
      const text = raw === null || raw === undefined ? '' : String(raw);
      buffer.write(text.slice(0, 80).padEnd(80, ' '), cursor, 80, 'utf8');
      cursor += 80;
    });
  });
  buffer.writeUInt8(0x1A, buffer.length - 1);
  return buffer;
}

// Well-known text for the CRSs the API exposes, so ArcGIS and QGIS place the file correctly.
const CRS_WKT = {
  'EPSG:4326': 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]',
  'EPSG:3857': 'PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",0.0],PARAMETER["Standard_Parallel_1",0.0],PARAMETER["Auxiliary_Sphere_Type",0.0],UNIT["Meter",1.0]]',
  'EPSG:32636': 'PROJCS["WGS_1984_UTM_Zone_36N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",33.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]',
  'EPSG:32637': 'PROJCS["WGS_1984_UTM_Zone_37N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",39.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]',
  'EPSG:32638': 'PROJCS["WGS_1984_UTM_Zone_38N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",45.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]'
};

function crsWkt(code) {
  return CRS_WKT[String(code || '').toUpperCase()] || CRS_WKT['EPSG:4326'];
}

/**
 * Write Shapefiles into one .zip. A shapefile holds a single geometry type, so points, lines and
 * polygons each get their own set inside the archive.
 */
function featureCollectionToShapefileZip(featureCollection, options = {}) {
  const features = (featureCollection && featureCollection.features) || [];
  const name = String(options.name || options.layerName || 'layer')
    .replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60) || 'layer';
  const crs = String(options.crs || 'EPSG:4326');
  const groups = { point: [], line: [], polygon: [] };
  features.forEach(feature => {
    const kind = geometryClass(feature && feature.geometry);
    if (kind) groups[kind].push(feature);
  });

  const files = [];
  const summary = [];
  Object.entries(groups).forEach(([kind, group]) => {
    if (!group.length) return;
    const geometries = group.map(feature => (kind === 'point'
      ? (feature.geometry.type === 'MultiPoint' ? feature.geometry.coordinates[0] : feature.geometry.coordinates)
      : feature.geometry));
    const records = shapefileRecords(kind, geometries);
    if (!records.length) return;
    const bundle = shapefileBundle(kind, records);
    const base = `${name}_${kind}`;
    const keys = new Set();
    group.forEach(feature => Object.keys(feature.properties || {}).forEach(key => keys.add(key)));
    const fieldNames = [...keys].slice(0, 24);
    files.push(
      { name: `${base}.shp`, data: bundle.shp },
      { name: `${base}.shx`, data: bundle.shx },
      { name: `${base}.dbf`, data: dbfBundle(fieldNames, group) },
      { name: `${base}.prj`, data: crsWkt(crs) }
    );
    summary.push(`${base}.shp — ${bundle.recordCount} ${kind} feature(s), fields: ${fieldNames.join(', ') || '(none)'}`);
  });

  if (!files.length) return null;

  files.push({
    name: 'README.txt',
    data: `SiteTrackerPro Shapefile export\n`
      + `Source layer: ${options.layerName || featureCollection.name || name}\n`
      + `CRS: ${crs}\n`
      + `Features: ${features.length}\n`
      + `A shapefile can hold one geometry type, so each type is a separate .shp/.shx/.dbf/.prj set.\n`
      + summary.map(line => `  ${line}`).join('\n')
      + '\n'
  });

  return zipStore(files);
}

function readDbf(buffer) {
  const fields = [];
  if (!buffer || buffer.length < 32) return { fields, rows: [] };
  const recordCount = buffer.readUInt32LE(4);
  const headerLength = buffer.readUInt16LE(8);
  const recordLength = buffer.readUInt16LE(10);
  let cursor = 32;
  while (cursor + 32 <= headerLength - 1 && buffer[cursor] !== 0x0D) {
    const name = buffer.slice(cursor, cursor + 11).toString('ascii').replace(/\0.*$/, '').trim();
    const length = buffer[cursor + 16];
    if (name) fields.push({ name, length });
    cursor += 32;
  }

  const rows = [];
  let offset = headerLength;
  for (let i = 0; i < recordCount && offset + recordLength <= buffer.length; i += 1) {
    offset += 1; // deletion flag
    const row = {};
    fields.forEach(field => {
      const raw = buffer.slice(offset, offset + field.length).toString('utf8').replace(/\0/g, '').trim();
      row[field.name] = raw;
      offset += field.length;
    });
    rows.push(row);
  }
  return { fields, rows };
}

function readShpGeometries(buffer) {
  if (!buffer || buffer.length < 100) return [];
  const shapeType = buffer.readInt32LE(32);
  const geometries = [];
  let offset = 100;
  while (offset + 8 <= buffer.length) {
    const contentLength = buffer.readInt32LE(offset + 4) * 2;
    const start = offset + 8;
    if (start + contentLength > buffer.length) break;
    const type = buffer.readInt32LE(start);
    if (type === 0) { geometries.push(null); offset = start + contentLength; continue; }

    if (shapeType === 1 || type === 1) {
      geometries.push({
        type: 'Point',
        coordinates: [buffer.readDoubleLE(start + 4), buffer.readDoubleLE(start + 12)]
      });
    } else {
      const numParts = buffer.readInt32LE(start + 36);
      const numPoints = buffer.readInt32LE(start + 40);
      const parts = [];
      for (let p = 0; p < numParts; p += 1) parts.push(buffer.readInt32LE(start + 44 + p * 4));
      const pointStart = start + 44 + numParts * 4;
      const points = [];
      for (let p = 0; p < numPoints; p += 1) {
        points.push([buffer.readDoubleLE(pointStart + p * 16), buffer.readDoubleLE(pointStart + p * 16 + 8)]);
      }
      const rings = parts.map((from, index) => points.slice(from, index + 1 < parts.length ? parts[index + 1] : points.length));
      if (type === 5 || shapeType === 5) {
        const outer = rings[0] && rings[0].length >= 3 ? closeRing(rings[0]) : null;
        if (outer) geometries.push({ type: 'Polygon', coordinates: [outer, ...rings.slice(1).map(closeRing)] });
      } else {
        geometries.push(rings.length === 1
          ? { type: 'LineString', coordinates: rings[0] }
          : { type: 'MultiLineString', coordinates: rings });
      }
    }
    offset = start + contentLength;
  }
  return geometries;
}

/** Read a zipped Shapefile set into a FeatureCollection (coordinates are left as stored). */
function parseShapefileZip(buffer) {
  const files = unzip(buffer);
  const shpNames = [...files.keys()].filter(name => /\.shp$/i.test(name) && !/^__MACOSX/i.test(name) && !/\/\._/.test(name));
  if (!shpNames.length) return { error: 'The .zip does not contain a .shp file. Zip the .shp, .shx and .dbf together.' };

  const features = [];
  shpNames.forEach(shpName => {
    const stem = shpName.replace(/\.shp$/i, '');
    const dbf = files.get(`${stem}.dbf`) || files.get([...files.keys()].find(n => n.toLowerCase() === `${stem.toLowerCase()}.dbf`) || '');
    const { rows } = readDbf(dbf || Buffer.alloc(0));
    const geometries = readShpGeometries(files.get(shpName));
    geometries.forEach((geometry, index) => {
      if (!geometry) return;
      const row = rows[index] || {};
      const properties = {};
      Object.entries(row).forEach(([key, value]) => {
        if (value === '') return;
        const numeric = Number(value);
        properties[key] = Number.isFinite(numeric) && /^-?\d+(\.\d+)?$/.test(value) ? numeric : value;
      });
      features.push({ type: 'Feature', geometry, properties });
    });
  });

  if (!features.length) return { error: 'No drawable features were found in the shapefile.' };
  return { type: 'FeatureCollection', features };
}

module.exports = {
  featureCollectionToDxf,
  featureCollectionToKml,
  featureCollectionToShapefileZip,
  parseKml,
  parseShapefileZip,
  zipStore,
  unzip,
  shapefileBundle,
  readDbf,
  readShpGeometries,
  crsWkt,
  collectionBbox,
  geometryClass,
  precisionFor,
  dxfSafeName
};
