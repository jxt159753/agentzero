import { describe, expect, it } from 'vitest';
import { DEFAULT_SCENE_BOUNDS, FIRST_PERSON_RUN_SPEED, FIRST_PERSON_WALK_SPEED, JUMP_DURATION, MovementOutbox, WALK_SPEED, applyWorldDelta, houseEntrance, interpolatePoint, moveTowards, nearbyArcade, nearbyShowcaseLand, sampleJumpHeight, sceneBounds, walk } from '../../apps/web/src/world-scene.js';
import { WORLD_BOUNDS, WORLD_PLACES, WORLD_PUBLIC_AREAS, type WorldLand, type WorldSnapshot } from '../../packages/contracts/src/world.js';

describe('world motion independent of renderer', () => {
  it('walks continuously at equal diagonal and straight speed, without overshooting the target', () => {
    const straight = walk({ x: 0, y: 0 }, { x: 1, y: 0 }, null, 0.016, DEFAULT_SCENE_BOUNDS);
    const diagonal = walk({ x: 0, y: 0 }, { x: 1, y: 1 }, null, 0.016, DEFAULT_SCENE_BOUNDS);
    expect(straight.x).toBeCloseTo(0.064);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(straight.x);
    expect(moveTowards({ x: 0.99, y: 0 }, { x: 1, y: 0 }, 0.064)).toEqual({ x: 1, y: 0 });
  });
  it('keeps movement inside town bounds and does not jump after a background-tab pause', () => {
    expect(walk({ x: 31.99, y: 0 }, { x: 1, y: 0 }, null, 0.016, DEFAULT_SCENE_BOUNDS).x).toBe(32);
    expect(walk({ x: 0, y: 0 }, { x: 1, y: 0 }, null, 12, DEFAULT_SCENE_BOUNDS).x).toBeCloseTo(0.2);
    const remote = interpolatePoint({ x: 0, y: 0 }, { x: 5, y: 2 }, 0.016);
    expect(remote.x).toBeGreaterThan(0); expect(remote.x).toBeLessThan(5);
  });
  it('runs at twice walking speed while keeping diagonal movement normalized', () => {
    const dt = 1 / 60, origin = { x: 0, y: 0 };
    const walking = walk(origin, { x: 1, y: 0 }, null, dt * FIRST_PERSON_WALK_SPEED / WALK_SPEED, DEFAULT_SCENE_BOUNDS);
    const running = walk(origin, { x: 1, y: 0 }, null, dt * FIRST_PERSON_RUN_SPEED / WALK_SPEED, DEFAULT_SCENE_BOUNDS);
    const diagonal = walk(origin, { x: 1, y: 1 }, null, dt * FIRST_PERSON_RUN_SPEED / WALK_SPEED, DEFAULT_SCENE_BOUNDS);
    expect(walking.x).toBeCloseTo(0.0075);
    expect(running.x).toBeCloseTo(walking.x * 2);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(running.x);
  });
});

describe('first-person jump height', () => {
  it('rises and falls in real seconds with a roughly 1.28-metre apex', () => {
    expect(JUMP_DURATION).toBeCloseTo(1.0204081633);
    expect(sampleJumpHeight(0.25)).toBeCloseTo(0.094375);
    expect(sampleJumpHeight(0.75)).toBeCloseTo(0.099375);
    const apexTime = JUMP_DURATION / 2, apex = sampleJumpHeight(apexTime);
    expect(apex).toBeCloseTo(0.1275510204);
    expect(sampleJumpHeight(apexTime - 0.2)).toBeLessThan(apex);
    expect(sampleJumpHeight(apexTime + 0.2)).toBeCloseTo(sampleJumpHeight(apexTime - 0.2));
  });
  it('starts and lands exactly on the ground without continuing below it', () => {
    expect(sampleJumpHeight(-1)).toBe(0);
    expect(sampleJumpHeight(0)).toBe(0);
    expect(sampleJumpHeight(JUMP_DURATION - 0.001)).toBeGreaterThan(0);
    expect(sampleJumpHeight(JUMP_DURATION)).toBe(0);
    expect(sampleJumpHeight(JUMP_DURATION + 10)).toBe(0);
  });
});

describe('nearby land showcase', () => {
  const land: WorldLand = { id: 'plot', code: 'PLOT', x: 10, y: 10, area: 1600, name: 'Studio', works_url: null,
    owner_agent_id: 'agent', owner_name: 'Agent', owner: { id: 'owner', github_login: 'owner', display_name: 'Owner' },
    tradeable: true, purchasable: false, points_price: '100', version: '1', listing: null, decorations: [],
    showcase: [{ type: 'text', text: 'Welcome' }] };
  it('uses the edge of square and rectangular plots, including corners and points inside', () => {
    expect(nearbyShowcaseLand([land], { x: 6.5, y: 10 })).toBe(land);
    expect(nearbyShowcaseLand([land], { x: 6.49, y: 10 })).toBeUndefined();
    expect(nearbyShowcaseLand([land], { x: 10, y: 10 })).toBe(land);
    const rectangle = { ...land, width: 8, height: 2 };
    expect(nearbyShowcaseLand([rectangle], { x: 4.5, y: 10 })).toBe(rectangle);
    expect(nearbyShowcaseLand([rectangle], { x: 5, y: 8 })).toBe(rectangle);
    expect(nearbyShowcaseLand([rectangle], { x: 4.9, y: 7.9 })).toBeUndefined();
  });
  it('ignores unowned and empty plots, and chooses nearest edge then nearest center', () => {
    expect(nearbyShowcaseLand([{ ...land, owner_agent_id: null }, { ...land, showcase: [] }, { ...land, showcase: undefined }], { x: 10, y: 10 })).toBeUndefined();
    const next = { ...land, id: 'next', x: 14 };
    expect(nearbyShowcaseLand([land, next], { x: 13, y: 10 })).toBe(next);
    const overlappingRange = { ...land, id: 'narrow', x: 14, width: 2, height: 2 };
    expect(nearbyShowcaseLand([land, overlappingRange], { x: 12.5, y: 10 })).toBe(overlappingRange);
  });
});

describe('movement synchronization', () => {
  it('keeps room changes distinct and clears old movement before a presence transition', () => {
    const queue = new MovementOutbox();
    queue.move({ x: 0, y: 0, room_id: 'room-a' }, false);
    expect(queue.next()).toMatchObject({ room_id: 'room-a' });
    queue.move({ x: 0, y: 0, room_id: 'room-b' }, false);
    expect(queue.next()).toMatchObject({ room_id: 'room-b' });
    queue.move({ x: 1, y: 0, room_id: 'room-b' }); queue.clear(); queue.reconnect();
    expect(queue.next()).toBeUndefined();
  });
  it('coalesces intermediate frames, emits the final stop and suppresses unchanged samples', () => {
    const queue = new MovementOutbox();
    queue.move({ x: 0.2, y: 0.1 });
    const original = queue.next()!;
    queue.move({ x: 0.6, y: 0.3 }); queue.move({ x: 0.9, y: 0.4 });
    const final = queue.next()!;
    expect(final.seq).toBe(original.seq + 1); expect(final).toMatchObject({ x: 0.9, y: 0.4, moving: true });
    expect(queue.next()).toBeUndefined();
    queue.move({ x: 0.9, y: 0.4 }, false);
    expect(queue.next()).toMatchObject({ x: 0.9, y: 0.4, moving: false, seq: 3 });
    expect(queue.next()).toBeUndefined();
  });
  it('reconnects with the latest quantized position and a new connection sequence', () => {
    const queue = new MovementOutbox();
    expect(queue.next()).toBeUndefined();
    queue.move({ x: 1.23456, y: 2 }, false);
    expect(queue.next()).toEqual({ type: 'move', seq: 1, x: 1.235, y: 2, moving: false });
    queue.move({ x: 5, y: 3 }, false); queue.next();
    queue.reconnect();
    expect(queue.next()).toEqual({ type: 'move', seq: 1, x: 5, y: 3, moving: false });
  });
});

describe('room geometry and nearby arcade selection', () => {
  const house = { id: 'room', version: '1', model_id: 'cabin' as const, x: 0, y: 0, rotation: 90, scale: 1 };
  const machine = { id: 'machine', version: '1', model_id: 'arcade' as const, x: 0, y: 0, rotation: 0, scale: 1, room_id: 'room' };
  const land = { id: 'land', x: 10, y: 20, models: [house, machine] } as WorldLand;
  it('rotates the entrance with the house and selects only machines in the current room', () => {
    const door = houseEntrance(land, house);
    expect(door.x).toBeCloseTo(10.985); expect(door.y).toBeCloseTo(20);
    expect(nearbyArcade([land], { x: 0, y: 0 })).toBeUndefined();
    expect(nearbyArcade([land], { x: 0.2, y: 0, room_id: 'room' })?.placement).toBe(machine);
    expect(nearbyArcade([land], { x: 0.2, y: 0, room_id: 'other' })).toBeUndefined();
    expect(nearbyArcade([land], { x: 0.8, y: 0, room_id: 'room' })).toBeUndefined();
  });
  it('uses room bounds instead of world coordinates while indoors', () => {
    const bounds = sceneBounds({ self: { room_id: 'room' } } as WorldSnapshot);
    const position = walk({ x: 1.41, y: 1.11 }, { x: 1, y: 1 }, null, 0.05, bounds);
    expect(position.x).toBeCloseTo(1.42); expect(position.y).toBeCloseTo(1.12);
  });
});

describe('world delta application', () => {
  it('applies removals and updates without replacing unchanged geometry data', () => {
    const world: WorldSnapshot = { server_time: 'before', presence_ttl_seconds: 60,
      self: { kind: 'visitor', id: 'me', x: 0, y: 0, online: true }, bounds: WORLD_BOUNDS,
      public_areas: WORLD_PUBLIC_AREAS, places: WORLD_PLACES, lands: [], agents: [],
      visitors: [{ id: 'me', name: 'Me', github_login: 'me', online: true, x: 0, y: 0 }, { id: 'gone', name: 'Gone', github_login: 'gone', online: true, x: 1, y: 1 }] };
    const moved = { ...world.visitors[0]!, x: 2 };
    const updated = applyWorldDelta(world, { type: 'delta', server_time: 'after', visitors: { upsert: [moved], remove: ['gone'] } });
    expect(updated.visitors).toEqual([moved]);
    expect(updated.lands).toBe(world.lands); expect(updated.agents).toBe(world.agents);
    expect(updated.public_areas).toBe(world.public_areas);
    expect(world.visitors).toHaveLength(2);
    expect(updated.server_time).toBe('after');
  });
});
