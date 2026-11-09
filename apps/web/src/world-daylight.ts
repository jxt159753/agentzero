export interface DaylightState {
  phase: 'dawn' | 'day' | 'dusk' | 'night';
  hours: number; daylight: number; lamps: number;
  skyTop: number; skyHorizon: number; fog: number;
  hemisphereSky: number; hemisphereGround: number; sunColor: number; cloudColor: number;
  hemisphereIntensity: number; sunIntensity: number; exposure: number;
  sunPosition: { x: number; y: number; z: number };
}

function smoothstep(from: number, to: number, value: number) {
  const t = Math.max(0, Math.min(1, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

function blend(from: number, to: number, amount: number) {
  let color = 0;
  for (const shift of [16, 8, 0]) color |= Math.round(((from >> shift) & 255) * (1 - amount) + ((to >> shift) & 255) * amount) << shift;
  return color;
}

/** A shared Beijing-time day, sampled from the existing server clock without weather or astronomy requests. */
export function sampleDaylight(epochMilliseconds: number): DaylightState {
  const hours = ((epochMilliseconds / 3600000 + 8) % 24 + 24) % 24;
  const daylight = smoothstep(5.5, 7, hours) * (1 - smoothstep(17, 18.5, hours));
  const warmth = 4 * daylight * (1 - daylight), angle = (hours - 6) / 24 * Math.PI * 2;
  const horizon = blend(blend(0x263f5b, 0xd9e8de, daylight), 0xe8a97a, warmth * 0.8);
  return {
    phase: hours >= 5.5 && hours < 7 ? 'dawn' : hours >= 7 && hours < 17 ? 'day' : hours >= 17 && hours < 18.5 ? 'dusk' : 'night',
    hours, daylight, lamps: 1 - smoothstep(0.18, 0.7, daylight),
    skyTop: blend(0x081629, 0x4096c4, daylight), skyHorizon: horizon,
    fog: blend(blend(0x1c304c, 0xc7dfeb, daylight), 0xd6a28a, warmth * 0.45),
    hemisphereSky: blend(0x7895c2, 0xe3f1ff, daylight), hemisphereGround: blend(0x29394c, 0x71844f, daylight),
    sunColor: blend(blend(0x92b2e0, 0xffe5bb, daylight), 0xffb36d, warmth),
    cloudColor: blend(blend(0x40546e, 0xffffff, daylight), 0xf5c2a0, warmth * 0.65),
    hemisphereIntensity: 0.42 + daylight * 1.03, sunIntensity: 0.18 + daylight * 2.32,
    exposure: 1.1 - daylight * 0.07,
    sunPosition: { x: -Math.cos(angle) * 24, y: 8 + Math.abs(Math.sin(angle)) * 20, z: 14 },
  };
}
