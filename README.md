# Ambiance MCP Server

> **Intelligent code context and analysis for modern IDEs**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.1+-blue)](https://www.typescriptlang.org/)
[![Version](https://img.shields.io/badge/version-0.1.1-blue)](https://github.com/sbarron/AmbianceMCP)

**MCP server that provides intelligent code context through semantic analysis, AST parsing, and token-efficient compression. Get 60-80% better token efficiency while maintaining full semantic understanding of your codebase.**

## 🚀 Quick Start

### 1. Install
```bash
npm install -g @jackjackstudios/ambiance-mcp
```

### 2. Create Embeddings (Recommended)
Navigate to your project directory and create embeddings for enhanced context analysis:
```bash
cd /path/to/your/project
ambiance-mcp embeddings create
```
This step generates local embeddings that enable semantic search and improve context analysis. The process may take 2-10 minutes depending on project size.

### 3. Configure Your IDE

**Windows:**
```json
{
  "mcpServers": {
    "ambiance": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "@jackjackstudios/ambiance-mcp@latest"
      ],
      "env": {
        "WORKSPACE_FOLDER": "C:\\DevelopmentDirectory\\YourProject",
        "USE_LOCAL_EMBEDDINGS": "true"
      }
    }
  }
}
```

**macOS/Linux:**
```json
{
  "mcpServers": {
    "ambiance": {
      "command": "npx",
      "args": [
        "-y",
        "@jackjackstudios/ambiance-mcp@latest"
      ],
      "env": {
        "WORKSPACE_FOLDER": "/path/to/your/project",
        "USE_LOCAL_EMBEDDINGS": "true"
      }
    }
  }
}
```

### 4. Start Using

**That's it!** Ambiance automatically enables features based on your environment variables:
- 🚀 **Local Embeddings** (`USE_LOCAL_EMBEDDINGS=true`): Cost-effective, offline-ready
- 🤖 **AI Enhancement** (`OPENAI_API_KEY`): Intelligent context analysis
- ☁️ **Cloud Features** (`AMBIANCE_API_KEY`): GitHub repository integration

## ✨ Key Features

- 🧠 **60-80% token reduction** through semantic compaction
- 🔍 **Multi-language support** (TypeScript, JavaScript, Python, Go, Rust)
- 🚀 **Works completely offline** - no internet required for core functionality
- 🎯 **Intelligent context analysis** with AI enhancement options
- 📊 **Project structure understanding** and navigation hints

## 🔧 Configuration

### Environment Variables

| Variable | Purpose | Required | Default |
|----------|---------|----------|---------|
| `WORKSPACE_FOLDER` | Project workspace path | ✅ | Auto-detected |
| `OPENAI_API_KEY` | AI-enhanced tools | ❌ | - |
| `AMBIANCE_API_KEY` | Cloud features | ❌ | - |
| `USE_LOCAL_EMBEDDINGS` | Local embedding storage | ❌ | `false` |

### Enhanced Features (Optional)

**AI Enhancement:**
```bash
OPENAI_API_KEY=your-openai-key
OPENAI_BASE_MODEL=gpt-4
```

**Cloud Integration:**
```bash
AMBIANCE_API_KEY=your-cloud-key
```

**Local Embeddings:**
```bash
USE_LOCAL_EMBEDDINGS=true
LOCAL_EMBEDDING_MODEL=all-MiniLM-L6-v2
LOG_LEVEL=warn  # Reduce verbose output (optional)
```

### How Embeddings Work

**First-Time Usage:**
- Embeddings are generated **automatically in the background** when you first use embedding-enhanced tools like `local_context` (when `USE_LOCAL_EMBEDDINGS=true`)
- Tools return results immediately using AST analysis while embeddings generate in the background
- Subsequent queries benefit from the generated embeddings for enhanced context similarity search

**Ongoing Updates:**
- File watcher monitors your project for changes (3-minute debounce)
- Only modified files have their embeddings updated
- Incremental updates keep embeddings current without full re-indexing

**Manual Control:**
Use `manage_embeddings` tool for fine-grained control:
```typescript
// Check embedding status with progress information
{ "action": "status", "projectPath": "." }

// Monitor progress during active generation
ambiance-mcp embeddings status

// Set workspace and auto-generate embeddings
{ "action": "set_workspace", "projectPath": ".", "autoGenerate": true }

// Regenerate all embeddings (after model changes)
{ "action": "create", "projectPath": ".", "force": true }
```

**Progress Monitoring:**
- Use `ambiance-mcp embeddings status` to check if generation is in progress
- Shows real-time progress: files processed, estimated time remaining
- Displays elapsed time and completion percentage

## 🛠️ Available Tools

### Core Tools (Always Available)
- `local_context` - Semantic code compaction (60-80% reduction)
- `local_project_hints` - Project navigation & architecture detection
- `local_file_summary` - AST-based file analysis
- `manage_embeddings` - Workspace & embedding management (replaces `workspace_config`)
- `local_debug_context` - Error analysis & debugging

### AI-Enhanced Tools (OpenAI API Required)
- `ai_get_context` - Intelligent context analysis
- `ai_project_hints` - Enhanced project insights
- `ai_code_explanation` - Detailed code documentation

### Cloud Tools (Ambiance API Required)
- `ambiance_search_github_repos` - Search GitHub repositories
- `ambiance_list_github_repos` - List available repositories
- `ambiance_get_context` - GitHub repository context

## 🖥️ Command Line Interface

Ambiance MCP now includes a comprehensive CLI for direct tool execution, perfect for development, testing, and standalone usage without requiring an MCP client.

### CLI Tools (No API Keys Required)

All local tools are available via CLI with no external dependencies:

| Command | Description | Example |
|---------|-------------|---------|
| `context` | Semantic code compaction and context generation | `ambiance-mcp context --query "authentication system"` |
| `hints` | Project structure analysis and navigation hints | `ambiance-mcp hints --format json` |
| `summary` | Individual file analysis and symbol extraction | `ambiance-mcp summary src/index.ts` |
| `frontend` | Frontend code pattern analysis | `ambiance-mcp frontend --include-content true` |
| `debug` | Debug context analysis from error logs | `ambiance-mcp debug "Error: Cannot read property"` |
| `grep` | AST-based structural code search | `ambiance-mcp grep "function $NAME($ARGS)"` |
| `embeddings` | Embedding management and workspace configuration | `ambiance-mcp embeddings status`, `ambiance-mcp embeddings create` |

### Global Options

| Option | Description | Example |
|--------|-------------|---------|
| `--project-path <path>` | Set project directory | `--project-path /my/project` |
| `--format <format>` | Output format (json, structured, compact) | `--format json` |
| `--output <file>` | Write output to file | `--output results.json` |
| `--verbose, -v` | Enable verbose output | `--verbose` |

### CLI Examples

```bash
# Project analysis with JSON output
ambiance-mcp hints --format json --project-path /path/to/project

# File analysis with symbols
ambiance-mcp summary src/index.ts --include-symbols true --format compact

# Structural code search
ambiance-mcp grep "function $NAME($ARGS)" --language typescript

# Context generation for specific query
ambiance-mcp context --query "How does database connection work?" --max-tokens 2000

# Debug error analysis
ambiance-mcp debug "TypeError: Cannot read property 'map' of undefined" --max-matches 10

# Embedding management
ambiance-mcp embeddings status --project-path /my/workspace
ambiance-mcp embeddings create --project-path /my/workspace
# Note: create command shows a detailed confirmation prompt before proceeding

# Save output to file
ambiance-mcp hints --format json --output project-analysis.json

# Verbose output for debugging
ambiance-mcp summary src/index.ts --verbose
```


## 📖 Documentation

For detailed help and configuration options, run:
```bash
ambiance-mcp --help
ambiance-mcp --help --expanded
```

For source code and contributions, visit: https://github.com/sbarron/AmbianceMCP

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.