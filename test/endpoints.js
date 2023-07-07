process.env.NODE_ENV = 'test'

var test = require('ava')
var servertest = require('servertest')

var server = require('../lib/server')

test.serial.cb('healthcheck', function (t) {
  var url = '/health'
  servertest(server(), url, { encoding: 'json' }, function (err, res) {
    t.falsy(err, 'no error')

    t.is(res.statusCode, 200, 'correct statusCode')
    t.is(res.body.status, 'OK', 'status is ok')
    t.end()
  })
})

// https://github.com/rvagg/archived-servertest/pull/11
const sampleTarget = {
  "id": "1",
  "url": "http://example.com",
  "value": "0.50",
  "maxAcceptsPerDay": "10",
  "accept": {
    "geoState": {
      "$in": ["ca", "ny"]
    },
    "hour": {
      "$in": [ "13", "14", "15" ]
    }
  }
}

const updatedTarget = {
  "id": "1",
  "url": "https://google.com",
  "value": "0.50",
  "maxAcceptsPerDay": "10",
  "accept": {
    "geoState": {
      "$in": ["ca", "ny"]
    },
    "hour": {
      "$in": [ "13", "14", "15" ]
    }
  }
}

test.serial.cb('Making a decision', t => {
  servertest(server(), '/api/targets', { method: 'POST', json: sampleTarget }, async (err, res) => {
    t.is(res.statusCode, 200)
    t.deepEqual(res.body, sampleTarget)
    t.end()
  });

  servertest(server(), '/api/targets/1', { method: 'GET' }, function (err, res) {
    t.is(res.statusCode, 200)
    t.deepEqual(res.body, sampleTarget)
    t.end()
  });

  servertest(server(), '/api/targets', { method: 'GET' }, function (err, res) {
    t.is(res.statusCode, 200)
    t.deepEqual(res.body, [sampleTarget])
    t.end()
  });

  servertest(server(), '/api/targets/1', { method: 'POST', json: updatedTarget }, async (err, res) => {
    t.is(res.statusCode, 200)
    t.deepEqual(res.body, updatedTarget)
    t.end()
  });

  servertest(server(), '/route', { method: 'POST', json: {
      "geoState": "ny",
      "publisher": "abc",
      "timestamp": new Date().toISOString()
    }}, async (err, res) => {
    t.is(res.statusCode, 200)
    t.is(res.body.status, 'OK', 'status is ok');
    t.end()
  });


});
