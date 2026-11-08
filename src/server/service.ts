import { studioProblem } from '../shared/studio.js';
import { withStudio } from '../shared/studio-legacy.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { commands, limits, plans, type AssetSummary, type Campaign, type CampaignContent, type Capability, type CommandName, type Connection } from '../shared/contracts.js';
import { Database, type Sql } from './db.js';
import { AppError, requireCondition } from './errors.js';
import { comparePlan, verifiedMemberCount } from './billing/plan-comparison.js';
import { deliveryGaps, digest, inspectImage, preflight, renderPreview } from './content.js';
import { SubscriberIntake } from './subscribers/intake.js';
import { audienceSummary, contactDetail, listContacts, unsubscribeContact } from './subscribers/audience.js';
import {createSegment,deleteSegment,listSegments,renameSegment,segmentSummary,updateSegmentMembers} from './subscribers/segments.js';
import { templates, fromTemplateContent, fromProductContent } from '../shared/authoring.js';
import { invalidateStudioReviews, approveRehearsal, cancelRehearsal, capturedMessage, listRehearsals, processDue, recipientOutcomes, rehearsalReport, reviewRehearsal, type CheckOwner } from './campaign/rehearsal.js';
import { localFeedbackBinding } from './campaign/feedback.js';
import { sesScope,type SesConfiguration } from './campaign/ses-runtime.js';
import { unsubscribeProfile, type MarketingLinks } from './subscribers/marketing-links.js';
import { deliveryReadiness } from './campaign/delivery-readiness.js';
import type {PrivateListmonk} from './campaign/private-listmonk.js';
import {isListmonkMethod,requiresSimulationGrant,type RehearsalTransport} from '../shared/rehearsal.js';
import { DeliveryWorker } from './campaign/delivery-worker.js';
import { practiceUsage, utcPeriod, workspaceAccess } from './campaign/access.js';
import { previewImport } from './subscribers/import-preview.js';
import { applyPracticeImport } from './subscribers/apply-import.js';
import { practiceImportRows } from '../shared/import-preview.js';
import type { Config } from './config.js';
import { senderStatus, registerSender, verifySender,lookupTxt,type LookupTxt } from './campaign/sender.js';
import { exportPage } from './subscribers/audience-export.js';
import { SandboxBilling } from './billing/service.js';
import {operations} from './campaign/operations.js';
import {retentionPreview} from './retention.js';
import {teamPage,teamInvitations,grantMember,revokeMember,unavailableTeam,memberPermissions,seatLimit,type ClerkTeam} from './team.js';
import { inviteMember } from './team-invitations.js';
import {companyDirectory,createCompany,renameCompany,createBrand,renameBrand,moveBrand} from './companies.js';

export type Actor = { workspaceId: string; userId: string; actorId: string; owner: boolean; kind: 'session' | 'connection'; scopes: Capability[]; brandIds: string[] | null };
type CampaignRow = { id: string; brand_id: string; version: number; content: CampaignContent; created_at: Date; updated_at: Date };
type AssetRow = { id: string; name: string; mime: string; size: number; width: number; height: number; sha256: string; created_at: Date; bytes: Buffer };
type ConnectionRow = { id: string; name: string; scopes: Capability[]; brand_ids: string[]; created_at: Date; expires_at: Date; revoked_at: Date | null };
const campaignView = (row: CampaignRow): Campaign => ({ id: row.id, brandId: row.brand_id, version: row.version, content: row.content, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), status: 'draft' });
const assetView = (row: AssetRow): AssetSummary => ({ id: row.id, name: row.name, mime: row.mime, size: row.size, width: row.width, height: row.height, sha256: row.sha256, createdAt: row.created_at.toISOString() });
const connectionView = (row: ConnectionRow): Connection => ({ id: row.id, name: row.name, scopes: row.scopes, brandIds: row.brand_ids, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null });

export function authorize(actor: Actor, name: CommandName) {
  const scope = commands[name].scope;
  if(scope==='campaign:rehearse' && actor.kind==='connection') requireCondition(actor.scopes.includes('read'),403,'scope_required','Rehearsals also require draft read access.');
  if (scope === 'owner') requireCondition(actor.kind === 'session' && actor.owner, 403, 'owner_required', 'Use a current workspace owner session for this action.');
  else {
    const memberScope=scope==='read'||scope==='draft:write'||scope==='assets:write';
    const allowed=actor.kind==='connection'?actor.owner&&actor.scopes.includes(scope):
      actor.owner||memberScope&&actor.scopes.includes(scope);
    requireCondition(allowed,403,'scope_required',`This action requires ${scope} access in this workspace.`);
  }
}
function assertBrand(actor: Actor, brandId: string) { requireCondition(actor.brandIds === null || actor.brandIds.includes(brandId), 404, 'not_found', 'The requested item is unavailable in this workspace or connection.'); }
async function brand(sql: Sql, actor: Actor, id: string) {
  assertBrand(actor, id);
  const found = await sql.query('SELECT id FROM brands WHERE id=$1', [id]);
  requireCondition(found.rowCount, 404, 'not_found', 'This brand is unavailable.');
}
async function audienceBrand(sql: Sql, actor: Actor, id: string) {
  await brand(sql, actor, id);
  await sql.query("SELECT set_config('app.intake_brand_id',$1,true)", [id]);
}
async function checkPracticeScope(sql:Sql,actor:Actor,id:string){
  if(actor.kind==='session'||actor.scopes.includes('audience:summary'))return;
  const visible=await sql.query("SELECT id FROM campaign_rehearsals WHERE id=$1 AND audience='test'",[id]);
  requireCondition(visible.rowCount,404,'not_found','This rehearsal is unavailable with this grant.');
}
async function campaign(sql: Sql, actor: Actor, id: string) {
  const result = await sql.query<CampaignRow>('SELECT * FROM campaigns WHERE id=$1', [id]);
  const row = result.rows[0];
  requireCondition(row, 404, 'not_found', 'This campaign is unavailable.');
  assertBrand(actor, row.brand_id);
  return campaignView(row);
}
async function checkImages(sql: Sql, actor: Actor, brandId: string, ids: string[]) {
  await brand(sql, actor, brandId);
  const result = await sql.query('SELECT id FROM assets WHERE brand_id=$1 AND id=ANY($2::uuid[])', [brandId, ids]);
  requireCondition(result.rowCount === ids.length, 422, 'image_unavailable', 'Every selected image must belong to this campaign brand.');
}

export class CommandService {
  constructor(readonly db: Database, readonly intake = new SubscriberIntake(db),
    readonly checkOwner:CheckOwner = async()=>{throw new AppError(503,'membership_unavailable','Current workspace membership could not be verified.');},
    readonly resolveTxt:LookupTxt=lookupTxt,readonly billing=new SandboxBilling(db),readonly team:ClerkTeam=unavailableTeam,
    private readonly providerScope?:(workspace:string,brand:string)=>boolean, readonly ses?:SesConfiguration,readonly listmonk?:PrivateListmonk,
    private readonly importEnvironment?: Config['environment'], readonly marketing?: MarketingLinks) {}
  private get practiceImportsEnabled() {
    return this.importEnvironment === 'staging' || this.importEnvironment === 'local' || this.importEnvironment === 'test';
  }
  private async methods(sql:Sql,w:string,b:string,actor:Actor):Promise<RehearsalTransport[]> {
    const methods:RehearsalTransport[]=['capture'];
    if(this.providerScope && !this.providerScope(w,b)) return methods;
    methods.push('provider_test');
    if(actor.kind==='connection' && !actor.scopes.includes('campaign:simulate')) return methods;
    methods.push('feedback_test');
    if(this.listmonk?.binding(w,b,'listmonk_test')) methods.push('listmonk_test');
    const candidate=sesScope(this.ses,w,b);
    if(candidate?.port && (await sql.query("SELECT 1 FROM sender_domains WHERE domain=$1 AND verified_at > now()-interval '24 hours'",[candidate.route.from.split('@')[1]])).rowCount){
      methods.push('ses_simulator');
      if(this.listmonk?.binding(w,b,'listmonk_ses')) methods.push('listmonk_ses');
    }
    return methods;
  }
  async execute(name: CommandName, raw: unknown, actor: Actor): Promise<unknown> {
    authorize(actor, name);
    if (name === 'sender.deliveryReadiness') {
      const {brandId} = commands[name].schema.parse(raw);
      const sender = await this.db.tenant(actor.workspaceId, async sql => {
        await audienceBrand(sql,actor,brandId);
        return senderStatus(sql);
      });
      return deliveryReadiness(sender,sesScope(this.ses,actor.workspaceId,brandId),this.providerScope?.(actor.workspaceId,brandId) ?? false);
    }
    const definition = commands[name];
    const parsed = definition.schema.safeParse(raw);
    if (!parsed.success) {
      if (name.startsWith('segment.')) throw new AppError(422, 'invalid_segment_input', 'Review the brand, group, name or contact rows.');
      if (name === 'audience.applyPracticeImport') throw new AppError(422, 'invalid_practice_import', 'Choose a CSV email column, affirm permission for fictional contacts, and provide a stable operation key.');
      if (name.startsWith('audience.')) throw new AppError(422, 'invalid_audience_input', 'Review the brand, contact, email, status or page.');
      throw parsed.error;
    }
    const input = parsed.data;
    if (name === 'billing.comparePlan') {
      const { plan } = commands[name].schema.parse(raw);
      const members = await verifiedMemberCount(this.team, actor.workspaceId);
      return this.db.tenant(actor.workspaceId, sql => comparePlan(sql, plan, members));
    }
    // Provider mutations persist their own intent before crossing the network. Session URLs never enter generic receipts.
    if(name==='billing.checkout') {const request=commands[name].schema.parse(raw);return this.billing.checkout(actor,request.plan,request.operationKey);}
    if(name==='billing.restart'){const input=commands[name].schema.parse(raw);return this.billing.restart(actor,input.plan,input.expiredId,input.operationKey);}
    if(name==='billing.portal') return this.billing.portal(actor,commands[name].schema.parse(raw).operationKey);
    if(name==='team.invitations') return teamInvitations(this.db,actor.workspaceId,actor.userId,this.team,commands[name].schema.parse(raw).offset);
    if(name==='team.invite'){
      const request=commands[name].schema.parse(raw);
      return inviteMember(this.db,actor,this.team,seatLimit,request.email,request.operationKey);
    }
    const optOut = name === 'audience.unsubscribe' ? commands[name].schema.parse(raw) : null;
    let wake: {brandId:string;id:string} | undefined;
    const response = await this.db.tenant(actor.workspaceId, async sql => {
      let requestHash = '';
      let operationKey = '';
      if (definition.mutation) {
        await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [actor.workspaceId]);
        if(actor.kind==='session'&&!actor.owner){
          // Recheck after the workspace lock: a brand grant or seat could have changed while this write waited.
          requireCondition(await this.team.membership(actor.userId,actor.workspaceId)==='member',403,'membership_required','Current workspace membership is required.');
          const current=await memberPermissions(sql,actor.workspaceId,actor.userId,this.team);
          actor={...actor,...current};authorize(actor,name);
          if('brandId' in input)await brand(sql,actor,input.brandId);
          if(name==='campaign.update')await campaign(sql,actor,commands[name].schema.parse(raw).id);
        }
        if (name.startsWith('rehearsal.') && 'brandId' in input) {
          await audienceBrand(sql,actor,input.brandId);
          if(name==='rehearsal.review' && 'audience' in input && input.audience==='confirmed' && actor.kind==='connection')
            requireCondition(actor.scopes.includes('audience:summary'),403,'scope_required','Grant audience totals to review a brand audience.');
          if('id' in input) await checkPracticeScope(sql,actor,input.id);
          if(actor.kind==='connection' && !actor.scopes.includes('campaign:simulate') && name!=='rehearsal.cancel'){
            const method='transport' in input?input.transport:'id' in input?(await sql.query('SELECT transport FROM campaign_rehearsals WHERE id=$1',[input.id])).rows[0]?.transport:undefined;
            requireCondition(!requiresSimulationGrant(method),403,'scope_required','This method requires a separate campaign simulator grant.');
          }
        }
        if (name.startsWith('segment.') && 'brandId' in input) {
          requireCondition(await this.checkOwner(actor.userId,actor.workspaceId),403,'owner_required','Current workspace ownership is required to manage groups.');
          await audienceBrand(sql, actor, input.brandId);
        }
        if(name==='team.grant'||name==='team.revoke')
          requireCondition(await this.team.membership(actor.userId,actor.workspaceId)==='owner',403,'owner_required','Current Clerk owner membership is required.');
        if (name === 'audience.applyPracticeImport' && 'brandId' in input) {
          requireCondition(this.practiceImportsEnabled, 403, 'practice_import_disabled', 'Practice imports are available only in staging or a local test.');
          await audienceBrand(sql, actor, input.brandId);
          requireCondition(await this.checkOwner(actor.userId,actor.workspaceId),403,'owner_required','Current workspace ownership is required to import contacts.');
        }
        if (optOut) await audienceBrand(sql, actor, optOut.brandId);
        // A permanent opt-out has one replay identity per owner, brand and contact.
        operationKey = optOut ? `unsubscribe:${optOut.brandId}:${optOut.id}` : (input as { operationKey: string }).operationKey;
        requestHash = digest(JSON.stringify({ name, input }));
        const prior = await sql.query<{ request_hash: string; result: unknown }>('SELECT request_hash,result FROM operations WHERE actor_id=$1 AND operation_key=$2', [actor.actorId, operationKey]);
        if (prior.rows[0]) {
          requireCondition(prior.rows[0].request_hash === requestHash, 409, 'operation_conflict', 'This operation key was already used for different input. Retry the original request or use a new key.');
          if(name==='rehearsal.review'||name==='rehearsal.approve'){
            const receipt=prior.rows[0].result as {id:string};
            const status=await sql.query<{reason:string|null}>('SELECT reason FROM campaign_rehearsals WHERE id=$1',[receipt.id]);
            requireCondition(status.rows[0]?.reason!=='draft_changed',409,'version_conflict','The draft changed. Review its current version.');
          }
          return prior.rows[0].result;
        }
        const disablingIntake = name === 'intake.configure' && 'enabled' in input && input.enabled === false;
        if (name !== 'connection.revoke' && name !== 'team.revoke' && name !== 'rehearsal.cancel' && !disablingIntake && !optOut) {
          const count = (await sql.query<{ count: string }>('SELECT count(*) FROM operations')).rows[0];
          requireCondition(Number(count?.count) < limits.preparationOperations, 422, 'preparation_limit', 'This foundation workspace has reached its preparation operation limit. Contact the operator; connection revocation remains available.');
        }
      }
      const result = await this.perform(name, raw, actor, sql);
      if (name==='rehearsal.process' && result && typeof result==='object' && 'processingRequested' in result)
        wake=commands[name].schema.parse(raw);
      if (definition.mutation) {
        // Connection secrets are returned once, never persisted in replay records or audit.
        const stored = name === 'connection.create' ? { ...(result as Record<string, unknown>), token: undefined, secretAlreadyIssued: true } : result;
        await sql.query('INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result) VALUES($1,$2,$3,$4,$5)', [actor.workspaceId, actor.actorId, operationKey, requestHash, JSON.stringify(stored)]);
        await sql.query('INSERT INTO audit(workspace_id,id,actor_id,action,resource_id) VALUES($1,$2,$3,$4,$5)', [actor.workspaceId, randomUUID(), actor.actorId, name, optOut?.id ?? null]);
      }
      return result;
    });
    // The saved command receipt requests processing. Claims must commit independently
    // of that receipt and before any provider contact. Replaying the command only reads its receipt.
    if (wake) await new DeliveryWorker(this.db,this.checkOwner,undefined,this.ses,this.listmonk,this.marketing).tick(actor.workspaceId,wake.brandId,wake.id);
    return response;
  }
  private async perform(name: CommandName, raw: unknown, actor: Actor, sql: Sql): Promise<unknown> {
    const w = actor.workspaceId;
    switch (name) {
      case 'workspace.preflight': {
        const initialized = Boolean((await sql.query('SELECT workspace_id FROM workspaces')).rowCount);
        const access=await workspaceAccess(sql);
        const gaps=deliveryGaps().filter(gap=>gap.code!=='entitlement_not_active'||!access.plan);
        return { initialized, canPrepare: initialized, canSend: false, scopes: actor.scopes, brandIds: actor.brandIds, limits, gaps: [...(!initialized ? [{ code: 'workspace_not_initialized', title: 'Name your workspace and first brand', detail: 'A workspace owner must complete setup in the dashboard.' }] : []), ...gaps] };
      }
      case 'workspace.get': {
        const workspace = (await sql.query<{ name: string }>('SELECT name FROM workspaces')).rows[0];
        if (!workspace) return null;
        const brands = (await sql.query<{ id: string; name: string }>('SELECT id,name FROM brands ORDER BY name')).rows.filter(b => actor.brandIds === null || actor.brandIds.includes(b.id));
        const access=await workspaceAccess(sql);
        const hasDraft=Boolean((await sql.query('SELECT id FROM campaigns WHERE ($1::uuid[] IS NULL OR brand_id=ANY($1)) LIMIT 1',[actor.brandIds])).rowCount);
        return { name: workspace.name, brands,hasDraft, canEdit:actor.kind==='session'&&actor.owner||actor.scopes.includes('draft:write'), entitlement: access.plan?'complimentary':'not_activated', canManageConnections: actor.kind === 'session' && actor.owner, preparationLimits: limits, plans };
      }
      case 'workspace.initialize': {
        const input = commands[name].schema.parse(raw);
        if ((await sql.query('SELECT workspace_id FROM workspaces')).rowCount) return { initialized: true, alreadyExisted: true };
        await sql.query('INSERT INTO workspaces(workspace_id,name) VALUES($1,$2)', [w, input.name]);
        await sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [w, randomUUID(), input.brandName]);
        return { initialized: true, alreadyExisted: false };
      }
      case 'campaign.list': {
        const rows = await sql.query<CampaignRow>('SELECT * FROM campaigns WHERE ($1::uuid[] IS NULL OR brand_id=ANY($1::uuid[])) ORDER BY updated_at DESC LIMIT 100', [actor.brandIds]);
        return rows.rows.map(campaignView);
      }
      case 'workspace.access': {
        const access=await workspaceAccess(sql);
        return {access,usage:actor.kind==='session' && actor.owner?await practiceUsage(sql,utcPeriod(new Date())):null};
      }
      case 'workspace.operations':return operations(sql);
      case 'workspace.retention':return retentionPreview(sql,w);
      case 'team.list':return teamPage(sql,w,this.team,commands[name].schema.parse(raw).offset);
      case 'team.grant':{
        const request=commands[name].schema.parse(raw);return grantMember(sql,w,actor.userId,this.team,request.userId,request.permission,request.brandIds);
      }
      case 'team.revoke':{
        return revokeMember(sql,commands[name].schema.parse(raw).userId);
      }
      case 'template.list': return templates;
      case 'company.list':return companyDirectory(sql);
      case 'company.create':return createCompany(sql,w,commands[name].schema.parse(raw).name);
      case 'company.rename':{const {id,name:next}=commands[name].schema.parse(raw);return renameCompany(sql,id,next);}
      case 'brand.create':{const {companyId,name:next}=commands[name].schema.parse(raw);return createBrand(sql,w,companyId,next);}
      case 'brand.rename':{const {id,name:next}=commands[name].schema.parse(raw);return renameBrand(sql,id,next);}
      case 'brand.move':{const {id,companyId}=commands[name].schema.parse(raw);return moveBrand(sql,id,companyId);}
      case 'billing.status':return this.billing.status(sql,w);
      case 'sender.status':
      case 'sender.register':
      case 'sender.verify': {
        const input=commands[name].schema.parse(raw);
        await audienceBrand(sql,actor,input.brandId);
        if(name==='sender.register') return registerSender(sql,w,input.brandId,commands[name].schema.parse(raw).domain);
        return name==='sender.verify'?verifySender(sql,this.resolveTxt):senderStatus(sql);
      }
      case 'campaign.fromTemplate': {
        const {operationKey,brandId,templateId}=commands[name].schema.parse(raw);
        return this.perform('campaign.create',{operationKey,brandId,content:fromTemplateContent(templateId)},actor,sql);
      }
      case 'campaign.fromProduct': {
        const {operationKey,brandId,...product}=commands[name].schema.parse(raw);
        return this.perform('campaign.create',{operationKey,brandId,content:fromProductContent(product)},actor,sql);
      }
      case 'audience.previewImport': {
        const input=commands[name].schema.parse(raw);
        await audienceBrand(sql,actor,input.brandId);
        const preview = await previewImport(sql,input);
        return this.practiceImportsEnabled ? {...preview, practiceRowLimit: practiceImportRows} : preview;
      }
      case 'audience.applyPracticeImport': {
        return applyPracticeImport(sql,w,commands[name].schema.parse(raw));
      }
      case 'audience.exportPage': {
        const input=commands[name].schema.parse(raw);
        await audienceBrand(sql,actor,input.brandId);
        return exportPage(sql,input);
      }
      case 'rehearsal.methods': {
        const {brandId}=commands[name].schema.parse(raw);
        await audienceBrand(sql,actor,brandId);
        return {methods:await this.methods(sql,w,brandId,actor),...(unsubscribeProfile(this.marketing,{workspaceId:w,brandId}) ? {unsubscribeAvailable:true} : {})};
      }
      case 'rehearsal.review': {
        const input=commands[name].schema.parse(raw),draft=await campaign(sql,actor,input.campaignId);
        requireCondition(draft.brandId===input.brandId,404,'not_found','This campaign is unavailable for this brand.');
        await audienceBrand(sql,actor,input.brandId);
        requireCondition((await this.methods(sql,w,input.brandId,actor)).includes(input.transport??'capture'),422,'worker_not_configured','This rehearsal method is not configured for this brand.');
        const route=input.transport==='ses_simulator'?sesScope(this.ses,w,input.brandId)?.route:undefined;
        const binding=isListmonkMethod(input.transport)?this.listmonk?.binding(w,input.brandId,input.transport)??null:
          input.transport==='feedback_test'?localFeedbackBinding:route?.fingerprint??null;
        return reviewRehearsal(sql,actor,draft,input.expectedVersion,input.audience,input.dueAt,input.segmentId,input.transport,binding,input.includeUnsubscribe ? {settings:this.marketing} : undefined);
      }
      case 'rehearsal.approve': {
        const {brandId,id}=commands[name].schema.parse(raw);
        return approveRehearsal(sql,actor,brandId,id);
      }
      case 'rehearsal.process': {
        const {brandId,id}=commands[name].schema.parse(raw);
        const rehearsal=await rehearsalReport(sql,id);
        if(rehearsal.transport!=='capture')return {processingRequested:true};
        return processDue(sql,w,brandId,this.checkOwner,id);
      }
      case 'rehearsal.cancel': return cancelRehearsal(sql,commands[name].schema.parse(raw).id);
      case 'rehearsal.report':
      case 'rehearsal.outcomes':
      case 'rehearsal.message': {
        const {brandId,id}=commands[name].schema.parse(raw);
        await audienceBrand(sql,actor,brandId);
        await checkPracticeScope(sql,actor,id);
        if(name==='rehearsal.outcomes')return recipientOutcomes(sql,id);
        return name==='rehearsal.report'?rehearsalReport(sql,id):capturedMessage(sql,brandId,id);
      }
      case 'rehearsal.list': {
        const {brandId,campaignId}=commands[name].schema.parse(raw);
        await audienceBrand(sql,actor,brandId);
        const draft=await campaign(sql,actor,campaignId);
        requireCondition(draft.brandId===brandId,404,'not_found','This campaign is unavailable for this brand.');
        return listRehearsals(sql,campaignId,actor.kind==='session'||actor.scopes.includes('audience:summary'));
      }
      case 'campaign.get': return campaign(sql, actor, commands[name].schema.parse(raw).id);
      case 'campaign.create': {
        const input = commands[name].schema.parse(raw);
        await checkImages(sql, actor, input.brandId, input.content.assetIds);
        const count = await sql.query<{ count: string }>('SELECT count(*) FROM campaigns');
        requireCondition(Number(count.rows[0]?.count) < limits.drafts, 422, 'draft_limit', 'This foundation supports up to 100 drafts per workspace.');
        const content=input.content.studio ? withStudio(input.content,input.content.studio) : input.content;
        const rows = await sql.query<CampaignRow>('INSERT INTO campaigns(workspace_id,id,brand_id,content) VALUES($1,$2,$3,$4) RETURNING *', [w, randomUUID(), input.brandId, JSON.stringify(content)]);
        return campaignView(rows.rows[0]!);
      }
      case 'campaign.update': {
        const input = commands[name].schema.parse(raw);
        const current = await campaign(sql, actor, input.id);
        requireCondition(current.version === input.expectedVersion, 409, 'version_conflict', 'This draft changed since you opened it. Reload the saved version before saving again.');
        if(current.content.studio!==undefined){
          const problem=studioProblem(current.content.studio);
          requireCondition(!problem,409,'studio_unsupported',problem??'This saved Studio revision is unsupported.');
          requireCondition(input.content.studio,409,'studio_required','This draft uses Newsletter Studio. Preserve its full block document when editing.');
        }
        const content=input.content.studio ? withStudio(input.content,input.content.studio) : input.content;
        if(current.content.studio && input.content.studio){
          for(const field of ['heading','body','ctaLabel','ctaUrl'] as const)
            requireCondition(input.content[field]===current.content[field]||input.content[field]===content[field],422,'studio_projection','Edit headings, text and buttons in the Studio document.');
        }
        await checkImages(sql, actor, current.brandId, content.assetIds);
        const result = await sql.query<CampaignRow>('UPDATE campaigns SET content=$1,version=version+1,updated_at=now() WHERE id=$2 AND version=$3 RETURNING *', [JSON.stringify(content), input.id, input.expectedVersion]);
        requireCondition(result.rows[0], 409, 'version_conflict', 'This draft changed. Reload before saving.');
        await audienceBrand(sql,actor,current.brandId);
        await invalidateStudioReviews(sql,current.id,result.rows[0].version,!content.studio);
        return campaignView(result.rows[0]);
      }
      case 'campaign.preflight': {
        const draft = await campaign(sql, actor, commands[name].schema.parse(raw).id);
        const review = preflight(draft);
        const access=await workspaceAccess(sql);
        if(access.plan) review.gaps=review.gaps.filter(gap=>gap.code!=='entitlement_not_active');
        if (!(actor.kind==='session' && actor.owner) && !actor.scopes.includes('audience:summary')) return review;
        await audienceBrand(sql, actor, draft.brandId);
        const counts = await audienceSummary(sql);
        return { ...review, audience: { confirmed: counts.confirmed, excluded: counts.total - counts.confirmed } };
      }
      case 'campaign.preview': {
        const input = commands[name].schema.parse(raw);
        const current = await campaign(sql, actor, input.id);
        requireCondition(current.version === input.expectedVersion, 409, 'version_conflict', 'Reload the saved draft before previewing.');
        if(current.content.studio!==undefined){
          const issue=studioProblem(current.content.studio);
          requireCondition(!issue,422,'studio_unsupported',issue??'This saved Studio format is unsupported.');
        }
        const images = await sql.query<AssetRow>('SELECT name,mime,bytes,id FROM assets WHERE brand_id=$1 AND id=ANY($2::uuid[])', [current.brandId, current.content.assetIds]);
        const ordered = current.content.assetIds.map(id => images.rows.find(i => i.id === id));
        requireCondition(ordered.every(Boolean), 422, 'image_unavailable', 'A selected image is unavailable.');
        return renderPreview(current, ordered as AssetRow[]);
      }
      case 'asset.list': {
        const input = commands[name].schema.parse(raw);
        await brand(sql, actor, input.brandId);
        return (await sql.query<AssetRow>('SELECT id,name,mime,octet_length(bytes) AS size,width,height,sha256,created_at FROM assets WHERE brand_id=$1 ORDER BY created_at DESC', [input.brandId])).rows.map(assetView);
      }
      case 'asset.uploadBatch': {
        const input = commands[name].schema.parse(raw);
        await brand(sql, actor, input.brandId);
        const total = input.files.reduce((sum, f) => sum + Buffer.byteLength(f.base64, 'base64'), 0);
        requireCondition(total <= limits.batchBytes, 413, 'batch_limit', 'Choose no more than 20 MiB of images per batch.');
        const used = await sql.query<{ total: string; count: string }>('SELECT coalesce(sum(octet_length(bytes)),0) AS total,count(*) FROM assets');
        let storage = Number(used.rows[0]?.total);
        let imageCount = Number(used.rows[0]?.count);
        const results: unknown[] = [];
        for (const file of input.files) {
          try {
            const image = await inspectImage(file.base64);
            const existing = (await sql.query<AssetRow>('SELECT *,octet_length(bytes) AS size FROM assets WHERE brand_id=$1 AND item_key=$2', [input.brandId, file.itemKey])).rows[0];
            if (existing) {
              requireCondition(existing.sha256 === image.sha256 && existing.name === file.name, 409, 'item_conflict', 'This file key already identifies different bytes or a different name.');
              results.push({ itemKey: file.itemKey, ok: true, reused: true, asset: assetView(existing) });
              continue;
            }
            requireCondition(storage + image.bytes.length <= limits.workspaceBytes, 422, 'storage_limit', 'This workspace has reached its 100 MiB preparation media limit.');
            requireCondition(imageCount < limits.assets, 422, 'asset_limit', 'This foundation supports up to 500 images per workspace.');
            const rows = await sql.query<AssetRow>('INSERT INTO assets(workspace_id,id,brand_id,item_key,name,mime,bytes,sha256,width,height) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *,octet_length(bytes) AS size', [w, randomUUID(), input.brandId, file.itemKey, file.name, image.mime, image.bytes, image.sha256, image.width, image.height]);
            storage += image.bytes.length;
            imageCount++;
            results.push({ itemKey: file.itemKey, ok: true, reused: false, asset: assetView(rows.rows[0]!) });
          } catch (error) {
            if (!(error instanceof AppError)) throw error;
            results.push({ itemKey: file.itemKey, ok: false, error: { code: error.code, message: error.message } });
          }
        }
        return { results, storageBytes: storage, storageLimitBytes: limits.workspaceBytes };
      }
      case 'connection.list': return (await sql.query<ConnectionRow>('SELECT id,name,scopes,brand_ids,created_at,expires_at,revoked_at FROM connections ORDER BY created_at DESC LIMIT 100')).rows.map(connectionView);
      case 'segment.list': {
        const {brandId}=commands[name].schema.parse(raw); await audienceBrand(sql,actor,brandId);
        return listSegments(sql);
      }
      case 'segment.summary': {
        const {brandId,segmentId}=commands[name].schema.parse(raw); await audienceBrand(sql,actor,brandId);
        return segmentSummary(sql,segmentId);
      }
      case 'segment.create': {
        const {brandId,name:groupName}=commands[name].schema.parse(raw);
        return createSegment(sql,w,brandId,groupName);
      }
      case 'segment.rename': {
        const {segmentId,name:groupName}=commands[name].schema.parse(raw);
        return renameSegment(sql,segmentId,groupName);
      }
      case 'segment.delete': return deleteSegment(sql,commands[name].schema.parse(raw).segmentId);
      case 'segment.members': {
        const {brandId,segmentId,action,emails}=commands[name].schema.parse(raw);
        return updateSegmentMembers(sql,w,brandId,segmentId,action,emails);
      }
      case 'audience.summary': {
        await audienceBrand(sql, actor, commands[name].schema.parse(raw).brandId);
        return audienceSummary(sql);
      }
      case 'audience.list': {
        const input = commands[name].schema.parse(raw);
        await audienceBrand(sql, actor, input.brandId);
        return listContacts(sql, input);
      }
      case 'audience.contact': {
        const input = commands[name].schema.parse(raw);
        await audienceBrand(sql, actor, input.brandId);
        return contactDetail(sql, input.id, input.cursor);
      }
      case 'audience.unsubscribe':
        return unsubscribeContact(sql, commands[name].schema.parse(raw).id);
      case 'intake.status': {
        const input=commands[name].schema.parse(raw);
        await brand(sql,actor,input.brandId);
        return this.intake.status(sql,actor,input.brandId);
      }
      case 'intake.configure': {
        const input=commands[name].schema.parse(raw);
        await brand(sql,actor,input.brandId);
        return this.intake.configure(sql,actor,input.brandId,input.enabled);
      }
      case 'connection.create': {
        const input = commands[name].schema.parse(raw);
        requireCondition(!input.scopes.includes('campaign:simulate')||input.scopes.includes('campaign:rehearse'),422,'invalid_rehearsal_grant','Simulator access also requires campaign rehearsals and draft read access.');
        requireCondition(!input.scopes.includes('campaign:rehearse')||input.scopes.includes('read'),422,'invalid_rehearsal_grant','Select draft read access together with campaign rehearsals.');
        for (const id of input.brandIds) await brand(sql, actor, id);
        if (input.scopes.includes('subscriber:signup')) {
          requireCondition(input.scopes.length===1 && input.brandIds.length===1,422,'invalid_intake_grant','Use only subscriber signup access and exactly one brand.');
          const view=await this.intake.status(sql,actor,input.brandIds[0]!);
          requireCondition(view.enabled && view.ready,503,'intake_unavailable','Enable a ready brand intake policy before issuing this connection.');
        }
        const count = (await sql.query<{ count: string }>('SELECT count(*) FROM connections WHERE revoked_at IS NULL AND expires_at>now()')).rows[0];
        requireCondition(Number(count?.count) < limits.connections, 422, 'connection_limit', 'Revoke an unused connection before creating another. Maximum 10 active connections.');
        const token = `flk_${Buffer.from(w).toString('base64url')}.${randomBytes(32).toString('base64url')}`;
        const result = await sql.query<ConnectionRow>("INSERT INTO connections(workspace_id,id,name,issuer_id,token_hash,scopes,brand_ids,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+($8::integer * interval '1 day')) RETURNING id,name,scopes,brand_ids,created_at,expires_at,revoked_at", [w, randomUUID(), input.name, actor.userId, digest(token), [...new Set(input.scopes)], [...new Set(input.brandIds)], input.expiresInDays]);
        return { connection: connectionView(result.rows[0]!), token, secretAlreadyIssued: false };
      }
      case 'connection.revoke': {
        const input = commands[name].schema.parse(raw);
        const result = await sql.query('UPDATE connections SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 RETURNING id', [input.id]);
        requireCondition(result.rowCount, 404, 'not_found', 'This connection is unavailable.');
        return { revoked: true, id: input.id };
      }
    }
  }
  async readAsset(actor: Actor, id: string) {
    authorize(actor, 'asset.list');
    return this.db.tenant(actor.workspaceId, async sql => {
      const row = (await sql.query<AssetRow & { brand_id: string }>('SELECT * FROM assets WHERE id=$1', [id])).rows[0];
      requireCondition(row, 404, 'not_found', 'This image is unavailable.');
      assertBrand(actor, row.brand_id);
      return row;
    });
  }
}
