import { z } from 'zod';
import { commandDefinition } from './command-definition.js';

export const customerOperationsCommands = {
  'operations.status': commandDefinition('Inspect customer workflow health and explicit activation gaps.', 'owner', false, {}),
  'operations.process': commandDefinition('Wake this workspace’s durable queues and process one bounded pass.', 'owner', true, { operationKey:z.uuid() }),
};
export type CustomerOperationsStatus = {
  environment:string;
  exercise:boolean;
  worker:{running:boolean;dedicated:boolean;lastPass:string|null;lastFailure:string|null};
  modes:{billing:string;delivery:string;audience:string;team:string;support:string;retention:string;infrastructure?:string};
  gaps:{area:string;code:string;detail:string}[];
  queue:{delivery:number;confirmations:number;team:number;support:number;retention:number;unknown:number;infrastructure?:number};
  safeguards:{externalDelivery:boolean;realCharges:boolean;hostedErasure:false;openTracking:false;clickTracking:false};
};
