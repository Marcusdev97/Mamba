# Mamba Lead Recovery — 2026-07-17

## TL;DR — nothing is lost
- **All 1,189 leads are safe in Notion** (verified live): Gen Starz 588, Binastra 435, Enlace 163, Radium Arena 2, +1.
- A full backup was exported: `Mamba_Leads_Backup_2026-07-17.xlsx` and `Mamba_Leads_Backup_2026-07-17.json`.
- The dashboard shows only 1 because of a **display filter**, not data loss.

## What actually happened
On 16 Jul a device-ownership claim ran (applied 1,175), then was **rolled back**, which cleared the
`Assigned Sender Key` / `Last Sender Key` / `Last Sent By Device` fields on 1,188 rows.

Your Inbox / Follow-Up desk only shows leads "owned" by the current Mac + WhatsApp number
(logic in `campaign-app/lib/device-scope.mjs` — keeps only rows scored `local`).
With the stamp cleared, 1,188 rows score `legacy`/`unassigned` and are hidden. Hence **Total: 1**.

Your device: `mamba-e69c1eb2-8b02-43a1-91fe-5eade52c6d58` (Marcuss-MacBook-Air)
Your sender: `wa_01` = `60168568756`
Yesterday's preview already confirmed **1,177 of 1,189** belong to this Mac + number.

---

## PART A — Bring all leads back (re-stamp ownership)

Run in Terminal on your Mac. **Preview writes nothing. Apply only writes 4 ownership fields — it never sends WhatsApp and never triggers AI.**

Prereqs: your Campaign Console / Evolution is running and `wa_01` shows **OPEN** in Settings → Phone Health.

**Step 1 — Preview (safe, no writes):**
```bash
cd /Users/marcus/Desktop/Mamba/campaign-app
node device_ownership_repair.mjs --dry-run --claim-current-connections --expected-sender=60168568756
```
Read the summary. Expect ≈1,177 "确定属于本机" (confirmed local), 0 conflicts. It prints a report path like
`.../campaign-data/device-ownership/claim-preview-<timestamp>.json`.

**Step 2 — Apply (writes the 4 ownership fields to Notion):**
```bash
node device_ownership_repair.mjs --apply \
  --report=/Users/marcus/Desktop/Mamba/campaign-data/device-ownership/claim-preview-<timestamp>.json \
  --confirm-device=mamba-e69c1eb2-8b02-43a1-91fe-5eade52c6d58
```
Replace `<timestamp>` with the exact file from Step 1. The preview must be < 24h old.

**Step 3 — Refresh the desk:** back in the Inbox, click 刷新 / Refresh. All ~1,177 leads reappear.

> If Step 2 says "sender phone 与本机绑定不一致" or "尚未绑定", just re-run Step 1 first (it saves the sender policy), then retry Step 2.

---

## PART B — Rebuild WhatsApp chat history

You already have the button. On the **Conversations** page click **"Refresh Replies from WhatsApp"**
(green button). It calls Evolution `/chat/findMessages` for your OPEN connection and pulls in replies /
conversation history. This is the same endpoint the deeper transcript rebuild uses.

---

## Notes
- Do NOT run `--rollback` again — that's what cleared the stamps in the first place.
- The desk is "Device-only" by design: it shows leads sent from *this* Mac's number. That's expected.
- Keep the two backup files above until the desk looks right again.
