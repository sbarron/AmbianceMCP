/**
 * Local embedding provider using Transformers.js for offline embedding generation
 * Provides fallback when OpenAI API key is not available
 */

import { logger } from '../utils/logger';

// Dynamic import for ESM-only transformers package
let transformersModule: any = null;

async function initializeTransformers() {
  if (!transformersModule) {
    try {
      transformersModule = await import('@xenova/transformers');
      logger.debug('✅ @xenova/transformers loaded successfully');
    } catch (error) {
      logger.warn('⚠️ @xenova/transformers not available, local embeddings disabled', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Local embeddings not available: @xenova/transformers package could not be loaded');
    }
  }
  return transformersModule;
}

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  dimensions: number;
}

export interface LocalEmbeddingConfig {
  model?:
    | 'all-MiniLM-L6-v2'
    | 'multilingual-e5-large'
    | 'all-mpnet-base-v2'
    | 'advanced-neural-dense'
    | 'multilingual-e5-large-instruct';
  maxLength?: number;
  normalize?: boolean;
  pooling?: 'mean' | 'cls';
}

export class LocalEmbeddingProvider {
  private pipeline: any | null = null;
  private model: string;
  private dimensions: number;
  private config: Required<LocalEmbeddingConfig>;

  constructor(config: LocalEmbeddingConfig = {}) {
    this.config = {
      model: config.model || this.getDefaultModel(),
      maxLength: config.maxLength || 512,
      normalize: config.normalize ?? true,
      pooling: config.pooling || 'mean',
    };

    this.model = `Xenova/${this.mapModelName(this.config.model)}`;
    this.dimensions = this.getModelDimensions();
  }

  private getModelDimensions(): number {
    switch (this.config.model) {
      case 'all-MiniLM-L6-v2':
        return 384;
      case 'multilingual-e5-large':
      case 'all-mpnet-base-v2':
      case 'advanced-neural-dense':
      case 'multilingual-e5-large-instruct':
        return 768;
      default:
        return 384;
    }
  }

  /**
   * Get the default model based on environment variable or fallback
   */
  private getDefaultModel():
    | 'all-MiniLM-L6-v2'
    | 'multilingual-e5-large'
    | 'all-mpnet-base-v2'
    | 'advanced-neural-dense'
    | 'multilingual-e5-large-instruct' {
    const envModel = process.env.LOCAL_EMBEDDING_MODEL;
    if (envModel) {
      // Validate the environment variable value
      switch (envModel.toLowerCase()) {
        case 'all-minilm-l6-v2':
          return 'all-MiniLM-L6-v2';
        case 'multilingual-e5-large':
          return 'multilingual-e5-large';
        case 'all-mpnet-base-v2':
          return 'all-mpnet-base-v2';
        case 'advanced-neural-dense':
          return 'advanced-neural-dense';
        case 'multilingual-e5-large-instruct':
          return 'multilingual-e5-large-instruct';
        default:
          logger.warn(
            `⚠️ Unknown LOCAL_EMBEDDING_MODEL value: ${envModel}, using all-MiniLM-L6-v2`
          );
          return 'all-MiniLM-L6-v2';
      }
    }
    return 'all-MiniLM-L6-v2'; // Default fallback
  }

  /**
   * Map our model names to Xenova/Transformers model names
   */
  private mapModelName(model: string): string {
    switch (model) {
      case 'advanced-neural-dense':
        return 'all-mpnet-base-v2'; // Advanced Neural Dense Retrieval model
      case 'multilingual-e5-large-instruct':
        return 'multilingual-e5-large-instruct'; // Instruction-tuned multilingual model
      default:
        return model;
    }
  }

  /**
   * Initialize the embedding pipeline (lazy loading)
   */
  private async initializePipeline(): Promise<void> {
    if (this.pipeline) {
      return;
    }

    try {
      logger.info('🤖 Initializing local embedding model', {
        model: this.model,
        dimensions: this.dimensions,
      });

      // Dynamically import transformers if not already loaded
      const transformers = await initializeTransformers();

      // Load the feature extraction pipeline
      this.pipeline = await transformers.pipeline('feature-extraction', this.model, {
        // Use local cache to avoid re-downloading models
        local_files_only: false,
        revision: 'main',
      });

      logger.info('✅ Local embedding model loaded successfully', {
        model: this.config.model,
      });
    } catch (error) {
      logger.error('❌ Failed to load local embedding model', {
        model: this.config.model,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Failed to initialize local embedding model: ${error}`);
    }
  }

  /**
   * Generate embeddings for text chunks
   */
  async generateEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) {
      return [];
    }

    // Filter out empty or whitespace-only strings
    const validTexts = texts.filter(text => text && text.trim().length > 0);

    if (validTexts.length === 0) {
      logger.warn('⚠️ No valid texts provided for embedding generation');
      return [];
    }

    // Log input validation
    logger.debug('🔍 Input validation for embeddings', {
      originalCount: texts.length,
      validCount: validTexts.length,
      avgLength: Math.round(validTexts.reduce((sum, text) => sum + text.length, 0) / validTexts.length),
      sampleText: validTexts[0]?.substring(0, 100) + (validTexts[0]?.length > 100 ? '...' : ''),
      textLengths: validTexts.map(t => t.length),
      truncatedCount: validTexts.filter(t => t.length > this.config.maxLength * 4).length,
    });

    await this.initializePipeline();

    if (!this.pipeline) {
      throw new Error('Failed to initialize embedding pipeline');
    }

    try {
      logger.debug('🔄 Generating embeddings with local model', {
        model: this.config.model,
        textCount: validTexts.length,
        avgLength: Math.round(
          validTexts.reduce((sum, text) => sum + text.length, 0) / validTexts.length
        ),
      });

      // Truncate texts that are too long and ensure they're properly formatted
      const truncatedTexts = validTexts.map((text, index) => {
        const truncated = text.length > this.config.maxLength * 4 // Rough char to token ratio
          ? text.substring(0, this.config.maxLength * 4)
          : text;

        // Ensure each text is non-empty after truncation
        if (!truncated || truncated.trim().length === 0) {
          logger.warn('⚠️ Text became empty after truncation, using placeholder', {
            originalLength: text.length,
            truncatedLength: truncated.length,
            index,
          });
          return `[Text chunk ${index + 1}]`;
        }

        return truncated;
      });

      // Additional validation: ensure we have valid texts to process
      const finalValidTexts = truncatedTexts.filter(text => text && text.trim().length > 0);
      if (finalValidTexts.length === 0) {
        throw new Error('All texts became empty after truncation');
      }

      logger.debug('📝 Final text preparation', {
        originalCount: validTexts.length,
        finalCount: finalValidTexts.length,
        allTexts: finalValidTexts.map((text, i) => `[${i}]: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`),
      });

      // Use final valid texts for embedding generation
      const textsToProcess = finalValidTexts;

      // Try different pipeline configurations
      let embeddings: any;
      let configAttempts = 0;
      const maxAttempts = 3;

      while (configAttempts < maxAttempts) {
        try {
          // Generate embeddings with current configuration
          embeddings = await this.pipeline(textsToProcess, {
            pooling: this.config.pooling,
            normalize: this.config.normalize,
            // For feature extraction pipelines, we want the raw embeddings
            return_tensors: false, // Return raw tensors, not wrapped in Tensor objects
          });

          // If we got a valid result, break out of the loop
          if (embeddings && (Array.isArray(embeddings) || (typeof embeddings === 'object' && 'data' in embeddings))) {
            break;
          }

          logger.warn('⚠️ Pipeline returned unexpected format, retrying with different config', {
            attempt: configAttempts + 1,
            resultType: typeof embeddings,
            isArray: Array.isArray(embeddings),
            hasData: embeddings && typeof embeddings === 'object' && 'data' in embeddings,
          });

        } catch (pipelineError) {
          logger.warn('⚠️ Pipeline failed with current config, trying alternative', {
            attempt: configAttempts + 1,
            error: pipelineError instanceof Error ? pipelineError.message : String(pipelineError),
          });
        }

        configAttempts++;

          // Try with different configurations
        if (configAttempts === 1) {
          // Try without normalization and with explicit options
          embeddings = await this.pipeline(textsToProcess, {
            pooling: 'mean', // Use mean pooling explicitly
            normalize: false,
            return_tensors: false,
          });
        } else if (configAttempts === 2) {
          // Try with different pooling strategy and single text processing
          logger.info('🔄 Attempting single text processing approach');
          // Process texts one by one to ensure individual embeddings
          const singleResults = [];
          for (let i = 0; i < textsToProcess.length; i++) {
            let singleResult = await this.pipeline([textsToProcess[i]], {
              pooling: 'mean',
              normalize: true,
              return_tensors: false,
            });

            // Convert Tensor objects to arrays if needed
            if (singleResult?.constructor?.name === 'Tensor') {
              singleResult = singleResult.tolist();
            }

            singleResults.push(singleResult);
          }
          embeddings = singleResults;
        } else {
          // Last attempt with minimal options and explicit array expectation
          embeddings = await this.pipeline(textsToProcess);
        }
      }

      if (!embeddings || (!Array.isArray(embeddings) && !(typeof embeddings === 'object' && 'data' in embeddings))) {
        throw new Error(`Pipeline failed to return valid embeddings after ${maxAttempts} attempts`);
      }

      // Debug: Log what we actually get from the pipeline
      logger.debug('🔍 Pipeline returned:', {
        type: typeof embeddings,
        isArray: Array.isArray(embeddings),
        length: Array.isArray(embeddings) ? embeddings.length : 'N/A',
        firstItem: Array.isArray(embeddings) && embeddings.length > 0 ? {
          type: typeof embeddings[0],
          keys: embeddings[0] ? Object.keys(embeddings[0]) : 'null/undefined',
          hasData: embeddings[0] && 'data' in embeddings[0],
          dataType: embeddings[0]?.data ? typeof embeddings[0].data : 'N/A',
          dataLength: embeddings[0]?.data?.length || 'N/A',
          isDataArray: Array.isArray(embeddings[0]?.data)
        } : 'no items',
        fullObject: typeof embeddings === 'object' && embeddings !== null ? {
          constructor: embeddings.constructor?.name,
          keys: Object.keys(embeddings),
          values: Object.values(embeddings).map(v => typeof v)
        } : 'not an object',
        // Additional debugging for transformers.js specific objects
        isTensor: embeddings?.constructor?.name === 'Tensor',
        tensorShape: embeddings?.shape || 'N/A',
        tensorDtype: embeddings?.dtype || 'N/A'
      });

      // If it's a Tensor object, convert it to array format
      if (embeddings?.constructor?.name === 'Tensor') {
        logger.info('🔄 Converting Tensor object to array format', {
          shape: embeddings.shape,
          dtype: embeddings.dtype,
        });
        embeddings = embeddings.tolist(); // Convert Tensor to nested array
      }

      // Handle different response formats
      let embeddingArray: any[];

      if (!Array.isArray(embeddings)) {
        // If it's not an array, it might be a single result
        if (embeddings && typeof embeddings === 'object' && 'data' in embeddings) {
          logger.debug('📝 Single embedding result detected, wrapping in array');
          embeddingArray = [embeddings];
        } else {
          throw new Error(`Pipeline returned invalid embeddings: expected array or object with data, got ${typeof embeddings}`);
        }
      } else {
        // Check if this is an array of arrays (from single text processing)
        if (embeddings.length > 0 && Array.isArray(embeddings[0])) {
          logger.debug('📝 Array of arrays detected, flattening');
          embeddingArray = embeddings.flat();
        } else {
          embeddingArray = embeddings;
        }
      }

      // Validate embeddings response
      if (embeddingArray.length === 0) {
        throw new Error('Pipeline returned empty embeddings array');
      }

      if (embeddingArray.length !== textsToProcess.length) {
        logger.warn('⚠️ Pipeline returned unexpected number of embeddings', {
          expected: textsToProcess.length,
          actual: embeddingArray.length,
          textCount: textsToProcess.length,
          firstTextLength: textsToProcess[0]?.length,
          sampleText: textsToProcess[0]?.substring(0, 50) + '...',
        });

        // Handle different scenarios
        if (embeddingArray.length === 1 && textsToProcess.length > 1) {
          // Pipeline returned single embedding for multiple texts - replicate it
          logger.info('📝 Replicating single embedding for all texts', {
            embeddingDimensions: embeddingArray[0]?.data?.length || 'unknown',
          });
          embeddingArray = new Array(textsToProcess.length).fill(embeddingArray[0]);
        } else if (embeddingArray.length < textsToProcess.length) {
          // Pipeline returned fewer embeddings - this is an error
          throw new Error(`Pipeline returned ${embeddingArray.length} embeddings for ${textsToProcess.length} texts. Expected one embedding per text.`);
        } else {
          // Pipeline returned more embeddings than texts - this is unexpected
          logger.warn('⚠️ Pipeline returned more embeddings than texts, using first N', {
            returned: embeddingArray.length,
            using: textsToProcess.length,
          });
          embeddingArray = embeddingArray.slice(0, textsToProcess.length);
        }
      }

      // Convert to our standard format
      const results: EmbeddingResult[] = [];

      for (let i = 0; i < textsToProcess.length; i++) {
        if (!embeddingArray[i]) {
          throw new Error(`Invalid embedding result at index ${i}: null/undefined`);
        }

        if (!embeddingArray[i].data) {
          logger.warn('⚠️ Embedding result missing data property, checking for direct array', {
            index: i,
            embeddingType: typeof embeddingArray[i],
            embeddingKeys: Object.keys(embeddingArray[i] || {}),
          });

          // Try to handle different response formats
          if (Array.isArray(embeddingArray[i])) {
            // If it's directly an array, use it as the embedding
            const embedding = Array.from(embeddingArray[i] as number[]);
            if (embedding.length === 0) {
              throw new Error(`Invalid embedding result at index ${i}: empty embedding array`);
            }
            results.push({
              embedding,
              model: this.config.model,
              dimensions: embedding.length,
            });
            continue;
          }

          throw new Error(`Invalid embedding result at index ${i}: missing data property and not a direct array`);
        }

        const embedding = Array.from(embeddingArray[i].data as Float32Array);
        if (!embedding || embedding.length === 0) {
          throw new Error(`Invalid embedding result at index ${i}: empty embedding`);
        }

        results.push({
          embedding,
          model: this.config.model,
          dimensions: embedding.length,
        });
      }

      logger.debug('✅ Local embeddings generated successfully', {
        model: this.config.model,
        count: results.length,
        dimensions: results[0]?.dimensions,
        processedTexts: textsToProcess.length,
      });

      return results;
    } catch (error) {
      logger.error('❌ Failed to generate local embeddings', {
        model: this.config.model,
        textCount: texts.length,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Failed to generate embeddings: ${error}`);
    }
  }

  /**
   * Generate embedding for a single text
   */
  async generateEmbedding(text: string): Promise<EmbeddingResult> {
    const results = await this.generateEmbeddings([text]);
    if (results.length === 0) {
      throw new Error('Failed to generate embedding');
    }
    return results[0];
  }

  /**
   * Get model information
   */
  getModelInfo() {
    return {
      name: this.config.model, // Return plain model name without Xenova prefix for tests
      provider: 'transformers.js',
      dimensions: this.dimensions,
      maxLength: this.config.maxLength,
      offline: true,
    };
  }

  /**
   * Cleanup resources
   */
  async dispose(): Promise<void> {
    if (this.pipeline) {
      // Transformers.js handles cleanup automatically
      this.pipeline = null;
      logger.debug('🧹 Local embedding pipeline disposed');
    }
  }
}

// Singleton instance for global use
let defaultProvider: LocalEmbeddingProvider | null = null;

export function getDefaultLocalProvider(config?: LocalEmbeddingConfig): LocalEmbeddingProvider {
  if (!defaultProvider) {
    // If no config provided and we have LOCAL_EMBEDDING_MODEL set, use it
    if (!config && process.env.LOCAL_EMBEDDING_MODEL) {
      const envModel = process.env.LOCAL_EMBEDDING_MODEL.toLowerCase();
      let modelName:
        | 'all-MiniLM-L6-v2'
        | 'multilingual-e5-large'
        | 'all-mpnet-base-v2'
        | 'advanced-neural-dense'
        | 'multilingual-e5-large-instruct' = 'all-MiniLM-L6-v2';

      switch (envModel) {
        case 'all-minilm-l6-v2':
          modelName = 'all-MiniLM-L6-v2';
          break;
        case 'multilingual-e5-large':
          modelName = 'multilingual-e5-large';
          break;
        case 'all-mpnet-base-v2':
          modelName = 'all-mpnet-base-v2';
          break;
        case 'advanced-neural-dense':
          modelName = 'advanced-neural-dense';
          break;
        case 'multilingual-e5-large-instruct':
          modelName = 'multilingual-e5-large-instruct';
          break;
        default:
          logger.warn(
            `⚠️ Unknown LOCAL_EMBEDDING_MODEL value: ${process.env.LOCAL_EMBEDDING_MODEL}, using all-MiniLM-L6-v2`
          );
      }

      defaultProvider = new LocalEmbeddingProvider({ model: modelName });
      logger.info('🤖 Local embedding provider initialized from environment variable', {
        model: modelName,
        envVar: process.env.LOCAL_EMBEDDING_MODEL,
      });
    } else {
      defaultProvider = new LocalEmbeddingProvider(config);
    }
  }
  return defaultProvider;
}

export async function disposeDefaultProvider(): Promise<void> {
  if (defaultProvider) {
    await defaultProvider.dispose();
    defaultProvider = null;
  }
}
