#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildAppPackage, type AppPackage } from './index';

async function loadAppModule(entryPath: string): Promise<AppPackage> {
  const abs = resolve(process.cwd(), entryPath);
  const mod = (await import(pathToFileURL(abs).href)) as { default?: AppPackage; app?: AppPackage };
  const pkg = mod.default ?? mod.app;
  if (!pkg || typeof pkg !== 'object' || !('scope' in pkg)) {
    throw new Error(`Module ${entryPath} must export an AppPackage as default or named 'app'`);
  }
  return pkg;
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [cmd, ...rest] = argv;
  if (cmd === 'build') {
    const entry = rest[0] ?? 'apps/itsm/src/index.ts';
    const outFile = rest[1];
    const pkg = await loadAppModule(entry);
    const json = buildAppPackage(pkg);
    if (outFile) {
      writeFileSync(resolve(process.cwd(), outFile), json, 'utf8');
      console.log(`Built ${pkg.scope}@${pkg.version} -> ${outFile}`);
    } else {
      console.log(json);
    }
    return;
  }

  if (cmd === 'deploy') {
    const entry = rest[0] ?? 'apps/itsm/src/index.ts';
    const baseUrl = process.env.STEWARD_URL ?? 'http://localhost:3000';
    const token = process.env.STEWARD_TOKEN ?? '';
    const pkg = await loadAppModule(entry);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}/api/steward/apps/deploy`, {
      method: 'POST',
      headers,
      body: buildAppPackage(pkg),
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(`Deploy failed (${res.status}): ${JSON.stringify(body)}`);
    }
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  if (cmd === 'types') {
    const scope = rest[0] ?? '';
    const outFile = rest[1];
    const baseUrl = process.env.STEWARD_URL ?? 'http://localhost:3000';
    const token = process.env.STEWARD_TOKEN ?? '';
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    const url = scope
      ? `${baseUrl}/api/steward/apps/types?scope=${encodeURIComponent(scope)}`
      : `${baseUrl}/api/steward/apps/types`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`Type generation failed (${res.status}): ${await res.text()}`);
    }
    const dts = await res.text();
    if (outFile) {
      writeFileSync(resolve(process.cwd(), outFile), dts, 'utf8');
      console.log(`Generated TypeScript definitions -> ${outFile}`);
    } else {
      console.log(dts);
    }
    return;
  }

  console.log(
    [
      'Steward Pro-Code SDK CLI',
      'Usage:',
      '  steward build <entry.ts> [out.json]   Compile a TypeScript app definition to a package manifest',
      '  steward deploy <entry.ts>             Deploy an app package to STEWARD_URL',
      '  steward types [scope] [out.d.ts]      Generate TypeScript .d.ts definitions from live dictionary',
    ].join('\n'),
  );
}
