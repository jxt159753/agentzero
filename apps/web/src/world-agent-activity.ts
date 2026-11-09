import type { WorldPoint } from './world-scene.js';

export type AgentActivity = 'walk' | 'rest' | 'look';
export interface AgentActivitySample { point: WorldPoint; yaw: number; moving: boolean; activity: AgentActivity }
interface ActivityLeg {
  from: WorldPoint; to: WorldPoint; yaw: number; travel: number; pause: number; activity: 'rest' | 'look';
}
export interface AgentActivityPlan { readonly legs: readonly ActivityLeg[]; readonly duration: number; readonly phase: number; readonly speed: number }

function seed(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  return ((hash ^ (hash >>> 13)) >>> 0) / 4294967296;
}

/** Cosmetic routes stay on public ground; they never change an Agent's real presence or saved location. */
export function createAgentActivity(id: string): AgentActivityPlan {
  const edge = 1.37, lane = 0.07, reach = 3.5 + seed(id + ':reach') * 1.8;
  const points: WorldPoint[] = [
    { x: -edge, y: -edge }, { x: edge, y: -edge }, { x: edge, y: -lane }, { x: edge, y: lane },
    { x: edge, y: edge }, { x: lane, y: edge }, { x: -lane, y: edge },
    { x: -edge, y: edge }, { x: -edge, y: lane }, { x: -edge, y: -lane },
  ];
  // Each resident takes one side trip. The north road is omitted because the market occupies it.
  const branch = Math.floor(seed(id + ':branch') * 3);
  if (branch === 0) points.splice(3, 0, { x: reach, y: -lane }, { x: reach, y: lane });
  else if (branch === 1) points.splice(6, 0, { x: lane, y: reach }, { x: -lane, y: reach });
  else points.splice(9, 0, { x: -reach, y: lane }, { x: -reach, y: -lane });
  if (seed(id + ':direction') < 0.5) points.reverse();
  const speed = 0.12 + seed(id + ':speed') * 0.06;
  const legs = points.map((from, index): ActivityLeg => {
    const to = points[(index + 1) % points.length]!, dx = to.x - from.x, dy = to.y - from.y;
    return { from, to, yaw: Math.atan2(dx, dy), travel: Math.hypot(dx, dy) / speed,
      pause: index % 3 === 0 ? 2 + seed(`${id}:pause:${index}`) * 4 : 0,
      activity: index % 2 === 0 ? 'look' : 'rest' };
  });
  const duration = legs.reduce((total, leg) => total + leg.travel + leg.pause, 0);
  return { legs, duration, speed, phase: seed(id + ':phase') * duration };
}

/** Pass server-aligned seconds; sampling is deterministic and needs no timer, random state or network. */
export function sampleAgentActivity(plan: AgentActivityPlan, seconds: number): AgentActivitySample {
  let elapsed = ((seconds + plan.phase) % plan.duration + plan.duration) % plan.duration;
  for (const leg of plan.legs) {
    if (elapsed < leg.travel) {
      const ratio = elapsed / leg.travel;
      return { point: { x: leg.from.x + (leg.to.x - leg.from.x) * ratio, y: leg.from.y + (leg.to.y - leg.from.y) * ratio },
        yaw: leg.yaw, moving: true, activity: 'walk' };
    }
    elapsed -= leg.travel;
    if (elapsed < leg.pause) return { point: { ...leg.to }, moving: false, activity: leg.activity,
      yaw: leg.yaw + (leg.activity === 'look' ? Math.sin(elapsed / leg.pause * Math.PI * 2) * 0.65 : 0) };
    elapsed -= leg.pause;
  }
  // Floating-point rounding at a cycle boundary returns the start, not an undefined pose.
  const first = plan.legs[0]!;
  return { point: { ...first.from }, yaw: first.yaw, moving: true, activity: 'walk' };
}
