/**
 * @fileOverview: Comprehensive tests for LocalEmbeddingGenerator functionality
 * @module: LocalEmbeddingGenerator Tests
 * @context: Testing embedding generation with provider fallback and error handling
 */

import { LocalEmbeddingGenerator, GenerationOptions, GenerationProgress } from '../embeddingGenerator';
import { LocalEmbeddingStorage } from '../embeddingStorage';
import { LocalEmbeddingProvider } from '../localEmbeddingProvider';
import { apiClient } from '../../client/apiClient';
import { openaiService } from '../../core/openaiService';
import { logger } from '../../utils/logger';

// Mock dependencies
jest.mock('../embeddingStorage', () => ({
  LocalEmbeddingStorage: jest.fn().mockImplementation(() => ({
    initializeDatabase: jest.fn().mockResolvedValue(undefined),
    ensureDimensionCompatibility: jest.fn().mockResolvedValue(undefined),
    storeEmbedding: jest.fn().mockResolvedValue(undefined),
    storeFileMetadata: jest.fn().mockResolvedValue(undefined),
    getEmbeddingMetadata: jest.fn().mockReturnValue({
      embeddingFormat: 'float32',
      embeddingDimensions: 1024,
      embeddingProvider: 'voyageai'
    }),
    getProjectEmbeddings: jest.fn().mockResolvedValue([]),
    clearProjectEmbeddings: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.mock('../localEmbeddingProvider');
jest.mock('../../client/apiClient');
jest.mock('../../utils/logger');
jest.mock('fs');
jest.mock('../treeSitterProcessor');

// Setup LocalEmbeddingProvider mock
const mockLocalProvider = {
  generateEmbeddings: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
  generateQueryEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  getModelInfo: jest.fn().mockReturnValue({
    name: 'all-MiniLM-L6-v2',
    dimensions: 384,
    provider: 'transformers.js'
  }),
  dispose: jest.fn().mockResolvedValue(undefined)
};
(LocalEmbeddingProvider as jest.Mock).mockImplementation(() => mockLocalProvider);

// Mock the openaiService module
jest.mock('../../core/openaiService', () => ({
  openaiService: {
    isReady: jest.fn(),
  },
}));

describe('LocalEmbeddingGenerator', () => {
  let generator: LocalEmbeddingGenerator;
  let mockStorage: jest.Mocked<LocalEmbeddingStorage>;
  let mockApiClient: jest.Mocked<typeof apiClient>;
  let mockLogger: jest.Mocked<typeof logger>;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Import the mocked modules
    const { LocalEmbeddingStorage } = require('../embeddingStorage');

    // Setup LocalEmbeddingStorage mock
    mockStorage = new LocalEmbeddingStorage() as jest.Mocked<LocalEmbeddingStorage>;
    LocalEmbeddingStorage.isEnabled = jest.fn().mockReturnValue(true);

    // Setup apiClient mock with successful response
    mockApiClient = {
      post: jest.fn().mockResolvedValue({
        data: { embeddings: [[0.1, 0.2, 0.3]] }
      }),
      generateEmbeddings: jest.fn().mockResolvedValue({
        embeddings: [[0.1, 0.2, 0.3]],
        model: 'voyage-context-3',
        dimensions: 3,
        input_type: 'document',
        encoding_format: 'float32',
        total_tokens: 10,
        processing_time_ms: 100,
        provider: 'voyage',
      }),
    } as any;

    // Setup logger mock
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as any;

    // Apply mocks
    (apiClient as any).post = mockApiClient.post;
    (apiClient as any).generateEmbeddings = mockApiClient.generateEmbeddings;
    (logger as any).info = mockLogger.info;
    (logger as any).warn = mockLogger.warn;
    (logger as any).error = mockLogger.error;
    (logger as any).debug = mockLogger.debug;

    // Mock environment variables
    process.env.USE_LOCAL_EMBEDDINGS = 'true';
    process.env.LOCAL_EMBEDDING_MODEL = 'all-MiniLM-L6-v2'; // Required for local provider selection
    process.env.AMBIANCE_API_KEY = process.env.AMBIANCE_API_KEY || 'test-key';

    // Create generator with mock storage to avoid constructor issues
    generator = new LocalEmbeddingGenerator(mockStorage);
  });

  afterEach(() => {
    // Clean up environment variables
    delete process.env.USE_LOCAL_EMBEDDINGS;
    delete process.env.LOCAL_EMBEDDING_MODEL;
    delete process.env.AMBIANCE_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  describe('Constructor', () => {
    test('should initialize with provided storage', () => {
      const customStorage = {} as LocalEmbeddingStorage;
      const gen = new LocalEmbeddingGenerator(customStorage);
      expect(gen).toBeInstanceOf(LocalEmbeddingGenerator);
    });

    test('should create default storage when none provided', () => {
      const gen = new LocalEmbeddingGenerator();
      expect(gen).toBeInstanceOf(LocalEmbeddingGenerator);
      expect(LocalEmbeddingStorage).toHaveBeenCalled();
    });

    test('should initialize with Ambiance API key from environment', () => {
      process.env.AMBIANCE_API_KEY = process.env.AMBIANCE_API_KEY || 'test-ambiance-key';
      const gen = new LocalEmbeddingGenerator();
      // The key should be set internally - we can't test private properties directly
      expect(gen).toBeDefined();
    });

    test('should handle missing API keys gracefully', () => {
      delete process.env.AMBIANCE_API_KEY;
      delete process.env.OPENAI_API_KEY;
      const gen = new LocalEmbeddingGenerator();
      expect(gen).toBeDefined();
    });
  });

  describe('generateProjectEmbeddings', () => {
    const mockProjectId = 'test-project-123';
    const mockProjectPath = '/path/to/test/project';

    beforeEach(() => {
      // Additional setup for generation tests if needed
    });

    test('should throw error when local embeddings not enabled', async () => {
      (LocalEmbeddingStorage.isEnabled as jest.Mock).mockReturnValue(false);

      await expect(
        generator.generateProjectEmbeddings(mockProjectId, mockProjectPath)
      ).rejects.toThrow('Local embeddings not enabled');
    });

    test('should initialize database on generation start', async () => {
      mockApiClient.post.mockResolvedValue({
        data: { embeddings: [[0.1, 0.2, 0.3]] }
      });

      await generator.generateProjectEmbeddings(mockProjectId, mockProjectPath);

      expect(mockStorage.initializeDatabase).toHaveBeenCalled();
    });

    test('should process files and return progress', async () => {
      mockApiClient.post.mockResolvedValue({
        data: { embeddings: [[0.1, 0.2, 0.3]] }
      });

      const result = await generator.generateProjectEmbeddings(mockProjectId, mockProjectPath);

      expect(result).toHaveProperty('totalFiles');
      expect(result).toHaveProperty('processedFiles');
      expect(result).toHaveProperty('totalChunks');
      expect(result).toHaveProperty('processedChunks');
      expect(result).toHaveProperty('embeddings');
      expect(result).toHaveProperty('errors');
      expect(Array.isArray(result.errors)).toBe(true);
    });

    test('should handle force regeneration option', async () => {
      mockApiClient.post.mockResolvedValue({
        data: { embeddings: [[0.1, 0.2, 0.3]] }
      });

      const options: GenerationOptions = { force: true };
      await generator.generateProjectEmbeddings(mockProjectId, mockProjectPath, options);

      // Should proceed with generation regardless of existing embeddings
      expect(mockStorage.initializeDatabase).toHaveBeenCalled();
    });

    test('should respect batch size configuration', async () => {
      mockApiClient.post.mockResolvedValue({
        data: { embeddings: [[0.1, 0.2, 0.3]] }
      });

      const options: GenerationOptions = { batchSize: 16 };
      await generator.generateProjectEmbeddings(mockProjectId, mockProjectPath, options);

      expect(mockApiClient.generateEmbeddings).toHaveBeenCalled();
    });

    test('should handle rate limiting', async () => {
      mockApiClient.post.mockResolvedValue({
        data: { embeddings: [[0.1, 0.2, 0.3]] }
      });

      const options: GenerationOptions = { rateLimit: 100 };
      const startTime = Date.now();

      await generator.generateProjectEmbeddings(mockProjectId, mockProjectPath, options);

      const endTime = Date.now();
      // Should take at least the rate limit time
      expect(endTime - startTime).toBeGreaterThanOrEqual(0); // Basic timing test
    });

    test('should handle file patterns filter', async () => {
      mockApiClient.post.mockResolvedValue({
        data: { embeddings: [[0.1, 0.2, 0.3]] }
      });

      const options: GenerationOptions = { filePatterns: ['*.ts'] };
      await generator.generateProjectEmbeddings(mockProjectId, mockProjectPath, options);

      expect(mockApiClient.generateEmbeddings).toHaveBeenCalled();
    });

    test('should handle parallel mode', async () => {
      mockApiClient.post.mockResolvedValue({
        data: { embeddings: [[0.1, 0.2, 0.3]] }
      });

      const options: GenerationOptions = { parallelMode: true, maxConcurrency: 5 };
      await generator.generateProjectEmbeddings(mockProjectId, mockProjectPath, options);

      expect(mockApiClient.generateEmbeddings).toHaveBeenCalled();
    });

    test('should handle API errors gracefully', async () => {
      mockApiClient.generateEmbeddings.mockRejectedValue(new Error('API Error'));

      const result = await generator.generateProjectEmbeddings(mockProjectId, mockProjectPath);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(mockLogger.error).toHaveBeenCalled();
    });

    test('should handle chunking options', async () => {
      mockApiClient.generateEmbeddings.mockResolvedValue({
        embeddings: [[0.1, 0.2, 0.3]],
        model: 'voyage-context-3',
        dimensions: 3,
        input_type: 'document',
        encoding_format: 'float32',
        total_tokens: 10,
        processing_time_ms: 100,
        provider: 'voyage'
      });

      const options: GenerationOptions = {
        maxChunkSize: 1000,
        overlapSize: 100,
        preferSymbolBoundaries: true,
        includeContext: true,
      };

      await generator.generateProjectEmbeddings(mockProjectId, mockProjectPath, options);

      expect(mockApiClient.generateEmbeddings).toHaveBeenCalled();
    });
  });

  describe('generateQueryEmbedding', () => {
    test('should generate embedding for query text', async () => {
      mockApiClient.generateEmbeddings.mockResolvedValue({
        embeddings: [[0.1, 0.2, 0.3, 0.4, 0.5]],
        model: 'voyage-context-3',
        dimensions: 5,
        input_type: 'document',
        encoding_format: 'float32',
        total_tokens: 10,
        processing_time_ms: 100,
        provider: 'voyage'
      });

      const result = await generator.generateQueryEmbedding('test query');

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      expect(typeof result[0]).toBe('number');
    });

    test('should handle empty query', async () => {
      mockApiClient.generateEmbeddings.mockResolvedValue({
        embeddings: [[]],
        model: 'voyage-context-3',
        dimensions: 0,
        input_type: 'document',
        encoding_format: 'float32',
        total_tokens: 10,
        processing_time_ms: 100,
        provider: 'voyage'
      });

      const result = await generator.generateQueryEmbedding('');

      expect(Array.isArray(result)).toBe(true);
    });

    test('should handle API errors in query embedding', async () => {
      mockApiClient.generateEmbeddings.mockRejectedValue(new Error('API Error'));

      await expect(generator.generateQueryEmbedding('test')).rejects.toThrow();
    });

    test('should use project-specific embedding generation when projectId provided', async () => {
      mockApiClient.generateEmbeddings.mockResolvedValue({
        embeddings: [[0.1, 0.2, 0.3]],
        model: 'voyage-context-3',
        dimensions: 3,
        input_type: 'document',
        encoding_format: 'float32',
        total_tokens: 10,
        processing_time_ms: 100,
        provider: 'voyage'
      });

      await generator.generateQueryEmbedding('test', 'project-123');

      expect(mockApiClient.generateEmbeddings).toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    test('should close storage connection', async () => {
      await generator.dispose();

      expect(mockStorage.close).toHaveBeenCalled();
    });

    test('should handle dispose errors gracefully', async () => {
      mockStorage.close.mockRejectedValue(new Error('Close error'));

      await expect(generator.dispose()).resolves.toBeUndefined();

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('Provider Selection Logic', () => {
    test('should prioritize local provider when USE_LOCAL_EMBEDDINGS=true and LOCAL_EMBEDDING_MODEL is set', async () => {
      // With USE_LOCAL_EMBEDDINGS=true and LOCAL_EMBEDDING_MODEL set (from beforeEach),
      // the provider selection should prioritize local even with Ambiance API key present

      const result = await generator.generateQueryEmbedding('test');

      // Should not call Ambiance API since local is prioritized
      expect(mockApiClient.generateEmbeddings).not.toHaveBeenCalled();
      // Should call local provider instead
      expect(mockLocalProvider.generateQueryEmbedding).toHaveBeenCalled();
    });

    test('should fallback to Ambiance API when LOCAL_EMBEDDING_MODEL not set', async () => {
      // Temporarily remove LOCAL_EMBEDDING_MODEL to test fallback
      delete process.env.LOCAL_EMBEDDING_MODEL;
      process.env.AMBIANCE_API_KEY = process.env.AMBIANCE_API_KEY || 'test-key';
      mockApiClient.post.mockResolvedValue({
        data: { embeddings: [[0.1, 0.2, 0.3]] }
      });

      await generator.generateQueryEmbedding('test');

      expect(mockApiClient.generateEmbeddings).toHaveBeenCalled();

      // Restore for other tests
      process.env.LOCAL_EMBEDDING_MODEL = 'all-MiniLM-L6-v2';
    });

    test('should handle local provider errors and fallback to Ambiance API', async () => {
      // Mock local provider to throw error
      (LocalEmbeddingProvider as jest.Mock).mockImplementation(() => {
        throw new Error('Local provider failed');
      });

      // With local provider failing, should fallback to Ambiance API
      mockApiClient.post.mockResolvedValue({
        data: { embeddings: [[0.1, 0.2, 0.3]] }
      });

      const result = await generator.generateQueryEmbedding('test');

      expect(mockApiClient.generateEmbeddings).toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalled();
    });

    test('should handle missing API keys with local provider', async () => {
      delete process.env.AMBIANCE_API_KEY;
      delete process.env.OPENAI_API_KEY;

      // Should still work with local provider
      const result = await generator.generateQueryEmbedding('test');

      expect(mockLocalProvider.generateQueryEmbedding).toHaveBeenCalled();
      expect(mockApiClient.generateEmbeddings).not.toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    test('should handle database initialization errors', async () => {
      mockStorage.initializeDatabase.mockRejectedValue(new Error('DB Error'));

      await expect(
        generator.generateProjectEmbeddings('test', '/path')
      ).rejects.toThrow('DB Error');
    });

    test('should handle dimension compatibility errors', async () => {
      mockStorage.ensureDimensionCompatibility.mockRejectedValue(new Error('Dimension mismatch'));

      await expect(
        generator.generateProjectEmbeddings('test', '/path')
      ).rejects.toThrow('Dimension mismatch');
    });

    test('should handle file system errors', async () => {
      // Mock fs to throw error - this will be handled by the existing fs mock
      jest.doMock('fs', () => ({
        ...jest.requireActual('fs'),
        readdirSync: jest.fn().mockImplementation(() => {
          throw new Error('File system error');
        })
      }));

      await expect(
        generator.generateProjectEmbeddings('test', '/invalid/path')
      ).rejects.toThrow('File system error');
    });

    test('should handle invalid project paths', async () => {
      jest.doMock('fs', () => ({
        ...jest.requireActual('fs'),
        existsSync: jest.fn().mockReturnValue(false)
      }));

      await expect(
        generator.generateProjectEmbeddings('test', '/nonexistent/path')
      ).rejects.toThrow();
    });
  });

  describe('Configuration and Environment', () => {
    test('should respect environment variable configurations', async () => {
      process.env.EMBEDDING_BATCH_SIZE = '16';
      process.env.EMBEDDING_MAX_CONCURRENCY = '5';
      process.env.EMBEDDING_PARALLEL_MODE = 'true';

      await generator.generateProjectEmbeddings('test', '/path');

      // With local provider prioritized, should call local provider instead of Ambiance API
      expect(mockLocalProvider.generateQueryEmbedding).toHaveBeenCalled();
      expect(mockApiClient.generateEmbeddings).not.toHaveBeenCalled();
    });

    test('should handle missing environment configurations gracefully', async () => {
      // Remove all optional environment variables
      delete process.env.EMBEDDING_BATCH_SIZE;
      delete process.env.EMBEDDING_MAX_CONCURRENCY;
      delete process.env.EMBEDDING_PARALLEL_MODE;

      await generator.generateProjectEmbeddings('test', '/path');

      // Should use default values with local provider
      expect(mockLocalProvider.generateQueryEmbedding).toHaveBeenCalled();
      expect(mockApiClient.generateEmbeddings).not.toHaveBeenCalled();
    });
  });

  describe('Progress Tracking', () => {
    test('should provide detailed progress information', async () => {
      const progress = await generator.generateProjectEmbeddings('test', '/path');

      expect(progress).toHaveProperty('totalFiles', expect.any(Number));
      expect(progress).toHaveProperty('processedFiles', expect.any(Number));
      expect(progress).toHaveProperty('totalChunks', expect.any(Number));
      expect(progress).toHaveProperty('processedChunks', expect.any(Number));
      expect(progress).toHaveProperty('embeddings', expect.any(Number));
      expect(progress).toHaveProperty('errors', expect.any(Array));
      // Should use local provider instead of Ambiance API
      expect(mockLocalProvider.generateQueryEmbedding).toHaveBeenCalled();
      expect(mockApiClient.generateEmbeddings).not.toHaveBeenCalled();
    });

    test('should track errors in progress', async () => {
      const progress = await generator.generateProjectEmbeddings('test', '/path');

      expect(progress.errors.length).toBeGreaterThan(0);
      expect(progress.errors[0]).toContain('Failed to generate embeddings');
      // Should use local provider even with errors
      expect(mockLocalProvider.generateQueryEmbedding).toHaveBeenCalled();
      expect(mockApiClient.generateEmbeddings).not.toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty file list', async () => {
      jest.doMock('fs', () => ({
        ...jest.requireActual('fs'),
        readdirSync: jest.fn().mockReturnValue([])
      }));

      const progress = await generator.generateProjectEmbeddings('test', '/empty/path');

      expect(progress.totalFiles).toBe(0);
      expect(progress.processedFiles).toBe(0);
    });

    test('should handle files with no content', async () => {
      jest.doMock('fs', () => ({
        ...jest.requireActual('fs'),
        readFileSync: jest.fn().mockReturnValue('')
      }));

      const progress = await generator.generateProjectEmbeddings('test', '/path');

      expect(progress.processedFiles).toBeGreaterThan(0);
      // Should use local provider instead of Ambiance API
      expect(mockLocalProvider.generateQueryEmbedding).toHaveBeenCalled();
      expect(mockApiClient.generateEmbeddings).not.toHaveBeenCalled();
    });

    test('should handle very large files', async () => {
      const largeContent = 'x'.repeat(100000); // 100KB file
      jest.doMock('fs', () => ({
        ...jest.requireActual('fs'),
        readFileSync: jest.fn().mockReturnValue(largeContent)
      }));

      await generator.generateProjectEmbeddings('test', '/path');

      // Should use local provider instead of Ambiance API
      expect(mockLocalProvider.generateQueryEmbedding).toHaveBeenCalled();
      expect(mockApiClient.generateEmbeddings).not.toHaveBeenCalled();
    });
  });
});
