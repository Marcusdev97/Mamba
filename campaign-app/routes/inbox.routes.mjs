import { httpError, json } from "../lib/http.mjs";
import { loadSuppressionSync } from "../suppression.mjs";

// 聊天室（本机对话纪录）。跟 /api/conversations（读 Notion 的 lead 状态板）不同 ——
// 这里读的是本机 SQLite 里存的实际来回讯息：客户讲的 + 我们发的。
// 只收有回复过、没被 STOP 的客户。

function requireInbox(runtime) {
  if (!runtime.conversationLog) {
    throw httpError(503, "对话纪录服务尚未载入。请重启 Mamba。", "INBOX_UNAVAILABLE");
  }
  return runtime.conversationLog;
}

export function registerInboxRoutes(router) {
  // 分页的 tab：目前连接（OPEN）的号码。只有连着的才出现。
  router.get("/api/inbox/numbers", async (_req, res, runtime) => {
    let numbers = [];
    try {
      // openInstances 本来就只回 OPEN 的号码，不用再按 status 过滤。
      const open = await runtime.campaign?.openInstances?.();
      numbers = (open || [])
        .filter((item) => item?.name && item?.allowedOnThisDevice !== false)
        .map((item) => ({ instance: item.name, number: item.number || item.owner || "" }));
    } catch { /* 读不到号码就回空，前端显示「没有连接的号码」 */ }
    json(res, 200, { ok: true, numbers });
  });

  // 某个号码底下、有回复、非 STOP 的客户清单（带最后一条讯息预览）。
  router.get("/api/inbox/threads", async (req, res, runtime) => {
    const inbox = requireInbox(runtime);
    const url = new URL(req.url, "http://mamba.local");
    const instance = url.searchParams.get("instance") || "";
    // STOP 有两个来源：contacts.stop_flag（服务层已排）+ 全域抑制名单（这里排）。
    // 抑制名单才是真正会挡发送的那份，聊天室也不该显示。
    const { set: suppressed } = loadSuppressionSync();
    const threads = (await inbox.inboxThreads({ instance, limit: 400 }))
      .filter((t) => !suppressed.has(String(t.phone)));
    json(res, 200, { ok: true, instance, count: threads.length, threads });
  });

  // 一个客户的完整对话（来回交错，由旧到新）。
  router.get("/api/inbox/thread", async (req, res, runtime) => {
    const inbox = requireInbox(runtime);
    const url = new URL(req.url, "http://mamba.local");
    const phone = url.searchParams.get("phone") || "";
    if (!phone) throw httpError(400, "缺少客户号码。", "INBOX_PHONE_REQUIRED");
    const thread = await inbox.fullThread(phone, { limit: 800 });
    json(res, 200, { ok: true, ...thread });
  });
}
