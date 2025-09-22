#!/usr/bin/env node

/**
 * Ambiance MCP Server CLI
 *
 * Provides command-line help and documentation for the Ambiance MCP server.
 */

const packageJson = require('../../package.json');

console.log('🤖 Ambiance MCP Server');
console.log('======================');
console.log('');
console.log('Intelligent code context and analysis for modern IDEs');
console.log('');
console.log('📖 Documentation & Setup:');
console.log('  https://github.com/jackjackstudios/AmbianceMCP#readme');
console.log('');
console.log('🚀 Quick Start:');
console.log('  1. Install: npm install -g @jackjackstudios/ambiance-mcp');
console.log('  2. Configure your IDE to use the MCP server');
console.log('  3. Set WORKSPACE_FOLDER environment variable');
console.log('');
console.log('💡 Features:');
console.log('  • 60-80% token reduction through semantic compaction');
console.log('  • Multi-language support (TypeScript, JavaScript, Python, Go, Rust)');
console.log('  • Local embeddings for cost-effective operation');
console.log('  • AI enhancement with OpenAI integration');
console.log('  • Cloud features for GitHub repository analysis');
console.log('');
console.log('🔧 Configuration:');
console.log('  Set WORKSPACE_FOLDER to your project path');
console.log('  Optional: OPENAI_API_KEY for AI features');
console.log('  Optional: AMBIANCE_API_KEY for cloud features');
console.log('');
console.log('📦 Package Information:');
console.log(`  Version: ${packageJson.version}`);
console.log(`  License: ${packageJson.license}`);
console.log(`  Repository: ${packageJson.repository.url}`);
console.log('');
console.log('For detailed setup instructions, visit:');
console.log('https://github.com/jackjackstudios/AmbianceMCP#readme');
console.log('');
