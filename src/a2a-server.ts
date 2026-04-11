/**
 * A2A (Agent-to-Agent) Protocol Server for NanoClaw
 *
 * Runs an Express server implementing the A2A protocol alongside the
 * existing mailbox system. Phase 1: serve Agent Card & accept tasks.
 */
import express from 'express';
import crypto from 'crypto';
import { hostname } from 'os';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  RequestContext,
  type ExecutionEventBus,
  type AgentExecutor,
} from '@a2a-js/sdk/server';
import {
  A2AExpressApp,
  UserBuilder,
} from '@a2a-js/sdk/server/express';
import type { AgentCard, TaskStatusUpdateEvent } from '@a2a-js/sdk';

import {
  A2A_PORT,
  A2A_AUTH_TOKEN,
  ASSISTANT_NAME,
} from './config.js';
import { logger } from './logger.js';

// Callback type for injecting A2A messages into NanoClaw's message loop
type MessageInjector = (text: string, taskId: string) => void;

// Registered callback set by index.ts at startup
let messageInjector: MessageInjector | null = null;

// Pending task results: taskId -> { resolve, reject }
const pendingResults = new Map<
  string,
  { resolve: (result: string) => void; reject: (err: Error) => void }
>();

/**
 * Register the message injector function.
 * Called from index.ts during startup to wire A2A into the message loop.
 */
export function setA2AMessageInjector(fn: MessageInjector): void {
  messageInjector = fn;
}

/**
 * Resolve a pending task with the agent's result.
 * Called from index.ts when an agent session completes for an A2A task.
 */
export function resolveA2ATask(taskId: string, result: string): void {
  const pending = pendingResults.get(taskId);
  if (pending) {
    pending.resolve(result);
    pendingResults.delete(taskId);
  }
}

/**
 * Reject a pending task on error.
 */
export function rejectA2ATask(taskId: string, error: Error): void {
  const pending = pendingResults.get(taskId);
  if (pending) {
    pending.reject(error);
    pendingResults.delete(taskId);
  }
}

/**
 * Build the Agent Card dynamically from NanoClaw runtime state.
 */
function buildAgentCard(): AgentCard {
  const host = hostname();
  return {
    protocolVersion: '0.3.0',
    name: ASSISTANT_NAME,
    description: `NanoClaw agent on ${host}`,
    url: `http://${host}:${A2A_PORT}`,
    provider: {
      organization: 'NanoClaw',
      url: 'https://github.com/anthropics/nanoclaw',
    },
    version: '1.0.0',
    capabilities: {
      streaming: false, // Phase 1: sync only
      pushNotifications: true,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'general',
        name: 'General Assistant',
        description: 'General-purpose Claude agent with full tool access',
        tags: ['assistant', 'coding', 'research'],
      },
    ],
    securitySchemes: A2A_AUTH_TOKEN
      ? {
          bearerAuth: { type: 'http', scheme: 'bearer' },
        }
      : undefined,
    security: A2A_AUTH_TOKEN ? [{ bearerAuth: [] }] : undefined,
  } as AgentCard;
}

/**
 * NanoClaw executor: receives A2A tasks and injects them into the message loop.
 */
class NanoClawExecutor implements AgentExecutor {
  execute = async (
    context: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> => {
    const userText = context.userMessage.parts
      ?.filter((p: { kind: string }) => p.kind === 'text')
      .map((p: { kind: string; text?: string }) => (p as { text: string }).text)
      .join('\n') || '';

    const taskId = context.taskId;

    logger.info(
      { taskId, contextId: context.contextId, textLength: userText.length },
      'A2A task received',
    );

    if (!messageInjector) {
      // Publish failed status
      eventBus.publish({
        kind: 'status-update',
        taskId,
        contextId: context.contextId,
        status: {
          state: 'failed',
          timestamp: new Date().toISOString(),
          message: {
            role: 'agent',
            kind: 'message',
            messageId: crypto.randomUUID(),
            parts: [{ kind: 'text', text: 'A2A server not connected to NanoClaw message loop' }],
          },
        },
        final: true,
      } as TaskStatusUpdateEvent);
      eventBus.finished();
      return;
    }

    // Publish working status
    eventBus.publish({
      kind: 'status-update',
      taskId,
      contextId: context.contextId,
      status: {
        state: 'working',
        timestamp: new Date().toISOString(),
      },
      final: false,
    } as TaskStatusUpdateEvent);

    // Inject into NanoClaw's message loop
    messageInjector(userText, taskId);

    // Fire-and-forget: return "working" immediately.
    // The message is injected and NanoClaw will process it in its normal loop.
    // Callers can poll tasks/get for eventual completion if needed.
    logger.info({ taskId }, 'A2A task injected into message loop');

    // Register pending result tracker (agent session will call resolveA2ATask)
    pendingResults.set(taskId, {
      resolve: (result: string) => {
        logger.info({ taskId, resultLength: result.length }, 'A2A task completed');
        // Could publish artifact/completed here if we had eventBus reference,
        // but for now the task store tracks status via the initial "working" event.
      },
      reject: (err: Error) => {
        logger.warn({ taskId, error: err.message }, 'A2A task failed');
      },
    });

    // Auto-cleanup after 30 minutes
    setTimeout(() => {
      pendingResults.delete(taskId);
    }, 30 * 60 * 1000);

    // Publish completed immediately with acknowledgment
    eventBus.publish({
      kind: 'status-update',
      taskId,
      contextId: context.contextId,
      status: {
        state: 'completed',
        timestamp: new Date().toISOString(),
        message: {
          role: 'agent',
          kind: 'message',
          messageId: crypto.randomUUID(),
          parts: [{ kind: 'text', text: `Message received and queued for processing (task: ${taskId})` }],
        },
      },
      final: true,
    } as TaskStatusUpdateEvent);

    eventBus.finished();
  };

  cancelTask = async (
    taskId: string,
    eventBus: ExecutionEventBus,
  ): Promise<void> => {
    logger.info({ taskId }, 'A2A task cancellation requested');
    const pending = pendingResults.get(taskId);
    if (pending) {
      pending.reject(new Error('Task cancelled'));
      pendingResults.delete(taskId);
    }
    eventBus.publish({
      kind: 'status-update',
      taskId,
      contextId: '',
      status: {
        state: 'canceled',
        timestamp: new Date().toISOString(),
      },
      final: true,
    } as TaskStatusUpdateEvent);
    eventBus.finished();
  };
}

/**
 * Start the A2A server.
 * Returns the Express app for testing, or null if A2A is not configured.
 */
export function startA2AServer(): express.Express | null {
  if (!A2A_PORT) {
    logger.debug('A2A_PORT not configured, skipping A2A server');
    return null;
  }

  const app = express();

  // Bearer token auth middleware
  if (A2A_AUTH_TOKEN) {
    app.use((req, res, next) => {
      // Allow agent card without auth (for discovery)
      if (
        req.path === '/.well-known/agent.json' ||
        req.path === '/.well-known/agent-card.json' ||
        req.path === '/health'
      ) {
        return next();
      }
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${A2A_AUTH_TOKEN}`) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      next();
    });
  }

  // Health endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', agent: ASSISTANT_NAME, protocol: 'a2a/0.3.0' });
  });

  // Build A2A handler
  const agentCard = buildAgentCard();
  const taskStore = new InMemoryTaskStore();
  const executor = new NanoClawExecutor();
  const requestHandler = new DefaultRequestHandler(
    agentCard,
    taskStore,
    executor,
  );

  // Setup A2A routes
  const a2aApp = new A2AExpressApp(requestHandler, UserBuilder.noAuthentication);
  a2aApp.setupRoutes(app, '');

  app.listen(A2A_PORT, '0.0.0.0', () => {
    logger.info(
      { port: A2A_PORT, agent: ASSISTANT_NAME },
      'A2A server started',
    );
  });

  return app;
}
