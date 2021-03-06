process.env.STRONGLOOP_CLUSTER = 1;

var app = require('./helper');
var assert = require('assert');
var async = require('async');
var exec = require('child_process').exec;
var path = require('path');
var util = require('util');

// TODO: convert to tap test and use tap@1's --bail option instead of asserts
//       to get early bailout on the first failure.

var server = app.listen();
var cpuProfilingSupported = require('semver').gt(process.version, '0.11.0');

var REPO = 'some-repo-name';

function pmctl(/*arguments..., callback*/) {
  var cli = require.resolve('../bin/sl-pmctl.js');
  var args = Array.prototype.slice.call(arguments);
  var callback = args.pop();

  var cmd = cli + ' ' + util.format.apply(util, args);
  var out = exec(cmd, function(err, stdout, stderr) {
    output = stdout.trim() + stderr.trim();
    console.log('Run: %s => err: %j stdout <\n%s>', cmd, err, output);
    assert.ifError(err);
    setImmediate(callback);
  });
}

server.on('listening', function() {
  app.push(REPO);
});

var ServiceProcess = server._meshApp.models.ServiceProcess;
var ServiceInstance = server._meshApp.models.ServiceInstance;

function testInitialInstState(cb) {
  ServiceInstance.findOne(function(err, instance) {
    assert.ifError(err);
    assert(instance.agentVersion, 'Agent version should be set');
    assert.equal(instance.applicationName, 'test-app');
    assert(instance.containerVersionInfo, 'Container info should be set');
    assert.equal(instance.restartCount, 0);
    assert.equal(instance.setSize, 1);
    assert(instance.startTime, 'Start time should be set');
    assert.equal(instance.started, true);
    cb(err);
  });
}

function testInstanceState(expected, cb) {
  ServiceInstance.findOne(function(err, instance) {
    assert.ifError(err);
    console.log('testInstanceState: expect started=%j:', expected, instance);
    assert.equal(instance.started, expected);
    cb(err);
  });
}

function testInitialWorkerState(cb) {
  ServiceProcess.findOne({where: { workerId: 1 }}, function(err, proc) {
    assert.ifError(err);
    assert.equal(proc.isProfiling, false);
    assert.equal(proc.isSnapshotting, false);
    assert.equal(proc.isTrackingObjects, false);
    assert(proc.startTime, 'Start time should be set');
    assert(!proc.stopTime, 'Stop time should not be set');
    assert(!proc.stopReason, 'Stop reason should not be set');
    cb(err);
  });
}

function testCpuStart(cb) {
  if (!cpuProfilingSupported) return cb();

  ServiceProcess.findOne({where: { workerId: 1 }}, function(err, proc) {
    assert.ifError(err);
    assert(proc, 'worker 1 exists');
    assert.equal(proc.isProfiling, true, 'worker 1 is profiling');
    cb(err);
  });
}

function testCpuStop(cb) {
  if (!cpuProfilingSupported) return cb();

  ServiceProcess.findOne({where: { workerId: 1, stopTime: null }},
    function(err, proc) {
      assert.ifError(err);
      assert.equal(proc.isProfiling, false);
      cb(err);
    }
  );
}

function testCpuWatchdogStart(cb) {
  if (!cpuProfilingSupported) return cb();

  ServiceProcess.findOne({where: { workerId: 1, stopTime: null }},
    function(err, proc) {
      assert.ifError(err);
      assert.equal(proc.isProfiling, true);
      assert.equal(proc.watchdogTimeout, 1000);
      cb(err);
    }
  );
}

function testObjTrackingStart(cb) {
  ServiceProcess.findOne({where: { workerId: 1 }}, function(err, proc) {
    assert.ifError(err);
    assert.equal(proc.isTrackingObjects, true);
    cb(err);
  });
}

function testObjTrackingStop(cb) {
  ServiceProcess.findOne({where: { workerId: 1 }}, function(err, proc) {
    assert.ifError(err);
    assert.equal(proc.isTrackingObjects, false);
    cb(err);
  });
}

function testWorkerExitState(cb) {
  server.once('exit', function() {
    ServiceProcess.findOne({where: { workerId: 1}}, function(err, proc) {
      assert.ifError(err);
      assert.equal(proc.isProfiling, false);
      assert.equal(proc.isSnapshotting, false);
      assert.equal(proc.isTrackingObjects, false);
      assert(proc.startTime, 'Start time should be set');
      assert(proc.stopTime, 'Stop time should be set');
      assert(proc.stopReason, 'Stop reason should be set');
      cb(err);
    });
  });
  pmctl('set-size 1 0', function(){});
}

function killClusterMaster(cb) {
  ServiceProcess.findOne({where: { workerId: 0}}, function(err, proc) {
    server.once('running', function() {
      cb();
    });
    process.kill(proc.pid, 'SIGTERM');
  });
}

function testRestartedInstState(cb) {
  ServiceInstance.findOne(function(err, instance) {
    assert.ifError(err);
    assert.equal(instance.restartCount, 1);
    cb(err);
  });
}

function testTotalWorkers(cb) {
  ServiceProcess.find(function(err, procs) {
    assert.ifError(err);
    assert.equal(procs.length, 4);
    cb(err);
  });
}

function waitForWorkers(cb) {
  waitForWorkers.count = waitForWorkers.count || 0;
  waitForWorkers.count += 1;
  ServiceProcess.find(function(err, procs) {
    console.log('# checked %d times waiting for a worker', waitForWorkers.count);
    // supervisor + workers
    if (procs.length > 1) {
      return cb();
    } else if (waitForWorkers.count > 20) {
      return cb(err || Error('no workers'));
    } else {
      return setTimeout(waitForWorkers.bind(null, cb), 100);
    }
  });
}

server.once('running', function() {
  var tests = [
    testInitialInstState,
    testInitialWorkerState,
    pmctl.bind(null, 'set-size 1 1'),
    pmctl.bind(null, 'status 1'),
    waitForWorkers,
    pmctl.bind(null, 'status 1'),
    pmctl.bind(null, 'cpu-start 1.1.1'),
    testCpuStart,
    pmctl.bind(null, 'cpu-stop 1.1.1'),
    testCpuStop,
    pmctl.bind(null, 'objects-start 1.1.1'),
    testObjTrackingStart,
    pmctl.bind(null, 'objects-stop 1.1.1'),
    testObjTrackingStop,
    testWorkerExitState,
    killClusterMaster,
    testRestartedInstState,
    testTotalWorkers,
    testInstanceState.bind(null, true),
    pmctl.bind(null, 'stop 1'),
    pmctl.bind(null, 'status 1'),
    pmctl.bind(null, 'status 1'),
    pmctl.bind(null, 'status 1'),
    testInstanceState.bind(null, false)
  ];

  if (process.platform === 'XXX' + 'linux') {
    tests.push(
      pmctl.bind(null, 'start 1'),
      pmctl.bind(null, 'cpu-start 1.1.1 1000'),
      testCpuWatchdogStart,
      pmctl.bind(null, 'cpu-stop 1.1.1'),
      testCpuStop);
  }

  tests.push(server.stop.bind(server));
  async.series(tests, function(err) {
    assert.ifError(err);
    app.ok = 1;
  });
});
