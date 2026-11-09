// MCP server: lets any MCP client (Claude Desktop, Claude Code, Cursor, ...)
// shop the PayGuard marketplace with the demo agent's key. Every payment goes
// through the on-chain rules and escrow, whatever the model decides.
//
//   claude mcp add payguard -- pnpm --dir /path/to/PayGuard mcp
import { PublicKey } from "@solana/web3.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PayGuardAgent, explorerTx } from "@payguard/sdk";
import { connection, loadConfig, loadKey } from "../server/env.js";

const cfg = loadConfig();
const vault = new PublicKey(process.env.PAYGUARD_VAULT ?? cfg.vault);
const agent = new PayGuardAgent({ connection, agent: loadKey("agent"), vault, decimals: cfg.decimals, responseTimeoutMs: 12_000 });

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });

const server = new McpServer({ name: "payguard", version: "0.1.0" });

server.registerTool(
  "search_vendors",
  {
    description: "Search the PayGuard marketplace of paid APIs. Returns url, price per call (dUSDC), on-chain reputation and whether your owner approved the vendor.",
    inputSchema: { query: z.string().optional().describe("Words to match in the vendor name or URL") },
  },
  async ({ query }) => text(await agent.searchVendors(query ?? "")),
);

server.registerTool(
  "buy",
  {
    description:
      "GET a paid API URL. Pays the x402 invoice into an on-chain escrow, checks the response against the vendor's receipt, then accepts or disputes. Returns the data and what happened to the money.",
    inputSchema: { url: z.string().url() },
  },
  async ({ url }) => {
    const r = await agent.fetch(url);
    const p = r.payment;
    return text({
      status: r.status,
      payment: p && { ...p, explorer: p.signatures.map(explorerTx) },
      data: (() => {
        try {
          return JSON.parse(r.body);
        } catch {
          return r.body.slice(0, 4000);
        }
      })(),
    });
  },
);

server.registerTool(
  "budget_status",
  { description: "Spending limits set by your owner on-chain, and what is left today.", inputSchema: {} },
  async () => text(await agent.budget()),
);

await server.connect(new StdioServerTransport());
