/**
 * @fileOverview: AST-Grep integration for structural code search and transformation
 * @module: AstGrep
 * @keyFunctions:
 *   - astGrepTool: MCP tool definition for ast-grep integration
 *   - handleAstGrep: Tool handler for executing ast-grep queries
 *   - executeAstGrep: Core function to run ast-grep commands
 *   - parseAstGrepOutput: Parse and structure ast-grep JSON output
 * @dependencies:
 *   - @ast-grep/cli: Command-line interface for ast-grep
 *   - child_process: Node.js process spawning for CLI execution
 * @context: Provides agents with direct access to ast-grep's powerful structural search capabilities
 */

import { spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { validateAndResolvePath } from '../utils/pathUtils';
import { logger } from '../../utils/logger';
import { loadIgnorePatterns } from '../../local/projectIdentifier';

export interface AstGrepMatch {
  file: string;
  range: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  text: string;
  variables?: Record<string, string>;
}

export interface AstGrepResult {
  matches: AstGrepMatch[];
  totalMatches: number;
  executionTime: number;
  pattern: string;
  language?: string;
  error?: string;
}

/**
 * MCP Tool definition for ast-grep structural search
 */
export const astGrepTool: Tool = {
  name: 'ast_grep_search',
  description: `🔍 AST-Grep structural code search tool

Performs powerful structural code search using ast-grep's pattern matching capabilities.
Unlike text-based search, this matches syntactical AST node structures.

**Key Features:**
- Structural pattern matching (not just text)
- Multi-language support (JS, TS, Python, Go, Rust, etc.)
- Wildcard variables ($VAR, $FUNC, $ARGS)
- Precise code location information
- Fast Rust-based execution

**Pattern Syntax:**
- Use $ + UPPERCASE for wildcards: $FUNC, $VAR, $ARGS
- Patterns look like real code: 'function $NAME($ARGS) { $BODY }'
- Match specific constructs: 'new $CLASS($ARGS)'
- Not regex: do NOT use '|', '.*', '/regex/', or escapes like '\('\/'\)'.

**Examples:**
- Find function calls: '$FUNC($ARGS)'
- Find class instantiation: 'new $CLASS($ARGS)'
- Find variable assignments: 'const $VAR = $VALUE'
- Find method calls: '$OBJ.$METHOD($ARGS)'
- Find Express usage (run separately):
  - 'import $NAME from "express"'
  - 'const $NAME = require("express")'
  - 'express()'

**Use Cases:**
- Code refactoring and migration
- Finding specific patterns across codebase
- Security auditing for dangerous patterns
- Architecture analysis and dependency tracking

**Automatic Exclusions:**
By default, excludes common non-source directories:
- node_modules/, .git/, dist/, build/
- IDE folders (.vscode/, .idea/)
- Generated files (*.min.js, *.map)
- Respects .gitignore and other ignore files`,

  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description:
          'AST pattern, not regex. Use $UPPERCASE wildcards. Examples: "$FUNC($ARGS)", "new $CLASS($ARGS)", "import $NAME from \"express\""',
      },
      projectPath: {
        type: 'string',
        description:
          'Project directory path to search in. Can be absolute or relative to workspace.',
      },
      language: {
        type: 'string',
        description:
          'Programming language (auto-detected if not provided). Supported: js, ts, py, go, rs, java, c, cpp',
        enum: [
          'js',
          'ts',
          'tsx',
          'jsx',
          'py',
          'go',
          'rs',
          'java',
          'c',
          'cpp',
          'php',
          'rb',
          'kt',
          'swift',
        ],
      },
      filePattern: {
        type: 'string',
        description:
          'Specific directory or file path to search within the project (e.g., "src", "lib"). If not provided, searches entire project.',
      },
      maxMatches: {
        type: 'number',
        description: 'Maximum number of matches to return (default: 100)',
        default: 100,
        minimum: 1,
        maximum: 1000,
      },
      includeContext: {
        type: 'boolean',
        description: 'Include surrounding context lines for each match (default: true)',
        default: true,
      },
      contextLines: {
        type: 'number',
        description: 'Number of context lines to include around matches (default: 3)',
        default: 3,
        minimum: 0,
        maximum: 10,
      },
      respectGitignore: {
        type: 'boolean',
        description: 'Respect .gitignore files and other ignore patterns (default: true)',
        default: true,
      },
      excludePatterns: {
        type: 'array',
        description: 'Additional patterns to exclude from search (e.g., ["test/**", "docs/**"])',
        items: { type: 'string' },
      },
    },
    required: ['pattern', 'projectPath'],
  },
};

/**
 * Handle ast-grep search requests
 */
export async function handleAstGrep(args: any): Promise<AstGrepResult> {
  const startTime = Date.now();

  try {
    // Early validation: discourage regex-like inputs that will fail or be handled by the shell on Windows
    if (typeof args.pattern !== 'string' || !args.pattern.trim()) {
      throw new Error('Pattern must be a non-empty string containing an AST pattern (not regex).');
    }

    const pattern = String(args.pattern);
    const regexLikeReason = looksLikeRegexPattern(pattern);
    if (regexLikeReason) {
      throw new Error(
        `Pattern appears to be a regular expression (${regexLikeReason}). ast-grep expects a structural code pattern. Examples: "$FUNC($ARGS)", "new $CLASS($ARGS)", "import $NAME from \"express\"". For OR conditions, run multiple searches.`
      );
    }

    logger.info('🔍 Executing ast-grep search', {
      pattern,
      projectPath: args.projectPath,
      language: args.language,
      filePattern: args.filePattern,
    });

    // Validate and resolve the project path
    const projectPath = await validateAndResolvePath(args.projectPath);

    // Execute ast-grep command
    const result = await executeAstGrep({
      pattern,
      projectPath,
      language: args.language,
      filePattern: args.filePattern,
      maxMatches: args.maxMatches || 100,
      includeContext: args.includeContext !== false,
      contextLines: args.contextLines || 3,
      respectGitignore: args.respectGitignore !== false,
      excludePatterns: args.excludePatterns,
    });

    const executionTime = Date.now() - startTime;

    logger.info('✅ ast-grep search completed', {
      matches: result.matches.length,
      executionTime,
    });

    return {
      ...result,
      executionTime,
      pattern,
      language: args.language,
    };
  } catch (error) {
    const executionTime = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('❌ ast-grep search failed', {
      error: errorMessage,
      pattern: args.pattern,
      executionTime,
    });

    return {
      matches: [],
      totalMatches: 0,
      executionTime,
      pattern: args?.pattern,
      language: args.language,
      error: errorMessage,
    };
  }
}

/**
 * Execute ast-grep command with specified options
 */
export async function executeAstGrep(options: {
  pattern: string;
  projectPath: string;
  language?: string;
  filePattern?: string;
  maxMatches: number;
  includeContext: boolean;
  contextLines: number;
  respectGitignore?: boolean;
  excludePatterns?: string[];
}): Promise<{ matches: AstGrepMatch[]; totalMatches: number }> {
  return new Promise((resolve, reject) => {
    // Build command arguments - note that 'run' is the default command, so we can omit it
    const cliArgs: string[] = [];

    // Add pattern
    cliArgs.push('--pattern', options.pattern);

    // Add language if specified
    if (options.language) {
      cliArgs.push('--lang', options.language);
    }

    // Add JSON output - use 'stream' for line-by-line parsing
    cliArgs.push('--json=stream');

    // Add context if requested
    if (options.includeContext && options.contextLines > 0) {
      cliArgs.push('--context', options.contextLines.toString());
    }

    // Handle ignore patterns
    if (options.respectGitignore === false) {
      // Disable gitignore respect if explicitly requested
      cliArgs.push('--no-ignore', 'vcs');
    }

    // Add the search path - always search current directory when cwd is set to projectPath
    if (options.filePattern) {
      // Use relative path since we set cwd to projectPath
      cliArgs.push(options.filePattern);
    } else {
      // Search current directory (which will be projectPath due to cwd)
      cliArgs.push('.');
    }

    logger.debug('Executing ast-grep command', {
      command: 'npx ast-grep',
      args: cliArgs.join(' '),
      cwd: options.projectPath,
    });

    let astGrep: ReturnType<typeof spawn>;
    try {
      // Prefer locally installed ast-grep binary if present
      const localBin = findLocalAstGrepBinary();
      if (localBin) {
        astGrep = spawn(localBin, [...cliArgs], {
          cwd: options.projectPath,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
        });
      } else {
        // Fallback to npx without shell
        const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
        astGrep = spawn(npxCmd, ['ast-grep', ...cliArgs], {
          cwd: options.projectPath,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
        });
      }
    } catch (spawnError) {
      // Last-resort fallback: run via shell command string (with safe quoting)
      const fullCommand = buildShellCommand('npx ast-grep', cliArgs);
      logger.warn('Falling back to shell execution for ast-grep due to spawn error', {
        error: spawnError instanceof Error ? spawnError.message : String(spawnError),
        fullCommand,
      });
      astGrep = spawn(fullCommand, [], {
        cwd: options.projectPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
      });
    }

    let stdout = '';
    let stderr = '';

    if (astGrep.stdout) {
      astGrep.stdout.on('data', data => {
        stdout += data.toString();
      });
    }

    if (astGrep.stderr) {
      astGrep.stderr.on('data', data => {
        stderr += data.toString();
      });
    }

    astGrep.on('close', code => {
      logger.debug('ast-grep process closed', {
        code,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
        stderr: stderr.substring(0, 500), // First 500 chars of stderr for debugging
      });

      if (code !== 0 && code !== null) {
        reject(new Error(`ast-grep exited with code ${code}: ${stderr}`));
        return;
      }

      try {
        // Parse JSON output
        let matches = parseAstGrepOutput(stdout, options.maxMatches);

        // Apply additional exclude patterns if specified
        if (options.excludePatterns && options.excludePatterns.length > 0) {
          matches = filterMatchesByExcludePatterns(
            matches,
            options.excludePatterns,
            options.projectPath
          );
        }

        resolve(matches);
      } catch (error) {
        reject(
          new Error(
            `Failed to parse ast-grep output: ${error instanceof Error ? error.message : String(error)}`
          )
        );
      }
    });

    astGrep.on('error', error => {
      reject(
        new Error(
          `Failed to spawn ast-grep: ${error.message}. Make sure @ast-grep/cli is installed.`
        )
      );
    });

    // Set timeout for long-running searches
    setTimeout(() => {
      astGrep.kill();
      reject(new Error('ast-grep search timed out after 30 seconds'));
    }, 30000);
  });
}

/**
 * Parse ast-grep JSON output into structured matches
 */
function parseAstGrepOutput(
  output: string,
  maxMatches: number
): { matches: AstGrepMatch[]; totalMatches: number } {
  if (!output.trim()) {
    return { matches: [], totalMatches: 0 };
  }

  try {
    // ast-grep outputs one JSON object per line for each match
    const lines = output
      .trim()
      .split('\n')
      .filter(line => line.trim());
    const allMatches: AstGrepMatch[] = [];

    for (const line of lines) {
      try {
        const match = JSON.parse(line);

        // Convert ast-grep format to our format
        const astGrepMatch: AstGrepMatch = {
          file: match.file || match.path || 'unknown',
          range: {
            start: {
              line: match.range?.start?.line || match.start?.line || 1,
              column: match.range?.start?.column || match.start?.column || 0,
            },
            end: {
              line: match.range?.end?.line || match.end?.line || 1,
              column: match.range?.end?.column || match.end?.column || 0,
            },
          },
          text: match.text || match.content || '',
          variables: match.variables || match.env || {},
        };

        allMatches.push(astGrepMatch);

        // Stop if we've reached the max matches
        if (allMatches.length >= maxMatches) {
          break;
        }
      } catch (parseError) {
        logger.debug('Failed to parse ast-grep match line', { line, error: parseError });
        continue;
      }
    }

    return {
      matches: allMatches,
      totalMatches: lines.length, // Total available matches
    };
  } catch (error) {
    logger.warn('Failed to parse ast-grep output', { error, output: output.substring(0, 200) });
    return { matches: [], totalMatches: 0 };
  }
}

/**
 * Check if ast-grep is available in the system
 */
/**
 * Filter matches by additional exclude patterns
 */
function filterMatchesByExcludePatterns(
  matches: { matches: AstGrepMatch[]; totalMatches: number },
  excludePatterns: string[],
  projectPath: string
): { matches: AstGrepMatch[]; totalMatches: number } {
  const filteredMatches = matches.matches.filter(match => {
    // Convert absolute path to relative for pattern matching
    const relativePath = path.relative(projectPath, match.file).replace(/\\/g, '/');

    // Check if file matches any exclude pattern
    return !excludePatterns.some(pattern => {
      // Simple glob pattern matching
      const regex = pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.');
      return new RegExp(`^${regex}$`).test(relativePath);
    });
  });

  return {
    matches: filteredMatches,
    totalMatches: filteredMatches.length,
  };
}

/**
 * Get default ignore patterns for common directories to exclude
 */
function getDefaultExcludePatterns(): string[] {
  return [
    'node_modules/**',
    '.git/**',
    'dist/**',
    'build/**',
    'out/**',
    'target/**',
    '.vscode/**',
    '.idea/**',
    '**/*.min.js',
    '**/*.min.css',
    '**/*.map',
    'coverage/**',
    '.nyc_output/**',
    'tmp/**',
    'temp/**',
  ];
}

export async function isAstGrepAvailable(): Promise<boolean> {
  return new Promise(resolve => {
    const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const astGrep = spawn(npxCmd, ['ast-grep', '--version'], {
      stdio: 'ignore',
      shell: false,
    });

    astGrep.on('close', code => {
      resolve(code === 0);
    });

    astGrep.on('error', () => {
      resolve(false);
    });

    // Timeout after 5 seconds
    setTimeout(() => {
      astGrep.kill();
      resolve(false);
    }, 5000);
  });
}

// Try to find a locally installed ast-grep binary in node_modules/.bin
function findLocalAstGrepBinary(): string | null {
  try {
    const binDir = path.join(process.cwd(), 'node_modules', '.bin');
    const exe = process.platform === 'win32' ? 'ast-grep.cmd' : 'ast-grep';
    const full = path.join(binDir, exe);
    if (require('fs').existsSync(full)) {
      return full;
    }
    return null;
  } catch {
    return null;
  }
}

// Build a shell-safe command string with quoted arguments
function buildShellCommand(cmd: string, args: string[]): string {
  const quote = (s: string) => {
    if (s === '.') return s;
    // Simple quoting; sufficient for our arg shapes (no newlines)
    if (process.platform === 'win32') {
      return `"${s.replace(/"/g, '\\"')}"`;
    }
    return `'${s.replace(/'/g, "'\\''")}'`;
  };
  return `${cmd} ${args.map(a => (a.startsWith('--') ? a : quote(a))).join(' ')}`.trim();
}
// Heuristic to detect regex-like patterns that will not work with ast-grep structural matching
function looksLikeRegexPattern(pattern: string): string | null {
  if (/^\s*\/.+\/[gimsuy]*\s*$/.test(pattern)) return 'regex literal (/.../)';
  if (pattern.includes('|')) return 'alternation (|)';
  if (pattern.includes('.*')) return 'wildcard (.*)';
  if (/\\[(){}\[\].+?^$]/.test(pattern)) return 'escaped regex metacharacters';
  return null;
}
