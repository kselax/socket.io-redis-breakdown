
/**
 * Module dependencies.
 */
// strong uid
var uid2 = require('uid2');
var redis = require('redis').createClient; // redis module
// A fast Node.js implementation of the latest MessagePack spec.
var msgpack = require('notepack.io');
var Adapter = require('socket.io-adapter'); // the node.js adapter
var debug = require('debug')('socket.io-redis'); // the debag module

/**
 * Module exports.
 */
// export the constructor
module.exports = adapter;

/**
 * Request types, for messages between nodes
 */

var requestTypes = {
  clients: 0,
  clientRooms: 1,
  allRooms: 2,
  remoteJoin: 3,
  remoteLeave: 4,
  customRequest: 5,
  remoteDisconnect: 6
};

/**
 * Returns a redis Adapter class.
 *
 * @param {String} optional, redis uri
 * @return {RedisAdapter} adapter
 * @api public
 */

function adapter(uri, opts) {
  opts = opts || {};
  // console.log('uri = ', uri); // uri =  { host: 'localhost', port: 6379 }
  // console.log('opts = ', opts); // opts =  {}
  // handle options only
  if ('object' == typeof uri) { // if uri is an object type, there only options
    opts = uri;
    uri = null;
  }

  // opts
  var pub = opts.pubClient;
  // console.log('pub = ', pub); // undefined
  // console.log('here we are');
  var sub = opts.subClient;
  // console.log('sub = ', sub); // undefined
  var prefix = opts.key || 'socket.io';
  // console.log('prefix = ', prefix); // socket.io
  var requestsTimeout = opts.requestsTimeout || 5000;
  // console.log('requestsTimeout = ', requestsTimeout); // 5000
  // init clients if needed
  function createClient() {
    if (uri) {
      // handle uri string
      return redis(uri, opts);
    } else {
      return redis(opts);
    }
  }
  // create the pub and sub clients
  if (!pub) pub = createClient();
  if (!sub) sub = createClient();
  // console.log('pub = ', pub, ' sub= ', sub); // will be return an object

  // this server's key
  var uid = uid2(6);
  // console.log('uid = ', uid); // uid =  2wBHUZ

  /**
   * Adapter constructor.
   *
   * @param {String} namespace name
   * @api public
   */
  // nsp is namespace
  function Redis(nsp){
    // console.log('nsp = ', nsp);
    // this thing probabely make a closure
    // this is call the function Adapter with this as argument and nsp
    Adapter.call(this, nsp); // this is call the Redis function
    console.log('here we go');

    this.uid = uid;
    this.prefix = prefix;
    this.requestsTimeout = requestsTimeout;
    console.log('this = ', this);

    this.channel = prefix + '#' + nsp.name + '#';
    this.requestChannel = prefix + '-request#' + this.nsp.name + '#';
    this.responseChannel = prefix + '-response#' + this.nsp.name + '#';
    this.requests = {};
    this.customHook = function(data, cb){ cb(null); }

    if (String.prototype.startsWith) {
      this.channelMatches = function (messageChannel, subscribedChannel) {
        // The startsWith() method determines whether a string begins with the characters of a specified string, returning true or false as appropriate.
        return messageChannel.startsWith(subscribedChannel);
      }
    } else { // Fallback to other impl for older Node.js
      this.channelMatches = function (messageChannel, subscribedChannel) {
        return messageChannel.substr(0, subscribedChannel.length) === subscribedChannel;
      }
    }
    this.pubClient = pub;
    this.subClient = sub;

    var self = this;

    sub.psubscribe(this.channel + '*', function(err){
      if (err) self.emit('error', err);
    });
    // bind onmessage
    sub.on('pmessageBuffer', this.onmessage.bind(this));

    sub.subscribe([this.requestChannel, this.responseChannel], function(err){
      if (err) self.emit('error', err);
    });
    // bind onrequest
    sub.on('messageBuffer', this.onrequest.bind(this));

    function onError(err) {
      self.emit('error', err);
    }
    pub.on('error', onError);
    sub.on('error', onError);
  } // function Redis(nsp){

  /**
   * Inherits from `Adapter`.
   */
  // Adapter.prototype gets methods from socket.io-adapter
  // The __proto__ property of Object.prototype is an accessor property (a getter function and a setter function) that exposes the internal [[Prototype]] (either an object or null) of the object through which it is accessed.
  Redis.prototype.__proto__ = Adapter.prototype;

  /**
   * Called with a subscription message
   *
   * @api private
   */

  Redis.prototype.onmessage = function(pattern, channel, msg){
    channel = channel.toString();

    if (!this.channelMatches(channel, this.channel)) {
      return debug('ignore different channel');
    }

    var room = channel.slice(this.channel.length, -1);
    if (room !== '' && !this.rooms.hasOwnProperty(room)) {
      return debug('ignore unknown room %s', room);
    }

    var args = msgpack.decode(msg);
    var packet;

    if (uid === args.shift()) return debug('ignore same uid');

    packet = args[0];

    if (packet && packet.nsp === undefined) {
      packet.nsp = '/';
    }

    if (!packet || packet.nsp != this.nsp.name) {
      return debug('ignore different namespace');
    }

    args.push(true);

    this.broadcast.apply(this, args);
  };

  /**
   * Called on request from another node
   *
   * @api private
   */

  Redis.prototype.onrequest = function(channel, msg){
    channel = channel.toString();

    if (this.channelMatches(channel, this.responseChannel)) {
      return this.onresponse(channel, msg);
    } else if (!this.channelMatches(channel, this.requestChannel)) {
      return debug('ignore different channel');
    }

    var self = this;
    var request;

    try {
      request = JSON.parse(msg);
    } catch(err){
      self.emit('error', err);
      return;
    }

    debug('received request %j', request);

    switch (request.type) {

      case requestTypes.clients:
        Adapter.prototype.clients.call(self, request.rooms, function(err, clients){
          if(err){
            self.emit('error', err);
            return;
          }

          var response = JSON.stringify({
            requestid: request.requestid,
            clients: clients
          });

          pub.publish(self.responseChannel, response);
        });
        break;

      case requestTypes.clientRooms:
        Adapter.prototype.clientRooms.call(self, request.sid, function(err, rooms){
          if(err){
            self.emit('error', err);
            return;
          }

          if (!rooms) { return; }

          var response = JSON.stringify({
            requestid: request.requestid,
            rooms: rooms
          });

          pub.publish(self.responseChannel, response);
        });
        break;

      case requestTypes.allRooms:

        var response = JSON.stringify({
          requestid: request.requestid,
          rooms: Object.keys(this.rooms)
        });

        pub.publish(self.responseChannel, response);
        break;

      case requestTypes.remoteJoin:

        var socket = this.nsp.connected[request.sid];
        if (!socket) { return; }

        socket.join(request.room, function(){
          var response = JSON.stringify({
            requestid: request.requestid
          });

          pub.publish(self.responseChannel, response);
        });
        break;

      case requestTypes.remoteLeave:

        var socket = this.nsp.connected[request.sid];
        if (!socket) { return; }

        socket.leave(request.room, function(){
          var response = JSON.stringify({
            requestid: request.requestid
          });

          pub.publish(self.responseChannel, response);
        });
        break;

      case requestTypes.remoteDisconnect:

        var socket = this.nsp.connected[request.sid];
        if (!socket) { return; }

        socket.disconnect(request.close);

        var response = JSON.stringify({
          requestid: request.requestid
        });

        pub.publish(self.responseChannel, response);
        break;

      case requestTypes.customRequest:
        this.customHook(request.data, function(data) {

          var response = JSON.stringify({
            requestid: request.requestid,
            data: data
          });

          pub.publish(self.responseChannel, response);
        });

        break;

      default:
        debug('ignoring unknown request type: %s', request.type);
    }
  };

  /**
   * Called on response from another node
   *
   * @api private
   */

  Redis.prototype.onresponse = function(channel, msg){
    var self = this;
    var response;

    try {
      response = JSON.parse(msg);
    } catch(err){
      self.emit('error', err);
      return;
    }

    var requestid = response.requestid;

    if (!requestid || !self.requests[requestid]) {
      debug('ignoring unknown request');
      return;
    }

    debug('received response %j', response);

    var request = self.requests[requestid];

    switch (request.type) {

      case requestTypes.clients:
        request.msgCount++;

        // ignore if response does not contain 'clients' key
        if(!response.clients || !Array.isArray(response.clients)) return;

        for(var i = 0; i < response.clients.length; i++){
          request.clients[response.clients[i]] = true;
        }

        if (request.msgCount === request.numsub) {
          clearTimeout(request.timeout);
          if (request.callback) process.nextTick(request.callback.bind(null, null, Object.keys(request.clients)));
          delete self.requests[requestid];
        }
        break;

      case requestTypes.clientRooms:
        clearTimeout(request.timeout);
        if (request.callback) process.nextTick(request.callback.bind(null, null, response.rooms));
        delete self.requests[requestid];
        break;

      case requestTypes.allRooms:
        request.msgCount++;

        // ignore if response does not contain 'rooms' key
        if(!response.rooms || !Array.isArray(response.rooms)) return;

        for(var i = 0; i < response.rooms.length; i++){
          request.rooms[response.rooms[i]] = true;
        }

        if (request.msgCount === request.numsub) {
          clearTimeout(request.timeout);
          if (request.callback) process.nextTick(request.callback.bind(null, null, Object.keys(request.rooms)));
          delete self.requests[requestid];
        }
        break;

      case requestTypes.remoteJoin:
      case requestTypes.remoteLeave:
      case requestTypes.remoteDisconnect:
        clearTimeout(request.timeout);
        if (request.callback) process.nextTick(request.callback.bind(null, null));
        delete self.requests[requestid];
        break;

      case requestTypes.customRequest:
        request.msgCount++;

        request.replies.push(response.data);

        if (request.msgCount === request.numsub) {
          clearTimeout(request.timeout);
          if (request.callback) process.nextTick(request.callback.bind(null, null, request.replies));
          delete self.requests[requestid];
        }
        break;

      default:
        debug('ignoring unknown request type: %s', request.type);
    }
  };

  /**
   * Broadcasts a packet.
   *
   * @param {Object} packet to emit
   * @param {Object} options
   * @param {Boolean} whether the packet came from another node
   * @api public
   */

  Redis.prototype.broadcast = function(packet, opts, remote){
    packet.nsp = this.nsp.name;
    if (!(remote || (opts && opts.flags && opts.flags.local))) {
      var msg = msgpack.encode([uid, packet, opts]);
      var channel = this.channel;
      if (opts.rooms && opts.rooms.length === 1) {
        channel += opts.rooms[0] + '#';
      }
      debug('publishing message to channel %s', channel);
      pub.publish(channel, msg);
    }
    Adapter.prototype.broadcast.call(this, packet, opts);
  };

  /**
   * Gets a list of clients by sid.
   *
   * @param {Array} explicit set of rooms to check.
   * @param {Function} callback
   * @api public
   */

  Redis.prototype.clients = function(rooms, fn){
    if ('function' == typeof rooms){
      fn = rooms;
      rooms = null;
    }

    rooms = rooms || [];

    var self = this;
    var requestid = uid2(6);

    pub.send_command('pubsub', ['numsub', self.requestChannel], function(err, numsub){
      if (err) {
        self.emit('error', err);
        if (fn) fn(err);
        return;
      }

      numsub = parseInt(numsub[1], 10);
      debug('waiting for %d responses to "clients" request', numsub);

      var request = JSON.stringify({
        requestid : requestid,
        type: requestTypes.clients,
        rooms : rooms
      });

      // if there is no response for x second, return result
      var timeout = setTimeout(function() {
        var request = self.requests[requestid];
        if (fn) process.nextTick(fn.bind(null, new Error('timeout reached while waiting for clients response'), Object.keys(request.clients)));
        delete self.requests[requestid];
      }, self.requestsTimeout);

      self.requests[requestid] = {
        type: requestTypes.clients,
        numsub: numsub,
        msgCount: 0,
        clients: {},
        callback: fn,
        timeout: timeout
      };

      pub.publish(self.requestChannel, request);
    });
  };

  /**
   * Gets the list of rooms a given client has joined.
   *
   * @param {String} client id
   * @param {Function} callback
   * @api public
   */

  Redis.prototype.clientRooms = function(id, fn){

    var self = this;
    var requestid = uid2(6);

    var rooms = this.sids[id];

    if (rooms) {
      if (fn) process.nextTick(fn.bind(null, null, Object.keys(rooms)));
      return;
    }

    var request = JSON.stringify({
      requestid : requestid,
      type: requestTypes.clientRooms,
      sid : id
    });

    // if there is no response for x second, return result
    var timeout = setTimeout(function() {
      if (fn) process.nextTick(fn.bind(null, new Error('timeout reached while waiting for rooms response')));
      delete self.requests[requestid];
    }, self.requestsTimeout);

    self.requests[requestid] = {
      type: requestTypes.clientRooms,
      callback: fn,
      timeout: timeout
    };

    pub.publish(self.requestChannel, request);
  };

  /**
   * Gets the list of all rooms (accross every node)
   *
   * @param {Function} callback
   * @api public
   */

  Redis.prototype.allRooms = function(fn){

    var self = this;
    var requestid = uid2(6);

    pub.send_command('pubsub', ['numsub', self.requestChannel], function(err, numsub){
      if (err) {
        self.emit('error', err);
        if (fn) fn(err);
        return;
      }

      numsub = parseInt(numsub[1], 10);
      debug('waiting for %d responses to "allRooms" request', numsub);

      var request = JSON.stringify({
        requestid : requestid,
        type: requestTypes.allRooms
      });

      // if there is no response for x second, return result
      var timeout = setTimeout(function() {
        var request = self.requests[requestid];
        if (fn) process.nextTick(fn.bind(null, new Error('timeout reached while waiting for allRooms response'), Object.keys(request.rooms)));
        delete self.requests[requestid];
      }, self.requestsTimeout);

      self.requests[requestid] = {
        type: requestTypes.allRooms,
        numsub: numsub,
        msgCount: 0,
        rooms: {},
        callback: fn,
        timeout: timeout
      };

      pub.publish(self.requestChannel, request);
    });
  };

  /**
   * Makes the socket with the given id join the room
   *
   * @param {String} socket id
   * @param {String} room name
   * @param {Function} callback
   * @api public
   */

  Redis.prototype.remoteJoin = function(id, room, fn){

    var self = this;
    var requestid = uid2(6);

    var socket = this.nsp.connected[id];
    if (socket) {
      socket.join(room, fn);
      return;
    }

    var request = JSON.stringify({
      requestid : requestid,
      type: requestTypes.remoteJoin,
      sid: id,
      room: room
    });

    // if there is no response for x second, return result
    var timeout = setTimeout(function() {
      if (fn) process.nextTick(fn.bind(null, new Error('timeout reached while waiting for remoteJoin response')));
      delete self.requests[requestid];
    }, self.requestsTimeout);

    self.requests[requestid] = {
      type: requestTypes.remoteJoin,
      callback: fn,
      timeout: timeout
    };

    pub.publish(self.requestChannel, request);
  };

  /**
   * Makes the socket with the given id leave the room
   *
   * @param {String} socket id
   * @param {String} room name
   * @param {Function} callback
   * @api public
   */

  Redis.prototype.remoteLeave = function(id, room, fn){

    var self = this;
    var requestid = uid2(6);

    var socket = this.nsp.connected[id];
    if (socket) {
      socket.leave(room, fn);
      return;
    }

    var request = JSON.stringify({
      requestid : requestid,
      type: requestTypes.remoteLeave,
      sid: id,
      room: room
    });

    // if there is no response for x second, return result
    var timeout = setTimeout(function() {
      if (fn) process.nextTick(fn.bind(null, new Error('timeout reached while waiting for remoteLeave response')));
      delete self.requests[requestid];
    }, self.requestsTimeout);

    self.requests[requestid] = {
      type: requestTypes.remoteLeave,
      callback: fn,
      timeout: timeout
    };

    pub.publish(self.requestChannel, request);
  };

  /**
   * Makes the socket with the given id to be disconnected forcefully
   * @param {String} socket id
   * @param {Boolean} close if `true`, closes the underlying connection
   * @param {Function} callback
   */

  Redis.prototype.remoteDisconnect = function(id, close, fn) {
    var self = this;
    var requestid = uid2(6);

    var socket = this.nsp.connected[id];
    if(socket) {
      socket.disconnect(close);
      if (fn) process.nextTick(fn.bind(null, null));
      return;
    }

    var request = JSON.stringify({
      requestid : requestid,
      type: requestTypes.remoteDisconnect,
      sid: id,
      close: close
    });

    // if there is no response for x second, return result
    var timeout = setTimeout(function() {
      if (fn) process.nextTick(fn.bind(null, new Error('timeout reached while waiting for remoteDisconnect response')));
      delete self.requests[requestid];
    }, self.requestsTimeout);

    self.requests[requestid] = {
      type: requestTypes.remoteDisconnect,
      callback: fn,
      timeout: timeout
    };

    pub.publish(self.requestChannel, request);
  };

  /**
   * Sends a new custom request to other nodes
   *
   * @param {Object} data (no binary)
   * @param {Function} callback
   * @api public
   */

  Redis.prototype.customRequest = function(data, fn){
    if (typeof data === 'function'){
      fn = data;
      data = null;
    }

    var self = this;
    var requestid = uid2(6);

    pub.send_command('pubsub', ['numsub', self.requestChannel], function(err, numsub){
      if (err) {
        self.emit('error', err);
        if (fn) fn(err);
        return;
      }

      numsub = parseInt(numsub[1], 10);
      debug('waiting for %d responses to "customRequest" request', numsub);

      var request = JSON.stringify({
        requestid : requestid,
        type: requestTypes.customRequest,
        data: data
      });

      // if there is no response for x second, return result
      var timeout = setTimeout(function() {
        var request = self.requests[requestid];
        if (fn) process.nextTick(fn.bind(null, new Error('timeout reached while waiting for customRequest response'), request.replies));
        delete self.requests[requestid];
      }, self.requestsTimeout);

      self.requests[requestid] = {
        type: requestTypes.customRequest,
        numsub: numsub,
        msgCount: 0,
        replies: [],
        callback: fn,
        timeout: timeout
      };

      pub.publish(self.requestChannel, request);
    });
  };

  // put to the Redis constructor properties: uid, pubClient, subClient, prefix, requestsTimeout
  // Redis.uid = uid;
  // Redis.pubClient = pub;
  // Redis.subClient = sub;
  // Redis.prefix = prefix;
  // Redis.requestsTimeout = requestsTimeout;

  console.log('Redis = ', Redis.subClient);
  return Redis; // this is return  the constructor function Redis from the top

} // function adapter(uri, opts) {
