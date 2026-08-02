# Mamba Multi-Channel SMS Blueprint

> Status: Phase 0 — architecture and safe scaffolding
>
> Branch: `feature/multi-channel-sms`
>
> Goal: Let Mamba send and receive messages through WhatsApp, Android SMS, and iPhone SMS via Mac, while keeping one customer list, one suppression list, one campaign history, and one Customer Desk.

## 1. What We Are Building

Mamba will become a channel-aware campaign and lead qualification system.

```text
Mamba Campaign Engine
        ↓
Consent + Suppression Gate
        ↓
Channel Router
 ┌───────────────┬──────────────────┬──────────────────┐
 ↓               ↓                  ↓
WhatsApp         Android SMS        iPhone SMS via Mac
Evolution API    Android Gateway    imsg + Messages.app
```

The user experience should remain simple:

1. Open Mamba.
2. Import or select leads.
3. Tick the sender devices to use.
4. Set a per-device limit, for example 20 contacts.
5. Start the campaign.
6. Mamba queues and sends messages.
7. Replies return to Customer Desk.
8. Mamba classifies replies and stops automation when human takeover is needed.

## 2. Supported Channels

### 2.1 WhatsApp

Current engine:

- Evolution API
- Existing Mamba WhatsApp campaign code
- Existing reply detection, STOP list, resend guard, and Customer Desk

No behaviour should change during the first implementation phase.

### 2.2 Android SMS

Tool:

- GitHub: `capcom6/android-sms-gateway`
- Device: Android phone, currently Oppo A38
- Connection: Local HTTP API first; private/cloud server may be added later
- Capabilities:
  - Send SMS through the SIM inside the Android phone
  - Dual-SIM selection where supported
  - Receive incoming SMS through webhook
  - Sent, delivered, and failed events
  - Multiple Android devices later

Important limitation:

- The project itself warns that batch sending may be restricted by mobile operators.
- Mamba must use conservative queues and only send to contacts with appropriate consent.

### 2.3 iPhone SMS through Mac

Tool:

- GitHub: `openclaw/imsg`
- Mac requirement: macOS 14+
- iPhone requirement: Text Message Forwarding enabled for the Mac
- Connection:
  - Mamba calls `imsg send` or its JSON-RPC interface
  - `imsg` controls Messages.app
  - Messages.app relays the SMS through the connected iPhone
- Incoming replies:
  - `imsg watch --json` streams new messages
  - Mamba normalizes them into the same inbound event format used by Android SMS

Important limitations:

- MacBook, Messages.app, and iPhone must remain available.
- AppleScript cannot reliably force a specific outgoing line when several iPhone lines are available.
- For predictable routing, dedicate one iPhone SMS line to this sender profile.
- This is not an operator-approved enterprise bulk SMS gateway.

## 3. Sender Device Model

Mamba should treat every sending source as a `Sender Device`.

Example configuration:

```json
{
  "id": "android-oppo-digi",
  "channel": "sms",
  "provider": "android-sms-gateway",
  "label": "Oppo A38 / Digi",
  "enabled": true,
  "dailyLimit": 20,
  "batchLimit": 20
}
```

```json
{
  "id": "iphone-maxis-via-mac",
  "channel": "sms",
  "provider": "imsg",
  "label": "iPhone / Maxis via MacBook",
  "enabled": true,
  "dailyLimit": 20,
  "batchLimit": 20
}
```

Existing WhatsApp instances should eventually use the same model:

```json
{
  "id": "whatsapp-mark-01",
  "channel": "whatsapp",
  "provider": "evolution",
  "label": "WhatsApp Mark 01",
  "enabled": true,
  "batchLimit": 20
}
```

## 4. Provider Interface

All channel providers must expose one common interface.

```js
{
  id,
  channel,
  healthCheck(),
  sendText({ to, text, sender, metadata }),
  normalizeInbound(payload)
}
```

Normalized send result:

```json
{
  "provider": "imsg",
  "channel": "sms",
  "senderId": "iphone-maxis-via-mac",
  "messageId": "provider-message-id",
  "status": "accepted",
  "sentAt": "2026-08-02T06:00:00.000Z",
  "raw": {}
}
```

Normalized inbound event:

```json
{
  "provider": "android-sms-gateway",
  "channel": "sms",
  "senderId": "android-oppo-digi",
  "from": "+60123456789",
  "to": "+601133698121",
  "text": "1",
  "messageId": "provider-message-id",
  "receivedAt": "2026-08-02T06:05:00.000Z",
  "raw": {}
}
```

## 5. Planned File Structure

```text
campaign-app/
├── providers/
│   ├── provider-errors.mjs
│   ├── provider-registry.mjs
│   ├── channel-router.mjs
│   ├── sms-android-gateway.mjs
│   ├── sms-imsg.mjs
│   └── whatsapp-evolution.mjs       # later extraction from campaign_core
├── inbound/
│   ├── normalize-inbound.mjs
│   ├── sms-android-webhook.mjs
│   └── sms-imsg-watcher.mjs
└── tests/
    └── channel-router.test.mjs
```

Phase 1 will add only isolated provider modules. Existing WhatsApp sending remains untouched until the adapter tests pass.

## 6. Environment Variables

Do not commit real credentials.

```bash
# Feature switch
MULTI_CHANNEL_ENABLED=false

# Android SMS Gateway — Local Mode
ANDROID_SMS_GATEWAY_ENABLED=false
ANDROID_SMS_GATEWAY_BASE_URL=http://192.168.1.100:8080
ANDROID_SMS_GATEWAY_USERNAME=
ANDROID_SMS_GATEWAY_PASSWORD=
ANDROID_SMS_GATEWAY_TIMEOUT_MS=30000

# iPhone SMS via Mac and imsg
IMSG_ENABLED=false
IMSG_BINARY=imsg
IMSG_DEFAULT_SERVICE=sms
IMSG_TIMEOUT_MS=30000

# Safety defaults
SMS_DEFAULT_BATCH_LIMIT=20
SMS_DEFAULT_DAILY_LIMIT=20
SMS_MIN_GAP_SECONDS=60
SMS_MAX_GAP_SECONDS=180
```

## 7. Campaign Job Changes

Current WhatsApp job fields remain valid. New optional fields:

```json
{
  "channel": "sms",
  "provider": "imsg",
  "senderId": "iphone-maxis-via-mac",
  "consentStatus": "VALID",
  "consentChannel": "sms"
}
```

Mamba must not infer consent from the existence of a phone number.

## 8. Routing Rules

Initial routing rules:

1. STOP or suppressed contacts are always blocked.
2. A lead must be permitted for the selected channel.
3. A sender must be healthy and explicitly selected.
4. Each sender has a campaign limit and daily limit.
5. Mamba must not automatically switch to another channel after a rejection, complaint, or opt-out.
6. A technical failure may only fail over when the lead is already permitted on the fallback channel.
7. One customer should not receive the same campaign through multiple channels unless the campaign explicitly allows it.

Example:

```js
if (lead.stopFlag) return "BLOCKED_SUPPRESSED";
if (!lead.smsConsent && channel === "sms") return "BLOCKED_NO_SMS_CONSENT";
if (!lead.whatsappConsent && channel === "whatsapp") return "BLOCKED_NO_WHATSAPP_CONSENT";
```

## 9. Queue and Batch Behaviour

The UI may allow:

```text
☑ WhatsApp Mark 01       Limit 20
☑ Oppo A38 / Digi        Limit 20
☑ iPhone / Maxis via Mac Limit 20
```

This creates separate queues:

```text
WhatsApp Queue: 20
Android SMS Queue: 20
iPhone SMS Queue: 20
```

The limits are operational caps, not anti-detection logic.

Recommended initial SMS behaviour:

- One short message per lead
- No automatic multi-flow follow-up during pilot
- No URL or phone number in the SMS body until Malaysian filtering rules are verified for the selected route
- Stop immediately on `STOP`, `REMOVE`, `不要`, `不需要`, or equivalent
- Archive no-response leads instead of automatically sending four SMS flows

## 10. Reply Processing

All inbound messages should enter one pipeline:

```text
Provider inbound event
        ↓
Normalize phone + text
        ↓
Global suppression check
        ↓
Reply classifier
        ↓
Lead score / category
        ↓
Customer Desk
```

Examples:

```text
1 / Own Stay        → WARM
2 / Investment      → WARM
Price?              → HOT
Can view this week? → HOT + human takeover
STOP / 不需要       → SUPPRESSED
```

Human takeover must pause automation across all channels for that customer.

## 11. UI Changes

### Sender Devices panel

Display:

- Sender label
- Channel
- Provider
- Connection status
- Phone/network label entered by the user
- Batch limit
- Daily usage
- Last successful send
- Last error

### Campaign setup

Add:

- Channel selection
- Sender tick boxes
- Per-sender limits
- Estimated SMS count and cost field
- Test-send button for each provider

### Campaign monitor

Show:

- Queued
- Sending
- Accepted
- Delivered where available
- Failed
- Replied
- Suppressed
- Human takeover

## 12. Data Fields

Suggested lead fields:

```text
Preferred Channel
SMS Consent
WhatsApp Consent
Consent Source
Consent Timestamp
Consent Evidence
Last Outbound Channel
Last Inbound Channel
Human Takeover
Stop Flag
Do Not Contact
```

Suggested message fields:

```text
Channel
Provider
Sender ID
Provider Message ID
Direction
Delivery Status
Sent At
Delivered At
Received At
Campaign Run ID
Flow Topic
```

## 13. Security

- Keep API usernames and passwords only in `.env`.
- Never expose the Android local gateway directly to the public internet.
- Use local network access first.
- Validate inbound webhook secrets/signatures where supported.
- Escape all CLI arguments passed to `imsg`; use `spawn` with argument arrays, never shell string concatenation.
- Mask phone numbers in logs and UI.
- Do not store message bodies in debug logs unless required.
- Preserve the global STOP list across every provider.

## 14. Implementation Phases

### Phase 0 — Blueprint and skeleton

- Create this document
- Create provider contract, registry, router, and provider stubs
- Add isolated tests
- No production sending changes

### Phase 1 — Android test sender

- Install Android SMS Gateway on Oppo A38
- Enable Local Server
- Add one sender profile
- Test one SMS to the user's own number
- Record accepted/failed status

### Phase 2 — Android inbound replies

- Add webhook endpoint
- Normalize `sms:received`
- Feed reply into current classifier
- Verify STOP propagation

### Phase 3 — iPhone/Mac sender

- Enable iPhone Text Message Forwarding to MacBook
- Install `imsg`
- Grant Full Disk Access and Messages automation permission
- Test one SMS to the user's own number
- Add `imsg watch` intake process

### Phase 4 — Mamba UI

- Sender Devices panel
- Tick boxes and limits
- Test connection and test-send controls
- Campaign progress by channel

### Phase 5 — Controlled pilot

- Use only contacts with valid channel consent
- Start with five contacts per sender
- One SMS only
- Manually review replies and failures
- Expand only after the logs and STOP handling are correct

### Phase 6 — WhatsApp provider extraction

- Wrap existing Evolution calls in `whatsapp-evolution.mjs`
- Route all sends through the common router
- Preserve current campaign restart, duplicate prevention, and reply cancellation behaviour

## 15. Definition of Done

The feature is ready when:

- Mamba can health-check Android and iPhone/Mac sender profiles.
- A test message can be sent from each provider to the user's own number.
- Every outbound message has a local record and provider message ID where available.
- Incoming SMS from both routes appears in Customer Desk.
- STOP from either route blocks future WhatsApp and SMS campaigns.
- Human takeover pauses every automated channel for the same lead.
- Existing WhatsApp campaigns still pass regression tests.

## 16. Current Decision

Recommended first implementation order:

```text
1. Android Local Gateway
2. Android inbound webhook
3. iPhone/Mac imsg sending
4. iPhone/Mac inbound watcher
5. Sender UI
6. Common WhatsApp adapter
```

This order gives the fastest working test while keeping current Mamba WhatsApp operations stable.
