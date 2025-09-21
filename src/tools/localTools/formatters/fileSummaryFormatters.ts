/**
 * @fileOverview: File summary output formatters for AST-based file analysis
 * @module: FileSummaryFormatters
 * @keyFunctions:
 *   - formatFileSummaryOutput(): Main formatter dispatcher
 *   - formatFileSummaryAsXML(): XML format for structured data exchange
 *   - formatFileSummaryAsStructured(): Markdown format for human readability
 *   - formatFileSummaryAsCompact(): Minimal format for space-constrained environments
 * @context: Provides multiple output formats for file analysis results
 */

import * as path from 'path';
import { escapeXml } from './contextFormatters';

/**
 * Main formatter dispatcher for file summary output
 */
export function formatFileSummaryOutput(
  summary: any,
  quickAnalysis: string,
  format: string
): string {
  switch (format) {
    case 'xml':
      return formatFileSummaryAsXML(summary, quickAnalysis);
    case 'structured':
      return formatFileSummaryAsStructured(summary, quickAnalysis);
    case 'compact':
      return formatFileSummaryAsCompact(summary, quickAnalysis);
    default:
      return formatFileSummaryAsStructured(summary, quickAnalysis);
  }
}

/**
 * Format file summary as XML for structured data exchange
 */
export function formatFileSummaryAsXML(summary: any, quickAnalysis: string): string {
  const headerXml =
    summary.fileHeader && summary.fileHeader.content
      ? `  <file_header>
    <type>${summary.fileHeader.type}</type>
    <line_count>${summary.fileHeader.lineCount}</line_count>
    <content><![CDATA[${summary.fileHeader.content}]]></content>
  </file_header>`
      : '';

  const functionsXml =
    summary.allFunctions && summary.allFunctions.length > 0
      ? `  <functions>
    ${summary.allFunctions
      .map(
        (func: any) => `
    <function>
      <name>${escapeXml(func.name)}</name>
      <line>${func.line}</line>
      <is_async>${func.isAsync}</is_async>
      <is_exported>${func.isExported}</is_exported>
      <parameter_count>${func.parameters.length}</parameter_count>
      <signature>${escapeXml(func.signature)}</signature>
    </function>`
      )
      .join('')}
  </functions>`
      : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<file_summary>
  <metadata>
    <file_path>${escapeXml(summary.file)}</file_path>
    <exists>${summary.exists}</exists>
    <language>${summary.language}</language>
    <complexity>${summary.complexity}</complexity>
    <symbol_count>${summary.symbolCount}</symbol_count>
    <function_count>${summary.allFunctions ? summary.allFunctions.length : 0}</function_count>
    ${
      summary.complexityData
        ? `<cyclomatic_complexity>
      <total>${summary.complexityData.totalComplexity}</total>
      <decision_points>${summary.complexityData.decisionPoints}</decision_points>
      <rating>${summary.complexityData.rating}</rating>
      <description><![CDATA[${summary.complexityData.description}]]></description>
    </cyclomatic_complexity>`
        : ''
    }
  </metadata>
  <quick_analysis>${escapeXml(quickAnalysis)}</quick_analysis>${headerXml}${functionsXml}
  <symbols>
    ${summary.symbols
      .map(
        (symbol: any) => `
    <symbol>
      <name>${escapeXml(symbol.name)}</name>
      <type>${escapeXml(symbol.type)}</type>
      <line>${symbol.line}</line>
      <purpose>${escapeXml(symbol.purpose || '')}</purpose>
      <signature>${escapeXml(symbol.signature)}</signature>
    </symbol>`
      )
      .join('')}
  </symbols>
</file_summary>`;
}

/**
 * Format file summary as structured markdown for human readability
 */
export function formatFileSummaryAsStructured(summary: any, quickAnalysis: string): string {
  // Group symbols by type for better organization
  const symbolsByType = summary.symbols.reduce((acc: any, symbol: any) => {
    if (!acc[symbol.type]) acc[symbol.type] = [];
    acc[symbol.type].push(symbol);
    return acc;
  }, {});

  // Prioritize symbol types for display
  const typeOrder = ['class', 'interface', 'function', 'export', 'import', 'variable', 'type'];
  const orderedTypes = typeOrder.filter(type => symbolsByType[type]);

  // Build file header section
  let headerSection = '';
  if (summary.fileHeader && summary.fileHeader.content) {
    const headerType =
      summary.fileHeader.type === 'comment' ? '📝 File Documentation' : '🔍 File Preview';
    headerSection = `
## ${headerType} (${summary.fileHeader.lineCount} lines)
\`\`\`
${summary.fileHeader.content}
\`\`\`
`;
  }

  return `# 📄 File Analysis: ${path.basename(summary.file)}

## File Information
- **Path:** ${summary.file}
- **Language:** ${summary.language}
- **Complexity:** ${summary.complexity}${summary.complexityData ? ` (CC: ${summary.complexityData.totalComplexity}, ${summary.complexityData.description})` : ''}
- **Symbol Count:** ${summary.symbolCount}
- **Exists:** ${summary.exists ? 'Yes' : 'No'}

## Quick Analysis
${quickAnalysis}${headerSection}

## 🏗️ Classes (${summary.allClasses ? summary.allClasses.length : 0})
${
  summary.allClasses && summary.allClasses.length > 0
    ? summary.allClasses
        .map(
          (cls: any) => `
### ${cls.name} ${cls.isExported ? '📤' : '🔒'}
- **Line:** ${cls.line}
- **Methods:** ${cls.methods.length > 0 ? cls.methods.join(', ') : 'None'}
- **Exported:** ${cls.isExported ? 'Yes' : 'No'}
`
        )
        .join('')
    : '_No classes found._'
}

## 🔧 Interface Definitions (${summary.allInterfaces ? summary.allInterfaces.length : 0})
${
  summary.allInterfaces && summary.allInterfaces.length > 0
    ? summary.allInterfaces
        .map(
          (iface: any) => `
### ${iface.name}
- **Line:** ${iface.line}
- **Purpose:** ${iface.purpose}
`
        )
        .join('')
    : '_No interfaces found._'
}

## 🔧 Function Definitions (${summary.allFunctions.length})
${
  summary.allFunctions.length > 0
    ? formatFunctionDefinitions(summary.allFunctions)
    : '_No functions found in this file._'
}

## 📤 Module Exports (${summary.exportedSymbols ? summary.exportedSymbols.length : 0})
${
  summary.exportedSymbols && summary.exportedSymbols.length > 0
    ? `This module exports: \`${summary.exportedSymbols.join('`, `')}\``
    : '_No exported symbols found._'
}

${
  summary.complexityData && summary.complexityData.decisionPoints > 0
    ? `
## 📊 Complexity Analysis
- **Cyclomatic Complexity:** ${summary.complexityData.totalComplexity}
- **Decision Points:** ${summary.complexityData.decisionPoints}
- **Rating:** ${summary.complexityData.rating} - ${summary.complexityData.description}
`
    : ''
}

## 📋 Key Symbols (${summary.symbols.length})
${orderedTypes
  .map(type => {
    const symbols = symbolsByType[type];
    return `
### ${type.charAt(0).toUpperCase() + type.slice(1)} Symbols (${symbols.length})
${symbols
  .map(
    (symbol: any) => `
#### ${symbol.name}
- **Line:** ${symbol.line}
- **Purpose:** ${classifySymbolPurpose(symbol)}
- **Signature:** \`${symbol.signature}\`${symbol.type === 'function' && symbol.signature.includes('async') ? ' (async)' : ''}
`
  )
  .join('')}`;
  })
  .join('')}

---
*End of AST-based analysis*`;
}

/**
 * Format file summary in compact format for space-constrained environments
 */
export function formatFileSummaryAsCompact(summary: any, quickAnalysis: string): string {
  const topSymbols = summary.symbols
    .slice(0, 5)
    .map((s: any) => `${s.name}(${s.type})`)
    .join(', ');
  const headerInfo =
    summary.fileHeader && summary.fileHeader.content
      ? `\nHEADER: ${summary.fileHeader.type} (${summary.fileHeader.lineCount} lines)`
      : '';
  const functionsInfo =
    summary.allFunctions && summary.allFunctions.length > 0
      ? `\nFUNCTIONS: ${summary.allFunctions.length} total (${summary.allFunctions.filter((f: any) => f.isExported).length} exported, ${summary.allFunctions.filter((f: any) => f.isAsync).length} async)`
      : '';

  const complexityInfo = summary.complexityData
    ? ` | CC: ${summary.complexityData.totalComplexity} (${summary.complexityData.decisionPoints} decision points)`
    : '';

  return `FILE: ${summary.file} | LANG: ${summary.language} | COMPLEXITY: ${summary.complexity}${complexityInfo} | SYMBOLS: ${summary.symbolCount}
ANALYSIS: ${quickAnalysis}${headerInfo}${functionsInfo}
TOP_SYMBOLS: ${topSymbols}`;
}

/**
 * Classify symbol purpose based on name and type patterns
 */
export function classifySymbolPurpose(symbol: any): string {
  const name = symbol.name.toLowerCase();
  const type = symbol.type;

  // Better purpose classification
  if (type === 'class') {
    if (name.includes('server') || name.includes('service')) return 'Core service class';
    if (name.includes('manager') || name.includes('handler')) return 'Business logic class';
    if (name.includes('component')) return 'UI component class';
    return 'Business logic class';
  }

  if (type === 'function') {
    if (name.includes('setup') || name.includes('init')) return 'Initialization function';
    if (name.includes('handler') || name.includes('handle')) return 'Event handler function';
    if (name.includes('start') || name.includes('run')) return 'Entry point function';
    if (symbol.signature?.includes('async')) return 'Async operation function';
    return 'Utility function';
  }

  if (type === 'interface' || type === 'type') return 'Type definition';
  if (type === 'export') return 'Module export';
  if (type === 'import') return 'External dependency';
  if (type === 'variable') {
    if (name.includes('config') || name.includes('options')) return 'Configuration variable';
    return 'State variable';
  }

  return symbol.purpose || 'Not documented';
}

/**
 * Format function definitions for display
 */
export function formatFunctionDefinitions(functions: any[]): string {
  if (functions.length === 0) return '_No functions found._';

  // Group functions by type and visibility
  const classMethods = functions.filter(f => f.isMethod);
  const standaloneFunctions = functions.filter(f => !f.isMethod);
  const exportedFunctions = standaloneFunctions.filter(f => f.isExported);
  const internalFunctions = standaloneFunctions.filter(f => !f.isExported);

  let output = '';

  // Class methods section
  if (classMethods.length > 0) {
    const methodsByClass = classMethods.reduce((acc: any, method) => {
      const className = method.className || 'Unknown';
      if (!acc[className]) acc[className] = [];
      acc[className].push(method);
      return acc;
    }, {});

    Object.entries(methodsByClass).forEach(([className, methods]: [string, any]) => {
      output += `\n### 🏗️ ${className} Class Methods (${methods.length})\n`;
      methods.forEach((func: any) => {
        const asyncLabel = func.isAsync ? ' `async`' : '';
        const paramCount = func.parameters.length;
        const paramPreview =
          paramCount > 0
            ? `${paramCount} param${paramCount > 1 ? 's' : ''}: \`${func.parameters
                .slice(0, 2)
                .map((p: any) => p.name + ': ' + p.type)
                .join(', ')}${paramCount > 2 ? '...' : ''}\``
            : 'no parameters';

        const returnInfo = buildReturnInfo(func);

        output += `- **${func.name}**${asyncLabel} (line ${func.line}) - ${paramPreview}${returnInfo}\n`;
        output += `  \`\`\`typescript\n  ${func.signature}\n  \`\`\`\n\n`;
      });
    });
  }

  // Exported standalone functions
  if (exportedFunctions.length > 0) {
    output += `\n### 📤 Exported Functions (${exportedFunctions.length})\n`;
    exportedFunctions.forEach(func => {
      const asyncLabel = func.isAsync ? ' `async`' : '';
      const paramCount = func.parameters.length;
      const paramPreview =
        paramCount > 0
          ? `${paramCount} param${paramCount > 1 ? 's' : ''}: \`${func.parameters
              .slice(0, 2)
              .map((p: any) => p.name + ': ' + p.type)
              .join(', ')}${paramCount > 2 ? '...' : ''}\``
          : 'no parameters';

      const returnInfo = buildReturnInfo(func);

      output += `- **${func.name}**${asyncLabel} (line ${func.line}) - ${paramPreview}${returnInfo}\n`;
      output += `  \`\`\`typescript\n  ${func.signature}\n  \`\`\`\n\n`;
    });
  }

  // Internal standalone functions
  if (internalFunctions.length > 0) {
    output += `\n### 🔒 Internal Functions (${internalFunctions.length})\n`;
    internalFunctions.forEach(func => {
      const asyncLabel = func.isAsync ? ' `async`' : '';
      const paramCount = func.parameters.length;
      const paramPreview =
        paramCount > 0
          ? `${paramCount} param${paramCount > 1 ? 's' : ''}: \`${func.parameters
              .slice(0, 2)
              .map((p: any) => p.name + ': ' + p.type)
              .join(', ')}${paramCount > 2 ? '...' : ''}\``
          : 'no parameters';

      const returnInfo = buildReturnInfo(func);

      output += `- **${func.name}**${asyncLabel} (line ${func.line}) - ${paramPreview}${returnInfo}\n`;
      output += `  \`\`\`typescript\n  ${func.signature}\n  \`\`\`\n\n`;
    });
  }

  return output;
}

/**
 * Build return information string for function display
 */
export function buildReturnInfo(func: any): string {
  const returnParts: string[] = [];

  // Add return type if available
  if (func.returnType && func.returnType !== 'unknown') {
    returnParts.push(`→ \`${func.returnType}\``);
  }

  // Add returned symbols if available
  if (func.returnedSymbols && func.returnedSymbols.length > 0) {
    const symbolsPreview = func.returnedSymbols.slice(0, 3).join(', ');
    const more = func.returnedSymbols.length > 3 ? '...' : '';
    returnParts.push(`returns: \`${symbolsPreview}${more}\``);
  }

  return returnParts.length > 0 ? ` | ${returnParts.join(' | ')}` : '';
}

/**
 * Generate quick file analysis summary
 */
export function generateQuickFileAnalysis(summary: any): string {
  const { file, symbolCount, complexity, language } = summary;
  const fileName = path.basename(file);

  // Analyze symbol types for better insights
  const symbolsByType = summary.symbols.reduce((acc: any, symbol: any) => {
    acc[symbol.type] = (acc[symbol.type] || 0) + 1;
    return acc;
  }, {});

  // Get top symbols by importance/type priority
  const topSymbols = summary.symbols
    .filter((s: any) => s.type !== 'variable' || s.purpose !== 'State variable') // Exclude basic variables
    .slice(0, 3)
    .map((s: any) => `${s.name}(${s.type})`)
    .join(', ');

  // Analyze architecture patterns
  const hasClass = symbolsByType.class > 0;
  const hasInterface = symbolsByType.interface > 0;
  const hasAsync = summary.symbols.some((s: any) => s.signature?.includes('async'));
  const isExportHeavy =
    summary.symbols.filter((s: any) => s.purpose?.includes('Export')).length > 1;

  let pattern = '';
  if (hasClass && hasInterface) pattern = 'OOP design';
  else if (hasClass) pattern = 'Class-based';
  else if (hasInterface) pattern = 'Interface-driven';
  else if (hasAsync) pattern = 'Async/functional';
  else if (isExportHeavy) pattern = 'Module/library';
  else pattern = 'Utility';

  return `${fileName} (${language}): ${symbolCount} symbols, ${complexity} complexity, ${pattern} pattern. Key: ${topSymbols || 'Analysis in progress'}`;
}
