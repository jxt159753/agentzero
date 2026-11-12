import { Type, type Static } from '@sinclair/typebox';
import { Amount, Name, Reason, Uuid } from './primitives.js';
import type { AgreementDto, ConfirmationDto, ContributionDto, ParticipantDto } from './collaboration.js';

export const TaskStatus = Type.Union(['draft','open','in_progress','submitted','changes_requested','settled','cancelled'].map(value=>Type.Literal(value)));
export const TaskVersion = Type.String({pattern:'^[1-9][0-9]{0,18}$'});
const Text = Type.String({minLength:1,maxLength:8000,pattern:'\\S'});
const TaskFields = {
  title:Name, description:Text, repository_id:Type.Optional(Type.Union([Uuid,Type.Null()])), issue_number:Type.Optional(Type.Union([Type.Integer({minimum:1,maximum:2147483647}),Type.Null()])),
  acceptance_criteria:Type.Optional(Text), required_checks:Type.Optional(Type.Array(Type.String({minLength:1,maxLength:200,pattern:'\\S'}),{maxItems:30,uniqueItems:true})),
  reward_points:Amount, deadline_at:Type.String({format:'date-time'}), reviewer_user_id:Type.Optional(Uuid), payer_agent_id:Type.Union([Uuid,Type.Null()]),
};
export const CreateTask = Type.Object(TaskFields,{additionalProperties:false});
export const EditTask = Type.Object({...Type.Partial(CreateTask).properties,version:TaskVersion},{additionalProperties:false,minProperties:2});
export const TaskVersionBody = Type.Object({version:TaskVersion},{additionalProperties:false});
export const AcceptTask = Type.Object({version:TaskVersion,agent_id:Uuid},{additionalProperties:false});
export const SubmitTask = Type.Union([
  Type.Object({version:TaskVersion,pr_number:Type.Integer({minimum:1,maximum:2147483647}),head_sha:Type.String({pattern:'^[0-9a-f]{40}$'})},{additionalProperties:false}),
  Type.Object({version:TaskVersion,content:Text},{additionalProperties:false}),
]);
export const ReviewTask = Type.Object({version:TaskVersion,decision:Type.Union([Type.Literal('accept'),Type.Literal('request_changes')]),reason:Reason,unmet_criteria:Type.Optional(Type.String({minLength:1,maxLength:2000,pattern:'\\S'}))},{additionalProperties:false});
export const TaskReasonBody = Type.Object({version:TaskVersion,reason:Reason},{additionalProperties:false});
export const TaskPayments = Type.Array(Type.Object({agent_id:Uuid,amount_points:Amount},{additionalProperties:false}),{minItems:1,maxItems:3});
export const CancelTaskProposal = Type.Object({version:TaskVersion,payment_points:Amount,refund_points:Amount,reason:Reason,payments:Type.Optional(TaskPayments),agent_id:Type.Optional(Uuid),as_publisher:Type.Optional(Type.Boolean())},{additionalProperties:false});
export const ResolveTask = Type.Object({...CancelTaskProposal.properties,outcome:Type.Union([Type.Literal('settled'),Type.Literal('cancelled')])},{additionalProperties:false});
export type CreateTaskInput=Static<typeof CreateTask>;
export type EditTaskInput=Static<typeof EditTask>;
export type SubmitTaskInput=Static<typeof SubmitTask>;
export type ReviewTaskInput=Static<typeof ReviewTask>;
export type CancelTaskInput=Static<typeof CancelTaskProposal>;
export type ResolveTaskInput=Static<typeof ResolveTask>;

export interface TaskDto {
  id:string; title:string; description:string; repository_id:string|null; issue_number:number|null;
  acceptance_criteria:string; required_checks:string[]; reward_points:string; deadline_at:string;
  publisher_user_id:string; publisher_agent_id:string|null; payer_agent_id:string|null; reviewer_user_id:string; assignee_agent_id:string|null;
  status:'draft'|'open'|'in_progress'|'submitted'|'changes_requested'|'settled'|'cancelled'; version:string;
  disputed:boolean; dispute_reason:string|null; hold_id:string|null; latest_delivery_id:string|null;
  review_due_at:string|null; review_reminded_at:string|null; settled_journal_id:string|null;
  created_at:string; updated_at:string; published_at:string|null; accepted_at:string|null; finalized_at:string|null;
  publisher_name?:string; reviewer_name?:string; assignee_name?:string|null; repository_name?:string|null;
  permissions?:Record<'edit'|'publish'|'accept'|'submit'|'review'|'cancel'|'propose_cancel'|'dispute'|'resolve',boolean>&Partial<Record<'propose_agreement'|'contribute'|'discuss'|'admin_cancel'|'admin_intervene',boolean>>;
  active_agreement_id?:string|null; participants?:ParticipantDto[]; agreements?:AgreementDto[]; contributions?:ContributionDto[];
  repository?:{id:string;full_name:string;status:string;installation_status:string}|null;
  hold?:{id:string;status:string;reserved_total:string;captured_total:string;released_total:string;remaining:string}|null;
  deliveries?:TaskDeliveryDto[]; reviews?:TaskReviewDto[]; cancellation_proposals?:TaskCancellationDto[]; events?:TaskEventDto[];
}
export interface TaskDeliveryDto {id:string;task_id:string;agent_id:string;pr_number:number|null;head_sha:string|null;pr_url:string|null;content?:string|null;evidence:Record<string,unknown>;created_at:string}
export interface TaskReviewDto {id:string;task_id:string;delivery_id:string|null;reviewer_user_id:string;decision:string;reason:string;unmet_criteria:string|null;evidence?:Record<string,unknown>|null;created_at:string}
export interface TaskCancellationDto {id:string;task_id:string;payment_points:string;refund_points:string;reason:string;status:'pending'|'accepted'|'superseded';publisher_accepted:boolean;assignee_accepted:boolean;can_accept?:boolean;created_at:string;payments?:{agent_id:string;amount_points:string}[];confirmations?:ConfirmationDto[]}
export interface TaskEventDto {id:string;task_id:string;kind:string;actor_type:string;actor_user_id:string|null;actor_agent_id:string|null;details:Record<string,unknown>;created_at:string}
