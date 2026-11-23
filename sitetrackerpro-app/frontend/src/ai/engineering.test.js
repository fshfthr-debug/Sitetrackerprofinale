import {
  bearingArea,
  concreteQuantities,
  crewDuration,
  earnedValue,
  excavationVolume,
  masonryUnits,
  rebarWeight,
  slopeGradient
} from './engineering';

describe('construction engineering calculations', () => {
  test('computes a nominal C25 concrete take-off with wastage', () => {
    const result = concreteQuantities({ volume: 10, grade: 'C25', wastage: 0.05 });
    expect(result.grade).toBe('C25');
    expect(result.mixRatio).toBe('1 : 1.5 : 3');
    expect(result.volume).toBe(10.5);
    expect(result.cementBags).toBeCloseTo(84.7, 1);
    expect(result.sandM3).toBeCloseTo(4.41, 1);
    expect(result.aggregateM3).toBeCloseTo(8.82, 1);
  });

  test('falls back to C25 when the grade is unknown', () => {
    const result = concreteQuantities({ volume: 1, grade: 'C99' });
    expect(result.grade).toBe('C25');
    expect(result.assumedGrade).toBe(true);
  });

  test('computes deformed bar weight from diameter, length and count', () => {
    const result = rebarWeight({ diameterMm: 12, lengthM: 12, count: 40 });
    expect(result.kgPerMetre).toBeCloseTo(0.889, 2);
    expect(result.totalKg).toBeCloseTo(426.7, 0);
    expect(result.totalTonnes).toBeCloseTo(0.427, 2);
  });

  test('counts blocks and mortar for a wall', () => {
    const result = masonryUnits({ wallArea: 20 });
    expect(result.netCount).toBe(233);
    expect(result.count).toBe(244);
    expect(result.mortarM3).toBeGreaterThan(0.2);
  });

  test('converts bank excavation to loose volume and truck loads', () => {
    const result = excavationVolume({ length: 20, width: 10, depth: 2 });
    expect(result.bankM3).toBe(400);
    expect(result.looseM3).toBe(500);
    expect(result.truckLoadsAt12M3).toBe(42);
  });

  test('computes earned value and the burn gap', () => {
    const result = earnedValue({ budget: 1000, spent: 400, percentComplete: 30 });
    expect(result.earnedValue).toBe(300);
    expect(result.cpi).toBe(0.75);
    expect(result.spentPercent).toBe(40);
    expect(result.burnGapPercent).toBe(10);
    expect(result.remaining).toBe(600);
  });

  test('sizes a preliminary square footing', () => {
    const result = bearingArea({ loadKN: 500, allowableKPa: 150 });
    expect(result.requiredAreaM2).toBeCloseTo(3.67, 2);
    expect(result.squareSideM).toBeCloseTo(1.91, 2);
  });

  test('converts rise and run into percentage, degrees and 1 in n', () => {
    const result = slopeGradient({ rise: 1.5, run: 20 });
    expect(result.percent).toBe(7.5);
    expect(result.oneIn).toBeCloseTo(13.3, 1);
  });

  test('estimates crew duration', () => {
    const result = crewDuration({ quantity: 600, outputPerCrewDay: 50, crews: 2 });
    expect(result.dailyOutput).toBe(100);
    expect(result.days).toBe(6);
    expect(result.weeks).toBe(1);
  });
});
