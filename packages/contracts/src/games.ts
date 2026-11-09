import { Type, type Static } from '@sinclair/typebox';
import { Amount, Name, Reason, Uuid } from './primitives.js';

export const GAME_BUNDLE_MAX_BYTES = 2 * 1024 * 1024;
export const GAME_SESSION_MINUTES = 30;
export const GameSettlementRule = Type.Union([Type.Literal('manual'), Type.Literal('starlight_slots_v1')]);
export type GameSettlementRuleId = Static<typeof GameSettlementRule>;
const PositiveAmount = Type.String({ pattern: '^[1-9][0-9]{0,18}$', maxLength: 19 });
export const GameSource = Type.Union([
  Type.Object({ type: Type.Literal('url'), url: Type.String({ pattern: '^https://', maxLength: 2000 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('bundle'), entry: Type.String({ minLength: 1, maxLength: 200 }), files: Type.Array(Type.Object({
    path: Type.String({ minLength: 1, maxLength: 200 }), content: Type.String({ maxLength: 2796204 }), mime: Type.String({ maxLength: 80 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 128 }) }, { additionalProperties: false }),
]);
export const CreateGame = Type.Object({ agent_id: Uuid, name: Name, description: Type.String({ maxLength: 1000 }),
  entry_fee: PositiveAmount, max_reward: PositiveAmount, minimum_pool: Type.Optional(PositiveAmount), source: GameSource,
  settlement_rule: Type.Optional(GameSettlementRule) }, { additionalProperties: false });
export const PatchGame = Type.Object({ version: PositiveAmount, status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('paused')])),
  minimum_pool: Type.Optional(PositiveAmount), settlement_rule: Type.Optional(GameSettlementRule),
  description: Type.Optional(Type.String({ maxLength: 1000 })), source: Type.Optional(GameSource) }, { additionalProperties: false, minProperties: 2 });
export const GameFunds = Type.Object({ amount: PositiveAmount }, { additionalProperties: false });
export const BindGameMachine = Type.Object({ game_id: Type.Union([Uuid, Type.Null()]) }, { additionalProperties: false });
export const StartGameSession = Type.Object({ agent_id: Type.Optional(Uuid), game_version: PositiveAmount }, { additionalProperties: false });
export const SubmitGameScore = Type.Object({ score: Amount, reward_requested: Amount }, { additionalProperties: false });
export const SettleGameSession = Type.Object({ reward_points: Amount, score: Type.Optional(Amount), reason: Reason }, { additionalProperties: false });
export const GameEmpty = Type.Object({}, { additionalProperties: false });
export const GameListQuery = Type.Object({ mine: Type.Optional(Type.String({ enum: ['true'] })) }, { additionalProperties: false });
export type GameSourceInput = Static<typeof GameSource>;
export type CreateGameInput = Static<typeof CreateGame>;
export type PatchGameInput = Static<typeof PatchGame>;
export type SubmitGameScoreInput = Static<typeof SubmitGameScore>;
export type SettleGameSessionInput = Static<typeof SettleGameSession>;
export interface GameDto {
  id: string; author_agent_id: string; owner_user_id: string; name: string; description: string;
  entry_fee: string; max_reward: string; status: 'active' | 'paused'; version: string;
  settlement_rule: GameSettlementRuleId;
  pool_balance: string; pool_committed: string; minimum_pool: string; available_pool: string; accepting_players: boolean;
  source_type: 'url' | 'bundle'; entry_url: string; created_at: string;
}
export interface GameSessionDto {
  id: string; game_id: string; player_agent_id: string | null; player_user_id: string; entry_fee: string; max_reward: string;
  settlement_rule: GameSettlementRuleId;
  status: 'playing' | 'submitted' | 'settled' | 'refunded'; score: string | null; reward_requested: string | null;
  reward_points: string | null; expires_at: string; created_at: string;
}
export interface GameMachineDto { placement_id: string; game: GameDto | null }
