import { describe, expect, it } from 'vitest';
import { DEFAULT_LAND_PLOT_AREA, WORLD_BOUNDS, WORLD_PUBLIC_AREAS, defaultLandPrice, landOverlapsPublicArea,
  worldLandDimensions, type WorldLandGeometry } from '../../packages/contracts/src/index.js';
import { generateDefaultLandPlots } from '../../apps/api/src/modules/market/default-land.js';

function overlapArea(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  const width = Math.max(0, Math.min(a.x + a.width / 2, b.x + b.width / 2) - Math.max(a.x - a.width / 2, b.x - b.width / 2));
  const height = Math.max(0, Math.min(a.y + a.height / 2, b.y + b.height / 2) - Math.max(a.y - a.height / 2, b.y - b.height / 2));
  return width * height;
}

describe('default town land supply', () => {
  it('covers all non-public ground exactly once, including the edges beside roads and facilities', () => {
    const plots = generateDefaultLandPlots();
    // Public rectangles occupy 89.76 world units² after their intersections are counted only once.
    expect(plots.reduce((area, land) => area + land.area, 0)).toBeCloseTo(298224, 6);
    expect(new Set(plots.map(land => land.code)).size).toBe(plots.length);
    for (const [index, land] of plots.entries()) {
      expect(land.area).toBeGreaterThan(0);
      expect(land.area).toBeLessThanOrEqual(DEFAULT_LAND_PLOT_AREA);
      expect(land.x - land.width / 2).toBeGreaterThanOrEqual(WORLD_BOUNDS.min_x);
      expect(land.x + land.width / 2).toBeLessThanOrEqual(WORLD_BOUNDS.max_x);
      expect(land.y - land.height / 2).toBeGreaterThanOrEqual(WORLD_BOUNDS.min_y);
      expect(land.y + land.height / 2).toBeLessThanOrEqual(WORLD_BOUNDS.max_y);
      expect(landOverlapsPublicArea(land)).toBe(false);
      for (const publicArea of WORLD_PUBLIC_AREAS) expect(overlapArea(land, publicArea)).toBeLessThan(1e-8);
      for (const other of plots.slice(index + 1)) expect(overlapArea(land, other)).toBeLessThan(1e-8);
    }
    expect(generateDefaultLandPlots()).toEqual(plots);
  });

  it('preserves old square and rectangular property while filling every remaining non-public area', () => {
    const existing = [
      { code: 'OWNED', x: 8, y: 8, area: 1600, points_price: '47', owner_agent_id: 'existing-owner' },
      { code: 'LEGACY-PUBLIC', x: 0, y: 0, area: 100, width: null, height: null },
      { code: 'ROAD-EDGE', x: 0, y: 10, area: 300, width: 3, height: 1 },
      { code: 'OUTSIDE', x: 100, y: 100, area: 100 },
    ];
    const before = structuredClone(existing), plots = generateDefaultLandPlots(existing);
    // The road-edge rectangle already includes 70 m² of public road, which is not subtracted twice.
    expect(plots.reduce((area, land) => area + land.area, 0)).toBeCloseTo(298224 - 1600 - 230, 6);
    for (const land of plots) {
      for (const previous of existing) expect(overlapArea(land, { ...previous, ...worldLandDimensions(previous) })).toBeLessThan(1e-8);
    }
    expect(existing).toEqual(before);
  });

  it('keeps fractional remnants and resolves existing code collisions without dropping land', () => {
    const collision = generateDefaultLandPlots()[0]!.code;
    const existing = [
      { code: collision, x: 100, y: 100, area: 100 },
      { code: 'FINE-EDGE', x: -30.0005, y: -22, area: 1599.6, width: 3.999, height: 4 },
    ];
    const plots = generateDefaultLandPlots(existing);
    expect(plots.some(land => land.area < 1)).toBe(true);
    expect(plots.reduce((area, land) => area + land.area, 0)).toBeCloseTo(298224 - 1599.6, 6);
    expect(plots.every(land => land.code !== collision)).toBe(true);
    expect(new Set(plots.map(land => land.code)).size).toBe(plots.length);
  });
});

describe('land dimensions and default pricing', () => {
  it('keeps old square dimensions and checks public overlap with the actual rectangular footprint', () => {
    expect(worldLandDimensions({ area: 400 })).toEqual({ width: 2, height: 2 });
    expect(worldLandDimensions({ area: 400, width: null, height: null })).toEqual({ width: 2, height: 2 });
    const rectangle: WorldLandGeometry = { x: 0.55, y: 10, area: 80, width: 0.4, height: 2 };
    expect(worldLandDimensions(rectangle)).toEqual({ width: 0.4, height: 2 });
    expect(landOverlapsPublicArea(rectangle)).toBe(false);
    expect(landOverlapsPublicArea({ ...rectangle, x: 0.54 })).toBe(true);
  });

  it('prices equally sized lots higher near the center and scales prices with area', () => {
    expect(defaultLandPrice({ x: 0, y: 0, area: 1600 })).toBe('1000');
    expect(defaultLandPrice({ x: 16, y: 12, area: 1600 })).toBe('550');
    expect(defaultLandPrice({ x: 32, y: 24, area: 1600 })).toBe('100');
    expect(defaultLandPrice({ x: -16, y: -12, area: 800 })).toBe('275');
    expect(defaultLandPrice({ x: 100, y: 100, area: 1600 })).toBe('100');
    expect(defaultLandPrice({ x: 32, y: 24, area: 0.01 })).toBe('1');
  });
});
