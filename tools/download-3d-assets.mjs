#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THREE_D_EXTENSIONS = new Set(['glb', 'gltf', 'buf', 'bin', 'mp4']);
const PLACEHOLDER_DEFAULTS = {
  videoHeight: ['480', '720', '900', '1080']
};
const REMOTE_DOWNLOAD_ROOT = ['downloads', 'remote-cdn'];
const REMOTE_CDN_HOST = 'd8d3yaw9yoj7k.cloudfront.net';
const BROWSER_HEADERS = {
  'accept': '*/*',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'origin': 'https://index.anheyu.com',
  'referer': 'https://index.anheyu.com/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36'
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const defaultReportPath = path.join(repoRoot, 'reports', 'har-assets-report.json');

function printHelp(exitCode = 0) {
  const output = exitCode === 0 ? console.log : console.error;
  output(`Usage:
  node tools/download-3d-assets.mjs [--report <absolute-path-to-report.json>]

Behavior:
  - Reads reports/har-assets-report.json by default
  - Downloads missing 3D-related assets referenced by the combined HAR/source audit
  - Tries alternate same-origin/CDN URL patterns for blocked visuals/video assets
  - Sends browser-like headers for remote fetches
  - Saves same-origin files into the repo at their normalized paths
  - Saves remote CDN files under downloads/remote-cdn/<host>/...
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = {
    report: defaultReportPath
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      printHelp(0);
    }

    if (arg === '--report') {
      options.report = path.resolve(argv[i + 1] ?? '');
      i += 1;
      continue;
    }

    console.error(`Unknown argument: ${arg}`);
    printHelp(1);
  }

  return options;
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function normalizeRelativePath(value) {
  const withForwardSlashes = String(value).replace(/\\/g, '/');
  const withoutLeadingDots = withForwardSlashes.replace(/^\.\//, '');
  const withoutLeadingSlashes = withoutLeadingDots.replace(/^\/+/, '');
  const normalized = path.posix.normalize(withoutLeadingSlashes);

  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    return null;
  }

  return normalized;
}

function getExtension(value) {
  return path.posix.extname(value).toLowerCase().replace(/^\./, '');
}

function isVisualPath(normalizedPath) {
  return normalizedPath.startsWith('assets/visuals/') || normalizedPath.startsWith('visuals/');
}

function is3dRelatedPath(resourcePath) {
  const normalized = normalizeRelativePath(resourcePath)?.toLowerCase();
  if (!normalized) {
    return false;
  }

  if (isVisualPath(normalized)) {
    return true;
  }

  if (THREE_D_EXTENSIONS.has(getExtension(normalized))) {
    return true;
  }

  if (/^assets\/images\/(?:\{low\/\|high\/\}|low\/|high\/)cloth_(?:pos|norm)\.png$/.test(normalized)) {
    return true;
  }

  if (/^assets\/images\/(?:\{low\/\|high\/\}|low\/|high\/)cloth\.json$/.test(normalized)) {
    return true;
  }

  return false;
}

function expandTemplatePath(templatePath) {
  const match = templatePath.match(/\{([^{}]+)\}/);
  if (!match) {
    return [templatePath];
  }

  const [placeholder, inner] = match;
  let replacements = null;

  if (inner.includes('|')) {
    replacements = inner.split('|');
  } else if (PLACEHOLDER_DEFAULTS[inner]) {
    replacements = PLACEHOLDER_DEFAULTS[inner];
  } else {
    return [];
  }

  const prefix = templatePath.slice(0, match.index);
  const suffix = templatePath.slice(match.index + placeholder.length);
  return replacements.flatMap((replacement) => expandTemplatePath(`${prefix}${replacement}${suffix}`));
}

function buildUrl(host, normalizedPath, originUrl) {
  if (host === originUrl.host.toLowerCase()) {
    return `${originUrl.origin}/${normalizedPath}`;
  }

  return `https://${host}/${normalizedPath}`;
}

function buildTargetPath(originHost, storageHost, normalizedPath) {
  if (storageHost === originHost) {
    return path.join(repoRoot, ...normalizedPath.split('/'));
  }

  return path.join(repoRoot, ...REMOTE_DOWNLOAD_ROOT, storageHost, ...normalizedPath.split('/'));
}

function buildCandidates(report) {
  const originUrl = new URL(report.origin);
  const originHost = originUrl.host.toLowerCase();
  const items = Array.isArray(report.items) ? report.items : [];
  const candidates = [];
  const skippedTemplates = [];
  const seen = new Set();

  for (const item of items) {
    const resourcePath = item.templatePath ?? item.normalizedPath;
    if (!resourcePath) {
      continue;
    }

    if (item.classification !== 'missing' && item.classification !== 'remote-cdn') {
      continue;
    }

    if (!is3dRelatedPath(resourcePath)) {
      continue;
    }

    const expandedPaths = item.templatePath ? expandTemplatePath(item.templatePath) : [item.normalizedPath];
    if (expandedPaths.length === 0) {
      skippedTemplates.push({
        templatePath: item.templatePath,
        host: item.host,
        sourceContext: item.sourceContext ?? null
      });
      continue;
    }

    for (const expandedPath of expandedPaths) {
      const normalizedPath = normalizeRelativePath(expandedPath);
      if (!normalizedPath) {
        continue;
      }

      const host = String(item.host ?? originHost).toLowerCase();
      const storageHost = host === originHost ? originHost : host;
      const key = `${storageHost}|${normalizedPath}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      candidates.push({
        originHost,
        originUrl,
        host,
        storageHost,
        normalizedPath,
        targetPath: buildTargetPath(originHost, storageHost, normalizedPath),
        sourceContext: item.sourceContext ?? null,
        classification: item.classification,
        discovery: item.discovery ?? 'unknown'
      });
    }
  }

  candidates.sort((left, right) => left.normalizedPath.localeCompare(right.normalizedPath));
  skippedTemplates.sort((left, right) => String(left.templatePath).localeCompare(String(right.templatePath)));

  return {
    candidates,
    skippedTemplates
  };
}

function buildAttemptSpecs(candidate) {
  const attempts = [];
  const seen = new Set();
  const pathValue = candidate.normalizedPath;
  const withoutAssets = pathValue.startsWith('assets/') ? pathValue.slice('assets/'.length) : null;
  const withAssets = pathValue.startsWith('assets/') ? pathValue : `assets/${pathValue}`;
  const visualPath = isVisualPath(pathValue);

  const addAttempt = (label, host, normalizedPath) => {
    const cleanPath = normalizeRelativePath(normalizedPath);
    if (!cleanPath) {
      return;
    }

    const url = buildUrl(host, cleanPath, candidate.originUrl);
    const key = `${host}|${cleanPath}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    attempts.push({
      label,
      host,
      normalizedPath: cleanPath,
      url
    });
  };

  addAttempt('primary', candidate.host, pathValue);

  if (candidate.host === candidate.originHost) {
    if (withoutAssets) {
      addAttempt('origin-no-assets', candidate.originHost, withoutAssets);
    }

    if (visualPath) {
      addAttempt('cdn-same-path', REMOTE_CDN_HOST, pathValue);
      if (withoutAssets) {
        addAttempt('cdn-no-assets', REMOTE_CDN_HOST, withoutAssets);
      }
    }
  } else {
    addAttempt('origin-same-path', candidate.originHost, pathValue);
    addAttempt('origin-with-assets', candidate.originHost, withAssets);
    addAttempt('cdn-with-assets', REMOTE_CDN_HOST, withAssets);
  }

  return attempts;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function toRepoRelative(filePath) {
  return normalizeRelativePath(path.relative(repoRoot, filePath)) ?? filePath;
}

async function fetchAttempt(attempt) {
  let response;
  try {
    response = await fetch(attempt.url, {
      headers: BROWSER_HEADERS,
      redirect: 'follow'
    });
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      httpStatus: null,
      attempt
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: `HTTP ${response.status}`,
      httpStatus: response.status,
      attempt
    };
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    ok: true,
    buffer,
    httpStatus: response.status,
    finalUrl: response.url,
    attempt
  };
}

async function downloadCandidate(candidate) {
  if (fs.existsSync(candidate.targetPath)) {
    return {
      status: 'exists',
      ...candidate,
      size: fs.statSync(candidate.targetPath).size
    };
  }

  const failures = [];
  const attempts = buildAttemptSpecs(candidate);

  for (const attempt of attempts) {
    const result = await fetchAttempt(attempt);
    if (!result.ok) {
      failures.push({
        label: attempt.label,
        url: attempt.url,
        error: result.error,
        httpStatus: result.httpStatus
      });
      continue;
    }

    fs.mkdirSync(path.dirname(candidate.targetPath), { recursive: true });
    fs.writeFileSync(candidate.targetPath, result.buffer);
    return {
      status: 'downloaded',
      ...candidate,
      size: result.buffer.length,
      httpStatus: result.httpStatus,
      downloadUrl: result.finalUrl,
      attemptLabel: attempt.label,
      attempted: failures.length + 1
    };
  }

  return {
    status: 'failed',
    ...candidate,
    attempts,
    failures,
    error: failures[failures.length - 1]?.error ?? 'unknown error'
  };
}

async function runWithConcurrency(candidates, concurrency = 4) {
  const results = new Array(candidates.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < candidates.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await downloadCandidate(candidates[currentIndex]);
    }
  }

  const workerCount = Math.min(concurrency, Math.max(1, candidates.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = readJson(options.report);
  const { candidates, skippedTemplates } = buildCandidates(report);

  if (candidates.length === 0) {
    console.log('No downloadable missing 3D-related assets were found in the report.');
    return;
  }

  console.log(`Report: ${options.report}`);
  console.log(`Candidates: ${candidates.length}`);
  if (skippedTemplates.length > 0) {
    console.log(`Skipped unresolved templates: ${skippedTemplates.length}`);
    for (const skipped of skippedTemplates) {
      console.log(`SKIP-TEMPLATE\t${skipped.templatePath}\t${skipped.sourceContext ?? '(no source context)'}`);
    }
  }

  const results = await runWithConcurrency(candidates, 4);
  let downloaded = 0;
  let exists = 0;
  let failed = 0;

  for (const result of results) {
    if (result.status === 'downloaded') {
      downloaded += 1;
      console.log(`DOWNLOADED\t${result.normalizedPath}\t${result.attemptLabel}\t${formatBytes(result.size)}\t${toRepoRelative(result.targetPath)}`);
      continue;
    }

    if (result.status === 'exists') {
      exists += 1;
      console.log(`EXISTS\t${result.normalizedPath}\t${formatBytes(result.size)}\t${toRepoRelative(result.targetPath)}`);
      continue;
    }

    failed += 1;
    const tried = result.failures.map((failure) => `${failure.label}:${failure.error}`).join(', ');
    console.log(`FAILED\t${result.normalizedPath}\t${tried}`);
  }

  console.log(`Summary: downloaded=${downloaded}, exists=${exists}, failed=${failed}, total=${results.length}`);
}

main().catch((error) => {
  console.error(`Failed to download assets: ${error.message}`);
  process.exit(1);
});
