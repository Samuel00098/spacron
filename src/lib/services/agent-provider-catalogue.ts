import { getAgentDisplayName } from '$lib/stores/terminal';
import {
  getAgentProviderCapabilities as getAdapterCapabilities,
  getAgentProviderLaunchOptions,
  getChatProviderTransport,
  getNativeChatProviderTransport,
  isPiProvider,
  isCodexProvider,
  getLiveAgentModelCommand,
  isChatAgentProvider,
  mergeAgentProviderModels,
  parseLiveAgentModels,
} from './chat-provider-adapters';
import type {
  AgentProviderCapabilities,
  AgentProviderLaunchOptions,
  AgentProviderModel,
  ChatProviderAdapter,
  ChatProviderProtocol,
  ChatProviderTransport,
} from './chat-provider-adapters';

export function getAgentProviderCapabilities(command: string, label = getAgentDisplayName(command) ?? command): AgentProviderCapabilities {
  return getAdapterCapabilities(command, label);
}

export {
  getAgentProviderLaunchOptions,
  getChatProviderTransport,
  getNativeChatProviderTransport,
  isPiProvider,
  isCodexProvider,
  getLiveAgentModelCommand,
  isChatAgentProvider,
  mergeAgentProviderModels,
  parseLiveAgentModels,
};
export type {
  AgentProviderCapabilities,
  AgentProviderLaunchOptions,
  AgentProviderModel,
  ChatProviderAdapter,
  ChatProviderProtocol,
  ChatProviderTransport,
};
