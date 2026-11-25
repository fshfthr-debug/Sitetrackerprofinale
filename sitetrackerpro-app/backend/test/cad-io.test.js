const test = require('node:test');
const assert = require('node:assert');

const {
  featureCollectionToDxf,
  featureCollectionToKml,
  featureCollectionToShapefileZip,
  parseKml,
  parseShapefileZip,
  zipStore,
  unzip,
  dxfSafeName,
  crsWkt
} = require('../cad-io');

const boundary = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'Site boundary', layer: 'SITE-BOUNDARY', status: 'approved' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[38.75, 9.02], [38.76, 9.02], [38.76, 9.03], [38.75, 9.03], [38.75, 9.02]]]
      }
    },
    {
      type: 'Feature',
      properties: { name: 'Access road', layer: 'ROADS' },
      geometry: { type: 'LineString', coordinates: [[38.7505, 9.0205], [38.7555, 9.0275]] }
    },
    {
      type: 'Feature',
      properties: { name: 'CP-01', point_id: 'CP-01' },
      geometry: { type: 'Point', coordinates: [38.7512, 9.0231] }
    }
  ]
};

test('DXF export writes a valid R2000 structure with layers and entities', () => {
  const dxf = featureCollectionToDxf(boundary, { layerName: 'Site boundary', crs: 'EPSG:4326' });

  assert.match(dxf, /^999\n/);
  assert.match(dxf, /\$ACADVER\n1\nAC1015\n/);
  assert.match(dxf, /\$INSUNITS\n70\n0\n/, 'degrees are unitless in the DXF header');
  assert.match(dxf, /SECTION\n2\nHEADER/);
  assert.match(dxf, /SECTION\n2\nTABLES/);
  assert.match(dxf, /SECTION\n2\nENTITIES/);
  assert.match(dxf, /EOF\n$/);

  // Layer names come from the feature where present, falling back to the dataset name.
  assert.match(dxf, /LAYER\n2\nSITE-BOUNDARY/);
  assert.match(dxf, /LAYER\n2\nROADS/);
  assert.match(dxf, /2\nSITE_BOUNDARY/, 'the fallback layer is sanitised and upper-cased');

  // One closed polyline for the polygon, one open polyline for the road, one point for CP-01.
  assert.match(dxf, /AcDbPolyline\n90\n5\n70\n1/, 'the polygon is written closed with 5 vertices');
  assert.match(dxf, /AcDbPolyline\n90\n2\n70\n0/, 'the road is written open with 2 vertices');
  assert.match(dxf, /AcDbPoint/);
  assert.match(dxf, /TEXT[\s\S]*?1\nSite boundary/, 'polygon labels are kept as TEXT');
  assert.match(dxf, /10\n38\.7500000\n20\n9\.0200000/, 'geographic coordinates are written with 7 decimals');
});

test('DXF export uses metres and 3 decimals for projected coordinates', () => {
  const projected = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { name: 'Cut fill' },
      geometry: { type: 'Polygon', coordinates: [[[500000, 1000000], [500100, 1000000], [500100, 1000100], [500000, 1000000]]] }
    }]
  };
  const dxf = featureCollectionToDxf(projected, { crs: 'EPSG:32637' });
  assert.match(dxf, /\$INSUNITS\n70\n6\n/);
  assert.match(dxf, /10\n500000\.000\n20\n1000000\.000/);
});

test('DXF layer names avoid characters AutoCAD rejects', () => {
  assert.equal(dxfSafeName('Layer <1> / site', 'FALLBACK'), 'LAYER_-1-_-_SITE');
  assert.equal(dxfSafeName('', 'fallback'), 'FALLBACK');
  assert.ok(dxfSafeName('x'.repeat(60), 'f').length <= 31);
});

test('KML export and import round-trip geometry, holes and attributes', () => {
  const collection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { name: 'Pond', depth_m: 3 },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [[38.75, 9.02], [38.76, 9.02], [38.76, 9.03], [38.75, 9.02]],
          [[38.753, 9.023], [38.755, 9.023], [38.754, 9.025], [38.753, 9.023]]
        ]
      }
    }, {
      type: 'Feature',
      properties: { name: 'CP-01' },
      geometry: { type: 'Point', coordinates: [38.7512, 9.0231] }
    }]
  };

  const kml = featureCollectionToKml(collection, { name: 'Site' });
  assert.match(kml, /<kml xmlns="http:\/\/www.opengis.net\/kml\/2.2">/);
  assert.match(kml, /<innerBoundaryIs>/);

  const parsed = parseKml(kml);
  assert.equal(parsed.features.length, 2);
  const polygon = parsed.features.find(f => f.geometry.type === 'Polygon');
  assert.equal(polygon.properties.name, 'Pond');
  assert.equal(String(polygon.properties.depth_m), '3');
  assert.equal(polygon.geometry.coordinates.length, 2, 'the hole survives the round trip');
  assert.deepEqual(polygon.geometry.coordinates[0][0], [38.75, 9.02]);

  const point = parsed.features.find(f => f.geometry.type === 'Point');
  assert.deepEqual(point.geometry.coordinates, [38.7512, 9.0231]);
});

test('KML import reads LineString and SimpleData from a foreign file', () => {
  const kml = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Placemark><name>Ridge</name><LineString><coordinates>
      38.1,9.1,0 38.2,9.2,0 38.3,9.25,0
  </coordinates></LineString></Placemark>
  <Placemark><name>Peg</name><ExtendedData>
    <SchemaData><SimpleData name="chainage">12+400</SimpleData></SchemaData>
  </ExtendedData><Point><coordinates>38.15,9.15,0</coordinates></Point></Placemark>
</Document></kml>`;

  const parsed = parseKml(kml);
  assert.equal(parsed.features.length, 2);
  const line = parsed.features[0];
  assert.equal(line.geometry.type, 'LineString');
  assert.equal(line.geometry.coordinates.length, 3);
  assert.deepEqual(line.geometry.coordinates[2], [38.3, 9.25]);
  assert.equal(parsed.features[1].properties.chainage, '12+400');
});

test('ZIP writer and reader preserve stored entries byte for byte', () => {
  const archive = zipStore([
    { name: 'a.txt', data: 'hello' },
    { name: 'nested/b.bin', data: Buffer.from([0, 1, 2, 255]) }
  ]);
  const files = unzip(archive);
  assert.equal(files.size, 2);
  assert.equal(files.get('a.txt').toString('utf8'), 'hello');
  assert.deepEqual([...files.get('nested/b.bin')], [0, 1, 2, 255]);
});

test('Shapefile export produces a readable .shp/.shx/.dbf/.prj set', () => {
  const archive = featureCollectionToShapefileZip(boundary, { layerName: 'Site boundary', crs: 'EPSG:32637' });
  assert.ok(archive && archive.length > 100, 'an archive is produced');

  const files = unzip(archive);
  assert.ok(files.has('Site_boundary_polygon.shp'));
  assert.ok(files.has('Site_boundary_polygon.shx'));
  assert.ok(files.has('Site_boundary_polygon.dbf'));
  assert.ok(files.has('Site_boundary_polygon.prj'));
  assert.ok(files.has('Site_boundary_line.shp'));
  assert.ok(files.has('Site_boundary_point.shp'));
  assert.match(files.get('Site_boundary_polygon.prj').toString('utf8'), /UTM_Zone_37N/);

  const shp = files.get('Site_boundary_polygon.shp');
  assert.equal(shp.readInt32LE(0), 9994, 'shapefile magic number');
  assert.equal(shp.readInt32LE(32), 5, 'polygon shape type');

  const parsed = parseShapefileZip(archive);
  assert.ok(!parsed.error, parsed.error);
  assert.equal(parsed.features.length, 3);

  const polygon = parsed.features.find(f => f.geometry.type === 'Polygon');
  assert.deepEqual(polygon.geometry.coordinates[0][0], [38.75, 9.02]);
  assert.equal(polygon.properties.NAME, 'Site boundary');
  assert.equal(polygon.properties.LAYER, 'SITE-BOUNDARY');

  const point = parsed.features.find(f => f.geometry.type === 'Point');
  assert.deepEqual(point.geometry.coordinates, [38.7512, 9.0231]);
});

test('Shapefile import reports a helpful error when the zip has no .shp', () => {
  const archive = zipStore([{ name: 'notes.txt', data: 'nothing here' }]);
  const parsed = parseShapefileZip(archive);
  assert.match(parsed.error, /does not contain a \.shp file/);
});

test('crsWkt covers the CRSs the API exposes and falls back safely', () => {
  assert.match(crsWkt('EPSG:4326'), /GCS_WGS_1984/);
  assert.match(crsWkt('EPSG:32636'), /UTM_Zone_36N/);
  assert.match(crsWkt('EPSG:9999'), /GCS_WGS_1984/);
});
