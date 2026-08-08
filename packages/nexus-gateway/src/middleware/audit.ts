import type { Request, Response, NextFunction } from 'express';

/**
 * Simple audit log middleware.
 * Logs every request to stdout in structured JSON format.
 * In production: write to audit_log PostgreSQL table via credits-ledger API.
 */
export function auditMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();

  // Capture response finish
  res.on('finish', () => {
    const entry = {
      timestamp: new Date().toISOString(),
      tenantId: (req as any).tenantContext?.tenantId ?? 'unknown',
      userId: (req as any).tenantContext?.userId ?? 'unknown',
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - start,
      ip: req.ip,
    };
    // Structured JSON to stdout — can be shipped to log aggregator
    console.log(JSON.stringify({ type: 'audit', ...entry }));
  });

  next();
}
