/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/src/**/*.test.ts', '**/tests/**/*.test.js'],
  setupFiles: ['<rootDir>/tests/setupEnv.js'],
  testPathIgnorePatterns: [
    'tools-old/',
    'indexers-old/',
    'renderers-old/',
    'search-old/',
    'database-old/',
    'llm-old/',
    'types-old/'
  ],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      useESM: false,
      tsconfig: 'tsconfig.json'
    }]
  },
  transformIgnorePatterns: [
    'node_modules/(?!(node-fetch|@babel|tree-sitter|@xenova))'
  ],
  moduleNameMapper: {
    '^node-fetch$': 'node-fetch',
    '^globby$': '<rootDir>/__mocks__/globby.js',
    '^fs$': '<rootDir>/__mocks__/fs.js',
    '^fs/promises$': '<rootDir>/__mocks__/fs.js',
    '^tree-sitter$': '<rootDir>/__mocks__/tree-sitter.js',
    '^tree-sitter-typescript$': '<rootDir>/__mocks__/tree-sitter-lang.js',
    '^tree-sitter-javascript$': '<rootDir>/__mocks__/tree-sitter-lang.js',
    '^tree-sitter-python$': '<rootDir>/__mocks__/tree-sitter-lang.js',
    '^@xenova/transformers$': '<rootDir>/__mocks__/@xenova/transformers.js',
  },
  // Add timeout and force exit to prevent hanging
  testTimeout: 10000,
  forceExit: true,
  // Verbose output for better debugging
  verbose: true
};