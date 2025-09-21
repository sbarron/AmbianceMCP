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

export interface EmbeddingChunk {
  id: string;
  projectId: string;
  fileId: string; // Reference to files table instead of direct path
  filePath: string; // Keep for backward compatibility and queries
  chunkIndex: number;
  content: string;
  embedding: number[];
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

export class LocalEmbeddingStorage {
  private db: Database | null = null;
  private dbPath: string;
  private initialized = false;

  // Prepared statements for performance
  private insertStmt: Statement | null = null;
  private updateStmt: Statement | null = null;
  private searchStmt: Statement | null = null;
  private projectStmt: Statement | null = null;

  // File management statements
  private insertFileStmt: Statement | null = null;
  private updateFileStmt: Statement | null = null;
  private getFileStmt: Statement | null = null;
  private listProjectFilesStmt: Statement | null = null;

  constructor(customPath?: string) {
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

    logger.info('💾 Local embedding storage initialized', {
      dbPath: this.dbPath,
      useLocalEmbeddings: process.env.USE_LOCAL_EMBEDDINGS === 'true',
      customPath: !!customPath,
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

      // Check if we need to migrate from the old schema
      this.db.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'",
        (err, row) => {
          if (err) {
            reject(err);
            return;
          }

          const hasOldSchema = !!row;
          this.migrateDatabaseIfNeeded(hasOldSchema)
            .then(() => {
              logger.info('✅ Database schema is up to date');
              resolve();
            })
            .catch(reject);
        }
      );
    });
  }

  /**
   * Migrate database schema if needed
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
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_project_id ON embeddings(project_id);
        CREATE INDEX IF NOT EXISTS idx_file_id ON embeddings(file_id);
        CREATE INDEX IF NOT EXISTS idx_file_path ON embeddings(file_path);
        CREATE INDEX IF NOT EXISTS idx_hash ON embeddings(hash);
        CREATE INDEX IF NOT EXISTS idx_created_at ON embeddings(created_at);

        -- Create a table for tracking project embedding stats
        CREATE TABLE IF NOT EXISTS project_stats (
          project_id TEXT PRIMARY KEY,
          total_chunks INTEGER DEFAULT 0,
          total_files INTEGER DEFAULT 0,
          last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- Create a table for tracking embedding model configurations
        CREATE TABLE IF NOT EXISTS embedding_models (
          project_id TEXT PRIMARY KEY,
          current_provider TEXT NOT NULL,
          current_dimensions INTEGER NOT NULL,
          current_format TEXT NOT NULL,
          last_model_change DATETIME DEFAULT CURRENT_TIMESTAMP,
          migration_needed BOOLEAN DEFAULT FALSE
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

    return new Promise((resolve, reject) => {
      // Serialize embedding vector as JSON
      const embeddingBlob = Buffer.from(JSON.stringify(chunk.embedding));
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
          chunk.metadata.embeddingFormat || null,
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
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Convert database row to EmbeddingChunk object
   */
  private rowToChunk(row: any): EmbeddingChunk {
    const embeddingBuffer = row.embedding as Buffer;
    const embedding = JSON.parse(embeddingBuffer.toString()) as number[];
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
   */
  async validateEmbeddingCompatibility(projectId: string): Promise<{
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

      // Check for mixed dimensions and providers
      this.db.all(
        `SELECT 
          metadata_embedding_provider, 
          metadata_embedding_dimensions, 
          COUNT(*) as count 
        FROM embeddings 
        WHERE project_id = ? 
        GROUP BY metadata_embedding_provider, metadata_embedding_dimensions`,
        [projectId],
        (err, rows: any[]) => {
          if (err) {
            reject(err);
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
            if (l.includes('minilm') || l.includes('transformers')) return 'local';
            return label;
          };
          const merged: Record<string, { provider: string; dimensions: number; count: number }> =
            {};
          for (const r of rows) {
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
}

// Export a default instance
export const embeddingStorage = new LocalEmbeddingStorage();
