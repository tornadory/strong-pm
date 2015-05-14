'use strict';

var _ = require('lodash');
var debug = require('debug')('strong-pm:docker:container');
var Docker = require('dockerode');
var EventEmitter = require('events').EventEmitter;
var fmt = require('util').format;
var inherits = require('util').inherits;
var sCtl = require('strong-control-channel/client');

module.exports = exports = Container;

function Container(image, logger, startOpts) {
  var self = this;
  EventEmitter.call(this);
  this.pid = process.pid;
  this.connected = false;
  this.docker = new Docker();
  this.image = image;
  this.commit = image.commit;
  this.restartCount = 0;
  this.child = {pid: 1};
  this.logger = logger;
  this.startOpts = startOpts;
  this.createOpts = {
    Image: image.name,
    Env: this.env(),
    Cmd: this.args(),
  };
  this.on('starting', function() {
    self.attachLogger();
    self.updateDetails();
  });
  this.on('available', function() {
    self.connectControlChannel();
  });
  this.on('connected', function() {
    self._onConnected();
  });
  this.docker.createContainer(this.createOpts, function(err, c) {
    self.c = c;
    self.id = c.Id;
    if (err) {
      self.emit('error', err);
    } else {
      self.emit('runnable');
    }
  });
}

inherits(Container, EventEmitter);

Container.prototype.start = function() {
  debug('Docker::Container.start()');
  var self = this;
  var startOpts = {
    // according to the Docker API docs, this is a create option, and start
    // doesn't even take options, but this seems to be the only way it works.
    PublishAllPorts: true,
  };
  this.c.start(startOpts, function(err) {
    if (err) {
      self.emit('error', err);
    } else {
      self.emit('starting');
    }
  });
};

Container.prototype.connectControlChannel = function() {
  debug('Docker::Container.connectControlChannel()');
  var self = this;
  this.ctl = new sCtl.Client(this.ports.ctl, onResponse, onNotify, onError);
  this.ctl._socket.once('connect', function() {
    self.connected = true;
    self.emit('connected');
  });
  this.ctl._socket.on('error', function(err) {
    debug('socket error on control channel:', err);
    self.connected = false;
  });

  function onResponse(req) {
    debug('onResponse: ', arguments);
    setImmediate(self.emit.bind(self, 'request', req));
  }
  function onNotify(req) {
    debug('onNotification: ', arguments);
    setImmediate(self.emit.bind(self, 'request', req));
  }
  function onError(err) {
    debug('onError: ', err, err.stacktrace);
    if (err.code === 'ECONNREFUSED') {
      self.connected = false;
      debug('Retrying connection');
      setTimeout(self.connectControlChannel.bind(self), 50);
    }
  }
};

Container.prototype.kill = function() {
  debug('Docker::Container.kill()');
  var self = this;
  this.c.remove({v: true, f: true}, function() {
    self.emit('exit', 1);
  });
};

Container.prototype.env = function() {
  var env = this.startOpts.env || {};
  return _(env).pairs().map(function(k, v) {
    return fmt('%s=%s', k, v);
  });
};

Container.prototype.args = function() {
  var args = ['--cluster=0'];
  if (this.startOpts.trace) {
    args.push('--trace');
  }
  if (!this.startOpts.profile) {
    args.push('--no-profile');
  }
  return args;
};

Container.prototype.attachLogger = function() {
  debug('Docker::Container.attachLogger()');
  var attachOpts = {stream: true, stdout: true, stderr: true};
  var self = this;
  this.c.attach(attachOpts, function(err, stream) {
    if (err) {
      debug('error attaching to container %j:', self.id, err);
      return self.handleError(err);
    }
    self.docker.modem.demuxStream(stream, self.logger, self.logger);
    stream.on('close', reconnect);
    stream.on('error', reconnect);
  });

  function reconnect(err) {
    // TODO(rmg): detect where disconnection was intentional
    debug('container stream stopped, reconnecting %j:', self.id, err);
    self.c.inspect(function(err, details) {
      if (err) {
        debug('error inspecting container %j:', self.c, err);
        return self.handleError(err);
      }
      debug('inspect container %j:', self.c.Id, details);
      if (details.State.Running) {
        self.attachLogger();
      } else {
        self.emit('exit', details.State.ExitCode);
        self.start();
      }
    });
  }
};

Container.prototype.updateDetails = function() {
  debug('Docker::Container.updateDetails()');
  var self = this;
  this.c.inspect(function(err, details) {
    if (err) {
      debug('error inspecting container %j:', self.c, err);
      return self.handleError(err);
    }
    var ports = translatePorts(self.docker, details);
    self.ports = {
      ctl: ports['8700/tcp'],
      app: ports['3000/tcp'],
    };
    self.emit('available', self.ports);
  });
};

Container.prototype._onConnected = function() {
  debug('Docker::Container._onConnected()');
  var self = this;
  this.ctl.request({cmd: 'status'}, function(status) {
    debug('supervisor status:', status);
    status.master.setSize = 4;
    var started = {
      cmd: 'started',
      pid: status.master.pid,
      pst: status.master.pst || status.master.startTime,
      startTime: status.master.pst || status.master.startTime,
      appName: status.appName,
      agentVersion: status.agentVersion,
      master: status.master,
      setSize: status.master.setSize,
    };
    self.appName = status.appName;
    self.agentVersion = status.agentVersion;
    self.child = status.master;
    // turn status response into a pseudo-notification
    status.cmd = status.cmd || 'status';
    self.emit('request', started);
    // self.emit('request', status);
    // XXX(rmg): soft-restart is a hack to get the cluster to report fork
    // events for all the workers since we likely missed some before the
    // control client was connected
    debug('sending soft-restart to supervisor');
    self.ctl.request({cmd: 'set-size', size: 4}, function(rsp) {
      debug('set-size sent', rsp);
    });
  });
};

Container.prototype.request = function(req, cb) {
  debug('Docker::Container.request(%j)', req);
  if (this.connected) {
    debug('request forwarded to supervisor');
    this.ctl.request(req, debounce(cb));
  } else {
    debug('not connected, request to supervisor deferred');
    this.on('connected', this.request.bind(this, req, cb));
  }
};

function debounce(fn) {
  return debounced;
  function debounced() {
    var args = arguments;
    var self = this;
    setImmediate(function() {
      fn.apply(self, args);
    });
  }
}

Container.prototype.handleError = function(err) {
  if (err.statusCode === 404) {
    // container was removed
    this.emit('exit', err);
  } else {
    this.emit('error', err);
  }
};

function translatePorts(docker, container) {
  var ports = JSON.parse(JSON.stringify(container.NetworkSettings.Ports));

  for (var p in ports) {
    ports[p] = translateMapping(ports[p]);
    ports[p].host = usableIp(docker.modem, ports[p].host);
  }

  return ports;

  function translateMapping(dockerFormat) {
    return {host: dockerFormat[0].HostIp, port: dockerFormat[0].HostPort};
  }

  function usableIp(modem, original) {
    return (modem.port && modem.host) || original;
  }
}
