import { mkdir, writeFile } from 'node:fs/promises';
import { commands } from '../src/shared/contracts.js';

const paths = Object.fromEntries(Object.entries(commands).map(([name, command]) => [`/api/v1/commands/${name}`, { post: {
  operationId: name.replace('.', '_'), summary: command.description,
  security: [{ bearerAuth: [] }], 'x-required-scope': command.scope, 'x-mutates': command.mutation,
  requestBody: { required: true, content: { 'application/json': { schema: command.schema.toJSONSchema() } } },
  responses: { '200': { description: 'Command result in a result envelope. Batch results include per-item failures.' }, '401': { description: 'Invalid, expired or revoked authentication.' }, '403': { description: 'Missing scope, owner membership or permitted browser origin.' }, '404': { description: 'Unavailable command or scoped resource.' }, '409': { description: 'Operation-key or draft-version conflict.' }, '413': { description: 'Request or batch too large.' }, '422': { description: 'Input or preparation limit failure; all schema issues are returned.' }, '429': { description: 'Rate or concurrency limit; retry with the same operation keys.' }, '503': { description: 'Required configuration or current membership verification unavailable.' } },
} }]));
await mkdir('docs/api', { recursive: true });
await writeFile('docs/api/openapi.json', JSON.stringify({ openapi: '3.1.0', info: { title: 'Flockletter preparation API', version: '0.1.0', description: 'Foundation only. No send, payment or subscriber operations. Generated from canonical command schemas.' }, paths, components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'A Clerk session token, or an owner-issued scoped Flockletter connection token. Connection tokens cannot invoke owner-only commands.' } } } }, null, 2) + '\n');
