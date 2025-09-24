/**
 * @fileOverview: Local embedding generation with Ambiance API integration
 * @module: EmbeddingGenerator
 * @keyFunctions:
 *   - generateEmbeddings(): Generate embeddings for project files via Ambiance API
 *   - chunkContent(): Intelligent code chunking for optimal embeddings
 *   - batchEmbeddings(): Efficient batch processing with rate limiting
 *   - updateProjectEmbeddings(): Incremental embedding updates
 * @dependencies:
 *   - apiClient: Ambiance API client for embedding generation
 *   - openai: OpenAI API when explicitly enabled
 *   - localEmbeddingProvider: Local Transformers.js models (offline fallback)
 *   - embeddingStorage: Local SQLite storage for persistence
 *   - treeSitterProcessor: AST-based chunking and symbol extraction
 * @context: Provides intelligent embedding generation with explicit provider selection: Local Models → OpenAI (explicit) → VoyageAI (explicit) → Error
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { OpenAI } from 'openai';
import { logger } from '../utils/logger';
import { LocalEmbeddingStorage, EmbeddingChunk, FileMetadata } from './embeddingStorage';
import { TreeSitterProcessor } from './treeSitterProcessor';
import { openaiService } from '../core/openaiService';
import { apiClient } from '../client/apiClient';
import {
  LocalEmbeddingProvider,
  getDefaultLocalProvider,
  EmbeddingResult,
} from './localEmbeddingProvider';

/**
 * Simple semaphore implementation for concurrency control
 */
class Semaphore {
  private permits: number;
  private waiting: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    return new Promise(resolve => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    this.permits++;
    if (this.waiting.length > 0) {
      const resolve = this.waiting.shift()!;
      this.permits--;
      resolve();
    }
  }
}

export interface ChunkingOptions {
  maxChunkSize?: number; // Maximum characters per chunk
  overlapSize?: number; // Overlap between chunks for context
  preferSymbolBoundaries?: boolean; // Try to chunk at symbol boundaries
  includeContext?: boolean; // Include surrounding context in chunks
}

export interface GenerationProgress {
  totalFiles: number;
  processedFiles: number;
  totalChunks: number;
  processedChunks: number;
  embeddings: number;
  errors: string[];
  currentFile?: string;
}

export interface GenerationOptions extends ChunkingOptions {
  force?: boolean; // Force regeneration even if embeddings exist
  batchSize?: number; // Number of embeddings to generate per batch
  rateLimit?: number; // Milliseconds between batches
  filePatterns?: string[]; // File patterns to include
  autoMigrate?: boolean; // Automatically clear incompatible embeddings on model change
  parallelMode?: boolean; // Enable parallel processing of batches (default: false for compatibility)
  maxConcurrency?: number; // Maximum number of concurrent API calls (default: 10, respecting OpenAI limits)
}

export class LocalEmbeddingGenerator {
  private openai: OpenAI | null = null;
  private localProvider: LocalEmbeddingProvider | null = null;
  private storage: LocalEmbeddingStorage;
  private treeSitter: TreeSitterProcessor | null = null;
  private embeddingModel: string;
  private ambianceApiKey?: string;

  // Provider failure tracking (resets on restart)
  private static providerFailures: Map<string, { count: number; lastFailure: Date }> = new Map();
  private static readonly MAX_FAILURES = 3;
  private static readonly FAILURE_RESET_TIME = 60 * 60 * 1000; // 1 hour

  // Rate limit tracking for dynamic concurrency adjustment
  private static rateLimitTracker: Map<
    string,
    { hits: number; lastHit: Date; currentConcurrency: number }
  > = new Map();
  private static readonly RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
  private static readonly MAX_RATE_LIMIT_HITS = 3;

  constructor(storage?: LocalEmbeddingStorage) {
    // Use provided storage or create with quantization enabled
    this.storage = storage || new LocalEmbeddingStorage(undefined, true);
    this.embeddingModel = process.env.OPENAI_EMBEDDINGS_MODEL || 'text-embedding-3-large';
    this.ambianceApiKey = process.env.AMBIANCE_API_KEY;

    // Initialize providers based on explicit user preferences
    const openaiEnabled = process.env.USE_OPENAI_EMBEDDINGS === 'true';
    const voyageAIEnabled = false; // VoyageAI is no longer supported

    // Initialize OpenAI client if explicitly enabled and API key is available
    if (openaiEnabled && openaiService.isReady()) {
      this.openai = openaiService.getClient();
      logger.info('🤖 Embedding generator initialized with OpenAI (explicitly enabled)', {
        model: this.embeddingModel,
      });
    }

    // Initialize Ambiance API client if explicitly enabled and API key is available
    if (voyageAIEnabled && this.ambianceApiKey) {
      logger.info('🚀 Embedding generator initialized with VoyageAI (explicitly enabled)', {
        hasApiKey: true,
        model: process.env.VOYAGEAI_MODEL || 'voyageai-model', // Handled by server
      });
    }

    // Local embeddings are always available as default fallback
    logger.info('✅ Local embedding provider (transformers.js) available as default');

    // Initialize TreeSitter for intelligent chunking
    try {
      this.treeSitter = new TreeSitterProcessor();
      logger.debug('🌳 TreeSitter initialized for intelligent chunking');
    } catch (error) {
      logger.warn('⚠️ TreeSitter initialization failed - using simple chunking', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check if a provider is currently available (not in failure state)
   */
  private static isProviderAvailable(providerName: string): boolean {
    const failure = LocalEmbeddingGenerator.providerFailures.get(providerName);
    if (!failure) return true;

    // Reset failures after timeout
    const now = new Date();
    if (
      now.getTime() - failure.lastFailure.getTime() >
      LocalEmbeddingGenerator.FAILURE_RESET_TIME
    ) {
      LocalEmbeddingGenerator.providerFailures.delete(providerName);
      logger.info(`🔄 Reset failure count for provider: ${providerName}`);
      return true;
    }

    return failure.count < LocalEmbeddingGenerator.MAX_FAILURES;
  }

  /**
   * Record a provider failure
   */
  private static recordProviderFailure(providerName: string): void {
    const failure = LocalEmbeddingGenerator.providerFailures.get(providerName) || {
      count: 0,
      lastFailure: new Date(),
    };
    failure.count += 1;
    failure.lastFailure = new Date();
    LocalEmbeddingGenerator.providerFailures.set(providerName, failure);

    if (failure.count >= LocalEmbeddingGenerator.MAX_FAILURES) {
      logger.warn(
        `🚫 Provider ${providerName} disabled after ${failure.count} failures. Will retry after 1 hour.`
      );
    } else {
      logger.warn(
        `⚠️ Provider ${providerName} failure ${failure.count}/${LocalEmbeddingGenerator.MAX_FAILURES}`
      );
    }
  }

  /**
   * Record a rate limit hit and adjust concurrency if needed
   */
  private static recordRateLimitHit(providerName: string, currentConcurrency: number): number {
    const tracker = LocalEmbeddingGenerator.rateLimitTracker.get(providerName) || {
      hits: 0,
      lastHit: new Date(),
      currentConcurrency,
    };

    tracker.hits += 1;
    tracker.lastHit = new Date();

    // Reset hit count if it's been more than the window
    const now = new Date();
    if (now.getTime() - tracker.lastHit.getTime() > LocalEmbeddingGenerator.RATE_LIMIT_WINDOW) {
      tracker.hits = 1;
    }

    // Reduce concurrency if we've hit rate limits multiple times
    if (tracker.hits >= LocalEmbeddingGenerator.MAX_RATE_LIMIT_HITS) {
      const newConcurrency = Math.max(1, Math.floor(currentConcurrency / 2));
      tracker.currentConcurrency = newConcurrency;

      logger.warn(`📉 Reducing concurrency due to rate limits`, {
        provider: providerName,
        oldConcurrency: currentConcurrency,
        newConcurrency,
        rateLimitHits: tracker.hits,
      });
    }

    LocalEmbeddingGenerator.rateLimitTracker.set(providerName, tracker);
    return tracker.currentConcurrency;
  }

  /**
   * Get recommended concurrency for a provider
   */
  private static getRecommendedConcurrency(
    providerName: string,
    defaultConcurrency: number
  ): number {
    const tracker = LocalEmbeddingGenerator.rateLimitTracker.get(providerName);
    if (!tracker) return defaultConcurrency;

    // Reset if window has passed
    const now = new Date();
    if (now.getTime() - tracker.lastHit.getTime() > LocalEmbeddingGenerator.RATE_LIMIT_WINDOW) {
      LocalEmbeddingGenerator.rateLimitTracker.delete(providerName);
      return defaultConcurrency;
    }

    return tracker.currentConcurrency;
  }

  /**
   * Get expected dimensions for a provider
   */
  private getExpectedDimensions(providerName: string): number {
    switch (providerName) {
      case 'voyageai':
        return 1024; // VoyageAI model dimensions
      case 'openai':
        return this.embeddingModel === 'text-embedding-3-large'
          ? 3072
          : this.embeddingModel === 'text-embedding-3-small'
            ? 1536
            : this.embeddingModel === 'text-embedding-ada-002'
              ? 1536
              : 3072;
      case 'local':
        return this.localProvider?.getModelInfo().dimensions || 384;
      default:
        return 384;
    }
  }

  /**
   * Generate embeddings for an entire project
   */
  async generateProjectEmbeddings(
    projectId: string,
    projectPath: string,
    options: GenerationOptions = {}
  ): Promise<GenerationProgress> {
    if (!LocalEmbeddingStorage.isEnabled()) {
      throw new Error('Local embeddings not enabled - set USE_LOCAL_EMBEDDINGS=true');
    }

    await this.storage.initializeDatabase();

    // Check for model changes and handle migration
    await this.handleModelChangeDetection(projectId, options);

    // Determine current provider and expected dimensions
    const currentProvider = this.getCurrentProvider();
    const expectedDimensions = this.getExpectedDimensions(currentProvider);

    // Ensure database can handle current provider's dimensions
    try {
      await this.storage.ensureDimensionCompatibility(expectedDimensions);
    } catch (error) {
      logger.error('❌ Database dimension compatibility check failed', {
        provider: currentProvider,
        expectedDimensions,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const progress: GenerationProgress = {
      totalFiles: 0,
      processedFiles: 0,
      totalChunks: 0,
      processedChunks: 0,
      embeddings: 0,
      errors: [],
    };

    try {
      // Get list of files to process
      const files = await this.getProjectFiles(projectPath, options.filePatterns);
      progress.totalFiles = files.length;

      const batchSize =
        options.batchSize || parseInt(process.env.EMBEDDING_BATCH_SIZE || '', 10) || 32;
      const parallelMode = options.parallelMode || process.env.EMBEDDING_PARALLEL_MODE === 'true';
      const maxConcurrency =
        options.maxConcurrency || parseInt(process.env.EMBEDDING_MAX_CONCURRENCY || '', 10) || 10;

      logger.info('🚀 Starting embedding generation', {
        projectId,
        totalFiles: files.length,
        options: {
          force: options.force,
          batchSize,
          maxChunkSize: options.maxChunkSize || 2000,
          parallelMode,
          maxConcurrency: parallelMode ? maxConcurrency : undefined,
          provider: this.getCurrentProvider(),
        },
      });

      for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
        const filePath = files[fileIdx];
        try {
          progress.currentFile = path.relative(projectPath, filePath);
          logger.info('Processing file', {
            file: progress.currentFile,
            index: fileIdx + 1,
            remaining: files.length - fileIdx - 1,
            total: files.length,
          });

          // Check if we should skip this file (unless forced)
          if (!options.force && (await this.shouldSkipFile(projectId, filePath))) {
            logger.debug('⏭️ Skipping unchanged file', { file: progress.currentFile });
            progress.processedFiles++;
            continue;
          }

          const fileProgress = await this.generateFileEmbeddings(
            projectId,
            filePath,
            projectPath,
            options
          );

          progress.processedChunks += fileProgress.processedChunks;
          progress.totalChunks += fileProgress.totalChunks;
          progress.embeddings += fileProgress.embeddings;
          progress.errors.push(...fileProgress.errors);
          progress.processedFiles++;

          logger.info('📄 File processed', {
            file: progress.currentFile,
            chunks: fileProgress.totalChunks,
            embeddings: fileProgress.embeddings,
            progress: `${progress.processedFiles}/${progress.totalFiles}`,
          });

          // Rate limiting between files
          if (options.rateLimit && options.rateLimit > 0) {
            await this.delay(options.rateLimit);
          }
        } catch (error) {
          const errorMsg = `Failed to process ${filePath}: ${error instanceof Error ? error.message : String(error)}`;
          progress.errors.push(errorMsg);
          logger.error('❌ File processing failed', {
            file: filePath,
            error: errorMsg,
          });
          progress.processedFiles++;
        }
      }

      logger.info('✅ Local embedding generation completed', {
        projectId,
        totalFiles: progress.totalFiles,
        totalChunks: progress.totalChunks,
        embeddings: progress.embeddings,
        errors: progress.errors.length,
      });

      // Cloud upload disabled by policy: do not upload local embeddings
      logger.info('☑️ Skipping cloud embedding upload (disabled by policy)');
    } catch (error) {
      const errorMsg = `Project embedding generation failed: ${error instanceof Error ? error.message : String(error)}`;
      progress.errors.push(errorMsg);
      logger.error('❌ Project embedding generation failed', { error: errorMsg });
    }

    return progress;
  }

  /**
   * Generate embeddings for a single file
   */
  private async generateFileEmbeddings(
    projectId: string,
    filePath: string,
    projectPath: string,
    options: GenerationOptions
  ): Promise<GenerationProgress> {
    const content = fs.readFileSync(filePath, 'utf8');
    const relativePath = path.relative(projectPath, filePath);
    const language = this.getLanguageFromPath(filePath);

    // Store file metadata first
    const fileId = this.generateFileId(projectId, relativePath);
    const fileStats = fs.statSync(filePath);
    const fileHash = crypto.createHash('sha256').update(content).digest('hex');

    const fileMetadata: FileMetadata = {
      id: fileId,
      projectId,
      path: relativePath,
      hash: fileHash,
      lastModified: fileStats.mtime,
      fileSize: fileStats.size,
      language,
      lineCount: content.split('\n').length,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.storage.storeFileMetadata(fileMetadata);

    // Chunk the content
    const chunks = await this.chunkContent(content, filePath, options);

    const fileProgress: GenerationProgress = {
      totalFiles: 1,
      processedFiles: 0,
      totalChunks: chunks.length,
      processedChunks: 0,
      embeddings: 0,
      errors: [],
    };

    // Generate embeddings in batches
    const batchSize =
      options.batchSize || parseInt(process.env.EMBEDDING_BATCH_SIZE || '', 10) || 32;

    // Create batches
    const batches: string[][] = [];
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      batches.push(batch.map(chunk => chunk.content));
    }

    try {
      // Generate embeddings for all batches (parallel or sequential)
      const batchResults = await this.generateBatchesEmbeddings(batches, options);

      // Store embeddings from all batches
      let batchIndex = 0;
      for (const batchEmbeddings of batchResults) {
        const batch = chunks.slice(batchIndex * batchSize, (batchIndex + 1) * batchSize);

        // Store embeddings for this batch
        for (let j = 0; j < batch.length; j++) {
          const chunk = batch[j];
          const embedding = batchEmbeddings[j];

          // Determine embedding metadata based on current provider
          const currentProvider = this.getCurrentProvider();
          const embeddingMetadata = this.getEmbeddingMetadata(currentProvider, embedding);

          const embeddingChunk: EmbeddingChunk = {
            id: `${projectId}_${relativePath}_${chunk.index}`,
            projectId,
            fileId,
            filePath: relativePath,
            chunkIndex: chunk.index,
            content: chunk.content,
            embedding,
            metadata: {
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              language,
              symbols: chunk.symbols,
              type: chunk.type,
              ...embeddingMetadata,
            },
            hash: LocalEmbeddingStorage.generateContentHash(
              chunk.content,
              relativePath,
              chunk.index
            ),
            createdAt: new Date(),
            updatedAt: new Date(),
          };

          await this.storage.storeEmbedding(embeddingChunk);
          fileProgress.embeddings++;
        }

        fileProgress.processedChunks += batch.length;
        logger.debug('Batch stored', {
          file: relativePath,
          batchIndex: batchIndex + 1,
          batchSize: batch.length,
          processedChunks: fileProgress.processedChunks,
          totalChunks: fileProgress.totalChunks,
          mode: options.parallelMode ? 'parallel' : 'sequential',
        });

        batchIndex++;
      }
    } catch (error) {
      const errorMsg = `Failed to generate embeddings: ${error instanceof Error ? error.message : String(error)}`;
      fileProgress.errors.push(errorMsg);
      logger.error('❌ Embedding generation failed', {
        error: errorMsg,
        totalBatches: batches.length,
        mode: options.parallelMode ? 'parallel' : 'sequential',
      });
    }

    return fileProgress;
  }

  /**
   * Generate embeddings for multiple batches with parallel processing support
   */
  private async generateBatchesEmbeddings(
    batches: string[][],
    options: GenerationOptions = {}
  ): Promise<number[][][]> {
    const parallelMode = options.parallelMode || process.env.EMBEDDING_PARALLEL_MODE === 'true';
    let maxConcurrency =
      options.maxConcurrency || parseInt(process.env.EMBEDDING_MAX_CONCURRENCY || '', 10) || 10;

    // Adjust concurrency based on rate limit history
    const currentProvider = this.getCurrentProvider();
    maxConcurrency = LocalEmbeddingGenerator.getRecommendedConcurrency(
      currentProvider,
      maxConcurrency
    );

    if (parallelMode) {
      logger.info('🚀 Using parallel embedding generation mode', {
        batchCount: batches.length,
        maxConcurrency,
        provider: currentProvider,
        adjustedForRateLimits:
          maxConcurrency !==
          (options.maxConcurrency ||
            parseInt(process.env.EMBEDDING_MAX_CONCURRENCY || '', 10) ||
            10),
      });
      return await this.generateBatchesInParallel(batches, maxConcurrency);
    } else {
      logger.info('🔄 Using sequential embedding generation mode', {
        batchCount: batches.length,
        provider: currentProvider,
      });
      return await this.generateBatchesSequentially(batches);
    }
  }

  /**
   * Call OpenAI API with retry logic for rate limits
   */
  private async callOpenAIWithRetry(texts: string[], retryCount: number = 0): Promise<number[][]> {
    const maxRetries = parseInt(process.env.EMBEDDING_RATE_LIMIT_RETRIES || '', 10) || 5;
    const baseDelay = parseInt(process.env.EMBEDDING_RATE_LIMIT_BASE_DELAY || '', 10) || 1000;

    try {
      const response = await this.openai!.embeddings.create({
        model: this.embeddingModel,
        input: texts,
      });

      // Validate response
      if (!response || !response.data || !Array.isArray(response.data)) {
        throw new Error('Invalid OpenAI response: missing or invalid data array');
      }

      if (response.data.length === 0) {
        throw new Error('Invalid OpenAI response: empty data array');
      }

      const firstItem = response.data[0];
      if (!firstItem || !firstItem.embedding || !Array.isArray(firstItem.embedding)) {
        throw new Error(
          'Invalid OpenAI response: first item missing embedding or embedding is not an array'
        );
      }

      return response.data.map((item: any) => {
        if (!item || !item.embedding || !Array.isArray(item.embedding)) {
          throw new Error(
            'Invalid OpenAI response: item missing embedding or embedding is not an array'
          );
        }
        return item.embedding;
      });
    } catch (error: any) {
      const isRateLimit = error?.status === 429 || error?.message?.includes('Rate limit');
      const isServerError = error?.status >= 500;

      if ((isRateLimit || isServerError) && retryCount < maxRetries) {
        // Extract retry delay from error message or headers
        let retryAfter = baseDelay * Math.pow(2, retryCount); // Exponential backoff

        if (error?.message?.includes('Please try again in')) {
          const match = error.message.match(/Please try again in (\d+)ms/);
          if (match) {
            retryAfter = parseInt(match[1]) + 100; // Add small buffer
          }
        }

        // Cap retry delay at 30 seconds
        retryAfter = Math.min(retryAfter, 30000);

        logger.warn(
          `⏳ Rate limit hit, retrying in ${retryAfter}ms (attempt ${retryCount + 1}/${maxRetries})`,
          {
            provider: 'openai',
            error: isRateLimit ? 'rate_limit' : 'server_error',
            retryAfter,
            textsCount: texts.length,
            retryCount: retryCount + 1,
            maxRetries,
          }
        );

        await this.delay(retryAfter);
        return await this.callOpenAIWithRetry(texts, retryCount + 1);
      }

      // If it's a rate limit and we've exhausted retries, this is a temporary failure
      // Don't mark the provider as permanently failed, but record the rate limit hit
      if (isRateLimit) {
        const currentConcurrency = LocalEmbeddingGenerator.getRecommendedConcurrency('openai', 10);
        LocalEmbeddingGenerator.recordRateLimitHit('openai', currentConcurrency);

        throw new Error(`RATE_LIMIT_EXHAUSTED: ${error.message}`);
      }

      // For other errors (auth, model not found, etc.), mark as permanent failure
      throw error;
    }
  }

  /**
   * Generate embeddings for batches in parallel with concurrency control
   */
  private async generateBatchesInParallel(
    batches: string[][],
    maxConcurrency: number
  ): Promise<number[][][]> {
    const results: number[][][] = new Array(batches.length);
    const semaphore = new Semaphore(maxConcurrency);

    // Create promises for all batches
    const batchPromises = batches.map(async (batch, index) => {
      await semaphore.acquire();

      try {
        logger.debug(`🔄 Processing batch ${index + 1}/${batches.length} (parallel)`, {
          batchSize: batch.length,
          provider: this.getCurrentProvider(),
        });

        const embeddings = await this.generateBatchEmbeddings(batch);

        logger.debug(`✅ Batch ${index + 1}/${batches.length} completed`, {
          batchSize: batch.length,
          embeddingsCount: embeddings.length,
          provider: this.getCurrentProvider(),
        });

        results[index] = embeddings;
      } catch (error) {
        logger.error(`❌ Batch ${index + 1}/${batches.length} failed`, {
          batchSize: batch.length,
          error: error instanceof Error ? error.message : String(error),
          provider: this.getCurrentProvider(),
        });
        throw error;
      } finally {
        semaphore.release();
      }
    });

    // Wait for all batches to complete
    await Promise.allSettled(batchPromises);

    // Check for any failures and collect results
    const failures: string[] = [];
    const successfulResults: number[][][] = [];

    for (let i = 0; i < results.length; i++) {
      if (results[i] === undefined) {
        failures.push(`Batch ${i + 1} failed to complete`);
      } else {
        successfulResults.push(results[i]);
      }
    }

    if (failures.length > 0) {
      throw new Error(`Parallel processing failed: ${failures.join(', ')}`);
    }

    return successfulResults;
  }

  /**
   * Generate embeddings for batches sequentially (original behavior)
   */
  private async generateBatchesSequentially(batches: string[][]): Promise<number[][][]> {
    const results: number[][][] = [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];

      logger.debug(`🔄 Processing batch ${i + 1}/${batches.length} (sequential)`, {
        batchSize: batch.length,
        provider: this.getCurrentProvider(),
      });

      const embeddings = await this.generateBatchEmbeddings(batch);

      logger.debug(`✅ Batch ${i + 1}/${batches.length} completed`, {
        batchSize: batch.length,
        embeddingsCount: embeddings.length,
        provider: this.getCurrentProvider(),
      });

      results.push(embeddings);
    }

    return results;
  }

  /**
   * Generate embeddings for a batch of text chunks with provider fallback
   * Priority: Local Models → OpenAI (explicit) → VoyageAI (explicit) → Error
   */
  private async generateBatchEmbeddings(texts: string[]): Promise<number[][]> {
    // Validate and filter input texts
    const validTexts = texts.filter(text => {
      if (typeof text !== 'string') {
        logger.warn('⚠️ Skipping non-string text input', { type: typeof text });
        return false;
      }
      if (text.trim().length === 0) {
        logger.warn('⚠️ Skipping empty text input');
        return false;
      }
      return true;
    });

    if (validTexts.length === 0) {
      throw new Error('No valid texts provided for embedding generation');
    }

    // Provider priority: Local → OpenAI (explicit) → Error
    // VoyageAI/Ambiance API removed as service is no longer available
    const providers = [
      {
        name: 'openai',
        available: !!this.openai && LocalEmbeddingGenerator.isProviderAvailable('openai'),
        getEmbeddings: async (texts: string[]) => {
          if (!this.openai) {
            throw new Error('OpenAI client not initialized');
          }

          // Truncate texts for OpenAI limit
          const truncatedTexts = texts.map(text =>
            text.length > 8000 ? text.substring(0, 8000) : text
          );

          return await this.callOpenAIWithRetry(truncatedTexts);
        },
      },
      {
        name: 'local',
        available: true, // Always available as final fallback
        getEmbeddings: async (texts: string[]) => {
          if (!this.localProvider) {
            this.localProvider = getDefaultLocalProvider();
          }

          try {
            const results = await this.localProvider.generateEmbeddings(texts);
            return results.map(result => result.embedding);
          } catch (error) {
            logger.warn('⚠️ Primary local model failed, attempting fallback', {
              error: error instanceof Error ? error.message : String(error),
              primaryModel: this.localProvider?.getModelInfo().name || 'unknown',
            });

            // Dispose of the failed provider
            if (this.localProvider.dispose) {
              await this.localProvider.dispose();
            }

            // Try fallback with default model
            try {
              this.localProvider = getDefaultLocalProvider({
                model: 'all-MiniLM-L6-v2',
              });
              const fallbackResults = await this.localProvider.generateEmbeddings(texts);
              logger.info('✅ Local embedding fallback successful', {
                fallbackModel: this.localProvider.getModelInfo().name,
              });
              return fallbackResults.map(result => result.embedding);
            } catch (fallbackError) {
              logger.error('❌ Both primary and fallback local models failed', {
                primaryError: error instanceof Error ? error.message : String(error),
                fallbackError:
                  fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
              });
              throw fallbackError;
            }
          }
        },
      },
    ];

    for (const { name, available, getEmbeddings } of providers) {
      if (!available) {
        logger.debug(`⏭️ Skipping unavailable provider: ${name}`);
        continue;
      }

      try {
        logger.info(`🚀 Generating embeddings via ${name.toUpperCase()} API`, {
          textCount: validTexts.length,
          inputType: name === 'ambiance' ? 'document' : 'text',
          model:
            name === 'ambiance'
              ? process.env.VOYAGEAI_MODEL || 'voyageai-model'
              : name === 'openai'
                ? this.embeddingModel
                : name === 'local'
                  ? this.localProvider
                    ? this.localProvider.getModelInfo().name
                    : 'unknown'
                  : 'unknown',
          encodingFormat: name === 'ambiance' ? 'int8' : 'float32',
        });

        const embeddings = await getEmbeddings(validTexts);

        // Validate embeddings structure
        if (!Array.isArray(embeddings) || embeddings.length === 0) {
          throw new Error(`Invalid embeddings response from ${name}: not an array or empty`);
        }

        const firstEmbedding = embeddings[0];
        if (firstEmbedding === undefined) {
          throw new Error(`Invalid embeddings response from ${name}: first embedding is undefined`);
        }

        if (!Array.isArray(firstEmbedding) || firstEmbedding.length === 0) {
          throw new Error(`Invalid embedding format from ${name}: not a valid vector or empty`);
        }

        const expectedDimensions = this.getExpectedDimensions(name);
        const actualDimensions = firstEmbedding.length;

        // Check database compatibility for dimension changes
        if (actualDimensions !== expectedDimensions) {
          logger.warn(`⚠️ Unexpected embedding dimensions from ${name}`, {
            expected: expectedDimensions,
            actual: actualDimensions,
            provider: name,
          });

          // Update storage to handle new dimensions if needed
          try {
            await this.storage.ensureDimensionCompatibility(actualDimensions);
          } catch (storageError) {
            logger.error(`❌ Database cannot handle ${actualDimensions} dimensions`, {
              error: storageError instanceof Error ? storageError.message : String(storageError),
              provider: name,
            });
            throw new Error(
              `Database compatibility issue: ${storageError instanceof Error ? storageError.message : String(storageError)}`
            );
          }
        }

        // Validate int8 range for Ambiance API
        if (name === 'ambiance') {
          const hasInvalidRange = firstEmbedding.some((val: number) => val < -128 || val > 127);
          if (hasInvalidRange) {
            logger.error(`❌ Invalid int8 range in ${name} embeddings`, {
              min: Math.min(...firstEmbedding),
              max: Math.max(...firstEmbedding),
              provider: name,
            });
            throw new Error(`Embeddings contain values outside int8 range (-128 to 127)`);
          }
        }

        logger.info(`✅ Successfully generated embeddings with ${name}`, {
          textsCount: validTexts.length,
          embeddingsCount: embeddings.length,
          dimensions: actualDimensions,
          provider: name,
        });

        return embeddings;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isRateLimitExhausted = errorMessage.startsWith('RATE_LIMIT_EXHAUSTED');
        const isTemporaryFailure = isRateLimitExhausted || errorMessage.includes('Rate limit');

        // Only record permanent failures, not temporary rate limit issues
        if (!isTemporaryFailure) {
          LocalEmbeddingGenerator.recordProviderFailure(name);
        }

        logger.error(`❌ Embedding generation failed`, {
          textCount: validTexts.length,
          error: errorMessage,
          failureType: isTemporaryFailure ? 'temporary' : 'permanent',
          provider: name,
          stack: error instanceof Error ? error.stack : undefined,
        });

        // For rate limit exhaustion, add a longer delay before trying next provider
        if (isRateLimitExhausted) {
          logger.warn(`⏳ Rate limit exhausted for ${name}, waiting before fallback`, {
            provider: name,
            waitTime: '30s',
          });
          await this.delay(30000); // Wait 30 seconds before trying fallback
        }

        // Continue to next provider
        continue;
      }
    }

    // All providers failed
    const availableProviders = providers
      .map(p => `${p.name}: ${p.available ? 'available' : 'not available'}`)
      .join(', ');
    throw new Error(
      `Embedding generation failed with all providers. ` +
        `Available providers: ${availableProviders}. ` +
        `Check API keys, network connectivity, and provider configurations.`
    );
  }

  /**
   * Generate a single query embedding using the same model as stored embeddings
   * Falls back to current config if stored model is not accessible
   */
  async generateQueryEmbedding(text: string, projectId?: string): Promise<number[]> {
    if (!LocalEmbeddingStorage.isEnabled()) {
      throw new Error('Local embeddings not enabled - set USE_LOCAL_EMBEDDINGS=true');
    }

    // If projectId provided, try to use the same model as stored embeddings
    if (projectId) {
      try {
        // Get stored model info
        const storedModelInfo = await this.storage.getModelInfo(projectId);

        if (storedModelInfo) {
          const currentProvider = this.getCurrentProvider();
          const currentDimensions = this.getCurrentDimensions();

          // Check if current config matches stored model
          const configMatches =
            storedModelInfo.currentProvider === currentProvider &&
            storedModelInfo.currentDimensions === currentDimensions;

          if (!configMatches) {
            logger.info('🔄 Using stored embedding model for query (differs from current config)', {
              storedProvider: storedModelInfo.currentProvider,
              storedDimensions: storedModelInfo.currentDimensions,
              currentProvider,
              currentDimensions,
              recommendation:
                'Consider running manage_embeddings {"action": "migrate"} to update to the current model if desired',
            });

            // Try to temporarily switch to stored model for this query
            try {
              const storedEmbeddings = await this.generateWithSpecificModel(
                [text],
                storedModelInfo.currentProvider,
                storedModelInfo.currentDimensions
              );
              return storedEmbeddings[0];
            } catch (modelAccessError: any) {
              logger.warn(
                '⚠️ Cannot access stored embedding model, falling back to current config',
                {
                  storedProvider: storedModelInfo.currentProvider,
                  error: modelAccessError.message,
                  fallbackProvider: currentProvider,
                  suggestion:
                    'Consider regenerating embeddings with: manage_embeddings {"action": "migrate", "projectPath": "your_path", "force": true}',
                }
              );
            }
          } else {
            logger.debug('✅ Current config matches stored embedding model', {
              provider: currentProvider,
              dimensions: currentDimensions,
            });
          }
        }
      } catch (error: any) {
        logger.debug('Could not retrieve stored model info, using current config', {
          error: error.message,
        });
      }
    }

    // Fallback to current configuration
    const embeddings = await this.generateBatchEmbeddings([text]);
    return embeddings[0];
  }

  /**
   * Intelligent content chunking based on code structure
   */
  private async chunkContent(
    content: string,
    filePath: string,
    options: ChunkingOptions
  ): Promise<
    Array<{
      content: string;
      index: number;
      startLine: number;
      endLine: number;
      symbols?: string[];
      type: 'code' | 'comment' | 'docstring' | 'import' | 'export';
    }>
  > {
    const maxChunkSize = options.maxChunkSize || 2000;
    const overlapSize = options.overlapSize || 100;
    const preferSymbolBoundaries = options.preferSymbolBoundaries !== false;

    // Try TreeSitter-based chunking first
    if (this.treeSitter && preferSymbolBoundaries) {
      try {
        return await this.smartChunkContent(content, filePath, maxChunkSize);
      } catch (error) {
        logger.warn('⚠️ Smart chunking failed, falling back to simple chunking', {
          file: filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Fallback to simple line-based chunking
    return this.simpleChunkContent(content, maxChunkSize, overlapSize);
  }

  /**
   * Smart chunking using AST information
   */
  private async smartChunkContent(
    content: string,
    filePath: string,
    maxChunkSize: number
  ): Promise<
    Array<{
      content: string;
      index: number;
      startLine: number;
      endLine: number;
      symbols?: string[];
      type: 'code' | 'comment' | 'docstring' | 'import' | 'export';
    }>
  > {
    if (!this.treeSitter) {
      throw new Error('TreeSitter not initialized');
    }

    // Get AST analysis
    const parseResult = await this.treeSitter.parseAndChunk(
      content,
      this.getLanguageFromPath(filePath),
      filePath
    );
    const chunks: any[] = [];

    // Use the chunks returned by TreeSitter
    const astChunks = parseResult.chunks || [];

    for (let i = 0; i < astChunks.length; i++) {
      const astChunk = astChunks[i];

      if (astChunk.content.length <= maxChunkSize) {
        chunks.push({
          content: astChunk.content,
          index: i,
          startLine: astChunk.startLine,
          endLine: astChunk.endLine,
          symbols: astChunk.symbolName ? [astChunk.symbolName] : [],
          type: 'code' as const,
        });
      } else {
        // Split large chunks
        const subChunks = await this.simpleChunkContent(astChunk.content, maxChunkSize, 100);
        for (let j = 0; j < subChunks.length; j++) {
          const subChunk = subChunks[j];
          chunks.push({
            content: subChunk.content,
            index: chunks.length,
            startLine: astChunk.startLine + subChunk.startLine - 1,
            endLine: astChunk.startLine + subChunk.endLine - 1,
            symbols: astChunk.symbolName ? [astChunk.symbolName] : [],
            type: 'code' as const,
          });
        }
      }
    }

    return chunks.sort((a, b) => a.startLine - b.startLine);
  }

  /**
   * Simple line-based chunking with overlap
   */
  private simpleChunkContent(
    content: string,
    maxChunkSize: number,
    overlapSize: number
  ): Promise<
    Array<{
      content: string;
      index: number;
      startLine: number;
      endLine: number;
      type: 'code' | 'comment' | 'docstring' | 'import' | 'export';
    }>
  > {
    const lines = content.split('\n');
    const chunks: any[] = [];
    let chunkIndex = 0;
    let currentChunk = '';
    let startLine = 1;
    let currentLine = 1;

    for (const line of lines) {
      if (currentChunk.length + line.length + 1 > maxChunkSize && currentChunk.length > 0) {
        // Finish current chunk
        chunks.push({
          content: currentChunk.trim(),
          index: chunkIndex++,
          startLine,
          endLine: currentLine - 1,
          type: 'code' as const,
        });

        // Start new chunk with overlap
        const overlapLines = currentChunk.split('\n').slice(-Math.ceil(overlapSize / 50));
        currentChunk = overlapLines.join('\n') + '\n' + line;
        startLine = currentLine - overlapLines.length + 1;
      } else {
        currentChunk += (currentChunk ? '\n' : '') + line;
        if (!currentChunk.trim()) {
          startLine = currentLine + 1;
        }
      }
      currentLine++;
    }

    // Add final chunk
    if (currentChunk.trim()) {
      chunks.push({
        content: currentChunk.trim(),
        index: chunkIndex++,
        startLine,
        endLine: currentLine - 1,
        type: 'code' as const,
      });
    }

    return Promise.resolve(chunks);
  }

  /**
   * Extract lines from content
   */
  private extractLines(content: string, startLine: number, endLine: number): string {
    const lines = content.split('\n');
    return lines.slice(startLine - 1, endLine).join('\n');
  }

  /**
   * Get the current active provider name
   */
  private getCurrentProvider(): string {
    // Default to local opensource models (transformers.js)
    logger.info('🔧 Provider selection debug', {
      hasAmbianceApiKey: !!this.ambianceApiKey,
      hasOpenAI: !!this.openai,
      useOpenAI: process.env.USE_OPENAI_EMBEDDINGS,
      useVoyageAI: false, // VoyageAI is no longer supported
    });

    // Use OpenAI only if explicitly enabled and key is available
    if (this.openai && process.env.USE_OPENAI_EMBEDDINGS === 'true') {
      logger.info('✅ Using openai provider (explicitly enabled)');
      return 'openai';
    }

    // Use VoyageAI only if explicitly enabled and key is available
    // VoyageAI support removed as service is no longer available
    if (false) {
      logger.info('✅ Using voyageai provider (explicitly enabled)');
      return 'voyageai';
    }

    // Default to local opensource models (transformers.js)
    logger.info('✅ Using local provider (default)');
    return 'local';
  }

  private getCurrentDimensions(): number {
    // Return expected dimensions for current provider
    const provider = this.getCurrentProvider();
    switch (provider) {
      case 'voyageai':
        return 1024; // VoyageAI model dimensions
      case 'openai':
        return 1536; // OpenAI default dimensions
      case 'local':
        return this.localProvider?.getModelInfo().dimensions || 384; // transformers.js default
      default:
        return 1536;
    }
  }

  /**
   * Generate embeddings with a specific model (for query compatibility)
   */
  private async generateWithSpecificModel(
    texts: string[],
    provider: string,
    dimensions: number
  ): Promise<number[][]> {
    // This is a simplified implementation - in a full version, you'd need to:
    // 1. Temporarily configure the embedding service to use the specific provider
    // 2. Generate embeddings with that provider
    // 3. Restore original configuration

    // For now, throw an error to indicate the model is not accessible
    // This will trigger the fallback logic in generateQueryEmbedding
    throw new Error(
      `Cannot access stored embedding model: ${provider} (${dimensions}D). Current providers available: ${this.getCurrentProvider()}`
    );
  }

  /**
   * Get embedding metadata for the current provider
   */
  private getEmbeddingMetadata(
    provider: string,
    embedding: number[]
  ): {
    embeddingFormat?: 'float32' | 'int8';
    embeddingDimensions?: number;
    embeddingProvider?: string;
  } {
    const dimensions = embedding.length;

    switch (provider) {
      case 'voyageai':
        return {
          embeddingFormat: 'int8',
          embeddingDimensions: dimensions,
          embeddingProvider: 'voyageai',
        };
      case 'openai':
        return {
          embeddingFormat: 'float32',
          embeddingDimensions: dimensions,
          embeddingProvider: 'openai',
        };
      case 'local':
        return {
          embeddingFormat: 'float32',
          embeddingDimensions: dimensions,
          embeddingProvider: this.localProvider?.getModelInfo().name || 'transformers.js',
        };
      default:
        return {
          embeddingFormat: 'float32',
          embeddingDimensions: dimensions,
          embeddingProvider: provider,
        };
    }
  }

  /**
   * Check if file should be skipped (unchanged)
   */
  private async shouldSkipFile(projectId: string, filePath: string): Promise<boolean> {
    try {
      const stats = fs.statSync(filePath);
      const existingEmbeddings = await this.storage.getProjectEmbeddings(projectId);

      // Check if file has existing embeddings and hasn't been modified
      const fileEmbeddings = existingEmbeddings.filter(
        e => path.resolve(e.filePath) === path.resolve(filePath)
      );

      if (fileEmbeddings.length === 0) return false;

      // Check if file modified after last embedding
      const lastEmbedding = fileEmbeddings.reduce((latest, current) =>
        current.updatedAt > latest.updatedAt ? current : latest
      );

      return stats.mtime <= lastEmbedding.updatedAt;
    } catch {
      return false;
    }
  }

  /**
   * Get language from file path
   */
  private getLanguageFromPath(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const langMap: Record<string, string> = {
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.py': 'python',
      '.go': 'go',
      '.rs': 'rust',
      '.java': 'java',
      '.c': 'c',
      '.cpp': 'cpp',
      '.h': 'c',
      '.hpp': 'cpp',
      '.cs': 'csharp',
      '.php': 'php',
      '.rb': 'ruby',
      '.swift': 'swift',
      '.kt': 'kotlin',
      '.scala': 'scala',
      '.sh': 'bash',
      '.md': 'markdown',
      '.json': 'json',
      '.yaml': 'yaml',
      '.yml': 'yaml',
      '.xml': 'xml',
      '.html': 'html',
      '.css': 'css',
      '.sql': 'sql',
    };

    return langMap[ext] || 'text';
  }

  /**
   * Generate a unique file ID for the files table
   */
  private generateFileId(projectId: string, relativePath: string): string {
    const normalizedPath = relativePath.replace(/\\/g, '/');
    return crypto.createHash('md5').update(`${projectId}:${normalizedPath}`).digest('hex');
  }

  /**
   * Get project files matching patterns
   */
  private async getProjectFiles(projectPath: string, patterns?: string[]): Promise<string[]> {
    const { globby } = await import('globby');

    const defaultPatterns = [
      '**/*.{js,jsx,ts,tsx,py,go,rs,java,c,cpp,h,hpp,cs,php,rb,swift,kt,scala,sh}',
      '**/*.{md,json,yaml,yml,xml,html,css,sql}',
      '!node_modules/**',
      '!dist/**',
      '!build/**',
      '!.git/**',
      '!**/*.min.{js,css}',
    ];

    const searchPatterns = patterns && patterns.length > 0 ? patterns : defaultPatterns;

    let files = await globby(searchPatterns, {
      cwd: projectPath,
      absolute: true,
      ignore: ['node_modules/**', 'dist/**', 'build/**', '.git/**'],
    });

    // Additional safety filtering to ensure ignored directories are not processed
    const shouldIgnoreFile = (filePath: string): boolean => {
      const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
      return (
        normalizedPath.includes('/node_modules/') ||
        normalizedPath.includes('/dist/') ||
        normalizedPath.includes('/build/') ||
        normalizedPath.includes('/.git/') ||
        normalizedPath.includes('.min.') ||
        normalizedPath.includes('.test.') ||
        normalizedPath.includes('.spec.')
      );
    };

    const beforeFilterCount = files.length;
    files = files.filter(file => !shouldIgnoreFile(file));
    const filteredCount = beforeFilterCount - files.length;

    if (filteredCount > 0) {
      logger.debug(`🧹 Embedding generator filtered ${filteredCount} additional files`, {
        before: beforeFilterCount,
        after: files.length,
      });
    }

    return files;
  }

  /**
   * Simple delay utility for rate limiting
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Automatically upload embeddings to Ambiance cloud if API key is available
   */
  private async uploadEmbeddingsToCloud(
    projectId: string,
    progress: GenerationProgress
  ): Promise<void> {
    // No-op by policy
    logger.debug('ℹ️ uploadEmbeddingsToCloud is disabled (policy)');
    return;
  }

  /**
   * Cleanup resources
   */
  async dispose(): Promise<void> {
    if (this.localProvider) {
      await this.localProvider.dispose();
      this.localProvider = null;
    }
    if (this.treeSitter) {
      // TreeSitterProcessor doesn't need disposal
      this.treeSitter = null;
    }
  }

  /**
   * Handle model change detection and migration
   */
  private async handleModelChangeDetection(
    projectId: string,
    options: GenerationOptions
  ): Promise<void> {
    try {
      // Determine current model info based on available providers
      const currentProvider = this.getCurrentProvider();
      const currentDimensions = this.getCurrentDimensions();
      const currentFormat = this.ambianceApiKey ? 'int8' : 'float32';

      // Check for model changes
      const changeResult = await this.storage.checkModelChange(
        projectId,
        currentProvider,
        currentDimensions,
        currentFormat
      );

      if (changeResult.changed) {
        logger.warn('🔄 Embedding model change detected!', {
          projectId,
          previousModel: changeResult.previousModel?.currentProvider,
          currentModel: changeResult.currentModel.currentProvider,
          incompatibleEmbeddings: changeResult.incompatibleEmbeddings,
          migrationRecommended: changeResult.migrationRecommended,
        });

        if (changeResult.migrationRecommended) {
          // Always auto-migrate when model/provider changes - no user intervention needed
          logger.info('🚀 Starting automatic embedding migration due to model change', {
            projectId,
            reason: 'Provider or model dimensions changed',
            oldProvider: changeResult.previousModel?.currentProvider,
            newProvider: changeResult.currentModel.currentProvider,
            oldDimensions: changeResult.previousModel?.currentDimensions,
            newDimensions: changeResult.currentModel.currentDimensions,
          });

          await this.storage.clearProjectEmbeddings(projectId);

          logger.info('✅ Automatic migration completed - incompatible embeddings cleared', {
            projectId,
            clearedReason: 'Model/provider change detected',
          });
        }
      } else if (changeResult.currentModel.migrationNeeded) {
        logger.warn('⚠️ Previous migration was incomplete', {
          projectId,
          suggestion: 'Consider clearing embeddings and regenerating with current model',
        });
      }

      // Validate embedding compatibility and auto-fix if needed
      const compatibility = await this.storage.validateEmbeddingCompatibility(projectId);
      if (!compatibility.compatible) {
        logger.warn(
          '🚨 Embedding compatibility issues detected - auto-clearing incompatible data',
          {
            projectId,
            issues: compatibility.issues,
            recommendations: compatibility.recommendations,
          }
        );

        // Automatically clear incompatible embeddings
        await this.storage.clearProjectEmbeddings(projectId);

        logger.info('✅ Incompatible embeddings automatically cleared', {
          projectId,
          reason: 'Compatibility validation failed',
        });
      }
    } catch (error) {
      logger.error('❌ Model change detection failed', {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't fail the entire process, just log the error
    }
  }

  /**
   * Check if embedding generation is available
   */
  static isAvailable(): boolean {
    // Available if storage is enabled
    const storageEnabled = LocalEmbeddingStorage.isEnabled();
    if (!storageEnabled) return false;

    // Check if any provider is explicitly enabled and available
    const openaiEnabled =
      process.env.OPENAI_API_KEY && process.env.USE_OPENAI_EMBEDDINGS === 'true';
    const voyageAIEnabled = false; // VoyageAI is no longer supported

    const openaiReady = openaiEnabled && openaiService.isReady();
    const voyageAIReady = voyageAIEnabled; // Ambiance API key presence is sufficient
    const localAvailable = true; // Transformers.js is always available once installed

    return openaiReady || voyageAIReady || localAvailable;
  }
}

// Export default instance
export const embeddingGenerator = new LocalEmbeddingGenerator();
