import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const secretPatterns = [
  { name: 'OpenAI API key', pattern: /\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'Groq API key', pattern: /\bgsk_[A-Za-z0-9]{20,}\b/g },
  { name: 'NVIDIA API key', pattern: /\bnvapi-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'Gemini API key', pattern: /\bAIza[A-Za-z0-9_-]{20,}\b/g },
  { name: 'GitHub token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'Cerebras API key', pattern: /\bcsk-[A-Za-z0-9]{20,}\b/g },
  { name: 'Together API key', pattern: /\btgp_v1_[A-Za-z0-9_-]{20,}\b/g },
  { name: 'LLMRack API key', pattern: /\brl_live_[A-Za-z0-9]{20,}\b/g },
  { name: 'ApiFreeLLM API key', pattern: /\bapf_[A-Za-z0-9]{20,}\b/g },
];

const forbiddenTrackedFiles = [
  /^\.env(?:\..*)?$/,
  /(?:^|\/)signalrss-pre-pgvector\.sql$/,
  /(?:^|\/).*(?:backup|dump).*\.sql$/i,
  /^data\/generated-thumbnails\/.*\.(?:png|jpe?g|webp|url)$/i,
];

const textExtensions = new Set([
  '.js',
  '.json',
  '.md',
  '.sql',
  '.csv',
  '.yml',
  '.yaml',
  '.example',
  '',
]);

function trackedFiles() {
  let output;
  try {
    output = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.length > 0) {
      output = error.stdout;
    } else {
      throw error;
    }
  }
  return output.split('\0').filter(Boolean);
}

function isProbablyText(file) {
  return textExtensions.has(path.extname(file));
}

function lineAndColumn(content, index) {
  const prefix = content.slice(0, index);
  const lines = prefix.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

const findings = [];

for (const file of trackedFiles()) {
  if (file !== '.env.example' && forbiddenTrackedFiles.some((pattern) => pattern.test(file))) {
    findings.push(`${file}: forbidden public artifact is tracked`);
    continue;
  }

  if (!isProbablyText(file)) {
    continue;
  }

  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch (error) {
    findings.push(`${file}: unable to read tracked file: ${error.message}`);
    continue;
  }

  for (const { name, pattern } of secretPatterns) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      if (file === '.env.example' && match[0].endsWith('=')) {
        continue;
      }
      const { line, column } = lineAndColumn(content, match.index);
      findings.push(`${file}:${line}:${column}: possible ${name}`);
    }
  }
}

if (findings.length > 0) {
  console.error('Public repository check failed:');
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exit(1);
}

console.log('Public repository check passed.');
