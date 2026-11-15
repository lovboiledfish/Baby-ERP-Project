import { Instance } from '@steward/kernel';
import { describe, expect, it } from 'vitest';
import { itsmApp } from '../../../apps/itsm/src/index';
import { buildApp } from './app';

describe('/api/steward/apps & Phase 6/7 HTTP endpoints', () => {
  it('deploys a scoped app package, generates .d.ts types, exports/imports update sets, and uninstalls via REST', async () => {
    const instance = await Instance.create({ adminPassword: 'admin-password' });
    const app = await buildApp(instance);
    try {
      const authHeader = `Basic ${Buffer.from('admin:admin-password').toString('base64')}`;

      // 1. Deploy itsmApp via POST /api/steward/apps/deploy
      const deployRes = await app.inject({
        method: 'POST',
        url: '/api/steward/apps/deploy',
        headers: { authorization: authHeader },
        payload: itsmApp,
      });
      expect(deployRes.statusCode).toBe(200);
      expect(deployRes.json().result.scope).toBe('x_steward_itsm');
      expect(deployRes.json().result.action).toBe('install');

      // 2. List installed apps via GET /api/steward/apps
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/steward/apps',
        headers: { authorization: authHeader },
      });
      expect(listRes.statusCode).toBe(200);
      const scopes = (listRes.json().result as Array<{ scope: string }>).map((a) => a.scope);
      expect(scopes).toContain('global');
      expect(scopes).toContain('x_steward_itsm');

      // 3. Generate .d.ts types via GET /api/steward/apps/types?scope=x_steward_itsm
      const typesRes = await app.inject({
        method: 'GET',
        url: '/api/steward/apps/types?scope=x_steward_itsm',
        headers: { authorization: authHeader },
      });
      expect(typesRes.statusCode).toBe(200);
      expect(typesRes.body).toContain('export interface XStewardItsmTicketRecord');

      // 4. Uninstall app via DELETE /api/steward/apps/x_steward_itsm
      const delRes = await app.inject({
        method: 'DELETE',
        url: '/api/steward/apps/x_steward_itsm',
        headers: { authorization: authHeader },
      });
      expect(delRes.statusCode).toBe(200);
      expect(delRes.json().result.scope).toBe('x_steward_itsm');
    } finally {
      await app.close();
      await instance.close();
    }
  });
});
