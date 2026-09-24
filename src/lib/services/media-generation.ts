/**
 * Image and video generation, shared by the orchestrator's generate_image /
 * generate_video tools and the image viewer's Edit mode.
 *
 * The backend (`images::generate_media`) owns the provider order: the user's
 * ChatGPT plan first for images, then every API-key provider with a saved key,
 * skipping any that is not set up or out of credit. The Settings choice only
 * moves one provider to the front, and the model map overrides defaults.
 */
import { invoke } from '@tauri-apps/api/core';

export type MediaKind = 'image' | 'video';
export type MediaProviderId = 'chatgpt' | 'openai' | 'google' | 'openrouter' | 'vercel' | 'fal' | 'replicate';

export interface MediaGenerationSettings {
  imageProvider: 'auto' | MediaProviderId;
  videoProvider: 'auto' | MediaProviderId;
  /** Provider id → model id; a missing or blank entry uses the default. */
  imageModels: Record<string, string>;
  videoModels: Record<string, string>;
}

export const DEFAULT_MEDIA_GENERATION: MediaGenerationSettings = {
  imageProvider: 'auto',
  videoProvider: 'auto',
  imageModels: {},
  videoModels: {},
};

export interface MediaProviderInfo {
  id: MediaProviderId;
  label: string;
  image: boolean;
  video: boolean;
  /** The backend's default model, shown as the placeholder. */
  imageDefault?: string;
  videoDefault?: string;
  /** Only for fal and Replicate, whose keys are not chat-provider keys. */
  keyUrl?: string;
}

/** Mirrors `media::default_model` in Rust; keep the two in step. */
export const MEDIA_PROVIDERS: MediaProviderInfo[] = [
  { id: 'chatgpt', label: 'ChatGPT plan', image: true, video: false, imageDefault: 'Codex image tool' },
  { id: 'openai', label: 'OpenAI API', image: true, video: true, imageDefault: 'gpt-image-1', videoDefault: 'sora-2' },
  { id: 'google', label: 'Google Gemini', image: true, video: true, imageDefault: 'gemini-2.5-flash-image', videoDefault: 'veo-3.0-fast-generate-001' },
  { id: 'openrouter', label: 'OpenRouter', image: true, video: false, imageDefault: 'google/gemini-2.5-flash-image' },
  { id: 'vercel', label: 'Vercel AI Gateway', image: true, video: true, imageDefault: 'openai/gpt-image-2', videoDefault: 'google/veo-3.1-fast-generate-001' },
  { id: 'fal', label: 'fal', image: true, video: true, imageDefault: 'fal-ai/nano-banana', videoDefault: 'fal-ai/veo3/fast', keyUrl: 'https://fal.ai/dashboard/keys' },
  { id: 'replicate', label: 'Replicate', image: true, video: true, imageDefault: 'black-forest-labs/flux-schnell', videoDefault: 'google/veo-3-fast', keyUrl: 'https://replicate.com/account/api-tokens' },
];

export interface GeneratedMedia {
  path: string;
  name: string;
  size: number;
  revisedPrompt: string | null;
  provider: MediaProviderId;
  /** Providers tried first that could not do it, with the reason. */
  skipped: string[];
}

export function mediaProviderLabel(id: string): string {
  return MEDIA_PROVIDERS.find((p) => p.id === id)?.label ?? id;
}

export async function generateMedia(options: {
  requestId: string;
  kind: MediaKind;
  prompt: string;
  referenceImages: string[];
  projectRoot: string | null;
  settings: MediaGenerationSettings;
}): Promise<GeneratedMedia> {
  const { settings, kind } = options;
  return invoke<GeneratedMedia>('generate_media', {
    requestId: options.requestId,
    kind,
    provider: kind === 'video' ? settings.videoProvider : settings.imageProvider,
    models: kind === 'video' ? settings.videoModels : settings.imageModels,
    prompt: options.prompt,
    referenceImages: options.referenceImages,
    projectRoot: options.projectRoot,
  });
}

export function cancelMediaGeneration(requestId: string): void {
  void invoke('generate_image_cancel', { requestId }).catch(() => {});
}

/**
 * A line for the thread when the first choice could not be used, so a spent
 * ChatGPT limit is never silent even though the picture still arrived.
 */
export function fallbackNotice(result: GeneratedMedia): string | null {
  if (!result.skipped.length) return null;
  const first = result.skipped.find((line) => !/no API key saved|not signed in/.test(line)) ?? null;
  if (!first) return null;
  return `Made with ${mediaProviderLabel(result.provider)} because ${first.replace(/^([^:]+): /, '$1 could not: ')}`;
}

/**
 * The message to put in the thread when generation fails in a way the user
 * must act on (credit used up, nothing configured), or null for failures the
 * brain can explain itself.
 */
export function failureNotice(error: string, kind: MediaKind): string | null {
  const noun = kind === 'video' ? 'video' : 'image';
  if (/^(quota|none_available):/.test(error)) {
    const body = error.replace(/^(quota|none_available):\s*/, '');
    const [headline, ...lines] = body.split('\n');
    return [`**Could not make the ${noun}.** ${headline}`, ...lines].join('\n');
  }
  if (/^unsupported:/.test(error)) return error.replace(/^unsupported:\s*/, '');
  return null;
}

/** File type for a generated file, from its extension. */
export function mediaMimeType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'mp4') return 'video/mp4';
  if (ext === 'webm') return 'video/webm';
  if (ext === 'mov') return 'video/quicktime';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/png';
}
