/**
 * @fileOverview: Enhanced semantic compactor with local embedding support for improved context generation
 * @module: EnhancedSemanticCompactor
 * @keyFunctions:
 *   - generateEnhancedContext(): Context generation with embedding-based similarity search
 *   - ensureEmbeddings(): Generate embeddings if needed and enabled
 *   - searchSimilarContent(): Find relevant code using embedding similarity
 *   - hybridContextGeneration(): Combine AST analysis with embedding search
 * @dependencies:
 *   - semanticCompactor: Core semantic compaction functionality
 *   - embeddingGenerator: Local embedding generation service
 *   - embeddingStorage: SQLite-based embedding persistence
 * @context: Enhances the existing semantic compaction with embedding-based similarity search for more relevant context when local storage is enabled
 */

import { logger } from '../utils/logger';
import { LocalEmbeddingGenerator, GenerationOptions } from './embeddingGenerator';
import { LocalEmbeddingStorage, SimilarChunk } from './embeddingStorage';
import { semanticCompactor } from '../core/compactor/semanticCompactor';
import { ProjectIdentifier } from './projectIdentifier';
import { openaiService } from '../core/openaiService';

export interface EnhancedContextOptions {
  projectPath: string;
  maxTokens?: number;
  query?: string;
  taskType?: 'debug' | 'implement' | 'understand' | 'refactor';
  format?: 'xml' | 'structured' | 'compact' | 'enhanced';

  // Embedding options
  useEmbeddings?: boolean;
  embeddingSimilarityThreshold?: number;
  maxSimilarChunks?: number;
  generateEmbeddingsIfMissing?: boolean;
  embeddingOptions?: GenerationOptions;
}

export interface EnhancedContextResult {
  content: string;
  metadata: {
    totalFiles: number;
    includedFiles: number;
    tokenCount: number;
    compressionRatio: number;
    embeddingsUsed: boolean;
    similarChunksFound: number;
    embeddingStats?: {
      totalEmbeddings: number;
      searchTime: number;
    };
  };
}

export class EnhancedSemanticCompactor {
  private embeddingGenerator: LocalEmbeddingGenerator;
  private embeddingStorage: LocalEmbeddingStorage;
  private projectIdentifier: ProjectIdentifier;

  constructor() {
    this.embeddingGenerator = new LocalEmbeddingGenerator();
    this.embeddingStorage = new LocalEmbeddingStorage();
    this.projectIdentifier = new ProjectIdentifier();
  }

  /**
   * Generate enhanced context with optional embedding-based similarity search
   */
  async generateEnhancedContext(options: EnhancedContextOptions): Promise<EnhancedContextResult> {
    const startTime = Date.now();

    logger.info('🚀 Starting enhanced context generation', {
      projectPath: options.projectPath,
      query: options.query || '(no query)',
      useEmbeddings: options.useEmbeddings !== false && LocalEmbeddingStorage.isEnabled(),
      taskType: options.taskType || 'understand',
    });

    try {
      // Get project info
      const projectInfo = await this.projectIdentifier.identifyProject(options.projectPath);
      const projectId = projectInfo.id;

      // First, generate standard semantic compaction
      let baseContext: any = null;
      try {
        logger.debug('🔧 Starting base semantic compaction', {
          projectPath: options.projectPath,
          maxTokens: options.maxTokens,
        });

        baseContext = await semanticCompactor.compactProject(options.projectPath, {
          maxTokens: options.maxTokens,
          maxTotalTokens: options.maxTokens,
          includeSourceCode: false,
          includeDocstrings: true,
        });

        logger.debug('✅ Base semantic compaction completed', {
          hasBaseContext: !!baseContext,
          hasCompactedContent: !!baseContext?.compactedContent,
          hasProcessingStats: !!baseContext?.processingStats,
          processingStatsKeys: baseContext?.processingStats
            ? Object.keys(baseContext.processingStats)
            : [],
          totalTokens: baseContext?.totalTokens,
          compressionRatio: baseContext?.compressionRatio,
        });
      } catch (error) {
        logger.warn('⚠️ Standard semantic compaction failed, continuing with embeddings only', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      logger.debug('🏗️ Building initial result object', {
        baseContextExists: !!baseContext,
        baseProcessingStats: baseContext?.processingStats,
        totalFiles: baseContext?.processingStats?.totalFiles,
        filesProcessed: baseContext?.processingStats?.filesProcessed,
        totalTokens: baseContext?.totalTokens,
        compressionRatio: baseContext?.compressionRatio,
      });

      // Generate fallback content if base context failed
      const fallbackContent =
        baseContext?.compactedContent ||
        `# Context Generation Notice

No context could be generated from the project at: ${options.projectPath}

This might happen if:
- The directory contains too many files
- No supported code files were found  
- File access permissions are restrictive

Try using a more specific directory or check the project path.`;

      let result: EnhancedContextResult = {
        content: fallbackContent,
        metadata: {
          totalFiles: baseContext?.processingStats?.totalFiles || 0,
          includedFiles: baseContext?.processingStats?.filesProcessed || 0,
          tokenCount: baseContext?.totalTokens || fallbackContent.length,
          compressionRatio: baseContext?.compressionRatio || 1,
          embeddingsUsed: false,
          similarChunksFound: 0,
        },
      };

      logger.debug('✅ Initial result object created', {
        contentLength: result.content.length,
        metadata: result.metadata,
      });

      // If embeddings are enabled and we have a query, enhance with similarity search
      logger.debug('🔍 Checking embedding enhancement conditions', {
        useEmbeddingsOption: options.useEmbeddings,
        useEmbeddingsCondition: options.useEmbeddings !== false,
        localStorageEnabled: LocalEmbeddingStorage.isEnabled(),
        hasQuery: !!options.query,
        willEnhance:
          options.useEmbeddings !== false && LocalEmbeddingStorage.isEnabled() && !!options.query,
      });

      if (options.useEmbeddings !== false && LocalEmbeddingStorage.isEnabled() && options.query) {
        logger.debug('🚀 Starting embedding enhancement', {
          projectId,
          query: options.query,
          baseContextType: typeof baseContext,
          baseContextNull: baseContext === null,
          baseContextUndefined: baseContext === undefined,
        });

        try {
          const enhancedResult = await this.enhanceWithEmbeddings(projectId, options, baseContext);

          logger.debug('📊 Embedding enhancement result', {
            enhancedResultExists: !!enhancedResult,
            enhancedResultType: typeof enhancedResult,
            enhancedMetadata: enhancedResult?.metadata,
          });

          if (enhancedResult) {
            result = enhancedResult;
            logger.debug('✅ Using enhanced result', {
              finalMetadata: result.metadata,
            });
          }
        } catch (error) {
          logger.warn('⚠️ Embedding enhancement failed, using base context', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
        }
      }

      const totalTime = Date.now() - startTime;
      logger.info('✅ Enhanced context generation completed', {
        tokenCount: result.metadata.tokenCount,
        embeddingsUsed: result.metadata.embeddingsUsed,
        similarChunks: result.metadata.similarChunksFound,
        processingTime: `${totalTime}ms`,
      });

      return result;
    } catch (error) {
      logger.error('❌ Enhanced context generation failed', {
        error: error instanceof Error ? error.message : String(error),
        projectPath: options.projectPath,
      });
      throw error;
    }
  }

  /**
   * Enhance context using embedding similarity search
   */
  private async enhanceWithEmbeddings(
    projectId: string,
    options: EnhancedContextOptions,
    baseContext: any
  ): Promise<EnhancedContextResult | null> {
    const searchStart = Date.now();

    // Ensure embeddings exist
    await this.ensureEmbeddings(projectId, options.projectPath, options);

    // Get embeddings stats - check both current and legacy project IDs
    let stats = await this.embeddingStorage.getProjectStats(projectId);
    let actualProjectId = projectId;

    // If no embeddings found under current ID, try legacy ID (sha256/16)
    if (!stats || stats.totalChunks === 0) {
      const legacyProjectId = require('crypto')
        .createHash('sha256')
        .update(options.projectPath)
        .digest('hex')
        .substring(0, 16);
      const legacyStats = await this.embeddingStorage.getProjectStats(legacyProjectId);

      if (legacyStats && legacyStats.totalChunks > 0) {
        logger.info('🔄 Found embeddings under legacy project ID, using legacy data', {
          originalId: projectId,
          legacyId: legacyProjectId,
          legacyEmbeddings: legacyStats.totalChunks,
        });
        stats = legacyStats;
        actualProjectId = legacyProjectId;
      }
    }

    if (!stats || stats.totalChunks === 0) {
      logger.info('📭 No embeddings found for project', { projectId });
      return null;
    }

    // Check embedding model compatibility before searching
    const compatibility =
      await this.embeddingStorage.validateEmbeddingCompatibility(actualProjectId);
    if (!compatibility.compatible) {
      logger.warn('⚠️ Embedding model compatibility issue detected', {
        issues: compatibility.issues,
        recommendations: compatibility.recommendations,
      });

      // Provide agent-friendly guidance for this common issue
      logger.info('🔧 EMBEDDING COMPATIBILITY ISSUE - ACTION REQUIRED', {
        diagnosis: 'Stored embeddings use different model than current configuration',
        immediateAction: 'Call manage_embeddings (action="migrate") to fix this issue',
        toolSequence: [
          '1. manage_embeddings {"action": "status", "projectPath": "your_project_path"}',
          '2. manage_embeddings {"action": "migrate", "projectPath": "your_project_path", "force": true}',
          '3. Retry your original query',
        ],
        commonCause: 'Switching between local (Xenova) and cloud (OpenAI) embedding providers',
        estimatedFixTime: '1-10 minutes depending on project size',
      });

      // Still try the search, but warn user about potential poor results
      logger.warn(
        '🔍 Proceeding with similarity search despite compatibility issues - results may be suboptimal'
      );
    }

    logger.info('🔍 Searching for similar content using embeddings', {
      query: options.query,
      totalEmbeddings: stats.totalChunks,
      modelCompatible: compatibility.compatible,
    });

    // Generate query embedding using same model as stored embeddings (if possible)
    const queryEmbedding = await this.embeddingGenerator.generateQueryEmbedding(
      options.query!,
      actualProjectId
    );

    // Search for similar chunks
    const similarChunks = await this.embeddingStorage.searchSimilarEmbeddings(
      actualProjectId,
      queryEmbedding,
      options.maxSimilarChunks || 10,
      options.embeddingSimilarityThreshold || 0.2
    );

    const searchTime = Date.now() - searchStart;

    if (similarChunks.length === 0) {
      logger.info('🔍 No similar chunks found above threshold', {
        threshold: options.embeddingSimilarityThreshold || 0.7,
      });

      // If no chunks found and we have compatibility issues, provide specific guidance
      if (!compatibility.compatible) {
        logger.error('❌ SIMILARITY SEARCH FAILED - MODEL COMPATIBILITY ISSUE', {
          problem: 'No chunks found above similarity threshold',
          rootCause: "Query embedding model doesn't match stored embedding model",
          immediateFix:
            'Call manage_embeddings (action="migrate") to regenerate embeddings with current model',
          toolCalls: [
            'manage_embeddings {"action": "status", "projectPath": "your_project_path"}',
            'manage_embeddings {"action": "migrate", "projectPath": "your_project_path", "force": true, "batchSize": 20}',
            'Retry your original AI context query',
          ],
          expectedResult: 'Similarity search will work and return relevant context',
        });
      }

      return null;
    }

    // Sort and limit chunks first
    const maxChunks = options.maxSimilarChunks || 10;
    const sortedChunks = similarChunks
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, maxChunks);

    // Combine base context with similar chunks
    logger.debug('🔗 Combining base context with similar chunks', {
      baseContextExists: !!baseContext,
      baseContextType: typeof baseContext,
      baseContextContent: baseContext?.compactedContent?.length || 0,
      baseProcessingStats: baseContext?.processingStats,
      similarChunksCount: similarChunks.length,
      sortedChunksCount: sortedChunks.length,
    });

    const enhancedContent = await this.combineContextWithSimilarChunks(
      baseContext?.compactedContent || '',
      sortedChunks,
      options
    );

    logger.debug('🏗️ Building enhanced result metadata', {
      baseContext_exists: !!baseContext,
      baseContext_processingStats: baseContext?.processingStats,
      totalFiles_raw: baseContext?.processingStats?.totalFiles,
      filesProcessed_raw: baseContext?.processingStats?.filesProcessed,
      totalTokens_raw: baseContext?.totalTokens,
      compressionRatio_raw: baseContext?.compressionRatio,
    });

    // Calculate approximate token count for the focused results
    const focusedTokenCount = Math.ceil(enhancedContent.length / 4); // Rough token estimation

    const enhancedResult = {
      content: enhancedContent,
      metadata: {
        totalFiles: sortedChunks.length, // Number of files represented in chunks
        includedFiles: sortedChunks.length,
        tokenCount: focusedTokenCount,
        compressionRatio: baseContext?.totalTokens
          ? focusedTokenCount / baseContext.totalTokens
          : 1,
        embeddingsUsed: true,
        similarChunksFound: similarChunks.length,
        embeddingStats: {
          totalEmbeddings: stats.totalChunks,
          searchTime,
          chunksShown: sortedChunks.length,
          avgSimilarity:
            sortedChunks.length > 0
              ? sortedChunks.reduce((sum: number, chunk: any) => sum + chunk.similarity, 0) /
                sortedChunks.length
              : 0,
        },
      },
    };

    logger.debug('✅ Enhanced result created successfully', {
      contentLength: enhancedResult.content.length,
      metadata: enhancedResult.metadata,
    });

    return enhancedResult;
  }

  /**
   * Ensure embeddings exist for the project
   */
  private async ensureEmbeddings(
    projectId: string,
    projectPath: string,
    options: EnhancedContextOptions
  ): Promise<void> {
    // Proceed with generation as long as local storage is enabled
    if (!LocalEmbeddingStorage.isEnabled()) {
      logger.info('💡 Embedding generation not available - local storage disabled');
      return;
    }

    // Check if embeddings exist
    const stats = await this.embeddingStorage.getProjectStats(projectId);

    if (!stats && options.generateEmbeddingsIfMissing !== false) {
      logger.info('🏗️ Generating embeddings for project (first time)', { projectId });

      const progress = await this.embeddingGenerator.generateProjectEmbeddings(
        projectId,
        projectPath,
        {
          batchSize: 10,
          rateLimit: 1000,
          maxChunkSize: 1500,
          ...options.embeddingOptions,
        }
      );

      logger.info('✅ Initial embedding generation completed', {
        projectId,
        embeddings: progress.embeddings,
        chunks: progress.totalChunks,
        files: progress.totalFiles,
        errors: progress.errors.length,
      });
    } else if (stats) {
      logger.debug('📊 Using existing embeddings', {
        projectId,
        totalChunks: stats.totalChunks,
        totalFiles: stats.totalFiles,
        lastUpdated: stats.lastUpdated,
      });
    }
  }

  /**
   * Generate focused context from similar chunks (already sorted and limited)
   * When we have good embedding matches, return ONLY the top relevant chunks
   */
  private async combineContextWithSimilarChunks(
    baseContent: string,
    sortedChunks: SimilarChunk[],
    options: EnhancedContextOptions
  ): Promise<string> {
    const format = options.format || 'structured';

    // Instead of adding to base context, return ONLY the relevant chunks
    logger.debug('🎯 Generating focused embedding results', {
      chunksToProcess: sortedChunks.length,
      format,
      avgSimilarity:
        sortedChunks.length > 0
          ? (
              sortedChunks.reduce((sum, chunk) => sum + chunk.similarity, 0) / sortedChunks.length
            ).toFixed(3)
          : 0,
    });

    // Generate content with ONLY the relevant chunks
    let enhancedContent = '';

    if (format === 'xml') {
      // XML format - focused embedding results only
      const similarChunksXml = sortedChunks
        .map(
          item => `
    <relevant_chunk similarity="${item.similarity.toFixed(3)}" file="${item.chunk.filePath}" lines="${item.chunk.metadata.startLine}-${item.chunk.metadata.endLine}">
      <content>${this.escapeXml(item.chunk.content)}</content>
      <symbols>${item.chunk.metadata.symbols?.join(', ') || ''}</symbols>
    </relevant_chunk>`
        )
        .join('\n');

      enhancedContent = `<?xml version="1.0" encoding="UTF-8"?>
<focused_context>
  <query>${this.escapeXml(options.query || '')}</query>
  <similarity_threshold>${options.embeddingSimilarityThreshold || 0.2}</similarity_threshold>
  <chunks_shown>${sortedChunks.length}</chunks_shown>
  <results>${similarChunksXml}
  </results>
</focused_context>`;
    } else if (format === 'structured') {
      // Structured format - focused embedding results only
      enhancedContent =
        `# 🎯 Focused Context Results

## Query Information
- **Query:** "${options.query || 'N/A'}"
- **Similarity Threshold:** ${(options.embeddingSimilarityThreshold || 0.2) * 100}%
- **Chunks Shown:** ${sortedChunks.length} (most relevant)

## Relevant Code Sections
` +
        sortedChunks
          .map(
            (item, index) => `
### ${index + 1}. ${item.chunk.filePath} (${(item.similarity * 100).toFixed(1)}% similar)
**Lines:** ${item.chunk.metadata.startLine}-${item.chunk.metadata.endLine} | **Language:** ${item.chunk.metadata.language || 'unknown'}
${item.chunk.metadata.symbols?.length ? `**Symbols:** ${item.chunk.metadata.symbols.join(', ')}\n` : ''}
\`\`\`${item.chunk.metadata.language || 'text'}
${item.chunk.content}
\`\`\``
          )
          .join('\n');
    } else if (format === 'enhanced' || format === 'compact') {
      // Enhanced/Compact format - focused results with smart chunk limiting
      // Use maxSimilarChunks from options, or default to 10 for enhanced, 5 for compact
      const maxDisplayChunks = format === 'compact' ? 5 : options.maxSimilarChunks || 10;
      const displayChunks = Math.min(sortedChunks.length, maxDisplayChunks);

      enhancedContent =
        `🎯 FOCUSED RESULTS | Query: "${options.query || 'N/A'}" | Threshold: ${(options.embeddingSimilarityThreshold || 0.2) * 100}%\n` +
        `Showing ${displayChunks} most relevant chunks:\n\n` +
        sortedChunks
          .slice(0, displayChunks)
          .map(
            (item, index) =>
              `${index + 1}. ${item.chunk.filePath}:${item.chunk.metadata.startLine} (${(item.similarity * 100).toFixed(0)}%)\n${item.chunk.content}`
          )
          .join('\n---\n');
    } else {
      // Fallback to structured format for unknown formats
      enhancedContent =
        `# 🎯 Focused Context Results

## Query Information
- **Query:** "${options.query || 'N/A'}"
- **Similarity Threshold:** ${(options.embeddingSimilarityThreshold || 0.2) * 100}%
- **Chunks Shown:** ${sortedChunks.length} (most relevant)

## Relevant Code Sections
` +
        sortedChunks
          .map(
            (item, index) => `
### ${index + 1}. ${item.chunk.filePath} (${(item.similarity * 100).toFixed(1)}% similar)
**Lines:** ${item.chunk.metadata.startLine}-${item.chunk.metadata.endLine} | **Language:** ${item.chunk.metadata.language || 'unknown'}
${item.chunk.metadata.symbols?.length ? `**Symbols:** ${item.chunk.metadata.symbols.join(', ')}\n` : ''}
\`\`\`${item.chunk.metadata.language || 'text'}
${item.chunk.content}
\`\`\``
          )
          .join('\n');
    }

    return enhancedContent;
  }

  /**
   * Escape XML special characters
   */
  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Get embedding statistics for a project
   */
  async getEmbeddingStats(projectPath: string): Promise<{
    hasEmbeddings: boolean;
    totalChunks: number;
    totalFiles: number;
    lastUpdated?: Date;
  } | null> {
    if (!LocalEmbeddingStorage.isEnabled()) {
      return null;
    }

    try {
      const projectInfo = await this.projectIdentifier.identifyProject(projectPath);
      const stats = await this.embeddingStorage.getProjectStats(projectInfo.id);

      if (stats) {
        return {
          hasEmbeddings: true,
          totalChunks: stats.totalChunks,
          totalFiles: stats.totalFiles,
          lastUpdated: stats.lastUpdated,
        };
      }

      return {
        hasEmbeddings: false,
        totalChunks: 0,
        totalFiles: 0,
      };
    } catch (error) {
      logger.error('❌ Failed to get embedding stats', {
        error: error instanceof Error ? error.message : String(error),
        projectPath,
      });
      return null;
    }
  }

  /**
   * Check if enhanced context generation is available
   */
  static isEnhancedModeAvailable(): boolean {
    return LocalEmbeddingStorage.isEnabled();
  }
}

// Export default instance
export const enhancedSemanticCompactor = new EnhancedSemanticCompactor();
