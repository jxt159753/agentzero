import { describe, expect, it } from 'vitest';
import { WORLD_MODEL_CATALOG, WORLD_ROOM_DIMENSIONS, worldModelFits, worldRoomFits, type WorldModelDraft, type WorldModelId, type WorldSnapshot } from '../../packages/contracts/src/index.js';
import { sceneBounds } from '../../apps/web/src/world-scene.js';

describe('expanded room space', () => {
  it('accepts furniture beyond the former perimeter and rejects shapes crossing the new perimeter', () => {
    const model: WorldModelDraft = { model_id: 'arcade', x: 2, y: 1.5, rotation: 0, scale: 1 };
    expect(worldModelFits({ area: 720, width: 3, height: 2.4 }, model)).toBe(false);
    expect(worldRoomFits(model)).toBe(true);
    expect(worldRoomFits({ ...model, x: WORLD_ROOM_DIMENSIONS.width / 2 - WORLD_MODEL_CATALOG.arcade.width / 2 })).toBe(true);
    expect(worldRoomFits({ ...model, x: WORLD_ROOM_DIMENSIONS.width / 2 - WORLD_MODEL_CATALOG.arcade.width / 2 + 0.001 })).toBe(false);
    expect(worldRoomFits({ ...model, y: WORLD_ROOM_DIMENSIONS.height / 2 - WORLD_MODEL_CATALOG.arcade.depth / 2 })).toBe(true);
    expect(worldRoomFits({ ...model, y: WORLD_ROOM_DIMENSIONS.height / 2 - WORLD_MODEL_CATALOG.arcade.depth / 2 + 0.001 })).toBe(false);
  });

  it('preserves every formerly valid furniture corner without scaling or moving saved models', () => {
    for (const model_id of Object.keys(WORLD_MODEL_CATALOG) as WorldModelId[]) {
      const spec = WORLD_MODEL_CATALOG[model_id];
      if (spec.category === 'building') continue;
      for (const rotation of [0, 45, 90, 135]) for (const scale of [0.25, 1, 2]) {
        const angle = rotation * Math.PI / 180;
        const halfX = (spec.width * Math.abs(Math.cos(angle)) + spec.depth * Math.abs(Math.sin(angle))) * scale / 2;
        const halfY = (spec.width * Math.abs(Math.sin(angle)) + spec.depth * Math.abs(Math.cos(angle))) * scale / 2;
        if (halfX > 1.5 || halfY > 1.2) continue;
        for (const sideX of [-1, 1]) for (const sideY of [-1, 1])
          expect(worldRoomFits({ model_id, rotation, scale, x: sideX * (1.5 - halfX), y: sideY * (1.2 - halfY) })).toBe(true);
      }
    }
  });

  it('keeps the walking boundary inside all four expanded walls', () => {
    const roomWorld = { self: { room_id: 'room' } } as WorldSnapshot;
    expect(sceneBounds(roomWorld)).toEqual({ min_x: -2.32, max_x: 2.32, min_y: -1.72, max_y: 1.72 });
  });
});
