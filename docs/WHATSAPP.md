# Connecting the agent to WhatsApp

This app speaks the **WhatsApp Cloud API** (Meta-hosted — no ManyChat/Twilio needed,
though you can put one in front if you prefer). Below is the end-to-end setup.

## 1. Create the Meta app

1. Go to <https://developers.facebook.com/> → **My Apps** → **Create App** → type
   **Business**.
2. Add the **WhatsApp** product. Meta gives you a **test phone number** and a
   **Phone number ID** immediately — enough to develop against.
3. In **WhatsApp → API Setup** you'll find a temporary **access token**. For production,
   create a **System User** with a **permanent token** (Business Settings → System Users
   → generate token with `whatsapp_business_messaging` + `whatsapp_business_management`).
4. Copy the **App Secret** from **App Settings → Basic**.

## 2. Configure the service

Put the values in `.env`:

```
WHATSAPP_TOKEN=<permanent or temporary access token>
WHATSAPP_PHONE_NUMBER_ID=<phone number id>
WHATSAPP_VERIFY_TOKEN=<invent any string, e.g. cyprus-agent-123>
WHATSAPP_APP_SECRET=<app secret>
ANTHROPIC_API_KEY=<your key>
```

## 3. Expose the webhook

The webhook must be reachable over HTTPS.

- **Local dev:** run the app (`uvicorn app.main:app --port 8000`) and tunnel it:
  ```
  ngrok http 8000
  ```
  Use the `https://…ngrok…` URL below.
- **Production:** deploy the container (see the repo README) behind HTTPS. Host in the
  **EU** (e.g. AWS Frankfurt) for GDPR — see Phase 5 in the README.

## 4. Register the webhook with Meta

In **WhatsApp → Configuration → Webhook**:

- **Callback URL:** `https://YOUR_HOST/webhook/whatsapp`
- **Verify token:** the same string you put in `WHATSAPP_VERIFY_TOKEN`
- Click **Verify and save** — Meta calls `GET /webhook/whatsapp`, the app echoes the
  challenge, and verification succeeds.
- **Subscribe** to the **messages** field.

## 5. Test it

Message your WhatsApp test number (or add your own number as a recipient in API Setup).
Try:

- `menu`
- `How do I get a Yellow Slip?`  → grounded answer with sources
- `checklist` → pick a topic → answer 3 questions → receive a **PDF checklist**
- `form` → pick MEU1/TD1 → send your details in plain text → reply `done` → receive a
  **pre-filled PDF**
- `delete my data` → GDPR erasure

## Testing without Meta

You don't need WhatsApp to exercise the whole conversation engine. The `POST /simulate`
endpoint runs the exact same router and returns the outbound messages (and PDF paths):

```bash
curl -s localhost:8000/simulate -H 'content-type: application/json' \
  -d '{"user_id":"me","text":"checklist"}' | jq
```

## How message sending works

Text replies are sent via `POST /{phone_number_id}/messages`. PDFs are sent by first
uploading to `POST /{phone_number_id}/media` (returns a media id) and then sending a
`document` message referencing that id — so no public file URL is required. Inbound
webhook POSTs are verified with the `X-Hub-Signature-256` HMAC using your app secret.

Inbound processing runs in a background task so the webhook returns `200` immediately
(Meta retries on slow responses); duplicate deliveries are de-duplicated by message id.
