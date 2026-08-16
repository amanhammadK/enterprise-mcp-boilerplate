import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { healthCheck, getConfig, setConfig, logAudit, listServices } from "./tools/enterprise_mcp_boilerplate.js";

const server = new Server(
  { name: "enterprise-mcp-boilerplate", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "health_check", description: "Check server health, uptime, and memory usage", inputSchema: { type: "object", properties: {} } },
    { name: "get_config", description: "Get a configuration value by key", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
    { name: "set_config", description: "Set a configuration value", inputSchema: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] } },
    { name: "log_audit", description: "Log an audit event", inputSchema: { type: "object", properties: { action: { type: "string" }, resource: { type: "string" }, details: { type: "string" } }, required: ["action", "resource"] } },
    { name: "list_services", description: "List registered services", inputSchema: { type: "object", properties: {} } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    let result;
    switch (name) {
      case "health_check": result = await healthCheck(); break;
      case "get_config": result = await getConfig((args as any).key); break;
      case "set_config": result = await setConfig((args as any).key, (args as any).value); break;
      case "log_audit": result = await logAudit((args as any).action, (args as any).resource, (args as any).details); break;
      case "list_services": result = await listServices(); break;
      default: return { content: [{ type: "text", text: "Unknown tool: " + name }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: "Error: " + e.message }] };
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("enterprise-mcp-boilerplate running on stdio");
}
run().catch(console.error);
