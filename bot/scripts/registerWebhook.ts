import { loadConfig } from '../src/config';

async function main() {
  const config = loadConfig();

  if (config.OPENWA_FLAVOR !== 'openwa-gateway') {
    console.error(
      '[register-webhook] Only supported for OPENWA_FLAVOR="openwa-gateway".'
    );
    process.exit(1);
  }

  const publicUrl = process.env.WEBHOOK_PUBLIC_URL;
  if (!publicUrl) {
    console.error(
      '[register-webhook] WEBHOOK_PUBLIC_URL is required to register a webhook.'
    );
    process.exit(1);
  }

  const sessionId = config.OPENWA_SESSION_ID;
  if (!sessionId) {
    console.error('[register-webhook] OPENWA_SESSION_ID is required.');
    process.exit(1);
  }

  const secret = config.WEBHOOK_HMAC_SECRET;
  if (!secret || secret.length < 16) {
    console.error(
      '[register-webhook] WEBHOOK_HMAC_SECRET must be at least 16 characters.'
    );
    process.exit(1);
  }

  const baseUrl = config.OPENWA_BASE_URL;
  const apiKey = config.OPENWA_API_KEY;
  const listUrl = `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/webhooks`;

  const headers = {
    'content-type': 'application/json',
    [config.apiKeyHeader]: apiKey,
  };

  console.log(`Checking existing webhooks for session "${sessionId}"...`);
  const listRes = await fetch(listUrl, { headers });
  if (!listRes.ok) {
    const text = await listRes.text();
    console.error(`Failed to list webhooks (HTTP ${listRes.status}): ${text}`);
    process.exit(1);
  }

  const webhooks: any = await listRes.json();
  const existing = Array.isArray(webhooks)
    ? webhooks.find((w: any) => w.url === publicUrl)
    : undefined;

  const payload = {
    url: publicUrl,
    events: ['message.received'],
    secret,
    filters: {
      conditions: [
        { field: 'fromMe', operator: 'is', value: false },
        { field: 'isGroup', operator: 'is', value: false },
      ],
    },
    retryCount: 3,
  };

  if (existing && existing.id) {
    console.log(
      `Updating existing webhook ${existing.id} with URL ${publicUrl}...`
    );
    const updateUrl = `${listUrl}/${encodeURIComponent(existing.id)}`;
    const putRes = await fetch(updateUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload),
    });
    if (!putRes.ok) {
      const text = await putRes.text();
      console.error(
        `Failed to update webhook (HTTP ${putRes.status}): ${text}`
      );
      process.exit(1);
    }
    const result = await putRes.json();
    console.log('Webhook updated successfully:', {
      id: result.id,
      url: result.url,
      events: result.events,
      retryCount: result.retryCount,
    });
  } else {
    console.log(`Registering new webhook with URL ${publicUrl}...`);
    const postRes = await fetch(listUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!postRes.ok) {
      const text = await postRes.text();
      console.error(
        `Failed to register webhook (HTTP ${postRes.status}): ${text}`
      );
      process.exit(1);
    }
    const result = await postRes.json();
    console.log('Webhook registered successfully:', {
      id: result.id,
      url: result.url,
      events: result.events,
      retryCount: result.retryCount,
    });
  }
}

main().catch((err) => {
  console.error('Fatal error during webhook registration:', err.message);
  process.exit(1);
});
