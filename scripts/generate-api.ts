import { mkdir, writeFile } from 'node:fs/promises';
import { platformCommands } from '../src/shared/platform.js';
import { commands } from '../src/shared/contracts.js';
import { intakeKey, signupInput, signupAccepted } from '../src/shared/subscriber.js';

const paths = Object.fromEntries(Object.entries(commands).map(([name, command]) => [`/api/v1/commands/${name}`, { post: {
  operationId: name.replace('.', '_'), summary: command.description,
  security: [{ bearerAuth: [] }], 'x-required-scope': command.scope, 'x-mutates': command.mutation,
  requestBody: { required: true, content: { 'application/json': { schema: command.schema.toJSONSchema({io:'input'}) } } },
  responses: { '200': { description: 'Command result in a result envelope. Batch results include per-item failures.' }, '401': { description: 'Invalid, expired or revoked authentication.' }, '403': { description: 'Missing scope, owner membership or permitted browser origin.' }, '404': { description: 'Unavailable command or scoped resource.' }, '409': { description: 'Operation-key or draft-version conflict.' }, '413': { description: 'Request or batch too large.' }, '422': { description: 'Input or preparation limit failure; all schema issues are returned.' }, '429': { description: 'Rate or concurrency limit; retry with the same operation keys.' }, '503': { description: 'Required configuration or current membership verification unavailable.' } },
} }]));
await mkdir('docs/api', { recursive: true });
const signupPath = { head: {
  operationId:'subscriber_intake_readiness',summary:'Check one brand and source without submitting a signup.',
  security:[{bearerAuth:[]}], 'x-required-scope':'subscriber:signup',
  parameters:[{in:'path',name:'brandId',required:true,schema:{type:'string',format:'uuid'}},
    {in:'header',name:'X-Flockletter-Source-Domain',required:true,schema:{type:'string'}}],
  responses:{'204':{description:'Ready for this source.',headers:{'X-Flockletter-Confirmation-Mode':{schema:{type:'string',enum:['capture','live']}}}},
    '401':{description:'Invalid or revoked credential.'},'403':{description:'Invalid client or scope.'},'404':{description:'Unavailable brand.'},
    '429':{description:'Probe rate limit.'},'503':{description:'Brand, source or confirmation worker is unavailable.'}},
}, post: {
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
const identityPath={get:{operationId:'connection_identity',summary:'Inspect this preparation connection’s own identity and brands.',security:[{bearerAuth:[]}],responses:{
  '200':{description:'Connection id, workspaceId, brandIds and scopes. No contact or token material.'},'401':{description:'Connection expired or revoked.'},'403':{description:'Requires a current preparation connection and issuer membership.'}}}};
const billingEventsPath={post:{operationId:'billing_stripe_events',summary:'Receive signed events for the separately configured Stripe sandbox.',
  parameters:[{in:'header',name:'Stripe-Signature',required:true,schema:{type:'string'}}],requestBody:{required:true,content:{'application/json':{schema:{type:'object'}}}},
  responses:{'200':{description:'Receipt acknowledged.'},'400':{description:'Invalid signature or wrong environment.'},'503':{description:'Sandbox unavailable or provider reconciliation pending.'}}}};
const optOutForm = {schema:{type:'object',additionalProperties:false,required:['List-Unsubscribe'],
  properties:{'List-Unsubscribe':{type:'string',const:'One-Click'}}}};
const marketingUnsubscribePath = {
  parameters:[{in:'query',name:'t',required:true,description:'Opaque per-recipient capability. Keep the query out of logs.',schema:{type:'string',maxLength:128}}],
  get:{operationId:'marketing_unsubscribe_form',summary:'Read an intentional unsubscribe form without changing state.',security:[],
    responses:{'200':{description:'Login-free confirmation form.'},'403':{description:'Wrong host or transport.'}}},
  post:{operationId:'marketing_unsubscribe',summary:'Honor the recipient’s opt-out for the issuing brand. Replays have the same result.',security:[],
    requestBody:{required:true,content:{'application/x-www-form-urlencoded':optOutForm,'multipart/form-data':optOutForm}},
    responses:{'200':{description:'Generic receipt for an attended same-origin submission.'},'204':{description:'Generic one-click acknowledgment.'},
      '400':{description:'Invalid form.'},'403':{description:'Disallowed browser origin, context, host or transport.'},
      '413':{description:'Form exceeds 4 KiB.'},'415':{description:'Unsupported media type or compression.'},'503':{description:'Opt-out service temporarily unavailable.'}}},
};
await writeFile('docs/api/openapi.json', JSON.stringify({ openapi:'3.1.0',info:{title:'Flockletter API',version:'0.3.0',
  description:'Campaign authoring, rehearsals, audience workflows, and separately gated subscriber intake and sandbox billing. Generated from canonical schemas.'},
  paths:{...Object.fromEntries(Object.entries(platformCommands).map(([name,c])=>['/api/operator/v1/commands/'+name,{post:{operationId:name.replace('.','_'),summary:c.description,security:[{operatorSession:[]}],'x-operator-mfa-required':true,'x-mutates':c.mutation,requestBody:{required:true,content:{'application/json':{schema:c.schema.toJSONSchema({io:'input'})}}},responses:{'200':{description:'Exact case-scoped operator result.'},'403':{description:'Separate operator organization, named membership, recent two-factor verification and exact case required.'},'409':{description:'Changed action, version, review or protected evidence.'},'503':{description:'Required protected operator configuration is missing.'}}}}])),...paths,'/api/v1/brands/{brandId}/subscriber-signups':signupPath,'/api/v1/connection/identity':identityPath,'/api/v1/billing/stripe-events':billingEventsPath,'/mail/unsubscribe':marketingUnsubscribePath},components:{securitySchemes:{operatorSession:{type:'http',scheme:'bearer',description:'Short-lived Clerk session in the separate named operator organization, both factors verified within five minutes. Customer connections never grant operator authority.'},bearerAuth:{type:'http',scheme:'bearer',
    description:'Use only a single-brand signup connection for subscriber intake. Owner-only commands require a Clerk owner session.'}}}},null,2)+'\n');
