"""Generates real GeoTIFF fixtures with known values, CRS and NoData.

Every expected number below is computed from the source array with numpy, independently of
geotiff.js, so the API statistics can be checked rather than trusted.
"""
import json, os
import numpy as np
import rasterio
from rasterio.transform import from_origin

OUT = os.path.dirname(os.path.abspath(__file__))
expected = {}

def write(name, arr, transform, crs, nodata=None, dtype='float32'):
    path = os.path.join(OUT, name)
    with rasterio.open(path, 'w', driver='GTiff', width=arr.shape[1], height=arr.shape[0],
                       count=1, dtype=dtype, crs=crs, transform=transform, nodata=nodata,
                       compress=None) as dst:
        dst.write(arr.astype(dtype), 1)
    return path

# --- 1. Valid DEM: WGS 84 / UTM 37N, 2 m cells, a NoData block and a NaN cell -------------
w, h = 300, 200
cols, rows = np.meshgrid(np.arange(w), np.arange(h))
elev = 2400.0 + 0.02 * cols + 0.03 * rows + 12.0 * np.sin(cols / 25.0) + 8.0 * np.cos(rows / 18.0)
elev = elev.astype('float32')
elev[40:70, 50:90] = -9999.0
elev[120, 30] = np.nan
transform = from_origin(500000.0, 1000000.0, 2.0, 2.0)
write('valid-utm37-dem.tif', elev, transform, 'EPSG:32637', nodata=-9999.0)
valid = elev[np.isfinite(elev) & (elev != -9999.0)]
expected['valid'] = {
    'width': w, 'height': h, 'epsg': 32637, 'nodata': -9999.0,
    'bounds': [500000.0, 999600.0, 500600.0, 1000000.0],
    'pixelSize': [2.0, 2.0],
    'validCells': int(valid.size),
    'min': float(valid.min()), 'max': float(valid.max()), 'mean': float(valid.mean()),
    'manifest': int(np.count_nonzero(elev == -9999.0))
}

# --- 2. Large-ish DEM: 2000 x 2000 (tests windowed reads and 512 px preview) ---------------
w2 = h2 = 2000
r2, c2 = np.mgrid[0:h2, 0:w2]
big = (2300.0 + 0.05 * c2 - 0.02 * r2 + 25.0 * np.sin(c2 / 180.0) * np.cos(r2 / 240.0)).astype('float32')
big[:, 0:5] = -32768.0
t2 = from_origin(496000.0, 1002000.0, 1.0, 1.0)
write('large-2000x2000-dem.tif', big, t2, 'EPSG:32637', nodata=-32768.0)
big_valid = big[big != -32768.0]
expected['large'] = {
    'width': w2, 'height': h2, 'validCells': int(big_valid.size),
    'bounds': [496000.0, 998000.0, 498000.0, 1002000.0],
    'min': float(big_valid.min()), 'max': float(big_valid.max()), 'mean': float(big_valid.mean())
}

# --- 3. Geographic WGS 84 DEM ------------------------------------------------------------
gw, gh = 120, 80
gr, gc = np.mgrid[0:gh, 0:gw]
geo = (2350.0 + 1.5 * np.sin(gc / 14.0) + 0.8 * np.cos(gr / 11.0)).astype('float32')
write('geographic-wgs84-dem.tif', geo, from_origin(38.7400, 9.0200, 0.0005, 0.0005), 'EPSG:4326')
expected['geographic'] = {
    'bounds': [38.74, 9.02 - gh * 0.0005, 38.74 + gw * 0.0005, 9.02],
    'min': float(geo.min()), 'max': float(geo.max())
}

# --- 4. Missing CRS, 5. unsupported CRS --------------------------------------------------
small = np.linspace(100.0, 120.0, 60 * 40, dtype='float32').reshape(40, 60)
write('missing-crs.tif', small, from_origin(500000.0, 1000000.0, 5.0, 5.0), None)
write('unsupported-mercator.tif', small, from_origin(4300000.0, 1100000.0, 5.0, 5.0), 'EPSG:3857')

# --- 6. Not a TIFF at all, and 7. TIFF header with corrupt body --------------------------
open(os.path.join(OUT, 'not-a-tiff.png'), 'wb').write(b'\x89PNG\r\n\x1a\n' + b'\x00' * 400)
with open(os.path.join(OUT, 'corrupt-header.tif'), 'wb') as fh:
    fh.write(b'II*\x00\x08\x00\x00\x00' + b'\xde\xad\xbe\xef' * 200)

with open(os.path.join(OUT, 'expected.json'), 'w') as fh:
    json.dump(expected, fh, indent=2)

# Corner coordinates used to place survey benchmarks on known DEM cells.
from rasterio.warp import transform as warp_transform
px, py = 100, 50
x = 500000.0 + (px + 0.5) * 2.0
y = 1000000.0 - (py + 0.5) * 2.0
lon, lat = warp_transform('EPSG:32637', 'EPSG:4326', [x], [y])
cell = float(elev[py, px])
expected['benchmarks'] = {
    'pixel': [px, py], 'xy': [x, y], 'lon': lon[0], 'lat': lat[0], 'demElevation': cell,
    'points': [
        {'name': 'BM-01', 'benchmark': round(cell + 1.5, 2), 'expectedDifference': round((cell + 1.5) - cell, 3)},
        {'name': 'BM-02', 'benchmark': round(cell - 0.5, 2), 'expectedDifference': round((cell - 0.5) - cell, 3)}
    ]
}
with open(os.path.join(OUT, 'expected.json'), 'w') as fh:
    json.dump(expected, fh, indent=2)

print(json.dumps({k: (v if k != 'large' else {kk: v[kk] for kk in ('width', 'height', 'min', 'max')}) for k, v in expected.items()}, indent=2, default=str))
