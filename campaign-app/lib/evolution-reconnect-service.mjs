function clean(value) {
  return String(value ?? "").trim();
}

function instanceStatus(instance) {
  return clean(instance?.status ?? instance?.connectionStatus ?? instance?.instance?.state).toUpperCase() || "UNKNOWN";
}

function isDisconnectedStatus(status) {
  return ["CLOSE", "CLOSED", "DISCONNECTED", "LOGGED_OUT", "LOGGEDOUT"].includes(status);
}

function reconnectError(statusCode, message, code, details = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = { code, ...details };
  return error;
}

export function createEvolutionReconnectService({
  listInstances,
  logoutInstanceSession,
  requestQr,
}) {
  if (!listInstances || !logoutInstanceSession || !requestQr) {
    throw new Error("Evolution reconnect service 缺少必要 dependency。");
  }

  async function readInstances(action) {
    try {
      const items = await listInstances();
      return Array.isArray(items) ? items : [];
    } catch (error) {
      throw reconnectError(
        503,
        `${action}失败：Evolution API 暂时无法读取号码状态。请确认 Docker 与 Evolution 已启动后再试。`,
        "EVOLUTION_INSTANCE_LIST_FAILED",
        { cause: error.message },
      );
    }
  }

  return {
    async begin({ instanceName, isCampaignRunning = false } = {}) {
      const name = clean(instanceName);
      if (!name) throw reconnectError(400, "缺少要重新连接的号码标签。", "EVOLUTION_INSTANCE_REQUIRED");
      if (isCampaignRunning) {
        throw reconnectError(
          409,
          "Campaign 正在发送，不能重置 WhatsApp session。请先安全停止 Campaign，再重新扫码。",
          "CAMPAIGN_RUNNING",
        );
      }

      const before = await readInstances(`检查 ${name}`);
      const target = before.find((item) => clean(item?.name ?? item?.instance?.instanceName) === name);
      if (!target) {
        throw reconnectError(404, `Evolution 找不到 ${name}。请刷新号码清单后再试。`, "EVOLUTION_INSTANCE_NOT_FOUND");
      }
      if (target.allowedOnThisDevice === false) {
        throw reconnectError(
          403,
          `${name} 不属于这台 Mamba 装置，不能在这里重置 session。`,
          "EVOLUTION_INSTANCE_DEVICE_BLOCKED",
        );
      }

      const previousStatus = instanceStatus(target);
      if (previousStatus === "OPEN") {
        throw reconnectError(
          409,
          `${name} 目前仍是 OPEN，不需要重新扫码。若手机显示 Restricted，请先处理 WhatsApp 账号限制；重新扫码不能解除限制。`,
          "EVOLUTION_INSTANCE_ALREADY_OPEN",
        );
      }

      let logoutRecovered = false;
      try {
        // Logout clears stale Baileys credentials but deliberately keeps the
        // Evolution instance record and Mamba's stable connection key intact.
        await logoutInstanceSession(name);
      } catch (logoutError) {
        // Evolution v2 can report an error after the session was already closed.
        // Only continue when a fresh status read proves it is no longer OPEN.
        const afterLogout = await readInstances(`确认 ${name} 已登出`);
        const current = afterLogout.find((item) => clean(item?.name ?? item?.instance?.instanceName) === name);
        if (!current || !isDisconnectedStatus(instanceStatus(current))) {
          throw reconnectError(
            503,
            `${name} 的旧 session 无法安全清除。没有删除 instance，请稍后再试。`,
            "EVOLUTION_LOGOUT_FAILED",
            { cause: logoutError.message },
          );
        }
        logoutRecovered = true;
      }

      let qr = null;
      let qrError = null;
      try {
        qr = await requestQr(name);
      } catch (error) {
        // The destructive portion (session logout) has already completed. Return
        // a pending result so Settings keeps the QR panel open and can poll the
        // normal connect endpoint without logging out the same instance again.
        qrError = clean(error?.message) || "Evolution 暂时无法生成二维码。";
      }

      return {
        instanceName: name,
        previousStatus,
        qr: qr || null,
        pending: !qr,
        qrError,
        sessionReset: true,
        instancePreserved: true,
        logoutRecovered,
      };
    },
  };
}
