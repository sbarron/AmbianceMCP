/**
 * Local embedding provider using Transformers.js for offline embedding generation
 * Provides fallback when OpenAI API key is not available
 */

import { pipeline } from '@xenova/transformers';
import { logger } from '../utils/logger';

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

      // Load the feature extraction pipeline
      this.pipeline = await pipeline('feature-extraction', this.model, {
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
      return [];
    }

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

      // Truncate texts that are too long
      const truncatedTexts = validTexts.map(text =>
        text.length > this.config.maxLength * 4 // Rough char to token ratio
          ? text.substring(0, this.config.maxLength * 4)
          : text
      );

      // Generate embeddings
      const embeddings = await this.pipeline(truncatedTexts, {
        pooling: this.config.pooling,
        normalize: this.config.normalize,
      });

      // Convert to our standard format
      const results: EmbeddingResult[] = [];

      for (let i = 0; i < validTexts.length; i++) {
        const embedding = Array.from(embeddings[i].data as Float32Array);

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
