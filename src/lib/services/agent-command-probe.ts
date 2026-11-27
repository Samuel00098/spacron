/**
 * Ask an agent for its slash commands when no structured chat is running it (a
 * terminal-backed chat). The agent is started over its protocol just long
 * enough to publish the list; no prompt is sent, so no model is called.
 */
import {
  ACP_NO_CLIENT_TOOLS,
  authenticateAcp,
  createAcpNativeSession,
  initializeAcp,
  openAgentSession,
  withTimeout,
  type AcpSession,
} from './acp-transport';
import { ACP_LAUNCHES } from './structured-chat/acp-session';
import { acpCommandsFrom, commandRows, setAgentCommands, type AgentCommand } from './agent-commands';

type Json = Record<string, unknown>;

/** Whether this agent can be asked for its commands. */
export function canProbeCommands(agent: string): boolean {
  return agent === 'pi' || agent in ACP_LAUNCHES;
}

async function askAcp(session: AcpSession, agent: string, cwd: string): Promise<AgentCommand[]> {
  let publish: (list: AgentCommand[]) => void = () => {};
  const published = new Promise<AgentCommand[]>((resolve) => { publish = resolve; });
  await session.onNotification((notification) => {
    const list = acpCommandsFrom(notification);
    if (list) publish(list);
  });
  const initialized = await withTimeout(initializeAcp(session, ACP_NO_CLIENT_TOOLS), 60_000, 'The agent did not answer initialize');
  const auth = ACP_LAUNCHES[agent].authMethod;
  if (auth && initialized.authMethods.some((method) => (method as Json | null)?.id === auth)) {
    await withTimeout(authenticateAcp(session, auth), 30_000, 'The agent did not finish signing in');
  }
  await withTimeout(createAcpNativeSession(session, cwd, null, []), 90_000, 'The agent did not open a session');
  return withTimeout(published, 20_000, 'The agent published no commands');
}

async function askPi(session: AcpSession): Promise<AgentCommand[]> {
  let publish: (list: AgentCommand[]) => void = () => {};
  const published = new Promise<AgentCommand[]>((resolve) => { publish = resolve; });
  const read = (frame: Json) => {
    if (frame.type === 'response' && frame.command === 'get_commands') publish(commandRows((frame.data as Json | undefined)?.commands));
  };
  await session.onNotification(read);
  await session.onRawLine((line) => { try { read(JSON.parse(line) as Json); } catch { /* not a frame */ } });
  await session.writeRaw(`${JSON.stringify({ type: 'get_commands', id: 'spacron-commands' })}\n`);
  return withTimeout(published, 30_000, 'Pi did not list its commands');
}

const pending = new Map<string, Promise<boolean>>();
const asked = new Map<string, number>();
const RECHECK_MS = 10 * 60_000;

/**
 * Fetch and record the agent's commands. False when it could not be asked.
 * Asked at most once every ten minutes per agent and folder.
 */
export function probeAgentCommands(agent: string, cwd: string): Promise<boolean> {
  const key = `${agent}|${cwd}`;
  const running = pending.get(key);
  if (running) return running;
  if (Date.now() - (asked.get(key) ?? 0) < RECHECK_MS) return Promise.resolve(true);
  const request = (async () => {
    const launch = agent === 'pi' ? { command: 'pi', args: ['--mode', 'rpc', '--no-session'], env: {} } : ACP_LAUNCHES[agent];
    const session = await openAgentSession(launch.command, launch.args, cwd, launch.env ?? {});
    try {
      const list = agent === 'pi' ? await askPi(session) : await askAcp(session, agent, cwd);
      setAgentCommands(agent, cwd, list);
      asked.set(key, Date.now());
      return list.length > 0;
    } finally {
      await session.close().catch(() => {});
    }
  })()
    .catch((error) => {
      console.warn(`Could not read ${agent}'s slash commands:`, error);
      return false;
    })
    .finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}
