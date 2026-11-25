# Georeferenced IFC/GLB layer on the map — plan

Status: proposal, nothing implemented. Written 25 November 2026 against commit `8def8be`.

Goal: a BIM model (IFC, GLB or glTF) drawn **on the GIS map at its real position**, sharing pan, zoom,
bearing and pitch with the basemap, with the DEM underneath it, so an engineer can see the building
against the survey control points, the terrain and the CAD drawing instead of a separate 3D screen
that knows nothing about where the site is.

Non-goals for the first release: editing the model, clash detection against IFC geometry, 4D
sequencing, globe projection, and IFC authoring.

---

## 1. What already exists, and why we build on it

The hard part of this feature — deciding where the model sits on the earth — is already solved and
shipped. It should be reused, not re-invented.

| Piece | Where | What it gives us |
|---|---|---|
| Anchor record | `gis_georeferencing` table (`database/schema.sql:299`) | `crs`, `anchor_lat/lon/elevation`, `model_origin_east/north/up`, `rotation_deg`, `scale`, `z_offset`, `vertical_datum` |
| Alignment pairs | `gis_alignment_points` + `POST /api/gis/alignment/:projectId/points` | model coordinate ↔ survey control point pairs |
| Least-squares fit | `computeAlignmentFit` (`backend/gis.js:1777`) | 2D similarity `survey = t + s·R(θ)·model` from ≥3 pairs, with residuals |
| Apply / preview | `POST …/apply-fit`, `GET …/preview` (`backend/gis.js:1958`) | the exact model→lng/lat transform already used to draw the sample footprint |
| CRS registry | `backend/gis-crs.js` | proj4 definitions, WGS84 + Web Mercator + UTM 32–37 N (covers Ethiopia), projected-metres rule |
| Model viewer | `frontend/src/BimViewer.jsx` (1,252 lines) | IFC via web-ifc, GLB/glTF via `GLTFLoader`, storeys, element picking, measurements, take-off |
| Map | MapLibre GL 5.24.1, DEM terrain layers | `CustomLayerInterface`, `MercatorCoordinate`, terrain depth |

So this is not "build a BIM viewer". It is "give the existing viewer a map position and a renderer
that shares the map camera".

The transform the backend already applies (from `computeAlignmentPreview`) is:

```
anchorProjected = proj4(anchor_lon, anchor_lat → model CRS)          // metres in the CRS
a = scale·cos(rotation),  b = scale·sin(rotation)
east  = anchorProjected.e + a·(mE − originE) − b·(mN − originN)
north = anchorProjected.n + b·(mE − originE) + a·(mN − originN)
lngLat = proj4(east, north → EPSG:4326)
```

That is a rotation and a uniform scale about the model origin, in a projected plane. Everything
below is a way to run *this same* transform on the GPU instead of per point in JavaScript.

---

## 2. The anchor model

### 2.1 One source of truth, not two

Today the record stores the anchor **twice**: as `anchor_lat/lon` and as `model_origin_east/north`
(the same point expressed in the model CRS). `apply-fit` writes both consistently, but the manual
form lets a user type one and not the other, and nothing checks them against each other. Two
representations of one point is a bug factory at metre precision.

Proposal:

* The **authoritative** fields become `crs` + `model_origin_east/north/up` + `rotation_deg` +
  `scale` + `z_offset`.
* `anchor_lat/lon/elevation` become a **derived, stored** value: computed from the origin at save
  time, kept for display, health checks and for readers that cannot run proj4.
* On `PUT /api/gis/georeferencing`, if both are supplied and they disagree by more than 0.5 m
  (≈5e-6°), return 400 with both values and the difference in metres, rather than silently picking
  one. If only the anchor is supplied, back-derive the origin through proj4.
* A new `GET /api/gis/georeferencing/:projectId/placement` returns everything the renderer needs in
  one call, already resolved (see §5.1). The browser never runs proj4 for rendering.

### 2.2 New columns

```sql
ALTER TABLE gis_georeferencing
  ADD COLUMN north_reference VARCHAR(8) DEFAULT 'grid',   -- 'grid' | 'true'
  ADD COLUMN convergence_deg NUMERIC(7,4),                -- derived, cached for display
  ADD COLUMN placement_checked_at TIMESTAMP,
  ADD COLUMN model_bim_id INTEGER REFERENCES bim_models(id) ON DELETE SET NULL;
```

`north_reference` is not cosmetic — see §4.2. `model_bim_id` records *which* model the anchor was
fitted for; a project with two buildings then cannot silently show one model with the other's
rotation.

### 2.3 Semantics to write down (and enforce in the UI)

* Model coordinates are the numbers the IFC/GLB contains: `(mE, mN, mUp)` in **metres**, with
  `model_origin_*` naming the CRS coordinate that the model's own `(0,0,0)` corresponds to. A model
  exported in local coordinates near `(0,0)` is the normal case; a model already exported in UTM
  coordinates is handled by setting the origin to `(0,0)`.
* `rotation_deg` is the angle from model axes to CRS grid axes, **counter-clockwise positive**,
  which is the convention the fit already uses (`b = scale·sin(rotation)`). The manual form must
  say so, and the preview must draw a north arrow so the sign is confirmed by eye rather than by
  argument.
* `scale` is dimensionless and is **1.0 for a model drawn at true size in the same units**. It
  exists because a fitted similarity absorbs both a drawing-unit mistake (mm-as-m) and the grid-to-
  ground scale factor (§3.3). Hand-entered `scale` must be labelled "1.000000 unless the model was
  not drawn in metres".
* Heights: `z = z_offset + scale·mUp`, in metres above the anchor's vertical datum. No conversion
  is invented (§3.4).

---

## 3. CRS handling

### 3.1 What is accepted

Only a **projected CRS in metres** may carry model coordinates — the rule `computeAlignmentFit`
already enforces. A geographic CRS would mix degrees with model units and is refused with a message
that says so. The offered set (`WGS84`, `EPSG:3857`, `UTM 32–37N`) is sufficient for Ethiopia; a
project that needs `Adindan / UTM 37N` or a local grid gets it by adding a definition to
`gis-crs.js`, which is a data change, not a code change.

### 3.2 Convert once, on the server, at the anchor

The renderer must not call proj4 per vertex — not for speed, but for correctness: Web Mercator is
conformal, so a **single** similarity (rotation + scale) about the anchor is exact to well under a
centimetre across a site of a few kilometres. The plan is therefore:

1. Server: `origin(e,n) → proj4 → (lon, lat)`, once, at save time and in `/placement`.
2. Browser: build a Mercator matrix from `(lon, lat, height)` and the model's rotation and scale
   (§5.2). No projection maths in the render loop.

Documented limit: beyond roughly 5 km from the anchor the single-rotation approximation starts to
matter (projection curvature), so the UI warns when the model's bounding box is further than 5 km
from the anchor. Fitting a 20 km linear asset needs a per-vertex transform in a vertex shader
instead; out of scope, and named so nobody assumes it works.

### 3.3 Grid north versus true north (this is the one that bites)

A UTM grid north differs from true north by the meridian convergence γ, which in Ethiopia reaches
about 1–2° away from the zone's central meridian. A 100 m building rotated by 2° is 3.5 m out of
place — visible against a survey point, and exactly the kind of error that gets a plan rejected.

The plan computes γ numerically, without deriving a formula per projection:

```
p0 = proj4(origin, CRS → WGS84)
p1 = proj4(origin + (0, 1000), CRS → WGS84)     // 1 km grid north
γ  = bearing(p0 → p1)                            // 0° when grid north == true north
```

The bearing is computed with the standard initial-bearing formula on the two WGS84 points. The
result is stored in `convergence_deg` and returned by `/placement`. The render rotation is then:

```
renderRotation = rotation_deg + (north_reference === 'true' ? -γ : 0)
```

because the map's north is true north. The UI offers **Grid north / True north** with a one-line
explanation and shows γ in degrees next to the saved fit, so a surveyor can confirm it matches their
own software. Default: `grid` (what a CAD drawing exported north-up in the project CRS actually is).

Related but separate: the fitted `scale` absorbs the grid-to-ground scale factor. A manually placed
model with `scale = 1` is placed at **grid** distances, which differ from ground distances by
0.04–0.08 % in UTM. That is 4–8 cm per 100 m; the plan surfaces it as a note, and the fit removes it
when control points are used.

### 3.4 Heights and the vertical datum

`z_offset` is the only vertical correction, applied in metres. If a model's heights are orthometric
and the DEM's are ellipsoidal (or the reverse), the difference is the geoid undulation — tens of
metres, and not something to guess. The plan does **not** attempt a geoid conversion: it stores
`vertical_datum` as text, shows it in the placement panel, and lets the surveyor set `z_offset` from
a known benchmark. A future geoid model would be a separate, verifiable addition.

---

## 4. Rotation, scale and how a user gets them right

Three routes, in order of trust:

1. **Fitted** — ≥3 alignment pairs → `apply-fit`. The server computes rotation, scale, origin and
   residuals; the client cannot submit its own rotation "as if verified" (already the behaviour).
   Residuals are shown per point; >50 mm turns the fit amber, >250 mm red.
2. **Two points** — a surveyor who has two known points can derive rotation and scale from them
   without a least-squares fit. Cheap to add later; deliberately not in stage 1.
3. **Manual** — anchor + rotation + scale typed in, for a model whose IFC already carries a surveyed
   site origin. Every field has a unit, a sign convention and a live preview footprint.

Whichever route is used, the placement panel shows a **plan-view footprint** (already produced by
`/preview`) with the anchor, a north arrow, and the residual list. A user should be able to see a
wrong sign before a model ever reaches the 3D renderer.

Sanity guard: after fitting, if `|rotation| > 45°` the panel says so explicitly ("the model is
rotated N° — confirm this is not a swapped easting/northing"). Swapped coordinates are the single
most common georeferencing error and they look like a plausible 90° rotation.

---

## 5. The MapLibre custom layer

### 5.1 Data the renderer needs

`GET /api/gis/georeferencing/:projectId/placement` (new, project-scoped, auth-required):

```json
{
  "configured": true,
  "crs": "EPSG:32637",
  "anchor": { "lon": 38.7578, "lat": 8.9806, "height": 2354.0 },
  "modelOrigin": { "east": 478000.0, "north": 993000.0, "up": 0 },
  "rotationDeg": 12.5,
  "northReference": "grid",
  "convergenceDeg": -0.83,
  "renderRotationDeg": 11.67,
  "scale": 1.0,
  "zOffset": 0.0,
  "bbox": { "minE": 477950, "minN": 992960, "maxE": 478060, "maxN": 993040, "minUp": 0, "maxUp": 18 },
  "checks": { "residualMaxMm": 12, "distanceFromAnchorM": 420, "warnings": [] }
}
```

The model file itself comes from the existing `bim_models` row (`file_path`, `file_type`) through a
signed, auth-checked download route — no new storage concept in stage 1.

### 5.2 Geometry preparation (the part that prevents jitter)

Float32 cannot hold UTM northing (≈9,930,000) with millimetre precision, and a Mercator coordinate
is a 0–1 number, so both must never appear in the vertex buffer. At load time, before the first
frame:

1. Read the model into `three` as now (`web-ifc` or `GLTFLoader`).
2. Compute the model's bounding box; **rebase** every geometry by the box centre (or the stored
   model origin) with `geometry.translate(-cx, -cy, -cz)`; keep the offset on the CPU.
3. Store per-element `expressID`/name so picking and property lookup keep working.

After rebasing, coordinates are small doubles/f32 that survive the GPU, and the map matrix carries
the world position.

### 5.3 The matrix

```js
// once per placement change
const anchor = maplibregl.MercatorCoordinate.fromLngLat({ lng: lon, lat }, height); // height in metres
const mPerMerc = anchor.meterInMercatorCoordinateUnits();            // metres → mercator units at this latitude
const rot = THREE.MathUtils.degToRad(renderRotationDeg);

const modelMatrix = new THREE.Matrix4()
  .makeTranslation(anchor.x, anchor.y, anchor.z)
  .scale(new THREE.Vector3(mPerMerc, -mPerMerc, mPerMerc)) // Mercator y grows southwards
  .multiply(new THREE.Matrix4().makeRotationZ(rot))
  .scale(new THREE.Vector3(scale, scale, scale))
  .multiply(new THREE.Matrix4().makeTranslation(-cx, -cy, -cz + zOffset / scale));
```

Note `fromLngLat`: the plain `new MercatorCoordinate(x, y, z)` constructor takes mercator units,
not degrees and metres — passing degrees and metres there is a silent 10,000× error. `anchor.z` is
then already in mercator units, so terrain clearance comes out right.

### 5.4 The layer

```js
const bimLayer = {
  id: 'bim-model',
  type: 'custom',
  renderingMode: '3d',
  onAdd(map, gl) { /* renderer, scene, camera; store map */ },
  render(gl, args) {
    camera.projectionMatrix = new THREE.Matrix4().fromArray(args.projectionMatrix);
    // MapLibre 5.24.1 also exposes args.defaultProjectionData.projectionMatrix; confirm which one
    // matches the documented three.js example for this version in the stage-0 spike.
    renderer.resetState();
    renderer.render(scene, camera);
  }
};
```

Verified in the installed types (`maplibre-gl.d.ts`): `CustomLayerInterface` with
`renderingMode: '2d' | '3d'` and a `render(gl, …)` method; `MercatorCoordinate` with
`meterInMercatorCoordinateUnits()`; `map.transform.getProjectionDataForCustomLayer(applyGlobeMatrix)`
and `ProjectionData.mainMatrix` for globe-aware work later.

Behaviour to get right:

* **Camera**: three's camera needs no position of its own if the scene uses `modelMatrix` as a world
  transform and the projection matrix comes from MapLibre — this is what keeps the model glued to
  the ground during pan/pitch/bearing.
* **Depth**: keep the depth buffer as MapLibre left it (do not `clear`) so the DEM rejects fragments
  behind hills; `gl.enable(DEPTH_TEST)` and `depthMask(true)`, with a small negative polygon offset
  so walls do not z-fight with the terrain surface.
* **Ordering**: add the layer above the DEM and below labels (`beforeId` of the first symbol layer),
  so building names still draw on top.
* **Repaint**: custom layers render every frame; still call `map.triggerRepaint()` when the model's
  style or visibility changes (storey toggle, section plane).
* **Picking**: raycast against loaded meshes only, and convert the hit point back to site
  coordinates (`mE, mN, mUp`) for the inspector — a measurement in model units is useless to a
  surveyor.
* **Terrain**: with `map.setTerrain` active, custom layers are drawn with the terrain depth present;
  verify occlusion on a hill in stage 1 rather than assuming.
* **Projection**: force `mercator` while a model layer is visible. Globe support via
  `getProjectionDataForCustomLayer(true)` is a later step, not a promise.
* **Budget**: one model at a time on the map in stage 1 (not two buildings plus a bridge); the
  matrix maths generalises, the memory budget on a Render instance does not.

---

## 6. Conversion route — which one, and why

Three realistic ways to get IFC geometry into that layer, with their licences verified today:

| Route | Licence | Where | Cost / risk |
|---|---|---|---|
| **A. web-ifc in the browser** (what `BimViewer.jsx` does now) | MPL-2.0 (file-level copyleft, no linking issue) | client | No server work; re-parses on every open; 1.6 MB wasm; a 100 MB IFC will exhaust a phone and strain a laptop; no cache, no LOD |
| **B. IFC → Fragments on the server** (`@thatopen/fragments` + web-ifc, Node) | **MIT** (Fragments), MPL-2.0 (web-ifc) | server, cached | Best licence posture of the three; Fragments carries geometry, properties and LOD; needs a spike to confirm the importer runs headless in Node without a DOM |
| **C. IFC → GLB via `IfcConvert`** (IfcOpenShell CLI) | **LGPL-3.0-or-later** | server, isolated binary | GLB is trivially loadable by the `GLTFLoader` already in the app; LGPL means shipping the source offer and allowing replacement — the same notices pattern LibreDWG already uses |

**Decision: A for small files now, B as the production route, C as the documented fallback.**

Reasoning:

1. **Licence first.** B is MIT/MPL — no copyleft obligation at all beyond web-ifc's existing
   file-level MPL, which we already satisfy by not modifying it. C is LGPL and, although running it
   as a separate binary is defensible (exactly as `dwg2dxf` is), every extra copyleft binary is a
   support obligation and a notices file to keep honest. Choose the route that needs neither when it
   also happens to be the better format.
2. **Size.** A cannot survive a real Ethiopian building model: IFC is text-heavy and web-ifc's
   memory footprint is several times the file. Parsing 100 MB on every open, per user, on a phone
   with site photos, is not a design — it is a demo. B converts once, caches by content hash, and
   ships a binary format with a spatial index.
3. **Properties and picking.** B keeps element properties and relationships in the same file, so the
   map inspector can show the same data the BIM screen shows. C would need a second pipeline to
   carry `Qto_*` sets, since GLB carries geometry only.
4. **LOD.** B carries levels of detail, which is what makes a 20-storey model usable while pitching
   a map. A GLB is one mesh set; decimation would be our problem.
5. **Fallback honesty.** If the headless Fragments import does not work reliably in Node (it is a
   TypeScript package built around a viewer), the plan falls back to C and accepts LGPL with the
   notices pattern — a known, bounded cost, not a redesign.

Storage: a new table rather than the existing `model_cache_3d` blob.

```sql
CREATE TABLE IF NOT EXISTS bim_model_cache (
  id SERIAL PRIMARY KEY,
  bim_model_id INTEGER NOT NULL REFERENCES bim_models(id) ON DELETE CASCADE,
  source_sha256 CHAR(64) NOT NULL,
  format VARCHAR(24) NOT NULL,          -- 'fragments' | 'glb'
  converter VARCHAR(64) NOT NULL,       -- e.g. '@thatopen/fragments@3.x'
  bytes BIGINT NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  status VARCHAR(16) NOT NULL,          -- 'pending' | 'ready' | 'failed'
  error TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (bim_model_id, source_sha256, format)
);
```

Conversion runs as a bounded job with the now-established pattern: size cap, wall-clock timeout,
memory cap, one scratch directory, job status polled by the client, and a failed job that explains
itself. A 100 MB IFC converted on a small instance is a denial-of-service waiting to happen, so the
same limits discipline as `backend/dwg.js` applies.

---

## 7. Stages

| Stage | Scope | Deliverable | Effort |
|---|---|---|---|
| **0. Spike (time-boxed half day)** | Confirm in 5.24.1 which projection matrix the three.js custom layer wants; confirm world-alignment with a 10 m cube at a known coordinate; confirm depth against a DEM hill | A throwaway page + screenshot, decision recorded in this file | 0.5 d |
| **1. Placement API + GLB on the map** | `/placement` route with convergence, origin/anchor consistency check, 400 on disagreement; custom layer; rebasing; anchor/rotation/scale controls wired to the existing Georeferencing panel; GLB upload reusing `bim_models` | A GLB building standing on the map at the right coordinate, correct against a control point | 2.5 d |
| **2. IFC in place (small files)** | Reuse `BimViewer` geometry extraction in the layer for files ≤ 25 MB, with a clear "large model" path to stage 3 | An IFC on the map without conversion | 2 d |
| **3. Server conversion + cache** | B route (Fragments) with C as fallback; job status; `bim_model_cache`; content-hash reuse; progress UI | 100 MB IFC on the map in seconds on second open | 3–4 d |
| **4. Cartographic finish** | Storey filter and section plane on the map, click-through inspector with site coordinates, label collision, model outline when far away | Reads like a drawing overlay, not a game | 2 d |
| **5. Performance and mobile** | Bounding-box culling, LOD switch by screen size, 60 fps target on the survey laptop, sane behaviour on a phone | Measured frame times, not claimed | 1 d |

Stage 1 is the risky one and the only one that must be right before anything else matters: if the
anchor, rotation and convergence are wrong, a beautiful renderer places a building 4 m into the
road.

---

## 8. Verification

Numbers, not screenshots alone:

1. **Unit, transform**: a fixture model whose four corners are known in model coordinates, a fixture
   georeference, and the expected lng/lat computed independently by proj4 → assert the renderer's
   `modelMatrix` places each corner within **1 cm**. This is the test that catches a rotation sign
   and a missing convergence.
2. **Unit, CRS**: convergence for a point on the UTM 37N central meridian is 0.00°; a point 2° east
   of it is within 10 % of the analytic value; a known Addis Ababa benchmark matches published
   grid-to-ground scale factors.
3. **Unit, API**: `/placement` returns 400 when anchor and origin disagree by >0.5 m, and when no
   CRS is set; it returns warnings when the bbox is >5 km from the anchor.
4. **Integration**: the GLB standing on a surveyed control point, checked in the browser by
   `map.project()` on the anchor against the known screen position of a map marker at the same
   coordinate — agreement within 1 px.
5. **Depth**: a model behind a DEM ridge is occluded — screenshot at two pitches.
6. **Perf**: frame time with a 1 M-triangle model, before and after LOD, measured with the browser
   profiler and reported as numbers.

Not claimed until measured: mobile performance, IFC4x3, files > 100 MB, globe projection, and models
whose IFC carries a rotated `IfcSite` placement (that is the next most likely coordinate bug after
swapped eastings).

---

## 9. Risks

* **Sign conventions** are the main failure mode: rotation sign, north reference, Mercator y. The
  fixture test in §8.1 and the north arrow in the preview are the defence.
* **Redundant anchor/origin storage** will drift unless the consistency check lands in the same
  change as the placement API.
* **Headless Fragments import** may not work outside a browser; the fallback (LGPL `IfcConvert`) is
  priced in, not a surprise.
* **Render memory** — the instance has no headroom for a 100 MB conversion plus a serving process;
  conversion must be bounded and ideally capped by plan, with a clear "too large" message.
* **Terrain depth** interplay can look wrong in ways that are hard to debug; stage 0 measures it
  before stage 1 builds on it.

## 10. Decisions needed from you

1. **Vertical datum**: heights relative to the site benchmark with a manual `z_offset` (proposed), or
   do you need a geoid model for a specific project?
2. **Default north reference**: grid (proposed) or true north — this depends on whether your CAD
   drawings are exported grid-north-up.
3. **Large-model policy**: cap IFC at 100 MB and convert server-side, or allow larger files with a
   longer job and a warning?
4. **Route confirmation**: MIT Fragments first with the LGPL `IfcConvert` fallback (proposed), or go
   straight to the isolated LGPL binary because it is the known-good converter.
