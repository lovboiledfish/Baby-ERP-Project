import { Instance } from '@steward/kernel';
import path from 'node:path';
import { buildApp } from './app';

const dataDirSetting = process.env.STEWARD_DATA_DIR ?? '.data/instance';
const baseDir = process.env.INIT_CWD ?? process.cwd();
const dataDir = dataDirSetting === 'memory' ? undefined : path.resolve(baseDir, dataDirSetting);
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';

const instance = await Instance.create({ dataDir, adminPassword: process.env.STEWARD_ADMIN_PASSWORD || undefined });
const app = await buildApp(instance, { logger: true });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await instance.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port, host });
app.log.info(`Steward instance ready (data: ${dataDir ?? 'in-memory'})`);
if (instance.generatedAdminPassword) {
  app.log.warn(
    `Generated a password for user "admin": ${instance.generatedAdminPassword}  ` +
      '(shown once; change it via PATCH /api/now/table/sys_user/<sys_id> {"user_password": "..."} or set STEWARD_ADMIN_PASSWORD on first boot)',
  );
}
