import { z } from 'zod';
import { commandDefinition } from './command-definition.js';

export const customerOperationsCommands = {
  'operations.status': commandDefinition('Inspect customer workflow health and explicit activation gaps.', 'owner', false, {}),
  'operations.process': commandDefinition('Wake this workspace’s durable queues and process one bounded pass.', 'owner', true, { operationKey:z.uuid() }),
};
export type CustomerOperationsStatus = {
  environment:string;
  exercise:boolean;
  worker:{running:boolean;dedicated:boolean;lastPass:string|null;lastFailure:string|null;
    localProcessRunning?:boolean;heartbeat?:CustomerWorkerHeartbeat};
  modes:{billing:string;delivery:string;deliveryScope?:'all'|'tests';audience:string;team:string;support:string;retention:string;infrastructure?:string};
  preparation?:CustomerPreparationCheck[];
  gaps:{area:string;code:string;detail:string}[];
  queue:{delivery:number;confirmations:number;team:number;support:number;retention:number;unknown:number;infrastructure?:number};
  safeguards:{externalDelivery:boolean;testDelivery?:boolean;realCharges:boolean;hostedErasure:false;openTracking:false;clickTracking:false};
};
export type CustomerWorkerHeartbeat = {
  kind:'embedded'|'dedicated';state:'fresh'|'stale'|'unknown'|'stopped';
  observedAt:string;startedAt:string|null;lastHeartbeat:string|null;stoppedAt:string|null;freshnessSeconds:number;
};

/** Recorded settings are not provider verification, launch approval or customer eligibility. */
export type CustomerPreparationCheck = {
  area:string;
  state:'settings_recorded'|'settings_missing'|'settings_invalid';
  detail:string;
};
