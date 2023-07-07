const URL = require('url')
const http = require('http')
const cuid = require('cuid')
const Corsify = require('corsify')
const sendJson = require("send-data/json")
const ReqLogger = require('req-logger')
const healthPoint = require('healthpoint')
const HttpHashRouter = require('http-hash-router')
const redis = require('./redis')
const version = require('../package.json').version

const router = HttpHashRouter()
const logger = ReqLogger({ version: version })
const health = healthPoint({ version: version }, redis.healthCheck)
const cors = Corsify({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, accept, content-type'
})

const BUCKET_NAME = 'targets';

router.set('/favicon.ico', empty)

module.exports = function createServer () {
  return http.createServer(cors(handler))
}

const getJSONfromRequest = (req, res) => {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    })

    req.on('end', () => {
      try {
        const result = JSON.parse(body);
        resolve(result);
      } catch (err) {
        onError(req, res, {
          message: "Request failed"
        })
      }
    })
  })
}

router.set('/api/targets', async (req, res) => {
  try {
    switch (req.method) {
      case 'GET':
        redis.hvals(BUCKET_NAME, (err, targetValues) => {
          if(err) onError(req, res, { message: "Failed to fetch all targets" });

          const targets = targetValues.map(tv => JSON.parse(tv));
          return sendJson(req, res, targets);
        })
        break;
      case 'POST':
        const body = await getJSONfromRequest(req, res);
        const { id, url, value, maxAcceptsPerDay, accept } = body;
        const newTarget = {
          id,
          url,
          value,
          maxAcceptsPerDay,
          accept
        };

        redis.hset(BUCKET_NAME, id, JSON.stringify(newTarget), err => {
          if(err) onError(req, res, { message: "Failed to save target" });
          return sendJson(req, res, newTarget);
        });
        break;
    }
  } catch(err) {
    return onError(req, res, { statusCode: 500, message: err });
  }

});

router.set('/api/targets/:id', async (req, res, opt) => {
  try {
    const body = await getJSONfromRequest(req, res);
    const { id } = opt.params;
    redis.hget(BUCKET_NAME, id, (err, targetValue) => {
      if(err) onError(req, res, { message: "Failed to fetch target" });
      if(!targetValue) onError(req, res, { message: "Target Not Found", statusCode: 404 });
      const target = JSON.parse(targetValue);

      switch (req.method) {
        case 'GET':
          return sendJson(req, res, target);
          break;
        case 'POST':
          const { url, value, maxAcceptsPerDay, accept } = body;
          target.url              = url || target.url;
          target.value            = value || target.value;
          target.maxAcceptsPerDay = maxAcceptsPerDay || target.maxAcceptsPerDay;
          target.accept           = accept || target.accept;

          redis.hset(BUCKET_NAME, id, JSON.stringify(target), err => {
            if(err) onError(req, res, { message: "Failed to update target" });
            return sendJson(req, res, target);
          });
          break;
      }
    })
  } catch(err) {
    return onError(req, res, { statusCode: 500, message: err });
  }

});

router.set('route', async (req, res) => {
  try {
    const visitorInfo = await getJSONfromRequest(req, res);

    redis.hvals(BUCKET_NAME, async (err, targetValues) => {
      if(err) onError(req, res, { message: "Failed to make a decision :(" });

      const targets = targetValues.map(tv => JSON.parse(tv));
      const filteredTargets = targets.filter(target => {
        const acceptCriteria = target.accept;

        if(acceptCriteria.geoState && !acceptCriteria.geoState.$in.includes(visitorInfo.geoState)) {
          return false;
        }
        if(acceptCriteria.hour && !acceptCriteria.hour.$in.includes(new Date().getUTCHours().toString())) {
          return false;
        }
        return true;
      })

      if(filteredTargets.length === 0) {
        return sendJson(req, res, { decision: "reject" });
      }

      let targetWithHighestValue = null;
      for(const target of filteredTargets) {
        const targetId = target.id;
        const acceptsCount = await getAcceptCount(targetId);
        if(acceptsCount < target.maxAcceptsPerDay) {
          if(!targetWithHighestValue || target.value > targetWithHighestValue.value) {
            targetWithHighestValue = target;
          }
        }
      }

      if(!targetWithHighestValue) {
        return sendJson(req, res, { decision: "reject" });
      }

      incrementAcceptsCount(targetWithHighestValue.id);
      return sendJson(req, res, { decision: "accept", url: targetWithHighestValue.url });
    })
  } catch (err) {
    return onError(req, res, { statusCode: 500, message: err });
  }

});

const incrementAcceptsCount = targetId => {
  const date = new Date().toISOString().split('T')[0];
  const key = `accepts:${date}:${targetId}`;

  redis.incr(key);
  redis.expireat(key, Math.floor(Date.now() / 1000) + 86400)
}

const getAcceptCount = targetId => {
  return new Promise((resolve, reject) => {
    const date = new Date().toISOString().split('T')[0];
    const key = `accepts:${date}:${targetId}`;

    redis.get(key, (err, count) => {
      if(err) {
        reject(err);
      } else {
        resolve(parseInt(count) || 0);
      }
    })
  });
}

async function handler (req, res) {
  if (req.url === '/health') return health(req, res)
  req.id = cuid()
  logger(req, res, { requestId: req.id }, function (info) {
    info.authEmail = (req.auth || {}).email
    console.log(info)
  })
  router(req, res, { query: getQuery(req.url) }, onError.bind(null, req, res))
}

function onError (req, res, err) {
  if (!err) return

  res.statusCode = err.statusCode
  logError(req, res, err)

  sendJson(req, res, {
    statusCode: err.statusCode || 500,
    body: { message: err.message }
  })
}

function logError (req, res, err) {
  if (process.env.NODE_ENV === 'test') return

  var logType = res.statusCode >= 500 ? 'error' : 'warn'

  console[logType]({
    err: err,
    requestId: req.id,
    statusCode: res.statusCode
  }, err.message)
}

function empty (req, res) {
  res.writeHead(204)
  res.end()
}

function getQuery (url) {
  return URL.parse(url, true).query // eslint-disable-line
}
