'use strict';
/**
 * Placement resolution for the georeferenced 3D layer.
 *
 * One job: take the saved georeferencing record plus its alignment pairs and return
 * everything the map renderer needs, already resolved — anchor, model origin, rotation
 * (including meridian convergence), scale, height offset, bbox and the checks that make
 * a wrong placement visible before it is drawn.
 *
 * Kept free of Express and the database so the transform can be unit tested.
 */

const { crsDefinition, transformPoint } = require('./gis-crs');

// When a model is already drawn in CRS coordinates, its origin and the anchor describe the same
// point and must agree. Anything beyond this is a real disagreement, not rounding, and is refused
// rather than silently preferred. A model drawn in local coordinates near (0,0) is the normal
// case, and there the origin is a model coordinate, not an easting: the check does not apply.
const ANCHOR_ORIGIN_TOLERANCE_M = 0.5;
const SAME_PLACE_LIMIT_M = 5000;

// Beyond this the single rotation about the anchor stops being exact (projection curvature).
const FAR_FROM_ANCHOR_M = 5000;

const round = (value, digits) => Number(Number(value).toFixed(digits));

function badRequest(message, extra) {
  const error = new Error(message);
  error.status = 400;
  if (extra) error.details = extra;
  return error;
}

function normaliseDegrees(value) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

// Standard initial bearing on the WGS 84 sphere. Only used for the convergence angle, which
// is a display-grade correction (tenths of a degree), not a survey bearing.
function initialBearingDegrees(lat1, lon1, lat2, lon2) {
  const toRad = (value) => (value * Math.PI) / 180;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaLon = toRad(lon2 - lon1);
  const y = Math.sin(deltaLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLon);
  return normaliseDegrees((Math.atan2(y, x) * 180) / Math.PI);
}

// Meridian convergence, computed numerically so no per-projection formula has to be trusted:
// project the origin and a point 1 km grid-north of it, and measure the bearing between them.
// A UTM grid that happens to run true north returns 0.
function convergenceDegrees(definition, east, north) {
  if (!definition) throw new Error('convergenceDegrees needs a CRS definition.');
  const origin = transformPoint([east, north], definition.code, 'EPSG:4326');
  const gridNorth = transformPoint([east, north + 1000], definition.code, 'EPSG:4326');
  return {
    origin: { lon: origin[0], lat: origin[1] },
    gridNorth: { lon: gridNorth[0], lat: gridNorth[1] },
    convergenceDeg: round(initialBearingDegrees(origin[1], origin[0], gridNorth[1], gridNorth[0]), 6)
  };
}

function projectedDefinition(georef) {
  if (!georef || !georef.crs) {
    throw badRequest('No model CRS is saved. Save the CRS, anchor, rotation and scale before placing a model.');
  }
  const definition = crsDefinition(georef.crs);
  if (!definition) {
    throw badRequest(`CRS ${georef.crs} is not supported. Choose one from GET /api/gis/crs.`);
  }
  if (definition.units === 'degrees') {
    throw badRequest('A geographic CRS cannot carry model coordinates. Choose a projected CRS in metres.');
  }
  return definition;
}

// Distance in metres between an anchor (lng/lat) and a model origin (CRS metres).
function anchorOriginDistanceMetres(definition, anchor, origin) {
  const projected = transformPoint([Number(anchor.lon), Number(anchor.lat)], 'EPSG:4326', definition.code);
  return Math.hypot(projected[0] - Number(origin.east), projected[1] - Number(origin.north));
}

function modelToSurvey(anchorProjected, originEast, originNorth, rotationDeg, scale) {
  const radians = (rotationDeg * Math.PI) / 180;
  const a = scale * Math.cos(radians);
  const b = scale * Math.sin(radians);
  return (east, north) => {
    const dx = east - originEast;
    const dy = north - originNorth;
    return [anchorProjected[0] + a * dx - b * dy, anchorProjected[1] + b * dx + a * dy];
  };
}

/**
 * resolvePlacement(georef, { pairs, model })
 *
 * georef: a row from gis_georeferencing (snake_case).
 * pairs:  rows from gis_alignment_points joined with surveying_control_points.
 * model:  { id, fileName, fileType, fileUrl } or null.
 *
 * Throws an error with status 400 and a message that names the missing field.
 */
function resolvePlacement(georef, { pairs = [], model = null } = {}) {
  const definition = projectedDefinition(georef);

  const anchorLat = georef.anchor_lat === null || georef.anchor_lat === undefined ? null : Number(georef.anchor_lat);
  const anchorLon = georef.anchor_lon === null || georef.anchor_lon === undefined ? null : Number(georef.anchor_lon);
  const anchorElevation = georef.anchor_elevation === null || georef.anchor_elevation === undefined
    ? null : Number(georef.anchor_elevation);
  const originEast = georef.model_origin_east === null || georef.model_origin_east === undefined
    ? null : Number(georef.model_origin_east);
  const originNorth = georef.model_origin_north === null || georef.model_origin_north === undefined
    ? null : Number(georef.model_origin_north);
  const originUp = georef.model_origin_up === null || georef.model_origin_up === undefined
    ? null : Number(georef.model_origin_up);
  const rotationDeg = georef.rotation_deg === null || georef.rotation_deg === undefined
    ? null : Number(georef.rotation_deg);
  const scale = georef.scale === null || georef.scale === undefined ? null : Number(georef.scale);
  const zOffset = georef.z_offset === null || georef.z_offset === undefined ? 0 : Number(georef.z_offset);

  const hasAnchor = anchorLat !== null && anchorLon !== null && Number.isFinite(anchorLat) && Number.isFinite(anchorLon);
  const hasOrigin = originEast !== null && originNorth !== null && Number.isFinite(originEast) && Number.isFinite(originNorth);

  if (!hasAnchor && !hasOrigin) {
    throw badRequest('Neither an anchor nor a model origin is saved, so the model has no position.');
  }
  if (rotationDeg === null || !Number.isFinite(rotationDeg)) {
    throw badRequest('No rotation is saved. Save 0 for a north-up model, or fit it from alignment pairs.');
  }
  if (scale === null || !Number.isFinite(scale) || scale <= 0) {
    throw badRequest('No scale is saved. Save 1 for a model drawn at true size in metres.');
  }

  // Both records of the same point: refuse to pick one silently.
  let anchor = hasAnchor ? { lat: anchorLat, lon: anchorLon } : null;
  let origin = hasOrigin ? { east: originEast, north: originNorth } : null;
  let discrepancyMetres = null;

  if (anchor && origin) {
    const gap = anchorOriginDistanceMetres(definition, anchor, origin);
    if (gap <= SAME_PLACE_LIMIT_M) {
      // Plausibly both in CRS metres: same point, so a gap is a typo.
      discrepancyMetres = round(gap, 3);
      if (discrepancyMetres > ANCHOR_ORIGIN_TOLERANCE_M) {
        throw badRequest(
          `The anchor and the model origin describe the same point but disagree by ${discrepancyMetres} m ` +
          `(limit ${ANCHOR_ORIGIN_TOLERANCE_M} m). Correct one of them; nothing was placed.`,
          { anchor, modelOrigin: origin, discrepancyMetres, limitMetres: ANCHOR_ORIGIN_TOLERANCE_M }
        );
      }
    } else {
      // Local model coordinates: the origin is a model coordinate, not the anchor's easting.
      discrepancyMetres = null;
    }
  } else if (origin) {
    const derived = transformPoint([origin.east, origin.north], definition.code, 'EPSG:4326');
    anchor = { lat: round(derived[1], 8), lon: round(derived[0], 8) };
  } else {
    const derived = transformPoint([anchor.lon, anchor.lat], 'EPSG:4326', definition.code);
    origin = { east: round(derived[0], 4), north: round(derived[1], 4) };
  }

  const anchorProjected = transformPoint([anchor.lon, anchor.lat], 'EPSG:4326', definition.code);

  // Convergence is a property of the site, not of the model's local origin: it must be taken at
  // the anchor's projected coordinates. A model in local coordinates has an origin of (0,0),
  // which is nowhere near the site and would give a meaningless convergence.
  const northReference = georef.north_reference === 'true' ? 'true' : 'grid';
  const convergence = convergenceDegrees(definition, anchorProjected[0], anchorProjected[1]);
  const renderRotationDeg = round(rotationDeg + (northReference === 'true' ? -convergence.convergenceDeg : 0), 6);
  const toSurvey = modelToSurvey(anchorProjected, origin.east, origin.north, rotationDeg, scale);

  const warnings = [];

  const anchorHeight = anchorElevation === null || !Number.isFinite(anchorElevation) ? 0 : anchorElevation;
  if (anchorElevation === null || !Number.isFinite(anchorElevation)) {
    warnings.push('The anchor elevation is not recorded, so the model is drawn at 0 m (sea level). Set the anchor elevation, or the height offset, from a benchmark.');
  }
  if (!georef.vertical_datum) {
    warnings.push('No vertical datum is recorded; heights are drawn as entered, with no geoid conversion.');
  }
  if (georef.north_reference === null || georef.north_reference === undefined) {
    warnings.push(`North reference was not recorded; grid north is assumed (convergence ${convergence.convergenceDeg}°).`);
  }
  if (Math.abs(rotationDeg) > 45) {
    warnings.push(`The model is rotated ${round(rotationDeg, 3)}°. Confirm this is not a swapped easting/northing, which looks like a plausible 90° rotation.`);
  }

  let residualMaxMm = null;
  const usablePairs = pairs.filter((row) => row.model_east !== null && row.model_north !== null
    && row.latitude !== null && row.longitude !== null);
  if (pairs.length > 0) {
    const residuals = usablePairs.map((row) => {
      const predicted = toSurvey(Number(row.model_east), Number(row.model_north));
      const survey = transformPoint([Number(row.longitude), Number(row.latitude)], 'EPSG:4326', definition.code);
      return Math.hypot(predicted[0] - survey[0], predicted[1] - survey[1]);
    });
    if (residuals.length > 0) residualMaxMm = round(Math.max(...residuals) * 1000, 1);
    if (pairs.length < 3) {
      warnings.push(`Only ${pairs.length} alignment pair(s) are recorded, so the placement cannot be checked properly. Three or more are needed.`);
    }
    if (residualMaxMm !== null && residualMaxMm > 50) {
      warnings.push(`The placement misses a survey control point by ${residualMaxMm} mm. Inspect the fit before relying on this position.`);
    }
  } else {
    warnings.push('No alignment pairs are recorded, so the model position cannot be checked against a survey control point.');
  }

  // bbox is the model-space extent of the alignment pairs: the only model geometry the
  // server knows until a file is parsed (stage 3).
  let bbox = null;
  let distanceFromAnchorM = null;
  const extentPairs = pairs.filter((row) => Number.isFinite(Number(row.model_east)) && Number.isFinite(Number(row.model_north)));
  if (extentPairs.length >= 2) {
    const easts = extentPairs.map((row) => Number(row.model_east));
    const norths = extentPairs.map((row) => Number(row.model_north));
    const ups = extentPairs.map((row) => (row.model_up === null ? null : Number(row.model_up))).filter((v) => v !== null);
    bbox = {
      minE: round(Math.min(...easts), 3), maxE: round(Math.max(...easts), 3),
      minN: round(Math.min(...norths), 3), maxN: round(Math.max(...norths), 3),
      minUp: ups.length ? round(Math.min(...ups), 3) : null,
      maxUp: ups.length ? round(Math.max(...ups), 3) : null
    };
    const corners = [
      [bbox.minE, bbox.minN], [bbox.minE, bbox.maxN],
      [bbox.maxE, bbox.minN], [bbox.maxE, bbox.maxN]
    ];
    distanceFromAnchorM = round(Math.max(...corners.map(([east, north]) => Math.hypot(
      (east - origin.east) * scale, (north - origin.north) * scale
    ))), 1);
    if (distanceFromAnchorM > FAR_FROM_ANCHOR_M) {
      warnings.push(`The model extends ${distanceFromAnchorM} m from its anchor. A single rotation about the anchor is only exact for a few kilometres; split or re-anchor the model.`);
    }
  }

  return {
    configured: true,
    crs: definition.code,
    crsName: definition.name,
    anchor: {
      lon: anchor.lon,
      lat: anchor.lat,
      height: round(anchorHeight, 3),
      elevationRecorded: anchorElevation !== null && Number.isFinite(anchorElevation)
    },
    modelOrigin: { east: origin.east, north: origin.north, up: originUp },
    rotationDeg: round(rotationDeg, 6),
    northReference,
    convergenceDeg: convergence.convergenceDeg,
    renderRotationDeg,
    scale: round(scale, 9),
    zOffset: round(zOffset, 4),
    bbox,
    model,
    checks: {
      anchorOriginDiscrepancyM: discrepancyMetres,
      residualMaxMm,
      distanceFromAnchorM,
      pairCount: pairs.length,
      warnings
    }
  };
}

module.exports = {
  ANCHOR_ORIGIN_TOLERANCE_M,
  SAME_PLACE_LIMIT_M,
  FAR_FROM_ANCHOR_M,
  initialBearingDegrees,
  convergenceDegrees,
  anchorOriginDistanceMetres,
  resolvePlacement
};
