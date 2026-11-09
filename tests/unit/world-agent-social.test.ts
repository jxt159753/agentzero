import { describe, expect, it } from 'vitest';
import { sampleAgentActivity, type AgentActivityPlan } from '../../apps/web/src/world-agent-activity.js';
import { AgentSocialActivity, type AgentSocialParticipant } from '../../apps/web/src/world-agent-social.js';

function route(y: number): AgentActivityPlan {
  const left = { x: 0, y }, right = { x: 20, y };
  return { duration: 400, phase: 0, speed: 0.1, legs: [
    { from: left, to: right, yaw: Math.PI / 2, travel: 200, pause: 0, activity: 'rest' },
    { from: right, to: left, yaw: -Math.PI / 2, travel: 200, pause: 0, activity: 'rest' },
  ] };
}
const pair: AgentSocialParticipant[] = [{ id: 'alice', plan: route(0) }, { id: 'bob', plan: route(0.4) }];

function encounter(social: AgentSocialActivity, participants = pair) {
  for (let time = 0; time < 600; time++) {
    const samples = social.sample(participants, time);
    if (samples.get(participants[0]!.id)?.conversation) return { time, samples };
  }
  throw new Error('Expected nearby residents to greet within ten minutes');
}

describe('local ambient Agent conversations', () => {
  it('faces two nearby residents, alternates decorative lines, then resumes without jumping', () => {
    const social = new AgentSocialActivity(), { time, samples } = encounter(social);
    const a = samples.get('alice')!, b = samples.get('bob')!;
    expect(a.moving).toBe(false); expect(b.moving).toBe(false);
    expect(a.yaw).toBe(0); expect(Math.abs(b.yaw)).toBe(Math.PI);
    expect(a.conversation?.partnerId).toBe('bob'); expect(b.conversation?.partnerId).toBe('alice');
    expect(a.conversation?.text).not.toBe(''); expect(b.conversation?.text).toBe('');
    const reply = social.sample(pair, time + 2.1);
    expect(reply.get('alice')?.conversation?.text).toBe(''); expect(reply.get('bob')?.conversation?.text).not.toBe('');
    for (const id of ['alice', 'bob']) expect(reply.get(id)?.point).toEqual(samples.get(id)?.point);
    const resumed = social.sample(pair, time + 6);
    expect(resumed.get('alice')?.conversation).toBeUndefined();
    expect(resumed.get('alice')?.point).toEqual(a.point);
    const walking = social.sample(pair, time + 6.1).get('alice')!;
    expect(Math.hypot(walking.point.x - a.point.x, walking.point.y - a.point.y)).toBeCloseTo(0.01, 8);
    for (let elapsed = 7; elapsed < 51; elapsed++) {
      expect(social.sample(pair, time + elapsed).get('alice')?.conversation).toBeUndefined();
    }
  });

  it('ends an encounter when its partner leaves, preserving the remaining route position', () => {
    const social = new AgentSocialActivity(), { time, samples } = encounter(social);
    const alone = social.sample([pair[0]!], time + 2.5);
    expect(alone.size).toBe(1); expect(alone.get('alice')?.conversation).toBeUndefined();
    expect(alone.get('alice')?.point).toEqual(samples.get('alice')?.point);
    const later = social.sample([pair[0]!], time + 3.5).get('alice')!;
    expect(later.point.x - alone.get('alice')!.point.x).toBeCloseTo(0.1, 8);
    expect(social.sample([], time + 4).size).toBe(0);
  });

  it('limits residents to 24 and simultaneous pairs to two without assigning anyone twice', () => {
    const crowded = Array.from({ length: 40 }, (_, index) => ({ id: `resident-${index}`, plan: route(index % 4 * 0.21) }));
    const social = new AgentSocialActivity();
    let observed = false;
    for (let time = 0; time < 120; time++) {
      const samples = social.sample(crowded, time);
      expect(samples.size).toBe(24);
      const talking = [...samples.entries()].filter(([, sample]) => sample.conversation);
      expect(talking.length).toBeLessThanOrEqual(4);
      if (talking.length) observed = true;
      for (const [id, sample] of talking) {
        expect(samples.get(sample.conversation!.partnerId)?.conversation?.partnerId).toBe(id);
      }
    }
    expect(observed).toBe(true);
  });

  it('keeps separated residents on their normal routes and does not start extra encounters between scan ticks', () => {
    const separated = [pair[0]!, { id: 'bob', plan: route(3) }];
    const social = new AgentSocialActivity();
    for (let time = 0; time < 120; time++) {
      const samples = social.sample(separated, time);
      expect(samples.get('alice')).toEqual(sampleAgentActivity(pair[0]!.plan, time));
      expect(samples.get('bob')?.conversation).toBeUndefined();
    }
    const { time } = encounter(new AgentSocialActivity());
    const throttled = new AgentSocialActivity();
    throttled.sample(separated, time);
    for (let frame = 1; frame < 60; frame++) {
      expect(throttled.sample(pair, time + frame / 60).get('alice')?.conversation).toBeUndefined();
    }
  });
});
