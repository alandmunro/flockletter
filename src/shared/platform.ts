import { z } from 'zod';

const operationKey=z.uuid(),caseId=z.uuid(),reason=z.string().trim().min(12).max(400);
const workspaceId=z.string().regex(/^org_[A-Za-z0-9_-]{1,120}$/);
const define=<T extends z.ZodRawShape>(description:string,mutation:boolean,shape:T)=>({description,mutation,schema:z.object(shape).strict()});
/** A separate command surface. Customer connection scopes never grant these commands. */
export const platformCommands={
  'platform.overview':define('Inspect platform health metadata and configuration gaps.',false,{}),
  'platform.openCase':define('Open a short-lived audited case for one exact workspace and resource.',true,{operationKey,workspaceId,kind:z.enum(['support','retention','abuse','delivery']),resourceId:z.uuid().nullable(),reason}),
  'platform.case':define('Read one case and its audited target.',false,{caseId}),
  'platform.support':define('Run a validated support action within the exact case target.',true,{caseId,command:z.enum(['support.get','support.draft','support.editDraft','support.approve','support.reauthorize','support.process','support.escalate','support.close','support.policyPreview','support.publishPolicy','support.policyHistory']),input:z.record(z.string(),z.unknown())}),
  'platform.retentionPlan':define('Build an exact hosted retention plan from protected evidence.',false,{caseId}),
  'platform.retentionApprove':define('Sign an expiring exact-target plan; never erase through HTTP.',true,{operationKey,caseId,expectedDigest:z.string().regex(/^[a-f0-9]{64}$/)}),
  'platform.abuseHold':define('Set a reversible workspace review hold without resetting trial history.',true,{operationKey,caseId,held:z.boolean(),reason}),
  'platform.alertAck':define('Acknowledge an alert without clearing the underlying risk.',true,{operationKey,alertId:z.uuid(),reason}),
  'platform.inbox':define('Inspect quarantined unassigned inbound support; sender is not authority.',false,{}),
};
export type PlatformCommand=keyof typeof platformCommands;
export type PlatformCase={id:string;workspaceId:string;kind:'support'|'retention'|'abuse'|'delivery';resourceId:string|null;reason:string;actorId:string;sessionId:string;verifiedAt:string;expiresAt:string;createdAt:string;requestHash:string};
export type PlatformAlert={id:string;workspaceId:string;code:string;active:boolean;acknowledgedAt:string|null;createdAt:string;updatedAt:string};
export type PlatformHealth={workspaceId:string;observedAt:string;lastPass:string|null;failure:string|null;pending:number;unknown:number};
export type PlatformOverview={mode:'off'|'capture'|'live';authority:'owner-exercise'|'platform-operator';gaps:string[];supportMode:'off'|'capture'|'live';writerConfigured:boolean;health:PlatformHealth[];alerts:PlatformAlert[];cases:PlatformCase[];sendingEnabled:false;erasureEnabled:false};
