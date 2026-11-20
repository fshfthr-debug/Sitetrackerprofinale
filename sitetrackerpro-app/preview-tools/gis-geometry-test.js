#!/usr/bin/env node
/**
 * Deterministic tests for the pure parts of the GIS module: OSM geometry classification,
 * multipolygon assembly, bbox validation and the EPSG:4326 coordinate guard.
 *
 *   node preview-tools/gis-geometry-test.js
 *
 * No network and no database: these run the functions directly.
 */

const gis = require('../backend/gis');

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

const square = (lon, lat, size = 0.001) => [
  [lon, lat], [lon + size, lat], [lon + size, lat + size], [lon, lat + size], [lon, lat]
];
const wayElement = (id, tags, coords) => ({
  type: 'way',
  id,
  tags,
  geometry: coords.map(([lon, lat]) => ({ lon, lat }))
});

console.log('OSM geometry classification');

// --- closed ways: the actual bug that was fixed (any selected polygon category used to
// turn every closed way into a polygon, including roundabouts and closed footways).
const closedFootway = gis.osmWayToGeoJson(wayElement(1, { highway: 'footway' }, square(38.76, 9.01)));
check('a closed footway stays a LineString', closedFootway.geometry.type === 'LineString', closedFootway.geometry.type);

const closedService = gis.osmWayToGeoJson(wayElement(2, { highway: 'service' }, square(38.76, 9.01)));
check('a closed service road stays a LineString', closedService.geometry.type === 'LineString', closedService.geometry.type);

const roundabout = gis.osmWayToGeoJson(wayElement(3, { highway: 'primary', junction: 'roundabout' }, square(38.76, 9.01)));
check('a roundabout stays a LineString', roundabout.geometry.type === 'LineString', roundabout.geometry.type);

const building = gis.osmWayToGeoJson(wayElement(4, { building: 'yes' }, square(38.76, 9.01)));
check('a closed building is a Polygon', building.geometry.type === 'Polygon', building.geometry.type);
check('the polygon ring is closed', building.geometry.coordinates[0][0].join() === building.geometry.coordinates[0].slice(-1)[0].join());

const landuse = gis.osmWayToGeoJson(wayElement(5, { landuse: 'residential' }, square(38.76, 9.01)));
check('closed landuse is a Polygon', landuse.geometry.type === 'Polygon', landuse.geometry.type);

const pond = gis.osmWayToGeoJson(wayElement(6, { natural: 'water' }, square(38.76, 9.01)));
check('a closed natural=water is a Polygon', pond.geometry.type === 'Polygon', pond.geometry.type);

const riverLoop = gis.osmWayToGeoJson(wayElement(7, { waterway: 'river' }, square(38.76, 9.01)));
check('a closed river loop stays a LineString', riverLoop.geometry.type === 'LineString', riverLoop.geometry.type);

const forcedArea = gis.osmWayToGeoJson(wayElement(8, { highway: 'pedestrian', area: 'yes' }, square(38.76, 9.01)));
check('area=yes on a closed way makes it a Polygon', forcedArea.geometry.type === 'Polygon', forcedArea.geometry.type);

const forcedLine = gis.osmWayToGeoJson(wayElement(9, { building: 'yes', area: 'no' }, square(38.76, 9.01)));
check('area=no keeps even a building as a LineString', forcedLine.geometry.type === 'LineString', forcedLine.geometry.type);

const openBuilding = gis.osmWayToGeoJson(wayElement(10, { building: 'yes' }, [[38.76, 9.01], [38.761, 9.01], [38.761, 9.011]]));
check('an open building outline is not closed into a polygon', openBuilding.geometry.type === 'LineString', openBuilding.geometry.type);

// --- coordinate order: GeoJSON is [longitude, latitude]
const node = gis.osmNodeToGeoJson({ type: 'node', id: 11, lat: 9.0102, lon: 38.7606, tags: { power: 'tower' } });
check('a node becomes a Point in [longitude, latitude]',
  node.geometry.type === 'Point' && node.geometry.coordinates[0] === 38.7606 && node.geometry.coordinates[1] === 9.0102,
  node.geometry.coordinates);
check('node provenance is attached', node.properties.osm_type === 'node' && /OpenStreetMap/.test(node.properties.source), node.properties);

// --- multipolygon relations
const outer = square(38.76, 9.01, 0.01);
const inner = square(38.763, 9.013, 0.002);
const relation = gis.osmRelationToGeoJson({
  type: 'relation',
  id: 12,
  tags: { building: 'yes', type: 'multipolygon' },
  members: [
    { type: 'way', role: 'outer', geometry: outer.map(([lon, lat]) => ({ lon, lat })) },
    { type: 'way', role: 'inner', geometry: inner.map(([lon, lat]) => ({ lon, lat })) }
  ]
});
check('a multipolygon relation becomes a MultiPolygon', relation.feature?.geometry.type === 'MultiPolygon', relation.feature?.geometry.type);
check('the inner ring is kept as a hole on the outer polygon',
  relation.feature?.geometry.coordinates[0].length === 2, relation.feature?.geometry.coordinates[0].length);
check('relation provenance names the relation', relation.feature?.properties.osm_type === 'relation' && relation.feature?.properties.osm_id === 12);

const brokenRelation = gis.osmRelationToGeoJson({
  type: 'relation', id: 13, tags: { building: 'yes' },
  members: [{ type: 'way', role: 'outer', geometry: [[38.76, 9.01], [38.761, 9.01]].map(([lon, lat]) => ({ lon, lat })) }]
});
check('a relation without a closed ring is skipped, not guessed', brokenRelation.feature === null && brokenRelation.unclosed === 1, brokenRelation);

const collection = gis.osmToFeatureCollection([
  { type: 'node', id: 1, lat: 9, lon: 38, tags: { highway: 'crossing' } },
  wayElement(2, { highway: 'residential' }, [[38.76, 9.01], [38.761, 9.011]]),
  { type: 'relation', id: 3, tags: { building: 'yes' }, members: [{ type: 'way', role: 'outer', geometry: outer.map(([lon, lat]) => ({ lon, lat })) }] }
], ['roads', 'buildings']);
check('nodes, ways and relations are all counted', collection.stats.nodes === 1 && collection.stats.ways === 1 && collection.stats.relations === 1, collection.stats);
check('the collection is a GeoJSON FeatureCollection', collection.featureCollection.type === 'FeatureCollection' && collection.featureCollection.features.length === 3);

console.log('\nBounding-box validation');
check('a valid bbox is accepted', gis.parseBbox([38.75, 9.00, 38.77, 9.02]).bbox?.length === 4);
check('west > east is refused instead of silently swapped',
  /west .* must be less than east/.test(gis.parseBbox([38.77, 9.00, 38.75, 9.02]).error || ''), gis.parseBbox([38.77, 9.00, 38.75, 9.02]));
check('south > north is refused', Boolean(gis.parseBbox([38.75, 9.02, 38.77, 9.00]).error));
check('coordinates beyond the poles are refused', Boolean(gis.parseBbox([0, -89, 1, -80]).error));
check('out-of-range longitudes are refused', Boolean(gis.parseBbox([-190, 0, -170, 10]).error));
check('a non-numeric bbox is refused', Boolean(gis.parseBbox(['a', 0, 1, 1]).error));
check('a malformed bbox is refused', Boolean(gis.parseBbox([1, 2, 3]).error));

console.log('\nCoordinate guards');
// A latitude such as 38.76 is indistinguishable from a longitude by range alone, so only
// values outside the geographic range can be refused; the rest is the documented
// [longitude, latitude] contract.
const axisGuard = (() => {
  try {
    gis.transformPoint([38.7606, 91], 'EPSG:4326', 'EPSG:32637');
    return null;
  } catch (err) {
    return err.message;
  }
})();
check('a coordinate outside the geographic range is refused', /\[longitude, latitude\]/.test(axisGuard || ''), axisGuard);

const farNorth = (() => {
  try {
    gis.transformPoint([500000, 996000], 'EPSG:4326', 'EPSG:32637');
    return null;
  } catch (err) {
    return err.message;
  }
})();
check('projected metres offered as degrees are refused', Boolean(farNorth), farNorth);

check('a projected dataset with metre coordinates is refused',
  gis.validateGeographic({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [473687, 995988] }, properties: {} }]
  }).ok === false);
check('a geographic dataset passes validation',
  gis.validateGeographic({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [38.7606, 9.0102] }, properties: {} }]
  }).ok === true);

console.log(`\n${passed} passed, ${failures.length} failed`);
failures.forEach(name => console.log(`  failed: ${name}`));
if (failures.length) process.exit(1);
