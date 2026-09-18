import { getAgentDisplayName } from '$lib/stores/terminal';
import {
  getAgentProviderCapabilities as getAdapterCapabilities,
  getAgentProviderLaunchOptions,
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
} from './chat-provider-adapters';

export function getAgentProviderCapabilities(command: string, label = getAgentDisplayName(command) ?? command): AgentProviderCapabilities {
  return getAdapterCapabilities(command, label);
}

export {
  getAgentProviderLaunchOptions,
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
};
