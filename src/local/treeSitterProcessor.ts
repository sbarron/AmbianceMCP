/**
 * @fileOverview: Tree-sitter based AST parsing and code analysis with fallback parsing support
 * @module: TreeSitterProcessor
 * @keyFunctions:
 *   - parseAndChunk(): Parse code and create semantic chunks with symbol extraction
 *   - extractSymbols(): Extract code symbols and cross-references
 *   - initializeParsers(): Set up language-specific parsers with error handling
 *   - fallbackParse(): Basic parsing when tree-sitter is unavailable
 * @dependencies:
 *   - tree-sitter: Core parsing engine (optional)
 *   - tree-sitter-typescript: TypeScript/TSX parsing
 *   - tree-sitter-javascript: JavaScript parsing
 *   - tree-sitter-python: Python parsing
 * @context: Provides robust AST parsing with graceful fallback to basic parsing when tree-sitter dependencies are unavailable, supporting multiple programming languages
 */

// Optional tree-sitter import to avoid hard native dependency at runtime
let Parser: any = null;
try {
  Parser = require('tree-sitter');
} catch {
  Parser = null;
}

// We'll need to install these as dev dependencies if not already available
let TypeScript: any;
let JavaScript: any;
let Python: any;

try {
  TypeScript = require('tree-sitter-typescript').typescript;
  JavaScript = require('tree-sitter-javascript');
  Python = require('tree-sitter-python');
} catch (error) {
  console.warn('Some tree-sitter parsers not available:', error);
}

export interface CodeChunk {
  content: string;
  startLine: number;
  endLine: number;
  tokenEstimate: number;
  symbolId?: string;
  symbolName?: string;
  symbolType?: string;
}

export interface CodeSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  lang: string;
  source: string;
}

export interface CodeXRef {
  name: string;
  kind: 'import' | 'export';
  startLine: number;
  endLine: number;
  targetPath?: string;
}

export class TreeSitterProcessor {
  private parsers: Map<string, any>;

  constructor() {
    this.parsers = new Map();
    this.initializeParsers();
  }

  private initializeParsers(): void {
    if (!Parser) {
      console.warn('Tree-sitter parser not available, will use fallback parsing');
      return;
    }

    try {
      if (TypeScript) {
        const tsParser = new Parser();
        try {
          tsParser.setLanguage(TypeScript);
          this.parsers.set('typescript', tsParser);
        } catch (error) {
          console.warn('Failed to initialize TypeScript parser:', error);
        }
      }

      if (JavaScript) {
        const jsParser = new Parser();
        try {
          jsParser.setLanguage(JavaScript);
          this.parsers.set('javascript', jsParser);
        } catch (error) {
          console.warn('Failed to initialize JavaScript parser:', error);
        }
      }

      if (Python) {
        const pyParser = new Parser();
        try {
          pyParser.setLanguage(Python);
          this.parsers.set('python', pyParser);
        } catch (error) {
          console.warn('Failed to initialize Python parser:', error);
        }
      }
    } catch (error) {
      console.warn('Failed to initialize some tree-sitter parsers:', error);
    }
  }

  async parseAndChunk(
    content: string,
    language: string,
    filePath: string
  ): Promise<{
    chunks: CodeChunk[];
    symbols: CodeSymbol[];
    xrefs: CodeXRef[];
  }> {
    // Validate input parameters
    if (!content || typeof content !== 'string') {
      console.warn(`Invalid content for parsing ${filePath}, using fallback`);
      const chunks = this.fallbackChunking(content || '', filePath);
      return { chunks, symbols: [], xrefs: [] };
    }

    if (!language || typeof language !== 'string') {
      console.warn(`Invalid language for parsing ${filePath}, using fallback`);
      const chunks = this.fallbackChunking(content, filePath);
      return { chunks, symbols: [], xrefs: [] };
    }

    const parser = this.parsers.get(language);
    if (!parser) {
      console.warn(`No parser available for language ${language} in ${filePath}, using fallback`);
      const chunks = this.fallbackChunking(content, filePath);
      return { chunks, symbols: [], xrefs: [] };
    }

    try {
      // Additional validation before parsing
      if (content.length === 0) {
        console.warn(`Empty content for parsing ${filePath}, using fallback`);
        const chunks = this.fallbackChunking(content, filePath);
        return { chunks, symbols: [], xrefs: [] };
      }

      // Check for problematic content that can cause Tree-sitter to fail
      const hasNullBytes = content.includes('\0');
      const hasInvalidChars = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(content);
      const isTooLarge = content.length > 1024 * 1024; // 1MB limit for safety

      if (hasNullBytes || hasInvalidChars || isTooLarge) {
        console.warn(
          `Problematic content detected in ${filePath} (${hasNullBytes ? 'null bytes' : ''} ${hasInvalidChars ? 'invalid chars' : ''} ${isTooLarge ? 'too large' : ''}), using fallback`
        );
        const chunks = this.fallbackChunking(content, filePath);
        return { chunks, symbols: [], xrefs: [] };
      }

      // Additional content validation - check for incomplete/truncated content
      const trimmedContent = content.trim();
      if (trimmedContent.length === 0) {
        console.warn(`Content is only whitespace for ${filePath}, using fallback`);
        const chunks = this.fallbackChunking(content, filePath);
        return { chunks, symbols: [], xrefs: [] };
      }

      // Check for obviously invalid syntax patterns that can crash Tree-sitter
      const openBraces = (content.match(/\{/g) || []).length;
      const closeBraces = (content.match(/\}/g) || []).length;
      if (Math.abs(openBraces - closeBraces) > 100) {
        console.warn(
          `Highly unbalanced braces in ${filePath}, likely invalid syntax, using fallback`
        );
        const chunks = this.fallbackChunking(content, filePath);
        return { chunks, symbols: [], xrefs: [] };
      }

      let tree;
      try {
        // Attempt to parse with a timeout safeguard
        tree = parser.parse(content);
      } catch (parseError) {
        const errorMessage = parseError instanceof Error ? parseError.message : String(parseError);
        if (
          errorMessage.includes('Invalid argument') ||
          errorMessage.includes('parse') ||
          errorMessage.includes('invalid')
        ) {
          console.warn(`Tree-sitter parse error for ${filePath}: ${errorMessage}, using fallback`);
          const chunks = this.fallbackChunking(content, filePath);
          return { chunks, symbols: [], xrefs: [] };
        }
        throw parseError; // Re-throw if it's not a parsing error we can handle
      }

      // Validate the parsed tree
      if (!tree || !tree.rootNode) {
        console.warn(`Invalid parse tree for ${filePath}, using fallback`);
        const chunks = this.fallbackChunking(content, filePath);
        return { chunks, symbols: [], xrefs: [] };
      }

      // Validate root node
      if (!tree.rootNode || tree.rootNode.type !== 'program') {
        console.warn(
          `Unexpected root node type in ${filePath}: ${tree.rootNode?.type}, using fallback`
        );
        const chunks = this.fallbackChunking(content, filePath);
        return { chunks, symbols: [], xrefs: [] };
      }

      const chunks = this.extractChunks(tree, content, language);
      const symbols = this.extractSymbols(tree, content, language);
      const xrefs = this.extractXRefs(tree, language);
      return { chunks, symbols, xrefs };
    } catch (error) {
      console.error(`Tree-sitter processing failed for ${filePath}:`, error);
      const chunks = this.fallbackChunking(content, filePath);
      return { chunks, symbols: [], xrefs: [] };
    }
  }

  private extractChunks(tree: any, content: string, language: string): CodeChunk[] {
    const chunks: CodeChunk[] = [];
    const lines = content.split('\n');

    const traverse = (node: any) => {
      try {
        if (this.isChunkableNode(node, language)) {
          const startLine = node.startPosition?.row + 1;
          const endLine = node.endPosition?.row + 1;

          if (startLine && endLine && startLine <= endLine) {
            const nodeContent = this.getNodeContent(node, lines);

            if (nodeContent && (endLine - startLine > 10 || nodeContent.length > 100)) {
              chunks.push({
                content: nodeContent,
                startLine,
                endLine,
                tokenEstimate: this.estimateTokens(nodeContent),
                symbolName: this.getSymbolName(node),
                symbolType: node.type,
              });
            }
          }
        }

        // Safely traverse children
        if (node.children && Array.isArray(node.children)) {
          for (const child of node.children) {
            if (child) {
              traverse(child);
            }
          }
        }
      } catch (error) {
        console.warn(`Error traversing node in ${language}:`, error);
        // Continue with other nodes
      }
    };

    try {
      if (tree?.rootNode) {
        traverse(tree.rootNode);
      }
    } catch (error) {
      console.warn(`Error extracting chunks from tree:`, error);
    }

    if (chunks.length === 0) {
      return this.fallbackChunking(content, '');
    }

    return chunks;
  }

  private isChunkableNode(node: any, language: string): boolean {
    try {
      if (!node || !node.type) return false;

      if (language === 'typescript' || language === 'javascript') {
        return [
          'function_declaration',
          'method_definition',
          'arrow_function',
          'class_declaration',
          'interface_declaration',
          'type_alias_declaration',
          'export_statement',
        ].includes(node.type);
      }

      if (language === 'python') {
        return ['function_definition', 'class_definition', 'decorated_definition'].includes(
          node.type
        );
      }

      return false;
    } catch (error) {
      console.warn(`Error checking if node is chunkable:`, error);
      return false;
    }
  }

  private getNodeContent(node: any, lines: string[]): string {
    try {
      if (!node || !node.startPosition || !node.endPosition || !Array.isArray(lines)) {
        return '';
      }

      const startLine = node.startPosition.row;
      const endLine = node.endPosition.row;

      if (
        typeof startLine !== 'number' ||
        typeof endLine !== 'number' ||
        startLine < 0 ||
        endLine < startLine ||
        endLine >= lines.length
      ) {
        return '';
      }

      return lines.slice(startLine, endLine + 1).join('\n');
    } catch (error) {
      console.warn(`Error getting node content:`, error);
      return '';
    }
  }

  private getSymbolName(node: any): string | undefined {
    try {
      if (!node || !Array.isArray(node.children)) return undefined;
      const nameNode = node.children.find(
        (child: any) =>
          child && (child.type === 'identifier' || child.type === 'property_identifier')
      );
      return nameNode?.text;
    } catch (error) {
      console.warn(`Error getting symbol name:`, error);
      return undefined;
    }
  }

  private fallbackChunking(content: string, filePath: string): CodeChunk[] {
    // If content is completely empty or only whitespace, create minimal chunk
    const trimmedContent = content.trim();
    if (trimmedContent.length === 0) {
      return [
        {
          content: '',
          startLine: 1,
          endLine: 1,
          tokenEstimate: 0,
          symbolName: 'empty_file',
          symbolType: 'fallback',
        },
      ];
    }

    const lines = content.split('\n');
    const chunks: CodeChunk[] = [];
    const chunkSize = 50;

    for (let i = 0; i < lines.length; i += chunkSize) {
      const endIndex = Math.min(i + chunkSize, lines.length);
      const chunkContent = lines.slice(i, endIndex).join('\n');

      chunks.push({
        content: chunkContent,
        startLine: i + 1,
        endLine: endIndex,
        tokenEstimate: this.estimateTokens(chunkContent),
      });
    }

    return chunks;
  }

  private estimateTokens(content: string): number {
    return Math.ceil(content.length / 4);
  }

  private extractSymbols(tree: any, content: string, language: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = [];
    const lines = content.split('\n');

    const traverse = (node: any) => {
      if (this.isSymbolNode(node, language)) {
        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        const nodeContent = this.getNodeContent(node, lines);
        const symbolName = this.getSymbolName(node);

        if (symbolName) {
          symbols.push({
            name: symbolName,
            kind: node.type,
            startLine,
            endLine,
            lang: language,
            source: nodeContent,
          });
        }
      }

      for (const child of node.children) {
        traverse(child);
      }
    };

    traverse(tree.rootNode);
    return symbols;
  }

  private isSymbolNode(node: any, language: string): boolean {
    if (language === 'typescript' || language === 'javascript') {
      return [
        'function_declaration',
        'function_expression',
        'arrow_function',
        'class_declaration',
        'interface_declaration',
        'type_alias_declaration',
        'variable_declarator',
        'method_definition',
        'property_definition',
      ].includes(node.type);
    }

    if (language === 'python') {
      return [
        'function_definition',
        'class_definition',
        'decorated_definition',
        'assignment',
      ].includes(node.type);
    }

    return false;
  }

  private extractXRefs(tree: any, language: string): CodeXRef[] {
    const xrefs: CodeXRef[] = [];
    if (language !== 'typescript' && language !== 'javascript') {
      return xrefs;
    }

    const traverse = (node: any) => {
      if (node.type === 'import_statement' || node.type === 'export_statement') {
        const kind = node.type === 'import_statement' ? 'import' : 'export';
        const pathNode = node.descendantsOfType('string_literal')[0];
        const targetPath = pathNode?.text.slice(1, -1);

        const importClause = node.descendantsOfType('import_clause')[0];
        if (importClause) {
          const namedImports = importClause.descendantsOfType('named_imports')[0];
          if (namedImports) {
            for (const specifier of namedImports.descendantsOfType('import_specifier')) {
              xrefs.push({
                name: specifier.text,
                kind,
                startLine: specifier.startPosition.row + 1,
                endLine: specifier.endPosition.row + 1,
                targetPath,
              });
            }
          }
        }
      }

      for (const child of node.children) {
        traverse(child);
      }
    };

    traverse(tree.rootNode);
    return xrefs;
  }
}
