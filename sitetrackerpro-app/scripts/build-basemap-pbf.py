#!/usr/bin/env python3
"""Build the self-hosted basemap extract from an OSM PBF file (offline, no tile service).

    python3 scripts/build-basemap-pbf.py /tmp/ethiopia.osm.pbf backend/basemaps/addis-osm.json

Requires pyosmium (`pip install osmium`). The result is the same GeoJSON format consumed by
scripts/build-basemap.js, so either generator can feed the map. Data © OpenStreetMap contributors,
ODbL 1.0.

Only ways whose tagged classes matter for a contextual basemap are kept; ways are clipped to the
bbox by keeping contiguous runs of nodes that fall inside it.
"""
import json
import math
import sys
import time
from collections import Counter

import osmium

WEST, SOUTH, EAST, NORTH = 38.65, 8.90, 39.10, 9.15
PLACE_KINDS = {'city', 'town', 'suburb', 'neighbourhood', 'village'}
ROAD_CLASSES = {
    'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified',
    'residential', 'living_street', 'motorway_link', 'trunk_link',
    'primary_link', 'secondary_link', 'tertiary_link'
}
AREA_KINDS = {'forest', 'grass', 'recreation_ground', 'cemetery', 'industrial', 'commercial', 'farmland'}


def inside(lon, lat):
    return WEST <= lon <= EAST and SOUTH <= lat <= NORTH


def round5(value):
    return round(value, 5)


class NodeCollector(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.coords = {}
        self.places = []
        self.count = 0

    def node(self, n):
        self.count += 1
        if not n.location.valid():
            return
        lon, lat = n.location.lon, n.location.lat
        if not inside(lon, lat):
            return
        self.coords[n.id] = (round5(lon), round5(lat))
        tags = n.tags
        if tags.get('place') in PLACE_KINDS:
            self.places.append({
                'lon': round5(lon),
                'lat': round5(lat),
                'name': tags.get('name:en') or tags.get('name') or tags.get('place'),
                'localName': tags.get('name') or None,
                'place': tags.get('place')
            })


class WayCollector(osmium.SimpleHandler):
    def __init__(self, coords):
        super().__init__()
        self.coords = coords
        self.features = []
        self.counts = Counter()

    def _runs(self, refs):
        runs, current = [], []
        for ref in refs:
            point = self.coords.get(ref.ref)
            if point is None:
                if len(current) >= 2:
                    runs.append(current)
                current = []
                continue
            if not current or current[-1] != point:
                current.append(point)
        if len(current) >= 2:
            runs.append(current)
        return runs

    def way(self, w):
        tags = w.tags
        kind = klass = None
        if tags.get('highway') in ROAD_CLASSES:
            kind, klass = 'road', tags.get('highway')
        elif tags.get('railway') in {'rail', 'light_rail', 'subway'}:
            kind, klass = 'rail', tags.get('railway')
        elif tags.get('natural') == 'water':
            kind, klass = 'water', 'water'
        elif tags.get('waterway') in {'river', 'stream', 'canal'}:
            kind, klass = 'waterway', tags.get('waterway')
        elif tags.get('leisure') in {'park', 'garden', 'pitch', 'stadium', 'nature_reserve'}:
            kind, klass = 'park', tags.get('leisure')
        elif tags.get('landuse') in AREA_KINDS:
            kind, klass = 'landuse', tags.get('landuse')
        if not kind:
            return

        refs = list(w.nodes)
        if len(refs) < 2:
            return

        closed = kind in {'water', 'park', 'landuse'} and refs[0].ref == refs[-1].ref
        name = tags.get('name:en') or tags.get('name')
        properties = {'kind': kind, 'class': klass}
        if name:
            properties['name'] = str(name)[:120]

        if closed:
            ring = [self.coords.get(ref.ref) for ref in refs]
            if any(point is None for point in ring) or len(ring) < 4:
                return
            if ring[0] != ring[-1]:
                ring.append(ring[0])
            self.features.append({
                'type': 'Feature',
                'properties': properties,
                'geometry': {'type': 'Polygon', 'coordinates': [ring]}
            })
            self.counts[kind] += 1
            return

        for run in self._runs(refs):
            # Reject degenerate runs that only graze the bbox boundary.
            if len(run) < 2:
                continue
            self.features.append({
                'type': 'Feature',
                'properties': properties,
                'geometry': {'type': 'LineString', 'coordinates': run}
            })
            self.counts[kind] += 1


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    pbf = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else 'backend/basemaps/addis-osm.json'

    started = time.time()
    nodes = NodeCollector()
    nodes.apply_file(pbf)
    print(f'Pass 1: {nodes.count} nodes read, {len(nodes.coords)} inside bbox, {len(nodes.places)} places ({time.time() - started:.1f}s)')

    started = time.time()
    ways = WayCollector(nodes.coords)
    ways.apply_file(pbf)
    print(f'Pass 2: {len(ways.features)} features ({time.time() - started:.1f}s)')

    collection = {
        'type': 'FeatureCollection',
        'metadata': {
            'name': f'OpenStreetMap basemap extract ({WEST},{SOUTH},{EAST},{NORTH})',
            'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'source': 'OpenStreetMap PBF extract',
            'licence': 'ODbL 1.0',
            'attribution': '© OpenStreetMap contributors',
            'bbox': [WEST, SOUTH, EAST, NORTH],
            'counts': dict(ways.counts),
            'note': 'Context basemap only. Not a survey measurement and not authoritative for engineering work.'
        },
        'features': ways.features,
        'places': nodes.places
    }

    import os
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, 'w', encoding='utf-8') as handle:
        json.dump(collection, handle, separators=(',', ':'))
    print(f'Wrote {out}: {os.path.getsize(out) / 1024 / 1024:.2f} MB, {len(ways.features)} features, {len(nodes.places)} places')
    print(dict(ways.counts))
    import gzip
    with open(out, 'rb') as source, gzip.open(out + '.gz', 'wb', compresslevel=9) as target:
        target.write(source.read())
    print(f'Wrote {out}.gz for on-the-wire compression')


if __name__ == '__main__':
    main()
