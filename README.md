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

### 2. Configure Your IDE

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

### 3. Start Using

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
```

## 🛠️ Available Tools

### Core Tools (Always Available)
- `local_context` - Semantic code compaction (60-80% reduction)
- `local_project_hints` - Project navigation & architecture detection
- `local_file_summary` - AST-based file analysis
- `workspace_config` - Embedding management & setup
- `local_debug_context` - Error analysis & debugging

### AI-Enhanced Tools (OpenAI API Required)
- `ai_get_context` - Intelligent context analysis
- `ai_project_hints` - Enhanced project insights
- `ai_code_explanation` - Detailed code documentation

### Cloud Tools (Ambiance API Required)
- `ambiance_search_github_repos` - Search GitHub repositories
- `ambiance_list_github_repos` - List available repositories
- `ambiance_get_context` - GitHub repository context

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
```

## 📖 Documentation

For detailed help and configuration options, run:
```bash
ambiance-mcp --help
```

For source code and contributions, visit: https://github.com/sbarron/AmbianceMCP

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.