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
- Comprehensive pattern validation with helpful error messages

**Pattern Syntax:**
- Use $ + UPPERCASE for wildcards: $FUNC, $VAR, $ARGS
- Patterns look like real code: 'function $NAME($ARGS) { $BODY }'
- Match specific constructs: 'new $CLASS($ARGS)'
- Valid characters: (), {}, [], "", '', numbers, operators, keywords
- NOT regex: do NOT use '|', '.*', '.+', '/pattern/', or escapes like '\\(' or '\\{'.

**Common Mistakes to Avoid:**
❌ Don't use: 'function $FUNC' (ambiguous, multiple AST interpretations)
❌ Don't use: 'export $TYPE' (ambiguous, multiple AST interpretations)
❌ Don't use: '$NAME' (too generic, matches everything)
❌ Don't use: /pattern/ (regex syntax not supported)

**✅ Good Patterns:**
- 'function $NAME($ARGS) { $BODY }' (complete function structure)
- 'export const $NAME = $VALUE' (exported constant)
- 'import $NAME from "$MODULE"' (import statement)
- 'new $CLASS($ARGS)' (constructor call)
- 'class $NAME: $BODY' (Python class)
- 'await $PROMISE' inside 'for ($COND) { $BODY }' (relational patterns)

**Examples:**
- Find all functions: 'function $NAME($ARGS) { $BODY }'
- Find all exports: 'export const $NAME = $VALUE'
- Find imports: 'import $NAME from "$MODULE"'
- Find class instantiation: 'new $CLASS($ARGS)'
- Find method calls: '$OBJ.$METHOD($ARGS)'
- Find async functions: 'async function $NAME($ARGS) { $BODY }'
- Find arrow functions: 'const $NAME = ($ARGS) => $BODY'
- Find React components: 'export function $NAME($PROPS) { return $JSX }'
- Find Python classes: 'class $NAME: $BODY'
- Find Python classes with inheritance: 'class $NAME($BASE): $BODY'

**Advanced Usage:**
- Use $$$ for zero or more arguments: 'console.log($$$ARGS)'
- Use relational rules: 'await $PROMISE' inside 'for ($COND) { $BODY }'
- Use multiple searches for OR conditions (alternation not supported)

**Use Cases:**
- Code refactoring and migration
- Finding specific patterns across codebase
- Security auditing for dangerous patterns
- Architecture analysis and dependency tracking
- Finding unused imports or exports
- API usage analysis

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

// Comprehensive pattern validation for ast-grep
interface PatternValidationResult {
  isValid: boolean;
  error?: string;
  suggestions?: string[];
  warning?: string;
}

export function validateAstGrepPattern(pattern: string): PatternValidationResult {
  const trimmedPattern = pattern.trim();

  // Empty pattern check
  if (!trimmedPattern) {
    return {
      isValid: false,
      error:
        'Pattern cannot be empty. Use valid TypeScript/JavaScript syntax like "function $NAME($ARGS) { $BODY }"',
      suggestions: [
        'function $NAME($ARGS) { $BODY }',
        'import $NAME from "$MODULE"',
        'new $CLASS($ARGS)',
        'const $VAR = $VALUE',
        'class $NAME: $BODY (Python)',
        'class $NAME($BASE): $BODY (Python with inheritance)',
      ],
    };
  }

  // Regex literal syntax check (/pattern/flags)
  if (/^\s*\/.+\/[gimsuy]*\s*$/i.test(trimmedPattern)) {
    return {
      isValid: false,
      error: 'Regex literal syntax (/pattern/flags) is not supported in AST patterns',
      suggestions: [
        'Use structural patterns instead of regex',
        'For multiple patterns, run separate searches',
        'Example: "import $NAME from \\"express\\"" instead of /import.*express/',
      ],
    };
  }

  // Alternation operator check
  if (trimmedPattern.includes('|')) {
    return {
      isValid: false,
      error: 'Alternation operator (|) is not supported in basic AST patterns',
      suggestions: [
        'Run separate searches for each pattern instead',
        'Example: search "import $NAME from \\"express\\"" and "const $NAME = require(\\"express\\")" separately',
      ],
    };
  }

  // Regex wildcards check
  if (
    trimmedPattern.includes('.*') ||
    trimmedPattern.includes('.+') ||
    trimmedPattern.includes('.*')
  ) {
    return {
      isValid: false,
      error: 'Regex wildcards (.*, .+, etc.) are not supported in AST patterns',
      suggestions: [
        'Use structural wildcards like $NAME, $ARGS instead',
        'Example: "function $NAME($ARGS) { $BODY }" matches any function',
      ],
    };
  }

  // Regex escape sequences check
  if (/\\([(){}\[\].+?^$])/g.test(trimmedPattern)) {
    return {
      isValid: false,
      error: 'Regex escape sequences (\\(escaped chars\\)) are not needed in AST patterns',
      suggestions: [
        'Remove backslashes - AST patterns use structural matching, not text matching',
        'Example: "function $NAME($ARGS)" instead of "function \\$NAME(\\$ARGS)"',
      ],
    };
  }

  // Regex groups/lookahead check
  if (trimmedPattern.includes('(?') || trimmedPattern.includes('?:')) {
    return {
      isValid: false,
      error: 'Regex groups and lookahead are not supported in AST patterns',
      suggestions: [
        'Use structural patterns with multiple searches instead',
        'Example: search "await $PROMISE" inside "for ($COND) { $BODY }"',
      ],
    };
  }

    // Check for ambiguous patterns that ast-grep can't parse
    const ambiguousPatterns = [
      /^export\s+\$[A-Z_]+$/,
      /^import\s+\$[A-Z_]+$/,
      /^function\s+\$[A-Z_]+$/,
      /^class\s+\$[A-Z_]+$/,
      /^\$[A-Z_]+\s*$/,
      /^export\s+default\s+\$[A-Z_]+$/,
    ];

  for (const ambiguousPattern of ambiguousPatterns) {
    if (ambiguousPattern.test(trimmedPattern)) {
      return {
        isValid: false,
        error: `Pattern "${trimmedPattern}" is ambiguous and cannot be parsed by ast-grep`,
        suggestions: [
          'Add more context to make the pattern unambiguous',
          'Example: "export const $NAME = $VALUE" instead of "export $TYPE"',
          'Example: "function $NAME($ARGS) { $BODY }" instead of "function $FUNC"',
        ],
      };
    }
  }

  // Check for patterns that are too generic and likely won't match anything useful
  const tooGenericPatterns = [
    /^\$[A-Z_]+$/,
    /^export\s+\$[A-Z_]+$/,
    /^import\s+\$[A-Z_]+$/,
    /^function\s+\$[A-Z_]+$/,
  ];

  let warning: string | undefined;
  for (const genericPattern of tooGenericPatterns) {
    if (genericPattern.test(trimmedPattern)) {
      warning = `Pattern "${trimmedPattern}" is very generic and may not match expected code structures`;
      break;
    }
  }

    // Check for patterns missing metavariables when they should have them
    const patternsNeedingMetavariables = [
      {
        regex: /^export\s+(const|let|var|function|class|interface|type)\s+[^$]/,
        suggestion: 'Use metavariables like $NAME for the exported identifier',
      },
      { regex: /^function\s+[^$]/, suggestion: 'Use $NAME for the function name' },
      { regex: /^class\s+[^$]/, suggestion: 'Use $NAME for the class name and $BASE for inheritance' },
      { regex: /^import\s+[^$]/, suggestion: 'Use $NAME for the imported identifier' },
    ];

  const suggestions: string[] = [];
  for (const patternCheck of patternsNeedingMetavariables) {
    if (patternCheck.regex.test(trimmedPattern)) {
      suggestions.push(patternCheck.suggestion);
    }
  }

  return {
    isValid: true,
    suggestions: suggestions.length > 0 ? suggestions : undefined,
    warning,
  };
}

/**
 * Handle ast-grep search requests
 */
export async function handleAstGrep(args: any): Promise<AstGrepResult> {
  const startTime = Date.now();

  try {
    // Early validation: comprehensive pattern validation
    if (typeof args.pattern !== 'string' || !args.pattern.trim()) {
      throw new Error('Pattern must be a non-empty string containing an AST pattern (not regex).');
    }

    const pattern = String(args.pattern);
    const validation = validateAstGrepPattern(pattern);

    if (!validation.isValid) {
      const errorMessage = validation.error || 'Invalid AST pattern';
      const suggestions = validation.suggestions || [];
      const fullMessage = `${errorMessage}${suggestions.length > 0 ? '\n\nSuggestions:\n' + suggestions.map(s => `• ${s}`).join('\n') : ''}`;
      throw new Error(fullMessage);
    }

    // Log warnings for potentially problematic patterns
    if (validation.warning) {
      logger.warn('⚠️ Potentially problematic AST pattern', {
        pattern,
        warning: validation.warning,
        suggestions: validation.suggestions,
      });
    }

    // Log suggestions for improvement
    if (validation.suggestions && validation.suggestions.length > 0) {
      logger.info('💡 Pattern suggestions available', {
        pattern,
        suggestions: validation.suggestions,
      });
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
}): Promise<AstGrepResult> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const cliArgs: string[] = [];

    try {
      logger.debug('Adding pattern to args', {
        pattern: options.pattern,
        patternType: typeof options.pattern,
        patternLength: options.pattern.length,
        patternTrimmed: options.pattern.trim(),
      });

      cliArgs.push('--pattern', options.pattern);

      if (options.language) {
        cliArgs.push('--lang', options.language);
      }

      cliArgs.push('--json=stream');

      if (options.includeContext && options.contextLines > 0) {
        cliArgs.push('--context', options.contextLines.toString());
      }

      if (options.respectGitignore === false) {
        cliArgs.push('--no-ignore', 'vcs');
      }

      if (options.filePattern) {
        cliArgs.push(options.filePattern);
      } else {
        cliArgs.push('.');
      }

      logger.debug('Executing ast-grep command', {
        command: 'npx ast-grep',
        args: cliArgs,
        argsJoined: cliArgs.join(' '),
        cwd: options.projectPath,
        pattern: options.pattern,
        language: options.language,
      });

      // Log the command being executed
      const fullCommand = `npx ast-grep ${cliArgs.join(' ')}`;
      logger.debug('Executing ast-grep command:', { command: fullCommand });

      let astGrep: ReturnType<typeof spawn> | null = null;
      let executionMethod = 'unknown';

      const localBinary = findLocalAstGrepBinary();
      if (localBinary) {
        try {
          const useShell = process.platform === 'win32' && localBinary.endsWith('.cmd');
          astGrep = spawn(localBinary, cliArgs, {
            cwd: options.projectPath,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: useShell,
          });
          executionMethod = 'local-binary';
          logger.debug('Using local ast-grep binary', { binary: localBinary, useShell });
        } catch (localBinaryError) {
          logger.debug('Failed to spawn local binary, falling back to npx', {
            error:
              localBinaryError instanceof Error
                ? localBinaryError.message
                : String(localBinaryError),
          });
        }
      }

      if (!astGrep) {
        const approaches = [
          {
            name: 'cmd-npx',
            command: 'cmd',
            args: ['/c', 'npx', 'ast-grep', ...cliArgs],
            options: { shell: false },
          },
          {
            name: 'powershell-npx',
            command: 'powershell',
            args: ['-Command', 'npx ast-grep ' + cliArgs.join(' ')],
            options: { shell: false },
          },
          {
            name: 'shell-cmd-npx',
            command: 'cmd /c "npx ast-grep ' + cliArgs.join(' ') + '"',
            args: [],
            options: { shell: true },
          },
        ] as const;

        let lastError: Error | null = null;

        for (const approach of approaches) {
          try {
            logger.debug('Attempting spawn approach', {
              approach: approach.name,
              command: approach.command,
              args: approach.args,
              cwd: options.projectPath,
              platform: process.platform,
              shell: approach.options.shell,
              fullCommand:
                approach.command + ' ' + (approach.args.length > 0 ? approach.args.join(' ') : ''),
            });

            astGrep = spawn(approach.command, approach.args, {
              cwd: options.projectPath,
              stdio: ['ignore', 'pipe', 'pipe'],
              ...approach.options,
              env: process.env,
            });

            executionMethod = approach.name;
            logger.debug('Spawn succeeded', { approach: approach.name });
            break;
          } catch (approachError) {
            lastError =
              approachError instanceof Error ? approachError : new Error(String(approachError));
            logger.debug('Spawn approach failed', {
              approach: approach.name,
              error: lastError.message,
              code: (lastError as any).code,
              shell: approach.options.shell,
            });
          }
        }

        if (!astGrep) {
          logger.error('All spawn approaches failed', {
            approaches: approaches.map(a => a.name),
            lastError: lastError?.message,
            cwd: options.projectPath,
            nodeVersion: process.version,
          });
          throw new Error(`All spawn approaches failed: ${lastError?.message || 'Unknown error'}`);
        }
      }

      if (!astGrep) {
        throw new Error('Failed to spawn ast-grep: no process handle available.');
      }

      let stdout = '';
      let stderr = '';

      astGrep.stdout?.on('data', data => {
        stdout += data.toString();
      });

      astGrep.stderr?.on('data', data => {
        stderr += data.toString();
      });

      astGrep.on('close', code => {
        logger.debug('ast-grep process closed', {
          code,
          stdoutLength: stdout.length,
          stderrLength: stderr.length,
          executionMethod,
          success: code === 0,
        });

        if (code !== 0 && code !== null) {
          reject(new Error(`ast-grep exited with code ${code}: ${stderr || 'No error message provided'}`));
          return;
        }

        try {
          let matches = parseAstGrepOutput(stdout, options.maxMatches);

          if (options.excludePatterns && options.excludePatterns.length > 0) {
            matches = filterMatchesByExcludePatterns(
              matches,
              options.excludePatterns,
              options.projectPath
            );
          }

          resolve({
            ...matches,
            executionTime: Date.now() - startTime,
            pattern: options.pattern,
            language: options.language,
          });
        } catch (parseError) {
          reject(
            new Error(
              `Failed to parse ast-grep output: ${
                parseError instanceof Error ? parseError.message : String(parseError)
              }`
            )
          );
        }
      });

      astGrep.on('error', processError => {
        logger.error('ast-grep process error', {
          error: processError.message,
          code: (processError as any).code,
          stack: processError.stack?.substring(0, 300),
          executionMethod,
          cwd: options.projectPath,
          platform: process.platform,
          nodeVersion: process.version,
          path: process.env.PATH?.substring(0, 200),
        });
        reject(
          new Error(
            `Failed to spawn ast-grep (${executionMethod}): ${processError.message} (code: ${(processError as any).code}). Make sure @ast-grep/cli is installed and accessible.`
          )
        );
      });

      setTimeout(() => {
        if (astGrep) {
          astGrep.kill();
        }
        reject(new Error('ast-grep search timed out after 30 seconds'));
      }, 30000);
    } catch (error) {
      logger.error('Failed to execute ast-grep', {
        error: error instanceof Error ? error.message : String(error),
        cwd: options.projectPath,
        platform: process.platform,
      });
      reject(
        new Error(
          `Failed to execute ast-grep: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
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
 * Filter matches by additional exclude patterns
 */
function filterMatchesByExcludePatterns(
  matches: { matches: AstGrepMatch[]; totalMatches: number },
  excludePatterns: string[],
  projectPath: string
): { matches: AstGrepMatch[]; totalMatches: number } {
  const filteredMatches = matches.matches.filter(match => {
    const relativePath = path.relative(projectPath, match.file).replace(/\\/g, '/');

    return !excludePatterns.some(pattern => {
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
    // First, try to use the local binary if available
    const localBinary = findLocalAstGrepBinary();
    if (localBinary) {
      // For Windows .cmd files, we need to use shell execution
      const useShell = process.platform === 'win32' && localBinary.endsWith('.cmd');
      const astGrep = spawn(localBinary, ['--version'], {
        stdio: 'ignore',
        shell: useShell,
      });

      astGrep.on('close', code => {
        resolve(code === 0);
      });

      astGrep.on('error', () => {
        // If local binary fails, try npx fallback
        const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
        const fallbackAstGrep = spawn(npxCmd, ['ast-grep', '--version'], {
          stdio: 'ignore',
          shell: false,
        });

        fallbackAstGrep.on('close', code => {
          resolve(code === 0);
        });

        fallbackAstGrep.on('error', () => {
          resolve(false);
        });

        setTimeout(() => {
          fallbackAstGrep.kill();
          resolve(false);
        }, 5000);
      });

      setTimeout(() => {
        astGrep.kill();
        resolve(false);
      }, 5000);
      return;
    }

    // If no local binary, use cmd /c npx approach (consistent with main execution)
    const astGrep = spawn('cmd', ['/c', 'npx', 'ast-grep', '--version'], {
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
    // Check multiple possible locations for the binary
    const possibleLocations = [
      path.join(process.cwd(), 'node_modules', '.bin'),
      path.join(__dirname, '..', '..', '..', 'node_modules', '.bin'),
      path.join(__dirname, '..', '..', 'node_modules', '.bin'),
    ];

    // Try different extensions based on platform
    const extensions = process.platform === 'win32' ? ['.cmd', '.ps1', ''] : [''];

    for (const binDir of possibleLocations) {
      for (const ext of extensions) {
        const exe = `ast-grep${ext}`;
        const full = path.join(binDir, exe);
        if (require('fs').existsSync(full)) {
          logger.debug('Found local ast-grep binary', { path: full });
          return full;
        }
      }
    }

    logger.debug('No local ast-grep binary found');
    return null;
  } catch (error) {
    logger.debug('Error finding local ast-grep binary', {
      error: error instanceof Error ? error.message : String(error),
    });
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
