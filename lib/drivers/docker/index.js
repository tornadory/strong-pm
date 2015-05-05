'use strict';

var _ = require('lodash');
var async = require('async');
var Deployment = require('./deployment');
var EventEmitter = require('events').EventEmitter;
var debug = require('debug')('strong-pm:docker-driver');
var fmt = require('util').format;
var inherits = require('util').inherits;
var sCtl = require('strong-control-channel/client');
var sdr = require('strong-docker-run');

module.exports = exports = DockerDriver;

function DockerDriver(opts) {
  if (!opts.baseDir || !opts.console || !opts.server) {
    throw Error('Requires baseDir, console, and server');
  }
  if (!(this instanceof DockerDriver)) {
    return new DockerDriver(opts);
  }
  EventEmitter.call(this);

  this.baseDir = opts.baseDir;
  this.console = opts.console;
  this.server = opts.server;

  this.instances = {};

  this.defaultStartOptions = {
    profile: true,
    trace: false,
    size: 'CPU',
  };

  this.on('request', this._onRequest.bind(this));
}

inherits(DockerDriver, EventEmitter);

DockerDriver.prototype.setStartOptions = function(id, opts) {
  var instance = this._instance(id);
  var original = _.clone(instance.startOpts);

  instance.startOpts = _.merge(instance.startOpts, opts);

  if (opts.size != null && opts.size !== original.size) {
    debug('cluster size changed, sending set-size: %j => %j', id, opts);
    this.requestOfInstance(id, {cmd: 'set-size', size: opts.size});
  } else {
    debug('cluster size unchanged');
  }
};

DockerDriver.prototype.removeInstance = function(id, cb) {
  var instance = this._instance(id);
  var current = instance.current;
  var container = current && current.app && current.app.container;
  if (container) {
    container.remove({v: true, f: true}, cb);
  } else {
    setImmediate(cb);
  }
};

DockerDriver.prototype.deployInstance = function(id, req, res) {
  debug('DockerDriver.deployInstance(%j)', id);
  var deployment = new Deployment(id, this.baseDir);
  deployment.on('error', function(err) {
    console.error('error deploying: %s, %j', err, err);
    throw err;
  });
  var self = this;
  var instance = this._containerById(id);
  instance.next = deployment;
  deployment.on('image', function(image) {
    console.error('Deployment image:', image);
    self.instances[id].next.image = image;
    self.startInstance(id, function(err) {
      console.error('deployInstance -> startInstance -> ', err);
    });
  });
  return deployment.receive(req, res);
};

DockerDriver.prototype.startInstance = function(id, cb) {
  debug('DockerDriver.startInstance(%j, %j)', id, cb.name);
  var instance = this._containerById(id);
  var toLaunch = instance.next || instance.current || instance.previous;
  var img = toLaunch.image;
  var self = this;
  this.server.getInstanceEnv(id, function(err, env) {
    if (err) return cb(err);
    var args = startArgs(instance.startOpts);
    sdr.run(img.name, args, {env: dockerEnv(env)}, function(err, app) {
      if (err) {
        throw err;
      }
      var ctlIp = app.ports.ctl.host;
      var ctlPort = app.ports.ctl.port;
      var addr = {host: ctlIp, port: ctlPort};
      var previous = instance.previous = instance.current;
      var current = instance.current = toLaunch;
      if (previous && previous.app && previous.app.container) {
        previous.emit('exit', 0);
        previous.app.container.remove({v: true, f: true}, function(err, res) {
          debug('stopped previous container for instance %j: ', id, err, res);
        });
        delete previous.app;
      }
      current.app = app;
      instance.next = null;
      current.child = {pid: 1};
      current.ports = [];
      // store intended environment (with string values) for comparison later
      current.env = _.mapValues(env, String);
      setImmediate(connectControlChannel);

      function connectControlChannel() {
        current.ctl = new sCtl.Client(addr, onResponse, onNotify, onError);
        current.ctl._socket.once('connect', updateStatus);
      }

      function updateStatus() {
        current.ctl.request({cmd: 'status'}, function(status) {
          debug(status);
          var started = {
            cmd: 'started',
            pid: status.master.pid,
            // TODO(rmg): get real appName and agentVersion
            appName: 'sample-app',
            agentVersion: '1.0.0',
          };
          started.pst = started.startTime = status.master.startTime;
          self.emit('request', id, started);
          self.emit('request', id, status);
          // XXX(rmg): soft-restart is a hack to get the cluster to report fork
          // events for all the workers since we likely missed some before the
          // control client was connected
          current.ctl.request({cmd: 'soft-restart'});
          cb();
        });
      }

      function onResponse(req) {
        // debug('onResponse: ', arguments);
        self.emit('request', id, req);
      }
      function onNotify(req) {
        // debug('onNotification: ', arguments);
        self.emit('request', id, req);
      }
      function onError(err) {
        debug('onError: ', err, err.stacktrace);
        if (err.code === 'ECONNREFUSED') {
          debug('Retrying connection');
          setTimeout(connectControlChannel, 50);
        }
        // self.emit('error', id, err);
      }

    });
  });
};

function dockerEnv(env) {
  return _.map(env, function(v, k) {
    return fmt('%s=%s', k, v);
  });
}

function startArgs(opts) {
  var args = ['--cluster=' + opts.size];
  if (opts.trace) {
    args.push('--trace');
  }
  if (!opts.profile) {
    args.push('--no-profile');
  }
  return args;
}

DockerDriver.prototype._onRequest = function(instanceId, req) {
  var instance = this._instance(instanceId);
  switch (req.cmd) {
    case 'listening':
      // emit a listening event each time a new port is listened on
      if (instance.current.ports.indexOf(req.address.port) < 0) {
        instance.current.ports.push(req.address.port);
        this.emit('listening', instanceId, req.address);
      }
  }
};

DockerDriver.prototype.stopInstance = function(id, style, cb) {
  debug('DockerDriver.stopInstance(%j, %j, %s)', id, style, cb.name);
  var current = this._instance(id).current;
  switch (style) {
    case 'soft':
      return this.requestOfInstance(id, {cmd: 'stop'}, cb);
    case 'hard':
    default:
      return current.app.container.stop({t: 5}, reportExit);
  }
  function reportExit(err, res) {
    debug('stopped container for instance %j:', id, err, res);
    current.emit('exit', 128 + 15);
    cb(err, res);
  }
};

DockerDriver.prototype.dumpInstanceLog = function(id) {
  debug('DockerDriver.dumpInstanceLog(%j)', id);
  // if async:
  //   1. lookup container by $id
  //   2. query logs using docker API
  //   3. cb with logs
  // if sync:
  //   1. lookup log buffer by $id
  //   2. copy current buffer contents
  //   3. flush log buffer
  //   4. return copy of buffer
  return id;
};

DockerDriver.prototype.updateInstanceEnv = function(id, env, cb) {
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
  var current = this._instance(id).current;
  if (current && current.ctl) {
    debug('requesting of %j: %j', id, req);
    return current.ctl.request(req, cb);
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
  setImmediate(cb);
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
  // debug('DockerDriver._containerById(%j)', id);
  this.instances[id] = this.instances[id] || {
    startOpts: _.clone(this.defaultStartOptions),
  };
  return this.instances[id];
};


DockerDriver.prototype.getName = function() {
  return 'Docker';
};

DockerDriver.prototype.getStatus = function() {
  return 'running';
};
