import { randomUUID } from 'node:crypto';
import type { Sql } from './db.js';
import { workspaceAccess } from './campaign/access.js';
import { requireCondition } from './errors.js';
import { plans } from '../shared/contracts.js';
import type { Company, CompanyDirectory } from '../shared/companies.js';
import { customerEligibility, type BillingOptions } from './customer-billing/service.js';

async function companyPlan(sql: Sql, options?: Partial<BillingOptions>) {
  if (options) {
    const workspace = (
      await sql.query<{ workspace: string }>("SELECT current_setting('app.workspace_id',true) workspace")
    ).rows[0]?.workspace;
    if (workspace) {
      const status = await customerEligibility(sql, workspace, options);
      if (status.eligible && status.limits)
        return {
          name: plans.find((item) => item.id === status.plan)?.name ?? 'Preparation',
          companies: status.limits.companies,
          brands: status.limits.brands,
        };
    }
    return { name: 'Preparation', companies: 1, brands: 1 };
  }
  const access = await workspaceAccess(sql);
  const plan = plans.find((item) => item.id === access.plan);
  return { name: plan?.name ?? 'Preparation', companies: plan?.companies ?? 1, brands: plan?.brands ?? 1 };
}

export async function companyDirectory(
  sql: Sql,
  options?: Partial<BillingOptions>,
): Promise<CompanyDirectory> {
  const plan = await companyPlan(sql, options);
  const { rows } = await sql.query<{
    company_id: string;
    company_name: string;
    is_default: boolean;
    brand_id: string | null;
    brand_name: string | null;
  }>(`
    SELECT c.id AS company_id, c.name AS company_name, c.is_default, b.id AS brand_id, b.name AS brand_name
    FROM companies c
    LEFT JOIN company_brands membership ON membership.workspace_id=c.workspace_id AND membership.company_id=c.id
    LEFT JOIN brands b ON b.workspace_id=membership.workspace_id AND b.id=membership.brand_id
    ORDER BY c.is_default DESC,lower(c.name),c.id,lower(b.name),b.id`);
  const companies = new Map<string, Company>();
  let brandCount = 0;
  for (const row of rows) {
    let company = companies.get(row.company_id);
    if (!company) {
      company = { id: row.company_id, name: row.company_name, isDefault: row.is_default, brands: [] };
      companies.set(company.id, company);
    }
    if (row.brand_id && row.brand_name !== null) {
      company.brands.push({ id: row.brand_id, name: row.brand_name });
      brandCount++;
    }
  }
  return {
    companies: [...companies.values()],
    brandCount,
    limits: { companies: plan.companies, brands: plan.brands },
    planName: plan.name,
  };
}

type Table = 'companies' | 'brands';
const entity = { companies: 'company', brands: 'brand' } as const;
async function requireRecord(sql: Sql, table: Table, id: string) {
  const found = await sql.query('SELECT id FROM ' + table + ' WHERE id=$1', [id]);
  requireCondition(
    found.rowCount,
    404,
    entity[table] + '_unavailable',
    'This ' + entity[table] + ' is unavailable in this workspace.',
  );
}
async function availableName(sql: Sql, table: Table, name: string, exceptId: string | null = null) {
  const used = await sql.query(
    'SELECT id FROM ' +
      table +
      ' WHERE lower(btrim(name))=lower(btrim($1)) AND ($2::uuid IS NULL OR id<>$2) LIMIT 1',
    [name, exceptId],
  );
  requireCondition(
    !used.rowCount,
    409,
    'name_in_use',
    'A ' + entity[table] + ' in this workspace already uses that name.',
  );
}
// All command mutations and complimentary plan changes hold the same workspace advisory lock.
async function requireCapacity(sql: Sql, table: Table, options?: Partial<BillingOptions>) {
  const plan = await companyPlan(sql, options);
  const { rows } = await sql.query<{ total: number }>('SELECT count(*)::int AS total FROM ' + table);
  requireCondition(
    rows[0]!.total < plan[table],
    422,
    entity[table] + '_limit',
    'This workspace has reached its ' + entity[table] + ' limit of ' + plan[table] + '.',
  );
}
export async function createCompany(
  sql: Sql,
  workspaceId: string,
  name: string,
  options?: Partial<BillingOptions>,
) {
  await availableName(sql, 'companies', name);
  await requireCapacity(sql, 'companies', options);
  const id = randomUUID();
  await sql.query('INSERT INTO companies(workspace_id,id,name) VALUES($1,$2,$3)', [workspaceId, id, name]);
  return { id, name };
}
export async function renameCompany(sql: Sql, id: string, name: string) {
  await requireRecord(sql, 'companies', id);
  await availableName(sql, 'companies', name, id);
  await sql.query('UPDATE companies SET name=$2 WHERE id=$1', [id, name]);
  return { id, name };
}
export async function createBrand(
  sql: Sql,
  workspaceId: string,
  companyId: string,
  name: string,
  options?: Partial<BillingOptions>,
) {
  await requireRecord(sql, 'companies', companyId);
  await availableName(sql, 'brands', name);
  await requireCapacity(sql, 'brands', options);
  const id = randomUUID();
  await sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [workspaceId, id, name]);
  // The insert first associates the brand with the default company for backward compatibility.
  await sql.query('UPDATE company_brands SET company_id=$2 WHERE brand_id=$1', [id, companyId]);
  return { id, companyId, name };
}
export async function renameBrand(sql: Sql, id: string, name: string) {
  await requireRecord(sql, 'brands', id);
  await availableName(sql, 'brands', name, id);
  await sql.query('UPDATE brands SET name=$2 WHERE id=$1', [id, name]);
  return { id, name };
}
export async function moveBrand(sql: Sql, id: string, companyId: string) {
  await requireRecord(sql, 'companies', companyId);
  const moved = await sql.query(
    'UPDATE company_brands SET company_id=$2 WHERE brand_id=$1 RETURNING brand_id',
    [id, companyId],
  );
  requireCondition(moved.rowCount, 404, 'brand_unavailable', 'This brand is unavailable in this workspace.');
  return { id, companyId };
}
