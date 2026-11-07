import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { apiCaller, createMcpServer } from './bridge.js';

const origin = process.env.FLOCKLETTER_API_ORIGIN;
const token = process.env.FLOCKLETTER_API_TOKEN;
if (!origin || !token) throw new Error('Set FLOCKLETTER_API_ORIGIN and FLOCKLETTER_API_TOKEN in the MCP host environment.');
await createMcpServer(apiCaller(origin, token), process.env.FLOCKLETTER_ASSET_ROOT).connect(new StdioServerTransport());
