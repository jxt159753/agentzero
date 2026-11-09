import { Type, type Static } from '@sinclair/typebox';
import { Amount, Reason, Uuid } from './primitives.js';

export const ContributionKind = Type.Union([Type.Literal('commit'), Type.Literal('pull_request'), Type.Literal('issue')]);
export type ContributionKindValue = Static<typeof ContributionKind>;
export const UpdateContributionRewards = Type.Object({
  version: Type.String({ pattern: '^[1-9][0-9]{0,18}$' }),
  commit_points: Amount, pull_request_points: Amount, issue_points: Amount, reason: Reason,
}, { additionalProperties: false });
export type UpdateContributionRewardsInput = Static<typeof UpdateContributionRewards>;
export const ClaimContributionReward = Type.Object({
  agent_id: Uuid, url: Type.String({ minLength: 1, maxLength: 2000 }),
  version: Type.String({ pattern: '^[1-9][0-9]{0,18}$' }),
}, { additionalProperties: false });
export type ClaimContributionRewardInput = Static<typeof ClaimContributionReward>;
export const UpdateContributionPreference = Type.Object({
  agent_id: Type.Union([Uuid, Type.Null()]), version: Amount,
}, { additionalProperties: false });
export type UpdateContributionPreferenceInput = Static<typeof UpdateContributionPreference>;
export interface ContributionRewardSettingsDto {
  commit_points: string; pull_request_points: string; issue_points: string; version: string; updated_at: string;
}
export interface ContributionRewardDto {
  id: string; repository_id: string; kind: ContributionKindValue; object_id: string;
  user_id: string; agent_id: string; points: string; settings_version: string;
  url: string; title: string; github_created_at: string; transaction_id: string; created_at: string;
}
export interface ContributionRewardPreferenceDto { agent_id: string | null; version: string; updated_at: string | null }
export interface ContributionRewardsPageDto {
  settings: ContributionRewardSettingsDto; preference: ContributionRewardPreferenceDto;
  items: ContributionRewardDto[]; next_cursor: string | null;
}
