import { Router, type Request, type Response, type NextFunction } from 'express';
import type pg from 'pg';
import {
  TenantMachineAssertionError,
  verifyTenantMachineAssertion,
} from '../services/tenant-machine-assertion.js';

/** Server-to-server verifier. It returns only a boolean and never a tenant machine secret. */
export function createTenantMachineAssertionRoutes(
  pool: pg.Pool,
  serviceAuth: (req: Request, res: Response, next: NextFunction) => void,
) {
  const router = Router();
  router.post(
    '/v1/internal/tenant-machine-assertions/verify-whatsapp-binding',
    serviceAuth,
    async (req: Request, res: Response) => {
      try {
        const valid = await verifyTenantMachineAssertion(pool, req.body);
        res.json({ valid });
      } catch (error) {
        if (error instanceof TenantMachineAssertionError) {
          res.status(error.status).json({ code: error.code, valid: false });
          return;
        }
        console.error('tenant-machine assertion verification failed');
        res.status(503).json({ code: 'ASSERTION_VERIFIER_UNAVAILABLE', valid: false });
      }
    },
  );
  return router;
}
