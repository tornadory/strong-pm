'use strict';

var _ = require('lodash');
var debug = require('debug')('strong-pm:docker:container');
var EventEmitter = require('events').EventEmitter;
var inherits = require('util').inherits;
var sCtl = require('strong-control-channel/client');

module.exports = exports = Container;

function Container(image, logger, startOpts) {
  var self = this;
  EventEmitter.call(this);
  this.driver = image.driver;
  this.docker = image.docker;
  this.shouldRestart = true;
  this.pid = process.pid;
  this.connected = false;
  this.image = image;
  this.commit = image.commit;
  this.restartCount = 0;
  this.child = {pid: 1};
  this.logger = logger;
  this.startOpts = startOpts;
  this.env = startOpts.env;
  this.createOpts = {
    Image: image.name,
    Env: this.dockerEnv(),
    Cmd: this.startArgs(),
    PublishAllPorts: true,
  };
  this.on('created', function() {
    self.attachMonitor();
  });
  this.on('starting', function() {
    self.updatePortMapping();
  });
  this.on('ports', function() {
    self.connectControlChannel();
  });
  this.on('connected', function() {
    self._onConnected();
  });
  this.docker.createContainer(this.createOpts, function(err, c) {
    debug('creatd container:', c);
    self.c = c;
    // similar to git, we don't need the whole id to have a useable identifier
    self.cid = c.id.slice(0, 12);
    if (err) {
      self.emit('error', err);
    } else {
      self.emit('created');
    }
  });
}

inherits(Container, EventEmitter);

Container.prototype.destroy = function() {
  debug('Destroying docker/container instance', this.cid);
  this.removeAllListeners();
  this.driver =
    this.docker =
    this.logger =
    this.c = null;
};

Container.prototype.start = function() {
  debug('Docker::Container.start()');
  var self = this;
  this.c.start(function(err) {
    if (err) {
      self.emit('error', err);
    } else {
      self.emit('starting');
    }
  });
};

Container.prototype.startSize = function() {
  if (/cpu/i.test(String(this.startOpts.size))) {
    return this.driver.CPUS;
  } else {
    return this.startOps.size;
  }
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

Container.prototype.kill = function(signal, cb) {
  debug('Container<%s>.kill(%s)', this.cid, signal);
  if (cb == null && typeof signal === 'function') {
    cb = signal;
    signal = undefined;
  }
  var self = this;
  this.shouldRestart = false;
  this.c.kill({signal: signal}, function(err, data) {
    if (err) {
      self.emit('error', err);
    }
    if (cb) {
      cb(err, data);
    }
  });
};

Container.prototype.dockerEnv = function() {
  var env = this.env || {};
  return _(env).pairs().map(function(p) {
    return p.join('=');
  }).value();
};

Container.prototype.startArgs = function() {
  var args = ['--cluster=0'];
  if (this.startOpts.trace) {
    args.push('--trace');
  }
  if (!this.startOpts.profile) {
    args.push('--no-profile');
  }
  return args;
};

Container.prototype.attachMonitor = function() {
  debug('Docker::Container.attachMonitor()');
  var attachOpts = {stream: true, stdout: true, stderr: true};
  var self = this;
  this.c.attach(attachOpts, function(err, stream) {
    if (err) {
      debug('error attaching to container %j:', self.cid, err);
      return inspect(err);
    }
    self.docker.modem.demuxStream(stream, self.logger, self.logger);
    stream.on('close', inspect);
    stream.on('error', inspect);
    self.emit('ready');
  });

  function inspect(err) {
    debug('monitor stopped, inspecting %j:', self.cid, err);
    self.c.inspect(function(err, details) {
      if (err) {
        debug('error inspecting monitored container %j:', self.cid, err);
        return self.handleError(err);
      }
      debug('inspect container %j:', self.cid, details);
      if (!details.State.Running) {
        self.emit('exit', details.State.ExitCode);
        if (self.shouldRestart) {
          self.start();
        }
      }
      self.attachMonitor();
    });
  }
};

Container.prototype.updatePortMapping = function() {
  debug('Docker::Container.updatePortMapping()');
  var self = this;
  this.c.inspect(function(err, details) {
    if (err) {
      debug('error inspecting started %j:', self.cid, err);
      return self.handleError(err);
    }
    debug('container details:', details);
    var ports = translatePorts(self.docker, details);
    self.ports = {
      ctl: ports['8700/tcp'],
      app: ports['3000/tcp'],
    };
    self.emit('ports', self.ports);
  });
};

Container.prototype._onConnected = function() {
  debug('Docker::Container._onConnected()');
  var self = this;
  this.ctl.request({cmd: 'status'}, function(status) {
    debug('supervisor status:', status);
    status.master.setSize = self.startSize();
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
    // XXX(rmg): using 0 as initial size and then doing an immediate set-size is
    // a hack to reduce the number of notifications we missed out on before we
    // connected.
    // TODO(rmg): replace this hack with support for WS based control channel
    debug('sending set-size to supervisor');
    self.ctl.request({cmd: 'set-size', size: started.setSize}, function(rsp) {
      debug('set-size sent', rsp);
    });
  });
};

Container.prototype.request = function(req, cb) {
  debug('Docker::Container<%s>.request(%j)', this.cid, req);
  if (this.connected) {
    debug('request forwarded to supervisor');
    this.ctl.request(req, cb);
  } else {
    debug('not connected, request to supervisor deferred');
    this.on('connected', this.request.bind(this, req, cb));
  }
};

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
