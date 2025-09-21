/**
 * @fileOverview: Workspace configuration tool for setting WORKSPACE_FOLDER safely
 * @module: WorkspaceConfig
 * @keyFunctions:
 *   - workspaceConfigTool: Tool definition for workspace configuration
 *   - handleWorkspaceConfig(): Handler for workspace configuration requests
 * @context: Allows agents to safely set workspace folder with validation
 */

import { logger } from '../../utils/logger';
import { initializeAutoIndexing } from '../../startup/autoIndexingStartup';
import {
  validateWorkspaceFolder,
  getCurrentWorkspaceFolder,
  setWorkspaceFolder,
  WorkspaceValidationOptions,
} from '../utils/workspaceValidator';
import { getEmbeddingStatus } from './embeddingManagement';

async function safeGetEmbeddingStatus(projectPath: string) {
  try {
    return await getEmbeddingStatus({ projectPath });
  } catch (error) {
    logger.warn('�s��,? Could not check embedding status', {
      projectPath,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      projectId: 'unknown',
      hasEmbeddings: false,
      totalEmbeddings: 0,
      compatible: false,
      error: 'Could not check embedding status',
      recommendations: [
        'dY"? Embedding status check failed - AI tools may still work but with reduced performance',
      ],
    };
  }
}

/**
 * Tool definition for workspace configuration
 */
export const workspaceConfigTool = {
  name: 'workspace_config',
  description:
    '🏠 Configure the workspace folder for the MCP server with safety validation and embedding status. Prevents setting root drives and directories with >1000 files to avoid performance issues. Automatically checks embedding compatibility and provides recommendations for AI tool optimization. Use this when you need to set the working directory for project analysis tools.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'set', 'validate'],
        description:
          'Action to perform: get current workspace (includes embedding status), set new workspace (triggers embedding check), or validate a path',
        default: 'get',
      },
      path: {
        type: 'string',
        description:
          'Path to set as workspace (required for set/validate actions). Can be absolute or relative.',
      },
      maxFiles: {
        type: 'number',
        default: 5000,
        minimum: 100,
        maximum: 10000,
        description: 'Maximum number of analyzable files allowed in workspace (default: 5000)',
      },
      excludePatterns: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Additional glob patterns to exclude when counting files (e.g., ["*.tmp", "cache/**"])',
        default: [],
      },
      allowHiddenFolders: {
        type: 'boolean',
        default: false,
        description: 'Whether to include hidden folders (starting with .) in file counting',
      },
      force: {
        type: 'boolean',
        default: false,
        description: 'Force set workspace even with warnings (but not errors)',
      },
    },
    required: [],
  },
};

/**
 * Handle workspace configuration requests
 */
export async function handleWorkspaceConfig(args: any): Promise<any> {
  const {
    action = 'get',
    path,
    maxFiles = 5000,
    excludePatterns = [],
    allowHiddenFolders = false,
    force = false,
  } = args;

  logger.info('🏠 Workspace configuration request', {
    action,
    path,
    maxFiles,
    excludePatterns,
    allowHiddenFolders,
    force,
  });

  try {
    switch (action) {
      case 'get':
        return await handleGetWorkspace();

      case 'validate':
        if (!path) {
          return {
            success: false,
            error: 'Path is required for validate action',
          };
        }
        return handleValidateWorkspace(path, { maxFiles, excludePatterns, allowHiddenFolders });

      case 'set':
        if (!path) {
          return {
            success: false,
            error: 'Path is required for set action',
          };
        }
        return await handleSetWorkspace(
          path,
          { maxFiles, excludePatterns, allowHiddenFolders },
          force
        );

      default:
        return {
          success: false,
          error: `Unknown action: ${action}. Use 'get', 'validate', or 'set'`,
        };
    }
  } catch (error) {
    logger.error('❌ Workspace configuration failed', {
      action,
      path,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get current workspace configuration
 */
async function handleGetWorkspace(): Promise<any> {
  const currentWorkspace = getCurrentWorkspaceFolder();

  logger.info('📍 Current workspace status', {
    workspace: currentWorkspace || '(not set)',
    fromEnv: !!process.env.WORKSPACE_FOLDER,
    fromBaseDir: !!process.env.AMBIANCE_BASE_DIR,
  });

  let embeddingStatus = null;
  if (currentWorkspace) {
    logger.info('🔍 Checking embedding status for current workspace', {
      workspace: currentWorkspace,
    });
    embeddingStatus = await safeGetEmbeddingStatus(currentWorkspace);
  }

  return {
    success: true,
    workspace: currentWorkspace || null,
    source: process.env.WORKSPACE_FOLDER
      ? 'WORKSPACE_FOLDER'
      : process.env.AMBIANCE_BASE_DIR
        ? 'AMBIANCE_BASE_DIR'
        : 'none',
    embeddingStatus,
    message: currentWorkspace
      ? `Current workspace: ${currentWorkspace}`
      : 'No workspace folder configured. Use action "set" to configure one.',
    recommendations: embeddingStatus?.recommendations || [],
  };
}

/**
 * Validate a workspace path
 */
async function handleValidateWorkspace(
  path: string,
  options: WorkspaceValidationOptions
): Promise<any> {
  logger.info('🔍 Validating workspace path', { path, options });

  const validation = await validateWorkspaceFolder(path, options);

  return {
    success: true,
    validation,
    message: validation.isValid
      ? `✅ Path is valid for workspace: ${validation.path} (${validation.fileCount} files)`
      : `❌ Path is not suitable for workspace: ${validation.error}`,
    recommendations: validation.isValid ? [] : getWorkspaceRecommendations(validation),
  };
}

/**
 * Set workspace folder
 */
async function handleSetWorkspace(
  path: string,
  options: WorkspaceValidationOptions,
  force: boolean
): Promise<any> {
  logger.info('🏠 Setting workspace folder', { path, options, force });

  // First validate the path
  const validation = await validateWorkspaceFolder(path, options);

  if (!validation.isValid) {
    return {
      success: false,
      error: validation.error,
      validation,
      recommendations: getWorkspaceRecommendations(validation),
      message: `Cannot set workspace: ${validation.error}`,
    };
  }

  // Check for warnings
  if (validation.warnings && validation.warnings.length > 0 && !force) {
    return {
      success: false,
      error: 'Workspace has warnings. Use force=true to override.',
      validation,
      warnings: validation.warnings,
      message: `Workspace has warnings: ${validation.warnings.join(', ')}. Use force=true if you want to proceed anyway.`,
    };
  }

  // Set the workspace
  setWorkspaceFolder(validation.path!);

  logger.info('✅ Workspace folder set successfully', {
    workspace: validation.path,
    fileCount: validation.fileCount,
    hadWarnings: !!validation.warnings,
  });

  // Mark workspace as initialized so startup can begin indexing on next cycle
  process.env.WORKSPACE_INITIALIZED = 'true';
  logger.info('🔧 Workspace initialization flag set');

  // Kick off auto-indexing in the background now that workspace is set
  try {
    setTimeout(() => {
      initializeAutoIndexing().catch(error => {
        logger.warn('⚠️ Failed to start auto-indexing after workspace setup', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, 0);
    logger.info('🚀 Triggered automatic indexing after workspace setup');
  } catch (err) {
    logger.warn('⚠️ Could not trigger automatic indexing after workspace setup', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Check embedding status for the newly set workspace
  logger.info('🔍 Checking embedding status for newly set workspace', {
    workspace: validation.path,
  });
  const embeddingStatus = await safeGetEmbeddingStatus(validation.path!);

  // Log embedding status for visibility
  if (embeddingStatus.hasEmbeddings) {
    logger.info('📊 Embedding status for workspace', {
      workspace: validation.path,
      totalEmbeddings: embeddingStatus.totalEmbeddings,
      compatible: embeddingStatus.compatible,
      lastUpdated: embeddingStatus.lastUpdated,
    });
  } else {
    logger.info('📝 No embeddings found for workspace - will be generated on first AI tool use', {
      workspace: validation.path,
    });
  }

  // Notify about any compatibility issues
  if (!embeddingStatus.compatible) {
    logger.warn('⚠️ Embedding compatibility issues detected in new workspace', {
      workspace: validation.path,
      issues: embeddingStatus.issues,
      recommendations: embeddingStatus.recommendations,
    });
  }

  return {
    success: true,
    workspace: validation.path,
    fileCount: validation.fileCount,
    warnings: validation.warnings,
    embeddingStatus,
    message:
      `✅ Workspace set successfully: ${validation.path} (${validation.fileCount} files)` +
      (validation.warnings ? ` [Warnings: ${validation.warnings.length}]` : ''),
    embeddingMessage: embeddingStatus.hasEmbeddings
      ? `Embeddings: ${embeddingStatus.totalEmbeddings} chunks, ${embeddingStatus.compatible ? 'compatible' : 'needs migration'}`
      : 'Embeddings: None found - will be generated automatically on first AI tool use',
  };
}

/**
 * Generate recommendations for failed workspace validation
 */
function getWorkspaceRecommendations(validation: any): string[] {
  const recommendations: string[] = [];

  if (!validation.isValid && validation.error) {
    if (validation.error.includes('root drive')) {
      recommendations.push('Use a specific project directory instead of root drive');
      recommendations.push('Example: C:\\Projects\\MyProject instead of C:\\');
    }

    if (validation.error.includes('too many files')) {
      recommendations.push('Choose a more specific subdirectory');
      recommendations.push('Add exclude patterns for build/dependency folders');
      recommendations.push('Consider using folderPath parameter in other tools instead');
    }

    if (validation.error.includes('does not exist')) {
      recommendations.push('Create the directory first');
      recommendations.push('Check the path spelling and access permissions');
    }

    if (validation.error.includes('not a directory')) {
      recommendations.push('Use the parent directory instead');
      recommendations.push('Check that the path points to a folder, not a file');
    }
  }

  if (recommendations.length === 0) {
    recommendations.push('Try a different path');
    recommendations.push('Use action "validate" to check paths before setting');
  }

  return recommendations;
}
