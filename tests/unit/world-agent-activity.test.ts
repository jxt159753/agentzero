import { describe, expect, it } from 'vitest';
import { createAgentActivity, sampleAgentActivity } from '../../apps/web/src/world-agent-activity.js';
import { WORLD_PLACES, WORLD_PUBLIC_AREAS } from '../../packages/contracts/src/world.js';

describe('cosmetic offline Agent activity', () => {
  it('gives separate clients identical poses, while IDs have varied routes and phases', () => {
    const plan = createAgentActivity('resident-a'), same = createAgentActivity('resident-a');
    expect(plan).toEqual(same);
    for (const time of [-1, 0, 15, 1794114000.125]) {
      expect(sampleAgentActivity(plan, time)).toEqual(sampleAgentActivity(same, time));
    }
    const samples = Array.from({ length: 20 }, (_, index) => sampleAgentActivity(createAgentActivity(`resident-${index}`), 1794114000));
    expect(new Set(samples.map(sample => `${sample.point.x}:${sample.point.y}`)).size).toBe(20);
  });

  it('stays on public routes and clear of the fountain, benches and public buildings for an entire cycle', () => {
    for (let resident = 0; resident < 30; resident++) {
      const plan = createAgentActivity(`resident-${resident}`);
      expect(plan.duration).toBeLessThan(180);
      for (let elapsed = 0; elapsed < plan.duration; elapsed += 0.25) {
        const sample = sampleAgentActivity(plan, elapsed - plan.phase), { x, y } = sample.point;
        expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(sample.yaw)).toBe(true);
        expect(WORLD_PUBLIC_AREAS.some(area => Math.abs(x - area.x) <= area.width / 2 && Math.abs(y - area.y) <= area.height / 2)).toBe(true);
        expect(Math.hypot(x, y + 0.75)).toBeGreaterThan(0.58);
        for (const building of WORLD_PLACES) expect(Math.abs(x - building.x) > 0.665 || Math.abs(y - building.y) > 0.665).toBe(true);
        for (const benchX of [-1.08, 1.08]) expect(Math.abs(x - benchX) > 0.19 || Math.abs(y - 0.45) > 0.33).toBe(true);
      }
    }
  });

  it('walks at the planned speed without position jumps at turns, rests or cycle wrap', () => {
    const plan = createAgentActivity('resident-boundaries');
    let boundary = -plan.phase;
    for (const leg of plan.legs) {
      const a = sampleAgentActivity(plan, boundary + leg.travel / 2), b = sampleAgentActivity(plan, boundary + leg.travel / 2 + 0.01);
      expect(a.activity).toBe('walk');
      expect(Math.hypot(b.point.x - a.point.x, b.point.y - a.point.y)).toBeCloseTo(plan.speed * 0.01, 8);
      for (const time of [boundary, boundary + leg.travel, boundary + leg.travel + leg.pause]) {
        const before = sampleAgentActivity(plan, time - 0.0001), after = sampleAgentActivity(plan, time + 0.0001);
        expect(Math.hypot(after.point.x - before.point.x, after.point.y - before.point.y)).toBeLessThan(0.00004);
      }
      boundary += leg.travel + leg.pause;
    }
  });

  it('pauses in place for rest and looking around, then continues the route', () => {
    const plan = createAgentActivity('resident-pauses'), activities = new Set<string>();
    let time = -plan.phase;
    for (const leg of plan.legs) {
      if (leg.pause) {
        const start = sampleAgentActivity(plan, time + leg.travel + leg.pause * 0.2);
        const later = sampleAgentActivity(plan, time + leg.travel + leg.pause * 0.7);
        expect(start.point).toEqual(later.point); expect(start.moving).toBe(false);
        activities.add(start.activity);
        if (start.activity === 'look') expect(start.yaw).not.toBe(later.yaw);
        else expect(start.yaw).toBe(later.yaw);
      }
      time += leg.travel + leg.pause;
    }
    expect(activities).toEqual(new Set(['look', 'rest']));
  });
});
