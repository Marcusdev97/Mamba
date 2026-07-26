import { httpError, json, readJson } from "../lib/http.mjs";
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
    const filter = url.searchParams.get("filter") === "pending" ? "pending" : "all";
    // 分页选的是「号码」，不是「wa_01 这个标签」。同一支号码以前在 Evolution 上
    // 叫过 wa_02 / wa_03 的那段对话，也要一起显示 —— 换标签不该让客户消失。
    const instances = runtime.instanceIdentity
      ? await runtime.instanceIdentity.siblingInstances(instance).catch(() => [instance])
      : [instance];
    // STOP 有两个来源：contacts.stop_flag（服务层已排）+ 全域抑制名单（这里排）。
    // 抑制名单才是真正会挡发送的那份，聊天室也不该显示。
    const { set: suppressed } = loadSuppressionSync();
    const threads = (await inbox.inboxThreads({ instance: instances, limit: 500, filter }))
      .filter((t) => !suppressed.has(String(t.phone)));
    json(res, 200, { ok: true, instance, instances, filter, count: threads.length, threads });
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

  // ---------- 互动：手动回复 / 发图 / 看客户的图 ----------
  //
  // 这是**人**在聊天室手动发的，不受 Sales Brain 自动回复开关影响 —— 大脑关着
  // 也能手动回客户。

  function requireSend(runtime) {
    if (!runtime.inboxSend) throw httpError(503, "聊天室发送功能尚未启用。请重启 Mamba。", "INBOX_SEND_UNAVAILABLE");
    return runtime.inboxSend;
  }

  router.post("/api/inbox/send", async (req, res, runtime) => {
    const send = requireSend(runtime);
    const body = await readJson(req);
    const result = await send.sendText({ instance: body?.instance, phone: body?.phone, text: body?.text });
    json(res, 200, { ok: true, ...result });
  });

  router.post("/api/inbox/send-image", async (req, res, runtime) => {
    const send = requireSend(runtime);
    const body = await readJson(req);
    const result = await send.sendImage({
      instance: body?.instance, phone: body?.phone,
      imageDataUrl: body?.image, caption: body?.caption,
    });
    json(res, 200, { ok: true, ...result });
  });

  // ---------- 一键从 Evolution 同步完整历史进 SQL ----------
  //
  // 觉得聊天室数据不全时按一下。要几分钟（拉两三万条历史），所以在背景跑，
  // 前端轮询进度。幂等，重复跑安全。

  router.post("/api/inbox/sync-history", async (req, res, runtime) => {
    if (!runtime.historySync) throw httpError(503, "历史同步功能尚未启用。请重启 Mamba。", "HISTORY_SYNC_UNAVAILABLE");
    const state = runtime.historySync.state();
    if (state.running) { json(res, 200, { ok: true, alreadyRunning: true, ...state }); return; }
    runtime.historySync.start();   // 不 await —— 背景跑
    json(res, 200, { ok: true, started: true, ...runtime.historySync.state() });
  });

  router.get("/api/inbox/sync-history/status", async (_req, res, runtime) => {
    if (!runtime.historySync) throw httpError(503, "历史同步功能尚未启用。", "HISTORY_SYNC_UNAVAILABLE");
    json(res, 200, { ok: true, ...runtime.historySync.state() });
  });

  // 按需抓客户发来的一张图。找不到就回 available:false，前端显示占位。
  router.get("/api/inbox/media", async (req, res, runtime) => {
    const send = requireSend(runtime);
    const url = new URL(req.url, "http://mamba.local");
    const result = await send.fetchInboundMedia({
      instance: url.searchParams.get("instance") || "",
      phone: url.searchParams.get("phone") || "",
      messageId: url.searchParams.get("messageId") || "",
    });
    json(res, 200, { ok: true, ...result });
  });
}
