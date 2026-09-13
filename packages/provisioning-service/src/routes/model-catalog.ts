import { Router, type NextFunction, type Request, type Response } from 'express';
import type pg from 'pg';
import type { ProvisioningConfig } from '../config.js';
import { actorFromRequest } from '../services/audit.js';
import { decryptValue } from '../services/crypto.js';
import { importLegacyCatalog } from '../services/model-catalog-import.js';
import { CatalogRepository, CatalogService, snapshotFingerprint } from '../services/model-catalog.js';
import { enqueueLlmPush } from '../services/llm-push-task.js';
import { getGlobalLlmProviders, LLM_PROVIDERS_KEY, validateLlmProviders } from '../services/llm-providers.js';
import { upsertRuntimeConfig, validateConfigValue } from '../services/runtime-config.js';

function disabled(res: Response): void {
  res.status(503).json({ code: 'DISABLED', message: 'Model catalog feature is disabled' });
}

function redactSnapshot(snapshot: Awaited<ReturnType<CatalogService['buildCompatibilitySnapshot']>>) {
  return {
    ...snapshot,
    providers: snapshot.providers.map(({ apiKey: _apiKey, ...provider }) => ({ ...provider, hasApiKey: true })),
  };
}

/** Admin routes for the P0 shadow catalog and explicit compatibility publishing. */
export function createModelCatalogRoutes(
  pool: pg.Pool,
  config: ProvisioningConfig,
  authMiddleware?: (req: Request, res: Response, next: NextFunction) => void,
) {
  const router = Router();
  if (authMiddleware) router.use(authMiddleware);
  const repository = new CatalogRepository(pool);
  const service = new CatalogService(repository);

  router.post('/v1/admin/model-catalog/import', async (req, res) => {
    if (config.modelCatalogShadowImport !== true) return disabled(res);
    if (typeof req.body?.dryRun !== 'boolean') {
      res.status(400).json({ code: 'VALIDATION', message: 'dryRun must be boolean' });
      return;
    }
    try {
      const { actor } = actorFromRequest(req);
      res.json(await importLegacyCatalog(pool, { dryRun: req.body.dryRun, actor }));
    } catch (error) {
      res.status(422).json({ code: 'IMPORT_FAILED', message: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/v1/admin/model-catalog/providers', async (_req, res) => {
    if (config.modelCatalogRead !== true) return disabled(res);
    res.json({ providers: await repository.listProviders() });
  });

  router.get('/v1/admin/model-catalog/providers/:id/models', async (req, res) => {
    if (config.modelCatalogRead !== true) return disabled(res);
    res.json({ models: await repository.listModels(req.params.id) });
  });

  router.get('/v1/admin/model-catalog/snapshot-preview', async (_req, res) => {
    if (config.modelCatalogRead !== true) return disabled(res);
    try {
      const legacy = await getGlobalLlmProviders(pool);
      const snapshot = await service.buildCompatibilitySnapshot(legacy);
      const diff = await service.diffCompatibilitySnapshot(legacy ?? {
        providers: [], defaultModel: null, imageModel: null, compactionModel: null, fallbackModels: [],
      });
      res.json({ snapshot: redactSnapshot(snapshot), fingerprint: snapshotFingerprint(snapshot), diff });
    } catch (error) {
      res.status(422).json({ code: 'SNAPSHOT_INVALID', message: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/v1/admin/model-catalog/snapshot-restore', async (req, res) => {
    if (config.modelCatalogSnapshotWrite !== true) return disabled(res);
    const backupId = typeof req.body?.backupId === 'string' ? req.body.backupId : '';
    if (!backupId) {
      res.status(400).json({ code: 'VALIDATION', message: 'backupId is required' });
      return;
    }
    try {
      const backup = await pool.query('SELECT encrypted_value FROM llm_catalog_snapshot_backups WHERE id=$1', [backupId]);
      if (!backup.rows[0]) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Snapshot backup not found' });
        return;
      }
      const previous = await getGlobalLlmProviders(pool);
      const restored = validateLlmProviders(JSON.parse(decryptValue(backup.rows[0].encrypted_value)));
      const blob = JSON.stringify(restored);
      validateConfigValue(blob);
      const { actor, actorType } = actorFromRequest(req);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const current = await client.query(
          `SELECT id,encrypted_value FROM runtime_configs WHERE tenant_id IS NULL AND config_key=$1 FOR UPDATE`,
          [LLM_PROVIDERS_KEY],
        );
        if (current.rows[0]) await client.query(
          `INSERT INTO llm_catalog_snapshot_backups
             (id,runtime_config_id,encrypted_value,source_fingerprint,actor)
           VALUES (gen_random_uuid(),$1,$2,$3,$4)`,
          [current.rows[0].id,current.rows[0].encrypted_value,snapshotFingerprint(previous ?? { providers:[],defaultModel:null,imageModel:null,compactionModel:null,fallbackModels:[] }),actor],
        );
        await upsertRuntimeConfig(client,{tenantId:null,key:LLM_PROVIDERS_KEY,value:blob,isSecret:true,description:'模型目录快照恢复'});
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
      const task=await enqueueLlmPush(pool,{kind:'global_push',scope:null,trigger:'retry',prevLibrary:previous,nextLibrary:restored,actor,actorType:actorType==='external'?'service':actorType});
      res.json({ok:true,...task,streamUrl:`/v1/admin/llm-push-tasks/${task.taskId}/stream`});
    } catch (error) {
      res.status(500).json({code:'INTERNAL',message:error instanceof Error?error.message:String(error)});
    }
  });

  router.post('/v1/admin/model-catalog/snapshot-publish', async (req, res) => {
    if (config.modelCatalogSnapshotWrite !== true) return disabled(res);
    const expectedFingerprint = typeof req.body?.fingerprint === 'string' ? req.body.fingerprint : '';
    if (!expectedFingerprint) {
      res.status(400).json({ code: 'VALIDATION', message: 'fingerprint is required' });
      return;
    }
    try {
      const previous = await getGlobalLlmProviders(pool);
      const next = validateLlmProviders(await service.buildCompatibilitySnapshot(previous));
      const actualFingerprint = snapshotFingerprint(next);
      if (actualFingerprint !== expectedFingerprint) {
        res.status(409).json({ code: 'FINGERPRINT_MISMATCH', message: 'Catalog changed after preview', details: { actualFingerprint } });
        return;
      }
      const blob = JSON.stringify(next);
      validateConfigValue(blob);
      const { actor, actorType } = actorFromRequest(req);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const current = await client.query(
          `SELECT id, encrypted_value FROM runtime_configs
            WHERE tenant_id IS NULL AND config_key=$1 FOR UPDATE`,
          [LLM_PROVIDERS_KEY],
        );
        if (current.rows[0]) {
          await client.query(
            `INSERT INTO llm_catalog_snapshot_backups
               (id,runtime_config_id,encrypted_value,source_fingerprint,actor)
             VALUES (gen_random_uuid(),$1,$2,$3,$4)`,
            [current.rows[0].id, current.rows[0].encrypted_value, actualFingerprint, actor],
          );
        }
        await upsertRuntimeConfig(client, {
          tenantId: null, key: LLM_PROVIDERS_KEY, value: blob, isSecret: true,
          description: '模型目录显式发布的兼容快照',
        });
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      const task = await enqueueLlmPush(pool, {
        kind: 'global_push', scope: null, trigger: 'save',
        prevLibrary: previous, nextLibrary: next, actor,
        actorType: actorType === 'external' ? 'service' : actorType,
      });
      res.json({ ok: true, ...task, streamUrl: `/v1/admin/llm-push-tasks/${task.taskId}/stream` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message.includes('too long') ? 422 : 500).json({ code: message.includes('too long') ? 'SNAPSHOT_TOO_LARGE' : 'INTERNAL', message });
    }
  });

  return router;
}
