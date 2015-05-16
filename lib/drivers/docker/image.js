'use strict';

var cicada = require('strong-fork-cicada');
var Container = require('./container');
var debug = require('debug')('strong-pm:docker:image');
var EventEmitter = require('events').EventEmitter;
var fmt = require('util').format;
var inherits = require('util').inherits;
var localDeploy = require('../common/local-deploy');
var packReceiver = require('../common/pack-receiver');
var path = require('path');
var sdb = require('strong-docker-build');

module.exports = exports = Image;

function Image(driver, id, baseDir) {
  EventEmitter.call(this);
  this.driver = driver;
  this.docker = driver.docker;
  this.instanceId = id;
  this.baseDir = baseDir;

  // XXX(sam) might be able to use a single cicada, made in the driver, and
  // using the repo set to the svcId, but this works fine.
  this._svcDir = path.resolve(this.baseDir, 'svc', String(this.instanceId));
  this.git = cicada(this._svcDir);
  // this.git.container = this;

  // emits 'commit' on this.git after unpack
  this.tar = packReceiver(this.git);
  // this.tar.on('error', this.emit.bind(this, 'error'));

  // emits 'prepared' on this when received
  this.local = localDeploy(this);
  // this.local.on('error', this.emit.bind(this, 'error'));

  this.git.on('commit', this._onCommit.bind(this));
  this.on('commit', this._onCommit.bind(this));
  this.git.on('error', this.emit.bind(this, 'error'));

  // Happens after a new-deploy is prepared, and also when a previously prepared
  // service is found at startup.
  // this.on('prepared', this._onCommit);
}

inherits(Image, EventEmitter);

Image.from = function(driver, id, baseDir, req, res) {
  var image = new Image(driver, id, baseDir);
  image.receive(req, res);
  return image;
};

Image.prototype.receive = function(req, res) {
  debug('Docker::Image.receive()');
  var contentType = req.headers['content-type'];

  debug('deploy request: locked? %s method %j content-type %j',
        !!process.env.STRONG_PM_LOCKED, req.method, contentType);

  if (process.env.STRONG_PM_LOCKED) {
    debug('deploy rejected: locked');
    return rejectDeployments(req, res);
  }

  if (req.method === 'PUT') {
    debug('deploy accepted: npm package');
    return this.tar.handle(req, res);
  }

  if (contentType === 'application/x-pm-deploy') {
    debug('deploy accepted: local deploy');
    return this.local.handle(req, res);
  }
  debug('deploy accepted: git deploy');

  return this.git.handle(req, res);
};

function rejectDeployments(req, res) {
  res.status(403)
     .set('Content-Type', 'text/plain')
     .end('Forbidden: Server is not accepting deployments');
}

Image.prototype._onCommit = function(commit) {
  this.name = fmt('%s/svc:%s', 'strong-pm', commit.hash);
  var self = this;
  debug('Image committed', commit);
  this.commit = commit;
  var imgOpts = {
    appRoot: this.commit.dir,
    imgName: this.name,
  };
  this.docker.getImage(imgOpts.imgName).inspect(function(err, details) {
    if (!err && details) {
      return self.emit('image', {id: details.Id, name: imgOpts.imgName});
    }
    sdb.buildDeployImage(imgOpts, function(err, img) {
      self.image = img;
      if (err) {
        self.emit('error', err);
      } else {
        self.emit('image');
      }
    });
  });
};

Image.prototype._onPrepared = function(commit) {
  debug('Image prepared', commit);
};

Image.prototype.start = function(instanceId, logger, startOpts) {
  var container = new Container(this, instanceId, logger, startOpts);
  container.once('ready', function() {
    container.start();
  });
  return container;
};
