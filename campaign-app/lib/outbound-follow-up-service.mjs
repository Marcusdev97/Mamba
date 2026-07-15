function clean(value) {
  return String(value ?? "").trim();
}

function dateMs(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function klDate(value = new Date()) {
  return new Date(value).toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
}

function startOfKLDayMs(value = new Date()) {
  return new Date(`${klDate(value)}T00:00:00+08:00`).getTime();
}

export function nextFollowUpAt(now = new Date()) {
  const date = new Date(`${klDate(now)}T10:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

export function isOutboundFollowUpCandidate(record, now = Date.now()) {
  const status = clean(record?.status).toLowerCase();
  const action = clean(record?.nextAction).toLowerCase();
  const sequence = clean(record?.sequenceStatus).toLowerCase();
  if (!record?.id || !record?.phone || !dateMs(record?.lastReplyAt)) return false;
  if (record.stopFlag || /stop|not interested|do not contact|invalid/.test(status)) return false;
  if (/done|completed|closed|stop/.test(action)) return false;
  if (sequence === "running") return false;
  const due = dateMs(record.followUpAt);
  return !due || klDate(due) <= klDate(now);
}

export function findHandledOutbound(records, messages, {
  normalizePhone,
  resolvePhone,
  messageTime,
  instanceName = "",
  now = Date.now(),
} = {}) {
  const candidates = new Map();
  for (const record of records || []) {
    if (!isOutboundFollowUpCandidate(record, now)) continue;
    const phone = normalizePhone(record.phone);
    if (!phone) continue;
    const existing = candidates.get(phone);
    if (!existing || dateMs(record.lastReplyAt) > dateMs(existing.lastReplyAt)) candidates.set(phone, record);
  }

  const handled = new Map();
  const todayStart = startOfKLDayMs(now);
  for (const message of messages || []) {
    if (!message?.key?.fromMe) continue;
    const phone = normalizePhone(resolvePhone(message));
    const record = phone && candidates.get(phone);
    if (!record) continue;
    if (record.senderInstance && instanceName && record.senderInstance !== instanceName) continue;
    const at = Number(messageTime(message) || 0);
    if (!at || at < todayStart || at <= dateMs(record.lastReplyAt)) continue;
    const previous = handled.get(record.id);
    if (!previous || at > previous.at) handled.set(record.id, { record, phone, message, at, instanceName });
  }
  return [...handled.values()];
}

export function createOutboundFollowUpService({
  blastDatabaseId,
  api,
  notion,
  openInstances,
  normalizePhone,
  collectMessageObjects,
  describeMessage,
  resolvePhone,
  messageTime,
  queryNotionRows,
  writeCache,
  history,
  systemLogs,
  intervalMs = 30 * 60 * 1000,
  initialDelayMs = 20 * 1000,
  onLog = (message) => console.log(message),
} = {}) {
  let timer = null;
  let initialTimer = null;
  let activeRun = null;
  let state = {
    running: false,
    intervalMinutes: Math.round(intervalMs / 60000),
    lastCheckedAt: null,
    nextCheckAt: null,
    checkedClients: 0,
    handled: 0,
    connections: 0,
    error: "",
  };

  function snapshot() {
    return { ...state };
  }

  function scheduleNext() {
    state.nextCheckAt = new Date(Date.now() + intervalMs).toISOString();
  }

  async function log(level, event, message, context = {}) {
    await systemLogs?.write({ level, area: "follow_up", event, message, context }).catch(() => {});
  }

  async function runOnce({ reason = "scheduled" } = {}) {
    if (activeRun) return activeRun;
    activeRun = (async () => {
      state = { ...state, running: true, error: "" };
      try {
        if (!blastDatabaseId) throw new Error("Notion Blast Leads database 没有配置。");
        const database = await notion("GET", `/databases/${blastDatabaseId}`);
        const schema = database?.properties || {};
        if (schema["Follow Up At"]?.type !== "date") {
          throw new Error("Notion 缺少 Follow Up At (date)。请先在 Follow-Up Desk 保存一次跟进动作来建立字段。");
        }

        const today = klDate();
        const records = await queryNotionRows({
          and: [
            { property: "Last Reply At", date: { is_not_empty: true } },
            { property: "Stop Flag", checkbox: { equals: false } },
            { or: [
              { property: "Follow Up At", date: { is_empty: true } },
              { property: "Follow Up At", date: { on_or_before: today } },
            ] },
          ],
        });
        const candidates = records.filter((record) => isOutboundFollowUpCandidate(record));
        const instances = (await openInstances()).filter((instance) => instance?.name);
        if (!instances.length) throw new Error("没有 OPEN 的 WhatsApp connection，无法核对手机回复。");

        const handledByPage = new Map();
        const connectionErrors = [];
        for (const instance of instances) {
          try {
            const response = await api(`/chat/findMessages/${encodeURIComponent(instance.name)}`, {
              method: "POST",
              body: JSON.stringify({ where: {} }),
            });
            const found = findHandledOutbound(candidates, collectMessageObjects(response), {
              normalizePhone,
              resolvePhone,
              messageTime,
              instanceName: instance.name,
            });
            for (const event of found) {
              const previous = handledByPage.get(event.record.id);
              if (!previous || event.at > previous.at) handledByPage.set(event.record.id, event);
            }
          } catch (error) {
            connectionErrors.push(`${instance.name}: ${error.message}`);
          }
        }
        if (connectionErrors.length === instances.length) throw new Error(`全部 WhatsApp connection 核对失败：${connectionErrors.join(" | ")}`);

        const followUpAt = nextFollowUpAt();
        let handled = 0;
        const failures = [];
        for (const event of handledByPage.values()) {
          try {
            await notion("PATCH", `/pages/${String(event.record.id).replace(/[^a-fA-F0-9]/g, "")}`, {
              properties: {
                "Follow Up At": { date: { start: followUpAt } },
                ...(schema["Reply Checked At"]?.type === "date"
                  ? { "Reply Checked At": { date: { start: new Date().toISOString() } } }
                  : {}),
              },
            });
            await history?.append(event.phone, {
              messageId: event.message?.key?.id || "",
              at: new Date(event.at).toISOString(),
              direction: "outbound",
              source: "outbound_follow_up_reconcile",
              text: describeMessage(event.message) || "[outbound message]",
              instanceName: event.instanceName,
              name: event.record.name || "",
              project: event.record.project || "",
            }).catch(() => {});
            handled += 1;
          } catch (error) {
            failures.push(`${event.record.name || event.phone}: ${error.message}`);
          }
        }

        if (handled) {
          const refreshed = await queryNotionRows(undefined);
          await writeCache(refreshed);
        }
        state = {
          ...state,
          running: false,
          lastCheckedAt: new Date().toISOString(),
          checkedClients: candidates.length,
          handled,
          connections: instances.length,
          error: failures.length ? `${failures.length} 位客户更新失败：${failures.slice(0, 3).join(" | ")}` : "",
        };
        scheduleNext();
        onLog(`[follow-up-sync] checked ${candidates.length}, phone replies handled ${handled}, reason=${reason}.`);
        await log(failures.length ? "warn" : "info", "outbound_follow_up_checked", "Checked sales replies sent from WhatsApp.", {
          reason,
          checkedClients: candidates.length,
          handled,
          connections: instances.map((instance) => instance.name),
          connectionErrors,
          failures,
          nextFollowUpAt: followUpAt,
        });
        return snapshot();
      } catch (error) {
        state = { ...state, running: false, lastCheckedAt: new Date().toISOString(), error: error.message || String(error) };
        scheduleNext();
        onLog(`[follow-up-sync:error] ${state.error}`);
        await log("warn", "outbound_follow_up_failed", "Could not check sales replies sent from WhatsApp.", { reason, error: state.error });
        return snapshot();
      } finally {
        activeRun = null;
      }
    })();
    return activeRun;
  }

  function start() {
    if (timer) return;
    scheduleNext();
    initialTimer = setTimeout(() => runOnce({ reason: "startup" }), initialDelayMs);
    initialTimer.unref?.();
    timer = setInterval(() => runOnce({ reason: "scheduled" }), intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (initialTimer) clearTimeout(initialTimer);
    if (timer) clearInterval(timer);
    initialTimer = null;
    timer = null;
    state.nextCheckAt = null;
  }

  return { runOnce, start, stop, snapshot };
}
