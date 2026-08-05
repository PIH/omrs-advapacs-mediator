require('dotenv').config();
const express = require('express');
const bodyParser = express.json;
const medUtils = require('openhim-mediator-utils');

const logger = require('./lib/logger');
const advapacs = require('./lib/advapacsClient');
const orderPoller = require('./lib/orderPoller');
const mediatorConfig = require('../mediatorConfig.json');

const serviceRequestRoute = require('./routes/serviceRequest');
const subscriptionWebhookRoute = require('./routes/subscriptionWebhook');

const openhimConfig = {
  username: process.env.OPENHIM_USERNAME,
  password: process.env.OPENHIM_PASSWORD,
  apiURL: process.env.OPENHIM_API_URL,
  trustSelfSigned: process.env.OPENHIM_TRUST_SELF_SIGNED === 'true'
};

function startServer() {
  const app = express();
  app.use(bodyParser({ type: ['application/json', 'application/fhir+json'] }));

  app.use('/', subscriptionWebhookRoute);

  // ORDER_INGESTION_MODE picks how OpenMRS ServiceRequests reach us: 'push'
  // (default) mounts the HTTP endpoint for OpenMRS/an event listener module
  // to POST to; 'poll' instead has us pull from OpenMRS on an interval. Both
  // funnel into the same lib/orderRelay.js logic -- see .env.example.
  if (process.env.ORDER_INGESTION_MODE === 'poll') {
    orderPoller.start(Number(process.env.ORDER_POLL_INTERVAL_MS) || 60000);
  } else {
    app.use('/', serviceRequestRoute);
  }

  app.get('/health', (req, res) => res.status(200).json({ status: 'up' }));

  const port = process.env.MEDIATOR_PORT || 3500;
  app.listen(port, () => {
    logger.info(`OpenMRS-AdvaPACS mediator listening on port ${port}`);
  });
}

async function registerAndStart() {
  medUtils.registerMediator(openhimConfig, mediatorConfig, (err) => {
    if (err) {
      logger.error('Failed to register mediator with OpenHIM core', { error: err.message || err });
      process.exit(1);
    }

    medUtils.activateHeartbeat(openhimConfig);
    logger.info('Registered with OpenHIM core and activated heartbeat');

    startServer();

    // One-time setup: make sure AdvaPACS has a live Subscription pointed at
    // our webhook. Safe to leave in on every boot; AdvaPACS treats repeat
    // registration of an equivalent Subscription as idempotent-ish, but
    // consider gating this behind an explicit CLI flag in production.
    const webhookUrl = `${process.env.OPENHIM_API_URL}/webhooks/advapacs`;
    advapacs
      .ensureSubscription(webhookUrl, process.env.ADVAPACS_WEBHOOK_SECRET, 'ImagingStudy')
      .catch((e) => logger.warn('Could not confirm AdvaPACS subscription on startup', { error: e.message }));
  });
}

// Allow running standalone (no OpenHIM core) for local testing with
// MEDIATOR_STANDALONE=true, skipping registration/heartbeat entirely.
if (process.env.MEDIATOR_STANDALONE === 'true') {
  startServer();
} else {
  registerAndStart();
}
