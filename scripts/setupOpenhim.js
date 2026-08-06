require('dotenv').config();
const axios = require('axios');
const https = require('https');
const mediatorConfig = require('../mediatorConfig.json');

// Channels aren't auto-created when the mediator registers -- OpenHIM only
// stores mediatorConfig.json's defaultChannelConfig as a console-importable
// suggestion. This script actually creates/updates them via the admin API so
// `docker compose up` produces a working setup, not just documentation.
const CHANNEL_NAMES = [
  'OpenMRS to Mediator Order Push',
  'Mediator to AdvaPACS Order Push'
];

const api = axios.create({
  baseURL: process.env.OPENHIM_API_URL,
  auth: {
    username: process.env.OPENHIM_USERNAME,
    password: process.env.OPENHIM_PASSWORD
  },
  httpsAgent: new https.Agent({
    rejectUnauthorized: process.env.OPENHIM_TRUST_SELF_SIGNED !== 'true'
  })
});

// Defensive: don't trust compose healthcheck timing alone (the reference
// healthcheck this project is modeled on was silently broken -- see
// docker-compose.yml) -- poll the admin API directly until it responds.
async function waitForOpenhim(retries = 30, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await api.get(`/authenticate/${process.env.OPENHIM_USERNAME}`);
      return;
    } catch (err) {
      if (attempt === retries) {
        throw new Error(`OpenHIM core never became reachable at ${process.env.OPENHIM_API_URL}: ${err.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function upsertChannel(channelDef) {
  // channelDef's autoRetryEnabled/autoRetryPeriodMinutes/autoRetryMaxAttempts
  // (set in mediatorConfig.json's defaultChannelConfig) only cover connection
  // failures/timeouts talking to the route host -- OpenHIM does NOT retry a
  // 4xx/5xx *response* from AdvaPACS itself (that only auto-retries when the
  // response is shaped like OpenHIM's own mediator-error envelope, which a
  // plain external FHIR API won't send). A real AdvaPACS error today just
  // surfaces as a normal failed transaction with no further retry or
  // alerting -- see the comment above advapacsClient.js's createServiceRequest.
  const { data: existing } = await api.get('/channels');
  const match = existing.find((c) => c.name === channelDef.name);

  if (match) {
    await api.put(`/channels/${match._id}`, channelDef);
    console.log(`Updated channel "${channelDef.name}"`);
  } else {
    await api.post('/channels', channelDef);
    console.log(`Created channel "${channelDef.name}"`);
  }
}

async function main() {
  await waitForOpenhim();
  const channels = mediatorConfig.defaultChannelConfig.filter((c) => CHANNEL_NAMES.includes(c.name));
  for (const channel of channels) {
    await upsertChannel(channel);
  }
}

main().catch((err) => {
  console.error('Failed to set up OpenHIM channels:', err.message);
  process.exit(1);
});
