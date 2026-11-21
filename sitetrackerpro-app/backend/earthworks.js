'use strict';

// Cut-and-fill volume model.
//
// `fillDepth` is the designed floor level minus the existing ground level:
//   positive -> the floor sits above ground and fill is needed
//   negative -> the floor sits below ground and the extra depth must be cut
//
// Foundation excavation and any design cut are added together. Fill can never be
// negative, which previously showed a negative "fill required" on site.
const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

function calculateEarthworksVolumes({ buildingFootprint, foundationDepth, fillDepth }) {
  const footprint = Number(buildingFootprint);
  const depth = Number(foundationDepth);
  const levelDifference = Number(fillDepth);

  if (!Number.isFinite(footprint) || footprint <= 0) {
    throw new TypeError('buildingFootprint must be a positive number');
  }
  if (!Number.isFinite(depth) || depth < 0) {
    throw new TypeError('foundationDepth must be zero or a positive number');
  }
  if (!Number.isFinite(levelDifference)) {
    throw new TypeError('fillDepth must be a finite number');
  }

  const foundationCut = footprint * depth;
  const designCut = Math.max(0, -levelDifference) * footprint;
  const fillVolume = Math.max(0, levelDifference) * footprint;
  const cutVolume = foundationCut + designCut;

  return {
    cutVolume: round2(cutVolume),
    fillVolume: round2(fillVolume),
    netVolume: round2(fillVolume - cutVolume)
  };
}

module.exports = { calculateEarthworksVolumes };
