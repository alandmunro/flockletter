import type { Sql } from '../db.js';

export async function coversTextCompany(sql: Sql, companyId: string, brandIds: string[] | null) {
  if (brandIds === null) return true;
  const { rows } = await sql.query<{ brand_id: string }>(
    'SELECT brand_id FROM company_brands WHERE company_id=$1', [companyId],
  );
  return rows.length > 0 && rows.every(({ brand_id }) => brandIds.includes(brand_id));
}
