import type { Client } from 'pg';
export function applyMigrations(client: Client, role: string): Promise<void>;
