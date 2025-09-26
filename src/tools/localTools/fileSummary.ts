/**
 * @fileOverview: Local file summary tool for AST-based file analysis
 * @module: FileSummary
 * @keyFunctions:
 *   - localFileSummaryTool: Tool definition for file analysis
 *   - handleFileSummary(): Handler for file summary requests
 *   - getComprehensiveASTAnalysis(): Comprehensive AST analysis without filtering
 *   - extractAllFunctions(): Extract all functions from file
 *   - getLanguageFromPath(): Determine language from file extension
 * @context: Provides detailed file analysis with symbol extraction and complexity calculation
 */

import * as path from 'path';
import { SemanticCompactor } from '../../core/compactor/semanticCompactor';
import { logger } from '../../utils/logger';
import { validateAndResolvePath } from '../utils/pathUtils';
import { formatFileSummaryOutput } from './formatters/fileSummaryFormatters';
import { generateQuickFileAnalysis } from './formatters/fileSummaryFormatters';
import { handleNonCodeFile, extractFileHeader } from './analyzers/fileAnalyzers';
import { calculateCyclomaticComplexity } from './analyzers/complexityAnalysis';

/**
 * Lightweight type resolution that maps AST node kinds to readable identifiers
 */
function resolveTypeFromAST(signature: string): string {
  if (!signature) return signature;

  // Map common AST node kinds to readable types
  const typeMappings: Record<string, string> = {
    TSTypeReference: 'Type',
    TSStringKeyword: 'string',
    TSNumberKeyword: 'number',
    TSBooleanKeyword: 'boolean',
    TSVoidKeyword: 'void',
    TSUndefinedKeyword: 'undefined',
    TSNullKeyword: 'null',
    TSAnyKeyword: 'any',
    TSUnknownKeyword: 'unknown',
    TSNeverKeyword: 'never',
    TSObjectKeyword: 'object',
    TSSymbolKeyword: 'symbol',
    TSBigIntKeyword: 'bigint',
    TSArrayType: 'Array',
    TSTupleType: 'Tuple',
    TSUnionType: 'Union',
    TSIntersectionType: 'Intersection',
    TSFunctionType: 'Function',
    TSMethodSignature: 'Method',
    TSPropertySignature: 'Property',
    TSIndexSignature: 'Index',
    TSConstructSignature: 'Constructor',
    TSCallSignature: 'Call',
    TSInterfaceDeclaration: 'Interface',
    TSClassDeclaration: 'Class',
    TSEnumDeclaration: 'Enum',
    TSTypeAliasDeclaration: 'TypeAlias',
    TSModuleDeclaration: 'Module',
    TSInterfaceBody: 'InterfaceBody',
    TSClassBody: 'ClassBody',
    TSModuleBody: 'ModuleBody',
    TSParameterProperty: 'Parameter',
    TSPropertyDeclaration: 'Property',
    TSMethodDeclaration: 'Method',
    TSConstructorDeclaration: 'Constructor',
    TSGetAccessor: 'Getter',
    TSSetAccessor: 'Setter',
  };

  let resolvedSignature = signature;

  // Replace AST node kinds with readable equivalents
  for (const [astKind, readableType] of Object.entries(typeMappings)) {
    resolvedSignature = resolvedSignature.replace(new RegExp(astKind, 'g'), readableType);
  }

  // Handle common patterns that might not be caught
  resolvedSignature = resolvedSignature
    .replace(/TS\((\w+)\)/g, '$1') // Remove TS() wrapper
    .replace(/TS/g, '') // Remove TS prefix from remaining types
    .replace(/TypeType/g, 'Type') // Fix double Type
    .replace(/ArrayArray/g, 'Array') // Fix double Array
    .replace(/FunctionFunction/g, 'Function'); // Fix double Function

  return resolvedSignature;
}

/**
 * Tool definition for local file summary
 */
export const localFileSummaryTool = {
  name: 'local_file_summary',
  description:
    '📄 Get quick AST-based summary and key symbols for any file. Fast file analysis without external dependencies. Accepts absolute paths or relative paths (when workspace can be detected).',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description:
          'File path for analysis. Can be absolute (recommended) or relative to workspace. Examples: "C:\\Dev\\my-project\\src\\index.ts", "/Users/username/project/src/index.ts", or "src/index.ts".',
      },
      includeSymbols: {
        type: 'boolean',
        default: true,
        description: 'Include detailed symbol information',
      },
      maxSymbols: {
        type: 'number',
        default: 20,
        minimum: 5,
        maximum: 50,
        description: 'Maximum number of symbols to return',
      },
      format: {
        type: 'string',
        enum: ['xml', 'structured', 'compact'],
        default: 'structured',
        description: 'Output format preference',
      },
    },
    required: ['filePath'],
  },
};

/**
 * Handler for file summary requests
 */
export async function handleFileSummary(args: any): Promise<any> {
  const { filePath, includeSymbols = true, maxSymbols = 20, format = 'structured' } = args;

  // Validate that filePath is provided and is absolute
  if (!filePath) {
    throw new Error('❌ filePath is required. Please provide an absolute path to the file.');
  }
  const resolvedFilePath = validateAndResolvePath(filePath, 'filePath');
  const projectPath = path.dirname(resolvedFilePath);

  logger.info('📄 Analyzing file', {
    originalPath: filePath,
    resolvedPath: resolvedFilePath,
    projectPath,
    includeSymbols,
    maxSymbols,
  });

  try {
    const language = getLanguageFromPath(filePath);

    // Check if this is a non-code file that doesn't need AST analysis
    if (
      language === 'json' ||
      language === 'markdown' ||
      language === 'yaml' ||
      language === 'toml' ||
      language === 'text'
    ) {
      return await handleNonCodeFile(
        resolvedFilePath,
        language,
        format,
        includeSymbols,
        maxSymbols
      );
    }

    // Use semantic compactor for single file analysis
    const compactor = new SemanticCompactor(projectPath);

    // 🔑 Get comprehensive analysis directly from AST (bypass semantic compactor filtering)
    const astAnalysis = await getComprehensiveASTAnalysis(resolvedFilePath);

    // Get semantic compactor results for comparison (but don't rely on them for symbol count)
    const nodes = await compactor.getSummary(resolvedFilePath);

    // Debug: Log the AST analysis results
    logger.debug('🔍 AST Analysis Results', {
      filePath: resolvedFilePath,
      totalSymbols: astAnalysis.totalSymbols,
      functions: astAnalysis.allFunctions.length,
      classes: astAnalysis.allClasses.length,
      interfaces: astAnalysis.allInterfaces.length,
      exportedSymbols: astAnalysis.exportedSymbols.length,
      topSymbols: astAnalysis.topSymbols.length,
      sampleFunctions: astAnalysis.allFunctions.slice(0, 3).map(f => ({ name: f.name, type: f.type, line: f.line })),
      sampleClasses: astAnalysis.allClasses.slice(0, 3).map(c => ({ name: c.name, type: c.type, line: c.line })),
    });

    // Force use the actual AST analysis results instead of semantic compactor
    logger.info('🔧 Using AST analysis results directly', {
      symbolCount: astAnalysis.totalSymbols,
      functions: astAnalysis.allFunctions.length,
      classes: astAnalysis.allClasses.length,
    });

    // Extract file header information
    const fileHeader = await extractFileHeader(resolvedFilePath);

    // Calculate cyclomatic complexity
    let complexityData = {
      rating: 'low',
      description: 'Simple code',
      totalComplexity: 1,
      decisionPoints: 0,
      breakdown: {},
    };
    try {
      const fs = await import('fs');
      const fileContent = await fs.promises.readFile(resolvedFilePath, 'utf8');
      complexityData = calculateCyclomaticComplexity(fileContent);
    } catch (error) {
      // Fallback to simple symbol-based complexity if file reading fails
      complexityData.rating =
        astAnalysis.totalSymbols > 50 ? 'high' : astAnalysis.totalSymbols > 20 ? 'medium' : 'low';
      complexityData.description = `Based on ${astAnalysis.totalSymbols} symbols`;
    }

    // Clean up resources
    compactor.dispose();

    const summary = {
      file: filePath,
      exists: astAnalysis.totalSymbols > 0,
      symbolCount: astAnalysis.totalSymbols, // 🔑 Use actual AST symbol count
      fileHeader: fileHeader,
      allFunctions: astAnalysis.allFunctions,
      exportedSymbols: astAnalysis.exportedSymbols,
      allClasses: astAnalysis.allClasses, // 🔑 Add class information
      allInterfaces: astAnalysis.allInterfaces, // 🔑 Add interface information
      symbols: includeSymbols
        ? astAnalysis.topSymbols.slice(0, maxSymbols) // 🔑 Use better symbol selection
        : [],
      complexity: complexityData.rating,
      complexityData: complexityData, // 🔑 Add detailed complexity information
      language: getLanguageFromPath(filePath),
    };

    const quickAnalysis = generateQuickFileAnalysis(summary);

    // Format the output based on preference
    const formattedSummary = formatFileSummaryOutput(summary, quickAnalysis, format);

    logger.info('✅ File analysis completed', {
      symbolCount: summary.symbolCount,
      complexity: summary.complexity,
    });

    return {
      success: true,
      summary: formattedSummary,
      quickAnalysis,
      metadata: {
        format,
        symbolCount: summary.symbolCount,
        complexity: summary.complexity,
        language: summary.language,
      },
      usage: `Found ${summary.symbolCount} symbols with ${summary.complexity} complexity`,
    };
  } catch (error) {
    logger.error('❌ File analysis failed', {
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      fallback: `Could not analyze ${filePath}. File may not exist, be too large, or contain unsupported language.`,
      suggestion: 'Try local_project_hints to understand the overall project structure instead.',
    };
  }
}

/**
 * Get language from file path extension
 */
export function getLanguageFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const languageMap: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.cpp': 'cpp',
    '.c': 'c',
    '.c++': 'cpp',
    '.c#': 'csharp',
    '.cs': 'csharp',
    '.java': 'java',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.swift': 'swift',
    '.dart': 'dart',
    '.h': 'c',
    '.hpp': 'cpp',
    '.php': 'php',
    '.html': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.sass': 'sass',
    '.less': 'less',
    '.json': 'json',
    '.md': 'markdown',
    '.txt': 'text',
    '.xml': 'xml',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.toml': 'toml',
    '.ini': 'ini',
    '.rb': 'ruby',
  };
  return languageMap[ext] || 'unknown';
}

/**
 * Extract all functions (standalone and class methods) directly from AST
 */
export async function extractAllFunctions(filePath: string): Promise<any[]> {
  try {
    const { ASTParser } = await import('../../core/compactor/astParser');

    const language = getLanguageFromPath(filePath) as any;
    const parser = new ASTParser();

    // Parse the file to get all symbols including class methods
    const parsedFile = await parser.parseFile(filePath, language);

    // Extract all function-like symbols (functions, methods, arrow functions)
    const allFunctions: any[] = [];

    for (const symbol of parsedFile.symbols) {
      if (symbol.type === 'function') {
        allFunctions.push({
          name: symbol.name,
          signature: resolveTypeFromAST(symbol.signature),
          line: symbol.startLine,
          isAsync: symbol.isAsync || symbol.signature.includes('async'),
          isExported: symbol.isExported,
          isMethod: false,
          className: undefined,
          parameters: extractParametersFromSignature(symbol.signature),
          returnType: resolveTypeFromAST(symbol.returnType || ''),
          returnedSymbols: extractReturnedSymbols(symbol.body),
          purpose: 'Function',
        });
      } else if (symbol.type === 'method') {
        // Handle individual method symbols with full signatures
        allFunctions.push({
          name: symbol.name,
          signature: resolveTypeFromAST(symbol.signature),
          line: symbol.startLine,
          isAsync: symbol.isAsync || false,
          isExported: symbol.isExported,
          isMethod: true,
          className: symbol.className,
          parameters: symbol.parameters || extractParametersFromSignature(symbol.signature),
          returnType: resolveTypeFromAST(symbol.returnType || ''),
          returnedSymbols: extractReturnedSymbols(symbol.body),
          purpose: 'Method',
        });
      } else if (symbol.type === 'class') {
        // Class symbols are handled in getComprehensiveASTAnalysis - skip here since we're only extracting functions
        // Methods are now handled separately as individual 'method' symbols
      }
    }

    parser.dispose();
    return allFunctions;
  } catch (error) {
    logger.warn('Failed to extract functions from AST', {
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Get comprehensive AST analysis without semantic compactor filtering
 */
export async function getComprehensiveASTAnalysis(filePath: string): Promise<{
  totalSymbols: number;
  allFunctions: any[];
  allClasses: any[];
  allInterfaces: any[];
  exportedSymbols: string[];
  topSymbols: any[];
}> {
  try {
    const { ASTParser } = await import('../../core/compactor/astParser');
    const language = getLanguageFromPath(filePath) as any;
    const parser = new ASTParser();

    const parsedFile = await parser.parseFile(filePath, language);

    // Extract all functions (including class methods)
    const allFunctions: any[] = [];
    const allClasses: any[] = [];
    const allInterfaces: any[] = [];
    const exportedSymbols: string[] = [];

    // Process symbols
    for (const symbol of parsedFile.symbols) {
      if (symbol.type === 'function') {
        allFunctions.push({
          name: symbol.name,
          signature: resolveTypeFromAST(symbol.signature),
          line: symbol.startLine,
          isAsync: symbol.isAsync || symbol.signature.includes('async'),
          isExported: symbol.isExported,
          isMethod: false,
          className: undefined,
          parameters: extractParametersFromSignature(symbol.signature),
          returnType: resolveTypeFromAST(symbol.returnType || ''),
          returnedSymbols: extractReturnedSymbols(symbol.body),
          purpose: 'Function',
        });
      } else if (symbol.type === 'method') {
        // Handle individual method symbols with full signatures
        allFunctions.push({
          name: symbol.name,
          signature: resolveTypeFromAST(symbol.signature),
          line: symbol.startLine,
          isAsync: symbol.isAsync || false,
          isExported: symbol.isExported,
          isMethod: true,
          className: symbol.className,
          parameters: symbol.parameters || extractParametersFromSignature(symbol.signature),
          returnType: resolveTypeFromAST(symbol.returnType || ''),
          returnedSymbols: extractReturnedSymbols(symbol.body),
          purpose: 'Method',
        });
      } else if (symbol.type === 'class') {
        allClasses.push({
          name: symbol.name,
          line: symbol.startLine,
          isExported: symbol.isExported,
          signature: resolveTypeFromAST(symbol.signature),
          methods:
            symbol.body && symbol.body.startsWith('Methods:')
              ? symbol.body
                  .replace('Methods:', '')
                  .trim()
                  .split(',')
                  .map(m => m.trim())
                  .filter(m => m && m !== 'constructor')
              : [],
        });
      } else if (symbol.type === 'interface') {
        allInterfaces.push({
          name: symbol.name,
          line: symbol.startLine,
          signature: resolveTypeFromAST(symbol.signature),
          purpose: 'Type definition',
        });
      }

      // Collect exported symbols
      if (symbol.isExported && !exportedSymbols.includes(symbol.name)) {
        exportedSymbols.push(symbol.name);
      }
    } // Close the for loop

    // Add exports from export statements
    if (parsedFile.exports) {
      parsedFile.exports.forEach(exportStmt => {
        if (exportStmt.name && !exportedSymbols.includes(exportStmt.name)) {
          exportedSymbols.push(exportStmt.name);
        }
      });
    }

    // Create top symbols list (prioritize important symbols)
    const topSymbols: any[] = [];

    // Add classes first (most important)
    allClasses.forEach(cls => {
      topSymbols.push({
        name: cls.name,
        type: 'class',
        line: cls.line,
        purpose: 'Core class',
        signature:
          resolveTypeFromAST(cls.signature).substring(0, 100) +
          (cls.signature.length > 100 ? '...' : ''),
      });
    });

    // Add interfaces
    allInterfaces.forEach(iface => {
      topSymbols.push({
        name: iface.name,
        type: 'interface',
        line: iface.line,
        purpose: iface.purpose,
        signature:
          resolveTypeFromAST(iface.signature).substring(0, 100) +
          (iface.signature.length > 100 ? '...' : ''),
      });
    });

    // Add some key functions (exported first)
    const keyFunctions = allFunctions
      .filter(f => !f.isMethod) // Only standalone functions
      .sort((a, b) => (b.isExported ? 1 : 0) - (a.isExported ? 1 : 0))
      .slice(0, 5);

    keyFunctions.forEach(func => {
      topSymbols.push({
        name: func.name,
        type: 'function',
        line: func.line,
        purpose: func.purpose,
        signature:
          resolveTypeFromAST(func.signature).substring(0, 100) +
          (func.signature.length > 100 ? '...' : ''),
      });
    });

    parser.dispose();

    return {
      totalSymbols: parsedFile.symbols.length,
      allFunctions,
      allClasses,
      allInterfaces,
      exportedSymbols,
      topSymbols,
    };
  } catch (error) {
    logger.warn('Failed to get comprehensive AST analysis', {
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      totalSymbols: 0,
      allFunctions: [],
      allClasses: [],
      allInterfaces: [],
      exportedSymbols: [],
      topSymbols: [],
    };
  }
}

/**
 * Extract symbols that are returned from function body
 */
export function extractReturnedSymbols(functionBody: string | undefined): string[] {
  if (!functionBody) return [];

  try {
    const returnedSymbols: string[] = [];

    // Match return statements
    const returnMatches = functionBody.match(/return\s+([^;}\n]+)/g);

    if (returnMatches) {
      returnMatches.forEach(returnStmt => {
        // Clean up the return statement
        const returnValue = returnStmt.replace(/^return\s+/, '').trim();

        // Extract object returns like { success: true, data: result }
        if (returnValue.startsWith('{') && returnValue.includes(':')) {
          const objectMatches = returnValue.match(/(\w+):/g);
          if (objectMatches) {
            objectMatches.forEach(match => {
              const key = match.replace(':', '').trim();
              if (key && !returnedSymbols.includes(key)) {
                returnedSymbols.push(key);
              }
            });
          }
        }

        // Extract simple variable returns
        const simpleVarMatch = returnValue.match(/^(\w+)(\s*[;,}]|$)/);
        if (simpleVarMatch) {
          const varName = simpleVarMatch[1];
          if (
            varName &&
            !['true', 'false', 'null', 'undefined'].includes(varName) &&
            !returnedSymbols.includes(varName)
          ) {
            returnedSymbols.push(varName);
          }
        }

        // Extract function calls like return someFunction()
        const funcCallMatch = returnValue.match(/^(\w+)\s*\(/);
        if (funcCallMatch) {
          const funcName = funcCallMatch[1];
          if (funcName && !returnedSymbols.includes(funcName)) {
            returnedSymbols.push(`${funcName}()`);
          }
        }

        // Extract property access like return this.property
        const propMatch = returnValue.match(/^(\w+)\.(\w+)/);
        if (propMatch) {
          const propAccess = `${propMatch[1]}.${propMatch[2]}`;
          if (!returnedSymbols.includes(propAccess)) {
            returnedSymbols.push(propAccess);
          }
        }
      });
    }

    return returnedSymbols.slice(0, 5); // Limit to first 5 returned symbols
  } catch (error) {
    return [];
  }
}

/**
 * Extract parameters from function signature
 */
export function extractParametersFromSignature(signature: string): string[] {
  try {
    // Match function parameters between parentheses
    const paramMatch = signature.match(/\(([^)]*)\)/);
    if (!paramMatch || !paramMatch[1].trim()) {
      return [];
    }

    const paramString = paramMatch[1].trim();
    if (paramString === '') return [];

    // Split by comma but be careful of nested types
    const params = [];
    let current = '';
    let depth = 0;

    for (let i = 0; i < paramString.length; i++) {
      const char = paramString[i];
      if (char === ',' && depth === 0) {
        params.push(current.trim());
        current = '';
      } else {
        if (char === '(' || char === '<') depth++;
        if (char === ')' || char === '>') depth--;
        current += char;
      }
    }

    if (current.trim()) {
      params.push(current.trim());
    }

    return params.filter(p => p.length > 0);
  } catch (error) {
    return [];
  }
}
