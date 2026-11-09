import { DEFAULT_LAND_PLOT_SIZE, WORLD_BOUNDS, WORLD_GEOMETRY_EPSILON, WORLD_METERS_PER_UNIT, WORLD_PUBLIC_AREAS,
  defaultLandPrice, worldLandDimensions, type WorldBounds, type WorldLandGeometry } from '@agentzero/contracts';
import type { Tx } from '@agentzero/database';

export interface DefaultLandPlot extends WorldLandGeometry { code: string; width: number; height: number; points_price: string }

function bounds(land: { x: number; y: number; width: number; height: number }): WorldBounds {
  return { min_x: land.x - land.width / 2, max_x: land.x + land.width / 2,
    min_y: land.y - land.height / 2, max_y: land.y + land.height / 2 };
}

function subtract(rect: WorldBounds, occupied: WorldBounds): WorldBounds[] {
  const left = Math.max(rect.min_x, occupied.min_x), right = Math.min(rect.max_x, occupied.max_x);
  const top = Math.max(rect.min_y, occupied.min_y), bottom = Math.min(rect.max_y, occupied.max_y);
  if (right - left <= WORLD_GEOMETRY_EPSILON || bottom - top <= WORLD_GEOMETRY_EPSILON) return [rect];
  return [
    { min_x: rect.min_x, max_x: rect.max_x, min_y: rect.min_y, max_y: top },
    { min_x: rect.min_x, max_x: rect.max_x, min_y: bottom, max_y: rect.max_y },
    { min_x: rect.min_x, max_x: left, min_y: top, max_y: bottom },
    { min_x: right, max_x: rect.max_x, min_y: top, max_y: bottom },
  ].filter(piece => piece.max_x - piece.min_x > WORLD_GEOMETRY_EPSILON && piece.max_y - piece.min_y > WORLD_GEOMETRY_EPSILON);
}

/** Fill the default town, subtracting all public ground and existing property without changing either. */
export function generateDefaultLandPlots(existing: readonly (WorldLandGeometry & { code?: string })[] = []): DefaultLandPlot[] {
  const occupied = [...WORLD_PUBLIC_AREAS.map(bounds), ...existing.map(land => bounds({ ...land, ...worldLandDimensions(land) }))];
  const usedCodes = new Set(existing.flatMap(land => land.code ? [land.code] : []));
  const plots: DefaultLandPlot[] = [];
  for (let x = WORLD_BOUNDS.min_x, column = 1; x < WORLD_BOUNDS.max_x; x += DEFAULT_LAND_PLOT_SIZE, column++) {
    for (let y = WORLD_BOUNDS.min_y, row = 1; y < WORLD_BOUNDS.max_y; y += DEFAULT_LAND_PLOT_SIZE, row++) {
      let pieces: WorldBounds[] = [{ min_x: x, max_x: Math.min(x + DEFAULT_LAND_PLOT_SIZE, WORLD_BOUNDS.max_x),
        min_y: y, max_y: Math.min(y + DEFAULT_LAND_PLOT_SIZE, WORLD_BOUNDS.max_y) }];
      for (const obstacle of occupied) pieces = pieces.flatMap(piece => subtract(piece, obstacle));
      for (const [index, piece] of pieces.entries()) {
        const width = piece.max_x - piece.min_x, height = piece.max_y - piece.min_y;
        const land = { x: (piece.min_x + piece.max_x) / 2, y: (piece.min_y + piece.max_y) / 2,
          width, height, area: width * height * WORLD_METERS_PER_UNIT ** 2 };
        const baseCode = `TOWN-DEFAULT-${column}-${row}-${index + 1}`;
        let code = baseCode, suffix = 1;
        while (usedCodes.has(code)) code = `${baseCode}-${suffix++}`;
        usedCodes.add(code);
        plots.push({ ...land, code, points_price: defaultLandPrice(land) });
      }
    }
  }
  return plots;
}

/** Call inside a transaction; the supply lock also serializes administrator-created plots. */
export async function initializeDefaultLandSupply(tx: Tx): Promise<number> {
  const state = (await tx.query<{ default_land_supplied: boolean }>('SELECT default_land_supplied FROM market_settings WHERE id=1 FOR UPDATE')).rows[0]!;
  if (state.default_land_supplied) return 0;
  const existing = (await tx.query<WorldLandGeometry & { code: string }>('SELECT code,x,y,area,width,height FROM land_plots ORDER BY x,y,id')).rows;
  const plots = generateDefaultLandPlots(existing);
  if (plots.length) {
    await tx.query(`INSERT INTO land_plots(code,x,y,area,width,height,points_price,created_by,created_at)
      SELECT code,x,y,area,width,height,points_price,NULL,transaction_timestamp()
      FROM jsonb_to_recordset($1::jsonb) AS plot(code text,x double precision,y double precision,area double precision,
        width double precision,height double precision,points_price bigint)`, [JSON.stringify(plots)]);
  }
  await tx.query('UPDATE market_settings SET default_land_supplied=true WHERE id=1');
  return plots.length;
}
