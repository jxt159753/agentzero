import { Type, type Static } from '@sinclair/typebox';
import { Amount, Name, Reason, Uuid } from './primitives.js';
import { TaskVersion } from './tasks.js';

export const AgreementMember = Type.Object({agent_id:Uuid,role:Name,deliverable:Type.String({minLength:1,maxLength:2000,pattern:'\\S'}),amount_points:Amount},{additionalProperties:false});
export const ProposeAgreement = Type.Object({version:TaskVersion,deadline_at:Type.String({format:'date-time'}),members:Type.Array(AgreementMember,{minItems:1,maxItems:3})},{additionalProperties:false});
export const ConfirmAgreement = Type.Object({version:TaskVersion,agent_id:Type.Optional(Uuid),as_publisher:Type.Optional(Type.Boolean())},{additionalProperties:false});
export const RejectAgreement = Type.Object({...ConfirmAgreement.properties,reason:Reason},{additionalProperties:false});
export const SubmitContribution = Type.Object({version:TaskVersion,agent_id:Uuid,kind:Type.Union([Type.Literal('pr'),Type.Literal('test'),Type.Literal('note')]),body:Type.String({minLength:1,maxLength:8000,pattern:'\\S'}),url:Type.Optional(Type.String({maxLength:2000,pattern:'^https://'}))},{additionalProperties:false});
export type ProposeAgreementInput=Static<typeof ProposeAgreement>;
export type ConfirmAgreementInput=Static<typeof ConfirmAgreement>;
export type RejectAgreementInput=Static<typeof RejectAgreement>;
export type SubmitContributionInput=Static<typeof SubmitContribution>;
export interface ParticipantDto {agent_id:string;owner_user_id:string;name:string;owner_name:string;role:string;deliverable:string;amount_points:string;shared_owner:boolean}
export interface ConfirmationDto {subject_key:string;agent_id:string|null;user_id:string;accepted_at:string|null}
export interface AgreementDto {id:string;task_id:string;version:string;status:'pending'|'active'|'superseded'|'rejected';deadline_at:string;created_at:string;activated_at:string|null;rejection_reason:string|null;members:ParticipantDto[];confirmations:ConfirmationDto[];can_accept:boolean;can_reject:boolean}
export interface ContributionDto {id:string;task_id:string;agreement_id:string|null;agent_id:string;kind:'pr'|'test'|'note';body:string;url:string|null;created_at:string}
