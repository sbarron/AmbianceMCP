/**
 * @fileOverview: Token Parameter Utilities for AI Tools
 * @module: TokenUtils
 * @keyFunctions:
 *   - determineTokenParameter: Choose between max_tokens (legacy) and max_completion_tokens (new)
 *   - buildApiRequest: Build API request with appropriate token parameter
 * @context: Handles compatibility between deprecated max_tokens and new max_completion_tokens
 */

import { logger } from '../../../utils/logger';

/**
 * Determine which token parameter to use based on the model
 */
export function determineTokenParameter(model: string): 'max_tokens' | 'max_completion_tokens' {
  // Legacy models that still use max_tokens
  const isLegacyModel =
    model.includes('gpt-3.5') ||
    model.includes('text-') ||
    model.includes('davinci') ||
    model.includes('curie') ||
    model.includes('babbage') ||
    model.includes('ada') ||
    model.includes('claude-') || // Anthropic models
    model.includes('gemini-') || // Google models
    model.includes('command-') || // Cohere models
    model.includes('qwen-'); // Qwen models

  return isLegacyModel ? 'max_tokens' : 'max_completion_tokens';
}

/**
 * Build API request with appropriate token parameter
 */
export function buildApiRequest(
  model: string,
  messages: any[],
  maxTokens: number,
  temperature: number = 0.3,
  additionalParams: Record<string, any> = {}
): any {
  const tokenParam = determineTokenParameter(model);

  logger.info('🔍 Token parameter selection', {
    model,
    isLegacyModel: tokenParam === 'max_tokens',
    usingParameter: tokenParam,
    tokenValue: maxTokens,
  });

  const apiRequest: any = {
    model,
    messages,
    temperature,
    ...additionalParams,
  };

  // Add the appropriate token parameter
  apiRequest[tokenParam] = maxTokens;

  return apiRequest;
}
