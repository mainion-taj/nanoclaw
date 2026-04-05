/**
 * Native Runner for NanoClaw
 * Spawns agent-runner directly as a Node.js child process (no container).
 * Same interface as container-runner but without Docker/container overhead.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { validateAdditionalMounts } from './mount-security.js';
import { ContainerInput, ContainerOutput } from './container-runner.js';
import { RegisteredGroup } from './types.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

let agentRunnerBuilt = false;

function getAgentRunnerDir(): string {
  return path.join(process.cwd(), 'container', 'agent-runner');
}

function getAgentRunnerDist(): string {
  return path.join(getAgentRunnerDir(), 'dist');
}

/**
 * Build the agent-runner TypeScript if not already built.
 * Installs deps and compiles on first call.
 */
export function ensureAgentRunnerBuilt(): void {
  if (agentRunnerBuilt) return;

  const runnerDir = getAgentRunnerDir();
  const distDir = getAgentRunnerDist();
  const indexJs = path.join(distDir, 'index.js');

  // Check if already built
  if (fs.existsSync(indexJs)) {
    agentRunnerBuilt = true;
    return;
  }

  logger.info('Building agent-runner for native mode...');

  const { execSync } = require('child_process');

  // Install dependencies if needed
  if (!fs.existsSync(path.join(runnerDir, 'node_modules'))) {
    execSync('npm install', { cwd: runnerDir, stdio: 'pipe', timeout: 120000 });
  }

  // Compile TypeScript
  execSync('npx tsc', { cwd: runnerDir, stdio: 'pipe', timeout: 60000 });

  agentRunnerBuilt = true;
  logger.info('Agent-runner built successfully');
}

function readSecrets(): Record<string, string> {
  return readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    // Agent mailbox MCP config
    'MAILBOX_SERVER_URL',
    'MAILBOX_AGENT_ID',
    'MAILBOX_AGENT_NAME',
    'MAILBOX_CLI_PATH',
    'MAILBOX_AUTH_TOKEN',
  ]);
}

function setupGroupDirs(
  group: RegisteredGroup,
  isMain: boolean,
): {
  groupDir: string;
  ipcDir: string;
  globalDir: string;
  extraDir: string;
  claudeDir: string;
  additionalDirs: string[];
} {
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);
  const ipcDir = resolveGroupIpcPath(group.folder);
  const globalDir = path.join(GROUPS_DIR, 'global');
  const extraDir = path.join(projectRoot, 'data', 'extra', group.folder);

  // Ensure directories exist
  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });
  fs.mkdirSync(extraDir, { recursive: true });

  // Per-group Claude sessions directory
  const claudeDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsFile = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  const skillsDst = path.join(claudeDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  // Collect additional mount directories
  const additionalDirs: string[] = [];
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    for (const mount of validatedMounts) {
      additionalDirs.push(mount.hostPath);
    }
  }

  return { groupDir, ipcDir, globalDir, extraDir, claudeDir, additionalDirs };
}

export async function runNativeAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  ensureAgentRunnerBuilt();

  const isMain = input.isMain;
  const dirs = setupGroupDirs(group, isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processName = `nanoclaw-native-${safeName}-${Date.now()}`;

  const secrets = readSecrets();

  // Symlink credentials from real HOME into per-group .claude dir
  // so the SDK can find OAuth tokens while using per-group settings/sessions.
  const realHome = process.env.HOME || require('os').homedir();
  const realCredentials = path.join(realHome, '.claude', '.credentials.json');
  const groupCredentials = path.join(dirs.claudeDir, '.credentials.json');
  if (fs.existsSync(realCredentials) && !fs.existsSync(groupCredentials)) {
    try {
      fs.symlinkSync(realCredentials, groupCredentials);
    } catch {
      // May already exist or be a regular file — copy instead
      try {
        fs.copyFileSync(realCredentials, groupCredentials);
      } catch {
        /* ignore */
      }
    }
  }

  // Build environment for the agent-runner process
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // Workspace paths (read by agent-runner via env vars)
    NANOCLAW_WORKSPACE_GROUP: dirs.groupDir,
    NANOCLAW_WORKSPACE_IPC: dirs.ipcDir,
    NANOCLAW_WORKSPACE_GLOBAL: dirs.globalDir,
    NANOCLAW_WORKSPACE_EXTRA: dirs.extraDir,
    // Claude config — override HOME so ~/.claude points to per-group sessions
    HOME: path.dirname(dirs.claudeDir),
    TZ: TIMEZONE,
  };

  // Pass secrets via env to the agent-runner (it passes them to SDK via sdkEnv)
  // These are NOT passed to Bash subprocesses (agent-runner sanitizes them)
  for (const [key, value] of Object.entries(secrets)) {
    if (value) env[key] = value;
  }

  const logsDir = path.join(dirs.groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const entryPoint = path.join(getAgentRunnerDist(), 'index.js');

  logger.info(
    {
      group: group.name,
      processName,
      isMain,
      groupDir: dirs.groupDir,
      ipcDir: dirs.ipcDir,
    },
    'Spawning native agent',
  );

  return new Promise((resolve) => {
    const proc = spawn('node', [entryPoint], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: dirs.groupDir,
      env,
    });

    onProcess(proc, processName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Pass input via stdin (same protocol as container mode)
    // Secrets are passed via env vars (above) and credential proxy — not in stdin
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();

    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let timedOut = false;
    let hadStreamingOutput = false;

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
        } else {
          stdout += chunk;
        }
      }

      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ native: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
      } else {
        stderr += chunk;
      }
    });

    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, processName },
        'Native agent timeout, sending SIGTERM',
      );
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 15000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    proc.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, processName, duration, code },
            'Native agent timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }

        resolve({
          status: 'error',
          result: null,
          error: `Native agent timed out after ${configTimeout}ms`,
        });
        return;
      }

      // Write log file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `native-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';
      const isError = code !== 0;

      const logLines = [
        `=== Native Agent Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        ``,
      ];

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Stderr ===`,
          stderr,
          ``,
          `=== Stdout ===`,
          stdout,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration, stderr, logFile },
          'Native agent exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Native agent exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Native agent completed (streaming mode)',
          );
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      // Legacy parse mode
      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);
        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }
        const output: ContainerOutput = JSON.parse(jsonLine);
        resolve(output);
      } catch (err) {
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse native agent output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, processName, error: err },
        'Native agent spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Native agent spawn error: ${err.message}`,
      });
    });
  });
}
