/**
 * @fileOverview: OpenAI service with provider-specific configurations and compatibility handling
 * @module: OpenAIService
 * @keyFunctions:
 *   - createChatCompletion(): Unified interface for chat completions across providers
 *   - getProviderConfig(): Get provider-specific configuration
 *   - normalizeParameters(): Normalize parameters for each provider
 * @dependencies:
 *   - openai: Official OpenAI SDK
 *   - logger: Logging utilities
 * @context: Handles differences between OpenAI-compatible providers (Qwen, Azure, etc.) with specific parameter requirements
 */

import OpenAI from 'openai';
import { logger } from '../utils/logger';
import { validateDynamicSignal, Message, ValidationError } from './validation';

// Provider types
export type ProviderType = 'openai' | 'qwen' | 'azure' | 'anthropic' | 'together' | 'custom';

// Provider-specific configurations
interface ProviderConfig {
  name: string;
  requiresTemperatureOne?: boolean;
  maxTokensParam?: string; // 'max_tokens' for most, could be 'maxTokens' for some
  supportsStreaming?: boolean;
  defaultModel: string;
  defaultMiniModel: string;
  defaultEmbeddingsModel?: string;
  baseUrl?: string;
}

// Model configurations
interface ModelConfig {
  maxTokensLimit: number;
  supportsFunctions?: boolean;
  supportsTools?: boolean;
  disallowMaxTokens?: boolean;
  enforceTemperature?: number;
}

// Service configuration
interface OpenAIServiceConfig {
  apiKey: string;
  provider: ProviderType;
  model?: string;
  miniModel?: string;
  embeddingsModel?: string;
  baseUrl?: string;
  organization?: string;
}

export class OpenAIService {
  private client: OpenAI;
  private config: OpenAIServiceConfig;
  private providerConfig: ProviderConfig;
  private modelConfig: ModelConfig;

  constructor(config: OpenAIServiceConfig) {
    this.config = config;

    // Get provider-specific configuration
    this.providerConfig = this.getProviderConfig(config.provider);

    // Set base URL if provided, or use OPENAI_BASE_URL env var, or use provider default, or use OpenAI default
    const baseUrl =
      config.baseUrl ||
      process.env.OPENAI_BASE_URL ||
      this.providerConfig.baseUrl ||
      'https://api.openai.com/v1';

    // Resolve provider by base URL if using a custom endpoint
    const resolvedProvider = this.resolveProvider(config.provider, baseUrl);
    if (resolvedProvider !== config.provider) {
      this.providerConfig = this.getProviderConfig(resolvedProvider);
    }

    // Initialize OpenAI client
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: baseUrl,
      organization: config.organization,
      dangerouslyAllowBrowser: true, // For browser environments if needed
    });

    // Get model configuration
    const modelName = config.model || this.providerConfig.defaultModel;
    this.modelConfig = this.getModelConfig(modelName);

    logger.info('OpenAI Service initialized', {
      provider: this.providerConfig.name,
      model: modelName,
      miniModel: config.miniModel || this.providerConfig.defaultMiniModel,
      embeddingsModel: this.getEmbeddingsModel(),
      baseUrl,
    });
  }

  /**
   * Perform a minimal live connectivity probe to verify the API key and endpoint work.
   * Tries to list models; falls back to a tiny completion if listing isn't available.
   * Returns true on success within timeout, false on error/timeout.
   */
  async quickProbe(timeoutMs: number = 3000): Promise<boolean> {
    const timeout = new Promise<never>((_, reject) => {
      const id = setTimeout(
        () => {
          clearTimeout(id);
          reject(new Error('probe-timeout'));
        },
        Math.max(500, timeoutMs)
      );
    });

    const tryList = async () => {
      try {
        // Some OpenAI-compatible providers may not support listing models
        // If it throws 404/401, treat as failure and try completion fallback
        const res = await this.client.models.list();
        return !!res && Array.isArray((res as any).data);
      } catch {
        return false;
      }
    };

    const tryTinyCompletion = async () => {
      try {
        await this.client.chat.completions.create({
          model: this.getModelForTask('mini'),
          messages: [{ role: 'system', content: 'ping' }],
          max_tokens: 1,
          temperature: 1,
        } as any);
        return true;
      } catch {
        return false;
      }
    };

    try {
      const ok = await Promise.race([
        (async () => (await tryList()) || (await tryTinyCompletion()))(),
        timeout,
      ] as [Promise<boolean>, Promise<never>]);
      return !!ok;
    } catch {
      return false;
    }
  }

  /**
   * Get provider-specific configuration
   */
  private getProviderConfig(provider: ProviderType): ProviderConfig {
    const configs: Record<ProviderType, ProviderConfig> = {
      openai: {
        name: 'OpenAI',
        supportsStreaming: true,
        defaultModel: process.env.OPENAI_BASE_MODEL || 'gpt-5',
        defaultMiniModel: process.env.OPENAI_MINI_MODEL || 'gpt-5-mini',
        defaultEmbeddingsModel: process.env.OPENAI_EMBEDDINGS_MODEL || 'text-embedding-3-large',
        maxTokensParam: 'max_tokens',
        baseUrl: 'https://api.openai.com/v1',
      },
      qwen: {
        name: 'Qwen',
        requiresTemperatureOne: true,
        maxTokensParam: 'max_tokens',
        supportsStreaming: true,
        defaultModel: process.env.OPENAI_BASE_MODEL || 'qwen-plus',
        defaultMiniModel: process.env.OPENAI_MINI_MODEL || 'qwen-turbo',
        defaultEmbeddingsModel: process.env.OPENAI_EMBEDDINGS_MODEL, // override via env when using Qwen-compatible embeddings
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      },
      azure: {
        name: 'Azure OpenAI',
        supportsStreaming: true,
        defaultModel: process.env.OPENAI_BASE_MODEL || 'gpt-5',
        defaultMiniModel: process.env.OPENAI_MINI_MODEL || 'gpt-5-mini',
        defaultEmbeddingsModel: process.env.OPENAI_EMBEDDINGS_MODEL || 'text-embedding-3-large',
        baseUrl: process.env.AZURE_OPENAI_ENDPOINT,
      },
      anthropic: {
        name: 'Anthropic',
        supportsStreaming: true,
        defaultModel: process.env.OPENAI_BASE_MODEL || 'claude-4-sonnet-latest',
        defaultMiniModel: process.env.OPENAI_MINI_MODEL || 'claude-4-haiku-20240307',
        defaultEmbeddingsModel: process.env.OPENAI_EMBEDDINGS_MODEL, // Anthropic does not provide embeddings; rely on env if proxying
        baseUrl: 'https://api.anthropic.com/v1',
      },
      together: {
        name: 'Together AI',
        supportsStreaming: true,
        defaultModel: process.env.OPENAI_BASE_MODEL || 'mistralai/Mixtral-8x7B-Instruct-v0.1',
        defaultMiniModel: process.env.OPENAI_MINI_MODEL || 'mistralai/Mistral-7B-Instruct-v0.2',
        defaultEmbeddingsModel: process.env.OPENAI_EMBEDDINGS_MODEL, // set for Together if applicable
        baseUrl: 'https://api.together.xyz/v1',
      },
      custom: {
        name: 'Custom Provider',
        supportsStreaming: true,
        defaultModel: process.env.OPENAI_BASE_MODEL || 'gpt-5',
        defaultMiniModel: process.env.OPENAI_MINI_MODEL || 'gpt-5-mini',
        defaultEmbeddingsModel: process.env.OPENAI_EMBEDDINGS_MODEL || 'text-embedding-3-large',
      },
    };

    return configs[provider];
  }

  /**
   * Resolve provider by base URL for common OpenAI-compatible services
   */
  private resolveProvider(provider: ProviderType, baseUrl?: string): ProviderType {
    if (!baseUrl || provider !== 'custom') return provider;
    try {
      const host = new URL(baseUrl).host.toLowerCase();
      if (host.includes('openrouter.ai')) return 'openai';
      if (host.includes('groq.com')) return 'openai';
      if (host.includes('together.xyz')) return 'together';
      if (host.includes('aliyuncs.com')) return 'qwen';
      if (host.includes('anthropic.com')) return 'anthropic';
      if (host.includes('openai.com')) return 'openai';
      return provider;
    } catch {
      return provider;
    }
  }

  /**
   * Get model-specific configuration
   */
  private getModelConfig(model: string): ModelConfig {
    // This would typically be more comprehensive
    const modelConfigs: Record<string, ModelConfig> = {
      'gpt-5': {
        maxTokensLimit: 16384,
        supportsFunctions: true,
        supportsTools: true,
        disallowMaxTokens: true,
        enforceTemperature: 1,
      },
      'gpt-5-mini': {
        maxTokensLimit: 16384,
        supportsFunctions: true,
        supportsTools: true,
        disallowMaxTokens: true,
        enforceTemperature: 1,
      },
      'gpt-5-nano': {
        maxTokensLimit: 16384,
        supportsFunctions: true,
        supportsTools: true,
        disallowMaxTokens: true,
        enforceTemperature: 1,
      },
      'gpt-4': { maxTokensLimit: 8192, supportsFunctions: true, supportsTools: true },
      'gpt-4o': { maxTokensLimit: 16384, supportsFunctions: true, supportsTools: true },
      'gpt-4o-mini': { maxTokensLimit: 16384, supportsFunctions: true, supportsTools: true },
      'gpt-3.5-turbo': { maxTokensLimit: 4096, supportsFunctions: true, supportsTools: true },
      'qwen-plus': { maxTokensLimit: 32768, supportsFunctions: true, supportsTools: true },
      'qwen-turbo': { maxTokensLimit: 16384, supportsFunctions: true, supportsTools: true },
      'qwen-max': { maxTokensLimit: 32768, supportsFunctions: true, supportsTools: true },
      'claude-3-5-sonnet-latest': {
        maxTokensLimit: 200000,
        supportsFunctions: false,
        supportsTools: true,
      },
      'claude-3-haiku-20240307': {
        maxTokensLimit: 200000,
        supportsFunctions: false,
        supportsTools: true,
      },
      'mistralai/Mixtral-8x7B-Instruct-v0.1': {
        maxTokensLimit: 32768,
        supportsFunctions: true,
        supportsTools: true,
      },
      'mistralai/Mistral-7B-Instruct-v0.2': {
        maxTokensLimit: 32768,
        supportsFunctions: true,
        supportsTools: true,
      },
    };

    // Return specific config or default
    return (
      modelConfigs[model] || { maxTokensLimit: 4096, supportsFunctions: true, supportsTools: true }
    );
  }

  /**
   * Normalize parameters for the specific provider
   */
  private normalizeParameters(
    params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
  ): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
    const normalizedParams = { ...params };

    // Handle temperature requirement for Qwen
    if (this.providerConfig.requiresTemperatureOne && normalizedParams.temperature !== 1) {
      logger.warn(
        `Provider ${this.providerConfig.name} requires temperature=1, overriding provided value`,
        {
          originalTemperature: normalizedParams.temperature,
          forcedTemperature: 1,
        }
      );
      normalizedParams.temperature = 1;
    }

    // Handle max_tokens parameter
    if (this.providerConfig.maxTokensParam && this.providerConfig.maxTokensParam !== 'max_tokens') {
      // This would handle cases where providers use different parameter names
      // For now, most providers use 'max_tokens' so we'll keep it as is
    }

    // Model-specific enforced temperature
    if (
      this.modelConfig.enforceTemperature !== undefined &&
      normalizedParams.temperature !== this.modelConfig.enforceTemperature
    ) {
      logger.warn(
        `Model ${normalizedParams.model} enforces temperature=${this.modelConfig.enforceTemperature}, overriding provided value`,
        {
          originalTemperature: normalizedParams.temperature,
          forcedTemperature: this.modelConfig.enforceTemperature,
        }
      );
      normalizedParams.temperature = this.modelConfig.enforceTemperature;
    }

    // Model-specific disallow max_tokens
    if (this.modelConfig.disallowMaxTokens && 'max_tokens' in normalizedParams) {
      logger.warn(`Model ${normalizedParams.model} does not allow max_tokens, removing parameter`);
      delete (normalizedParams as any).max_tokens;
    }

    // Ensure max_tokens doesn't exceed model limit
    if (
      normalizedParams.max_tokens &&
      normalizedParams.max_tokens > this.modelConfig.maxTokensLimit
    ) {
      logger.warn(
        `max_tokens (${normalizedParams.max_tokens}) exceeds model limit (${this.modelConfig.maxTokensLimit}), capping value`
      );
      normalizedParams.max_tokens = this.modelConfig.maxTokensLimit;
    }

    // Handle streaming support
    if (normalizedParams.stream && !this.providerConfig.supportsStreaming) {
      logger.warn(
        `Provider ${this.providerConfig.name} doesn't support streaming, disabling stream mode`
      );
      normalizedParams.stream = false;
    }

    return normalizedParams;
  }

  /**
   * Create a chat completion with provider-specific handling
   */
  async createChatCompletion(
    params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    try {
      // Normalize parameters for the provider
      const normalizedParams = this.normalizeParameters(params);

      logger.info('Creating chat completion', {
        provider: this.providerConfig.name,
        model: normalizedParams.model,
        messagesCount: normalizedParams.messages.length,
        maxTokens: normalizedParams.max_tokens,
        temperature: normalizedParams.temperature,
      });

      // Validate context before making API call
      try {
        validateDynamicSignal(normalizedParams.messages as Message[]);
        logger.debug('✅ Context validation passed', {
          messageCount: normalizedParams.messages.length,
          provider: this.providerConfig.name,
        });
      } catch (validationError) {
        if (validationError instanceof ValidationError) {
          logger.warn('🚫 Context validation failed, blocking API call', {
            error: validationError.message,
            code: validationError.structured.code,
            context: validationError.structured.context,
            suggestion: validationError.structured.suggestion,
          });

          // Return a structured error response instead of throwing
          throw new Error(
            `INSUFFICIENT_CONTEXT: ${validationError.message}. ${validationError.structured.suggestion || ''}`
          );
        }
        throw validationError;
      }

      // Make the API call
      const response = await this.client.chat.completions.create(normalizedParams);

      logger.info('Chat completion successful', {
        provider: this.providerConfig.name,
        model: normalizedParams.model,
        usage: 'usage' in response ? response.usage : undefined,
      });

      return response;
    } catch (error) {
      logger.error('Chat completion failed', {
        provider: this.providerConfig.name,
        model: params.model,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  /**
   * Create a streaming chat completion
   */
  async createChatCompletionStream(
    params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming
  ): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
    try {
      // Normalize parameters for the provider (streaming version)
      const normalizedParams = {
        ...params,
        stream: true,
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;

      logger.info('Creating streaming chat completion', {
        provider: this.providerConfig.name,
        model: normalizedParams.model,
        messagesCount: normalizedParams.messages.length,
      });

      // Validate context before making streaming API call
      try {
        validateDynamicSignal(normalizedParams.messages as Message[]);
        logger.debug('✅ Streaming context validation passed', {
          messageCount: normalizedParams.messages.length,
          provider: this.providerConfig.name,
        });
      } catch (validationError) {
        if (validationError instanceof ValidationError) {
          logger.warn('🚫 Streaming context validation failed, blocking API call', {
            error: validationError.message,
            code: validationError.structured.code,
            context: validationError.structured.context,
            suggestion: validationError.structured.suggestion,
          });

          throw new Error(
            `INSUFFICIENT_CONTEXT: ${validationError.message}. ${validationError.structured.suggestion || ''}`
          );
        }
        throw validationError;
      }

      // Make the streaming API call
      return await this.client.chat.completions.create(normalizedParams);
    } catch (error) {
      logger.error('Streaming chat completion failed', {
        provider: this.providerConfig.name,
        model: params.model,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  /**
   * Get current provider information
   */
  getProviderInfo(): {
    provider: string;
    model: string;
    miniModel: string;
    supportsStreaming: boolean;
  } {
    return {
      provider: this.providerConfig.name,
      model: this.config.model || this.providerConfig.defaultModel,
      miniModel: this.config.miniModel || this.providerConfig.defaultMiniModel,
      supportsStreaming: this.providerConfig.supportsStreaming || false,
    };
  }

  /**
   * Get the appropriate model based on complexity needs
   */
  getModelForTask(task: 'base' | 'mini' = 'base'): string {
    if (task === 'base') {
      return this.config.model || this.providerConfig.defaultModel;
    } else {
      return this.config.miniModel || this.providerConfig.defaultMiniModel;
    }
  }

  /**
   * Get embeddings model name
   */
  getEmbeddingsModel(): string {
    return (
      this.config.embeddingsModel ||
      process.env.OPENAI_EMBEDDINGS_MODEL ||
      this.providerConfig.defaultEmbeddingsModel ||
      'text-embedding-3-large'
    );
  }

  /**
   * Validate if the current configuration is ready for use
   */
  isReady(): boolean {
    return !!this.client && !!this.config.apiKey;
  }

  /**
   * Get the underlying OpenAI client
   */
  getClient(): OpenAI | null {
    return this.isReady() ? this.client : null;
  }

  /**
   * Dispose of resources
   */
  async dispose(): Promise<void> {
    // Close any open connections
    (this.client as any) = undefined;
    logger.info('OpenAI Service disposed');
  }
}

// Factory function for easier instantiation
export function createOpenAIService(config: OpenAIServiceConfig): OpenAIService {
  return new OpenAIService(config);
}

// Lazy-loaded singleton instance
let _openaiServiceInstance: OpenAIService | null = null;

/**
 * Get the OpenAI service instance, creating it lazily if needed
 */
export function getOpenAIService(): OpenAIService {
  if (!_openaiServiceInstance) {
    _openaiServiceInstance = new OpenAIService({
      apiKey: process.env.OPENAI_API_KEY || '',
      provider: (process.env.OPENAI_PROVIDER as ProviderType) || 'openai',
      model: process.env.OPENAI_BASE_MODEL,
      miniModel: process.env.OPENAI_MINI_MODEL,
      embeddingsModel: process.env.OPENAI_EMBEDDINGS_MODEL,
      baseUrl: process.env.OPENAI_BASE_URL,
    });
  }
  return _openaiServiceInstance;
}

/**
 * Reset the OpenAI service instance (useful for testing)
 */
export function resetOpenAIService(): void {
  _openaiServiceInstance = null;
}

// Export the service getter for backward compatibility
export const openaiService = {
  get instance() {
    return getOpenAIService();
  },
  // Delegate all methods to the lazy-loaded instance
  createChatCompletion: (...args: Parameters<OpenAIService['createChatCompletion']>) =>
    getOpenAIService().createChatCompletion(...args),
  createChatCompletionStream: (...args: Parameters<OpenAIService['createChatCompletionStream']>) =>
    getOpenAIService().createChatCompletionStream(...args),
  getProviderInfo: () => getOpenAIService().getProviderInfo(),
  getModelForTask: (...args: Parameters<OpenAIService['getModelForTask']>) =>
    getOpenAIService().getModelForTask(...args),
  getEmbeddingsModel: () => getOpenAIService().getEmbeddingsModel(),
  isReady: () => getOpenAIService().isReady(),
  getClient: () => getOpenAIService().getClient(),
  quickProbe: (...args: Parameters<OpenAIService['quickProbe']>) =>
    getOpenAIService().quickProbe(...args),
  dispose: () => getOpenAIService().dispose(),
};

export default OpenAIService;
