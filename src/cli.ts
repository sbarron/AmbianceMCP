#!/usr/bin/env node

/**
 * Ambiance MCP Server CLI
 *
 * Provides command-line interface for the Ambiance MCP server and local tools.
 * Supports MCP server mode, help display, and direct tool execution.
 */

const packageJson = require('../../package.json');

// Import local tool handlers for CLI access (using dynamic imports to avoid issues)
const handleSemanticCompact = require('./tools/localTools/semanticCompact').handleSemanticCompact;
const handleProjectHints = require('./tools/localTools/projectHints').handleProjectHints;
const handleFileSummary = require('./tools/localTools/fileSummary').handleFileSummary;
const handleFrontendInsights =
  require('./tools/localTools/frontendInsights').handleFrontendInsights;
const handleLocalDebugContext = require('./tools/debug/localDebugContext').handleLocalDebugContext;
const handleAstGrep = require('./tools/localTools/astGrep').handleAstGrep;
const handleManageEmbeddings =
  require('./tools/localTools/embeddingManagement').handleManageEmbeddings;
const { detectWorkspaceDirectory } = require('./tools/utils/pathUtils');

/**
 * Detect the appropriate project path for CLI operations
 */
function detectProjectPath(): string {
  // First check if WORKSPACE_FOLDER is set
  if (process.env.WORKSPACE_FOLDER) {
    return process.env.WORKSPACE_FOLDER;
  }

  // Use intelligent workspace detection
  const detected = detectWorkspaceDirectory();
  if (detected && detected !== process.cwd()) {
    console.log(`🔍 Auto-detected project directory: ${detected}`);
    return detected;
  }

  // Fallback to current directory
  return process.cwd();
}

/**
 * Estimate embedding generation time based on project characteristics
 */
function estimateEmbeddingTime(fileCount: number, avgFileSize: number = 5000): string {
  // Based on empirical data: ~200-500 files per minute depending on size and hardware
  // Rough estimates:
  // - Small files (< 1KB): ~1000 files/minute
  // - Medium files (1-10KB): ~500 files/minute
  // - Large files (> 10KB): ~200 files/minute

  let filesPerMinute = 500; // Default assumption

  if (avgFileSize < 1000) {
    filesPerMinute = 1000;
  } else if (avgFileSize < 10000) {
    filesPerMinute = 500;
  } else {
    filesPerMinute = 200;
  }

  const estimatedMinutes = Math.ceil(fileCount / filesPerMinute);

  if (estimatedMinutes < 1) {
    return '< 1 minute';
  } else if (estimatedMinutes === 1) {
    return '1 minute';
  } else if (estimatedMinutes < 60) {
    return `${estimatedMinutes} minutes`;
  } else {
    const hours = Math.floor(estimatedMinutes / 60);
    const remainingMinutes = estimatedMinutes % 60;
    return remainingMinutes > 0
      ? `${hours}h ${remainingMinutes}m`
      : `${hours} hour${hours > 1 ? 's' : ''}`;
  }
}

// Make this file a module
export {};

// Force enable local embeddings for CLI embedding operations
if (!process.env.USE_LOCAL_EMBEDDINGS) {
  process.env.USE_LOCAL_EMBEDDINGS = 'true';
  console.log('🔧 Auto-enabled USE_LOCAL_EMBEDDINGS=true for embedding functionality');
}

interface EnvVarSpec {
  name: string;
  defaultValue: string;
  description: string;
}

interface EnvVarCategory {
  title: string;
  summary?: string;
  vars: EnvVarSpec[];
}

const ENVIRONMENT_VARIABLES: EnvVarCategory[] = [
  {
    title: 'Core Workspace',
    summary: 'Workspace detection and automatic embedding generation.',
    vars: [
      {
        name: 'WORKSPACE_FOLDER',
        defaultValue: 'Auto-detected or set via manage_embeddings',
        description: 'Root path analysed by tools.',
      },
      {
        name: 'WORKSPACE_INITIALIZED',
        defaultValue: 'false',
        description: 'Set to true after workspace is configured.',
      },
      {
        name: 'WORKSPACE_PROACTIVE_EMBEDDINGS',
        defaultValue: 'false',
        description: 'Deprecated - embeddings now auto-generate on first tool use.',
      },
      {
        name: 'WORKSPACE_EMBEDDING_MAX_FILES',
        defaultValue: '500',
        description: 'Deprecated - use manage_embeddings for control.',
      },
      {
        name: 'WORKSPACE_EMBEDDING_MIN_FILES',
        defaultValue: '10',
        description: 'Deprecated - use manage_embeddings for control.',
      },
      {
        name: 'AMBIANCE_BASE_DIR',
        defaultValue: 'Not set',
        description: 'Optional base path hint for workspace discovery.',
      },
      {
        name: 'CURSOR_WORKSPACE_ROOT',
        defaultValue: 'IDE-provided',
        description: 'Cursor workspace hint used when available.',
      },
      {
        name: 'VSCODE_WORKSPACE_FOLDER',
        defaultValue: 'IDE-provided',
        description: 'VS Code workspace hint used when available.',
      },
    ],
  },
  {
    title: 'Embeddings & Storage',
    summary: 'Local embedding engine with automatic generation on first tool use.',
    vars: [
      {
        name: 'USE_LOCAL_EMBEDDINGS',
        defaultValue: 'true',
        description: 'Enables local embeddings (auto-generated on first tool use).',
      },
      {
        name: 'USE_LOCAL_STORAGE',
        defaultValue: 'false',
        description: 'Legacy toggle kept for backward compatibility.',
      },
      {
        name: 'LOCAL_EMBEDDING_MODEL',
        defaultValue: 'all-MiniLM-L6-v2',
        description: 'Transformers.js model used for offline embeddings.',
      },
      {
        name: 'LOCAL_STORAGE_PATH',
        defaultValue: '~/.ambiance',
        description: 'Folder for local embedding SQLite databases.',
      },
      {
        name: 'EMBEDDING_ASSISTED_HINTS',
        defaultValue: 'Auto',
        description: 'Turns on when local embeddings exist and are ready.',
      },
      {
        name: 'EMBEDDING_BATCH_SIZE',
        defaultValue: '32',
        description: 'Items processed per embedding batch.',
      },
      {
        name: 'EMBEDDING_PARALLEL_MODE',
        defaultValue: 'false',
        description: 'Enable parallel batch execution for embeddings.',
      },
      {
        name: 'EMBEDDING_MAX_CONCURRENCY',
        defaultValue: '10',
        description: 'Maximum concurrent requests when parallel mode is true.',
      },
      {
        name: 'EMBEDDING_RATE_LIMIT_RETRIES',
        defaultValue: '5',
        description: 'Retry attempts after provider rate limits.',
      },
      {
        name: 'EMBEDDING_RATE_LIMIT_BASE_DELAY',
        defaultValue: '1000 ms',
        description: 'Base delay between retries when throttled.',
      },
      {
        name: 'EMBEDDING_QUANTIZATION',
        defaultValue: 'true',
        description: 'Stores embeddings as int8 by default.',
      },
      {
        name: 'EMBEDDING_QUOTAS',
        defaultValue: 'false',
        description: 'Enforce per-project and global storage quotas.',
      },
      {
        name: 'EMBEDDING_GLOBAL_QUOTA',
        defaultValue: '10GB',
        description: 'Total storage cap when quotas are enabled.',
      },
      {
        name: 'USE_OPENAI_EMBEDDINGS',
        defaultValue: 'false',
        description: 'Opt in to use OpenAI for embeddings instead of local models.',
      },
      {
        name: 'USE_VOYAGEAI_EMBEDDINGS',
        defaultValue: 'false',
        description: 'Legacy VoyageAI toggle (feature off by default).',
      },
      {
        name: 'VOYAGEAI_MODEL',
        defaultValue: 'voyageai-model',
        description: 'Default VoyageAI model name when enabled.',
      },
    ],
  },
  {
    title: 'OpenAI & Providers',
    summary: 'API connectivity and model defaults for hosted AI providers.',
    vars: [
      {
        name: 'OPENAI_API_KEY',
        defaultValue: 'Not set',
        description: 'Required to unlock OpenAI-compatible tools.',
      },
      {
        name: 'OPENAI_BASE_URL',
        defaultValue: 'https://api.openai.com/v1',
        description: 'Override for OpenAI-style endpoints.',
      },
      {
        name: 'OPENAI_BASE_MODEL',
        defaultValue: 'gpt-4o',
        description: 'Primary reasoning model requested by default.',
      },
      {
        name: 'OPENAI_MINI_MODEL',
        defaultValue: 'gpt-4o-mini',
        description: 'Lightweight model used for fast operations.',
      },
      {
        name: 'OPENAI_EMBEDDINGS_MODEL',
        defaultValue: 'text-embedding-3-small',
        description: 'Embeddings model requested from hosted providers.',
      },
      {
        name: 'OPENAI_PROVIDER',
        defaultValue: 'openai',
        description:
          'Explicit provider selector (openai, qwen, azure, anthropic, together, custom).',
      },
      {
        name: 'OPENAI_ORG_ID',
        defaultValue: 'Not set',
        description: 'Optional OpenAI organisation identifier.',
      },
      {
        name: 'OPENAI_PROBE_TIMEOUT_MS',
        defaultValue: '3000',
        description: 'Timeout used when probing OpenAI connectivity.',
      },
      {
        name: 'SKIP_OPENAI_PROBE',
        defaultValue: 'false',
        description: 'Skip connectivity probe in constrained environments.',
      },
      {
        name: 'AZURE_OPENAI_ENDPOINT',
        defaultValue: 'Not set',
        description: 'Azure endpoint when OPENAI_PROVIDER=azure.',
      },
      {
        name: 'PROJECT_HINTS_MODEL',
        defaultValue: 'gpt-5-mini',
        description: 'Fallback hints model when providers are unavailable.',
      },
      {
        name: 'AI_CODE_EXPLANATION_TIMEOUT_MS',
        defaultValue: '60000',
        description: 'Timeout applied to AI code explanation requests.',
      },
    ],
  },
  {
    title: 'Ambiance Cloud',
    summary: 'Settings for Ambiance cloud APIs and local overrides.',
    vars: [
      {
        name: 'AMBIANCE_API_KEY',
        defaultValue: 'Not set',
        description: 'Required to enable Ambiance cloud tooling.',
      },
      {
        name: 'AMBIANCE_API_URL',
        defaultValue: 'https://api.ambiance.dev',
        description: 'Primary Ambiance API endpoint.',
      },
      {
        name: 'AMBIANCE_API_BASE_URL',
        defaultValue: 'https://api.ambiance.dev',
        description: 'Alternate endpoint for helper clients.',
      },
      {
        name: 'USING_LOCAL_SERVER_URL',
        defaultValue: 'Not set',
        description: 'Direct cloud calls to a local Ambiance-compatible server.',
      },
      {
        name: 'AMBIANCE_DEVICE_TOKEN',
        defaultValue: 'local-device',
        description: 'Identifier sent with project sync operations.',
      },
    ],
  },
  {
    title: 'Diagnostics & Logging',
    summary: 'Flags that adjust logging verbosity.',
    vars: [
      { name: 'DEBUG', defaultValue: 'false', description: 'Enable verbose debug logging.' },
      {
        name: 'NODE_ENV',
        defaultValue: 'production',
        description: 'Controls logging mode (test, development, etc.).',
      },
    ],
  },
];

// Parse command line arguments
const args = process.argv.slice(2);

// Global options
const wantsExpandedHelp =
  args.includes('--expanded') || args.includes('--env-help') || args.includes('-E');
const isHelp = args.includes('--help') || args.includes('-h');
const isVersion = args.includes('--version') || args.includes('-v') || args.includes('version');
const isServer = args.includes('--server') || args.includes('-s');

// Auto-detect MCP server mode: when no args provided or running non-interactively
const isMcpServerMode = isServer || (args.length === 0 && !process.stdout.isTTY);

// Tool commands
const commands = ['context', 'hints', 'summary', 'frontend', 'debug', 'grep', 'embeddings'];
const isToolCommand = args.length > 0 && commands.includes(args[0]);

// Parse global options
function parseGlobalOptions(args: string[]) {
  const options: { [key: string]: string | boolean } = {};
  const remaining: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      if (arg === '--project-path' && i + 1 < args.length) {
        options.projectPath = args[++i];
      } else if (arg === '--format' && i + 1 < args.length) {
        options.format = args[++i];
      } else if (arg === '--output' && i + 1 < args.length) {
        options.output = args[++i];
      } else if (arg === '--help' || arg === '-h') {
        options.help = true;
      } else if (arg === '--verbose' || arg === '-v') {
        options.verbose = true;
      }
    } else if (!arg.startsWith('-')) {
      remaining.push(arg);
    }
  }

  return { options, remaining };
}

const { options: globalOptions, remaining } = parseGlobalOptions(args);

/**
 * Display help information
 */
function showHelp(options: { expanded?: boolean } = {}): void {
  const expanded = options.expanded === true;
  console.log('🤖 Ambiance MCP Server');
  console.log('======================');
  console.log('');
  console.log('Intelligent code context and analysis for modern IDEs');
  console.log('');
  console.log('📖 Documentation & Setup:');
  console.log('  https://github.com/sbarron/AmbianceMCP');
  console.log('');
  console.log('🚀 Quick Start:');
  console.log('  1. Install: npm install -g @jackjackstudios/ambiance-mcp');
  console.log('  2. Add to your MCP configuration (Cursor/Claude/other IDEs):');
  console.log('');
  console.log('     Windows:');
  console.log('     "ambiance": {');
  console.log('       "command": "cmd",');
  console.log('       "args": [');
  console.log('         "/c",');
  console.log('         "npx",');
  console.log('         "-y",');
  console.log('         "@jackjackstudios/ambiance-mcp@latest"');
  console.log('       ],');
  console.log('       "env": {');
  console.log('         "WORKSPACE_FOLDER": "C:\\\\DevelopmentDirectory\\\\YourProject",');
  console.log('         "USE_LOCAL_EMBEDDINGS": "true",');
  console.log('         "LOCAL_EMBEDDING_MODEL": "all-MiniLM-L6-v2"');
  console.log('       }');
  console.log('     }');
  console.log('');
  console.log('     macOS/Linux:');
  console.log('     "ambiance": {');
  console.log('       "command": "npx",');
  console.log('       "args": [');
  console.log('         "-y",');
  console.log('         "@jackjackstudios/ambiance-mcp@latest"');
  console.log('       ],');
  console.log('       "env": {');
  console.log('         "WORKSPACE_FOLDER": "/path/to/your/project",');
  console.log('         "USE_LOCAL_EMBEDDINGS": "true",');
  console.log('         "LOCAL_EMBEDDING_MODEL": "all-MiniLM-L6-v2"');
  console.log('       }');
  console.log('     }');
  console.log('');
  console.log('💡 Features:');
  console.log('  • 60-80% token reduction through semantic compaction');
  console.log('  • Multi-language support (TypeScript, JavaScript, Python, Go, Rust, C/C++, Java)');
  console.log('  • Automatic local embeddings (generated on first tool use)');
  console.log('  • Incremental file updates (3-min debounced watching)');
  console.log('  • AI enhancement with OpenAI integration');
  console.log('  • Cloud features for GitHub repository analysis');
  console.log('');
  console.log('🔧 Configuration:');
  console.log('  Required:');
  console.log('  • WORKSPACE_FOLDER: Path to your project directory');
  console.log('');
  console.log('  Optional (for AI features):');
  console.log('  • OPENAI_API_KEY: Your OpenAI API key');
  console.log(
    '  • OPENAI_BASE_URL: Custom OpenAI API endpoint (default: https://api.openai.com/v1)'
  );
  console.log('');
  console.log('  Optional (for cloud features):');
  console.log('  • AMBIANCE_API_KEY: Your Ambiance cloud API key');
  console.log('');
  console.log('  Optional (for local embeddings):');
  console.log('  • USE_LOCAL_EMBEDDINGS: "true" to enable local embeddings (default: true)');
  console.log('  • LOCAL_EMBEDDING_MODEL: Model for local embeddings (default: all-MiniLM-L6-v2)');
  console.log('  • SKIP_OPENAI_PROBE: "true" to skip OpenAI connectivity test');
  console.log('  • SKIP_AMBIANCE_PROBE: "true" to skip Ambiance API health check');
  console.log('');
  console.log('  🤖 Embedding Behavior:');
  console.log('  • First use: Auto-generates in background (non-blocking)');
  console.log('  • File changes: Auto-updates via 3-minute debounced watching');
  console.log('  • Manual control: Use manage_embeddings tool for workspace setup');
  console.log('');
  console.log('📦 Package Information:');
  console.log(`  Version: ${packageJson.version}`);
  console.log(`  License: ${packageJson.license}`);
  console.log(`  Repository: ${packageJson.repository.url}`);
  console.log('');
  console.log('Usage:');
  console.log('  ambiance-mcp [options]');
  console.log('  ambiance-mcp <tool> [tool-options] [global-options]');
  console.log('');
  console.log('Options:');
  console.log('  --help, -h          Show this help message');
  console.log('  --expanded, -E      Include environment variable defaults in help output');
  console.log('  --env-help          Shortcut for --help --expanded');
  console.log('  --version, -v       Show version information');
  console.log('  --server, -s        Start MCP server (default mode)');
  console.log('');
  console.log('Tools:');
  console.log('  context             Semantic code compaction and context generation');
  console.log('  hints               Project structure analysis and navigation hints');
  console.log('  summary             Individual file analysis and symbol extraction');
  console.log('  frontend            Frontend code pattern analysis');
  console.log('  debug               Debug context analysis from error logs');
  console.log('  grep                AST-based structural code search');
  console.log(
    '  embeddings          Embedding management and workspace configuration (status, create)'
  );
  console.log('');
  console.log('Global Options:');
  console.log('  --project-path <path>  Project directory path');
  console.log('  --format <format>      Output format (json, structured, compact)');
  console.log('  --output <file>        Write output to file');
  console.log('  --verbose, -v          Enable verbose output');
  console.log('');
  console.log('Examples:');
  console.log('  ambiance-mcp context --query "How does auth work?"');
  console.log('  ambiance-mcp hints --format json --project-path /path/to/project');
  console.log('  ambiance-mcp summary src/index.ts --include-symbols true');
  console.log('  ambiance-mcp grep "function $NAME($ARGS)" --language typescript');
  console.log('  ambiance-mcp embeddings create --project-path /my/workspace');
  console.log('');
  console.log('For detailed setup instructions, visit:');
  console.log('https://github.com/sbarron/AmbianceMCP#readme');
  console.log('');

  if (expanded) {
    console.log('Environment configuration details:');
    console.log('');
    showEnvironmentHelp();
  } else {
    console.log('Tip: Run `ambiance-mcp --help --expanded` to see environment defaults.');
    console.log('');
  }
}

function showEnvironmentHelp(): void {
  console.log('Environment Variables');
  console.log('---------------------');
  console.log('Defaults apply when a variable is unset.');
  console.log('');

  for (const category of ENVIRONMENT_VARIABLES) {
    console.log(`${category.title}:`);
    if (category.summary) {
      console.log(`  ${category.summary}`);
    }
    for (const envVar of category.vars) {
      console.log(`  - ${envVar.name}`);
      console.log(`      Default: ${envVar.defaultValue}`);
      console.log(`      ${envVar.description}`);
    }
    console.log('');
  }
}

/**
 * Display version information
 */
function showVersion(): void {
  console.log(`Ambiance MCP Server v${packageJson.version}`);
}

/**
 * Start the MCP server
 */
async function startServer(): Promise<void> {
  try {
    // Import the MCP server dynamically to avoid loading it when just showing help
    const { AmbianceMCPServer } = await import('./index.js');
    const server = new AmbianceMCPServer();
    await server.start();
    // Keep the server running (this won't return until interrupted)
  } catch (error) {
    console.error(
      '❌ Failed to start MCP server:',
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  }
}
// Tool execution functions
async function executeToolCommand(
  command: string,
  toolArgs: string[],
  globalOptions: any
): Promise<void> {
  try {
    let result: any;

    switch (command) {
      case 'context':
        result = await handleSemanticCompact({
          query: toolArgs.find(arg => !arg.startsWith('--')) || 'Analyze this project',
          projectPath: globalOptions.projectPath || detectProjectPath(),
          format: globalOptions.format || 'structured',
          ...parseToolSpecificArgs(toolArgs, [
            'query',
            'taskType',
            'maxTokens',
            'maxSimilarChunks',
          ]),
        });
        break;

      case 'hints':
        result = await handleProjectHints({
          projectPath: globalOptions.projectPath || detectProjectPath(),
          format: globalOptions.format || 'compact',
          ...parseToolSpecificArgs(toolArgs, ['maxFiles', 'folderPath', 'includeContent', 'useAI']),
        });
        break;

      case 'summary':
        const filePath = toolArgs.find(arg => !arg.startsWith('--'));
        if (!filePath) {
          console.error('Error: filePath is required for summary command');
          process.exit(1);
        }
        result = await handleFileSummary({
          filePath,
          format: globalOptions.format || 'structured',
          ...parseToolSpecificArgs(toolArgs, ['includeSymbols', 'maxSymbols']),
        });
        break;

      case 'frontend':
        result = await handleFrontendInsights({
          projectPath: globalOptions.projectPath || detectProjectPath(),
          format: globalOptions.format || 'structured',
          ...parseToolSpecificArgs(toolArgs, ['includeContent', 'subtree', 'maxFiles']),
        });
        break;

      case 'debug':
        const logText = toolArgs.find(arg => !arg.startsWith('--'));
        if (!logText) {
          console.error('Error: logText is required for debug command');
          process.exit(1);
        }
        result = await handleLocalDebugContext({
          logText,
          projectPath: globalOptions.projectPath || detectProjectPath(),
          format: globalOptions.format || 'structured',
          ...parseToolSpecificArgs(toolArgs, ['maxMatches']),
        });
        break;

      case 'grep':
        const pattern = toolArgs.find(arg => !arg.startsWith('--'));
        if (!pattern) {
          console.error('Error: pattern is required for grep command');
          process.exit(1);
        }
        result = await handleAstGrep({
          pattern,
          projectPath: globalOptions.projectPath || detectProjectPath(),
          ...parseToolSpecificArgs(toolArgs, ['language', 'outputMode']),
        });
        break;

      case 'embeddings':
        const action = toolArgs.find(arg => !arg.startsWith('--')) || 'status';

        // Special handling for create action - require confirmation
        if (action === 'create') {
          const projectPath = globalOptions.projectPath || process.cwd();

          // Wait a moment for initialization messages to complete, then show clear confirmation
          await new Promise(resolve => setTimeout(resolve, 100));

          // Get project file count for better time estimation
          let fileCount = 'unknown';
          let estimatedTime = '2-10 minutes';
          try {
            const fs = require('fs');
            const path = require('path');
            const { globby } = await import('globby');

            const files = await globby(
              [
                '**/*.{ts,tsx,js,jsx,py,go,rs,java,cpp,c,h,hpp,cs,rb,php,swift,kt,scala,clj,hs,ml,r,sql,sh,bash,zsh,md}',
              ],
              {
                cwd: projectPath,
                ignore: ['node_modules/**', 'dist/**', 'build/**', '.git/**'],
                onlyFiles: true,
              }
            );

            fileCount = files.length.toString();
            estimatedTime = estimateEmbeddingTime(files.length);
          } catch (error) {
            // Use default estimate if file counting fails
            estimatedTime = '2-10 minutes';
          }

          console.log('\n' + '='.repeat(70));
          console.log('🚨 EMBEDDING CREATION CONFIRMATION');
          console.log('='.repeat(70));
          console.log(`📁 Project: ${projectPath}`);
          console.log(`📊 Files to Process: ${fileCount} code files`);
          console.log('🔧 Action: Create/Regenerate embeddings for the entire project');
          console.log(`⏱️  Estimated Time: ${estimatedTime}`);
          console.log('💾 Storage: Embeddings will be stored locally in ~/.ambiance/');
          console.log('🔄 Process: Will analyze all code files and generate vector embeddings');
          console.log('📈 Progress: Can be monitored with "ambiance-mcp embeddings status"');
          console.log('='.repeat(70));
          console.log('⚠️  This operation cannot be easily undone.');
          console.log('');

          // Enhanced confirmation prompt with better UX
          const readline = require('readline');
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          const confirmation = await new Promise<string>(resolve => {
            rl.question('❓ Do you want to continue? (y/N): ', (answer: string) => {
              rl.close();
              resolve(answer.toLowerCase().trim());
            });
          });

          console.log(''); // Add spacing

          if (!['y', 'yes'].includes(confirmation)) {
            console.log('✅ Embedding creation cancelled by user.');
            process.exit(0);
          }

          console.log(
            `🚀 Starting embedding creation process (${fileCount} files, ~${estimatedTime})...\n`
          );
        }

        result = await handleManageEmbeddings({
          action,
          projectPath: globalOptions.projectPath || detectProjectPath(),
          ...parseToolSpecificArgs(toolArgs, ['autoGenerate', 'autoFix', 'batchSize']),
        });
        break;

      default:
        console.error(`Unknown tool command: ${command}`);
        process.exit(1);
    }

    // Handle output
    const output = formatToolOutput(result, globalOptions);
    if (globalOptions.output) {
      require('fs').writeFileSync(globalOptions.output, output);
      console.log(`Output written to ${globalOptions.output}`);
    } else {
      console.log(output);
    }
  } catch (error) {
    console.error(
      `Error executing ${command} command:`,
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  }
}

function parseToolSpecificArgs(args: string[], allowedKeys: string[]): { [key: string]: any } {
  const parsed: { [key: string]: any } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--') && allowedKeys.some(key => arg.includes(key.toLowerCase()))) {
      const key = arg.replace('--', '').replace('-', '');
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        const value = args[++i];
        // Try to parse as number or boolean
        if (value === 'true') parsed[key] = true;
        else if (value === 'false') parsed[key] = false;
        else if (!isNaN(Number(value))) parsed[key] = Number(value);
        else parsed[key] = value;
      } else {
        parsed[key] = true;
      }
    }
  }

  return parsed;
}

function formatToolOutput(result: any, options: any): string {
  if (options.format === 'json') {
    return JSON.stringify(result, null, 2);
  }

  if (result.success && typeof result === 'object') {
    return result.content || result.summary || JSON.stringify(result, null, 2);
  }

  if (typeof result === 'string') {
    return result;
  }

  return JSON.stringify(result, null, 2);
}

// Main CLI logic
async function main() {
  if (isHelp) {
    showHelp({ expanded: wantsExpandedHelp });
    process.exit(0);
  } else if (isVersion) {
    showVersion();
    process.exit(0);
  } else if (isMcpServerMode) {
    // Start MCP server - this will run indefinitely until interrupted
    await startServer();
  } else if (isToolCommand && remaining.length > 0) {
    // Execute tool command
    const command = remaining[0];
    const toolArgs = remaining.slice(1);
    await executeToolCommand(command, toolArgs, globalOptions);
  } else {
    // Fallback to help for unrecognized arguments
    console.log('Unrecognized arguments. Use --help for usage information.\n');
    showHelp();
    process.exit(1);
  }
}

// Run main function
main().catch(error => {
  console.error('CLI Error:', error);
  process.exit(1);
});
