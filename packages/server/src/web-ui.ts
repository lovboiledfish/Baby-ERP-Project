import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Pages are same-origin only: no inline scripts, no framing, no third-party resources. */
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
};

/** Resolve a URL path inside `root`, or null if it escapes it or is not a file. */
export function resolveStatic(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]!);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const full = path.resolve(root, '.' + path.posix.normalize('/' + decoded.replaceAll('\\', '/')));
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try {
    return statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

/**
 * Serve the built SPA (packages/web/dist): real files as-is, and index.html for
 * every other GET that is not an API route, so deep links such as
 * /incident_list.do?sysparm_query=... and /incident.do?sys_id=... work.
 */
export function registerWebUi(app: FastifyInstance, root: string): void {
  const absRoot = path.resolve(root);
  const index = path.join(absRoot, 'index.html');
  if (!existsSync(index)) throw new Error(`Web UI not built: ${index} is missing (run npm run build -w @steward/web)`);

  const send = async (reply: FastifyReply, file: string) => {
    const ext = path.extname(file).toLowerCase();
    reply.headers(SECURITY_HEADERS).header('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
    // Vite fingerprints assets, so they can be cached forever; index.html must always be revalidated.
    reply.header('Cache-Control', path.relative(absRoot, file).startsWith(`assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
    return reply.send(await readFile(file));
  };

  app.setNotFoundHandler(async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url;
    if ((req.method !== 'GET' && req.method !== 'HEAD') || url.startsWith('/api/') || url === '/api') {
      return reply.status(404).send({ error: { message: `Route ${req.method} ${url.split('?')[0]} not found`, detail: null }, status: 'failure' });
    }
    const file = resolveStatic(absRoot, url);
    return send(reply, file ?? index);
  });
}
