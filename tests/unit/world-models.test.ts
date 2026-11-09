import { describe, expect, it } from 'vitest';
import { WORLD_MODEL_CATALOG, WORLD_ROOM_DIMENSIONS, worldModelFits, worldRoomFits, type WorldModelDraft } from '../../packages/contracts/src/index.js';

describe('free world model placement geometry', () => {
  const plot = { area: 400, width: 2, height: 2 };
  const model: WorldModelDraft = { model_id: 'studio', x: 0, y: 0, rotation: 0, scale: 1 };

  it('checks the whole rotated and scaled fitting box, including exact shared edges', () => {
    expect(worldModelFits(plot, model)).toBe(true);
    expect(worldModelFits(plot, { ...model, x: (2 - WORLD_MODEL_CATALOG.studio.width) / 2 })).toBe(true);
    expect(worldModelFits(plot, { ...model, x: 0.226 })).toBe(false);
    expect(worldModelFits(plot, { ...model, rotation: 45 })).toBe(false);
    expect(worldModelFits(plot, { ...model, rotation: 45, scale: 0.9 })).toBe(true);
    expect(worldModelFits(plot, { ...model, scale: 2 })).toBe(false);
  });

  it('rotates rectangular footprints and supports existing square-area land records', () => {
    const narrow = { area: 2, width: 0.2, height: 0.1 };
    expect(worldModelFits(narrow, { ...model, model_id: 'bench' })).toBe(true);
    expect(worldModelFits(narrow, { ...model, model_id: 'bench', rotation: 90 })).toBe(false);
    expect(worldModelFits({ area: 400 }, model)).toBe(true);
    expect(worldModelFits({ area: 6 }, { ...model, model_id: 'plant', scale: 0.25 })).toBe(true);
    expect(worldModelFits({ area: 6 }, model)).toBe(false);
  });

  it('rejects non-finite geometry and out-of-range transforms', () => {
    for (const invalid of [{ x: NaN }, { y: Infinity }, { rotation: -1 }, { rotation: 360 }, { scale: 0.24 }, { scale: 2.01 }])
      expect(worldModelFits(plot, { ...model, ...invalid })).toBe(false);
  });

  it('keeps previously valid lamps and seating within their land after correcting their size', () => {
    const previous = { lamp: [0.24, 0.24], bench: [0.66, 0.35], chair: [0.25, 0.25] } as const;
    for (const modelId of ['lamp', 'bench', 'chair'] as const) for (const scale of [0.25, 1, 2]) for (const rotation of [0, 45, 90, 135]) {
      const [width, depth] = previous[modelId], angle = rotation * Math.PI / 180;
      const x = 1 - (width * Math.abs(Math.cos(angle)) + depth * Math.abs(Math.sin(angle))) * scale / 2;
      const y = 1 - (width * Math.abs(Math.sin(angle)) + depth * Math.abs(Math.cos(angle))) * scale / 2;
      expect(worldModelFits(plot, { model_id: modelId, x, y, rotation, scale })).toBe(true);
    }
  });

  it('fits long fences and added buildings using their own footprint at every rotation', () => {
    const fence: WorldModelDraft = { model_id: 'fence', x: 0, y: 0, rotation: 0, scale: 1 };
    expect(worldModelFits({ area: 6, width: 0.75, height: 0.08 }, fence)).toBe(true);
    expect(worldModelFits({ area: 6, width: 0.75, height: 0.08 }, { ...fence, rotation: 90 })).toBe(false);
    expect(worldModelFits({ area: 36, width: 0.6, height: 0.6 }, { ...fence, rotation: 45 })).toBe(true);
    expect(worldModelFits({ area: 33.64, width: 0.58, height: 0.58 }, { ...fence, rotation: 45 })).toBe(false);
    const cabin: WorldModelDraft = { ...model, model_id: 'cabin' };
    expect(worldModelFits({ area: 231, width: 1.4, height: 1.65 }, cabin)).toBe(true);
    expect(worldModelFits({ area: 231, width: 1.4, height: 1.65 }, { ...cabin, rotation: 90 })).toBe(false);
    expect(worldModelFits({ area: 100, width: 1, height: 1 }, { ...cabin, scale: 0.5, rotation: 90 })).toBe(true);
  });

  it('fits furniture inside the room independently of the building footprint and excludes nested houses', () => {
    const arcade: WorldModelDraft = { model_id: 'arcade', x: 1, y: 0, rotation: 0, scale: 1 };
    expect(worldRoomFits(arcade)).toBe(true);
    expect(worldModelFits({ area: 100 }, arcade)).toBe(false);
    expect(worldRoomFits({ ...arcade, x: WORLD_ROOM_DIMENSIONS.width / 2 - WORLD_MODEL_CATALOG.arcade.width / 2 })).toBe(true);
    expect(worldRoomFits({ ...arcade, y: WORLD_ROOM_DIMENSIONS.height / 2 })).toBe(false);
    for (const model_id of ['studio', 'cabin', 'shed'] as const) expect(worldRoomFits({ ...arcade, model_id, x: 0, scale: 0.25 })).toBe(false);
  });
});
