import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { healthCheck, getConfig, setConfig, logAudit, listServices, getAuditLog } from "./tools/enterprise_mcp_boilerplate.js";

const server = new Server(
  { name: "enterprise-mcp-boilerplate", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler("list_tools", async () => ({
  tools: [
    {
      name: "health_check",
      description: "Check server health, uptime, and memory usage",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_config",
      description: "Get a configuration value by key",
      inputSchema: {
        type: "object",
        properties: { key: { type: "string", description: "Configuration key" } },
        required: ["key"],
      },
    },
    {
      name: "set_config",
      description: "Set a configuration value",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string" },
          value: { type: "string" },
        },
        required: ["key", "value"],
      },
    },
    {
      name: "log_audit",
      description: "Log an audit event",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "Action performed" },
          resource: { type: "string", description: "Resource affected" },
          details: { type: "string", description: "Additional details" },
        },
        required: ["action", "resource"],
      },
    },
    {
      name: "list_services",
      description: "List registered services and their status",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_audit_log",
      description: "Retrieve recent audit log entries",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number", default: 50 } },
      },
    },
  ],
}));

server.setRequestHandler("call_tool", async (request) => {
  const { name, arguments: args } = request.params;
  switch (name) {
    case "health_check":
      return { content: [{ type: "text", text: JSON.stringify(await healthCheck(), null, 2) }] };
    case "get_config":
      return { content: [{ type: "text", text: JSON.stringify(await getConfig(args.key), null, 2) }] };
    case "set_config":
      return { content: [{ type: "text", text: JSON.stringify(await setConfig(args.key, args.value), null, 2) }] };
    case "log_audit":
      return { content: [{ type: "text", text: JSON.stringify(await logAudit(args.action, args.resource, args.details), null, 2) }] };
    case "list_services":
      return { content: [{ type: "text", text: JSON.stringify(await listServices(), null, 2) }] };
    case "get_audit_log":
      return { content: [{ type: "text", text: JSON.stringify(await getAuditLog(args.limit), null, 2) }] };
    default:
      throw new Error("Unknown tool: " + name);
  }
});

export { server };
