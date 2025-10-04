/**
 * @fileOverview: Local embedding storage using SQLite for offline embedding persistence
 * @module: EmbeddingStorage
 * @keyFunctions:
 *   - initializeDatabase(): Create database schema and tables
 *   - storeEmbedding(): Store chunk text and embedding vector locally
 *   - searchSimilarEmbeddings(): Vector similarity search for context retrieval
 *   - getProjectEmbeddings(): Get all embeddings for a project
 * @dependencies:
 *   - sqlite3: SQLite database for local persistence
 *   - openai: Embedding generation using OpenAI API
 * @context: Provides local embedding storage and retrieval for enhanced context generation without requiring cloud connectivity
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Database, Statement } from 'sqlite3';
import { logger } from '../utils/logger';

import {
  QuantizedEmbedding,
  quantizeFloat32ToInt8,
  dequantizeInt8ToFloat32,
  isQuantized,
  serializeQuantizedEmbedding,
  deserializeQuantizedEmbedding,
} from './quantization';

export interface EmbeddingChunk {
  id: string;
  projectId: string;
  fileId: string; // Reference to files table instead of direct path
  filePath: string; // Keep for backward compatibility and queries
  chunkIndex: number;
  content: string;
  embedding: number[] | QuantizedEmbedding; // Support both float32 and quantized int8
  metadata: {
    startLine?: number;
    endLine?: number;
    language?: string;
    symbols?: string[];
    type: 'code' | 'comment' | 'docstring' | 'import' | 'export';
    embeddingFormat?: 'float32' | 'int8';
    embeddingDimensions?: number;
    embeddingProvider?: string;
  };
  hash: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SimilarChunk {
  chunk: EmbeddingChunk;
  similarity: number;
}

export interface EmbeddingModelInfo {
  projectId: string;
  currentProvider: string;
  currentDimensions: number;
  currentFormat: string;
  lastModelChange: Date;
  migrationNeeded: boolean;
}

export interface ProjectMetadata {
  id: string;
  name: string;
  path: string;
  type: 'git' | 'local';
  gitRemoteUrl?: string;
  gitBranch?: string;
  gitCommitSha?: string;
  workspaceRoot: string;
  addedAt: Date;
  lastIndexed?: Date;
  updatedAt: Date;
}

export interface FileMetadata {
  id: string;
  projectId: string;
  path: string;
  hash: string;
  lastModified: Date;
  fileSize: number;
  language?: string;
  lineCount?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ModelChangeResult {
  changed: boolean;
  previousModel?: EmbeddingModelInfo;
  currentModel: EmbeddingModelInfo;
  incompatibleEmbeddings: number;
  migrationRecommended: boolean;
}

export interface SchemaVersion {
  version: number;
  appliedAt: Date;
  description: string;
}

// Current schema version - increment when making breaking changes
export const CURRENT_SCHEMA_VERSION = 2;

// Schema version history
export const SCHEMA_VERSIONS = {
  1: 'Initial schema with embeddings, project_stats, embedding_models',
  2: 'Added projects table with foreign keys, files table',
};

export class LocalEmbeddingStorage {
  private db: Database | null = null;
  private dbPath: string;
  private initialized = false;
  private enableQuantization: boolean;

  // Quota management
  private projectQuotas: Map<string, number> = new Map(); // projectId -> quota in bytes
  private globalQuota: number; // Global quota in bytes
  private enableQuotas: boolean;

  // Prepared statements for performance
  private insertStmt: Statement | null = null;
  private insertProjectStmt: Statement | null = null;
  private getProjectStmt: Statement | null = null;
  private getProjectByPathStmt: Statement | null = null;
  private updateProjectLastIndexedStmt: Statement | null = null;
  private updateStmt: Statement | null = null;
  private searchStmt: Statement | null = null;
  private projectStmt: Statement | null = null;

  // File management statements
  private insertFileStmt: Statement | null = null;
  private updateFileStmt: Statement | null = null;
  private getFileStmt: Statement | null = null;
  private listProjectFilesStmt: Statement | null = null;

  constructor(customPath?: string, enableQuantization?: boolean) {
    // Use custom path or default to ~/.ambiance/embeddings.db
    if (customPath && process.env.USE_LOCAL_EMBEDDINGS === 'true') {
      this.dbPath = path.resolve(customPath, 'embeddings.db');
    } else {
      const homeDir = process.env.HOME || process.env.USERPROFILE || process.cwd();
      const ambianceDir = path.join(homeDir, '.ambiance');

      // Use LOCAL_STORAGE_PATH if provided
      const localStoragePath = process.env.LOCAL_STORAGE_PATH;
      if (localStoragePath) {
        const resolvedPath = path.resolve(localStoragePath);
        this.dbPath = path.join(resolvedPath, 'embeddings.db');
      } else {
        this.dbPath = path.join(ambianceDir, 'embeddings.db');
      }
    }

    // Enable quantization by default for new installations, or based on explicit setting
    this.enableQuantization = enableQuantization ?? process.env.EMBEDDING_QUANTIZATION === 'true';

    // Initialize quota management
    this.enableQuotas = process.env.EMBEDDING_QUOTAS === 'true';
    this.globalQuota = this.parseQuotaSize(process.env.EMBEDDING_GLOBAL_QUOTA || '10GB');

    logger.info('💾 Local embedding storage initialized', {
      dbPath: this.dbPath,
      useLocalEmbeddings: process.env.USE_LOCAL_EMBEDDINGS === 'true',
      customPath: !!customPath,
      quantizationEnabled: this.enableQuantization,
      quotasEnabled: this.enableQuotas,
      globalQuota: this.formatQuotaSize(this.globalQuota),
    });
  }

  /**
   * Initialize the SQLite database and create tables
   */
  async initializeDatabase(): Promise<void> {
    if (this.initialized) return;

    return new Promise((resolve, reject) => {
      // Ensure directory exists
      const dbDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      this.db = new Database(this.dbPath, err => {
        if (err) {
          logger.error('❌ Failed to open SQLite database', {
            error: err.message,
            path: this.dbPath,
          });
          reject(err);
          return;
        }

        logger.info('✅ SQLite database opened', { path: this.dbPath });
        this.createTables()
          .then(() => {
            this.prepareStatements();
            this.initialized = true;
            resolve();
          })
          .catch(reject);
      });
    });
  }

  /**
   * Create database tables for embedding storage
   */
  private createTables(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }

      // Check current schema version
      this.db.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
        (err, row) => {
          if (err) {
            reject(err);
            return;
          }

          if (!row) {
            // No schema_version table = old database or new database
            // Check if embeddings table exists (old database)
            this.db!.get(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'",
              (embErr, embRow) => {
                if (embErr) {
                  reject(embErr);
                  return;
                }

                if (embRow) {
                  // Old database exists - FORCE MIGRATION
                  this.forceSchemaUpgrade()
                    .then(() => {
                      logger.info('✅ Database schema upgraded successfully');
                      resolve();
                    })
                    .catch(reject);
                } else {
                  // New database - create fresh schema
                  this.createNewTables()
                    .then(() => this.setSchemaVersion(CURRENT_SCHEMA_VERSION))
                    .then(() => {
                      logger.info('✅ Database schema is up to date');
                      resolve();
                    })
                    .catch(reject);
                }
              }
            );
          } else {
            // Schema version table exists - check version
            this.db!.get(
              'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1',
              (verErr, verRow: any) => {
                if (verErr) {
                  reject(verErr);
                  return;
                }

                const currentVersion = verRow?.version || 0;

                if (currentVersion < CURRENT_SCHEMA_VERSION) {
                  // Outdated schema - FORCE MIGRATION
                  logger.warn('⚠️ Database schema is outdated', {
                    current: currentVersion,
                    required: CURRENT_SCHEMA_VERSION,
                  });

                  this.forceSchemaUpgrade()
                    .then(() => {
                      logger.info('✅ Database schema upgraded successfully');
                      resolve();
                    })
                    .catch(reject);
                } else if (currentVersion > CURRENT_SCHEMA_VERSION) {
                  // Future schema version - cannot handle
                  const error = new Error(
                    `Database schema version ${currentVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}. ` +
                      `Please upgrade the Ambiance MCP package.`
                  );
                  logger.error('❌ Database schema too new', {
                    dbVersion: currentVersion,
                    supportedVersion: CURRENT_SCHEMA_VERSION,
                  });
                  reject(error);
                } else {
                  // Schema is up to date
                  logger.info('✅ Database schema is up to date');
                  resolve();
                }
              }
            );
          }
        }
      );
    });
  }

  /**
   * Force schema upgrade by backing up old data and recreating database
   */
  private async forceSchemaUpgrade(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    logger.warn('🔧 Starting forced schema upgrade - this will clear existing embeddings');

    // Create backup file path
    const backupPath = `${this.dbPath}.backup.${Date.now()}`;

    try {
      // Close current database connection
      await new Promise<void>((resolve, reject) => {
        this.db!.close(err => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Backup the old database file
      if (fs.existsSync(this.dbPath)) {
        fs.copyFileSync(this.dbPath, backupPath);
        logger.info('💾 Old database backed up', { backup: backupPath });
      }

      // Delete the old database file
      if (fs.existsSync(this.dbPath)) {
        fs.unlinkSync(this.dbPath);
        logger.info('🗑️  Old database file deleted');
      }

      // Reopen database (creates new empty file)
      await new Promise<void>((resolve, reject) => {
        this.db = new Database(this.dbPath, err => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });

      // Create new schema
      await this.createNewTables();
      await this.setSchemaVersion(CURRENT_SCHEMA_VERSION);

      logger.warn('⚠️ Database schema upgraded - all existing embeddings cleared');
      logger.info('💡 Backup saved at:', { path: backupPath });
      logger.info('💡 Regenerate embeddings with: npx ambiance-mcp embeddings create');
    } catch (error) {
      logger.error('❌ Failed to upgrade schema', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Try to restore backup
      if (fs.existsSync(backupPath)) {
        try {
          fs.copyFileSync(backupPath, this.dbPath);
          logger.info('✅ Restored database from backup');
        } catch (restoreError) {
          logger.error('❌ Failed to restore backup', {
            error: restoreError instanceof Error ? restoreError.message : String(restoreError),
          });
        }
      }

      throw error;
    }
  }

  /**
   * Set the schema version in the database
   */
  private setSchemaVersion(version: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }

      const description =
        SCHEMA_VERSIONS[version as keyof typeof SCHEMA_VERSIONS] || 'Unknown version';

      this.db.run(
        'INSERT OR REPLACE INTO schema_version (version, description) VALUES (?, ?)',
        [version, description],
        err => {
          if (err) {
            logger.error('❌ Failed to set schema version', {
              error: err.message,
              version,
            });
            reject(err);
          } else {
            logger.info('✅ Schema version set', { version, description });
            resolve();
          }
        }
      );
    });
  }

  /**
   * Migrate database schema if needed (DEPRECATED - use forceSchemaUpgrade instead)
   * @deprecated
   */
  private migrateDatabaseIfNeeded(hasOldSchema: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }

      let migrationSQL = '';

      if (hasOldSchema) {
        // Check if files table exists
        this.db.get(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='files'",
          (err, row) => {
            if (err) {
              reject(err);
              return;
            }

            if (!row) {
              // Need to add files table and migrate existing data
              migrationSQL = `
              -- Create files table for file metadata tracking (similar to online database)
              CREATE TABLE files (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                path TEXT NOT NULL,
                hash TEXT NOT NULL,
                last_modified DATETIME NOT NULL,
                file_size INTEGER NOT NULL,
                language TEXT,
                line_count INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
              );

              CREATE INDEX idx_files_project_id ON files(project_id);
              CREATE INDEX idx_files_path ON files(path);
              CREATE INDEX idx_files_hash ON files(hash);

              -- Add file_id column to embeddings table
              ALTER TABLE embeddings ADD COLUMN file_id TEXT;
              ALTER TABLE embeddings ADD COLUMN file_path TEXT;

              -- Migrate existing data - create file entries and update embeddings
              INSERT INTO files (id, project_id, path, hash, last_modified, file_size, language, line_count, created_at, updated_at)
              SELECT
                LOWER(HEX(RANDOM())) as id,
                project_id,
                file_path,
                hash,
                DATETIME('now') as last_modified,
                0 as file_size,
                metadata_language,
                0 as line_count,
                created_at,
                updated_at
              FROM (
                SELECT DISTINCT
                  project_id,
                  file_path,
                  hash,
                  metadata_language,
                  created_at,
                  updated_at
                FROM embeddings
              );

              -- Update embeddings with file_id references
              UPDATE embeddings
              SET file_id = (
                SELECT id FROM files
                WHERE files.project_id = embeddings.project_id
                AND files.path = embeddings.file_path
                AND files.hash = embeddings.hash
                LIMIT 1
              ),
              file_path = embeddings.file_path
              WHERE file_id IS NULL;

              -- Add foreign key constraint (SQLite doesn't support adding FK constraints to existing tables easily)
              -- We'll handle this in application logic instead
            `;
            }

            // Execute migration if needed
            if (migrationSQL) {
              logger.info('🔄 Migrating database schema for improved file tracking...');
              this.db!.exec(migrationSQL, err => {
                if (err) {
                  logger.error('❌ Database migration failed', { error: err.message });
                  reject(err);
                } else {
                  logger.info('✅ Database migration completed successfully');
                  this.createNewTables().then(resolve).catch(reject);
                }
              });
            } else {
              // No migration needed, just ensure new tables exist
              this.createNewTables().then(resolve).catch(reject);
            }
          }
        );
      } else {
        // Fresh database, create all tables
        this.createNewTables().then(resolve).catch(reject);
      }
    });
  }

  /**
   * Create new tables (called after migration or for fresh databases)
   */
  private createNewTables(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }

      const createTableSQL = `
        -- Schema version tracking table
        CREATE TABLE IF NOT EXISTS schema_version (
          version INTEGER PRIMARY KEY,
          applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          description TEXT NOT NULL
        );

        -- Create projects table as the authoritative source for project metadata
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL,
          git_remote_url TEXT,
          git_branch TEXT,
          git_commit_sha TEXT,
          workspace_root TEXT NOT NULL,
          added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_indexed DATETIME,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path);
        CREATE INDEX IF NOT EXISTS idx_projects_workspace_root ON projects(workspace_root);
        CREATE INDEX IF NOT EXISTS idx_projects_type ON projects(type);

        -- Create files table for file metadata tracking (similar to online database)
        CREATE TABLE IF NOT EXISTS files (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          path TEXT NOT NULL,
          hash TEXT NOT NULL,
          last_modified DATETIME NOT NULL,
          file_size INTEGER NOT NULL,
          language TEXT,
          line_count INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_files_project_id ON files(project_id);
        CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
        CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);

        -- Ensure embeddings table has the new columns
        CREATE TABLE IF NOT EXISTS embeddings (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          file_id TEXT,
          file_path TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          content TEXT NOT NULL,
          embedding BLOB NOT NULL,
          metadata_type TEXT NOT NULL,
          metadata_language TEXT,
          metadata_symbols TEXT,
          metadata_start_line INTEGER,
          metadata_end_line INTEGER,
          metadata_embedding_format TEXT,
          metadata_embedding_dimensions INTEGER,
          metadata_embedding_provider TEXT,
          hash TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
          FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_project_id ON embeddings(project_id);
        CREATE INDEX IF NOT EXISTS idx_file_id ON embeddings(file_id);
        CREATE INDEX IF NOT EXISTS idx_file_path ON embeddings(file_path);
        CREATE INDEX IF NOT EXISTS idx_hash ON embeddings(hash);
        CREATE INDEX IF NOT EXISTS idx_created_at ON embeddings(created_at);

        -- Additional indexes for performance optimization
        CREATE INDEX IF NOT EXISTS idx_project_file ON embeddings(project_id, file_id);
        CREATE INDEX IF NOT EXISTS idx_project_created_at ON embeddings(project_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_project_format ON embeddings(project_id, metadata_embedding_format);
        CREATE INDEX IF NOT EXISTS idx_metadata_language ON embeddings(metadata_language);
        CREATE INDEX IF NOT EXISTS idx_metadata_type ON embeddings(metadata_type);
        CREATE INDEX IF NOT EXISTS idx_content_length ON embeddings(project_id, LENGTH(content));
        CREATE INDEX IF NOT EXISTS idx_file_path_created ON embeddings(file_path, created_at);

        -- Create a table for tracking project embedding stats
        CREATE TABLE IF NOT EXISTS project_stats (
          project_id TEXT PRIMARY KEY,
          total_chunks INTEGER DEFAULT 0,
          total_files INTEGER DEFAULT 0,
          last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        -- Create a table for tracking embedding model configurations
        CREATE TABLE IF NOT EXISTS embedding_models (
          project_id TEXT PRIMARY KEY,
          current_provider TEXT NOT NULL,
          current_dimensions INTEGER NOT NULL,
          current_format TEXT NOT NULL,
          last_model_change DATETIME DEFAULT CURRENT_TIMESTAMP,
          migration_needed BOOLEAN DEFAULT FALSE,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
      `;

      this.db.exec(createTableSQL, err => {
        if (err) {
          logger.error('❌ Failed to create database tables', { error: err.message });
          reject(err);
        } else {
          logger.info('✅ Database tables created successfully');
          resolve();
        }
      });
    });
  }

  /**
   * Prepare statements for optimal performance
   */
  private prepareStatements(): void {
    if (!this.db) return;

    // Project management statements
    this.insertProjectStmt = this.db.prepare(`
      INSERT OR REPLACE INTO projects (
        id, name, path, type, git_remote_url, git_branch, git_commit_sha, workspace_root, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    this.getProjectStmt = this.db.prepare(`
      SELECT * FROM projects WHERE id = ?
    `);

    this.getProjectByPathStmt = this.db.prepare(`
      SELECT * FROM projects WHERE path = ?
    `);

    this.updateProjectLastIndexedStmt = this.db.prepare(`
      UPDATE projects SET last_indexed = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `);

    // File management statements
    this.insertFileStmt = this.db.prepare(`
      INSERT OR REPLACE INTO files (
        id, project_id, path, hash, last_modified, file_size, language, line_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    this.updateFileStmt = this.db.prepare(`
      UPDATE files SET hash = ?, last_modified = ?, file_size = ?, language = ?, line_count = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    this.getFileStmt = this.db.prepare(`
      SELECT * FROM files WHERE id = ?
    `);

    this.listProjectFilesStmt = this.db.prepare(`
      SELECT * FROM files WHERE project_id = ? ORDER BY path
    `);

    this.insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO embeddings (
        id, project_id, file_id, file_path, chunk_index, content, embedding,
        metadata_type, metadata_language, metadata_symbols,
        metadata_start_line, metadata_end_line, metadata_embedding_format,
        metadata_embedding_dimensions, metadata_embedding_provider, hash, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    this.updateStmt = this.db.prepare(`
      INSERT OR REPLACE INTO project_stats (project_id, total_chunks, total_files)
      VALUES (?,
        (SELECT COUNT(*) FROM embeddings WHERE project_id = ?),
        (SELECT COUNT(DISTINCT file_id) FROM embeddings WHERE project_id = ?)
      )
    `);

    this.searchStmt = this.db.prepare(`
      SELECT * FROM embeddings WHERE project_id = ? ORDER BY created_at DESC LIMIT ?
    `);

    this.projectStmt = this.db.prepare(`
      SELECT * FROM embeddings WHERE project_id = ?
    `);
  }

  /**
   * Store an embedding chunk in the database
   */
  async storeEmbedding(chunk: EmbeddingChunk): Promise<void> {
    if (!this.initialized) {
      await this.initializeDatabase();
    }

    if (!this.insertStmt || !this.updateStmt) {
      throw new Error('Database statements not prepared');
    }

    // Estimate size of the embedding to be stored
    const estimatedSize = this.estimateEmbeddingSize(chunk.embedding);

    // Check and enforce quotas
    const quotaCheck = await this.checkAndEnforceQuota(chunk.projectId, estimatedSize);

    if (!quotaCheck.canStore) {
      logger.error('❌ Cannot store embedding: quota exceeded and cleanup failed', {
        projectId: chunk.projectId,
        estimatedSize: this.formatQuotaSize(estimatedSize),
        quotaExceeded: quotaCheck.quotaExceeded,
        cleanupRequired: quotaCheck.cleanupRequired,
      });

      throw new Error(
        `Storage quota exceeded for project ${chunk.projectId}. ` +
          `Cannot store ${this.formatQuotaSize(estimatedSize)} of embedding data. ` +
          `Consider increasing quota or clearing old embeddings.`
      );
    }

    if (quotaCheck.cleanupRequired) {
      logger.info('✅ Quota enforced, storage space reclaimed', {
        projectId: chunk.projectId,
        cleanedEmbeddings: quotaCheck.cleanedEmbeddings || 0,
        estimatedSize: this.formatQuotaSize(estimatedSize),
      });
    }

    return new Promise((resolve, reject) => {
      // Prepare embedding for storage (quantize if enabled)
      let embeddingToStore: number[] | QuantizedEmbedding;
      let embeddingFormat: 'float32' | 'int8' = 'float32';

      if (this.enableQuantization && Array.isArray(chunk.embedding)) {
        // Quantize float32 embedding to int8 for storage
        try {
          embeddingToStore = quantizeFloat32ToInt8(chunk.embedding);
          embeddingFormat = 'int8';

          logger.debug('🔢 Quantized embedding for storage', {
            chunkId: chunk.id,
            originalSize: chunk.embedding.length * 4,
            quantizedSize: embeddingToStore.data.length,
            compressionRatio: ((chunk.embedding.length * 4) / embeddingToStore.data.length).toFixed(
              1
            ),
          });
        } catch (quantizationError) {
          logger.warn('⚠️ Quantization failed, storing as float32', {
            chunkId: chunk.id,
            error:
              quantizationError instanceof Error
                ? quantizationError.message
                : String(quantizationError),
          });
          embeddingToStore = chunk.embedding;
          embeddingFormat = 'float32';
        }
      } else {
        // Store as-is (either already quantized or quantization disabled)
        embeddingToStore = chunk.embedding;
        embeddingFormat = Array.isArray(chunk.embedding) ? 'float32' : 'int8';
      }

      // Serialize embedding vector
      const embeddingBlob = isQuantized(embeddingToStore)
        ? serializeQuantizedEmbedding(embeddingToStore)
        : Buffer.from(JSON.stringify(embeddingToStore));

      const symbolsJson = chunk.metadata.symbols ? JSON.stringify(chunk.metadata.symbols) : null;

      this.insertStmt!.run(
        [
          chunk.id,
          chunk.projectId,
          chunk.fileId,
          chunk.filePath,
          chunk.chunkIndex,
          chunk.content,
          embeddingBlob,
          chunk.metadata.type,
          chunk.metadata.language || null,
          symbolsJson,
          chunk.metadata.startLine || null,
          chunk.metadata.endLine || null,
          embeddingFormat, // Store the actual format used
          chunk.metadata.embeddingDimensions || null,
          chunk.metadata.embeddingProvider || null,
          chunk.hash,
        ],
        err => {
          if (err) {
            logger.error('❌ Failed to store embedding', {
              error: err.message,
              chunkId: chunk.id,
              projectId: chunk.projectId,
              format: embeddingFormat,
            });
            reject(err);
          } else {
            // Update project stats
            this.updateStmt!.run([chunk.projectId, chunk.projectId, chunk.projectId], statsErr => {
              if (statsErr) {
                logger.warn('⚠️ Failed to update project stats', { error: statsErr.message });
              }
            });

            logger.debug('✅ Embedding stored', {
              chunkId: chunk.id,
              projectId: chunk.projectId,
              contentLength: chunk.content.length,
              format: embeddingFormat,
              quantized: embeddingFormat === 'int8',
            });
            resolve();
          }
        }
      );
    });
  }

  /**
   * Get all embeddings for a project
   */
  async getProjectEmbeddings(projectId: string): Promise<EmbeddingChunk[]> {
    if (!this.initialized) {
      await this.initializeDatabase();
    }

    if (!this.projectStmt) {
      throw new Error('Database statements not prepared');
    }

    return new Promise((resolve, reject) => {
      this.projectStmt!.all([projectId], (err, rows: any[]) => {
        if (err) {
          logger.error('❌ Failed to fetch project embeddings', {
            error: err.message,
            projectId,
          });
          reject(err);
        } else {
          const chunks = rows.map(row => this.rowToChunk(row));
          logger.debug('📦 Retrieved project embeddings', {
            projectId,
            chunkCount: chunks.length,
          });
          resolve(chunks);
        }
      });
    });
  }

  /**
   * Get embeddings for a specific file within a project (optimized query)
   */
  async getFileEmbeddings(projectId: string, fileId: string): Promise<EmbeddingChunk[]> {
    if (!this.initialized) {
      await this.initializeDatabase();
    }

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }

      this.db.get(
        `
        SELECT * FROM embeddings
        WHERE project_id = ? AND file_id = ?
        ORDER BY chunk_index ASC
      `,
        [projectId, fileId],
        (err, rows: any[]) => {
          if (err) {
            logger.error('❌ Failed to fetch file embeddings', {
              error: err.message,
              projectId,
              fileId,
            });
            reject(err);
          } else {
            const chunks = rows.map((row: any) => this.rowToChunk(row));
            logger.debug('📄 Retrieved file embeddings', {
              projectId,
              fileId,
              chunkCount: chunks.length,
            });
            resolve(chunks);
          }
        }
      );
    });
  }

  /**
   * Get recent embeddings for a project (for LRU cleanup)
   */
  async getRecentEmbeddings(projectId: string, limit: number = 100): Promise<EmbeddingChunk[]> {
    if (!this.initialized) {
      await this.initializeDatabase();
    }

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }

      this.db.all(
        `
        SELECT * FROM embeddings
        WHERE project_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
        [projectId, limit],
        (err, rows: any[]) => {
          if (err) {
            logger.error('❌ Failed to fetch recent embeddings', {
              error: err.message,
              projectId,
              limit,
            });
            reject(err);
          } else {
            const chunks = rows.map((row: any) => this.rowToChunk(row));
            logger.debug('🕒 Retrieved recent embeddings', {
              projectId,
              chunkCount: chunks.length,
              limit,
            });
            resolve(chunks);
          }
        }
      );
    });
  }

  /**
   * Get embeddings by format for a project (for compatibility checking)
   */
  async getEmbeddingsByFormat(
    projectId: string,
    format: 'float32' | 'int8'
  ): Promise<EmbeddingChunk[]> {
    if (!this.initialized) {
      await this.initializeDatabase();
    }

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }

      this.db.all(
        `
        SELECT * FROM embeddings
        WHERE project_id = ? AND metadata_embedding_format = ?
        ORDER BY created_at ASC
      `,
        [projectId, format],
        (err, rows: any[]) => {
          if (err) {
            logger.error('❌ Failed to fetch embeddings by format', {
              error: err.message,
              projectId,
              format,
            });
            reject(err);
          } else {
            const chunks = rows.map((row: any) => this.rowToChunk(row));
            logger.debug('🔢 Retrieved embeddings by format', {
              projectId,
              format,
              chunkCount: chunks.length,
            });
            resolve(chunks);
          }
        }
      );
    });
  }

  /**
   * Get embeddings by language for a project
   */
  async getEmbeddingsByLanguage(projectId: string, language: string): Promise<EmbeddingChunk[]> {
    if (!this.initialized) {
      await this.initializeDatabase();
    }

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }

      this.db.all(
        `
        SELECT * FROM embeddings
        WHERE project_id = ? AND metadata_language = ?
        ORDER BY created_at ASC
      `,
        [projectId, language],
        (err, rows: any[]) => {
          if (err) {
            logger.error('❌ Failed to fetch embeddings by language', {
              error: err.message,
              projectId,
              language,
            });
            reject(err);
          } else {
            const chunks = rows.map((row: any) => this.rowToChunk(row));
            logger.debug('🌐 Retrieved embeddings by language', {
              projectId,
              language,
              chunkCount: chunks.length,
            });
            resolve(chunks);
          }
        }
      );
    });
  }

  /**
   * Get embeddings with content matching a pattern (for content-based search)
   */
  async searchEmbeddingsByContent(
    projectId: string,
    pattern: string,
    limit: number = 50
  ): Promise<EmbeddingChunk[]> {
    if (!this.initialized) {
      await this.initializeDatabase();
    }

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }

      // Use SQLite's LIKE for pattern matching (could be enhanced with FTS later)
      this.db.all(
        `
        SELECT * FROM embeddings
        WHERE project_id = ? AND content LIKE ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
        [projectId, `%${pattern}%`, limit],
        (err, rows: any[]) => {
          if (err) {
            logger.error('❌ Failed to search embeddings by content', {
              error: err.message,
              projectId,
              pattern,
              limit,
            });
            reject(err);
          } else {
            const chunks = rows.map((row: any) => this.rowToChunk(row));
            logger.debug('🔍 Retrieved embeddings by content search', {
              projectId,
              pattern,
              chunkCount: chunks.length,
              limit,
            });
            resolve(chunks);
          }
        }
      );
    });
  }

  /**
   * Search for similar embeddings using basic similarity (cosine similarity)
   * Improved logic: Always return the top N results, but still apply threshold filtering when meaningful
   * Note: This is a simple implementation. For production, consider using vector databases like Faiss or Qdrant
   */
  async searchSimilarEmbeddings(
    projectId: string,
    queryEmbedding: number[],
    limit: number = 10,
    similarityThreshold: number = 0.2
  ): Promise<SimilarChunk[]> {
    const allEmbeddings = await this.getProjectEmbeddings(projectId);

    if (allEmbeddings.length === 0) {
      return [];
    }

    const similarities = allEmbeddings.map(chunk => ({
      chunk,
      similarity: this.cosineSimilarity(queryEmbedding, chunk.embedding),
    }));

    // Sort by similarity first
    similarities.sort((a, b) => b.similarity - a.similarity);

    // Apply smart filtering logic:
    // 1. If threshold is very low (< 0.3), return top N results regardless of threshold
    // 2. If threshold is higher, filter first then take top N
    // 3. Always ensure we return at least some results if they exist

    if (similarityThreshold < 0.3) {
      // Low threshold: prioritize returning useful results over strict filtering
      const topResults = similarities.slice(0, limit);
      return topResults.filter(item => item.similarity > 0.05); // Remove only truly irrelevant results
    } else {
      // Higher threshold: apply filtering but ensure we don't return empty results unnecessarily
      const filtered = similarities.filter(item => item.similarity >= similarityThreshold);

      if (filtered.length === 0 && similarities.length > 0) {
        // If threshold filtering returns nothing, return top 3 results with a warning log
        logger.info('🔍 Threshold too restrictive, returning top results instead', {
          requestedThreshold: similarityThreshold,
          topSimilarity: similarities[0]?.similarity,
          resultCount: Math.min(3, similarities.length),
        });
        return similarities.slice(0, Math.min(3, limit));
      }

      return filtered.slice(0, limit);
    }
  }

  /**
   * Calculate cosine similarity between two vectors (handles both quantized and float32)
   */
  private cosineSimilarity(
    a: number[] | QuantizedEmbedding,
    b: number[] | QuantizedEmbedding
  ): number {
    // Normalize both embeddings to float32 arrays
    const aFloat32 = isQuantized(a) ? dequantizeInt8ToFloat32(a) : a;
    const bFloat32 = isQuantized(b) ? dequantizeInt8ToFloat32(b) : b;

    if (aFloat32.length !== bFloat32.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < aFloat32.length; i++) {
      dotProduct += aFloat32[i] * bFloat32[i];
      normA += aFloat32[i] * aFloat32[i];
      normB += bFloat32[i] * bFloat32[i];
    }

    if (normA === 0 || normB === 0) return 0;

    const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));

    // Log quantization impact for debugging
    if (isQuantized(a) || isQuantized(b)) {
      logger.debug('🔍 Cosine similarity with quantization', {
        similarity,
        aFormat: isQuantized(a) ? 'int8' : 'float32',
        bFormat: isQuantized(b) ? 'int8' : 'float32',
      });
    }

    return similarity;
  }

  /**
   * Convert database row to EmbeddingChunk object
   */
  private rowToChunk(row: any): EmbeddingChunk {
    const embeddingBuffer = row.embedding as Buffer;
    let embedding: number[] | QuantizedEmbedding;

    // Check if this is a quantized embedding (newer format)
    const embeddingFormat = row.metadata_embedding_format;
    if (embeddingFormat === 'int8') {
      try {
        // Deserialize quantized embedding
        embedding = deserializeQuantizedEmbedding(embeddingBuffer);
      } catch (error) {
        logger.warn('⚠️ Failed to deserialize quantized embedding, treating as float32', {
          error: error instanceof Error ? error.message : String(error),
          embeddingId: row.id,
        });
        // Fallback to JSON parsing
        embedding = JSON.parse(embeddingBuffer.toString()) as number[];
      }
    } else {
      // Legacy float32 format or fallback
      embedding = JSON.parse(embeddingBuffer.toString()) as number[];
    }

    const symbols = row.metadata_symbols ? JSON.parse(row.metadata_symbols) : undefined;

    return {
      id: row.id,
      projectId: row.project_id,
      fileId: row.file_id,
      filePath: row.file_path,
      chunkIndex: row.chunk_index,
      content: row.content,
      embedding,
      metadata: {
        type: row.metadata_type,
        language: row.metadata_language,
        symbols,
        startLine: row.metadata_start_line,
        endLine: row.metadata_end_line,
        embeddingFormat: row.metadata_embedding_format,
        embeddingDimensions: row.metadata_embedding_dimensions,
        embeddingProvider: row.metadata_embedding_provider,
      },
      hash: row.hash,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  /**
   * Generate a hash for chunk content to detect changes
   */
  static generateContentHash(content: string, filePath: string, chunkIndex: number): string {
    return crypto.createHash('md5').update(`${filePath}:${chunkIndex}:${content}`).digest('hex');
  }

  /**
   * Store or update file metadata
   */
  async storeFileMetadata(metadata: FileMetadata): Promise<void> {
    if (!this.initialized) {
      await this.initializeDatabase();
    }

    if (!this.insertFileStmt) {
      throw new Error('Database statements not prepared');
    }

    return new Promise((resolve, reject) => {
      this.insertFileStmt!.run(
        [
          metadata.id,
          metadata.projectId,
          metadata.path,
          metadata.hash,
          metadata.lastModified.toISOString(),
          metadata.fileSize,
          metadata.language || null,
          metadata.lineCount || null,
        ],
        err => {
          if (err) {
            logger.error('❌ Failed to store file metadata', {
              error: err.message,
              fileId: metadata.id,
              projectId: metadata.projectId,
            });
            reject(err);
          } else {
            logger.debug('✅ File metadata stored', {
              fileId: metadata.id,
              projectId: metadata.projectId,
              path: metadata.path,
            });
            resolve();
          }
        }
      );
    });
  }

  /**
   * Get file metadata by ID
   */
  async getFileMetadata(fileId: string): Promise<FileMetadata | null> {
    if (!this.initialized) {
      await this.initializeDatabase();
    }

    if (!this.getFileStmt) {
      throw new Error('Database statements not prepared');
    }

    return new Promise((resolve, reject) => {
      this.getFileStmt!.get([fileId], (err, row: any) => {
        if (err) {
          logger.error('❌ Failed to get file metadata', { error: err.message, fileId });
          reject(err);
        } else if (!row) {
          resolve(null);
        } else {
          resolve({
            id: row.id,
            projectId: row.project_id,
            path: row.path,
            hash: row.hash,
            lastModified: new Date(row.last_modified),
            fileSize: row.file_size,
            language: row.language,
            lineCount: row.line_count,
            createdAt: new Date(row.created_at),
            updatedAt: new Date(row.updated_at),
          });
        }
      });
    });
  }

  /**
   * List all files for a project
   */
  async listProjectFiles(projectId: string): Promise<FileMetadata[]> {
    if (!this.initialized) {
      await this.initializeDatabase();
    }

    if (!this.listProjectFilesStmt) {
      throw new Error('Database statements not prepared');
    }

    return new Promise((resolve, reject) => {
      this.listProjectFilesStmt!.all([projectId], (err, rows: any[]) => {
        if (err) {
          logger.error('❌ Failed to list project files', { error: err.message, projectId });
          reject(err);
        } else {
          const files = rows.map(row => ({
            id: row.id,
            projectId: row.project_id,
            path: row.path,
            hash: row.hash,
            lastModified: new Date(row.last_modified),
            fileSize: row.file_size,
            language: row.language,
            lineCount: row.line_count,
            createdAt: new Date(row.created_at),
            updatedAt: new Date(row.updated_at),
          }));
          resolve(files);
        }
      });
    });
  }

  /**
   * Register or update a project in the database
   */
  async registerProject(project: ProjectMetadata): Promise<void> {
    if (!this.initialized) {
      await this.initializeDatabase();
    }

    if (!this.insertProjectStmt) {
      throw new Error('Database statements not prepared');
    }

    return new Promise((resolve, reject) => {
      this.insertProjectStmt!.run(
        [
          project.id,
          project.name,
          project.path,
          project.type,
          project.gitRemoteUrl || null,
          project.gitBranch || null,
          project.gitCommitSha || null,
          project.workspaceRoot,
        ],
        err => {
          if (err) {
            logger.error('❌ Failed to register project', {
              error: err.message,
              projectId: project.id,
              path: project.path,
            });
            reject(err);
          } else {
            logger.debug('✅ Project registered', {
              projectId: project.id,
              name: project.name,
              path: project.path,
            });
            resolve();
          }
        }
      );
    });
  }

  /**
   * Get project metadata by ID
   */
  async getProject(projectId: string): Promise<ProjectMetadata | null> {
    if (!this.initialized) {
      await this.initializeDatabase();
    }

    if (!this.getProjectStmt) {
      throw new Error('Database statements not prepared');
    }

    return new Promise((resolve, reject) => {
      this.getProjectStmt!.get([projectId], (err, row: any) => {
        if (err) {
          logger.error('❌ Failed to get project', { error: err.message, projectId });
          reject(err);
        } else if (!row) {
          resolve(null);
        } else {
          resolve({
            id: row.id,
            name: row.name,
            path: row.path,
            type: row.type,
            gitRemoteUrl: row.git_remote_url,
            gitBranch: row.git_branch,
            gitCommitSha: row.git_commit_sha,
            workspaceRoot: row.workspace_root,
            addedAt: new Date(row.added_at),
            lastIndexed: row.last_indexed ? new Date(row.last_indexed) : undefined,
            updatedAt: new Date(row.updated_at),
          });
        }
      });
    });
  }

  /**
   * Get project metadata by path
   */
  async getProjectByPath(projectPath: string): Promise<ProjectMetadata | null> {
    if (!this.initialized) {
      await this.initializeDatabase();
    }

    if (!this.getProjectByPathStmt) {
      throw new Error('Database statements not prepared');
    }

    return new Promise((resolve, reject) => {
      this.getProjectByPathStmt!.get([projectPath], (err, row: any) => {
        if (err) {
          logger.error('❌ Failed to get project by path', { error: err.message, projectPath });
          reject(err);
        } else if (!row) {
          resolve(null);
        } else {
          resolve({
            id: row.id,
            name: row.name,
            path: row.path,
            type: row.type,
            gitRemoteUrl: row.git_remote_url,
            gitBranch: row.git_branch,
            gitCommitSha: row.git_commit_sha,
            workspaceRoot: row.workspace_root,
            addedAt: new Date(row.added_at),
            lastIndexed: row.last_indexed ? new Date(row.last_indexed) : undefined,
            updatedAt: new Date(row.updated_at),
          });
        }
      });
    });
  }

  /**
   * Update project's last indexed timestamp
   */
  async updateProjectLastIndexed(projectId: string): Promise<void> {
    if (!this.initialized) {
      await this.initializeDatabase();
    }

    if (!this.updateProjectLastIndexedStmt) {
      throw new Error('Database statements not prepared');
    }

    return new Promise((resolve, reject) => {
      this.updateProjectLastIndexedStmt!.run([projectId], err => {
        if (err) {
          logger.error('❌ Failed to update project last indexed', {
            error: err.message,
            projectId,
          });
          reject(err);
        } else {
          logger.debug('✅ Project last indexed timestamp updated', { projectId });
          resolve();
        }
      });
    });
  }

  /**
   * List all registered projects
   */
  async listProjects(): Promise<ProjectMetadata[]> {
    if (!this.initialized) {
      await this.initializeDatabase();
    }

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }

      this.db.all(
        'SELECT * FROM projects ORDER BY last_indexed DESC, added_at DESC',
        (err, rows: any[]) => {
          if (err) {
            logger.error('❌ Failed to list projects', { error: err.message });
            reject(err);
          } else {
            const projects = rows.map(row => ({
              id: row.id,
              name: row.name,
              path: row.path,
              type: row.type,
              gitRemoteUrl: row.git_remote_url,
              gitBranch: row.git_branch,
              gitCommitSha: row.git_commit_sha,
              workspaceRoot: row.workspace_root,
              addedAt: new Date(row.added_at),
              lastIndexed: row.last_indexed ? new Date(row.last_indexed) : undefined,
              updatedAt: new Date(row.updated_at),
            }));
            resolve(projects);
          }
        }
      );
    });
  }

  /**
   * List all projects that have embeddings
   */
  async listProjectsWithEmbeddings(): Promise<
    Array<{
      projectId: string;
      totalChunks: number;
      totalFiles: number;
      lastUpdated: Date;
    }>
  > {
    if (!this.initialized) {
      await this.initializeDatabase();
    }

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }

      this.db.all(
        `
        SELECT
          ps.project_id,
          ps.total_chunks,
          ps.total_files,
          ps.last_updated
        FROM project_stats ps
        WHERE ps.total_chunks > 0
        ORDER BY ps.last_updated DESC
      `,
        (err, rows: any[]) => {
          if (err) {
            logger.error('❌ Failed to list projects with embeddings', { error: err.message });
            reject(err);
          } else {
            const projects = rows.map(row => ({
              projectId: row.project_id,
              totalChunks: row.total_chunks,
              totalFiles: row.total_files,
              lastUpdated: new Date(row.last_updated),
            }));
            resolve(projects);
          }
        }
      );
    });
  }

  /**
   * Get project statistics
   */
  async getProjectStats(
    projectId: string
  ): Promise<{ totalChunks: number; totalFiles: number; lastUpdated: Date } | null> {
    if (!this.initialized) {
      await this.initializeDatabase();
    }

    return new Promise((resolve, reject) => {
      this.db!.get(
        'SELECT * FROM project_stats WHERE project_id = ?',
        [projectId],
        (err, row: any) => {
          if (err) {
            reject(err);
          } else if (!row) {
            resolve(null);
          } else {
            resolve({
              totalChunks: row.total_chunks,
              totalFiles: row.total_files,
              lastUpdated: new Date(row.last_updated),
            });
          }
        }
      );
    });
  }

  /**
   * Check for embedding model changes and detect incompatibilities
   */
  async checkModelChange(
    projectId: string,
    currentProvider: string,
    currentDimensions: number,
    currentFormat: string = 'float32'
  ): Promise<ModelChangeResult> {
    if (!this.initialized) {
      await this.initializeDatabase();
    }

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }

      // Get current model info from database
      this.db.get(
        'SELECT * FROM embedding_models WHERE project_id = ?',
        [projectId],
        (err, row: any) => {
          if (err) {
            reject(err);
            return;
          }

          const currentModel: EmbeddingModelInfo = {
            projectId,
            currentProvider,
            currentDimensions,
            currentFormat,
            lastModelChange: new Date(),
            migrationNeeded: false,
          };

          if (!row) {
            // First time setup - no previous model
            this.db!.run(
              'INSERT INTO embedding_models (project_id, current_provider, current_dimensions, current_format) VALUES (?, ?, ?, ?)',
              [projectId, currentProvider, currentDimensions, currentFormat],
              insertErr => {
                if (insertErr) {
                  reject(insertErr);
                  return;
                }

                resolve({
                  changed: false,
                  currentModel,
                  incompatibleEmbeddings: 0,
                  migrationRecommended: false,
                });
              }
            );
            return;
          }

          const previousModel: EmbeddingModelInfo = {
            projectId: row.project_id,
            currentProvider: row.current_provider,
            currentDimensions: row.current_dimensions,
            currentFormat: row.current_format,
            lastModelChange: new Date(row.last_model_change),
            migrationNeeded: row.migration_needed === 1,
          };

          // Check if model has changed
          const modelChanged =
            previousModel.currentProvider !== currentProvider ||
            previousModel.currentDimensions !== currentDimensions ||
            previousModel.currentFormat !== currentFormat;

          if (modelChanged) {
            // Count incompatible embeddings
            this.db!.get(
              'SELECT COUNT(*) as count FROM embeddings WHERE project_id = ? AND (metadata_embedding_provider != ? OR metadata_embedding_dimensions != ?)',
              [projectId, currentProvider, currentDimensions],
              (countErr, countRow: any) => {
                if (countErr) {
                  reject(countErr);
                  return;
                }

                const incompatibleCount = countRow?.count || 0;
                const migrationRecommended = incompatibleCount > 0;

                // Update model info in database
                this.db!.run(
                  'UPDATE embedding_models SET current_provider = ?, current_dimensions = ?, current_format = ?, last_model_change = CURRENT_TIMESTAMP, migration_needed = ? WHERE project_id = ?',
                  [
                    currentProvider,
                    currentDimensions,
                    currentFormat,
                    migrationRecommended ? 1 : 0,
                    projectId,
                  ],
                  updateErr => {
                    if (updateErr) {
                      reject(updateErr);
                      return;
                    }

                    logger.warn('⚠️ Embedding model change detected', {
                      projectId,
                      previousProvider: previousModel.currentProvider,
                      currentProvider,
                      previousDimensions: previousModel.currentDimensions,
                      currentDimensions,
                      incompatibleEmbeddings: incompatibleCount,
                      migrationRecommended,
                    });

                    resolve({
                      changed: true,
                      previousModel,
                      currentModel: { ...currentModel, migrationNeeded: migrationRecommended },
                      incompatibleEmbeddings: incompatibleCount,
                      migrationRecommended,
                    });
                  }
                );
              }
            );
          } else {
            resolve({
              changed: false,
              currentModel: previousModel,
              incompatibleEmbeddings: 0,
              migrationRecommended: false,
            });
          }
        }
      );
    });
  }

  /**
   * Get embedding model info for a project
   */
  async getModelInfo(projectId: string): Promise<EmbeddingModelInfo | null> {
    if (!this.initialized) {
      await this.initializeDatabase();
    }

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }

      this.db.get(
        'SELECT * FROM embedding_models WHERE project_id = ?',
        [projectId],
        (err, row: any) => {
          if (err) {
            reject(err);
          } else if (!row) {
            resolve(null);
          } else {
            const norm = (label: string) => {
              const l = (label || '').toLowerCase();
              if (l.startsWith('text-embedding-')) return 'openai';
              if (l.startsWith('voyage-') || l === 'voyageai' || l === 'ambiance')
                return 'voyageai';
              if (l.includes('minilm') || l.includes('transformers')) return 'local';
              return label;
            };
            resolve({
              projectId: row.project_id,
              currentProvider: norm(row.current_provider),
              currentDimensions: row.current_dimensions,
              currentFormat: row.current_format,
              lastModelChange: new Date(row.last_model_change),
              migrationNeeded: row.migration_needed === 1,
            });
          }
        }
      );
    });
  }

  /**
   * Validate embedding compatibility for similarity search
   * Now also checks if stored embeddings match the current model configuration
   */
  async validateEmbeddingCompatibility(
    projectId: string,
    currentProvider?: string,
    currentDimensions?: number
  ): Promise<{
    compatible: boolean;
    issues: string[];
    recommendations: string[];
  }> {
    if (!this.initialized) {
      await this.initializeDatabase();
    }

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }

      // First, check the embedding_models table for the authoritative model info
      this.db.get(
        'SELECT * FROM embedding_models WHERE project_id = ?',
        [projectId],
        (modelErr, modelRow: any) => {
          if (modelErr) {
            reject(modelErr);
            return;
          }

          const issues: string[] = [];
          const recommendations: string[] = [];
          let compatible = true;

          // Normalize provider labels (handle legacy rows that stored model as provider)
          const norm = (label: string) => {
            const l = (label || '').toLowerCase();
            if (l.startsWith('text-embedding-')) return 'openai';
            if (l.startsWith('voyage-') || l === 'voyageai' || l === 'ambiance') return 'voyageai';
            if (l.includes('minilm') || l.includes('transformers') || l.includes('e5'))
              return 'local';
            return label;
          };

          // If we have model info in the table, use that as the source of truth
          if (modelRow) {
            const storedProvider = norm(modelRow.current_provider);
            const storedDimensions = modelRow.current_dimensions;

            logger.debug('🔍 Checking embedding model compatibility using model table', {
              currentProvider,
              currentDimensions,
              storedProvider,
              storedDimensions,
              modelRowExists: true,
              providerMatch: currentProvider ? norm(currentProvider) === storedProvider : true,
              dimensionMatch: currentDimensions ? storedDimensions === currentDimensions : true,
            });

            // Check if current model matches stored model
            if (currentProvider && currentDimensions) {
              const normalizedCurrentProvider = norm(currentProvider);

              if (
                normalizedCurrentProvider !== storedProvider ||
                storedDimensions !== currentDimensions
              ) {
                compatible = false;
                issues.push(
                  `Stored model configuration (${storedProvider}, ${storedDimensions}D) doesn't match current model (${normalizedCurrentProvider}, ${currentDimensions}D)`
                );
                recommendations.push(
                  'Run "manage_embeddings action=create" to regenerate embeddings with the current model configuration'
                );
              }
            }

            // Also check that stored embeddings match the model table info
            this.db!.all(
              `SELECT
                metadata_embedding_provider,
                metadata_embedding_dimensions,
                COUNT(*) as count
              FROM embeddings
              WHERE project_id = ?
              GROUP BY metadata_embedding_provider, metadata_embedding_dimensions`,
              [projectId],
              (embedErr, embedRows: any[]) => {
                if (embedErr) {
                  reject(embedErr);
                  return;
                }

                const merged: Record<
                  string,
                  { provider: string; dimensions: number; count: number }
                > = {};
                for (const r of embedRows) {
                  const key = `${norm(r.metadata_embedding_provider)}:${r.metadata_embedding_dimensions}`;
                  if (!merged[key]) {
                    merged[key] = {
                      provider: norm(r.metadata_embedding_provider),
                      dimensions: r.metadata_embedding_dimensions,
                      count: 0,
                    };
                  }
                  merged[key].count += r.count;
                }
                const mergedRows = Object.values(merged);

                // Check for consistency between model table and stored embeddings
                if (mergedRows.length > 0) {
                  const modelTableProvider = storedProvider;
                  const modelTableDimensions = storedDimensions;

                  const inconsistentEmbeddings = mergedRows.filter(
                    row =>
                      row.provider !== modelTableProvider || row.dimensions !== modelTableDimensions
                  );

                  if (inconsistentEmbeddings.length > 0) {
                    compatible = false;
                    const inconsistencySummary = inconsistentEmbeddings
                      .map(row => `${row.provider} (${row.dimensions}D): ${row.count} embeddings`)
                      .join(', ');

                    issues.push(
                      `Stored embeddings don't match model configuration: ${inconsistencySummary} vs expected ${modelTableProvider} (${modelTableDimensions}D)`
                    );
                    recommendations.push(
                      'Run "manage_embeddings action=create" to fix embedding metadata consistency'
                    );
                  }
                }

                // Check for null or invalid dimensions
                this.db!.get(
                  'SELECT COUNT(*) as count FROM embeddings WHERE project_id = ? AND (metadata_embedding_dimensions IS NULL OR metadata_embedding_dimensions <= 0)',
                  [projectId],
                  (nullErr, nullRow: any) => {
                    if (nullErr) {
                      reject(nullErr);
                      return;
                    }

                    if (nullRow?.count > 0) {
                      compatible = false;
                      issues.push(
                        `${nullRow.count} embeddings have invalid or missing dimension information`
                      );
                      recommendations.push('Regenerate embeddings with proper metadata');
                    }

                    resolve({
                      compatible,
                      issues,
                      recommendations,
                    });
                  }
                );
              }
            );
          } else {
            // Fallback to checking embeddings directly if no model info exists
            logger.debug('🔍 No model info in table, falling back to embedding metadata check', {
              modelRow: modelRow,
              modelRowExists: !!modelRow,
            });

            this.db!.all(
              `SELECT
                metadata_embedding_provider,
                metadata_embedding_dimensions,
                COUNT(*) as count
              FROM embeddings
              WHERE project_id = ?
              GROUP BY metadata_embedding_provider, metadata_embedding_dimensions`,
              [projectId],
              (embedErr, embedRows: any[]) => {
                if (embedErr) {
                  reject(embedErr);
                  return;
                }

                const merged: Record<
                  string,
                  { provider: string; dimensions: number; count: number }
                > = {};
                for (const r of embedRows) {
                  const key = `${norm(r.metadata_embedding_provider)}:${r.metadata_embedding_dimensions}`;
                  if (!merged[key]) {
                    merged[key] = {
                      provider: norm(r.metadata_embedding_provider),
                      dimensions: r.metadata_embedding_dimensions,
                      count: 0,
                    };
                  }
                  merged[key].count += r.count;
                }
                const mergedRows = Object.values(merged);

                if (mergedRows.length > 1) {
                  compatible = false;
                  const modelSummary = mergedRows
                    .map(row => `${row.provider} (${row.dimensions}D): ${row.count} embeddings`)
                    .join(', ');

                  issues.push(`Mixed embedding models detected: ${modelSummary}`);
                  recommendations.push(
                    'Consider regenerating all embeddings with a single model for consistent similarity search results'
                  );
                }

                if (mergedRows.length === 0) {
                  issues.push('No embeddings found for this project');
                  recommendations.push('Generate embeddings for the project first');
                }

                // Check if stored embeddings match current model configuration
                if (currentProvider && currentDimensions && mergedRows.length === 1) {
                  const storedModel = mergedRows[0];
                  const normalizedCurrentProvider = norm(currentProvider);
                  const normalizedStoredProvider = norm(storedModel.provider);

                  if (
                    normalizedStoredProvider !== normalizedCurrentProvider ||
                    storedModel.dimensions !== currentDimensions
                  ) {
                    compatible = false;
                    issues.push(
                      `Stored embeddings (${normalizedStoredProvider}, ${storedModel.dimensions}D) don't match current model (${normalizedCurrentProvider}, ${currentDimensions}D)`
                    );
                    recommendations.push(
                      'Run "manage_embeddings action=create" to regenerate embeddings with the current model configuration'
                    );
                  }
                }

                // Check for null or invalid dimensions
                this.db!.get(
                  'SELECT COUNT(*) as count FROM embeddings WHERE project_id = ? AND (metadata_embedding_dimensions IS NULL OR metadata_embedding_dimensions <= 0)',
                  [projectId],
                  (nullErr, nullRow: any) => {
                    if (nullErr) {
                      reject(nullErr);
                      return;
                    }

                    if (nullRow?.count > 0) {
                      compatible = false;
                      issues.push(
                        `${nullRow.count} embeddings have invalid or missing dimension information`
                      );
                      recommendations.push('Regenerate embeddings with proper metadata');
                    }

                    resolve({
                      compatible,
                      issues,
                      recommendations,
                    });
                  }
                );
              }
            );
          }
        }
      );
    });
  }

  /**
   * Ensure database can handle embeddings with specified dimensions
   * Automatically clears incompatible embeddings when dimensions change
   */
  async ensureDimensionCompatibility(dimensions: number): Promise<void> {
    await this.initializeDatabase();

    logger.info('🔍 Checking database dimension compatibility', { dimensions });

    // Check if there are existing embeddings with different dimensions
    return new Promise((resolve, reject) => {
      this.db!.get(
        `SELECT DISTINCT metadata_embedding_dimensions as existing_dimensions, COUNT(*) as count,
                GROUP_CONCAT(DISTINCT project_id) as affected_projects
         FROM embeddings
         WHERE metadata_embedding_dimensions IS NOT NULL 
         LIMIT 1`,
        (err, row: any) => {
          if (err) {
            reject(new Error(`Failed to check existing dimensions: ${err.message}`));
            return;
          }

          if (row && row.existing_dimensions && row.existing_dimensions !== dimensions) {
            logger.warn('🚨 Incompatible embedding dimensions detected - clearing old embeddings', {
              existing: row.existing_dimensions,
              requested: dimensions,
              affectedEmbeddings: row.count,
              affectedProjects: row.affected_projects,
            });

            // Clear all incompatible embeddings
            this.db!.run(
              `DELETE FROM embeddings WHERE metadata_embedding_dimensions != ?`,
              [dimensions],
              deleteErr => {
                if (deleteErr) {
                  reject(
                    new Error(`Failed to clear incompatible embeddings: ${deleteErr.message}`)
                  );
                  return;
                }

                // Also clear related metadata for affected projects
                this.db!.run(
                  `DELETE FROM project_stats WHERE project_id IN (${
                    row.affected_projects
                      ?.split(',')
                      .map(() => '?')
                      .join(',') || ''
                  })`,
                  row.affected_projects?.split(',') || [],
                  metaErr => {
                    if (metaErr) {
                      logger.warn('⚠️ Failed to clear project metadata', {
                        error: metaErr.message,
                      });
                    }

                    logger.info('🧹 Successfully cleared incompatible embeddings', {
                      clearedEmbeddings: row.count,
                      oldDimensions: row.existing_dimensions,
                      newDimensions: dimensions,
                      affectedProjects: row.affected_projects,
                    });

                    logger.info('✅ Database is now ready for new embedding dimensions', {
                      dimensions,
                    });
                    resolve();
                  }
                );
              }
            );
          } else {
            logger.info('✅ Database dimension compatibility verified', {
              dimensions,
              hasExistingData: !!row && row.count > 0,
              existingDimensions: row?.existing_dimensions || 'none',
            });

            resolve();
          }
        }
      );
    });
  }

  /**
   * Clear all embeddings and start fresh (useful when changing providers/models)
   */
  async clearAllEmbeddings(): Promise<void> {
    await this.initializeDatabase();

    logger.info('🧹 Clearing all embeddings for fresh start');

    return new Promise((resolve, reject) => {
      this.db!.serialize(() => {
        // Get stats before clearing
        this.db!.get(
          `SELECT COUNT(*) as embedding_count, COUNT(DISTINCT project_id) as project_count FROM embeddings`,
          (err, stats: any) => {
            if (err) {
              logger.warn('⚠️ Could not get stats before clearing', { error: err.message });
            }

            // Clear embeddings table
            this.db!.run(`DELETE FROM embeddings`, deleteErr => {
              if (deleteErr) {
                reject(new Error(`Failed to clear embeddings: ${deleteErr.message}`));
                return;
              }

              // Clear projects metadata
              this.db!.run(`DELETE FROM project_stats`, metaErr => {
                if (metaErr) {
                  logger.warn('⚠️ Failed to clear project metadata', { error: metaErr.message });
                }

                logger.info('🧹 Successfully cleared all embeddings', {
                  clearedEmbeddings: stats?.embedding_count || 0,
                  clearedProjects: stats?.project_count || 0,
                });

                resolve();
              });
            });
          }
        );
      });
    });
  }

  /**
   * Clear embeddings for a specific project
   */
  async clearProjectEmbeddings(projectId: string): Promise<void> {
    await this.initializeDatabase();

    logger.info('🧹 Clearing embeddings for project', { projectId });

    return new Promise((resolve, reject) => {
      this.db!.serialize(() => {
        // Get count before clearing
        this.db!.get(
          `SELECT COUNT(*) as count FROM embeddings WHERE project_id = ?`,
          [projectId],
          (err, stats: any) => {
            if (err) {
              logger.warn('⚠️ Could not get project stats before clearing', {
                error: err.message,
                projectId,
              });
            }

            // Clear project embeddings
            this.db!.run(`DELETE FROM embeddings WHERE project_id = ?`, [projectId], deleteErr => {
              if (deleteErr) {
                reject(new Error(`Failed to clear project embeddings: ${deleteErr.message}`));
                return;
              }

              // Clear project metadata
              this.db!.run(
                `DELETE FROM project_stats WHERE project_id = ?`,
                [projectId],
                metaErr => {
                  if (metaErr) {
                    logger.warn('⚠️ Failed to clear project metadata', {
                      error: metaErr.message,
                      projectId,
                    });
                  }

                  // Clear embedding model info for the project
                  this.db!.run(
                    `DELETE FROM embedding_models WHERE project_id = ?`,
                    [projectId],
                    modelErr => {
                      if (modelErr) {
                        logger.warn('⚠️ Failed to clear embedding model info', {
                          error: modelErr.message,
                          projectId,
                        });
                      }

                      logger.info('🧹 Successfully cleared project embeddings', {
                        projectId,
                        clearedEmbeddings: stats?.count || 0,
                      });

                      resolve();
                    }
                  );
                }
              );
            });
          }
        );
      });
    });
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    if (this.db) {
      return new Promise(resolve => {
        this.db!.close(err => {
          if (err) {
            logger.error('❌ Error closing database', { error: err.message });
          } else {
            logger.info('✅ Database connection closed');
          }
          this.initialized = false;
          resolve();
        });
      });
    }
  }

  /**
   * Check if local storage is enabled
   */
  static isEnabled(): boolean {
    return process.env.USE_LOCAL_EMBEDDINGS === 'true';
  }

  /**
   * Parse quota size string (e.g., "1GB", "500MB", "1000KB") to bytes
   */
  private parseQuotaSize(quotaStr: string): number {
    const match = quotaStr.trim().match(/^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)?$/i);
    if (!match) {
      logger.warn('⚠️ Invalid quota format, using 10GB default', { quotaStr });
      return 10 * 1024 * 1024 * 1024; // 10GB
    }

    const value = parseFloat(match[1]);
    const unit = match[2]?.toUpperCase() || 'MB';

    const multipliers: Record<string, number> = {
      KB: 1024,
      MB: 1024 * 1024,
      GB: 1024 * 1024 * 1024,
      TB: 1024 * 1024 * 1024 * 1024,
    };

    return Math.floor(value * multipliers[unit]);
  }

  /**
   * Format quota size in bytes to human-readable string
   */
  private formatQuotaSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }

    return `${value.toFixed(1)}${units[unitIndex]}`;
  }

  /**
   * Set quota for a specific project
   */
  setProjectQuota(projectId: string, quotaBytes: number): void {
    this.projectQuotas.set(projectId, quotaBytes);
    logger.info('🔧 Project quota updated', {
      projectId,
      quota: this.formatQuotaSize(quotaBytes),
    });
  }

  /**
   * Get quota for a specific project (or global quota if not set)
   */
  private getQuotaForProject(projectId: string): number {
    return this.projectQuotas.get(projectId) || this.globalQuota;
  }

  /**
   * Get current storage usage for a project
   */
  async getProjectStorageUsage(projectId: string): Promise<{
    totalBytes: number;
    embeddingCount: number;
    fileCount: number;
    quotaBytes: number;
    usagePercentage: number;
    remainingBytes: number;
  }> {
    if (!this.initialized) {
      await this.initializeDatabase();
    }

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }

      // Get storage usage for project
      this.db.get(
        `
        SELECT
          COUNT(*) as embedding_count,
          COUNT(DISTINCT file_id) as file_count,
          SUM(LENGTH(embedding)) as total_bytes
        FROM embeddings
        WHERE project_id = ?
      `,
        [projectId],
        (err, row: any) => {
          if (err) {
            reject(err);
            return;
          }

          const quotaBytes = this.getQuotaForProject(projectId);
          const totalBytes = row?.total_bytes || 0;
          const embeddingCount = row?.embedding_count || 0;
          const fileCount = row?.file_count || 0;
          const usagePercentage = quotaBytes > 0 ? (totalBytes / quotaBytes) * 100 : 0;
          const remainingBytes = Math.max(0, quotaBytes - totalBytes);

          resolve({
            totalBytes,
            embeddingCount,
            fileCount,
            quotaBytes,
            usagePercentage,
            remainingBytes,
          });
        }
      );
    });
  }

  /**
   * Check if storing embeddings would exceed quota and enforce cleanup if needed
   */
  private async checkAndEnforceQuota(
    projectId: string,
    newEmbeddingSize: number
  ): Promise<{
    canStore: boolean;
    quotaExceeded: boolean;
    cleanupRequired: boolean;
    cleanedEmbeddings?: number;
  }> {
    if (!this.enableQuotas) {
      return { canStore: true, quotaExceeded: false, cleanupRequired: false };
    }

    const currentUsage = await this.getProjectStorageUsage(projectId);
    const quotaBytes = this.getQuotaForProject(projectId);
    const projectedUsage = currentUsage.totalBytes + newEmbeddingSize;

    if (projectedUsage <= quotaBytes) {
      return { canStore: true, quotaExceeded: false, cleanupRequired: false };
    }

    // Quota would be exceeded, try cleanup
    logger.warn('⚠️ Storage quota exceeded, attempting cleanup', {
      projectId,
      currentUsage: this.formatQuotaSize(currentUsage.totalBytes),
      quota: this.formatQuotaSize(quotaBytes),
      projectedUsage: this.formatQuotaSize(projectedUsage),
      excess: this.formatQuotaSize(projectedUsage - quotaBytes),
    });

    const cleanedEmbeddings = await this.cleanupOldEmbeddings(
      projectId,
      projectedUsage - quotaBytes
    );

    // Check again after cleanup
    const finalUsage = await this.getProjectStorageUsage(projectId);
    const canStore = finalUsage.totalBytes + newEmbeddingSize <= quotaBytes;

    return {
      canStore,
      quotaExceeded: !canStore,
      cleanupRequired: true,
      cleanedEmbeddings,
    };
  }

  /**
   * Clean up old embeddings using LRU strategy (by created_at timestamp)
   */
  private async cleanupOldEmbeddings(projectId: string, targetReduction: number): Promise<number> {
    if (!this.initialized) {
      await this.initializeDatabase();
    }

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }

      let cleanedCount = 0;
      let totalCleanedSize = 0;

      // Get embeddings ordered by creation time (oldest first)
      this.db.all(
        `
        SELECT id, LENGTH(embedding) as size, created_at
        FROM embeddings
        WHERE project_id = ?
        ORDER BY created_at ASC
      `,
        [projectId],
        (err, rows: any[]) => {
          if (err) {
            reject(err);
            return;
          }

          const toDelete: string[] = [];
          for (const row of rows) {
            toDelete.push(row.id);
            totalCleanedSize += row.size;
            cleanedCount++;

            if (totalCleanedSize >= targetReduction) {
              break;
            }
          }

          if (toDelete.length === 0) {
            resolve(0);
            return;
          }

          // Delete old embeddings
          const placeholders = toDelete.map(() => '?').join(',');
          this.db!.run(
            `DELETE FROM embeddings WHERE id IN (${placeholders})`,
            toDelete,
            (deleteErr: Error | null) => {
              if (deleteErr) {
                reject(deleteErr);
                return;
              }

              logger.info('🧹 Cleaned up old embeddings', {
                projectId,
                cleanedCount,
                cleanedSize: this.formatQuotaSize(totalCleanedSize),
                targetReduction: this.formatQuotaSize(targetReduction),
              });

              // Update project stats
              this.db!.run(
                'UPDATE project_stats SET total_chunks = (SELECT COUNT(*) FROM embeddings WHERE project_id = ?), total_files = (SELECT COUNT(DISTINCT file_id) FROM embeddings WHERE project_id = ?), last_updated = CURRENT_TIMESTAMP WHERE project_id = ?',
                [projectId, projectId, projectId],
                (statsErr: Error | null) => {
                  if (statsErr) {
                    logger.warn('⚠️ Failed to update project stats after cleanup', {
                      error: statsErr.message,
                    });
                  }
                }
              );

              resolve(cleanedCount);
            }
          );
        }
      );
    });
  }

  /**
   * Estimate the storage size of an embedding
   */
  private estimateEmbeddingSize(embedding: number[] | QuantizedEmbedding): number {
    if (isQuantized(embedding)) {
      // For quantized embeddings, use the actual serialized size
      return JSON.stringify(embedding).length;
    } else {
      // For float32 embeddings, estimate based on dimensions
      // JSON overhead + 4 bytes per float32
      const dimensions = embedding.length;
      return dimensions * 4 + 100; // Conservative estimate with JSON overhead
    }
  }

  /**
   * Check if quotas are enabled
   */
  isQuotasEnabled(): boolean {
    return this.enableQuotas;
  }

  /**
   * Get global quota
   */
  getGlobalQuota(): number {
    return this.globalQuota;
  }

  /**
   * Set global quota
   */
  setGlobalQuota(quotaBytes: number): void {
    this.globalQuota = quotaBytes;
    logger.info('🔧 Global quota updated', {
      quota: this.formatQuotaSize(quotaBytes),
    });
  }

  /**
   * Check if quantization is enabled
   */
  isQuantizationEnabled(): boolean {
    return this.enableQuantization;
  }

  /**
   * Enable or disable quantization for future embeddings
   */
  setQuantizationEnabled(enabled: boolean): void {
    this.enableQuantization = enabled;
    logger.info('🔧 Quantization setting updated', { enabled });
  }

  /**
   * Get storage statistics including quantization information
   */
  async getStorageStats(projectId?: string): Promise<{
    totalEmbeddings: number;
    totalProjects: number;
    quantizedEmbeddings: number;
    float32Embeddings: number;
    storageSavings: number;
    averageCompressionRatio: number;
    projectStats?: {
      totalChunks: number;
      totalFiles: number;
      quantizedChunks: number;
      float32Chunks: number;
    };
  }> {
    if (!this.initialized) {
      await this.initializeDatabase();
    }

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }

      let query = `
        SELECT
          COUNT(*) as total_embeddings,
          COUNT(CASE WHEN metadata_embedding_format = 'int8' THEN 1 END) as quantized_embeddings,
          COUNT(CASE WHEN metadata_embedding_format = 'float32' OR metadata_embedding_format IS NULL THEN 1 END) as float32_embeddings
        FROM embeddings
      `;

      const params: any[] = [];

      if (projectId) {
        query += ' WHERE project_id = ?';
        params.push(projectId);
      }

      this.db!.get(query, params, (err, globalStats: any) => {
        if (err) {
          reject(err);
          return;
        }

        // Calculate storage savings estimate
        const totalChunks = globalStats.total_embeddings;
        const quantizedChunks = globalStats.quantized_embeddings;
        const float32Chunks = globalStats.float32_embeddings;

        // Estimate storage: float32 = ~4 bytes per dimension, int8 = ~1 byte per dimension
        // Average embedding dimension estimate (conservative)
        const avgDimensions = 1536; // Conservative estimate
        const float32SizePerEmbedding = avgDimensions * 4;
        const int8SizePerEmbedding = avgDimensions * 1;

        const totalFloat32Size = float32Chunks * float32SizePerEmbedding;
        const totalInt8Size = quantizedChunks * int8SizePerEmbedding;
        const totalActualSize = totalFloat32Size + totalInt8Size;

        const originalSizeIfAllFloat32 = totalChunks * float32SizePerEmbedding;
        const storageSavings = originalSizeIfAllFloat32 - totalActualSize;
        const compressionRatio = totalChunks > 0 ? originalSizeIfAllFloat32 / totalActualSize : 1;

        let projectStats = undefined;
        if (projectId) {
          this.db!.get(
            `
            SELECT
              COUNT(*) as total_chunks,
              COUNT(CASE WHEN metadata_embedding_format = 'int8' THEN 1 END) as quantized_chunks,
              COUNT(CASE WHEN metadata_embedding_format = 'float32' OR metadata_embedding_format IS NULL THEN 1 END) as float32_chunks
            FROM embeddings
            WHERE project_id = ?
          `,
            [projectId],
            (projErr, projStats: any) => {
              if (projErr) {
                reject(projErr);
                return;
              }

              resolve({
                totalEmbeddings: globalStats.total_embeddings,
                totalProjects: 0, // Would need additional query for this
                quantizedEmbeddings: globalStats.quantized_embeddings,
                float32Embeddings: globalStats.float32_embeddings,
                storageSavings,
                averageCompressionRatio: compressionRatio,
                projectStats: projStats
                  ? {
                      totalChunks: projStats.total_chunks,
                      totalFiles: projStats.total_chunks, // Approximation
                      quantizedChunks: projStats.quantized_chunks,
                      float32Chunks: projStats.float32_chunks,
                    }
                  : undefined,
              });
            }
          );
        } else {
          resolve({
            totalEmbeddings: globalStats.total_embeddings,
            totalProjects: 0, // Would need additional query for this
            quantizedEmbeddings: globalStats.quantized_embeddings,
            float32Embeddings: globalStats.float32_embeddings,
            storageSavings,
            averageCompressionRatio: compressionRatio,
          });
        }
      });
    });
  }
}

// Export a default instance
export const embeddingStorage = new LocalEmbeddingStorage();
