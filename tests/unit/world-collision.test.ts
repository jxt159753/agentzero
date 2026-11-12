import { describe, expect, it } from 'vitest';
import { WORLD_MODEL_CATALOG, WORLD_PLACES, type WorldLand, type WorldModelId, type WorldSnapshot } from '../../packages/contracts/src/index.js';
import { PLAYER_RADIUS, slideWorldMovement, worldObstacles, type WorldObstacle } from '../../apps/web/src/world-collision.js';
import { quantizePoint } from '../../apps/web/src/world-scene.js';

const modelWorld = (modelId: WorldModelId, roomId: string | null = null, rotation = 0, scale = 1) => ({
  places: WORLD_PLACES, lands: [{ x: 8, y: 5, models: [{ id: 'model', version: '1', model_id: modelId, x: 0, y: 0, rotation, scale, room_id: roomId }] } as WorldLand],
}) as Pick<WorldSnapshot, 'lands' | 'places'>;
const box: WorldObstacle = { x: 0, y: 0, halfWidth: 0.5, halfDepth: 0.3, cosine: 1, sine: 0 };

describe('placed model collisions', () => {
  for (const modelId of Object.keys(WORLD_MODEL_CATALOG) as WorldModelId[]) it(`${modelId} blocks walking in its own indoor and outdoor space`, () => {
    for (const roomId of [null, 'room']) {
      const world = modelWorld(modelId, roomId), obstacles = worldObstacles(world, roomId);
      const x = roomId ? 0 : 8, y = roomId ? 0 : 5;
      const result = slideWorldMovement({ x, y: y - 3 }, { x, y: y + 3 }, obstacles);
      expect(result.y).toBeCloseTo(y - WORLD_MODEL_CATALOG[modelId].depth / 2 - PLAYER_RADIUS, 4);
      expect(worldObstacles(world, roomId ? 'another-room' : 'room')).toHaveLength(0);
    }
  });

  it('uses the mesh rotation sign and scaled footprint rather than a large world-axis box', () => {
    const rotation = 35 * Math.PI / 180, c = Math.cos(rotation), s = Math.sin(rotation), scale = 1.7;
    const localToWorld = (x: number, y: number) => ({ x: c * x + s * y, y: -s * x + c * y });
    const obstacles = worldObstacles(modelWorld('fence', 'room', 35, scale), 'room');
    const result = slideWorldMovement(localToWorld(0, -1), localToWorld(0, 1), obstacles);
    expect(s * result.x + c * result.y).toBeCloseTo(-0.08 * scale / 2 - PLAYER_RADIUS, 4);
    const from = localToWorld(0.5 * scale + PLAYER_RADIUS, -0.5), to = localToWorld(0.5 * scale + PLAYER_RADIUS, 0.5);
    const passed = slideWorldMovement(from, to, obstacles);
    expect(passed.x).toBeCloseTo(to.x, 10); expect(passed.y).toBeCloseTo(to.y, 10);
  });

  it('sweeps through the entire step so a minimum-scale fence cannot be skipped', () => {
    const obstacles = worldObstacles(modelWorld('fence', 'room', 0, 0.25), 'room');
    const result = slideWorldMovement({ x: 0, y: -1 }, { x: 0, y: 1 }, obstacles);
    expect(result.y).toBeCloseTo(-0.01 - PLAYER_RADIUS, 4);
  });

  it('slides along straight and rotated walls without entering them', () => {
    const straight = slideWorldMovement({ x: -1, y: -0.2 }, { x: 0.5, y: 0.2 }, [box]);
    expect(straight.x).toBeCloseTo(-0.5 - PLAYER_RADIUS, 4); expect(straight.y).toBeCloseTo(0.2, 4);
    const c = Math.SQRT1_2, rotate = (x: number, y: number) => ({ x: c * x + c * y, y: -c * x + c * y });
    const result = slideWorldMovement(rotate(-1, -0.2), rotate(0.5, 0.2), [{ ...box, cosine: c, sine: c }]);
    expect(c * result.x - c * result.y).toBeCloseTo(-0.5 - PLAYER_RADIUS, 4);
    expect(c * result.x + c * result.y).toBeCloseTo(0.2, 4);
  });

  it('stops at the second wall after sliding into a corner', () => {
    const result = slideWorldMovement({ x: -1, y: -1 }, { x: 1, y: 1 }, [
      { ...box, halfDepth: 5 }, { ...box, y: 0.7, halfWidth: 5 },
    ]);
    expect(result.x).toBeCloseTo(-0.575, 4); expect(result.y).toBeCloseTo(0.325, 4);
  });

  it('lets an overlapping spawn exit, then blocks re-entry', () => {
    const exit = slideWorldMovement({ x: 0, y: 0 }, { x: 1, y: 0 }, [box]);
    expect(exit).toEqual({ x: 1, y: 0 });
    expect(slideWorldMovement(exit, { x: 0, y: 0 }, [box]).x).toBeCloseTo(0.575, 4);
  });

  it('cannot walk inward after a rotated contact is rounded by position sync and restored', () => {
    const angle = 35 * Math.PI / 180, s = Math.sin(angle), c = Math.cos(angle);
    const obstacles = worldObstacles(modelWorld('fence', 'room', 35), 'room');
    const contact = slideWorldMovement({ x: s, y: c }, { x: -s, y: -c }, obstacles);
    const restored = quantizePoint(contact);
    expect(s * restored.x + c * restored.y).toBeLessThan(0.04 + PLAYER_RADIUS);
    const inward = slideWorldMovement(restored, { x: restored.x - s, y: restored.y - c }, obstacles);
    expect(inward.x).toBeCloseTo(restored.x, 10); expect(inward.y).toBeCloseTo(restored.y, 10);
    const escaped = slideWorldMovement(restored, { x: s, y: c }, obstacles);
    expect(escaped.x).toBeCloseTo(s, 10); expect(escaped.y).toBeCloseTo(c, 10);
  });

  it('removing or moving a placement updates the occupied space without stale colliders', () => {
    const world = modelWorld('arcade', 'room'), from = { x: 0, y: -1 }, to = { x: 0, y: 1 };
    expect(slideWorldMovement(from, to, worldObstacles(world, 'room')).y).toBeLessThan(0);
    world.lands[0]!.models![0]!.x = 2;
    expect(slideWorldMovement(from, to, worldObstacles(world, 'room'))).toEqual(to);
    world.lands[0]!.models = [];
    expect(worldObstacles(world, 'room')).toHaveLength(0);
  });

  it('preserves the central fountain collider without putting it inside rooms', () => {
    const world = { places: [], lands: [] } as unknown as Pick<WorldSnapshot, 'lands' | 'places'>;
    const from = { x: 0, y: 0.5 }, to = { x: 0, y: -2 };
    expect(slideWorldMovement(from, to, worldObstacles(world, null)).y).toBeCloseTo(-0.21, 4);
    expect(slideWorldMovement(from, to, worldObstacles(world, 'room'))).toEqual(to);
  });
});
