import { Type, type Static } from '@sinclair/typebox';
import { Reason } from './primitives.js';

export const RepositoryRequestStatus = Type.Union([Type.Literal('pending'), Type.Literal('approved'), Type.Literal('rejected')]);
export type RepositoryRequestStatusValue = Static<typeof RepositoryRequestStatus>;
export const CreateRepositoryRequest = Type.Object({
  repository_url: Type.String({ minLength: 1, maxLength: 2000 }), reason: Reason,
}, { additionalProperties: false });
export type CreateRepositoryRequestInput = Static<typeof CreateRepositoryRequest>;
export const ReviewRepositoryRequest = Type.Object({
  version: Type.String({ pattern: '^[1-9][0-9]{0,18}$' }), decision: Type.Union([Type.Literal('approve'), Type.Literal('reject')]),
  reason: Reason, installation_id: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,19}$' })),
}, { additionalProperties: false });
export type ReviewRepositoryRequestInput = Static<typeof ReviewRepositoryRequest>;
export interface RepositoryRequestDto {
  id: string; user_id: string; applicant_login: string; owner: string; name: string; repository_url: string; reason: string;
  status: RepositoryRequestStatusValue; version: string; repository_id: string | null; review_reason: string | null;
  reviewer_user_id: string | null; reviewed_at: string | null; created_at: string; updated_at: string;
}
