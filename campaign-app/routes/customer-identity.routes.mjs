import { httpError, json, readJson } from "../lib/http.mjs";

function repository(runtime) {
  if (!runtime.customerIdentity) {
    throw httpError(503, "Customer Identity repository 尚未载入。", { code: "CUSTOMER_IDENTITY_UNAVAILABLE" });
  }
  return runtime.customerIdentity;
}

function requireText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw httpError(400, `缺少 ${label}。`, { code: "CUSTOMER_IDENTITY_INPUT_REQUIRED", field: label });
  return text;
}

async function mutation(action) {
  try {
    return await action();
  } catch (error) {
    if (error.code?.includes("ACTIVE_CAMPAIGN") || error.code?.includes("CONFIRMATION") || error.code?.includes("MERGE_") || error.code?.startsWith("IDENTITY_CONFLICT_")) {
      error.statusCode = 409;
    }
    throw error;
  }
}

export function registerCustomerIdentityRoutes(router) {
  router.get("/api/customer-identity/status", async (_req, res, runtime) => {
    const repo = repository(runtime);
    const schema = await repo.schemaStatus();
    const activeCampaigns = schema.ready ? await repo.activeCampaigns() : [];
    json(res, 200, { ok: true, schema, activeCampaigns, mutationsBlocked: activeCampaigns.length > 0 });
  });

  router.get("/api/customer-identity/customers", async (req, res, runtime) => {
    const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
    const records = await repository(runtime).listCustomers({
      query: url.searchParams.get("q") || "",
      limit: url.searchParams.get("limit") || 100,
    });
    json(res, 200, { ok: true, records, count: records.length });
  });

  router.get("/api/customer-identity/customer", async (req, res, runtime) => {
    const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
    const customerId = requireText(url.searchParams.get("customerId"), "customerId");
    const record = await repository(runtime).customerDetail(customerId);
    if (!record) throw httpError(404, "找不到 customer。", { code: "CUSTOMER_NOT_FOUND" });
    json(res, 200, { ok: true, record });
  });

  router.get("/api/customer-identity/conflicts", async (req, res, runtime) => {
    const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
    const records = await repository(runtime).listConflicts({
      status: url.searchParams.get("status") || "OPEN",
      limit: url.searchParams.get("limit") || 100,
    });
    json(res, 200, { ok: true, records, count: records.length });
  });

  router.post("/api/customer-identity/conflicts/resolve", async (req, res, runtime) => {
    const body = await readJson(req);
    const conflictId = requireText(body.conflictId, "conflictId");
    const result = await mutation(() => repository(runtime).resolveConflict(conflictId, {
      action: requireText(body.action, "action"),
      resolvedCustomerId: body.resolvedCustomerId || "",
      resolvedBy: body.resolvedBy || "local_operator",
    }));
    if (!result) throw httpError(404, "找不到 identity conflict。", { code: "IDENTITY_CONFLICT_NOT_FOUND" });
    json(res, 200, { ok: true, result });
  });

  router.post("/api/customer-identity/merge/plan", async (req, res, runtime) => {
    const body = await readJson(req);
    const result = await repository(runtime).mergePlan({
      survivingCustomerId: requireText(body.survivingCustomerId, "survivingCustomerId"),
      duplicateCustomerId: requireText(body.duplicateCustomerId, "duplicateCustomerId"),
    });
    json(res, 200, { ok: true, result, dryRun: true });
  });

  router.post("/api/customer-identity/merge/apply", async (req, res, runtime) => {
    const body = await readJson(req);
    const result = await mutation(() => repository(runtime).applyMerge({
      survivingCustomerId: requireText(body.survivingCustomerId, "survivingCustomerId"),
      duplicateCustomerId: requireText(body.duplicateCustomerId, "duplicateCustomerId"),
      confirmation: body.confirmation || "",
      reason: body.reason || "",
      createdBy: body.createdBy || "local_operator",
    }));
    json(res, 200, { ok: true, result });
  });

  router.post("/api/customer-identity/merge/reverse", async (req, res, runtime) => {
    const body = await readJson(req);
    const result = await mutation(() => repository(runtime).reverseMerge(requireText(body.mergeId, "mergeId"), {
      confirmation: body.confirmation || "",
      reversedBy: body.reversedBy || "local_operator",
    }));
    if (!result) throw httpError(404, "找不到可还原的 merge。", { code: "CUSTOMER_MERGE_NOT_FOUND" });
    json(res, 200, { ok: true, result });
  });
}
