import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Express } from 'express';
import { parse } from 'yaml';
import { createApp } from '../../src/app';

/**
 * CR-HM-18 — shared OpenAPI census helpers.
 *
 * The legacy OpenAPI closure suites each re-implemented the same three
 * primitives (path normalization, express router walk, local `$ref`
 * validation). Their `$ref` check only understood `#/components/<bucket>/<name>`
 * and therefore reported valid deep JSON pointers (e.g.
 * `#/components/schemas/X/properties/y`) as broken. This module resolves the
 * full pointer instead, so the suites fail only for genuinely unresolvable
 * references.
 */

export const SPEC_PATH = resolve(__dirname, '../../docs/api/openapi.yaml');

export function loadSpec(): Record<string, any> {
  return parse(readFileSync(SPEC_PATH, 'utf8')) as Record<string, any>;
}

export function normalizePath(p: string): string {
  return p
    .replace(/:([a-zA-Z0-9_]+)/g, '{$1}')
    .replace(/\{([a-zA-Z0-9_]+)\}/g, '{p}')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '') || '/';
}

export function walkRouter(
  stack: unknown,
  prefix = '',
): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  const s = stack as Array<{
    route?: { path?: string; methods?: Record<string, unknown> };
    handle?: { stack?: unknown[] };
    matchers?: Array<(input: string) => boolean | object>;
  }>;

  for (const layer of s || []) {
    if (layer.route?.path) {
      // Express accepts an ARRAY of paths for one handler
      // (`router.get(['/a', '/b'], h)`, very common for paired URLs).
      const paths = Array.isArray(layer.route.path)
        ? (layer.route.path as string[])
        : [layer.route.path as string];
      for (const rawPath of paths) {
        const full = (prefix + rawPath) || '/';
        for (const m of Object.keys(layer.route.methods || {})) {
          if (m === '_all') continue;
          out.push({ method: m.toUpperCase(), path: full });
        }
      }
    } else if (layer.handle?.stack) {
      let layerPrefix = prefix;
      if (layer.matchers?.[0]?.('/webhooks/notifications/whatsapp')) {
        layerPrefix = '/webhooks/notifications/whatsapp';
      }
      out.push(...walkRouter(layer.handle.stack, layerPrefix));
    }
  }
  return out;
}

export function extractAllRuntimeRoutes(): Array<{
  method: string;
  path: string;
  canon: string;
}> {
  const app = createApp() as Express & { router?: { stack: unknown } };
  const stack = app.router?.stack;
  if (!stack) {
    throw new Error('Could not access express router stack from createApp()');
  }
  return walkRouter(stack).map((r) => ({
    method: r.method,
    path: r.path,
    canon: normalizePath(r.path),
  }));
}

export function extractOpenApiOperations(
  spec: Record<string, any> = loadSpec(),
): Array<Record<string, any> & { method: string; path: string; canon: string }> {
  const out: Array<Record<string, any> & {
    method: string;
    path: string;
    canon: string;
  }> = [];
  const paths = (spec.paths as Record<string, Record<string, any>>) ?? {};
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      out.push({
        ...(op as Record<string, any>),
        method: method.toUpperCase(),
        path,
        canon: normalizePath(path),
      });
    }
  }
  return out;
}

/** Resolve a local `#/…` JSON pointer against the document. */
export function resolvePointer(
  doc: unknown,
  pointer: string,
): { found: boolean; value?: unknown } {
  if (!pointer.startsWith('#/')) return { found: false };
  const parts = pointer
    .slice(2)
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node: unknown = doc;
  for (const part of parts) {
    if (node === null || typeof node !== 'object') return { found: false };
    const record = node as Record<string, unknown>;
    if (!(part in record)) return { found: false };
    node = record[part];
  }
  return { found: true, value: node };
}

/**
 * Every local `$ref` in the document that cannot be resolved by pointer.
 * Only genuine breakage is reported (deep pointers are legal).
 */
export function findBrokenLocalRefs(
  spec: Record<string, any> = loadSpec(),
): string[] {
  const broken: string[] = [];
  const seen = new Set<string>();
  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const o = node as Record<string, unknown>;
    const ref = o['$ref'];
    if (typeof ref === 'string' && ref.startsWith('#') && !seen.has(ref)) {
      seen.add(ref);
      if (!resolvePointer(spec, ref).found) broken.push(ref);
    }
    for (const v of Object.values(o)) walk(v);
  }
  walk(spec);
  return broken.sort();
}
