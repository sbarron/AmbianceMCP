#!/usr/bin/env node

/**
 * Ambiance MCP Server CLI
 *
 * Provides command-line interface for the Ambiance MCP server.
 * Supports both help display and MCP server mode.
 */

const packageJson = require('../../package.json');

// Parse command line arguments
const args = process.argv.slice(2);
const isHelp = args.includes('--help') || args.includes('-h');
const isVersion = args.includes('--version') || args.includes('-v');
const isServer = args.includes('--server') || args.includes('-s') || args.length === 0; // Default to server mode

/**
 * Display help information
 */
function showHelp(): void {
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
  console.log('  • Token reduction through semantic compaction');
  console.log('  • Multi-language support (TypeScript, JavaScript, Python, Go, Rust)');
  console.log('  • Local embeddings for cost-effective operation');
  console.log('  • AI enhancement with OpenAI integration');
  console.log('  • Cloud features for GitHub repository analysis');
  console.log('');
console.log('🔧 Configuration:');
console.log('  Required:');
console.log('  • WORKSPACE_FOLDER: Path to your project directory');
console.log('');
console.log('  Optional (for AI features):');
console.log('  • OPENAI_API_KEY: Your OpenAI API key');
console.log('  • OPENAI_BASE_URL: Custom OpenAI API endpoint (default: https://api.openai.com/v1)');
console.log('');
console.log('  Optional (for cloud features):');
console.log('  • AMBIANCE_API_KEY: Your Ambiance cloud API key');
console.log('');
console.log('  Optional (for local embeddings):');
console.log('  • USE_LOCAL_EMBEDDINGS: "true" to enable local embeddings (default: false)');
console.log('  • USE_LOCAL_STORAGE: Alternative to USE_LOCAL_EMBEDDINGS (default: false)');
console.log('  • LOCAL_EMBEDDING_MODEL: Model for local embeddings (default: all-MiniLM-L6-v2)');
console.log('  • SKIP_OPENAI_PROBE: "true" to skip OpenAI connectivity test');
console.log('  • SKIP_AMBIANCE_PROBE: "true" to skip Ambiance API health check');
console.log('');
  console.log('📦 Package Information:');
  console.log(`  Version: ${packageJson.version}`);
  console.log(`  License: ${packageJson.license}`);
  console.log(`  Repository: ${packageJson.repository.url}`);
  console.log('');
  console.log('Usage:');
  console.log('  ambiance-mcp [options]');
  console.log('');
  console.log('Options:');
  console.log('  --help, -h          Show this help message');
  console.log('  --version, -v       Show version information');
  console.log('  --server, -s        Start MCP server (default mode)');
  console.log('');
  console.log('For detailed setup instructions, visit:');
  console.log('https://github.com/sbarron/AmbianceMCP#readme');
  console.log('');
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
  } catch (error) {
    console.error('❌ Failed to start MCP server:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
// Main CLI logic
if (isHelp) {
  showHelp();
  process.exit(0);
} else if (isVersion) {
  showVersion();
  process.exit(0);
} else if (isServer) {
  // Start MCP server - this will run indefinitely until interrupted
  startServer();
} else {
  // Fallback to help for unrecognized arguments
  console.log('Unrecognized arguments. Use --help for usage information.\n');
  showHelp();
  process.exit(1);
}

