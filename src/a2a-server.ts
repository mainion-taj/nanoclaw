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
import { A2AExpressApp, UserBuilder } from '@a2a-js/sdk/server/express';
import type { AgentCard, TaskStatusUpdateEvent, Task } from '@a2a-js/sdk';

import { A2A_PORT, A2A_AUTH_TOKEN, ASSISTANT_NAME } from './config.js';
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
    const taskId = context.taskId;

    // Log raw message shape for debugging A2A delivery issues
    const rawParts = context.userMessage?.parts;
    logger.info(
      {
        taskId,
        contextId: context.contextId,
        partsCount: rawParts?.length ?? 0,
        partsKinds: rawParts?.map((p: { kind: string }) => p.kind),
        rawMessage: JSON.stringify(context.userMessage).slice(0, 500),
      },
      'A2A task received — raw message',
    );

    const userText =
      (rawParts || [])
        .filter((p: { kind: string }) => p.kind === 'text')
        .map(
          (p: { kind: string; text?: string }) => (p as { text: string }).text,
        )
        .filter(Boolean)
        .join('\n') || '';

    logger.info(
      { taskId, textLength: userText.length, textPreview: userText.slice(0, 200) },
      'A2A task text extracted',
    );

    // Helper: publish a Task event (the SDK ResultManager needs kind:'task' to
    // initialise currentTask; bare status-update events get lost when no task
    // exists in the InMemoryTaskStore yet).
    const publishTask = (state: string, text: string, final: boolean) => {
      const task: Task & { kind: 'task' } = {
        kind: 'task',
        id: taskId,
        contextId: context.contextId,
        status: {
          state: state as Task['status']['state'],
          timestamp: new Date().toISOString(),
          message: {
            role: 'agent',
            kind: 'message',
            messageId: crypto.randomUUID(),
            parts: [{ kind: 'text', text }],
          },
        },
        history: [],
      };
      eventBus.publish(task);
    };

    if (!userText) {
      logger.warn(
        { taskId, rawParts: JSON.stringify(rawParts) },
        'A2A task has empty text — rejecting',
      );
      publishTask('failed', 'A2A task contained no text content. Raw parts logged on receiver.', true);
      eventBus.finished();
      return;
    }

    if (!messageInjector) {
      publishTask('failed', 'A2A server not connected to NanoClaw message loop', true);
      eventBus.finished();
      return;
    }

    // Inject into NanoClaw's message loop
    messageInjector(userText, taskId);
    logger.info({ taskId }, 'A2A task injected into message loop');

    // Register pending result tracker (agent session will call resolveA2ATask)
    pendingResults.set(taskId, {
      resolve: (result: string) => {
        logger.info(
          { taskId, resultLength: result.length },
          'A2A task completed',
        );
      },
      reject: (err: Error) => {
        logger.warn({ taskId, error: err.message }, 'A2A task failed');
      },
    });

    // Auto-cleanup after 30 minutes
    setTimeout(
      () => {
        pendingResults.delete(taskId);
      },
      30 * 60 * 1000,
    );

    // Publish completed task with acknowledgment
    publishTask('completed', `Message received and queued for processing (task: ${taskId})`, true);
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
    const task: Task & { kind: 'task' } = {
      kind: 'task',
      id: taskId,
      contextId: '',
      status: {
        state: 'canceled',
        timestamp: new Date().toISOString(),
      },
      history: [],
    };
    eventBus.publish(task);
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
  const a2aApp = new A2AExpressApp(
    requestHandler,
    UserBuilder.noAuthentication,
  );
  a2aApp.setupRoutes(app, '');

  app.listen(A2A_PORT, '0.0.0.0', () => {
    logger.info(
      { port: A2A_PORT, agent: ASSISTANT_NAME },
      'A2A server started',
    );
  });

  return app;
}
