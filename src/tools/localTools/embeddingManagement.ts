/**
 * @fileOverview: Consolidated embedding lifecycle management tool
 * @module: EmbeddingManagement
 * @keyFunctions:
 *   - manageEmbeddingsTool: Tool definition with action-driven interface
 *   - handleManageEmbeddings(): Dispatch to specific embedding operations
 *   - getEmbeddingStatus(): Shared helper for workspace configuration flows
 * @context: Central entry point for embedding health, migration, validation, and project maintenance tasks
 */

import { logger } from '../../utils/logger';
import { validateAndResolvePath } from '../utils/pathUtils';
import { LocalEmbeddingStorage } from '../../local/embeddingStorage';
import { LocalEmbeddingGenerator } from '../../local/embeddingGenerator';
import { ProjectIdentifier } from '../../local/projectIdentifier';
import {
  listProjectsWithEmbeddings,
  deleteProjectEmbeddings,
  getProjectEmbeddingDetails,
} from './projectManagement';
import * as crypto from 'crypto';

export type ManageEmbeddingsAction =
  | 'status'
  | 'health_check'
  | 'migrate'
  | 'validate'
  | 'list_projects'
  | 'delete_project'
  | 'project_details';

const SUPPORTED_ACTIONS: readonly ManageEmbeddingsAction[] = [
  'status',
  'health_check',
  'migrate',
  'validate',
  'list_projects',
  'delete_project',
  'project_details',
];

export interface ManageEmbeddingsRequest {
  action?: ManageEmbeddingsAction;
  projectPath?: string;
  projectIdentifier?: string;
  format?: 'structured' | 'compact' | 'detailed';
  autoFix?: boolean;
  maxFixTime?: number;
  force?: boolean;
  batchSize?: number;
  includeStats?: boolean;
  checkIntegrity?: boolean;
  confirmDeletion?: boolean;
}

interface ProjectResolution {
  projectPath: string;
  projectId: string;
  legacyProjectId: string;
}

export const manageEmbeddingsTool = {
  name: 'manage_embeddings',
  description: `Coordinate embedding lifecycle tasks with a single entry point.

**Actions**
- status: Inspect current/stored model configuration, stats, and recommendations.
- health_check: Run diagnostics with optional auto-fix for model mismatches.
- migrate: Clear and regenerate embeddings using the active model settings.
- validate: Inspect stored embeddings for compatibility issues and integrity problems.
- list_projects: Enumerate every project with stored embeddings.
- delete_project: Remove embeddings for a specific project (requires confirmDeletion=true).
- project_details: Deep dive into coverage, metadata, and compatibility for one project.

**Inputs**
- Set action to choose the workflow (defaults to status when a projectPath is supplied).
- Provide projectPath for workspace-level actions (status, health_check, migrate, validate).
- Use projectIdentifier for project-specific lookups (delete_project, project_details).
- Optional knobs like autoFix, batchSize, includeStats mirror legacy tool behaviour.

**Outputs**
- Returns structured results for the selected action without changing schema alignment with previous tools.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: SUPPORTED_ACTIONS,
        description: 'Embedding management action to perform',
        default: 'status',
      },
      projectPath: {
        type: 'string',
        description: 'Project root directory for workspace-level actions',
      },
      projectIdentifier: {
        type: 'string',
        description: 'Project ID, name, or path for project-level actions',
      },
      format: {
        type: 'string',
        enum: ['structured', 'compact', 'detailed'],
        description: 'Preferred output format for status action',
        default: 'structured',
      },
      autoFix: {
        type: 'boolean',
        description: 'Automatically attempt repairs during health_check',
        default: false,
      },
      maxFixTime: {
        type: 'number',
        minimum: 1,
        maximum: 60,
        description: 'Maximum minutes to spend on health_check auto-fixes',
        default: 15,
      },
      force: {
        type: 'boolean',
        description: 'Regenerate embeddings even when compatibility looks good',
        default: false,
      },
      batchSize: {
        type: 'number',
        minimum: 1,
        maximum: 50,
        description: 'Number of files to embed per batch during migration',
        default: 10,
      },
      includeStats: {
        type: 'boolean',
        description: 'Include statistics when validating embeddings',
        default: true,
      },
      checkIntegrity: {
        type: 'boolean',
        description: 'Perform deeper integrity checks during validation',
        default: false,
      },
      confirmDeletion: {
        type: 'boolean',
        description: 'Must be true to delete stored embeddings for a project',
        default: false,
      },
    },
    required: [],
  },
};

export async function handleManageEmbeddings(args: ManageEmbeddingsRequest): Promise<any> {
  const action = (args?.action || 'status') as ManageEmbeddingsAction;

  if (!SUPPORTED_ACTIONS.includes(action)) {
    throw new Error(`Unsupported manage_embeddings action: ${String(args?.action)}`);
  }

  try {
    switch (action) {
      case 'status': {
        const projectPath = requireProjectPath(args.projectPath);
        return await getEmbeddingStatus({ projectPath, format: args.format });
      }
      case 'health_check': {
        const projectPath = requireProjectPath(args.projectPath);
        return await runEmbeddingHealthCheck({
          projectPath,
          autoFix: args.autoFix,
          maxFixTime: args.maxFixTime,
        });
      }
      case 'migrate': {
        const projectPath = requireProjectPath(args.projectPath);
        return await migrateProjectEmbeddings({
          projectPath,
          force: args.force,
          batchSize: args.batchSize,
        });
      }
      case 'validate': {
        const projectPath = requireProjectPath(args.projectPath);
        return await validateProjectEmbeddings({
          projectPath,
          includeStats: args.includeStats,
          checkIntegrity: args.checkIntegrity,
        });
      }
      case 'list_projects':
        return await listProjectsWithEmbeddings();
      case 'delete_project': {
        if (!args.projectIdentifier) {
          throw new Error('projectIdentifier is required for delete_project action');
        }
        if (!args.confirmDeletion) {
          throw new Error('confirmDeletion must be true to delete project embeddings');
        }
        return await deleteProjectEmbeddings({
          projectIdentifier: args.projectIdentifier,
          confirmDeletion: args.confirmDeletion,
        });
      }
      case 'project_details': {
        if (!args.projectIdentifier) {
          throw new Error('projectIdentifier is required for project_details action');
        }
        return await getProjectEmbeddingDetails({
          projectIdentifier: args.projectIdentifier,
        });
      }
      default:
        throw new Error(`Unhandled manage_embeddings action: ${action}`);
    }
  } catch (error) {
    logger.error('manage_embeddings action failed', {
      action,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function getEmbeddingStatus(args: {
  projectPath: string;
  format?: 'structured' | 'compact' | 'detailed';
}): Promise<any> {
  const { projectPath, format = 'structured' } = args;

  const {
    projectId,
    legacyProjectId,
    projectPath: resolvedProjectPath,
  } = await resolveProject(projectPath);

  logger.info('Checking embedding model status', {
    projectPath: resolvedProjectPath,
    projectId,
    format,
  });

  try {
    const storage = new LocalEmbeddingStorage();

    const modelInfo = await storage.getModelInfo(projectId);
    const compatibility = await storage.validateEmbeddingCompatibility(projectId);
    const statsCurrent = await storage.getProjectStats(projectId);
    const statsLegacy =
      legacyProjectId !== projectId ? await storage.getProjectStats(legacyProjectId) : null;

    const currentModelConfig = await getCurrentModelConfiguration();

    const result = {
      success: true,
      projectId,
      projectPath: resolvedProjectPath,
      currentModel: currentModelConfig,
      storedModel: modelInfo,
      compatibility,
      stats: statsCurrent,
      legacy:
        statsLegacy && statsLegacy.totalChunks > 0
          ? { projectId: legacyProjectId, stats: statsLegacy }
          : undefined,
      recommendations: [] as string[],
    };

    if (!compatibility.compatible) {
      result.recommendations.push(
        'Embedding model compatibility issues detected. Run manage_embeddings with action="migrate" to refresh embeddings.'
      );
    }

    if (
      modelInfo &&
      (modelInfo.currentProvider !== currentModelConfig.provider ||
        modelInfo.currentDimensions !== currentModelConfig.dimensions)
    ) {
      result.recommendations.push(
        `Stored embeddings use ${modelInfo.currentProvider} (${modelInfo.currentDimensions}d) while the current environment prefers ${currentModelConfig.provider} (${currentModelConfig.dimensions}d). Consider migration.`
      );
    }

    if ((!statsCurrent || statsCurrent.totalChunks === 0) && !statsLegacy) {
      result.recommendations.push(
        'No embeddings found. They will be generated automatically when local_context or related tools run.'
      );
    } else if (!statsCurrent && statsLegacy) {
      result.recommendations.push(
        'Embeddings exist under a legacy project ID. Re-running manage_embeddings with action="migrate" will standardise storage.'
      );
    } else if (statsCurrent && statsCurrent.totalChunks > 0) {
      result.recommendations.push('Embeddings look healthy for similarity search.');
    }

    logger.info('Embedding model status check complete', {
      projectId,
      compatible: compatibility.compatible,
      issues: compatibility.issues.length,
      recommendations: result.recommendations.length,
    });

    return result;
  } catch (error) {
    logger.error('Embedding model status check failed', {
      error: error instanceof Error ? error.message : String(error),
      projectPath: resolvedProjectPath,
    });
    throw new Error(`Embedding model status check failed: ${(error as Error).message}`);
  }
}

export async function runEmbeddingHealthCheck(args: {
  projectPath: string;
  autoFix?: boolean;
  maxFixTime?: number;
}): Promise<any> {
  const { projectPath, autoFix = false, maxFixTime = 15 } = args;

  const { projectId, projectPath: resolvedProjectPath } = await resolveProject(projectPath);

  logger.info('Starting embedding health check', {
    projectPath: resolvedProjectPath,
    projectId,
    autoFix,
    maxFixTime,
  });

  const startTime = Date.now();
  const issues: string[] = [];
  const fixes: string[] = [];
  const recommendations: string[] = [];

  try {
    const storage = new LocalEmbeddingStorage();
    const generator = new LocalEmbeddingGenerator(storage);

    try {
      await storage.initializeDatabase();
      logger.info('Embedding database connectivity verified');
    } catch (error) {
      issues.push(`Database connectivity failed: ${(error as Error).message}`);
      return {
        success: false,
        projectPath: resolvedProjectPath,
        issues,
        error: 'Database connectivity failed',
      };
    }

    const compatibility = await storage.validateEmbeddingCompatibility(projectId);
    if (!compatibility.compatible) {
      issues.push('Embedding model compatibility issues detected.');
      recommendations.push('Run manage_embeddings with action="migrate" to regenerate embeddings.');
      if (autoFix) {
        logger.info('Auto-fix enabled. Initiating embedding migration.');
        try {
          const migrationResult = await migrateProjectEmbeddings({
            projectPath: resolvedProjectPath,
            force: true,
            batchSize: 20,
          });
          fixes.push(`Migration completed: ${migrationResult.message || 'Embeddings refreshed.'}`);
        } catch (error) {
          issues.push(`Auto-migration failed: ${(error as Error).message}`);
        }
      }
    }

    const stats = await storage.getProjectStats(projectId);
    if (!stats || stats.totalChunks === 0) {
      issues.push('No embeddings found for this project.');
      recommendations.push(
        'Trigger local_context or manage_embeddings action="migrate" to populate embeddings.'
      );
    }

    if (process.env.OPENAI_API_KEY) {
      try {
        const testEmbedding = await generator.generateQueryEmbedding('health-check probe');
        if (!testEmbedding || testEmbedding.length === 0) {
          issues.push('OpenAI API returned an empty embedding during probe.');
        }
      } catch (error) {
        issues.push(`OpenAI API connectivity issue: ${(error as Error).message}`);
        recommendations.push('Verify OPENAI_API_KEY or fall back to local embeddings.');
      }
    }

    const requiredEnvVars = ['WORKSPACE_FOLDER'];
    const recommendedEnvVars = ['USE_LOCAL_EMBEDDINGS', 'OPENAI_API_KEY'];

    for (const envVar of requiredEnvVars) {
      if (!process.env[envVar]) {
        issues.push(`Required environment variable missing: ${envVar}`);
      }
    }

    for (const envVar of recommendedEnvVars) {
      if (!process.env[envVar]) {
        recommendations.push(`Consider setting ${envVar} for optimal behaviour.`);
      }
    }

    const duration = Date.now() - startTime;
    const healthScore = Math.max(0, 100 - issues.length * 20 - recommendations.length * 5);

    logger.info('Embedding health check complete', {
      duration,
      issues: issues.length,
      fixes: fixes.length,
      recommendations: recommendations.length,
      healthScore,
    });

    return {
      success: true,
      projectPath: resolvedProjectPath,
      projectId,
      healthScore: `${healthScore}%`,
      issues,
      fixes,
      recommendations,
      duration: `${duration}ms`,
      compatibility,
      stats,
      autoFixAttempted: autoFix,
      summary:
        issues.length === 0
          ? 'All embedding diagnostics passed.'
          : `${issues.length} issues detected, ${fixes.length} auto-fixed`,
    };
  } catch (error) {
    logger.error('Embedding health check failed', {
      error: error instanceof Error ? error.message : String(error),
      projectPath: resolvedProjectPath,
    });
    throw new Error(`Embedding health check failed: ${(error as Error).message}`);
  }
}

export async function migrateProjectEmbeddings(args: {
  projectPath: string;
  force?: boolean;
  batchSize?: number;
}): Promise<any> {
  const {
    projectPath,
    force = false,
    batchSize = (() => {
      const parsed = parseInt(process.env.EMBEDDING_BATCH_SIZE || '', 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 32;
    })(),
  } = args;

  const { projectId, projectPath: resolvedProjectPath } = await resolveProject(projectPath);

  logger.info('Starting embedding migration', {
    projectPath: resolvedProjectPath,
    projectId,
    force,
    batchSize,
  });

  try {
    const storage = new LocalEmbeddingStorage();
    const generator = new LocalEmbeddingGenerator(storage);

    if (!force) {
      const compatibility = await storage.validateEmbeddingCompatibility(projectId);
      if (compatibility.compatible) {
        return {
          success: true,
          skipped: true,
          reason: 'No migration needed - embeddings already compatible.',
          compatibility,
        };
      }
    }

    await storage.clearProjectEmbeddings(projectId);

    const parallelMode = process.env.EMBEDDING_PARALLEL_MODE === 'true';
    const maxConcurrency = parseInt(process.env.EMBEDDING_MAX_CONCURRENCY || '', 10) || 10;

    const progress = await generator.generateProjectEmbeddings(projectId, resolvedProjectPath, {
      batchSize,
      autoMigrate: true,
      filePatterns: ['**/*.{ts,tsx,js,jsx,py,md}'],
      parallelMode,
      maxConcurrency,
    });

    const postMigrationCompatibility = await storage.validateEmbeddingCompatibility(projectId);
    const newStats = await storage.getProjectStats(projectId);

    const result = {
      success: true,
      migrated: true,
      projectId,
      progress,
      compatibility: postMigrationCompatibility,
      stats: newStats,
      recommendations: [
        'Migration completed successfully.',
        'Embeddings are now compatible with the active model configuration.',
        'You can resume semantic search and context generation tools.',
      ],
      message: 'Migration completed successfully.',
    };

    logger.info('Embedding migration completed', {
      projectId,
      filesProcessed: progress.processedFiles,
      embeddingsGenerated: progress.embeddings,
      compatible: postMigrationCompatibility.compatible,
    });

    return result;
  } catch (error) {
    logger.error('Embedding migration failed', {
      error: error instanceof Error ? error.message : String(error),
      projectPath: resolvedProjectPath,
    });
    throw new Error(`Embedding migration failed: ${(error as Error).message}`);
  }
}

export async function validateProjectEmbeddings(args: {
  projectPath: string;
  includeStats?: boolean;
  checkIntegrity?: boolean;
}): Promise<any> {
  const { projectPath, includeStats = true, checkIntegrity = false } = args;

  const {
    projectId,
    legacyProjectId,
    projectPath: resolvedProjectPath,
  } = await resolveProject(projectPath);

  logger.info('Starting embedding validation', {
    projectPath: resolvedProjectPath,
    projectId,
    includeStats,
    checkIntegrity,
  });

  try {
    const storage = new LocalEmbeddingStorage();

    const compatibility = await storage.validateEmbeddingCompatibility(projectId);

    const result: any = {
      success: true,
      projectId,
      projectPath: resolvedProjectPath,
      compatibility,
      validation: {
        passed: compatibility.compatible,
        issues: compatibility.issues,
        recommendations: compatibility.recommendations,
      },
    };

    if (includeStats) {
      const stats = await storage.getProjectStats(projectId);
      const modelInfo = await storage.getModelInfo(projectId);
      const legacyStats =
        legacyProjectId !== projectId ? await storage.getProjectStats(legacyProjectId) : null;

      result.stats = stats;
      result.modelInfo = modelInfo;
      if (legacyStats) {
        result.legacy = { projectId: legacyProjectId, stats: legacyStats };
      }
    }

    if (checkIntegrity) {
      logger.info('Performing embedding integrity probe', { projectId });

      const embeddings = await storage.getProjectEmbeddings(projectId);
      const sampleSize = Math.min(10, embeddings.length);
      const sample = embeddings.slice(0, sampleSize);

      const integrityIssues: string[] = [];

      for (const embedding of sample) {
        if (!Array.isArray(embedding.embedding) || embedding.embedding.length === 0) {
          integrityIssues.push(`Embedding ${embedding.id} has invalid vector data.`);
        }

        const hasInvalidValues = embedding.embedding.some(
          (value: number) => !Number.isFinite(value)
        );
        if (hasInvalidValues) {
          integrityIssues.push(`Embedding ${embedding.id} contains NaN or infinite values.`);
        }

        if (embedding.metadata.embeddingDimensions !== embedding.embedding.length) {
          integrityIssues.push(
            `Embedding ${embedding.id} has dimension mismatch: metadata ${embedding.metadata.embeddingDimensions}, actual ${embedding.embedding.length}.`
          );
        }
      }

      result.integrity = {
        checked: sampleSize,
        total: embeddings.length,
        issues: integrityIssues,
        passed: integrityIssues.length === 0,
      };
    }

    logger.info('Embedding validation completed', {
      projectId,
      compatible: compatibility.compatible,
      issues: compatibility.issues.length,
      integrityChecked: checkIntegrity,
    });

    return result;
  } catch (error) {
    logger.error('Embedding validation failed', {
      error: error instanceof Error ? error.message : String(error),
      projectPath: resolvedProjectPath,
    });
    throw new Error(`Embedding validation failed: ${(error as Error).message}`);
  }
}

function requireProjectPath(projectPath?: string): string {
  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error('projectPath is required and must be a string');
  }
  return projectPath;
}

async function resolveProject(projectPath: string): Promise<ProjectResolution> {
  const resolvedProjectPath = validateAndResolvePath(projectPath);
  const projectInfo = await ProjectIdentifier.getInstance().identifyProject(resolvedProjectPath);
  const projectId = projectInfo.id;
  const legacyProjectId = crypto
    .createHash('sha256')
    .update(resolvedProjectPath)
    .digest('hex')
    .substring(0, 16);

  return { projectPath: resolvedProjectPath, projectId, legacyProjectId };
}

async function getCurrentModelConfiguration(): Promise<{
  provider: string;
  model: string;
  dimensions: number;
  format: 'int8' | 'float32';
}> {
  if (process.env.AMBIANCE_API_KEY) {
    return {
      provider: 'voyageai',
      model: 'voyage-context-3',
      dimensions: 1024,
      format: 'int8',
    };
  }

  if (process.env.OPENAI_API_KEY) {
    const currentModel = process.env.OPENAI_EMBEDDINGS_MODEL || 'text-embedding-3-large';
    const modelDimensions =
      currentModel === 'text-embedding-3-large'
        ? 3072
        : currentModel === 'text-embedding-3-small'
          ? 1536
          : currentModel === 'text-embedding-ada-002'
            ? 1536
            : 3072;

    return {
      provider: 'openai',
      model: currentModel,
      dimensions: modelDimensions,
      format: 'float32',
    };
  }

  try {
    const { getDefaultLocalProvider } = await import('../../local/localEmbeddingProvider');
    const localProvider = getDefaultLocalProvider();
    const localModelInfo = localProvider.getModelInfo();

    return {
      provider: 'local',
      model: localModelInfo.name,
      dimensions: localModelInfo.dimensions,
      format: 'float32',
    };
  } catch {
    return {
      provider: 'local',
      model: 'transformers.js',
      dimensions: 384,
      format: 'float32',
    };
  }
}
