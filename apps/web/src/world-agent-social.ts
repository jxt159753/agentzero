import { sampleAgentActivity, type AgentActivityPlan, type AgentActivitySample } from './world-agent-activity.js';

export interface AgentSocialParticipant { id: string; plan: AgentActivityPlan }
export interface AgentSocialSample extends AgentActivitySample { conversation?: { partnerId: string; text: string } }
interface ResidentState { plan: AgentActivityPlan; delay: number; availableAt: number; conversation?: Conversation }
interface Conversation {
  ids: readonly [string, string]; poses: readonly [AgentActivitySample, AgentActivitySample];
  startedAt: number; endsAt: number; lines: readonly string[];
}

// These are decorative scene lines, never messages authored by or delivered to an Agent.
const greetings = [
  ['你好，散步呢？', '是呀，这里真舒服。', '回头见！'],
  ['嗨，来广场逛逛？', '嗯，看看小镇的风景。', '祝你今天愉快！'],
  ['你好，今天天气不错。', '很适合出来走走。', '下次再聊！'],
] as const;

function seed(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  return ((hash ^ (hash >>> 13)) >>> 0) / 4294967296;
}

/** Local ambient encounters: bounded work, no timers, real presence changes or network writes. */
export class AgentSocialActivity {
  private readonly residents = new Map<string, ResidentState>();
  private readonly conversations = new Set<Conversation>();
  private lastScan = -Infinity;

  sample(participants: readonly AgentSocialParticipant[], seconds: number): Map<string, AgentSocialSample> {
    const nearby = participants.slice(0, 24).sort((a, b) => a.id.localeCompare(b.id));
    const present = new Set(nearby.map(participant => participant.id));
    for (const id of this.residents.keys()) if (!present.has(id)) this.residents.delete(id);
    for (const { id, plan } of nearby) {
      if (this.residents.get(id)?.plan !== plan) this.residents.set(id, { plan, delay: 0, availableAt: -Infinity });
    }
    for (const conversation of this.conversations) {
      if (seconds >= conversation.endsAt || conversation.ids.some(id => this.residents.get(id)?.conversation !== conversation)) {
        this.finish(conversation, seconds);
      }
    }
    const samples = new Map<string, AgentSocialSample>();
    for (const [id, state] of this.residents) samples.set(id, sampleAgentActivity(state.plan, seconds - state.delay));

    // At most 276 distance checks once per second, irrespective of render frame rate.
    const tick = Math.floor(seconds);
    if (tick !== this.lastScan) {
      this.lastScan = tick;
      for (let i = 0; i < nearby.length && this.conversations.size < 2; i++) {
        const first = nearby[i]!, firstState = this.residents.get(first.id)!;
        if (firstState.conversation || seconds < firstState.availableAt) continue;
        for (let j = i + 1; j < nearby.length; j++) {
          const second = nearby[j]!, secondState = this.residents.get(second.id)!;
          if (secondState.conversation || seconds < secondState.availableAt) continue;
          const a = samples.get(first.id)!, b = samples.get(second.id)!;
          const distance = Math.hypot(a.point.x - b.point.x, a.point.y - b.point.y);
          if (distance < 0.2 || distance > 0.7) continue;
          // One chance per pair per half-minute, rather than a new random chance every frame.
          const chance = seed(`${first.id}:${second.id}:${Math.floor(seconds / 30)}`);
          if (chance >= 0.4) continue;
          const conversation: Conversation = { ids: [first.id, second.id], poses: [a, b], startedAt: seconds,
            endsAt: seconds + 6, lines: greetings[Math.floor(chance / 0.4 * greetings.length)]! };
          firstState.conversation = conversation; secondState.conversation = conversation;
          this.conversations.add(conversation);
          break;
        }
      }
    }
    for (const conversation of this.conversations) {
      const turn = Math.min(2, Math.floor((seconds - conversation.startedAt) / 2));
      for (const index of [0, 1] as const) {
        const partnerIndex = index === 0 ? 1 : 0, pose = conversation.poses[index], partner = conversation.poses[partnerIndex];
        samples.set(conversation.ids[index], { point: { ...pose.point }, moving: false, activity: 'rest',
          yaw: Math.atan2(partner.point.x - pose.point.x, partner.point.y - pose.point.y),
          conversation: { partnerId: conversation.ids[partnerIndex], text: turn % 2 === index ? conversation.lines[turn]! : '' } });
      }
    }
    return samples;
  }

  private finish(conversation: Conversation, seconds: number): void {
    const finishedAt = Math.min(seconds, conversation.endsAt);
    for (const id of conversation.ids) {
      const state = this.residents.get(id);
      if (state?.conversation !== conversation) continue;
      state.delay += finishedAt - conversation.startedAt;
      state.availableAt = finishedAt + 45;
      delete state.conversation;
    }
    this.conversations.delete(conversation);
  }
}
