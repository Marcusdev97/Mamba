(() => {
  const STYLE_ID = "mamba-live-recipient-risk-style";
  const MODAL_ID = "mamba-live-recipient-risk-modal";

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[char]));
  }

  function displayTime(value) {
    if (!value) return "时间不详";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return String(value);
    return date.toLocaleString("en-MY", {
      timeZone: "Asia/Kuala_Lumpur",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  function formatRequestError(error, { action = "执行 LIVE 检查" } = {}) {
    const status = Number(error?.status || error?.httpStatus || 0);
    const message = String(error?.message || error || "").trim();
    if (status === 404 || /^not found$/i.test(message)) {
      return `当前 Mamba Server 还是更新前的版本，暂时没有发送前风险检查接口。${action}已安全停止，没有发送 WhatsApp。请等正在运行的 Campaign 完成后重启 Mamba，再重新确认。`;
    }
    return `${action}失败：${message || "未知错误"}`;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .mamba-risk-backdrop{position:fixed;inset:0;z-index:10050;display:grid;place-items:center;padding:22px;background:rgba(3,7,18,.82);backdrop-filter:blur(8px)}
      .mamba-risk-dialog{width:min(720px,calc(100vw - 44px));max-height:min(820px,calc(100vh - 44px));overflow:auto;border:1px solid #334155;border-radius:14px;background:#111827;color:#e5e7eb;box-shadow:0 30px 90px rgba(0,0,0,.55)}
      .mamba-risk-head{display:flex;gap:14px;align-items:flex-start;padding:22px 22px 16px;border-bottom:1px solid #273449}
      .mamba-risk-icon{display:grid;place-items:center;width:42px;height:42px;flex:0 0 42px;border-radius:50%;background:#35250d;color:#fbbf24;font-size:20px}
      .mamba-risk-head h2{margin:0;color:#f8fafc;font-size:20px}
      .mamba-risk-head p{margin:6px 0 0;color:#94a3b8;font-size:13px;line-height:1.55}
      .mamba-risk-body{padding:18px 22px}
      .mamba-risk-counts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:16px}
      .mamba-risk-count{padding:10px;border:1px solid #2b394d;border-radius:9px;background:#0f172a}
      .mamba-risk-count span{display:block;color:#94a3b8;font-size:10.5px}
      .mamba-risk-count b{display:block;margin-top:3px;color:#f8fafc;font-size:19px}
      .mamba-risk-section{margin-top:12px;border:1px solid #334155;border-radius:10px;overflow:hidden}
      .mamba-risk-section.danger{border-color:#7f1d1d}.mamba-risk-section.warn{border-color:#854d0e}
      .mamba-risk-section h3{margin:0;padding:10px 12px;background:#172033;color:#e2e8f0;font-size:12.5px}
      .mamba-risk-section.danger h3{background:#2b1519;color:#fca5a5}.mamba-risk-section.warn h3{background:#2a200e;color:#fcd34d}
      .mamba-risk-list{margin:0;padding:0;list-style:none}
      .mamba-risk-list li{display:grid;grid-template-columns:minmax(120px,.8fr) minmax(130px,.75fr) minmax(0,1.4fr);gap:10px;padding:10px 12px;border-top:1px solid #273449;font-size:12px;line-height:1.45}
      .mamba-risk-list strong{overflow:hidden;color:#f1f5f9;text-overflow:ellipsis;white-space:nowrap}
      .mamba-risk-phone{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#cbd5e1}
      .mamba-risk-reason{color:#94a3b8}
      .mamba-risk-more{padding:9px 12px;border-top:1px solid #273449;color:#94a3b8;font-size:11.5px}
      .mamba-risk-clear{padding:13px;border:1px solid #14532d;border-radius:10px;background:#0c2118;color:#86efac;font-size:13px;line-height:1.55}
      .mamba-risk-unavailable{margin-top:12px;padding:11px 13px;border:1px solid #7f1d1d;border-radius:9px;background:#2b1519;color:#fecaca;font-size:12px;line-height:1.55}
      .mamba-risk-ack{display:flex;gap:9px;align-items:flex-start;margin-top:16px;padding:12px 13px;border:1px solid #854d0e;border-radius:9px;background:#251c0d;color:#fde68a;font-size:12.5px;line-height:1.5}
      .mamba-risk-ack input{margin-top:2px;flex:0 0 auto}
      .mamba-risk-actions{display:flex;justify-content:flex-end;gap:10px;padding:16px 22px;border-top:1px solid #273449}
      .mamba-risk-actions button{min-height:40px;padding:9px 15px;border:1px solid #475569;border-radius:8px;background:#1f2937;color:#e5e7eb;font:inherit;font-weight:800;cursor:pointer}
      .mamba-risk-actions .confirm{border-color:#b45309;background:#d97706;color:#1c0d02}
      .mamba-risk-actions .confirm:disabled{opacity:.42;cursor:not-allowed}
      @media(max-width:620px){.mamba-risk-counts{grid-template-columns:repeat(2,1fr)}.mamba-risk-list li{grid-template-columns:1fr}.mamba-risk-actions{flex-direction:column-reverse}.mamba-risk-actions button{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function section(title, items, kind, detail) {
    if (!items?.length) return "";
    const visible = items.slice(0, 8);
    const rows = visible.map((item) => `
      <li>
        <strong>${escapeHtml(item.name || item.privateName || item.phone)}</strong>
        <span class="mamba-risk-phone">${escapeHtml(item.phone)}</span>
        <span class="mamba-risk-reason">${escapeHtml(detail(item))}</span>
      </li>`).join("");
    const more = items.length > visible.length
      ? `<div class="mamba-risk-more">另有 ${items.length - visible.length} 位，请返回名单逐一检查。</div>`
      : "";
    return `<section class="mamba-risk-section ${kind}"><h3>${escapeHtml(title)} · ${items.length}</h3><ul class="mamba-risk-list">${rows}</ul>${more}</section>`;
  }

  function open(risk, { actionLabel = "确认发送" } = {}) {
    ensureStyle();
    document.getElementById(MODAL_ID)?.remove();
    const connected = risk?.connectedSenders || [];
    const privateContacts = risk?.privateContacts || [];
    const previous = risk?.previousBlast || [];
    const unavailable = risk?.unavailableChecks || [];
    const needsExtraAck = Boolean(connected.length || privateContacts.length || previous.length || unavailable.length);
    const modal = document.createElement("div");
    modal.id = MODAL_ID;
    modal.className = "mamba-risk-backdrop";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", `${MODAL_ID}-title`);
    modal.innerHTML = `
      <div class="mamba-risk-dialog">
        <header class="mamba-risk-head">
          <div class="mamba-risk-icon">!</div>
          <div><h2 id="${MODAL_ID}-title">确定要发给这群人？</h2><p>这是最后一道 LIVE 检查。请确认没有把自己的其他号码、私人联系人或已经 Blast 过的客户混进来。</p></div>
        </header>
        <div class="mamba-risk-body">
          <div class="mamba-risk-counts">
            <div class="mamba-risk-count"><span>本次发送</span><b>${Number(risk?.total || 0)}</b></div>
            <div class="mamba-risk-count"><span>自己的号码</span><b>${connected.length}</b></div>
            <div class="mamba-risk-count"><span>私人联系人</span><b>${privateContacts.length}</b></div>
            <div class="mamba-risk-count"><span>曾经 Blast</span><b>${previous.length}</b></div>
          </div>
          ${needsExtraAck ? "" : '<div class="mamba-risk-clear">✓ 没有发现自己的连接号码、私人联系人或历史 Blast 记录。仍请确认这就是你选择的客户群。</div>'}
          ${section("自己的已连接号码", connected, "danger", (item) => item.reason)}
          ${section("Settings 私人联系人", privateContacts, "danger", (item) => item.reason)}
          ${section("本机有历史 Blast 记录", previous, "warn", (item) => `${item.reason} · 最近 ${displayTime(item.lastSentAt)}${item.flows?.length ? ` · ${item.flows.join(" / ")}` : ""}`)}
          ${unavailable.length ? `<div class="mamba-risk-unavailable">⚠️ ${unavailable.map(escapeHtml).join("；")}。系统无法证明名单安全，请先返回检查，或明确承担风险后继续。</div>` : ""}
          ${needsExtraAck ? '<label class="mamba-risk-ack"><input type="checkbox" data-risk-ack><span>我已经检查以上标记号码，确认仍要把未取消选择的人加入 LIVE 发送。</span></label>' : ""}
        </div>
        <footer class="mamba-risk-actions">
          <button type="button" data-risk-cancel>返回检查名单</button>
          <button type="button" class="confirm" data-risk-confirm ${needsExtraAck ? "disabled" : ""}>${escapeHtml(actionLabel)} ${Number(risk?.total || 0)} 人</button>
        </footer>
      </div>`;
    document.body.appendChild(modal);

    return new Promise((resolve) => {
      const confirm = modal.querySelector("[data-risk-confirm]");
      const finish = (answer) => {
        document.removeEventListener("keydown", onKey);
        modal.remove();
        resolve(answer);
      };
      const onKey = (event) => {
        if (event.key === "Escape") finish(false);
      };
      modal.querySelector("[data-risk-cancel]").addEventListener("click", () => finish(false));
      confirm.addEventListener("click", () => finish(true));
      modal.querySelector("[data-risk-ack]")?.addEventListener("change", (event) => {
        confirm.disabled = !event.target.checked;
      });
      modal.addEventListener("click", (event) => {
        if (event.target === modal) finish(false);
      });
      document.addEventListener("keydown", onKey);
    });
  }

  window.MambaLiveRecipientConfirm = { open, formatRequestError };
})();
