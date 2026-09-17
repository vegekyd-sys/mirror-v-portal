import { Router, type RequestHandler } from 'express';
import { createSystemAgentService, SystemAgentError } from '../services/system-agent.js';

export function createSystemAgentRoutes(auth: RequestHandler, service = createSystemAgentService()) {
  const router = Router();
  router.use(auth);
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const handle = (fn: (req: any) => Promise<unknown>): RequestHandler => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (e) { res.status(e instanceof SystemAgentError ? e.status : 500).json({
      code: 'SYSTEM_AGENT_ERROR', message: e instanceof SystemAgentError ? e.message : 'Nexus Manager 操作失败',
    }); }
  };
  router.get('/', handle(() => service.status()));
  router.get('/logs', handle(req => service.logs(String(req.query.pod || ''), req.query.previous === 'true')));
  for (const action of ['start', 'stop', 'restart']) {
    router.post(`/${action}`, handle(req => service.action(action, req.body?.version)));
  }
  return router;
}
