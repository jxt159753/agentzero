import { describe, expect, it } from 'vitest';
import { sampleDaylight } from '../../apps/web/src/world-daylight.js';

const at = (time: string) => Date.parse(`2026-11-08T${time}+08:00`);

describe('shared real-time town daylight', () => {
  it('uses Beijing time independently of the browser timezone and advances at real-world speed', () => {
    expect(sampleDaylight(Date.parse('2026-11-08T04:00:00Z')).hours).toBe(12);
    expect(sampleDaylight(at('23:59:00')).hours).toBeCloseTo(23 + 59 / 60, 8);
    expect(sampleDaylight(at('10:00:00') + 60000).hours - sampleDaylight(at('10:00:00')).hours).toBeCloseTo(1 / 60, 8);
    expect(sampleDaylight(at('12:00:00') + 86400000)).toEqual(sampleDaylight(at('12:00:00')));
  });

  it('keeps midday bright with lamps off and night readable with lamps on', () => {
    const day = sampleDaylight(at('12:00:00')), night = sampleDaylight(at('23:00:00'));
    expect(day).toMatchObject({ phase: 'day', daylight: 1, lamps: 0 });
    expect(night).toMatchObject({ phase: 'night', daylight: 0, lamps: 1 });
    expect(night.hemisphereIntensity).toBeGreaterThan(0);
    expect(night.sunIntensity).toBeGreaterThan(0);
    expect(day.hemisphereIntensity).toBeGreaterThan(night.hemisphereIntensity);
    expect(day.skyTop).not.toBe(night.skyTop);
  });

  it('gradually brightens at dawn and fades at dusk, with inverse lamp transitions', () => {
    let previous = sampleDaylight(at('05:30:00'));
    for (let minute = 1; minute <= 90; minute++) {
      const current = sampleDaylight(at('05:30:00') + minute * 60000);
      expect(current.daylight).toBeGreaterThanOrEqual(previous.daylight);
      expect(current.lamps).toBeLessThanOrEqual(previous.lamps);
      expect(current.daylight - previous.daylight).toBeLessThan(0.02);
      previous = current;
    }
    previous = sampleDaylight(at('17:00:00'));
    for (let minute = 1; minute <= 90; minute++) {
      const current = sampleDaylight(at('17:00:00') + minute * 60000);
      expect(current.daylight).toBeLessThanOrEqual(previous.daylight);
      expect(current.lamps).toBeGreaterThanOrEqual(previous.lamps);
      previous = current;
    }
    expect(sampleDaylight(at('06:15:00')).phase).toBe('dawn');
    expect(sampleDaylight(at('17:45:00')).phase).toBe('dusk');
    expect(sampleDaylight(at('17:45:00')).lamps).toBeGreaterThan(0);
    expect(sampleDaylight(at('17:45:00')).lamps).toBeLessThan(1);
  });

  it('does not jump at midnight or the daylight boundaries', () => {
    for (const time of ['00:00:00', '05:30:00', '07:00:00', '17:00:00', '18:30:00']) {
      const before = sampleDaylight(at(time) - 10), after = sampleDaylight(at(time) + 10);
      expect(Math.abs(before.daylight - after.daylight)).toBeLessThan(0.00001);
      expect(Math.abs(before.lamps - after.lamps)).toBeLessThan(0.00001);
      expect(Math.abs(before.sunPosition.x - after.sunPosition.x)).toBeLessThan(0.001);
      expect(Math.abs(before.sunPosition.y - after.sunPosition.y)).toBeLessThan(0.001);
    }
  });
});
