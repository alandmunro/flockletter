import { randomBytes, randomUUID } from 'node:crypto';
import { commands, limits, plans, type AssetSummary, type Campaign, type CampaignContent, type Capability, type CommandName, type Connection } from '../shared/contracts.js';
import { Database, type Sql } from './db.js';
import { AppError, requireCondition } from './errors.js';
import { deliveryGaps, digest, inspectImage, preflight, renderPreview } from './content.js';
import { SubscriberIntake } from './subscribers/intake.js';

export type Actor = { workspaceId: string; userId: string; actorId: string; owner: boolean; kind: 'session' | 'connection'; scopes: Capability[]; brandIds: string[] | null };
type CampaignRow = { id: string; brand_id: string; version: number; content: CampaignContent; created_at: Date; updated_at: Date };
type AssetRow = { id: string; name: string; mime: string; size: number; width: number; height: number; sha256: string; created_at: Date; bytes: Buffer };
type ConnectionRow = { id: string; name: string; scopes: Capability[]; brand_ids: string[]; created_at: Date; expires_at: Date; revoked_at: Date | null };
const campaignView = (row: CampaignRow): Campaign => ({ id: row.id, brandId: row.brand_id, version: row.version, content: row.content, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), status: 'draft' });
const assetView = (row: AssetRow): AssetSummary => ({ id: row.id, name: row.name, mime: row.mime, size: row.size, width: row.width, height: row.height, sha256: row.sha256, createdAt: row.created_at.toISOString() });
const connectionView = (row: ConnectionRow): Connection => ({ id: row.id, name: row.name, scopes: row.scopes, brandIds: row.brand_ids, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null });

export function authorize(actor: Actor, name: CommandName) {
  const scope = commands[name].scope;
  if (scope === 'owner') requireCondition(actor.kind === 'session' && actor.owner, 403, 'owner_required', 'Use a current workspace owner session for this action.');
  else requireCondition(actor.owner && (actor.kind === 'session' || actor.scopes.includes(scope)), 403, 'scope_required', `This action requires ${scope} access. Current owners can grant the needed scopes together in Connections.`);
}
function assertBrand(actor: Actor, brandId: string) { requireCondition(actor.brandIds === null || actor.brandIds.includes(brandId), 404, 'not_found', 'The requested item is unavailable in this workspace or connection.'); }
async function brand(sql: Sql, actor: Actor, id: string) {
  assertBrand(actor, id);
  const found = await sql.query('SELECT id FROM brands WHERE id=$1', [id]);
  requireCondition(found.rowCount, 404, 'not_found', 'This brand is unavailable.');
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
  constructor(readonly db: Database, readonly intake = new SubscriberIntake(db)) {}
  async execute(name: CommandName, raw: unknown, actor: Actor): Promise<unknown> {
    authorize(actor, name);
    const definition = commands[name];
    const input = definition.schema.parse(raw);
    return this.db.tenant(actor.workspaceId, async sql => {
      let requestHash = '';
      let operationKey = '';
      if (definition.mutation) {
        await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [actor.workspaceId]);
        operationKey = (input as { operationKey: string }).operationKey;
        requestHash = digest(JSON.stringify({ name, input }));
        const prior = await sql.query<{ request_hash: string; result: unknown }>('SELECT request_hash,result FROM operations WHERE actor_id=$1 AND operation_key=$2', [actor.actorId, operationKey]);
        if (prior.rows[0]) {
          requireCondition(prior.rows[0].request_hash === requestHash, 409, 'operation_conflict', 'This operation key was already used for different input. Retry the original request or use a new key.');
          return prior.rows[0].result;
        }
        const disablingIntake = name === 'intake.configure' && 'enabled' in input && input.enabled === false;
        if (name !== 'connection.revoke' && !disablingIntake) {
          const count = (await sql.query<{ count: string }>('SELECT count(*) FROM operations')).rows[0];
          requireCondition(Number(count?.count) < limits.preparationOperations, 422, 'preparation_limit', 'This foundation workspace has reached its preparation operation limit. Contact the operator; connection revocation remains available.');
        }
      }
      const result = await this.perform(name, raw, actor, sql);
      if (definition.mutation) {
        // Connection secrets are returned once, never persisted in replay records or audit.
        const stored = name === 'connection.create' ? { ...(result as Record<string, unknown>), token: undefined, secretAlreadyIssued: true } : result;
        await sql.query('INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result) VALUES($1,$2,$3,$4,$5)', [actor.workspaceId, actor.actorId, operationKey, requestHash, JSON.stringify(stored)]);
        await sql.query('INSERT INTO audit(workspace_id,id,actor_id,action) VALUES($1,$2,$3,$4)', [actor.workspaceId, randomUUID(), actor.actorId, name]);
      }
      return result;
    });
  }
  private async perform(name: CommandName, raw: unknown, actor: Actor, sql: Sql): Promise<unknown> {
    const w = actor.workspaceId;
    switch (name) {
      case 'workspace.preflight': {
        const initialized = Boolean((await sql.query('SELECT workspace_id FROM workspaces')).rowCount);
        return { initialized, canPrepare: initialized, canSend: false, scopes: actor.scopes, brandIds: actor.brandIds, limits, gaps: [...(!initialized ? [{ code: 'workspace_not_initialized', title: 'Name your workspace and first brand', detail: 'A workspace owner must complete setup in the dashboard.' }] : []), ...deliveryGaps()] };
      }
      case 'workspace.get': {
        const workspace = (await sql.query<{ name: string }>('SELECT name FROM workspaces')).rows[0];
        if (!workspace) return null;
        const brands = (await sql.query<{ id: string; name: string }>('SELECT id,name FROM brands ORDER BY name')).rows.filter(b => actor.brandIds === null || actor.brandIds.includes(b.id));
        return { name: workspace.name, brands, entitlement: 'not_activated', canManageConnections: actor.kind === 'session' && actor.owner, preparationLimits: limits, plans };
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
      case 'campaign.get': return campaign(sql, actor, commands[name].schema.parse(raw).id);
      case 'campaign.create': {
        const input = commands[name].schema.parse(raw);
        await checkImages(sql, actor, input.brandId, input.content.assetIds);
        const count = await sql.query<{ count: string }>('SELECT count(*) FROM campaigns');
        requireCondition(Number(count.rows[0]?.count) < limits.drafts, 422, 'draft_limit', 'This foundation supports up to 100 drafts per workspace.');
        const rows = await sql.query<CampaignRow>('INSERT INTO campaigns(workspace_id,id,brand_id,content) VALUES($1,$2,$3,$4) RETURNING *', [w, randomUUID(), input.brandId, JSON.stringify(input.content)]);
        return campaignView(rows.rows[0]!);
      }
      case 'campaign.update': {
        const input = commands[name].schema.parse(raw);
        const current = await campaign(sql, actor, input.id);
        requireCondition(current.version === input.expectedVersion, 409, 'version_conflict', 'This draft changed since you opened it. Reload the saved version before saving again.');
        await checkImages(sql, actor, current.brandId, input.content.assetIds);
        const result = await sql.query<CampaignRow>('UPDATE campaigns SET content=$1,version=version+1,updated_at=now() WHERE id=$2 AND version=$3 RETURNING *', [JSON.stringify(input.content), input.id, input.expectedVersion]);
        requireCondition(result.rows[0], 409, 'version_conflict', 'This draft changed. Reload before saving.');
        return campaignView(result.rows[0]);
      }
      case 'campaign.preflight': return preflight(await campaign(sql, actor, commands[name].schema.parse(raw).id));
      case 'campaign.preview': {
        const input = commands[name].schema.parse(raw);
        const current = await campaign(sql, actor, input.id);
        requireCondition(current.version === input.expectedVersion, 409, 'version_conflict', 'Reload the saved draft before previewing.');
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
