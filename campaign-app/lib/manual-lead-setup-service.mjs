const LEAD_TYPES = Object.freeze([
  Object.freeze({
    key: "BLAST",
    label: "Blasting Leads",
    description: "正式 Project 客户；写入 Blast Leads，但不会自动加入正在运行的 Campaign。",
    requiresProject: true,
    notion: true,
  }),
  Object.freeze({
    key: "RECYCLE",
    label: "Recycle Leads",
    description: "电话名单、旧客户或需要再次跟进的客户。",
    requiresProject: false,
    notion: true,
  }),
  Object.freeze({
    key: "ADS",
    label: "Ads Leads",
    description: "来自广告、Click-to-WhatsApp 或新 enquiry。",
    requiresProject: false,
    notion: true,
  }),
  Object.freeze({
    key: "OWN",
    label: "Own Leads",
    description: "自己的私有客户；只保存在本机，不进入 Notion 或 Campaign。",
    requiresProject: false,
    notion: false,
  }),
]);

function clean(value) {
  return String(value ?? "").trim();
}

function serviceError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function klDate(iso) {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
}

function klTime(iso) {
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: "Asia/Kuala_Lumpur",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function listManualLeadTypes() {
  return LEAD_TYPES.map((item) => ({ ...item }));
}

export function createManualLeadSetupService({
  localDatabase,
  conversationLog,
  notionSync,
  loadProjects,
} = {}) {
  async function projects() {
    const rows = await loadProjects?.();
    return (rows || []).map((project) => ({
      id: clean(project?.id),
      name: clean(project?.name),
    })).filter((project) => project.id && project.name);
  }

  async function setup({
    phone,
    name = "",
    leadType,
    projectId = "",
    instanceName,
    note = "",
  } = {}) {
    if (!localDatabase?.setupManualLead || !localDatabase?.markManualLeadNotionSync || !conversationLog?.prepareManualContact) {
      throw serviceError(503, "客户 Setup service 尚未载入。请重启 Mamba。");
    }
    const type = LEAD_TYPES.find((item) => item.key === clean(leadType).toUpperCase());
    if (!type) throw serviceError(400, "请选择客户类型。");

    let project = null;
    if (type.requiresProject) {
      const available = await projects();
      project = available.find((item) => item.id === clean(projectId)) || null;
      if (!project) throw serviceError(400, "Blasting Lead 必须选择有效的 Project。");
    }

    const local = await localDatabase.setupManualLead({
      phone,
      name,
      leadType: type.key,
      projectCode: project?.id || "",
      projectName: project?.name || "",
      instanceName,
      note,
    });
    await conversationLog.prepareManualContact({
      phone: local.phone,
      name: local.name,
      instanceName: local.instanceName,
    });

    if (!type.notion) {
      return {
        ...local,
        typeLabel: type.label,
        notionSyncStatus: "LOCAL_ONLY",
        notice: "Own Lead 已保存到本机数据库，不会加入 Campaign 或 Notion。",
      };
    }

    if (!notionSync?.enabled) {
      await localDatabase.markManualLeadNotionSync({
        originKey: local.originKey,
        status: "FAILED",
        error: "Notion sync is not configured.",
      });
      return {
        ...local,
        typeLabel: type.label,
        notionSyncStatus: "FAILED",
        warning: "客户已安全保存到本机，但 Notion 尚未连接；重新 Setup 同一个客户即可补同步。",
      };
    }

    try {
      let result;
      if (type.key === "BLAST") {
        result = await notionSync.upsertManualBlastLead({
          ...local,
          note: clean(note),
        });
      } else if (type.key === "ADS") {
        result = await notionSync.upsertAdLead({
          id: `manual_ads_${local.phone}_${local.createdAt}`,
          phone: local.phone,
          name: local.name,
          receivedAt: local.createdAt,
          text: clean(note) || "Manual Chat Room setup after call",
          touchType: "Call",
          nextAction: "Follow Up",
        });
      } else {
        result = await notionSync.upsertRecycleLead({
          phone: local.phone,
          name: local.name,
          leadStatus: "Follow Up",
          recycleCategory: "Follow Up",
          blastEligible: false,
          hasCallActivity: true,
          callDate: klDate(local.createdAt),
          callTime: klTime(local.createdAt),
          lastCallOutcome: "Other",
          followUpDue: klDate(local.createdAt),
          nextAction: "Call Again",
          remark: clean(note) || "Manual Chat Room setup after call",
          aiSummary: "",
          sourceBatch: "manual_chat",
          importedAt: local.createdAt,
          importFile: "",
        });
      }
      if (result?.action === "already_stopped" || result?.protectedDoNotCall) {
        await localDatabase.markManualLeadNotionSync({
          originKey: local.originKey,
          status: "FAILED",
          notionPageId: result?.pageId || "",
          error: "Notion lead is already Do Not Contact.",
        });
        return {
          ...local,
          typeLabel: type.label,
          notionSyncStatus: "FAILED",
          warning: "客户已保存到本机，但 Notion 里的客户是 Do Not Contact，系统没有重新启用。",
        };
      }
      await localDatabase.markManualLeadNotionSync({
        originKey: local.originKey,
        status: "SYNCED",
        notionPageId: result?.pageId || "",
      });
      return {
        ...local,
        typeLabel: type.label,
        notionSyncStatus: "SYNCED",
        notionAction: result?.action || "updated",
        notice: `${type.label} 已保存到本机并同步 Notion。`,
      };
    } catch (error) {
      await localDatabase.markManualLeadNotionSync({
        originKey: local.originKey,
        status: "FAILED",
        error: error.message,
      }).catch(() => {});
      return {
        ...local,
        typeLabel: type.label,
        notionSyncStatus: "FAILED",
        warning: `客户已安全保存到本机，但 Notion 同步失败：${error.message}`,
      };
    }
  }

  return {
    listTypes: listManualLeadTypes,
    projects,
    setup,
  };
}
