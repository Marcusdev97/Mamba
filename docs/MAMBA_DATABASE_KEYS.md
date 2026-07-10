# Mamba Database Primary Key / Unique Key Map

Updated: 2026-07-10

This document defines the stable keys for the full Mamba system. Notion page IDs are internal IDs; they are useful for code, but the business system should still keep readable key fields so humans and imports can deduplicate safely.

## Key Rules

| Rule | Meaning |
| --- | --- |
| Primary display field | The Notion title field humans see. It does not guarantee uniqueness. |
| Unique Key | The field or formula we use to prevent duplicate rows. |
| Foreign Key | A value used to connect one database to another. |
| Phone format | Always normalized digits only, e.g. `601133698121`. |
| Project code | Use stable lower snake code internally, e.g. `gen_starz`, `binastra`. Display name can remain `Gen Starz`. |
| Sender key | Use `wa_01`, `wa_02`, etc. The WhatsApp phone number is not the unique key. |
| Device key | Use a stable computer/worker key, e.g. `cici_macbook_pro`, `office_pc_01`. |
| Lock key | Use short-lived send locks to stop two PCs sending the same lead at the same time. |

## Multi-User / Multi-PC Direction

Mamba has two operating stages.

### Stage 1: Current practical setup

```text
PC A / PC B / PC C
  -> Local Mamba app
  -> Same Notion workspace
```

This is acceptable for the current phase if every sender and every lead has stable keys.

The safety rules are:

- Every WhatsApp connection must have a stable `Connection Key`, such as `wa_01`, `wa_02`, or `marcus_01`.
- The WhatsApp phone number is display information only. It must not be the primary key.
- Every PC should have a stable `Device Key`, such as `cici_macbook_pro`.
- Before sending, the app should claim a lead with a short send lock.
- After sending, the app should write which sender and which device actually sent the message.

### Stage 2: Future SaaS / many-user setup

```text
PC workers
  -> Mamba Backend
  -> Database
  -> Notion sync view
```

When Mamba is used by many people, Notion should become the human CRM/view layer. It should not be the only source of truth for permissions, locking, and job scheduling.

Future backend tables should be:

| Table | Purpose |
| --- | --- |
| `workspaces` | One company/team tenant |
| `users` | Human users |
| `projects` | Campaign projects |
| `contacts` | Global people/phone identity |
| `project_leads` | One contact inside one project |
| `whatsapp_connections` | Sender registry |
| `devices` | PC/worker registry |
| `campaign_runs` | One blast run |
| `send_jobs` | One scheduled send task |
| `messages` | Sent and received WhatsApp messages |
| `conversation_events` | Conversation history |
| `system_logs` | Audit and error logs |

Notion can still show the data, but backend should own dedup, permissions, locks, and audit.

## Current Best Strategy

Do not rebuild everything now. First make Notion safe for multiple WhatsApp numbers and multiple PCs.

Add these fields to `Mamba | Blast Leads` first:

| Field | Type | Purpose |
| --- | --- | --- |
| `Contact Key` | Text / formula | Global customer identity, normally normalized phone. |
| `Project Lead Key` | Text / formula | Unique row for one customer in one project. |
| `Assigned Sender Key` | Select / text | Preferred WhatsApp connection for this lead. |
| `Last Sender Key` | Select / text | Actual WhatsApp connection used last time. |
| `Last Sender Phone` | Phone / text | Actual sender phone shown for debugging. |
| `Last Sent By Device` | Text / select | Which PC/worker sent last. |
| `Campaign Run ID` | Text / relation | Which blast run touched this lead. |
| `Send Lock` | Checkbox | Lead is currently claimed for sending. |
| `Locked By Device` | Text / select | Which PC claimed it. |
| `Lock Until` | Date | Auto-expire lock if PC crashes or network hangs. |

This gives us safe multi-PC behavior while still using Notion.

## Current Notion Databases

From `campaign-data/notion_config.json`:

| Logical Name | Notion Database | Current ID |
| --- | --- | --- |
| `blastLeads` | Mamba \| Blast Leads | `64b439a288c1415fa36ac890e17c88e6` |
| `adsLeads` | Mamba \| Ads Leads | `fcfe32f817244929b89085f4af59ade9` |
| `templates` | Mamba \| Campaign Templates | `d8a1bf9c5fdd4c1198f50b91ee41079c` |
| `images` | Mamba \| Images | `b8978f28aa004e22a21ff4b95aa00790` |
| `recycleLeads` | Mamba \| Recycle Leads | `fd7bba6715434c5f820a36ead4a582c8` |
| `campaignRuns` | Mamba \| Campaign Runs | `38358de2161380e28f19f7587f3fa932` |

## 1. Mamba | Projects

There is no separate Notion project database yet. Current source of truth is `campaign-assets/projects.json` plus Project select options in Notion.

| Field | Role | Example |
| --- | --- | --- |
| `Project Code` | Primary unique key | `gen_starz` |
| `Project Name` | Human display | `Gen Starz` |
| `Alias` | Import/template matching | `Gen Starz`, `GenStarz` |

Recommended unique key:

```text
project_code
```

Use this key everywhere in code. Display name can change; project code should not.

## 2. Mamba | Blast Leads

This is the main customer state table.

| Field | Role | Example |
| --- | --- | --- |
| `Name` | Primary display | `Marcus Chin` |
| `Phone` | Global contact key | `601133698121` |
| `Project` | Project FK | `Gen Starz` |
| `Contact Key` | Recommended formula/text | `601133698121` |
| `Project Lead Key` | Recommended unique key | `gen_starz:601133698121` |
| `Sender Instance` | Legacy/current sender FK | `wa_01` |
| `Assigned Sender Key` | Preferred sender FK | `wa_01` |
| `Last Sender Key` | Actual last sender FK | `wa_02` |
| `Last Sender Phone` | Actual sender phone | `601133698121` |
| `Last Sent By Device` | Device FK | `cici_macbook_pro` |
| `Campaign Run` | Run FK | relation to Campaign Runs |
| `Campaign Run ID` | Run FK text | `run_20260710_131500_gen_starz_flow01` |
| `Last Flow Sent` | Flow FK | `Flow 1 - Project Template` |
| `Next Flow` | Flow FK | `Flow 2 - Layout` |
| `Send Lock` | Concurrency lock | checked while a PC is sending |
| `Locked By Device` | Lock owner | `office_pc_01` |
| `Lock Until` | Lock expiry | date/time |
| `Follow Up At` | Tracking date | date/time customer should be followed up |
| `Priority` | Tracking priority | `HIGH`, `MED`, `LOW` |
| `Appointment Date` | Appointment date | showroom / call date |
| `Appointment Time` | Appointment time | `15:00` |
| `Appointment Place` | Appointment place | `Showroom`, `WhatsApp`, `Call` |
| `Appointment Status` | Appointment state | `Pending`, `Confirmed`, `Done`, `No Show` |
| `Assigned Sales` | Sales owner | `Marcus` |
| `Sales Notes` | Sales notes | next human action notes |

Current behavior:

```text
dedup = Phone
```

Recommended final behavior:

```text
project_lead_key = project_code + ":" + normalized_phone
```

Why:

`Phone` is the global human/contact identity, but one person can appear under more than one project. For customer conversation history and STOP list, use `Phone`. For a project campaign row, use `Project Lead Key`.

Best fields to add in Notion:

| Field | Type | Formula / Value |
| --- | --- | --- |
| `Contact Key` | Formula or Text | normalized `Phone` |
| `Project Lead Key` | Formula or Text | `project_code + ":" + Phone` |
| `Assigned Sender Key` | Select or Text | `wa_01` |
| `Last Sender Key` | Select or Text | `wa_01` |
| `Last Sender Phone` | Phone or Text | `601133698121` |
| `Last Sent By Device` | Text or Select | `cici_macbook_pro` |
| `Campaign Run ID` | Text | `run_20260710_131500_gen_starz_flow01` |
| `Send Lock` | Checkbox | true while sending |
| `Locked By Device` | Text or Select | `cici_macbook_pro` |
| `Lock Until` | Date | lock expiry time |

Follow-up tracking fields to add next:

| Field | Type | Value |
| --- | --- | --- |
| `Follow Up At` | Date | next human follow-up time |
| `Priority` | Select | `HIGH`, `MED`, `LOW` |
| `Appointment Date` | Date | appointment date/time |
| `Appointment Time` | Rich Text | human-readable time if needed |
| `Appointment Place` | Rich Text | showroom / call / WhatsApp |
| `Appointment Status` | Select | `Pending`, `Confirmed`, `Done`, `No Show` |
| `Assigned Sales` | Select or Rich Text | sales owner |
| `Sales Notes` | Rich Text | sales notes |

Multi-PC send rule:

```text
1. Find lead by Project Lead Key.
2. If Send Lock is true and Lock Until is still future, skip this lead.
3. Otherwise set Send Lock = true, Locked By Device = current device, Lock Until = now + 5 minutes.
4. Send WhatsApp message.
5. Update Last Sender Key, Last Sender Phone, Last Sent By Device, Last Flow Sent, Next Flow, Campaign Run ID.
6. Clear Send Lock.
```

If the app crashes, `Lock Until` allows another PC to retry later.

## 3. Mamba | Campaign Templates

This is the source of truth for outbound message templates.

| Field | Role | Example |
| --- | --- | --- |
| `Template Name` | Primary display | `[Gen Starz][F01 Project][EN][P1][v2]` |
| `Project` | Project FK | `Gen Starz` |
| `Flow Topic` | Flow FK | `Project Template` |
| `Part` | Message order | `Part 1` |
| `Language` | Language key | `EN` |
| `Version` | Version key | `v2` |
| `Template Key` | Recommended unique key | `gen_starz:f01:p1:en:v2` |
| `Image Name` | Image FK | `gs_f01_project_en_v1` |

Recommended unique key:

```text
template_key = project_code + ":f" + flow_no + ":p" + part_no + ":" + language + ":v" + version
```

Example:

```text
gen_starz:f01:p1:en:v2
```

Rules:

- Do not use message text as a key.
- A tiny copy change means new version.
- Active templates should be 2-4 per same project/flow/part/language for rotation.

## 4. Mamba | Images

This registers reusable campaign media.

| Field | Role | Example |
| --- | --- | --- |
| `Image Name` | Primary display / unique key | `gs_f03_location_en_v1` |
| `Project` | Project FK | `Gen Starz` |
| `Flow Topic` | Flow FK | `Location` |
| `Language` | Language key | `EN` |
| `Asset Key` | Recommended unique key | `gs_f03_location_en_v1` |
| `Local File` | Local path key | `campaign-assets/images/gs_f03_location_en_v1.jpg` |

Recommended unique key:

```text
asset_key = image_name
```

Rules:

- Never use original export names like `ChatGPT Image Jul...`.
- The local filename and Notion `Image Name` should match whenever possible.
- Large video files over 100 MB should not go into normal Git.

## 5. Mamba | Campaign Runs

This is one row per blast/cohort/run.

| Field | Role | Example |
| --- | --- | --- |
| `Name` | Primary display | `Gen Starz | 2026-07-10 | Flow 1 (13:15)` |
| `Run ID` | Recommended unique key | `run_20260710_131500_gen_starz_flow01` |
| `Project` | Project FK | `Gen Starz` |
| `Flow` | Flow FK | `Flow 1 - Project Template` |
| `Sender Set` | Sender FK list | `wa_01,wa_02` |

Current behavior:

```text
dedup = Name
```

Recommended unique key:

```text
run_id
```

Reason:

Name is readable, but `Run ID` is safer for re-uploading, retrying, and linking Blast Leads back to one campaign.

## 6. Mamba | Ads Leads

This is for click-to-WhatsApp or ad-origin inbound leads.

| Field | Role | Example |
| --- | --- | --- |
| `Name` | Primary display | `Unknown / Customer name` |
| `Phone` | Contact key | `60123456789` |
| `Ad Lead Key` | Recommended unique key | `ads:60123456789` |
| `Lead Received At` | First received time | date |
| `Last Touch At` | Last message/touch | date |

Recommended unique key:

```text
ad_lead_key = "ads:" + normalized_phone
```

If you later run multiple ad sources:

```text
ad_lead_key = source_code + ":" + normalized_phone
```

## 7. Mamba | Recycle Leads

This is for old lists, call lists, and recovered leads.

| Field | Role | Example |
| --- | --- | --- |
| `Name` | Primary display | `Customer` |
| `Phone` | Contact key | `60123456789` |
| `Recycle Lead Key` | Recommended unique key | `recycle:60123456789` |
| `Source Batch` | Import batch FK | `expo_july_2026` |

Recommended unique key:

```text
recycle_lead_key = "recycle:" + normalized_phone
```

For repeated call campaigns, do not duplicate the lead. Add activity fields or a separate activity log later.

## 8. Mamba | Project Knowledge

This is the verified fact source for AI.

| Field | Role | Example |
| --- | --- | --- |
| `Fact` | Primary display | `Freehold commercial title` |
| `Project` | Project FK | `Gen Starz` |
| `Category` | Topic key | `Legal` |
| `Fact Key` | Recommended unique key | `gen_starz:legal:freehold_commercial_title` |
| `Verified` | Safety gate | checkbox |
| `Valid Until` | Expiry | date |

Recommended unique key:

```text
fact_key = project_code + ":" + category_slug + ":" + fact_slug
```

Rules:

- AI can only quote `Verified = true`.
- Price/promo facts should have `Valid Until`.

## 9. Mamba | Golden Conversations

This stores examples of good real conversations.

| Field | Role | Example |
| --- | --- | --- |
| `Scenario` | Scenario key | `Price Objection` |
| `Project` | Project FK | `Gen Starz` |
| `Conversation Hash` | Recommended unique key | hash of conversation text |
| `Golden Key` | Recommended unique key | `gen_starz:price_objection:{hash8}` |

Recommended unique key:

```text
golden_key = project_code + ":" + scenario_slug + ":" + conversation_hash8
```

## 10. Mamba | Objection Bank

This stores reusable objection handling logic.

| Field | Role | Example |
| --- | --- | --- |
| `Customer Says` | Primary display | `Price expensive` |
| `Scenario` | Scenario key | `Price Objection` |
| `Objection Key` | Recommended unique key | `price_objection:price_expensive` |

Recommended unique key:

```text
objection_key = scenario_slug + ":" + customer_says_slug
```

## 11. Mamba | AI Reply Log

This records AI/human reply decisions.

| Field | Role | Example |
| --- | --- | --- |
| `Lead Phone` | Contact FK | `60123456789` |
| `Project` | Project FK | `Gen Starz` |
| `Route` | Classifier route | `PRICE_REQUEST` |
| `Message ID` | WhatsApp message FK | Evolution message id |
| `Reply Log Key` | Recommended unique key | `{message_id}:PRICE_REQUEST` |

Recommended unique key:

```text
reply_log_key = message_id || normalized_phone + ":" + timestamp_iso
```

Rules:

- If Evolution gives a message id, use it.
- If there is no message id, fallback to `phone + timestamp`.
- Store both robot draft and final human-approved version.

## 12. WhatsApp Connections

This currently lives in Evolution / Settings, not a Notion database.

| Field | Role | Example |
| --- | --- | --- |
| `Connection Key` | Primary unique key | `wa_01` |
| `WhatsApp Number` | Display / owner number | `+601133698121` |
| `Owner` | Human owner | `Marcus` |
| `Team` | Team / branch | `Sales Team A` |
| `Device Key` | PC/worker using it | `cici_macbook_pro` |
| `Status` | Health | `OPEN` |
| `Last Health Check` | Health timestamp | date/time |
| `Last Seen At` | Last connected timestamp | date/time |

Recommended unique key:

```text
connection_key = wa_01
```

Important:

The WhatsApp phone number must not be the unique key. A number can be relinked, renamed, or replaced. The app should route by `wa_01`, `wa_02`, etc.

Recommended registry:

| Connection Key | WhatsApp Number | Owner | Device Key | Status |
| --- | --- | --- | --- | --- |
| `wa_01` | `601133698121` | `Marcus` | `cici_macbook_pro` | `OPEN` |
| `wa_02` | `60123456789` | `Sales 2` | `office_pc_01` | `OPEN` |

If the same WhatsApp account is linked on a second computer later, the app should update `Device Key` / `Last Seen At`, not create a new customer identity.

## 12A. Devices / Workers

This can start as local config first, then become a Notion/backend table later.

| Field | Role | Example |
| --- | --- | --- |
| `Device Key` | Primary unique key | `cici_macbook_pro` |
| `Device Name` | Human display | `Cici's MacBook Pro` |
| `Owner` | Human owner | `Marcus` |
| `Workspace` | Future tenant | `Mamba Sales` |
| `Last Online At` | Health timestamp | date/time |

Recommended unique key:

```text
device_key
```

Rules:

- Device key should be stable and not change every app restart.
- Device key is used for send locks and audit.
- Device key should be visible in Settings so non-technical users know which PC is active.

## 13. Local Conversation History

This is stored locally under:

```text
campaign-data/conversations/{phone}.jsonl
```

| Field | Role |
| --- | --- |
| `phone` | File partition key |
| `eventKey` | Unique event key |
| `messageId` | Preferred source id |
| `at + instanceName + text` | Fallback unique key |

Recommended unique key:

```text
event_key = message_id || at + ":" + instance_name + ":" + text_hash
```

## 14. System Logs

This is stored locally under:

```text
campaign-data/system-logs/YYYY-MM-DD.jsonl
```

| Field | Role |
| --- | --- |
| `at` | Time partition |
| `level` | info / warn / error |
| `area` | campaign / conversations / api / system |
| `event` | event name |

Recommended unique key:

```text
log_key = at + ":" + area + ":" + event + ":" + random_or_sequence
```

Logs are append-only. They do not need strict dedup.

## Cross-Database Foreign Keys

| From | Field | To |
| --- | --- | --- |
| Blast Leads | `Project` / `project_code` | Projects |
| Blast Leads | `Campaign Run` / `run_id` | Campaign Runs |
| Blast Leads | `Sender Instance` | WhatsApp Connections |
| Blast Leads | `Assigned Sender Key` | WhatsApp Connections |
| Blast Leads | `Last Sender Key` | WhatsApp Connections |
| Blast Leads | `Last Sent By Device` | Devices / Workers |
| Blast Leads | `Template Sent` | Campaign Templates |
| Campaign Templates | `Image Name` | Images |
| AI Reply Log | `Lead Phone` / `Contact Key` | Blast Leads / Ads Leads / Recycle Leads |
| Project Knowledge | `Project` | Projects |
| Golden Conversations | `Project` | Projects |

## Most Important Decision

Use two different lead keys:

```text
Contact Key      = normalized_phone
Project Lead Key = project_code + ":" + normalized_phone
```

`Contact Key` answers:

```text
Who is this human?
```

`Project Lead Key` answers:

```text
This human inside which project/campaign?
```

STOP / suppression / conversation history should use `Contact Key`.

Blast flow status / Next Flow / Last Flow Sent should use `Project Lead Key`.

## Recommended Next Code Change

Current code still dedups many Blast Lead operations by `Phone` only. The next clean upgrade should be:

1. Add `Project Lead Key` to Notion Blast Leads.
2. During import/upload, compute `project_code:phone`.
3. Query by `Project Lead Key` instead of `Phone` for Blast Leads.
4. Keep global STOP list by `Phone`.
5. Keep conversation history by `Phone`.

That gives both safety and flexibility for multi-project selling.

## Implementation Order

Do this in small, testable steps.

### Step 1: Schema only

Add the Notion fields, but do not change sending behavior yet.

Required fields:

```text
Contact Key
Project Lead Key
Assigned Sender Key
Last Sender Key
Last Sender Phone
Last Sent By Device
Campaign Run ID
Send Lock
Locked By Device
Lock Until
```

Expected result:

- Existing pages still load.
- Conversations still load.
- Campaign send still works as before.
- Schema health should show these fields as OK once added.

### Step 2: Write audit fields

When sending succeeds or fails, write:

```text
Last Sender Key
Last Sender Phone
Last Sent By Device
Campaign Run ID
```

Expected result:

- You can see exactly which WhatsApp connection touched the customer.
- Multiple sender numbers become traceable.

### Step 3: Project Lead Key dedup

Change Blast Leads dedup from:

```text
Phone
```

to:

```text
Project Lead Key
```

Expected result:

- Same customer can exist in Binastra and Gen Starz without overwriting project status.
- Global STOP still blocks by phone.

### Step 4: Send lock

Before sending, claim the lead:

```text
Send Lock = true
Locked By Device = current device
Lock Until = now + 5 minutes
```

Expected result:

- Two PCs using the same Notion will not send the same lead at the same time.
- If one PC crashes, another PC can retry after lock expiry.

### Step 5: Backend migration later

Only after the workflow is stable, move the real source of truth from Notion to backend database.

Notion then becomes:

```text
Human CRM view + manual correction panel + backup mirror
```

Backend becomes:

```text
Permission + lock + send queue + audit truth
```

## Bot Rules Brain

Current rule brain lives in:

```text
campaign-data/bot_rules.json
```

The visual editor is:

```text
/bot-rules
```

Rule output writes into Blast Leads through the existing classifier flow:

| Rule Output | Notion Field |
| --- | --- |
| `status` | `Status` |
| `sequenceStatus` | `Sequence Status` |
| `nextAction` | `Next Action` |
| `aiCategory` | `AI Category` |
| `suggestedReply` / route summary | `AI Summary` |
| `stopFlag` | `Stop Flag` |

Recommended operating flow:

```text
1. Edit / test rules in Bot Rules.
2. Save Rules.
3. Apply to Conversations.
4. Conversations writes the classification back to Notion.
5. Follow-Up Desk only shows replied/actionable customers.
```
