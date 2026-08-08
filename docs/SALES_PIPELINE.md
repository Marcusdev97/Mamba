# Sales Stage and Follow-up Pipeline

> 状态：Implemented in code · Migration 307 required · 更新日期：2026-08-08

## Source of truth

SQLite is the operational source for sales work:

- `project_leads.sales_stage` answers where the lead is in the project opportunity.
- `project_leads.temperature` is separate from stage.
- `sales_opportunities` exists only after qualified intent evidence or manual promotion.
- `customer_follow_up_tasks` is the one task queue shared with Send Eligibility.
- `sales_activities` is the append-only explanation of who changed what and when.

The pure rules live in `domain/sales-pipeline.mjs`; HTTP and the `/sales` page never decide
whether a transition or opportunity is valid.

`/follow-up` serves the same Sales Pipeline UI so operators have one task surface. The legacy
`/api/follow-up` integration remains temporarily available for old Notion reconciliation, but
it is not an authority for migration 307 stage or task decisions.

`/sales` and `/follow-up` keep the shared Mamba Sidebar and use `assets/mamba.css` as the only
source for content colors, fonts, type scale, and base components.

## Stage and temperature

Stages are `NEW`, `CONTACTED`, `REPLIED`, `QUALIFIED`, `WARM`, `APPOINTMENT`, `VIEWED`,
`LOAN_PROCESSING`, `BOOKING`, `SPA_SIGNED`, `WON`, and `LOST`.

Temperatures are `HOT`, `WARM`, `COLD`, `NURTURE`, and `STOP`. A `QUALIFIED` lead may be
`WARM`; a later buyer may remain active as `NURTURE` instead of being marked Lost.

Only first confirmed outbound (`NEW → CONTACTED`) and meaningful inbound
(`NEW/CONTACTED → REPLIED`) are automatic. Qualification, Warm, Viewing, Loan, Booking,
SPA and corrections require a human decision. Backward corrections require a reason;
Lost requires `lost_reason`; Won is terminal in the normal workflow.

## Opportunities and commission

Import and first outbound do not create an opportunity. Creation requires one of:

- meaningful reply;
- qualified call;
- clear budget/location need;
- appointment discussion;
- explicit agent promotion.

Commission calculation is recorded with its inputs:

```text
gross = property value × commission rate
expected = gross × team split × closing probability
```

Actual commission, payment status, expected payment date and paid time remain human-owned.

## Follow-up engine

The five-minute job only creates or reprioritises tasks; it never sends messages. Its
idempotency key includes the lead, trigger type and source evidence. Triggers cover:

- customer waiting for reply;
- Hot/Warm lead without meaningful contact for seven days;
- confirmed Snooze time reached;
- appointment confirmation window;
- viewing completed without outcome;
- stale loan processing;
- Booking and SPA transaction actions.

Priority combines overdue time, temperature, stage value, explicit commitment and expected
commission. STOP/identity risk cannot become a high-priority contact instruction.

## Notion

Notion CRM schema v2 adds the sales profile, task and commission fields while preserving the
same eight databases. Human fields use the existing three-way merge. A backward Notion stage
edit without a fresh `Stage Change Reason`, or Lost without `Lost Reason`, becomes a conflict
instead of overwriting SQLite.

## Migration

Dry-run:

```bash
npm --prefix campaign-app run db:sales-pipeline:dry-run
```

Apply only after migrations 304–306 and after every LIVE Campaign is terminal:

```bash
node scripts/maintenance/migrate-sales-stage-followup.mjs \
  --apply --confirm APPLY_SALES_PIPELINE_V1
```

Then run the Notion CRM provisioner with `CREATE_NOTION_CRM_V2` to add missing properties to
the existing CRM Hub. Neither maintenance command restarts Mamba or sends a message.
