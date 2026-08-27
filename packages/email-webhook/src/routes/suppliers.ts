import type { FastifyInstance } from "fastify";
import { headerValue, queryBool, requireAdmin } from "../auth.js";
import { isValidSupplierId, publicSupplier } from "../suppliers.js";

interface SupplierIn {
  supplier_id: string;
  name?: string;
  note?: string;
}

const supplierInSchema = {
  type: "object",
  required: ["supplier_id"],
  properties: {
    supplier_id: { type: "string", description: "供应商 ID，字母数字/下划线/短横，≤64 位" },
    name: { type: "string", default: "", description: "供应商名称" },
    note: { type: "string", default: "", description: "备注" },
  },
} as const;

/** 供应商（租户）管理 —— 仅平台管理员可用。 */
export async function registerSupplierRoutes(app: FastifyInstance): Promise<void> {
  /** 列出全部供应商。密钥只存哈希，不返回。 */
  app.get("/suppliers", async (request) => {
    const state = request.server.state;
    requireAdmin(state, headerValue(request.headers["x-admin-token"]));
    const [bindings, suppliers] = await Promise.all([
      state.bindings.all(),
      state.suppliers.all(),
    ]);
    const result = suppliers.map((supplier) => ({
      ...publicSupplier(supplier),
      bindings: bindings.filter((b) => b.supplier_id === supplier.supplier_id).length,
    }));
    return { count: result.length, suppliers: result };
  });

  /** 登记或更新一个供应商。supplier_id 不是凭据，这里只维护元信息。 */
  app.post<{ Body: SupplierIn }>(
    "/suppliers",
    { schema: { body: supplierInSchema } },
    async (request, reply) => {
      const state = request.server.state;
      requireAdmin(state, headerValue(request.headers["x-admin-token"]));
      const supplierId = request.body.supplier_id.trim();
      if (!isValidSupplierId(supplierId)) {
        return reply.code(400).send({ error: "invalid supplier_id" });
      }

      const existed = (await state.suppliers.get(supplierId)) !== null;
      const supplier = await state.suppliers.upsert(
        supplierId,
        (request.body.name ?? "").trim(),
        (request.body.note ?? "").trim(),
      );
      return { status: existed ? "updated" : "created", supplier: publicSupplier(supplier) };
    },
  );

  /** 删除供应商。名下还有绑定时默认拒绝，避免留下无主数据。 */
  app.delete<{ Params: { supplierId: string }; Querystring: { force?: string } }>(
    "/suppliers/:supplierId",
    async (request, reply) => {
      const state = request.server.state;
      requireAdmin(state, headerValue(request.headers["x-admin-token"]));
      const supplierId = request.params.supplierId;
      const force = queryBool(request.query.force);

      const owned = await state.bindings.allFor(supplierId);
      if (owned.length > 0 && !force) {
        return reply.code(409).send({
          error: "supplier still has bindings",
          count: owned.length,
          detail: "先转移或删除这些绑定，或加 ?force=true 一并删除",
        });
      }
      if (!(await state.suppliers.delete(supplierId))) {
        return reply.code(404).send({ error: "supplier not found" });
      }
      const removed = await state.bindings.deleteForSupplier(supplierId);
      return { status: "deleted", supplier_id: supplierId, bindings_removed: removed };
    },
  );
}
