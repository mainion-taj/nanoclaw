/**
 * A2A MCP Server — stdio transport
 *
 * Exposes A2A (Agent-to-Agent Protocol) tools to the Claude agent session.
 * Replaces agent-mailbox MCP tools with structured A2A task exchange.
 *
 * Spawned by agent-runner alongside the IPC MCP server.
 * Communicates with peer A2A servers via HTTP using @a2a-js/sdk client.
 *
 * Environment variables:
 *   A2A_PEERS        — comma-separated peer A2A server URLs
 *   A2A_AUTH_TOKEN    — bearer token for authentication
 *   A2A_AGENT_NAME    — this agent's display name
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import crypto from 'crypto';

// --- Config from env ---
const PEERS = (process.env.A2A_PEERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const AUTH_TOKEN = process.env.A2A_AUTH_TOKEN || '';
const AGENT_NAME = process.env.A2A_AGENT_NAME || 'agent';

// --- Types ---
interface AgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  skills?: Array<{ id: string; name: string; description: string; tags?: string[] }>;
  [key: string]: unknown;
}

interface TaskResponse {
  id: string;
  contextId: string;
  status: { state: string; timestamp?: string; message?: { role: string; parts: Array<{ kind: string; text?: string }> } };
  artifacts?: Array<{ parts: Array<{ kind: string; text?: string }> }>;
  [key: string]: unknown;
}

// --- HTTP helpers ---
async function a2aFetch(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (AUTH_TOKEN) headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;

  const opts: RequestInit = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

/** JSON-RPC 2.0 call to an A2A server */
async function jsonRpc(
  baseUrl: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const body = {
    jsonrpc: '2.0',
    id: crypto.randomUUID(),
    method,
    params,
  };
  const result = (await a2aFetch(baseUrl, 'POST', '/', body)) as {
    result?: unknown;
    error?: { code: number; message: string };
  };
  if (result.error) {
    throw new Error(`A2A RPC error ${result.error.code}: ${result.error.message}`);
  }
  return result.result;
}

// --- Peer discovery cache ---
const peerCards = new Map<string, AgentCard>();

async function discoverPeers(): Promise<void> {
  for (const peerUrl of PEERS) {
    try {
      const card = (await a2aFetch(
        peerUrl,
        'GET',
        '/.well-known/agent-card.json',
      )) as AgentCard;
      peerCards.set(peerUrl, card);
    } catch {
      // Peer offline — skip
    }
  }
}

function extractText(task: TaskResponse): string {
  // Try artifacts first
  if (task.artifacts?.length) {
    const texts = task.artifacts
      .flatMap((a) => a.parts)
      .filter((p) => p.kind === 'text' && p.text)
      .map((p) => p.text!);
    if (texts.length) return texts.join('\n');
  }
  // Fall back to status message
  if (task.status?.message?.parts) {
    const texts = task.status.message.parts
      .filter((p) => p.kind === 'text' && p.text)
      .map((p) => p.text!);
    if (texts.length) return texts.join('\n');
  }
  return `Task ${task.id}: ${task.status?.state || 'unknown'}`;
}

// --- MCP Server ---
async function main(): Promise<void> {
  // Discover peers on startup
  await discoverPeers();

  const server = new McpServer({
    name: 'a2a-client',
    version: '0.1.0',
  });

  // --- Tool: a2a_send_message ---
  server.tool(
    'send_message',
    'Send a message to a peer agent via A2A protocol. The message is sent as a task that the peer processes.',
    {
      to: z
        .string()
        .describe(
          'Agent ID of the recipient (use list_agents to see available agents)',
        ),
      content: z.string().describe('Message content to send'),
      priority: z
        .enum(['low', 'normal', 'high', 'urgent'])
        .optional()
        .describe('Message priority (default: normal)'),
      thread_id: z
        .string()
        .optional()
        .describe('Thread ID for conversation threading'),
      in_reply_to: z
        .string()
        .optional()
        .describe('Message ID this is a reply to'),
    },
    async (params) => {
      try {
        // Find the peer URL by agent name
        let targetUrl: string | undefined;
        for (const [url, card] of peerCards.entries()) {
          if (
            card.name.toLowerCase() === params.to.toLowerCase() ||
            url.includes(params.to)
          ) {
            targetUrl = url;
            break;
          }
        }

        // If not found in cache, try re-discovering
        if (!targetUrl) {
          await discoverPeers();
          for (const [url, card] of peerCards.entries()) {
            if (
              card.name.toLowerCase() === params.to.toLowerCase() ||
              url.includes(params.to)
            ) {
              targetUrl = url;
              break;
            }
          }
        }

        if (!targetUrl) {
          // Try to use `to` as a direct URL
          if (params.to.startsWith('http')) {
            targetUrl = params.to;
          } else {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Agent "${params.to}" not found. Use list_agents to see available peers.`,
                },
              ],
              isError: true,
            };
          }
        }

        // Build metadata with priority, threading
        const metadata: Record<string, string> = {};
        if (params.priority) metadata.priority = params.priority;
        if (params.thread_id) metadata.thread_id = params.thread_id;
        if (params.in_reply_to) metadata.in_reply_to = params.in_reply_to;
        metadata.from = AGENT_NAME;

        // Send via A2A message/send JSON-RPC
        const task = (await jsonRpc(targetUrl, 'message/send', {
          message: {
            role: 'user',
            kind: 'message',
            messageId: crypto.randomUUID(),
            parts: [{ kind: 'text', text: params.content }],
            metadata: Object.keys(metadata).length ? metadata : undefined,
          },
        })) as TaskResponse;

        const state = task.status?.state || 'submitted';
        const resultText = extractText(task);

        return {
          content: [
            {
              type: 'text' as const,
              text: `Message sent to ${params.to} via A2A.\nTask ID: ${task.id}\nStatus: ${state}${state === 'completed' ? `\nResponse: ${resultText}` : ''}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to send: ${err instanceof Error ? err.message : 'unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // --- Tool: a2a_get_task ---
  server.tool(
    'check_inbox',
    'Check status of A2A tasks. Without a task_id, lists recent tasks from all peers.',
    {
      unread_only: z
        .boolean()
        .optional()
        .describe('Only show unread/pending tasks (default: false)'),
      limit: z
        .number()
        .optional()
        .describe('Maximum tasks to return (default: 20)'),
    },
    async (params) => {
      try {
        // Query tasks/list from all peers
        const allTasks: Array<{ peer: string; task: TaskResponse }> = [];

        for (const [url, card] of peerCards.entries()) {
          try {
            const result = (await jsonRpc(url, 'tasks/list', {})) as
              | TaskResponse[]
              | { tasks: TaskResponse[] };
            const tasks = Array.isArray(result)
              ? result
              : (result as { tasks: TaskResponse[] }).tasks || [];
            for (const task of tasks) {
              if (params.unread_only && task.status?.state === 'completed')
                continue;
              allTasks.push({ peer: card.name, task });
            }
          } catch {
            // Peer offline or doesn't support tasks/list
          }
        }

        const limit = params.limit ?? 20;
        const limited = allTasks.slice(0, limit);

        if (limited.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: params.unread_only
                  ? 'No pending tasks from peers.'
                  : 'No tasks found.',
              },
            ],
          };
        }

        const formatted = limited
          .map(
            ({ peer, task }) =>
              `[${task.status?.state || '?'}] ${task.id} | Peer: ${peer}\n   ${extractText(task).substring(0, 200)}`,
          )
          .join('\n\n');

        return {
          content: [
            {
              type: 'text' as const,
              text: `${limited.length} task(s):\n\n${formatted}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed: ${err instanceof Error ? err.message : 'unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // --- Tool: mark_read (no-op for A2A compatibility) ---
  server.tool(
    'mark_read',
    'Mark messages as read. Pass specific message IDs or mark all as read.',
    {
      message_ids: z
        .array(z.string())
        .optional()
        .describe('Specific message IDs to mark as read'),
      all: z
        .boolean()
        .optional()
        .describe('Mark ALL messages as read (default: false)'),
    },
    async () => {
      // A2A tasks are stateful — no explicit mark-read needed.
      // This exists for backward compatibility with agents that call mark_read.
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Messages acknowledged.',
          },
        ],
      };
    },
  );

  // --- Tool: list_agents ---
  server.tool(
    'list_agents',
    'List all discovered peer agents you can communicate with via A2A.',
    {},
    async () => {
      try {
        // Re-discover to get fresh data
        await discoverPeers();

        if (peerCards.size === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No peer agents discovered. Check A2A_PEERS configuration.',
              },
            ],
          };
        }

        const formatted = Array.from(peerCards.entries())
          .map(([url, card]) => {
            const skills = card.skills
              ?.map((s) => s.name)
              .join(', ');
            return `• ${card.name} (${url})${skills ? `\n  Skills: ${skills}` : ''}`;
          })
          .join('\n');

        return {
          content: [
            {
              type: 'text' as const,
              text: `Discovered A2A peers:\n${formatted}\n\nYou are: ${AGENT_NAME}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed: ${err instanceof Error ? err.message : 'unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Start MCP server over stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`A2A MCP server failed: ${err}\n`);
  process.exit(1);
});
