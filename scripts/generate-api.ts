import { mkdir, writeFile } from 'node:fs/promises';
import { commands } from '../src/shared/contracts.js';
import { intakeKey, signupInput, signupAccepted } from '../src/shared/subscriber.js';

const paths = Object.fromEntries(Object.entries(commands).map(([name, command]) => [`/api/v1/commands/${name}`, { post: {
  operationId: name.replace('.', '_'), summary: command.description,
  security: [{ bearerAuth: [] }], 'x-required-scope': command.scope, 'x-mutates': command.mutation,
  requestBody: { required: true, content: { 'application/json': { schema: command.schema.toJSONSchema() } } },
  responses: { '200': { description: 'Command result in a result envelope. Batch results include per-item failures.' }, '401': { description: 'Invalid, expired or revoked authentication.' }, '403': { description: 'Missing scope, owner membership or permitted browser origin.' }, '404': { description: 'Unavailable command or scoped resource.' }, '409': { description: 'Operation-key or draft-version conflict.' }, '413': { description: 'Request or batch too large.' }, '422': { description: 'Input or preparation limit failure; all schema issues are returned.' }, '429': { description: 'Rate or concurrency limit; retry with the same operation keys.' }, '503': { description: 'Required configuration or current membership verification unavailable.' } },
} }]));
await mkdir('docs/api', { recursive: true });
const signupPath = { post: {
  operationId:'subscriber_signup',summary:'Accept an attested first-party signup for one configured brand.',
  security:[{bearerAuth:[]}], 'x-required-scope':'subscriber:signup',
  parameters:[{in:'path',name:'brandId',required:true,schema:{type:'string',format:'uuid'}},
    {in:'header',name:'Idempotency-Key',required:true,schema:intakeKey.toJSONSchema()}],
  requestBody:{required:true,content:{'application/json':{schema:signupInput.toJSONSchema({io:'input'})}}},
  responses:{'202':{description:'Durably accepted without disclosing subscriber status.',content:{'application/json':{example:signupAccepted}}},
    '400':{description:'Malformed JSON.'},'401':{description:'Invalid or expired credential.'},'403':{description:'Server client or scope required.'},
    '404':{description:'Unavailable brand.'},'409':{description:'Operation key reused with different input.'},
    '413':{description:'Body exceeds 8 KiB.'},'415':{description:'Unsupported content type.'},'422':{description:'Invalid consent or input.'},
    '429':{description:'Rate limited.'},'503':{description:'Intake or its confirmation worker is unavailable.'}},
} };
await writeFile('docs/api/openapi.json', JSON.stringify({ openapi:'3.1.0',info:{title:'Flockletter API',version:'0.2.0',
  description:'Campaign preparation and separately gated first-party subscriber intake. Generated from canonical schemas.'},
  paths:{...paths,'/api/v1/brands/{brandId}/subscriber-signups':signupPath},components:{securitySchemes:{bearerAuth:{type:'http',scheme:'bearer',
    description:'Use only a single-brand signup connection for subscriber intake. Owner-only commands require a Clerk owner session.'}}}},null,2)+'\n');
