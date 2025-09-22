# Ambiance MCP Server

> **Intelligent code context and analysis for modern IDEs**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.1+-blue)](https://www.typescriptlang.org/)
[![Version](https://img.shields.io/badge/version-0.1.0-blue)](https://github.com/jackjackstudios/AmbianceMCP)

This is a **MCP (Model Context Protocol)** server that provides intelligent code context through semantic analysis, AST parsing, and token-efficient compression. Add OpenAI-compatible API keys to unlock AI-powered summarization and analysis tools. Core functionality works completely offline - no internet required for basic use.

**Stop wasting time** with manual file exploration and context switching. This tool gives AI assistants **instant, accurate understanding** of your codebase through intelligent semantic search, eliminating the need for endless file reads and grep searches. Get **60-80% better token efficiency** while maintaining full semantic understanding of your projects.

## 🤖 What is MCP?

**Model Context Protocol (MCP)** enables AI assistants to understand your codebase contextually. Instead of copying/pasting code, MCP servers provide structured access to your project's files, symbols, and relationships.

Ambiance MCP excels at:
- **60-80% token reduction** through semantic compaction
- **Multi-language analysis** (TypeScript, JavaScript, Python, Go, Rust, Java)
- **Intelligent ranking** based on relevance, recency, and importance
- **Progressive enhancement** from local-only to AI-powered to cloud-integrated

## ✨ Key Features

- 🧠 **Multi-tier Intelligence**: Local → OpenAI → Cloud service with graceful fallbacks
- 🔧 **Semantic Compaction**: 60-80% token reduction while preserving code meaning
- 🚀 **Zero Dependencies**: Core functionality works completely offline
- 🔍 **Multi-Language Support**: TypeScript, JavaScript, Python, Go, Rust, and more
- 📊 **Project Analysis**: Smart architecture detection and navigation hints
- 🛡️ **Production Ready**: Enterprise-grade error handling, logging, and structured error management

## 🎯 Release Scope

### ✅ Included in Release (v0.1.0)

**Core Local Tools (No API Keys Required):**
- `local_context` - Semantic code compaction with token-efficient compression (60-80% reduction)
- `local_project_hints` - Project navigation with architecture detection
- `local_file_summary` - AST-based file analysis and symbol extraction
- `frontend_insights` - Comprehensive Next.js/React frontend analysis
- `workspace_config` - Embedding management and workspace setup
- `local_debug_context` - Error analysis and debugging assistance
- `ast_grep_search` - Structural code pattern searching

**Enhanced AI Tools (OpenAI API Key Required):**
- `ai_get_context` - AI-optimized context with recursive analysis
- `ai_project_insights` - Enhanced project analysis with AI insights
- `ai_code_explanation` - Detailed code documentation and explanations

**Cloud Tools (Ambiance API Key Required):**
- `ambiance_search_github_repos` - Search code within indexed GitHub repositories
- `ambiance_list_github_repos` - List available GitHub repositories
- `ambiance_get_context` - Get structured context from GitHub repositories
- `ambiance_get_graph_context` - Graph-based repository context analysis

### 🔮 Future Releases

- **Enhanced Features**: LMDB storage, incremental parsing, local semantic index
- **Advanced Tools**: Profile/approval enforcement and diagnostics tooling
- **Integration**: ACP bridge and @-mention resolver
- **Cloud Expansion**: Enhanced uploaded project handlers and search capabilities

## 🚀 Quick Start (5 Minutes)

### CLI Help

After installation, get help and documentation:

```bash
# Show help and documentation (if installed globally)
ambiance-mcp

# Or if installed locally in your project
npx ambiance-mcp

# Or run the built version directly
node node_modules/ambiance-mcp/dist/src/cli.js
```

**What you'll see:**
```
🤖 Ambiance MCP Server
======================

Intelligent code context and analysis for modern IDEs

📖 Documentation & Setup:
  https://github.com/jackjackstudios/AmbianceMCP#readme

🚀 Quick Start:
  1. Install: npm install -g @jackjackstudios/ambiance-mcp
  2. Configure your IDE to use the MCP server
  3. Set WORKSPACE_FOLDER environment variable

💡 Features:
  • 60-80% token reduction through semantic compaction
  • Multi-language support (TypeScript, JavaScript, Python, Go, Rust)
  • Local embeddings for cost-effective operation
  • AI enhancement with OpenAI integration
  • Cloud features for GitHub repository analysis

🔧 Configuration:
  Set WORKSPACE_FOLDER to your project path
  Optional: OPENAI_API_KEY for AI features
  Optional: AMBIANCE_API_KEY for cloud features

📦 Package Information:
  Version: 0.1.0
  License: MIT
  Repository: https://github.com/jackjackstudios/AmbianceMCP
```

### 1. Install & Build

```bash
# Option 1: Install globally for CLI access
npm install -g @jackjackstudios/ambiance-mcp

# Option 2: Install locally in your project
npm install @jackjackstudios/ambiance-mcp

# Option 3: Build from source
git clone https://github.com/jackjackstudios/AmbianceMCP.git
cd AmbianceMCP
npm install
npm run build
```

### 2. Configure Your IDE

#### Recommended Starting Setup (Local Tools with embeddings)
```json
{
  "mcpServers": {
    "ambiance": {
      "command": "node",
      "args": ["/path/to/ambiance-mcp-server/dist/src/index.js"],
      "env": {
        "WORKSPACE_FOLDER": "/path/to/your/project",
        "USE_LOCAL_EMBEDDINGS": "true",
        "LOCAL_EMBEDDING_MODEL": "all-MiniLM-L6-v2"
      }
    }
  }
}
```

#### Minimum Setup (Local and AI Tools (summarization) with embeddings for semantic search)
```json
{
  "mcpServers": {
    "ambiance": {
      "command": "node",
      "args": ["/path/to/ambiance-mcp-server/dist/src/index.js"],
      "env": {
        "WORKSPACE_FOLDER": "/path/to/your/project",
        "OPENAI_API_KEY": "your-openai-key",
        "OPENAI_BASE_MODEL": "gpt-4",
        "OPENAI_MINI_MODEL": "gpt-4o-mini",
        "USE_LOCAL_EMBEDDINGS": "true",
        "LOCAL_EMBEDDING_MODEL": "all-MiniLM-L6-v2"
      }
    }
  }
}
```

#### Basic Setup (Local Tools without embeddings (no semantic search))
```json
{
  "mcpServers": {
    "ambiance": {
      "command": "node",
      "args": ["/path/to/ambiance-mcp-server/dist/src/index.js"],
      "env": {
        "WORKSPACE_FOLDER": "/path/to/your/project"
      }
    }
  }
}
```

### 3. Start Using

**Feature Tiers** (based on your setup):

- **🚀 Local Embeddings** (`USE_LOCAL_EMBEDDINGS=true`): Cost-effective, offline-ready
- **🤖 AI Enhancement** (`OPENAI_API_KEY`): Intelligent context analysis
- **☁️ Cloud Features**: Coming soon - GitHub repository integration

**That's it!** Ambiance automatically enables features based on your environment variables.

## 🔧 Configuration Options

### Environment Variables

| Variable | Purpose | Required | Default |
|----------|---------|----------|---------|
| `WORKSPACE_FOLDER` | Project workspace path | ✅ | Auto-detected |
| `OPENAI_API_KEY` | AI-enhanced tools | ❌ | - |
| `AMBIANCE_API_KEY` | Cloud features | ❌ | - |
| `USE_LOCAL_EMBEDDINGS` | Local embedding storage | ❌ | `false` |

### Enhanced Features (Optional)

#### AI Enhancement
Add OpenAI API key for intelligent context analysis:
```bash
OPENAI_API_KEY=your-openai-key
OPENAI_BASE_MODEL=gpt-4  # or gpt-5
```

#### Cloud Integration
Add Ambiance API key for GitHub repository access:
```bash
AMBIANCE_API_KEY=amb_your-key
AMBIANCE_API_URL=https://api.ambiance.dev
```

#### Local Embeddings
Enable cost-effective local embedding storage:
```bash
USE_LOCAL_EMBEDDINGS=true
LOCAL_EMBEDDING_MODEL=all-MiniLM-L6-v2
```

## 🛠️ Available Tools

### Core Tools (Always Available)

| Tool | Purpose | API Keys |
|------|---------|----------|
| `local_context` | Semantic code compaction (60-80% reduction) | None |
| `local_project_hints` | Project navigation & architecture detection | None |
| `local_file_summary` | AST-based file analysis | None |
| `workspace_config` | Embedding management & setup | None |
| `local_debug_context` | Error analysis & debugging | None |

### AI-Enhanced Tools (OpenAI API Required)

| Tool | Purpose | Enhancement |
|------|---------|-------------|
| `ai_get_context` | Intelligent context analysis | AI optimization |
| `ai_project_hints` | Enhanced project insights | AI-powered analysis |
| `ai_code_explanation` | Detailed code documentation | AI explanations |

### Cloud Tools (Ambiance API Required)

| Tool | Purpose | Features |
|------|---------|----------|
| `ambiance_search_github_repos` | Search GitHub repositories | Cloud indexing |
| `ambiance_list_github_repos` | List available repositories | Repository management |
| `ambiance_get_context` | GitHub repository context | Cloud context |
| `ambiance_get_graph_context` | Graph-based analysis | Advanced relationships |

### Example Usage

```typescript
// Basic context analysis (no API keys needed)
{
  "tool": "local_context",
  "arguments": {
    "projectPath": ".",
    "maxTokens": 4000,
    "query": "authentication system"
  }
}

// AI-enhanced analysis (OpenAI API required)
{
  "tool": "ai_get_context",
  "arguments": {
    "query": "debug login failure",
    "taskType": "debug",
    "maxTokens": 8000
  }
}

## 🚀 Usage Examples

### Basic Code Analysis
```typescript
// Get semantic context (no API keys needed)
{
  "tool": "local_context",
  "arguments": {
    "projectPath": ".",
    "maxTokens": 4000,
    "query": "authentication system",
    "taskType": "understand"
  }
}
```

### Project Navigation
```typescript
// Understand project structure
{
  "tool": "local_project_hints",
  "arguments": {
    "projectPath": ".",
    "format": "structured"
  }
}
```

### File Analysis
```typescript
// Analyze specific file
{
  "tool": "local_file_summary",
  "arguments": {
    "filePath": "src/auth.ts",
    "includeSymbols": true
  }
}
```

### AI-Enhanced Analysis (OpenAI API Required)
```typescript
// Get intelligent context analysis
{
  "tool": "ai_get_context",
  "arguments": {
    "query": "debug login failure",
    "taskType": "debug",
    "maxTokens": 8000
  }
}
```

### GitHub Repository Analysis (Ambiance API Required)
```typescript
// Search GitHub repositories
{
  "tool": "ambiance_search_github_repos",
  "arguments": {
    "query": "authentication middleware",
    "repoId": "my-org/my-repo"
  }
}
```

## 🛠️ Development

### Building from Source
```bash
npm install
npm run build
npm test
```

### Testing
```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test suites
npm run test:embeddings
npm run test:compactor
```

### Contributing
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Ensure tests pass: `npm test`
6. Submit a pull request

## 📊 Performance & Security

- **60-80% token reduction** through semantic compaction
- **Multi-language support**: TypeScript, JavaScript, Python, Go, Rust, Java
- **Enterprise security**: Input validation, path traversal protection
- **Memory efficient**: ~50MB peak during processing
- **Fast processing**: 2-5 seconds for typical projects

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| **OpenAI Integration** | | | |
| `OPENAI_API_KEY` | Required for OpenAI tools | - | OpenAI API key |
| `OPENAI_BASE_URL` | Optional | `https://api.openai.com/v1` | OpenAI-compatible API endpoint |
| `OPENAI_BASE_MODEL` | Optional | `gpt-5` | Primary model for analysis tasks |
| `OPENAI_MINI_MODEL` | Optional | `gpt-5-mini` | Faster model for hints/summaries |
| `OPENAI_EMBEDDINGS_MODEL` | Optional | `text-embedding-3-large` | Model for generating embeddings |
| `OPENAI_ORG_ID` | Optional | - | OpenAI organization ID |
| `OPENAI_PROVIDER` | Optional | `openai` | Provider: `openai`, `qwen`, `azure`, `anthropic`, `together` |
| **Ambiance Cloud Service** | | | |
| `AMBIANCE_API_KEY` | Required for cloud tools | - | Ambiance cloud API key |
| `AMBIANCE_API_URL` | Optional | `https://api.ambiance.dev` | Ambiance cloud API URL |
| `AMBIANCE_DEVICE_TOKEN` | Optional | - | Device identification token |
| **Local Server** | | | |
| `USING_LOCAL_SERVER_URL` | Optional | - | Use local Ambiance server instead of cloud |
| **Local Storage** | | | |
| `USE_LOCAL_EMBEDDINGS` | Optional | `false` | Enable local embedding storage |
| `LOCAL_EMBEDDING_MODEL` | Optional | `all-MiniLM-L6-v2` | Local embedding model when using local embeddings. When set with `USE_LOCAL_EMBEDDINGS=true`, overrides cloud providers for cost-effective local embeddings |
| `LOCAL_STORAGE_PATH` | Optional | `~/.ambiance/embeddings` | Custom local storage path |
| `EMBEDDING_BATCH_SIZE` | Optional | `32` | Number of texts per embedding batch |
| `EMBEDDING_PARALLEL_MODE` | Optional | `false` | Enable parallel embedding generation |
| `EMBEDDING_MAX_CONCURRENCY` | Optional | `10` | Max concurrent API calls for parallel mode |
| `EMBEDDING_RATE_LIMIT_RETRIES` | Optional | `5` | Max retries for rate limit errors |
| `EMBEDDING_RATE_LIMIT_BASE_DELAY` | Optional | `1000` | Base delay for rate limit retries (ms) |
| **Workspace** | | | |
| `WORKSPACE_FOLDER` | Critical for Cursor | Auto-detected | Project workspace path |
| `AMBIANCE_BASE_DIR` | Optional | Current directory | Override working directory |
| **Development** | | | |
| `DEBUG` | Optional | `false` | Enable debug logging |
| `NODE_ENV` | Optional | - | Affects logging behavior (`development`, `test`, `production`) |

### Configuration Tiers

1. **Tier 1: Local Only** (No API keys required)
   - ✅ `local_context`, `local_project_hints`, `local_file_summary`
   - ✅ Works completely offline
   - ✅ 60-80% semantic compression
   - ✅ Cost-effective local embeddings with `USE_LOCAL_EMBEDDINGS=true`

2. **Tier 2: Enhanced** (OpenAI API key)
   - ✅ All Tier 1 tools
   - ✅ `ambiance_get_context` with AI optimization
   - ✅ Enhanced `ambiance_project_hints`
   - ✅ High-performance parallel embedding generation
   - ✅ OpenAI embeddings (when not using local embeddings)

3. **Tier 3: Full Cloud** (Both API keys)
   - ✅ All previous tools
   - ✅ All previous tools
   - ✅ `ambiance_setup_project`, `ambiance_project_status`
   - ✅ Team collaboration features

### Embedding Provider Priority

The system intelligently selects embedding providers based on your configuration:

1. **Local Priority** (when `USE_LOCAL_EMBEDDINGS=true` and `LOCAL_EMBEDDING_MODEL` is set)
   - Uses cost-effective local Transformers.js models like `all-MiniLM-L6-v2`
   - Works completely offline
   - Overrides cloud providers when explicitly configured

2. **Cloud Priority** (when `AMBIANCE_API_KEY` is available)
   - Uses high-performance cloud embeddings (voyage-context-3)
   - Requires internet connection

3. **OpenAI Fallback** (when `OPENAI_API_KEY` is available)
   - Uses OpenAI embeddings (text-embedding-3-small)
   - Falls back when cloud services unavailable

4. **Pure Local** (no API keys)
   - Uses local Transformers.js models
   - Completely offline operation

### Performance Optimization

#### Parallel Embedding Generation with Smart Rate Limiting
For large projects, you can significantly speed up embedding generation using parallel processing with intelligent rate limit handling:

```bash
# Enable parallel mode with smart rate limit handling
EMBEDDING_PARALLEL_MODE=true
EMBEDDING_MAX_CONCURRENCY=10           # Starting concurrency (auto-adjusts)
EMBEDDING_BATCH_SIZE=32                # Balance batch size with memory usage
EMBEDDING_RATE_LIMIT_RETRIES=5         # Retry failed requests up to 5 times
EMBEDDING_RATE_LIMIT_BASE_DELAY=1000   # Base delay between retries (1 second)
```


**Example for large project:**
```bash
EMBEDDING_PARALLEL_MODE=true
EMBEDDING_MAX_CONCURRENCY=15
EMBEDDING_BATCH_SIZE=64
EMBEDDING_RATE_LIMIT_RETRIES=3
```

**Rate Limit Behavior:**
- ⏳ **Rate Limit Hit**: Retries with exponential backoff (1s, 2s, 4s, 8s, 16s)
- 📉 **Multiple Hits**: Automatically reduces concurrency by half
- 🔄 **Recovery**: Gradually increases concurrency after 1 minute
- 🚫 **Fallback**: Only switches to local embeddings for permanent failures (not rate limits)

Monitor your OpenAI usage dashboard to ensure you stay within rate limits.

### Environment Variables for MCP Server
```bash
# Point to your local Ambiance server backend
USING_LOCAL_SERVER_URL=http://localhost:3001

# Optional: API key if your local server requires authentication
AMBIANCE_API_KEY=your-local-api-key

# Required: For embedding generation and AI features
OPENAI_API_KEY=your-openai-key
OPENAI_BASE_MODEL=gpt-5
OPENAI_MINI_MODEL=gpt-5-mini
OPENAI_EMBEDDINGS_MODEL=text-embedding-3-large

# Local storage configuration
USE_LOCAL_EMBEDDINGS=true
LOCAL_STORAGE_PATH=/path/to/local/embeddings/storage

# Workspace configuration
WORKSPACE_FOLDER=/path/to/your/workspace
```

### Common Issues

**"No tools available"**
- Ensure the server is built: `npm run build`
- Check file paths are absolute in IDE configuration
- Verify Node.js version >= 18.0.0

**"Tool execution failed"**
- Check server logs for detailed error messages
- Ensure project path exists and is readable
- For OpenAI tools, verify API key is valid
- For Ambiance cloud tools, check `AMBIANCE_API_KEY` is set, register on website for key.

### Debugging Server Issues

```bash
# Enable debug logging
DEBUG=ambiance:* npm run dev

# Check configuration
npm run test
```

## 🏗️ Development

### Building from Source

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Run tests
npm test
npm run test:coverage

# Performance benchmarks
npm run benchmark:current
```

### Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Make your changes following our coding standards
4. Add tests for new functionality
5. Ensure all tests pass: `npm test`
6. Run performance benchmarks: `npm run benchmark`
7. Commit your changes: `git commit -m 'Add amazing feature'`
8. Push to the branch: `git push origin feature/amazing-feature`
9. Open a Pull Request

### Code Quality Standards

- ✅ TypeScript with strict mode
- ✅ Comprehensive error handling
- ✅ Structured logging (no console.log)
- ✅ >85% test coverage target
- ✅ Performance benchmarking

## 🔒 Security

- ✅ Input validation and sanitization
- ✅ Path traversal protection  
- ✅ No sensitive data logging
- ✅ Secure file operations only
- ✅ API key handling best practices

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

