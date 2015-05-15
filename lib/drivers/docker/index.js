'use strict';

var _ = require('lodash');
var async = require('async');
var bl = require('bl');
var debug = require('debug')('strong-pm:docker:driver');
var Docker = require('dockerode');
var EventEmitter = require('events').EventEmitter;
var Image = require('./image');
var inherits = require('util').inherits;
var isError = require('util').isError;

module.exports = exports = DockerDriver;

function DockerDriver(opts) {
  if (!opts.baseDir || !opts.console || !opts.server) {
    throw Error('Requires baseDir, console, and server');
  }
  if (!(this instanceof DockerDriver)) {
    return new DockerDriver(opts);
  }
  EventEmitter.call(this);
  this.docker = new Docker();

  this.baseDir = opts.baseDir;
  this.console = opts.console;
  this.server = opts.server;

  this.instances = {};

  this.defaultStartOptions = {
    profile: true,
    trace: false,
    size: 'STRONGLOOP_CLUSTER' in process.env ?
      process.env.STRONGLOOP_CLUSTER : 'CPU',
  };

  this.on('request', this._onRequest.bind(this));
}

inherits(DockerDriver, EventEmitter);

DockerDriver.prototype.setStartOptions = function(id, opts) {
  debug('DockerDriver.setStartOptions(%j, %j)', id, opts);
  // console.trace();
  var instance = this._instance(id);
  var original = _.clone(instance.startOpts);

  instance.startOpts = _.merge(instance.startOpts, opts);

  if (opts.size != null && opts.size !== original.size) {
    debug('cluster size changed, sending set-size: %j => %j', id, opts);
    this.requestOfInstance(id, {cmd: 'set-size', size: opts.size});
  } else {
    // debug('cluster size unchanged');
  }
};

DockerDriver.prototype.removeInstance = function(id, cb) {
  debug('DockerDriver.removeInstance(%j)', id);
  var instance = this._instance(id);
  if (instance.current) {
    instance.current.kill('SIGKILL', cb);
    delete instance.current;
  } else {
    setImmediate(cb);
  }
};

DockerDriver.prototype.deployInstance = function(id, req, res) {
  debug('DockerDriver.deployInstance(%j)', id);
  var self = this;
  var instance = this._containerById(id);
  var image = Image.from(this, id, this.baseDir, req, res);
  instance.next = image;
  image.on('error', function(err) {
    console.error('error deploying: %s, %j', err, err);
    throw err;
  });
  image.on('image', function() {
    debug('Deployment image:', image.name);
    self.instances[id].next.image = image;
    self.startInstance(id, function(err) {
      debug('deployInstance -> startInstance -> ', err);
    });
  });
};

DockerDriver.prototype.startInstance = function(id, cb) {
  debug('DockerDriver.startInstance(%j, %j)', id, cb.name);
  var instance = this._instance(id);
  var toLaunch = instance.next || instance.currentImage || instance.previous;
  var img = toLaunch.image;
  var self = this;
  this.server.getInstanceEnv(id, function(err, env) {
    if (err) return cb(err);
    // ensure environment variable values have been stringified
    env = _.mapValues(env, String);
    var opts = _.merge(instance.startOpts, {env: env});
    instance.log.enableGC();
    var previous = instance.current;
    instance.current = img.start(instance.log, opts);
    instance.previous = instance.currentImage;
    instance.currentImage = toLaunch;
    delete instance.next;
    instance.current.on('request', function(req) {
      debug('bubbling up request from instance %j:', id, req);
      self.emit('request', id, req);
    });
    instance.current.on('error', function(err) {
      console.error('error from docker child %j:', id, err);
    });
    instance.current.on('starting', function() {
      instance.ports = [];
      if (previous) {
        previous.kill('SIGKILL', function() {
          previous.destroy();
        });
      }
    });
    instance.current.on('exit', function(err) {
      if (isError(err) && err.statusCode === 404) {
        self.startInstance(id, function() {
          console.log('restarted instance after container disappeared (exit)');
        });
      }
    });
    if (cb) {
      instance.current.on('connected', cb);
    }
  });
};

DockerDriver.prototype._onRequest = function(instanceId, req) {
  debug('DockerDriver._onRequest(%j)', instanceId, req);
  var instance = this._instance(instanceId);
  switch (req.cmd) {
    case 'listening':
      // emit a listening event each time a _new_ port is listened on
      if (instance.ports.indexOf(req.address.port) < 0) {
        instance.ports.push(req.address.port);
        this.emit('listening', instanceId, req.address);
      }
  }
};

DockerDriver.prototype.stopInstance = function(id, style, cb) {
  debug('DockerDriver.stopInstance(%j, %j, %s)', id, style, cb.name);
  var instance = this._instance(id);
  instance.shouldRestart = false;
  switch (style) {
    case 'soft':
      return this.requestOfInstance(id, {cmd: 'stop'}, cb);
    case 'hard':
    default:
      if (instance.current) {
        return instance.current.kill('SIGTERM', reportExit);
      } else {
        return cb(Error('No such instance: ' + id));
      }
  }
  function reportExit(err, res) {
    debug('stopped container for instance %j:', id, err, res);
    cb(err, res);
  }
};

DockerDriver.prototype._onContainerStopped = function(id, app) {
  console.error('container stream stopped for some reason!', id, app);
};

DockerDriver.prototype.dumpInstanceLog = function(id) {
  debug('DockerDriver.dumpInstanceLog(%j)', id);
  var instance = this._instance(id);
  if (!instance.current) {
    debug('no instance to dump logs for: %j', id);
    return null;
  }
  var logDump = instance.log.duplicate().toString();
  instance.log.consume(logDump.length);
  return logDump;
};

DockerDriver.prototype.updateInstanceEnv = function(id, env, cb) {
  debug('DockerDriver.updateInstanceEnv(%j)', id);
  var self = this;
  var current = this._instance(id).current;
  if (!current) {
    debug('no instance to update env of: %j', id);
    return setImmediate(cb);
  }
  // Environment variables can only really have string values, so make sure we
  // are consistent with that so our comparisons are reliable.
  env = _.mapValues(env, String);
  debug('updating instance %j env: %j', id, env);
  if (_.isEqual(current.env, env)) {
    debug('env unchanged, skipping restart: %j', id);
    return cb && setImmediate(cb);
  } else {
    debug('env changed, restarting %j: %j => %j', id, current.env, env);
    // env is alredy a copy
    current.env = env;
    return self.requestOfInstance(id, {cmd: 'env-set', env: env}, function() {
      self.requestOfInstance(id, {cmd: 'restart'}, function(rsp) {
        cb(rsp && rsp.error, rsp);
      });
    });
  }
};

DockerDriver.prototype.requestOfInstance = function(id, req, cb) {
  debug('DockerDriver.requestOfInstance(%j)', id);
  var current = this._instance(id).current;
  if (current) {
    debug('requesting of %j: %j', id, req);
    return current.request(req, cb);
  } else if (cb) {
    setImmediate(cb({error: 'Cannot send request to instance'}));
  }
};

DockerDriver.prototype.start = function(instanceMetas, cb) {
  debug('DockerDriver.start(%j, %s)', instanceMetas, cb.name);
  // TODO(rmg):
  //   1. Get list of currently running docker containers.
  //   2. Compare containers to instanceMetas
  //   3. Create internal instances from matching containers
  //   4. Start new containers from missing instances
  var self = this;
  this.docker.info(function(err, info) {
    self.dockerInfo = info;
    self.CPUS = info.NCPU;
    debug('Connected to docker:', err, info);
    cb(err);
  });
};

DockerDriver.prototype.stop = function(cb) {
  var self = this;

  async.each(Object.keys(this.instances), stopInstanceById, cb);

  function stopInstanceById(id, next) {
    self.stopInstance(id, 'hard', next);
  }
};

DockerDriver.prototype._instance =
DockerDriver.prototype._containerById = function(id) {
  this.instances[id] = this.instances[id] || {
    startOpts: _.clone(this.defaultStartOptions),
    log: makeLogBuffer(),
  };
  return this.instances[id];
};

// This is a soft limit that is only checked/enforced once per LOG_GC interval.
exports.MAX_LOG_RETENTION_BYTES = 1 * 1024 * 1024;
exports.LOG_GC_INTERVAL_MS = 30 * 1000;

function makeLogBuffer() {
  var logger = bl();
  logger.enableGC = function() {
    logger._logGcTimer = logger._logGcTimer || makeGcTimer();
  };
  logger.on('end', function() {
    if (logger._logGcTimer) {
      clearInterval(logger.logGcTimer);
      logger._logGcTimer = null;
    }
  });
  return logger;

  function gcLogger() {
    var overflow = logger.length - exports.MAX_LOG_RETENTION_BYTES;
    if (overflow > 0) {
      logger.consume(overflow);
    }
  }

  function makeGcTimer() {
    var timer = setInterval(gcLogger, exports.LOG_GC_INTERVAL_MS);
    timer.unref();
    return timer;
  }
}

DockerDriver.prototype.getName = function() {
  return 'Docker';
};

DockerDriver.prototype.getStatus = function() {
  return 'running';
};
