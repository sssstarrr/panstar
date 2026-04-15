#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RESOURCE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg',
  'mp3', 'mp4',
  'glb', 'gltf', 'buf', 'bin', 'json',
  'woff', 'woff2', 'ttf', 'otf',
  'css', 'js', 'mjs', 'cjs'
]);

const STYLE_EXTENSIONS = new Set(['css']);
const SCRIPT_EXTENSIONS = new Set(['js', 'mjs', 'cjs']);
const REMOTE_CDN_HOST = 'd8d3yaw9yoj7k.cloudfront.net';
const REMOTE_CDN_HOSTS = new Set([REMOTE_CDN_HOST]);
const SKIPPED_PROTOCOLS = new Set([
  'data:',
  'blob:',
  'devtools:',
  'chrome-extension:',
  'edge:',
  'file:',
  'about:'
]);
const SOURCE_SCAN_RELATIVE_PATH = 'js/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const sourceScanPath = path.join(repoRoot, ...SOURCE_SCAN_RELATIVE_PATH.split('/'));

function printHelp(exitCode = 0) {
  const message = `Usage:
  node tools/har-audit.mjs --har <absolute-path-to.har> [--origin https://index.anheyu.com]

Options:
  --har       Absolute path to the HAR file to analyze
  --origin    Site origin to treat as same-origin (default: https://index.anheyu.com)
  --help      Show this help message
`;

  const output = exitCode === 0 ? console.log : console.error;
  output(message);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = {
    har: null,
    origin: 'https://index.anheyu.com'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      printHelp(0);
    }

    if (arg === '--har') {
      options.har = argv[i + 1] ?? null;
      i += 1;
      continue;
    }

    if (arg === '--origin') {
      options.origin = argv[i + 1] ?? options.origin;
      i += 1;
      continue;
    }

    console.error(`Unknown argument: ${arg}`);
    printHelp(1);
  }

  if (!options.har) {
    console.error('Missing required --har argument.');
    printHelp(1);
  }

  return options;
}

function readHarFile(harPath) {
  const raw = fs.readFileSync(harPath, 'utf8').replace(/^\uFEFF/, '');
  const data = JSON.parse(raw);

  if (!data?.log || !Array.isArray(data.log.entries)) {
    throw new Error('HAR file is missing log.entries.');
  }

  return data;
}

function readSourceFile(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
}

function decodePathname(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function normalizeRelativePath(value) {
  const withForwardSlashes = value.replace(/\\/g, '/');
  const withoutLeadingDots = withForwardSlashes.replace(/^\.\//, '');
  const withoutLeadingSlashes = withoutLeadingDots.replace(/^\/+/, '');
  const normalized = path.posix.normalize(withoutLeadingSlashes);

  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    return null;
  }

  return normalized;
}

function normalizeSourcePath(value) {
  const collapsed = value.replace(/\\/g, '/').replace(/\/+/g, '/');
  return normalizeRelativePath(collapsed);
}

function getExtension(pathname) {
  return path.posix.extname(pathname).toLowerCase().replace(/^\./, '');
}

function inferExtension(value) {
  const matches = [...value.matchAll(/\.([a-z0-9]+)(?=(?:\||\}|[?#]|$))/gi)];
  if (matches.length === 0) {
    return '';
  }

  return String(matches[matches.length - 1][1] ?? '').toLowerCase();
}

function isResourceRequest(pathname) {
  const extension = getExtension(pathname);
  return RESOURCE_EXTENSIONS.has(extension);
}

function buildSameOriginCandidates(pathname) {
  const cleanPath = normalizeRelativePath(decodePathname(pathname));
  if (!cleanPath) {
    return ['index.html'];
  }

  const basename = path.posix.basename(cleanPath);
  const extension = getExtension(basename);
  const candidates = [];

  const addCandidate = (candidate) => {
    const normalized = normalizeRelativePath(candidate);
    if (normalized && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  addCandidate(cleanPath);

  if (cleanPath.startsWith('assets/') || cleanPath.startsWith('css/') || cleanPath.startsWith('js/')) {
    return candidates;
  }

  if (!cleanPath.includes('/')) {
    if (basename === 'index.css') {
      addCandidate('css/index.css');
    }

    if (basename === 'index.js' || basename === 'TweenLite.js' || basename === 'three.r112.js') {
      addCandidate(`js/${basename}`);
    }

    if (STYLE_EXTENSIONS.has(extension)) {
      addCandidate(`css/${basename}`);
    }

    if (SCRIPT_EXTENSIONS.has(extension)) {
      addCandidate(`js/${basename}`);
    }
  }

  return candidates;
}

function resolveLocalCandidate(candidates) {
  for (const candidate of candidates) {
    const absolutePath = path.join(repoRoot, ...candidate.split('/'));
    if (fs.existsSync(absolutePath)) {
      return {
        normalizedPath: candidate,
        absolutePath,
        exists: true
      };
    }
  }

  if (candidates.length === 0) {
    return {
      normalizedPath: null,
      absolutePath: null,
      exists: false
    };
  }

  const normalizedPath = candidates[0];
  return {
    normalizedPath,
    absolutePath: path.join(repoRoot, ...normalizedPath.split('/')),
    exists: false
  };
}

function classifyRequest(urlObject, sameOriginHost) {
  const protocol = urlObject.protocol.toLowerCase();
  if (SKIPPED_PROTOCOLS.has(protocol)) {
    return { skip: true, reason: 'skipped-protocol' };
  }

  if (protocol !== 'http:' && protocol !== 'https:') {
    return { skip: true, reason: 'unsupported-protocol' };
  }

  const pathname = decodePathname(urlObject.pathname || '');
  if (!isResourceRequest(pathname)) {
    return { skip: true, reason: 'non-resource-extension' };
  }

  const host = urlObject.host.toLowerCase();
  if (host === sameOriginHost) {
    const resolved = resolveLocalCandidate(buildSameOriginCandidates(pathname));
    return {
      classification: resolved.exists ? 'present' : 'missing',
      normalizedPath: resolved.normalizedPath,
      absolutePath: resolved.absolutePath,
      exists: resolved.exists,
      extension: getExtension(pathname)
    };
  }

  if (REMOTE_CDN_HOSTS.has(host)) {
    return {
      classification: 'remote-cdn',
      normalizedPath: normalizeRelativePath(pathname),
      absolutePath: null,
      exists: null,
      extension: getExtension(pathname)
    };
  }

  return {
    classification: 'external-ignored',
    normalizedPath: null,
    absolutePath: null,
    exists: null,
    extension: getExtension(pathname)
  };
}

function createLineStarts(text) {
  const starts = [0];

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }

  return starts;
}

function getLineNumber(lineStarts, index) {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const start = lineStarts[mid];
    const next = mid + 1 < lineStarts.length ? lineStarts[mid + 1] : Number.POSITIVE_INFINITY;

    if (index >= start && index < next) {
      return mid + 1;
    }

    if (index < start) {
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return lineStarts.length;
}

function getLineText(text, lineStarts, index) {
  const lineNumber = getLineNumber(lineStarts, index);
  const start = lineStarts[Math.max(0, lineNumber - 1)] ?? 0;
  const end = lineNumber < lineStarts.length ? lineStarts[lineNumber] - 1 : text.length;
  return text.slice(start, end).trim();
}

function shortenText(text, maxLength = 160) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMatchingDelimiter(text, startIndex, openChar, closeChar) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = startIndex; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char === openChar) {
      depth += 1;
      continue;
    }

    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function readUntilTopLevelDelimiter(text, startIndex, delimiters) {
  let quote = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;

  for (let i = startIndex; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char === '(') {
      parenDepth += 1;
      continue;
    }

    if (char === ')') {
      if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0 && delimiters.has(')')) {
        return {
          text: text.slice(startIndex, i),
          endIndex: i,
          delimiter: char
        };
      }

      parenDepth -= 1;
      continue;
    }

    if (char === '{') {
      braceDepth += 1;
      continue;
    }

    if (char === '}') {
      braceDepth -= 1;
      continue;
    }

    if (char === '[') {
      bracketDepth += 1;
      continue;
    }

    if (char === ']') {
      bracketDepth -= 1;
      continue;
    }

    if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0 && delimiters.has(char)) {
      return {
        text: text.slice(startIndex, i),
        endIndex: i,
        delimiter: char
      };
    }
  }

  return {
    text: text.slice(startIndex),
    endIndex: text.length,
    delimiter: null
  };
}

function splitTopLevel(text, delimiter) {
  const parts = [];
  let quote = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let lastIndex = 0;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char === '(') {
      parenDepth += 1;
      continue;
    }

    if (char === ')') {
      parenDepth -= 1;
      continue;
    }

    if (char === '{') {
      braceDepth += 1;
      continue;
    }

    if (char === '}') {
      braceDepth -= 1;
      continue;
    }

    if (char === '[') {
      bracketDepth += 1;
      continue;
    }

    if (char === ']') {
      bracketDepth -= 1;
      continue;
    }

    if (char === delimiter && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
      parts.push(text.slice(lastIndex, i));
      lastIndex = i + 1;
    }
  }

  parts.push(text.slice(lastIndex));
  return parts;
}

function stripOuterParens(value) {
  let result = value.trim();

  while (result.startsWith('(') && result.endsWith(')')) {
    const closingIndex = findMatchingDelimiter(result, 0, '(', ')');
    if (closingIndex !== result.length - 1) {
      break;
    }
    result = result.slice(1, -1).trim();
  }

  return result;
}

function tryParseStringLiteral(value) {
  const text = value.trim();
  const quote = text[0];

  if ((quote !== '"' && quote !== "'") || text[text.length - 1] !== quote) {
    return null;
  }

  let result = '';

  for (let i = 1; i < text.length - 1; i += 1) {
    const char = text[i];
    if (char !== '\\') {
      result += char;
      continue;
    }

    i += 1;
    if (i >= text.length - 1) {
      break;
    }

    const escaped = text[i];
    if (escaped === 'n') {
      result += '\n';
      continue;
    }

    if (escaped === 'r') {
      result += '\r';
      continue;
    }

    if (escaped === 't') {
      result += '\t';
      continue;
    }

    if (escaped === 'b') {
      result += '\b';
      continue;
    }

    if (escaped === 'f') {
      result += '\f';
      continue;
    }

    if (escaped === 'v') {
      result += '\v';
      continue;
    }

    if (escaped === '0') {
      result += '\0';
      continue;
    }

    if (escaped === 'x') {
      const hex = text.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        result += String.fromCharCode(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }

    if (escaped === 'u') {
      const hex = text.slice(i + 1, i + 5);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        result += String.fromCharCode(Number.parseInt(hex, 16));
        i += 4;
        continue;
      }
    }

    result += escaped;
  }

  return result;
}

function findTopLevelTernary(expression) {
  let quote = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let questionIndex = -1;
  let ternaryDepth = 0;

  for (let i = 0; i < expression.length; i += 1) {
    const char = expression[i];
    const next = expression[i + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char === '(') {
      parenDepth += 1;
      continue;
    }

    if (char === ')') {
      parenDepth -= 1;
      continue;
    }

    if (char === '{') {
      braceDepth += 1;
      continue;
    }

    if (char === '}') {
      braceDepth -= 1;
      continue;
    }

    if (char === '[') {
      bracketDepth += 1;
      continue;
    }

    if (char === ']') {
      bracketDepth -= 1;
      continue;
    }

    if (parenDepth !== 0 || braceDepth !== 0 || bracketDepth !== 0) {
      continue;
    }

    if (char === '?') {
      if (questionIndex === -1) {
        questionIndex = i;
      }
      ternaryDepth += 1;
      continue;
    }

    if (char === ':' && questionIndex !== -1) {
      ternaryDepth -= 1;
      if (ternaryDepth === 0) {
        return {
          questionIndex,
          colonIndex: i
        };
      }
    }
  }

  return null;
}

function isIdentifier(value) {
  return /^[A-Za-z_$][\w$]*$/.test(value);
}

function isMemberExpression(value) {
  return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value);
}

function parseRootFragment(value, sameOriginHost) {
  const match = value.match(/^(?:[A-Za-z_$][\w$]*\.)*(assetPath|cdnPath|videoCdnPath)$/);
  if (!match) {
    return null;
  }

  const property = match[1];
  if (property === 'videoCdnPath') {
    return {
      value: '',
      rootType: 'remote-cdn',
      host: REMOTE_CDN_HOST,
      dynamic: false,
      fromConcatenation: false
    };
  }

  return {
    value: 'assets/',
    rootType: 'same-origin',
    host: sameOriginHost,
    dynamic: false,
    fromConcatenation: false
  };
}

function parseSimpleCall(value) {
  const match = value.match(/^([A-Za-z_$][\w$]*)\s*\((.*)\)$/s);
  if (!match) {
    return null;
  }

  const openIndex = value.indexOf('(');
  const closeIndex = findMatchingDelimiter(value, openIndex, '(', ')');
  if (closeIndex !== value.length - 1) {
    return null;
  }

  const argsSource = value.slice(openIndex + 1, -1);
  const args = splitTopLevel(argsSource, ',').map((part) => part.trim()).filter(Boolean);
  return {
    name: match[1],
    args
  };
}

function sanitizePlaceholderName(value) {
  const candidate = value.split('.').pop() || value;
  const cleaned = candidate.replace(/[^A-Za-z0-9_$]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'value';
}

function cloneFragment(fragment) {
  return {
    value: fragment.value,
    rootType: fragment.rootType,
    host: fragment.host,
    dynamic: fragment.dynamic,
    fromConcatenation: fragment.fromConcatenation
  };
}

function combineAlternativeFragments(left, right) {
  if (!left || !right) {
    return null;
  }

  if (left.rootType && right.rootType && (left.rootType !== right.rootType || left.host !== right.host)) {
    return null;
  }

  return {
    value: `{${left.value}|${right.value}}`,
    rootType: left.rootType ?? right.rootType ?? null,
    host: left.host ?? right.host ?? null,
    dynamic: true,
    fromConcatenation: left.fromConcatenation || right.fromConcatenation
  };
}

function combineFragments(fragments) {
  if (fragments.length === 0) {
    return null;
  }

  let rootType = null;
  let host = null;
  let value = '';
  let dynamic = false;

  for (const fragment of fragments) {
    if (!fragment) {
      return null;
    }

    if (fragment.rootType) {
      if (rootType && (rootType !== fragment.rootType || host !== fragment.host)) {
        return null;
      }
      rootType = fragment.rootType;
      host = fragment.host;
    }

    value += fragment.value;
    dynamic = dynamic || fragment.dynamic;
  }

  return {
    value,
    rootType,
    host,
    dynamic,
    fromConcatenation: true
  };
}

function findNearbyAssignmentExpression(name, source, position, cache) {
  const cacheKey = `${name}:${position}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const windowStart = Math.max(0, position - 3000);
  const snippet = source.slice(windowStart, position);
  const pattern = new RegExp(`(?:\\bvar\\s+|\\blet\\s+|\\bconst\\s+|[,;(])\\s*${escapeRegExp(name)}\\s*=`, 'g');
  let match = null;
  let lastMatch = null;

  while ((match = pattern.exec(snippet)) !== null) {
    lastMatch = {
      startIndex: windowStart + match.index,
      expressionStart: windowStart + match.index + match[0].length
    };
  }

  if (!lastMatch) {
    cache.set(cacheKey, null);
    return null;
  }

  const parsed = readUntilTopLevelDelimiter(source, lastMatch.expressionStart, new Set([',', ';']));
  const result = {
    index: lastMatch.startIndex,
    expression: parsed.text.trim()
  };
  cache.set(cacheKey, result);
  return result;
}

function findNearbyFunctionDefinition(name, source, position, cache) {
  const cacheKey = `${name}:${position}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const windowStart = Math.max(0, position - 5000);
  const windowEnd = Math.min(source.length, position + 5000);
  const snippet = source.slice(windowStart, windowEnd);
  const patterns = [
    new RegExp(`function\\s+${escapeRegExp(name)}\\s*\\(([^)]*)\\)\\s*\\{`, 'g'),
    new RegExp(`(?:\\bvar\\s+|\\blet\\s+|\\bconst\\s+)?${escapeRegExp(name)}\\s*=\\s*function\\s*\\(([^)]*)\\)\\s*\\{`, 'g')
  ];
  const candidates = [];

  for (const pattern of patterns) {
    let match = null;
    while ((match = pattern.exec(snippet)) !== null) {
      const absoluteIndex = windowStart + match.index;
      const braceIndex = absoluteIndex + match[0].lastIndexOf('{');
      const closingIndex = findMatchingDelimiter(source, braceIndex, '{', '}');
      if (closingIndex === -1) {
        continue;
      }

      const body = source.slice(braceIndex + 1, closingIndex);
      const returnMatch = body.match(/\breturn\s+([\s\S]*?);/);
      if (!returnMatch) {
        continue;
      }

      const params = String(match[1] ?? '')
        .split(',')
        .map((param) => param.trim())
        .filter(Boolean);

      candidates.push({
        index: absoluteIndex,
        params,
        returnExpression: returnMatch[1].trim(),
        distance: Math.abs(absoluteIndex - position)
      });
    }
  }

  if (candidates.length === 0) {
    cache.set(cacheKey, null);
    return null;
  }

  candidates.sort((left, right) => left.distance - right.distance);
  const result = candidates[0];
  cache.set(cacheKey, result);
  return result;
}

function resolveExpression(expression, context) {
  const expr = stripOuterParens(expression);
  if (!expr) {
    return null;
  }

  if (context.paramMap.has(expr)) {
    return cloneFragment(context.paramMap.get(expr));
  }

  const ternary = findTopLevelTernary(expr);
  if (ternary) {
    const consequent = resolveExpression(expr.slice(ternary.questionIndex + 1, ternary.colonIndex), context);
    const alternate = resolveExpression(expr.slice(ternary.colonIndex + 1), context);
    return combineAlternativeFragments(consequent, alternate);
  }

  const parts = splitTopLevel(expr, '+').map((part) => part.trim()).filter(Boolean);
  if (parts.length > 1) {
    const fragments = parts.map((part) => resolveExpression(part, context));
    return combineFragments(fragments);
  }

  const literal = tryParseStringLiteral(expr);
  if (literal != null) {
    return {
      value: literal,
      rootType: null,
      host: null,
      dynamic: false,
      fromConcatenation: false
    };
  }

  const rootFragment = parseRootFragment(expr, context.sameOriginHost);
  if (rootFragment) {
    return rootFragment;
  }

  const simpleCall = parseSimpleCall(expr);
  if (simpleCall) {
    const functionDefinition = findNearbyFunctionDefinition(simpleCall.name, context.source, context.position, context.functionCache);
    if (!functionDefinition) {
      return null;
    }

    const visitedKey = `function:${simpleCall.name}:${functionDefinition.index}`;
    if (context.visited.has(visitedKey)) {
      return null;
    }

    const nextParamMap = new Map(context.paramMap);
    for (let i = 0; i < functionDefinition.params.length; i += 1) {
      const paramName = functionDefinition.params[i];
      const argExpression = simpleCall.args[i] ?? paramName;
      const argFragment = resolveExpression(argExpression, {
        ...context,
        visited: new Set(context.visited)
      }) ?? {
        value: `{${sanitizePlaceholderName(argExpression)}}`,
        rootType: null,
        host: null,
        dynamic: true,
        fromConcatenation: false
      };
      nextParamMap.set(paramName, argFragment);
    }

    const nextVisited = new Set(context.visited);
    nextVisited.add(visitedKey);
    return resolveExpression(functionDefinition.returnExpression, {
      ...context,
      position: functionDefinition.index,
      paramMap: nextParamMap,
      visited: nextVisited
    });
  }

  if (isIdentifier(expr)) {
    const assignment = findNearbyAssignmentExpression(expr, context.source, context.position, context.assignmentCache);
    if (assignment) {
      const visitedKey = `variable:${expr}:${assignment.index}`;
      if (!context.visited.has(visitedKey)) {
        const nextVisited = new Set(context.visited);
        nextVisited.add(visitedKey);
        const resolved = resolveExpression(assignment.expression, {
          ...context,
          position: assignment.index,
          visited: nextVisited
        });
        if (resolved) {
          return resolved;
        }
      }
    }

    return {
      value: `{${sanitizePlaceholderName(expr)}}`,
      rootType: null,
      host: null,
      dynamic: true,
      fromConcatenation: false
    };
  }

  if (isMemberExpression(expr)) {
    return {
      value: `{${sanitizePlaceholderName(expr)}}`,
      rootType: null,
      host: null,
      dynamic: true,
      fromConcatenation: false
    };
  }

  return null;
}

function determinePatternType(fragment) {
  if (fragment.dynamic || /\{[^}]+\}/.test(fragment.value)) {
    return 'template';
  }

  if (fragment.fromConcatenation) {
    return 'concatenated';
  }

  return 'literal';
}

function templateToRegExp(templatePath) {
  let pattern = '^';

  for (let i = 0; i < templatePath.length; i += 1) {
    const char = templatePath[i];
    if (char !== '{') {
      pattern += escapeRegExp(char);
      continue;
    }

    const closingIndex = templatePath.indexOf('}', i + 1);
    if (closingIndex === -1) {
      pattern += escapeRegExp(templatePath.slice(i));
      break;
    }

    const inner = templatePath.slice(i + 1, closingIndex);
    if (inner.includes('|')) {
      pattern += `(?:${inner.split('|').map((part) => escapeRegExp(part)).join('|')})`;
    } else {
      pattern += '[^/]+';
    }

    i = closingIndex;
  }

  pattern += '$';
  return new RegExp(pattern);
}

function hasTemplateLocalMatch(templatePath, cache) {
  if (cache.has(templatePath)) {
    return cache.get(templatePath);
  }

  const firstPlaceholderIndex = templatePath.indexOf('{');
  const prefix = firstPlaceholderIndex === -1 ? templatePath : templatePath.slice(0, firstPlaceholderIndex);
  const directoryPrefix = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/') + 1) : '';
  const baseSegments = directoryPrefix.split('/').filter(Boolean);
  const baseDirectory = baseSegments.length > 0 ? path.join(repoRoot, ...baseSegments) : repoRoot;

  if (!fs.existsSync(baseDirectory)) {
    cache.set(templatePath, false);
    return false;
  }

  const matcher = templateToRegExp(templatePath);
  const stack = [baseDirectory];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, {
      withFileTypes: true
    });

    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }

      const relativePath = normalizeRelativePath(path.relative(repoRoot, absolutePath));
      if (relativePath && matcher.test(relativePath)) {
        cache.set(templatePath, true);
        return true;
      }
    }
  }

  cache.set(templatePath, false);
  return false;
}

function buildCandidateUrl(origin, host, pathValue, rootType) {
  if (rootType === 'same-origin') {
    return `${origin.origin}/${pathValue}`;
  }

  if (rootType === 'remote-cdn') {
    return `https://${host}/${pathValue}`;
  }

  return null;
}

function extractCallExpressions(source) {
  const lineStarts = createLineStarts(source);
  const definitions = [
    {
      token: 'loader.add(',
      label: 'loader.add'
    },
    {
      token: 'loader.load(',
      label: 'loader.load'
    },
    {
      token: 'GLTFLoader.load(',
      label: 'GLTFLoader.load'
    }
  ];
  const calls = [];
  const seen = new Set();

  for (const definition of definitions) {
    let searchIndex = 0;

    while (searchIndex < source.length) {
      const index = source.indexOf(definition.token, searchIndex);
      if (index === -1) {
        break;
      }

      const argumentStart = index + definition.token.length;
      const parsed = readUntilTopLevelDelimiter(source, argumentStart, new Set([',', ')']));
      const key = `${definition.label}:${index}`;
      if (parsed.text.trim() && !seen.has(key)) {
        seen.add(key);
        calls.push({
          index,
          expression: parsed.text.trim(),
          kind: definition.label,
          line: getLineNumber(lineStarts, index),
          snippet: shortenText(getLineText(source, lineStarts, index))
        });
      }

      searchIndex = argumentStart;
    }
  }

  calls.sort((left, right) => left.index - right.index);
  return calls;
}

function buildSourceCandidate(fragment, call, origin, sameOriginHost, templateExistsCache) {
  const normalizedValue = normalizeSourcePath(fragment.value);
  if (!normalizedValue) {
    return null;
  }

  const extension = inferExtension(normalizedValue);
  if (!RESOURCE_EXTENSIONS.has(extension)) {
    return null;
  }

  const patternType = determinePatternType(fragment);
  const isTemplate = /\{[^}]+\}/.test(normalizedValue);
  let classification = null;
  let exists = null;
  let host = null;
  let normalizedPath = null;
  let templatePath = null;

  if (fragment.rootType === 'same-origin') {
    host = sameOriginHost;
    if (isTemplate) {
      templatePath = normalizedValue;
      exists = hasTemplateLocalMatch(templatePath, templateExistsCache);
      classification = exists ? 'present' : 'missing';
    } else {
      const resolved = resolveLocalCandidate([normalizedValue]);
      normalizedPath = resolved.normalizedPath;
      exists = resolved.exists;
      classification = exists ? 'present' : 'missing';
    }
  } else if (fragment.rootType === 'remote-cdn') {
    host = fragment.host ?? REMOTE_CDN_HOST;
    classification = 'remote-cdn';
    if (isTemplate) {
      templatePath = normalizedValue;
    } else {
      normalizedPath = normalizedValue;
    }
  } else {
    return null;
  }

  const pathValue = templatePath ?? normalizedPath;
  if (!pathValue) {
    return null;
  }

  const sourceContext = `${SOURCE_SCAN_RELATIVE_PATH}:${call.line}`;
  return {
    kind: 'source-candidate',
    url: buildCandidateUrl(origin, host, pathValue, fragment.rootType),
    host,
    status: null,
    statuses: [],
    responseOk: null,
    normalizedPath,
    templatePath,
    exists,
    classification,
    extension,
    requestCount: 0,
    discovery: 'source',
    evidence: ['source'],
    patternType,
    sourceContext,
    sourceContexts: [sourceContext],
    sourceSnippet: call.snippet,
    sourceSnippets: [call.snippet],
    sourceCount: 1,
    discoveredBy: call.kind,
    matchedRuntimeCount: 0,
    matchedRuntimePaths: []
  };
}

function patternTypeRank(value) {
  if (value === 'template') {
    return 2;
  }

  if (value === 'concatenated') {
    return 1;
  }

  return 0;
}

function mergeSourceCandidate(map, candidate) {
  const key = `${candidate.host}|${candidate.templatePath ?? candidate.normalizedPath}`;
  if (!map.has(key)) {
    map.set(key, candidate);
    return;
  }

  const existing = map.get(key);
  existing.sourceCount += candidate.sourceCount;

  if (patternTypeRank(candidate.patternType) > patternTypeRank(existing.patternType)) {
    existing.patternType = candidate.patternType;
  }

  if (candidate.exists === true) {
    existing.exists = true;
    if (existing.classification !== 'remote-cdn') {
      existing.classification = 'present';
    }
  }

  if (candidate.classification === 'remote-cdn') {
    existing.classification = 'remote-cdn';
    existing.exists = null;
  }

  if (!existing.sourceContexts.includes(candidate.sourceContext)) {
    existing.sourceContexts.push(candidate.sourceContext);
  }

  if (!existing.sourceSnippets.includes(candidate.sourceSnippet)) {
    existing.sourceSnippets.push(candidate.sourceSnippet);
  }

  existing.sourceContext = existing.sourceContexts[0];
  existing.sourceSnippet = existing.sourceSnippets[0];
}

function extractSourceCandidates(source, sameOriginHost, origin) {
  const calls = extractCallExpressions(source);
  const assignmentCache = new Map();
  const functionCache = new Map();
  const templateExistsCache = new Map();
  const candidates = new Map();

  for (const call of calls) {
    const fragment = resolveExpression(call.expression, {
      source,
      position: call.index,
      sameOriginHost,
      assignmentCache,
      functionCache,
      paramMap: new Map(),
      visited: new Set()
    });

    if (!fragment) {
      continue;
    }

    const candidate = buildSourceCandidate(fragment, call, origin, sameOriginHost, templateExistsCache);
    if (!candidate) {
      continue;
    }

    mergeSourceCandidate(candidates, candidate);
  }

  return {
    callSites: calls.length,
    items: [...candidates.values()]
  };
}

function buildRuntimeItems(harData, sameOriginHost) {
  const skippedEntries = {
    nonGetMethod: 0,
    invalidUrl: 0,
    skippedProtocol: 0,
    unsupportedProtocol: 0,
    nonResourceExtension: 0
  };
  const aggregated = new Map();

  for (const entry of harData.log.entries) {
    const method = String(entry?.request?.method ?? '').toUpperCase();
    if (method !== 'GET') {
      skippedEntries.nonGetMethod += 1;
      continue;
    }

    const requestUrl = entry?.request?.url;
    if (!requestUrl) {
      skippedEntries.invalidUrl += 1;
      continue;
    }

    let urlObject;
    try {
      urlObject = new URL(requestUrl);
    } catch {
      skippedEntries.invalidUrl += 1;
      continue;
    }

    const classified = classifyRequest(urlObject, sameOriginHost);
    if (classified.skip) {
      if (classified.reason === 'skipped-protocol') {
        skippedEntries.skippedProtocol += 1;
      } else if (classified.reason === 'unsupported-protocol') {
        skippedEntries.unsupportedProtocol += 1;
      } else if (classified.reason === 'non-resource-extension') {
        skippedEntries.nonResourceExtension += 1;
      }
      continue;
    }

    const cleanedUrl = `${urlObject.origin}${decodePathname(urlObject.pathname)}`;
    const status = Number(entry?.response?.status ?? 0) || null;
    const key = [
      classified.classification,
      urlObject.host.toLowerCase(),
      classified.normalizedPath ?? cleanedUrl
    ].join('|');

    if (!aggregated.has(key)) {
      aggregated.set(key, {
        kind: 'runtime',
        url: cleanedUrl,
        host: urlObject.host.toLowerCase(),
        status,
        statuses: status == null ? [] : [status],
        responseOk: status != null ? status >= 200 && status < 400 : null,
        normalizedPath: classified.normalizedPath,
        templatePath: null,
        exists: classified.exists,
        classification: classified.classification,
        extension: classified.extension,
        requestCount: 1,
        discovery: 'runtime',
        evidence: ['runtime'],
        matchedSourcePaths: [],
        matchedSourceContexts: []
      });
      continue;
    }

    const record = aggregated.get(key);
    record.requestCount += 1;
    if (status != null && !record.statuses.includes(status)) {
      record.statuses.push(status);
      record.statuses.sort((left, right) => left - right);
    }
  }

  return {
    skippedEntries,
    items: [...aggregated.values()]
  };
}

function addUnique(list, values) {
  for (const value of values) {
    if (!list.includes(value)) {
      list.push(value);
    }
  }
}

function mergeRuntimeAndSource(runtimeItems, sourceItems) {
  const runtimeByExactPath = new Map();

  for (const runtimeItem of runtimeItems) {
    if (runtimeItem.normalizedPath) {
      runtimeByExactPath.set(`${runtimeItem.host}|${runtimeItem.normalizedPath}`, runtimeItem);
    }
  }

  for (const sourceItem of sourceItems) {
    const matches = new Set();

    if (sourceItem.normalizedPath) {
      const exactMatch = runtimeByExactPath.get(`${sourceItem.host}|${sourceItem.normalizedPath}`);
      if (exactMatch) {
        matches.add(exactMatch);
      }
    }

    if (sourceItem.templatePath) {
      const matcher = templateToRegExp(sourceItem.templatePath);
      for (const runtimeItem of runtimeItems) {
        if (runtimeItem.host !== sourceItem.host || !runtimeItem.normalizedPath) {
          continue;
        }

        if (matcher.test(runtimeItem.normalizedPath)) {
          matches.add(runtimeItem);
        }
      }
    }

    if (matches.size === 0) {
      continue;
    }

    sourceItem.discovery = 'runtime+source';
    sourceItem.evidence = ['runtime', 'source'];
    sourceItem.matchedRuntimeCount = matches.size;
    sourceItem.matchedRuntimePaths = [...matches]
      .map((item) => item.normalizedPath)
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));

    for (const runtimeItem of matches) {
      runtimeItem.discovery = 'runtime+source';
      addUnique(runtimeItem.evidence, ['source']);
      addUnique(runtimeItem.matchedSourcePaths, [sourceItem.templatePath ?? sourceItem.normalizedPath].filter(Boolean));
      addUnique(runtimeItem.matchedSourceContexts, sourceItem.sourceContexts);
    }
  }
}

function sortItems(items) {
  const classificationOrder = new Map([
    ['missing', 0],
    ['remote-cdn', 1],
    ['present', 2],
    ['external-ignored', 3]
  ]);
  const kindOrder = new Map([
    ['runtime', 0],
    ['source-candidate', 1]
  ]);
  const discoveryOrder = new Map([
    ['runtime+source', 0],
    ['runtime', 1],
    ['source', 2]
  ]);

  return items.sort((left, right) => {
    const leftClassification = classificationOrder.get(left.classification) ?? 99;
    const rightClassification = classificationOrder.get(right.classification) ?? 99;
    if (leftClassification !== rightClassification) {
      return leftClassification - rightClassification;
    }

    const leftKind = kindOrder.get(left.kind) ?? 99;
    const rightKind = kindOrder.get(right.kind) ?? 99;
    if (leftKind !== rightKind) {
      return leftKind - rightKind;
    }

    const leftDiscovery = discoveryOrder.get(left.discovery) ?? 99;
    const rightDiscovery = discoveryOrder.get(right.discovery) ?? 99;
    if (leftDiscovery !== rightDiscovery) {
      return leftDiscovery - rightDiscovery;
    }

    const leftKey = left.templatePath ?? left.normalizedPath ?? left.url ?? '';
    const rightKey = right.templatePath ?? right.normalizedPath ?? right.url ?? '';
    return leftKey.localeCompare(rightKey);
  });
}

function buildMissingText(items) {
  const runtimeMissing = items.filter((item) => item.kind === 'runtime' && item.classification === 'missing');
  const runtimeRemoteCdn = items.filter((item) => item.kind === 'runtime' && item.classification === 'remote-cdn');
  const sourceOnly = items.filter((item) => item.kind === 'source-candidate' && item.discovery === 'source');
  const lines = [];

  lines.push('# Missing local same-origin resources');
  if (runtimeMissing.length === 0) {
    lines.push('(none)');
  } else {
    for (const item of runtimeMissing) {
      lines.push(`missing\t${item.normalizedPath ?? '(unmapped)'}\t${item.url}`);
    }
  }

  lines.push('');
  lines.push('# Remote CDN resources (not counted as local missing)');
  if (runtimeRemoteCdn.length === 0) {
    lines.push('(none)');
  } else {
    for (const item of runtimeRemoteCdn) {
      lines.push(`remote-cdn\t${item.normalizedPath ?? '(unmapped)'}\t${item.url}`);
    }
  }

  lines.push('');
  lines.push('# Source-only asset candidates');
  if (sourceOnly.length === 0) {
    lines.push('(none)');
  } else {
    for (const item of sourceOnly) {
      lines.push(
        `source-only\t${item.classification}\t${item.templatePath ?? item.normalizedPath ?? '(unmapped)'}\t${item.patternType}\t${item.sourceContext}`
      );
    }
  }

  return lines.join('\n');
}

function summarize(runtimeItems, sourceItems, skippedEntries, totalEntries) {
  const summary = {
    totalEntries,
    consideredResources: runtimeItems.length,
    skippedEntries,
    present: 0,
    missing: 0,
    remoteCdn: 0,
    externalIgnored: 0,
    sourceCandidates: sourceItems.length,
    sourceOnlyCandidates: 0,
    runtimeSeenAndSourceMatched: 0,
    templateCandidates: 0
  };

  for (const item of runtimeItems) {
    if (item.classification === 'present') {
      summary.present += 1;
      continue;
    }

    if (item.classification === 'missing') {
      summary.missing += 1;
      continue;
    }

    if (item.classification === 'remote-cdn') {
      summary.remoteCdn += 1;
      continue;
    }

    if (item.classification === 'external-ignored') {
      summary.externalIgnored += 1;
    }
  }

  for (const item of runtimeItems) {
    if (item.discovery === 'runtime+source') {
      summary.runtimeSeenAndSourceMatched += 1;
    }
  }

  for (const item of sourceItems) {
    if (item.discovery === 'source') {
      summary.sourceOnlyCandidates += 1;
    }

    if (item.patternType === 'template') {
      summary.templateCandidates += 1;
    }
  }

  return summary;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const harPath = path.resolve(options.har);
  const harData = readHarFile(harPath);
  const sourceCode = readSourceFile(sourceScanPath);
  const origin = new URL(options.origin);
  const sameOriginHost = origin.host.toLowerCase();

  const runtimeScan = buildRuntimeItems(harData, sameOriginHost);
  const sourceScan = extractSourceCandidates(sourceCode, sameOriginHost, origin);
  mergeRuntimeAndSource(runtimeScan.items, sourceScan.items);

  const items = sortItems([...runtimeScan.items, ...sourceScan.items]);
  const summary = summarize(runtimeScan.items, sourceScan.items, runtimeScan.skippedEntries, harData.log.entries.length);
  const reportsDir = path.join(repoRoot, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });

  const reportJsonPath = path.join(reportsDir, 'har-assets-report.json');
  const reportTextPath = path.join(reportsDir, 'har-assets-missing.txt');

  fs.writeFileSync(
    reportJsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        harFile: harPath,
        repoRoot,
        origin: options.origin,
        sourceFile: sourceScanPath,
        summary,
        sourceScan: {
          sourceFile: sourceScanPath,
          callSites: sourceScan.callSites,
          uniqueCandidates: sourceScan.items.length,
          sourceOnlyCandidates: summary.sourceOnlyCandidates,
          runtimeSeenAndSourceMatched: summary.runtimeSeenAndSourceMatched,
          templateCandidates: summary.templateCandidates
        },
        items
      },
      null,
      2
    ),
    'utf8'
  );

  fs.writeFileSync(reportTextPath, buildMissingText(items), 'utf8');

  console.log(`HAR analyzed: ${harPath}`);
  console.log(`Report written: ${reportJsonPath}`);
  console.log(`Missing list written: ${reportTextPath}`);
  console.log(
    `Summary: missing=${summary.missing}, remote-cdn=${summary.remoteCdn}, present=${summary.present}, external-ignored=${summary.externalIgnored}, source-only=${summary.sourceOnlyCandidates}, runtime+source=${summary.runtimeSeenAndSourceMatched}, template-candidates=${summary.templateCandidates}`
  );
}

try {
  main();
} catch (error) {
  console.error(`Failed to analyze HAR: ${error.message}`);
  process.exit(1);
}
