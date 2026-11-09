export const releaseOperations:Readonly<Record<string,Readonly<{environment:string;mode:string;database:string;runtimeRole:string;migrationRole:string}>>>;
export function isRecord(value:unknown):value is Record<string,unknown>;
export function sourceMatchesEnvironment(source:unknown,environment:string):boolean;
export function validReleaseHost(host:unknown):boolean;
export function parseReleaseConnection(value:unknown):URL|undefined;
export function releaseInputPreflight(operation:string,input:unknown,environment:string|undefined):string[];
export function refuseReleaseInput(codes:string[]):never;
