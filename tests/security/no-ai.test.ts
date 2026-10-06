import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * TFME Auto contains no AI functionality, by design. This guard fails the build if an AI/LLM SDK, endpoint or model
 * name ever appears in the application's dependencies or source, so the rule cannot be broken by accident.
 */

const ROOT = process.cwd();

const AI_PACKAGES = [
  'openai', '@anthropic-ai/sdk', '@anthropic-ai/', '@google/generative-ai', '@google/genai', '@langchain/', 'langchain', 'llamaindex', '@huggingface/',
  'cohere-ai', '@mistralai/', 'replicate', 'ollama', 'ai', '@ai-sdk/', '@vercel/ai', 'groq-sdk', '@aws-sdk/client-bedrock', '@azure/openai', 'together-ai', 'tensorflow', '@tensorflow/', 'onnxruntime',
];
const AI_SOURCE_PATTERNS = [
  /api\.openai\.com/i, /api\.anthropic\.com/i, /generativelanguage\.googleapis\.com/i, /api\.cohere\./i, /api\.mistral\.ai/i, /api\.groq\.com/i,
  /from ['"](openai|@anthropic-ai\/[^'"]*|@google\/generative-ai|langchain[^'"]*|@langchain\/[^'"]*|ai|@ai-sdk\/[^'"]*)['"]/,
  /\b(gpt-[345]|gpt-4o|claude-(opus|sonnet|haiku|fable|\d)|gemini-(pro|\d)|llama-?\d|mistral-(large|small|medium))\b/i,
  /\bchat\.completions\b/, /\bmessages\.create\(/, /\bembeddings\.create\(/,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.next', 'generated', '.local-data', 'storage-data'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|cjs|json|sql|prisma)$/.test(name)) out.push(p);
  }
  return out;
}

describe('no AI anywhere in the product', () => {
  it('declares no AI or LLM package as a dependency', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const offenders = names.filter((n) => AI_PACKAGES.some((a) => (a.endsWith('/') ? n.startsWith(a) : n === a)));
    expect(offenders).toEqual([]);
  });

  it('has no AI SDK import, API endpoint, model name or LLM call in the application source, scripts or migrations', () => {
    const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'scripts')), ...walk(join(ROOT, 'prisma'))];
    expect(files.length).toBeGreaterThan(100);
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const re of AI_SOURCE_PATTERNS) {
        const m = re.exec(text);
        if (m) hits.push(`${relative(ROOT, f)}: ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('every inspection finding, diagnosis, recommendation and schedule is a stored or rule-derived value (no model output)', () => {
    // The deterministic rule engines live in these files; they must stay free of any network call.
    for (const f of ['src/server/vehicles/insights.ts', 'src/server/bookings/availability.ts', 'src/server/jobcards/transitions.ts']) {
      const text = readFileSync(join(ROOT, f), 'utf8');
      expect(text, f).not.toMatch(/\bfetch\(|https?:\/\/|XMLHttpRequest/);
    }
  });
});
