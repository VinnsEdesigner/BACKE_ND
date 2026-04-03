'use strict';

const logger = require('../lib/logger');
const { HTTP } = require('../utils/constants');

const START_TIME = Date.now();

function warmup(req, res) {
  const uptimeSeconds = Math.floor((Date.now() - START_TIME) / 1000);

  logger.debug('warmup', 'Ping received', {
    uptime: `${uptimeSeconds}s`,
    source: req.headers['user-agent'] || 'unknown',
  });

  return res.status(HTTP.OK).json({
    status: 'alive',
    uptime: uptimeSeconds,
    timestamp: new Date().toISOString(),
  });
}

module.exports = warmup;
