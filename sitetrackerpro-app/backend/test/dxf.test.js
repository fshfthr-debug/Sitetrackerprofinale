const test = require('node:test');
const assert = require('node:assert');

const { parseDxf, dxfUnits } = require('../dxf');
const { featureCollectionToDxf } = require('../cad-io');

function dxfBody(lines) {
  return lines.map(line => String(line)).join('\n') + '\n';
}

const DRAWING = dxfBody([
  0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 6, 0, 'ENDSEC',
  0, 'SECTION', 2, 'BLOCKS',
  0, 'BLOCK', 8, '0', 2, 'MANHOLE', 70, 0, 10, 0, 20, 0, 30, 0, 3, 'MANHOLE',
  0, 'CIRCLE', 8, '0', 10, 0, 20, 0, 40, 1.5,
  0, 'TEXT', 8, '0', 10, 0, 20, 0, 40, 0.5, 1, 'MH',
  0, 'ENDBLK', 8, '0',
  0, 'ENDSEC',
  0, 'SECTION', 2, 'ENTITIES',
  // line on layer ROADS
  0, 'LINE', 8, 'ROADS', 10, 500000, 20, 1000000, 11, 500100, 21, 1000100,
  // closed polyline on layer SITE
  0, 'LWPOLYLINE', 8, 'SITE', 90, 4, 70, 1,
  10, 0, 20, 0, 10, 10, 20, 0, 10, 10, 20, 10, 10, 0, 20, 10,
  // open polyline
  0, 'LWPOLYLINE', 8, 'SITE', 90, 2, 70, 0, 10, 0, 20, 0, 10, 5, 20, 5,
  // circle and arc
  0, 'CIRCLE', 8, 'PITS', 10, 20, 20, 20, 40, 2,
  0, 'ARC', 8, 'PITS', 10, 40, 20, 40, 40, 3, 50, 0, 51, 90,
  // point + text
  0, 'POINT', 8, 'CP', 10, 7, 20, 8,
  0, 'TEXT', 8, 'CP', 10, 7, 20, 8, 40, 0.3, 1, 'CP-01',
  // legacy POLYLINE with VERTEX entities
  0, 'POLYLINE', 8, 'FENCE', 70, 1,
  0, 'VERTEX', 10, 0, 20, 0,
  0, 'VERTEX', 10, 3, 20, 0,
  0, 'VERTEX', 10, 3, 20, 3,
  0, 'SEQEND',
  // block insert: layer inherited by the block's layer-0 entities
  0, 'INSERT', 8, 'INTERFERENCE', 2, 'MANHOLE', 10, 100, 20, 200, 41, 2, 42, 2, 50, 90,
  0, 'ENDSEC',
  0, 'EOF'
]);

test('DXF reader keeps layers, entity types and geometry', () => {
  const parsed = parseDxf(DRAWING);

  assert.deepEqual(parsed.layers.sort(), ['CP', 'FENCE', 'INTERFERENCE', 'PITS', 'ROADS', 'SITE']);
  assert.equal(parsed.entityCounts.LINE, 1);
  assert.equal(parsed.entityCounts.LWPOLYLINE, 2);
  assert.equal(parsed.entityCounts.INSERT, 1);
  assert.equal(parsed.entityCount, 10, 'line, 2 polylines, circle, arc, point, text, legacy polyline, block circle + block text');

  const road = parsed.featureCollection.features.find(f => f.properties.layer === 'ROADS');
  assert.equal(road.geometry.type, 'LineString');
  assert.deepEqual(road.geometry.coordinates, [[500000, 1000000], [500100, 1000100]]);

  const closed = parsed.featureCollection.features.find(f => f.geometry.type === 'Polygon' && f.properties.layer === 'SITE');
  assert.equal(closed.geometry.coordinates[0].length, 5, 'the ring is closed with 5 positions');
  assert.equal(closed.properties.entity, 'LWPOLYLINE');

  const open = parsed.featureCollection.features.find(f => f.geometry.type === 'LineString' && f.properties.layer === 'SITE');
  assert.deepEqual(open.geometry.coordinates, [[0, 0], [5, 5]]);

  const text = parsed.featureCollection.features.find(f => f.properties.text === 'CP-01');
  assert.equal(text.geometry.type, 'Point');
  assert.deepEqual(text.geometry.coordinates, [7, 8]);

  const circle = parsed.featureCollection.features.find(f => f.properties.layer === 'PITS' && f.geometry.type === 'Polygon');
  const ring = circle.geometry.coordinates[0];
  assert.equal(ring.length, 73, 'a circle is a 72-segment closed ring');
  assert.ok(Math.abs(ring[0][0] - 22) < 1e-9 && Math.abs(ring[0][1] - 20) < 1e-9, 'starts at centre + radius');

  const arc = parsed.featureCollection.features.find(f => f.geometry.type === 'LineString' && f.properties.layer === 'PITS');
  const first = arc.geometry.coordinates[0];
  const last = arc.geometry.coordinates[arc.geometry.coordinates.length - 1];
  assert.ok(Math.abs(first[0] - 43) < 1e-6 && Math.abs(first[1] - 40) < 1e-6, 'arc starts at 0 degrees');
  assert.ok(Math.abs(last[0] - 40) < 1e-6 && Math.abs(last[1] - 43) < 1e-6, 'arc ends at 90 degrees');
});

test('DXF reader expands block inserts with translation, scale and rotation on the insert layer', () => {
  const parsed = parseDxf(DRAWING);
  const fromBlock = parsed.featureCollection.features.filter(f => f.properties.layer === 'INTERFERENCE');
  assert.equal(fromBlock.length, 2, 'the block circle and text both come through');

  const circle = fromBlock.find(f => f.geometry.type === 'Polygon');
  assert.ok(circle, 'block circle is expanded as a polygon');
  assert.equal(circle.properties.block, 'MANHOLE');
  // Centre (0,0) scaled by 2 and rotated 90 degrees, then moved to (100,200).
  const ring = circle.geometry.coordinates[0];
  const centre = [100, 200];
  const distances = ring.map(([x, y]) => Math.hypot(x - centre[0], y - centre[1]));
  assert.ok(distances.every(d => Math.abs(d - 3) < 1e-6), 'the radius is scaled by 2 (1.5 -> 3) around the insert point');
});

test('DXF reader keeps the POLYLINE/VERTEX/SEQEND form and closes it when the flag says so', () => {
  const parsed = parseDxf(DRAWING);
  const fence = parsed.featureCollection.features.find(f => f.properties.layer === 'FENCE');
  assert.equal(fence.geometry.type, 'Polygon');
  assert.deepEqual(fence.geometry.coordinates[0], [[0, 0], [3, 0], [3, 3], [0, 0]]);
});

test('DXF reader reads $INSUNITS and ignores malformed input safely', () => {
  assert.equal(dxfUnits(DRAWING), 6);
  assert.equal(dxfUnits('0\nSECTION\n'), 0);

  const empty = parseDxf('');
  assert.equal(empty.entityCount, 0);
  assert.deepEqual(empty.featureCollection.features, []);

  const garbage = parseDxf('this is not a dxf\nat all');
  assert.equal(garbage.entityCount, 0);

  const brokenEntity = parseDxf(dxfBody([0, 'SECTION', 2, 'ENTITIES', 0, 'LINE', 8, 'A', 10, 'x', 20, 'y', 0, 'ENDSEC']));
  assert.equal(brokenEntity.featureCollection.features[0].geometry.coordinates[0][0], 0, 'non-numeric coordinates fall back to 0');
});

test('DXF exported by the app reads back with the same layers and geometry classes', () => {
  const original = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: 'Boundary', layer: 'SITE-BOUNDARY' },
        geometry: { type: 'Polygon', coordinates: [[[38.75, 9.02], [38.76, 9.02], [38.76, 9.03], [38.75, 9.02]]] }
      },
      {
        type: 'Feature',
        properties: { name: 'Road', layer: 'ROADS' },
        geometry: { type: 'LineString', coordinates: [[38.7505, 9.0205], [38.7555, 9.0275]] }
      },
      {
        type: 'Feature',
        properties: { name: 'CP-01' },
        geometry: { type: 'Point', coordinates: [38.7512, 9.0231] }
      }
    ]
  };

  const dxf = featureCollectionToDxf(original, { layerName: 'Site', crs: 'EPSG:4326' });
  const parsed = parseDxf(dxf);

  // The exporter writes a TEXT label beside the polygon and the point, so 5 features come back.
  assert.equal(parsed.entityCount, 5);
  assert.equal(parsed.featureCollection.features.filter(f => f.properties.text).length, 2);
  assert.ok(parsed.layers.includes('SITE-BOUNDARY'));
  assert.ok(parsed.layers.includes('ROADS'));

  const polygon = parsed.featureCollection.features.find(f => f.geometry.type === 'Polygon');
  assert.equal(polygon.geometry.coordinates[0].length, 4);
  assert.ok(Math.abs(polygon.geometry.coordinates[0][0][0] - 38.75) < 1e-6);

  const point = parsed.featureCollection.features.find(f => f.properties.entity === 'POINT');
  assert.ok(Math.abs(point.geometry.coordinates[0] - 38.7512) < 1e-6);
  assert.ok(Math.abs(point.geometry.coordinates[1] - 9.0231) < 1e-6);
});
