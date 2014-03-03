(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var check = Package.check.check;
var Match = Package.check.Match;
var Random = Package.random.Random;
var EJSON = Package.ejson.EJSON;
var _ = Package.underscore._;
var Deps = Package.deps.Deps;
var Log = Package.logging.Log;
var Retry = Package.retry.Retry;
var LocalCollection = Package.minimongo.LocalCollection;
var Minimongo = Package.minimongo.Minimongo;

/* Package-scope variables */
var DDP, DDPServer, LivedataTest, toSockjsUrl, toWebsocketUrl, StreamServer, Server, SUPPORTED_DDP_VERSIONS, MethodInvocation, parseDDP, stringifyDDP, allConnections;

(function () {

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/livedata/common.js                                                                                         //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
LivedataTest = {};                                                                                                     // 1
                                                                                                                       // 2
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/livedata/stream_client_nodejs.js                                                                           //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
// @param endpoint {String} URL to Meteor app                                                                          // 1
//   "http://subdomain.meteor.com/" or "/" or                                                                          // 2
//   "ddp+sockjs://foo-**.meteor.com/sockjs"                                                                           // 3
//                                                                                                                     // 4
// We do some rewriting of the URL to eventually make it "ws://" or "wss://",                                          // 5
// whatever was passed in.  At the very least, what Meteor.absoluteUrl() returns                                       // 6
// us should work.                                                                                                     // 7
//                                                                                                                     // 8
// We don't do any heartbeating. (The logic that did this in sockjs was removed,                                       // 9
// because it used a built-in sockjs mechanism. We could do it with WebSocket                                          // 10
// ping frames or with DDP-level messages.)                                                                            // 11
LivedataTest.ClientStream = function (endpoint, options) {                                                             // 12
  var self = this;                                                                                                     // 13
  self.options = _.extend({                                                                                            // 14
    retry: true                                                                                                        // 15
  }, options);                                                                                                         // 16
                                                                                                                       // 17
  // WebSocket-Node https://github.com/Worlize/WebSocket-Node                                                          // 18
  // Chosen because it can run without native components. It has a                                                     // 19
  // somewhat idiosyncratic API. We may want to use 'ws' instead in the                                                // 20
  // future.                                                                                                           // 21
  //                                                                                                                   // 22
  // Since server-to-server DDP is still an experimental feature, we only                                              // 23
  // require the module if we actually create a server-to-server                                                       // 24
  // connection. This is a minor efficiency improvement, but moreover: while                                           // 25
  // 'websocket' doesn't require native components, it tries to use some                                               // 26
  // optional native components and prints a warning if it can't load                                                  // 27
  // them. Since native components in packages don't work when transferred to                                          // 28
  // other architectures yet, this means that require('websocket') prints a                                            // 29
  // spammy log message when deployed to another architecture. Delaying the                                            // 30
  // require means you only get the log message if you're actually using the                                           // 31
  // feature.                                                                                                          // 32
  self.client = new (Npm.require('websocket').client)();                                                               // 33
  self.endpoint = endpoint;                                                                                            // 34
  self.currentConnection = null;                                                                                       // 35
                                                                                                                       // 36
  options = options || {};                                                                                             // 37
  self.headers = options.headers || {};                                                                                // 38
                                                                                                                       // 39
  self.client.on('connect', Meteor.bindEnvironment(                                                                    // 40
    function (connection) {                                                                                            // 41
      return self._onConnect(connection);                                                                              // 42
    },                                                                                                                 // 43
    "stream connect callback"                                                                                          // 44
  ));                                                                                                                  // 45
                                                                                                                       // 46
  self.client.on('connectFailed', function (error) {                                                                   // 47
    // XXX: Make this do something better than make the tests hang if it does not work.                                // 48
    return self._lostConnection();                                                                                     // 49
  });                                                                                                                  // 50
                                                                                                                       // 51
  self._initCommon();                                                                                                  // 52
                                                                                                                       // 53
  //// Kickoff!                                                                                                        // 54
  self._launchConnection();                                                                                            // 55
};                                                                                                                     // 56
                                                                                                                       // 57
_.extend(LivedataTest.ClientStream.prototype, {                                                                        // 58
                                                                                                                       // 59
  // data is a utf8 string. Data sent while not connected is dropped on                                                // 60
  // the floor, and it is up the user of this API to retransmit lost                                                   // 61
  // messages on 'reset'                                                                                               // 62
  send: function (data) {                                                                                              // 63
    var self = this;                                                                                                   // 64
    if (self.currentStatus.connected) {                                                                                // 65
      self.currentConnection.send(data);                                                                               // 66
    }                                                                                                                  // 67
  },                                                                                                                   // 68
                                                                                                                       // 69
  // Changes where this connection points                                                                              // 70
  _changeUrl: function (url) {                                                                                         // 71
    var self = this;                                                                                                   // 72
    self.endpoint = url;                                                                                               // 73
  },                                                                                                                   // 74
                                                                                                                       // 75
  _onConnect: function (connection) {                                                                                  // 76
    var self = this;                                                                                                   // 77
                                                                                                                       // 78
    if (self._forcedToDisconnect) {                                                                                    // 79
      // We were asked to disconnect between trying to open the connection and                                         // 80
      // actually opening it. Let's just pretend this never happened.                                                  // 81
      connection.close();                                                                                              // 82
      return;                                                                                                          // 83
    }                                                                                                                  // 84
                                                                                                                       // 85
    if (self.currentStatus.connected) {                                                                                // 86
      // We already have a connection. It must have been the case that                                                 // 87
      // we started two parallel connection attempts (because we                                                       // 88
      // wanted to 'reconnect now' on a hanging connection and we had                                                  // 89
      // no way to cancel the connection attempt.) Just ignore/close                                                   // 90
      // the latecomer.                                                                                                // 91
      connection.close();                                                                                              // 92
      return;                                                                                                          // 93
    }                                                                                                                  // 94
                                                                                                                       // 95
    if (self.connectionTimer) {                                                                                        // 96
      clearTimeout(self.connectionTimer);                                                                              // 97
      self.connectionTimer = null;                                                                                     // 98
    }                                                                                                                  // 99
                                                                                                                       // 100
    var onError = Meteor.bindEnvironment(                                                                              // 101
      function (_this, error) {                                                                                        // 102
        if (self.currentConnection !== _this)                                                                          // 103
          return;                                                                                                      // 104
                                                                                                                       // 105
        Meteor._debug("stream error", error.toString(),                                                                // 106
                      (new Date()).toDateString());                                                                    // 107
        self._lostConnection();                                                                                        // 108
      },                                                                                                               // 109
      "stream error callback"                                                                                          // 110
    );                                                                                                                 // 111
                                                                                                                       // 112
    connection.on('error', function (error) {                                                                          // 113
      // We have to pass in `this` explicitly because bindEnvironment                                                  // 114
      // doesn't propagate it for us.                                                                                  // 115
      onError(this, error);                                                                                            // 116
    });                                                                                                                // 117
                                                                                                                       // 118
    var onClose = Meteor.bindEnvironment(                                                                              // 119
      function (_this) {                                                                                               // 120
        if (self.options._testOnClose)                                                                                 // 121
          self.options._testOnClose();                                                                                 // 122
                                                                                                                       // 123
        if (self.currentConnection !== _this)                                                                          // 124
          return;                                                                                                      // 125
                                                                                                                       // 126
        self._lostConnection();                                                                                        // 127
      },                                                                                                               // 128
      "stream close callback"                                                                                          // 129
    );                                                                                                                 // 130
                                                                                                                       // 131
    connection.on('close', function () {                                                                               // 132
      // We have to pass in `this` explicitly because bindEnvironment                                                  // 133
      // doesn't propagate it for us.                                                                                  // 134
      onClose(this);                                                                                                   // 135
    });                                                                                                                // 136
                                                                                                                       // 137
    connection.on('message', function (message) {                                                                      // 138
      if (self.currentConnection !== this)                                                                             // 139
        return; // old connection still emitting messages                                                              // 140
                                                                                                                       // 141
      if (message.type === "utf8") // ignore binary frames                                                             // 142
        _.each(self.eventCallbacks.message, function (callback) {                                                      // 143
          callback(message.utf8Data);                                                                                  // 144
        });                                                                                                            // 145
    });                                                                                                                // 146
                                                                                                                       // 147
    // update status                                                                                                   // 148
    self.currentConnection = connection;                                                                               // 149
    self.currentStatus.status = "connected";                                                                           // 150
    self.currentStatus.connected = true;                                                                               // 151
    self.currentStatus.retryCount = 0;                                                                                 // 152
    self.statusChanged();                                                                                              // 153
                                                                                                                       // 154
    // fire resets. This must come after status change so that clients                                                 // 155
    // can call send from within a reset callback.                                                                     // 156
    _.each(self.eventCallbacks.reset, function (callback) { callback(); });                                            // 157
  },                                                                                                                   // 158
                                                                                                                       // 159
  _cleanup: function () {                                                                                              // 160
    var self = this;                                                                                                   // 161
                                                                                                                       // 162
    self._clearConnectionTimer();                                                                                      // 163
    if (self.currentConnection) {                                                                                      // 164
      var conn = self.currentConnection;                                                                               // 165
      self.currentConnection = null;                                                                                   // 166
      conn.close();                                                                                                    // 167
    }                                                                                                                  // 168
  },                                                                                                                   // 169
                                                                                                                       // 170
  _clearConnectionTimer: function () {                                                                                 // 171
    var self = this;                                                                                                   // 172
                                                                                                                       // 173
    if (self.connectionTimer) {                                                                                        // 174
      clearTimeout(self.connectionTimer);                                                                              // 175
      self.connectionTimer = null;                                                                                     // 176
    }                                                                                                                  // 177
  },                                                                                                                   // 178
                                                                                                                       // 179
  _launchConnection: function () {                                                                                     // 180
    var self = this;                                                                                                   // 181
    self._cleanup(); // cleanup the old socket, if there was one.                                                      // 182
                                                                                                                       // 183
    // launch a connect attempt. we have no way to track it. we either                                                 // 184
    // get an _onConnect event, or we don't.                                                                           // 185
                                                                                                                       // 186
    // XXX: set up a timeout on this.                                                                                  // 187
                                                                                                                       // 188
    // we would like to specify 'ddp' as the protocol here, but                                                        // 189
    // unfortunately WebSocket-Node fails the handshake if we ask for                                                  // 190
    // a protocol and the server doesn't send one back (and sockjs                                                     // 191
    // doesn't). also, related: I guess we have to accept that                                                         // 192
    // 'stream' is ddp-specific                                                                                        // 193
    self.client.connect(toWebsocketUrl(self.endpoint),                                                                 // 194
                        undefined, // protocols                                                                        // 195
                        undefined, // origin                                                                           // 196
                        self.headers);                                                                                 // 197
                                                                                                                       // 198
    if (self.connectionTimer)                                                                                          // 199
      clearTimeout(self.connectionTimer);                                                                              // 200
    self.connectionTimer = setTimeout(                                                                                 // 201
      _.bind(self._lostConnection, self),                                                                              // 202
      self.CONNECT_TIMEOUT);                                                                                           // 203
  }                                                                                                                    // 204
});                                                                                                                    // 205
                                                                                                                       // 206
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/livedata/stream_client_common.js                                                                           //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
// XXX from Underscore.String (http://epeli.github.com/underscore.string/)                                             // 1
var startsWith = function(str, starts) {                                                                               // 2
  return str.length >= starts.length &&                                                                                // 3
    str.substring(0, starts.length) === starts;                                                                        // 4
};                                                                                                                     // 5
var endsWith = function(str, ends) {                                                                                   // 6
  return str.length >= ends.length &&                                                                                  // 7
    str.substring(str.length - ends.length) === ends;                                                                  // 8
};                                                                                                                     // 9
                                                                                                                       // 10
// @param url {String} URL to Meteor app, eg:                                                                          // 11
//   "/" or "madewith.meteor.com" or "https://foo.meteor.com"                                                          // 12
//   or "ddp+sockjs://ddp--****-foo.meteor.com/sockjs"                                                                 // 13
// @returns {String} URL to the endpoint with the specific scheme and subPath, e.g.                                    // 14
// for scheme "http" and subPath "sockjs"                                                                              // 15
//   "http://subdomain.meteor.com/sockjs" or "/sockjs"                                                                 // 16
//   or "https://ddp--1234-foo.meteor.com/sockjs"                                                                      // 17
var translateUrl =  function(url, newSchemeBase, subPath) {                                                            // 18
  if (! newSchemeBase) {                                                                                               // 19
    newSchemeBase = "http";                                                                                            // 20
  }                                                                                                                    // 21
                                                                                                                       // 22
  var ddpUrlMatch = url.match(/^ddp(i?)\+sockjs:\/\//);                                                                // 23
  var httpUrlMatch = url.match(/^http(s?):\/\//);                                                                      // 24
  var newScheme;                                                                                                       // 25
  if (ddpUrlMatch) {                                                                                                   // 26
    // Remove scheme and split off the host.                                                                           // 27
    var urlAfterDDP = url.substr(ddpUrlMatch[0].length);                                                               // 28
    newScheme = ddpUrlMatch[1] === "i" ? newSchemeBase : newSchemeBase + "s";                                          // 29
    var slashPos = urlAfterDDP.indexOf('/');                                                                           // 30
    var host =                                                                                                         // 31
          slashPos === -1 ? urlAfterDDP : urlAfterDDP.substr(0, slashPos);                                             // 32
    var rest = slashPos === -1 ? '' : urlAfterDDP.substr(slashPos);                                                    // 33
                                                                                                                       // 34
    // In the host (ONLY!), change '*' characters into random digits. This                                             // 35
    // allows different stream connections to connect to different hostnames                                           // 36
    // and avoid browser per-hostname connection limits.                                                               // 37
    host = host.replace(/\*/g, function () {                                                                           // 38
      return Math.floor(Random.fraction()*10);                                                                         // 39
    });                                                                                                                // 40
                                                                                                                       // 41
    return newScheme + '://' + host + rest;                                                                            // 42
  } else if (httpUrlMatch) {                                                                                           // 43
    newScheme = !httpUrlMatch[1] ? newSchemeBase : newSchemeBase + "s";                                                // 44
    var urlAfterHttp = url.substr(httpUrlMatch[0].length);                                                             // 45
    url = newScheme + "://" + urlAfterHttp;                                                                            // 46
  }                                                                                                                    // 47
                                                                                                                       // 48
  // Prefix FQDNs but not relative URLs                                                                                // 49
  if (url.indexOf("://") === -1 && !startsWith(url, "/")) {                                                            // 50
    url = newSchemeBase + "://" + url;                                                                                 // 51
  }                                                                                                                    // 52
                                                                                                                       // 53
  // XXX This is not what we should be doing: if I have a site                                                         // 54
  // deployed at "/foo", then DDP.connect("/") should actually connect                                                 // 55
  // to "/", not to "/foo". "/" is an absolute path. (Contrast: if                                                     // 56
  // deployed at "/foo", it would be reasonable for DDP.connect("bar")                                                 // 57
  // to connect to "/foo/bar").                                                                                        // 58
  //                                                                                                                   // 59
  // We should make this properly honor absolute paths rather than                                                     // 60
  // forcing the path to be relative to the site root. Simultaneously,                                                 // 61
  // we should set DDP_DEFAULT_CONNECTION_URL to include the site                                                      // 62
  // root. See also client_convenience.js #RationalizingRelativeDDPURLs                                                // 63
  url = Meteor._relativeToSiteRootUrl(url);                                                                            // 64
                                                                                                                       // 65
  if (endsWith(url, "/"))                                                                                              // 66
    return url + subPath;                                                                                              // 67
  else                                                                                                                 // 68
    return url + "/" + subPath;                                                                                        // 69
};                                                                                                                     // 70
                                                                                                                       // 71
toSockjsUrl = function (url) {                                                                                         // 72
  return translateUrl(url, "http", "sockjs");                                                                          // 73
};                                                                                                                     // 74
                                                                                                                       // 75
toWebsocketUrl = function (url) {                                                                                      // 76
  var ret = translateUrl(url, "ws", "websocket");                                                                      // 77
  return ret;                                                                                                          // 78
};                                                                                                                     // 79
                                                                                                                       // 80
LivedataTest.toSockjsUrl = toSockjsUrl;                                                                                // 81
                                                                                                                       // 82
                                                                                                                       // 83
_.extend(LivedataTest.ClientStream.prototype, {                                                                        // 84
                                                                                                                       // 85
  // Register for callbacks.                                                                                           // 86
  on: function (name, callback) {                                                                                      // 87
    var self = this;                                                                                                   // 88
                                                                                                                       // 89
    if (name !== 'message' && name !== 'reset')                                                                        // 90
      throw new Error("unknown event type: " + name);                                                                  // 91
                                                                                                                       // 92
    if (!self.eventCallbacks[name])                                                                                    // 93
      self.eventCallbacks[name] = [];                                                                                  // 94
    self.eventCallbacks[name].push(callback);                                                                          // 95
  },                                                                                                                   // 96
                                                                                                                       // 97
                                                                                                                       // 98
  _initCommon: function () {                                                                                           // 99
    var self = this;                                                                                                   // 100
    //// Constants                                                                                                     // 101
                                                                                                                       // 102
    // how long to wait until we declare the connection attempt                                                        // 103
    // failed.                                                                                                         // 104
    self.CONNECT_TIMEOUT = 10000;                                                                                      // 105
                                                                                                                       // 106
    self.eventCallbacks = {}; // name -> [callback]                                                                    // 107
                                                                                                                       // 108
    self._forcedToDisconnect = false;                                                                                  // 109
                                                                                                                       // 110
    //// Reactive status                                                                                               // 111
    self.currentStatus = {                                                                                             // 112
      status: "connecting",                                                                                            // 113
      connected: false,                                                                                                // 114
      retryCount: 0                                                                                                    // 115
    };                                                                                                                 // 116
                                                                                                                       // 117
                                                                                                                       // 118
    self.statusListeners = typeof Deps !== 'undefined' && new Deps.Dependency;                                         // 119
    self.statusChanged = function () {                                                                                 // 120
      if (self.statusListeners)                                                                                        // 121
        self.statusListeners.changed();                                                                                // 122
    };                                                                                                                 // 123
                                                                                                                       // 124
    //// Retry logic                                                                                                   // 125
    self._retry = new Retry;                                                                                           // 126
    self.connectionTimer = null;                                                                                       // 127
                                                                                                                       // 128
  },                                                                                                                   // 129
                                                                                                                       // 130
  // Trigger a reconnect.                                                                                              // 131
  reconnect: function (options) {                                                                                      // 132
    var self = this;                                                                                                   // 133
    options = options || {};                                                                                           // 134
                                                                                                                       // 135
    if (options.url) {                                                                                                 // 136
      self._changeUrl(options.url);                                                                                    // 137
    }                                                                                                                  // 138
                                                                                                                       // 139
    if (options._sockjsOptions) {                                                                                      // 140
      self.options._sockjsOptions = options._sockjsOptions;                                                            // 141
    }                                                                                                                  // 142
                                                                                                                       // 143
    if (self.currentStatus.connected) {                                                                                // 144
      if (options._force || options.url) {                                                                             // 145
        // force reconnect.                                                                                            // 146
        self._lostConnection();                                                                                        // 147
      } // else, noop.                                                                                                 // 148
      return;                                                                                                          // 149
    }                                                                                                                  // 150
                                                                                                                       // 151
    // if we're mid-connection, stop it.                                                                               // 152
    if (self.currentStatus.status === "connecting") {                                                                  // 153
      self._lostConnection();                                                                                          // 154
    }                                                                                                                  // 155
                                                                                                                       // 156
    self._retry.clear();                                                                                               // 157
    self.currentStatus.retryCount -= 1; // don't count manual retries                                                  // 158
    self._retryNow();                                                                                                  // 159
  },                                                                                                                   // 160
                                                                                                                       // 161
  disconnect: function (options) {                                                                                     // 162
    var self = this;                                                                                                   // 163
    options = options || {};                                                                                           // 164
                                                                                                                       // 165
    // Failed is permanent. If we're failed, don't let people go back                                                  // 166
    // online by calling 'disconnect' then 'reconnect'.                                                                // 167
    if (self._forcedToDisconnect)                                                                                      // 168
      return;                                                                                                          // 169
                                                                                                                       // 170
    // If _permanent is set, permanently disconnect a stream. Once a stream                                            // 171
    // is forced to disconnect, it can never reconnect. This is for                                                    // 172
    // error cases such as ddp version mismatch, where trying again                                                    // 173
    // won't fix the problem.                                                                                          // 174
    if (options._permanent) {                                                                                          // 175
      self._forcedToDisconnect = true;                                                                                 // 176
    }                                                                                                                  // 177
                                                                                                                       // 178
    self._cleanup();                                                                                                   // 179
    self._retry.clear();                                                                                               // 180
                                                                                                                       // 181
    self.currentStatus = {                                                                                             // 182
      status: (options._permanent ? "failed" : "offline"),                                                             // 183
      connected: false,                                                                                                // 184
      retryCount: 0                                                                                                    // 185
    };                                                                                                                 // 186
                                                                                                                       // 187
    if (options._permanent && options._error)                                                                          // 188
      self.currentStatus.reason = options._error;                                                                      // 189
                                                                                                                       // 190
    self.statusChanged();                                                                                              // 191
  },                                                                                                                   // 192
                                                                                                                       // 193
  _lostConnection: function () {                                                                                       // 194
    var self = this;                                                                                                   // 195
                                                                                                                       // 196
    self._cleanup();                                                                                                   // 197
    self._retryLater(); // sets status. no need to do it here.                                                         // 198
  },                                                                                                                   // 199
                                                                                                                       // 200
  // fired when we detect that we've gone online. try to reconnect                                                     // 201
  // immediately.                                                                                                      // 202
  _online: function () {                                                                                               // 203
    // if we've requested to be offline by disconnecting, don't reconnect.                                             // 204
    if (this.currentStatus.status != "offline")                                                                        // 205
      this.reconnect();                                                                                                // 206
  },                                                                                                                   // 207
                                                                                                                       // 208
  _retryLater: function () {                                                                                           // 209
    var self = this;                                                                                                   // 210
                                                                                                                       // 211
    var timeout = 0;                                                                                                   // 212
    if (self.options.retry) {                                                                                          // 213
      timeout = self._retry.retryLater(                                                                                // 214
        self.currentStatus.retryCount,                                                                                 // 215
        _.bind(self._retryNow, self)                                                                                   // 216
      );                                                                                                               // 217
    }                                                                                                                  // 218
                                                                                                                       // 219
    self.currentStatus.status = "waiting";                                                                             // 220
    self.currentStatus.connected = false;                                                                              // 221
    self.currentStatus.retryTime = (new Date()).getTime() + timeout;                                                   // 222
    self.statusChanged();                                                                                              // 223
  },                                                                                                                   // 224
                                                                                                                       // 225
  _retryNow: function () {                                                                                             // 226
    var self = this;                                                                                                   // 227
                                                                                                                       // 228
    if (self._forcedToDisconnect)                                                                                      // 229
      return;                                                                                                          // 230
                                                                                                                       // 231
    self.currentStatus.retryCount += 1;                                                                                // 232
    self.currentStatus.status = "connecting";                                                                          // 233
    self.currentStatus.connected = false;                                                                              // 234
    delete self.currentStatus.retryTime;                                                                               // 235
    self.statusChanged();                                                                                              // 236
                                                                                                                       // 237
    self._launchConnection();                                                                                          // 238
  },                                                                                                                   // 239
                                                                                                                       // 240
                                                                                                                       // 241
  // Get current status. Reactive.                                                                                     // 242
  status: function () {                                                                                                // 243
    var self = this;                                                                                                   // 244
    if (self.statusListeners)                                                                                          // 245
      self.statusListeners.depend();                                                                                   // 246
    return self.currentStatus;                                                                                         // 247
  }                                                                                                                    // 248
});                                                                                                                    // 249
                                                                                                                       // 250
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/livedata/stream_server.js                                                                                  //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
var url = Npm.require('url');                                                                                          // 1
                                                                                                                       // 2
var pathPrefix = __meteor_runtime_config__.ROOT_URL_PATH_PREFIX ||  "";                                                // 3
                                                                                                                       // 4
StreamServer = function () {                                                                                           // 5
  var self = this;                                                                                                     // 6
  self.registration_callbacks = [];                                                                                    // 7
  self.open_sockets = [];                                                                                              // 8
                                                                                                                       // 9
  // Because we are installing directly onto WebApp.httpServer instead of using                                        // 10
  // WebApp.app, we have to process the path prefix ourselves.                                                         // 11
  self.prefix = pathPrefix + '/sockjs';                                                                                // 12
  // routepolicy is only a weak dependency, because we don't need it if we're                                          // 13
  // just doing server-to-server DDP as a client.                                                                      // 14
  if (Package.routepolicy) {                                                                                           // 15
    Package.routepolicy.RoutePolicy.declare(self.prefix + '/', 'network');                                             // 16
  }                                                                                                                    // 17
                                                                                                                       // 18
  // set up sockjs                                                                                                     // 19
  var sockjs = Npm.require('sockjs');                                                                                  // 20
  var serverOptions = {                                                                                                // 21
    prefix: self.prefix,                                                                                               // 22
    log: function() {},                                                                                                // 23
    // this is the default, but we code it explicitly because we depend                                                // 24
    // on it in stream_client:HEARTBEAT_TIMEOUT                                                                        // 25
    heartbeat_delay: 25000,                                                                                            // 26
    // The default disconnect_delay is 5 seconds, but if the server ends up CPU                                        // 27
    // bound for that much time, SockJS might not notice that the user has                                             // 28
    // reconnected because the timer (of disconnect_delay ms) can fire before                                          // 29
    // SockJS processes the new connection. Eventually we'll fix this by not                                           // 30
    // combining CPU-heavy processing with SockJS termination (eg a proxy which                                        // 31
    // converts to Unix sockets) but for now, raise the delay.                                                         // 32
    disconnect_delay: 60 * 1000,                                                                                       // 33
    // Set the USE_JSESSIONID environment variable to enable setting the                                               // 34
    // JSESSIONID cookie. This is useful for setting up proxies with                                                   // 35
    // session affinity.                                                                                               // 36
    jsessionid: !!process.env.USE_JSESSIONID                                                                           // 37
  };                                                                                                                   // 38
                                                                                                                       // 39
  // If you know your server environment (eg, proxies) will prevent websockets                                         // 40
  // from ever working, set $DISABLE_WEBSOCKETS and SockJS clients (ie,                                                // 41
  // browsers) will not waste time attempting to use them.                                                             // 42
  // (Your server will still have a /websocket endpoint.)                                                              // 43
  if (process.env.DISABLE_WEBSOCKETS)                                                                                  // 44
    serverOptions.websocket = false;                                                                                   // 45
                                                                                                                       // 46
  self.server = sockjs.createServer(serverOptions);                                                                    // 47
  if (!Package.webapp) {                                                                                               // 48
    throw new Error("Cannot create a DDP server without the webapp package");                                          // 49
  }                                                                                                                    // 50
  // Install the sockjs handlers, but we want to keep around our own particular                                        // 51
  // request handler that adjusts idle timeouts while we have an outstanding                                           // 52
  // request.  This compensates for the fact that sockjs removes all listeners                                         // 53
  // for "request" to add its own.                                                                                     // 54
  Package.webapp.WebApp.httpServer.removeListener('request', Package.webapp.WebApp._timeoutAdjustmentRequestCallback); // 55
  self.server.installHandlers(Package.webapp.WebApp.httpServer);                                                       // 56
  Package.webapp.WebApp.httpServer.addListener('request', Package.webapp.WebApp._timeoutAdjustmentRequestCallback);    // 57
                                                                                                                       // 58
  Package.webapp.WebApp.httpServer.on('meteor-closing', function () {                                                  // 59
    _.each(self.open_sockets, function (socket) {                                                                      // 60
      socket.end();                                                                                                    // 61
    });                                                                                                                // 62
  });                                                                                                                  // 63
                                                                                                                       // 64
  // Support the /websocket endpoint                                                                                   // 65
  self._redirectWebsocketEndpoint();                                                                                   // 66
                                                                                                                       // 67
  self.server.on('connection', function (socket) {                                                                     // 68
                                                                                                                       // 69
    if (Package.webapp.WebAppInternals.usingDdpProxy) {                                                                // 70
      // If we are behind a DDP proxy, immediately close any sockjs connections                                        // 71
      // that are not using websockets; the proxy will terminate sockjs for us,                                        // 72
      // so we don't expect to be handling any other transports.                                                       // 73
      if (socket.protocol !== "websocket" &&                                                                           // 74
          socket.protocol !== "websocket-raw") {                                                                       // 75
        socket.close();                                                                                                // 76
        return;                                                                                                        // 77
      }                                                                                                                // 78
    }                                                                                                                  // 79
                                                                                                                       // 80
    socket.send = function (data) {                                                                                    // 81
      socket.write(data);                                                                                              // 82
    };                                                                                                                 // 83
    socket.on('close', function () {                                                                                   // 84
      self.open_sockets = _.without(self.open_sockets, socket);                                                        // 85
    });                                                                                                                // 86
    self.open_sockets.push(socket);                                                                                    // 87
                                                                                                                       // 88
    // XXX COMPAT WITH 0.6.6. Send the old style welcome message, which                                                // 89
    // will force old clients to reload. Remove this once we're not                                                    // 90
    // concerned about people upgrading from a pre-0.7.0 release. Also,                                                // 91
    // remove the clause in the client that ignores the welcome message                                                // 92
    // (livedata_connection.js)                                                                                        // 93
    socket.send(JSON.stringify({server_id: "0"}));                                                                     // 94
                                                                                                                       // 95
    // call all our callbacks when we get a new socket. they will do the                                               // 96
    // work of setting up handlers and such for specific messages.                                                     // 97
    _.each(self.registration_callbacks, function (callback) {                                                          // 98
      callback(socket);                                                                                                // 99
    });                                                                                                                // 100
  });                                                                                                                  // 101
                                                                                                                       // 102
};                                                                                                                     // 103
                                                                                                                       // 104
_.extend(StreamServer.prototype, {                                                                                     // 105
  // call my callback when a new socket connects.                                                                      // 106
  // also call it for all current connections.                                                                         // 107
  register: function (callback) {                                                                                      // 108
    var self = this;                                                                                                   // 109
    self.registration_callbacks.push(callback);                                                                        // 110
    _.each(self.all_sockets(), function (socket) {                                                                     // 111
      callback(socket);                                                                                                // 112
    });                                                                                                                // 113
  },                                                                                                                   // 114
                                                                                                                       // 115
  // get a list of all sockets                                                                                         // 116
  all_sockets: function () {                                                                                           // 117
    var self = this;                                                                                                   // 118
    return _.values(self.open_sockets);                                                                                // 119
  },                                                                                                                   // 120
                                                                                                                       // 121
  // Redirect /websocket to /sockjs/websocket in order to not expose                                                   // 122
  // sockjs to clients that want to use raw websockets                                                                 // 123
  _redirectWebsocketEndpoint: function() {                                                                             // 124
    var self = this;                                                                                                   // 125
    // Unfortunately we can't use a connect middleware here since                                                      // 126
    // sockjs installs itself prior to all existing listeners                                                          // 127
    // (meaning prior to any connect middlewares) so we need to take                                                   // 128
    // an approach similar to overshadowListeners in                                                                   // 129
    // https://github.com/sockjs/sockjs-node/blob/cf820c55af6a9953e16558555a31decea554f70e/src/utils.coffee            // 130
    _.each(['request', 'upgrade'], function(event) {                                                                   // 131
      var httpServer = Package.webapp.WebApp.httpServer;                                                               // 132
      var oldHttpServerListeners = httpServer.listeners(event).slice(0);                                               // 133
      httpServer.removeAllListeners(event);                                                                            // 134
                                                                                                                       // 135
      // request and upgrade have different arguments passed but                                                       // 136
      // we only care about the first one which is always request                                                      // 137
      var newListener = function(request /*, moreArguments */) {                                                       // 138
        // Store arguments for use within the closure below                                                            // 139
        var args = arguments;                                                                                          // 140
                                                                                                                       // 141
        // Rewrite /websocket and /websocket/ urls to /sockjs/websocket while                                          // 142
        // preserving query string.                                                                                    // 143
        var parsedUrl = url.parse(request.url);                                                                        // 144
        if (parsedUrl.pathname === pathPrefix + '/websocket' ||                                                        // 145
            parsedUrl.pathname === pathPrefix + '/websocket/') {                                                       // 146
          parsedUrl.pathname = self.prefix + '/websocket';                                                             // 147
          request.url = url.format(parsedUrl);                                                                         // 148
        }                                                                                                              // 149
        _.each(oldHttpServerListeners, function(oldListener) {                                                         // 150
          oldListener.apply(httpServer, args);                                                                         // 151
        });                                                                                                            // 152
      };                                                                                                               // 153
      httpServer.addListener(event, newListener);                                                                      // 154
    });                                                                                                                // 155
  }                                                                                                                    // 156
});                                                                                                                    // 157
                                                                                                                       // 158
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/livedata/livedata_server.js                                                                                //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
DDPServer = {};                                                                                                        // 1
                                                                                                                       // 2
var Fiber = Npm.require('fibers');                                                                                     // 3
                                                                                                                       // 4
// This file contains classes:                                                                                         // 5
// * Session - The server's connection to a single DDP client                                                          // 6
// * Subscription - A single subscription for a single client                                                          // 7
// * Server - An entire server that may talk to > 1 client. A DDP endpoint.                                            // 8
//                                                                                                                     // 9
// Session and Subscription are file scope. For now, until we freeze                                                   // 10
// the interface, Server is package scope (in the future it should be                                                  // 11
// exported.)                                                                                                          // 12
                                                                                                                       // 13
// Represents a single document in a SessionCollectionView                                                             // 14
var SessionDocumentView = function () {                                                                                // 15
  var self = this;                                                                                                     // 16
  self.existsIn = {}; // set of subscriptionHandle                                                                     // 17
  self.dataByKey = {}; // key-> [ {subscriptionHandle, value} by precedence]                                           // 18
};                                                                                                                     // 19
                                                                                                                       // 20
_.extend(SessionDocumentView.prototype, {                                                                              // 21
                                                                                                                       // 22
  getFields: function () {                                                                                             // 23
    var self = this;                                                                                                   // 24
    var ret = {};                                                                                                      // 25
    _.each(self.dataByKey, function (precedenceList, key) {                                                            // 26
      ret[key] = precedenceList[0].value;                                                                              // 27
    });                                                                                                                // 28
    return ret;                                                                                                        // 29
  },                                                                                                                   // 30
                                                                                                                       // 31
  clearField: function (subscriptionHandle, key, changeCollector) {                                                    // 32
    var self = this;                                                                                                   // 33
    // Publish API ignores _id if present in fields                                                                    // 34
    if (key === "_id")                                                                                                 // 35
      return;                                                                                                          // 36
    var precedenceList = self.dataByKey[key];                                                                          // 37
                                                                                                                       // 38
    // It's okay to clear fields that didn't exist. No need to throw                                                   // 39
    // an error.                                                                                                       // 40
    if (!precedenceList)                                                                                               // 41
      return;                                                                                                          // 42
                                                                                                                       // 43
    var removedValue = undefined;                                                                                      // 44
    for (var i = 0; i < precedenceList.length; i++) {                                                                  // 45
      var precedence = precedenceList[i];                                                                              // 46
      if (precedence.subscriptionHandle === subscriptionHandle) {                                                      // 47
        // The view's value can only change if this subscription is the one that                                       // 48
        // used to have precedence.                                                                                    // 49
        if (i === 0)                                                                                                   // 50
          removedValue = precedence.value;                                                                             // 51
        precedenceList.splice(i, 1);                                                                                   // 52
        break;                                                                                                         // 53
      }                                                                                                                // 54
    }                                                                                                                  // 55
    if (_.isEmpty(precedenceList)) {                                                                                   // 56
      delete self.dataByKey[key];                                                                                      // 57
      changeCollector[key] = undefined;                                                                                // 58
    } else if (removedValue !== undefined &&                                                                           // 59
               !EJSON.equals(removedValue, precedenceList[0].value)) {                                                 // 60
      changeCollector[key] = precedenceList[0].value;                                                                  // 61
    }                                                                                                                  // 62
  },                                                                                                                   // 63
                                                                                                                       // 64
  changeField: function (subscriptionHandle, key, value,                                                               // 65
                         changeCollector, isAdd) {                                                                     // 66
    var self = this;                                                                                                   // 67
    // Publish API ignores _id if present in fields                                                                    // 68
    if (key === "_id")                                                                                                 // 69
      return;                                                                                                          // 70
                                                                                                                       // 71
    // Don't share state with the data passed in by the user.                                                          // 72
    value = EJSON.clone(value);                                                                                        // 73
                                                                                                                       // 74
    if (!_.has(self.dataByKey, key)) {                                                                                 // 75
      self.dataByKey[key] = [{subscriptionHandle: subscriptionHandle,                                                  // 76
                              value: value}];                                                                          // 77
      changeCollector[key] = value;                                                                                    // 78
      return;                                                                                                          // 79
    }                                                                                                                  // 80
    var precedenceList = self.dataByKey[key];                                                                          // 81
    var elt;                                                                                                           // 82
    if (!isAdd) {                                                                                                      // 83
      elt = _.find(precedenceList, function (precedence) {                                                             // 84
        return precedence.subscriptionHandle === subscriptionHandle;                                                   // 85
      });                                                                                                              // 86
    }                                                                                                                  // 87
                                                                                                                       // 88
    if (elt) {                                                                                                         // 89
      if (elt === precedenceList[0] && !EJSON.equals(value, elt.value)) {                                              // 90
        // this subscription is changing the value of this field.                                                      // 91
        changeCollector[key] = value;                                                                                  // 92
      }                                                                                                                // 93
      elt.value = value;                                                                                               // 94
    } else {                                                                                                           // 95
      // this subscription is newly caring about this field                                                            // 96
      precedenceList.push({subscriptionHandle: subscriptionHandle, value: value});                                     // 97
    }                                                                                                                  // 98
                                                                                                                       // 99
  }                                                                                                                    // 100
});                                                                                                                    // 101
                                                                                                                       // 102
// Represents a client's view of a single collection                                                                   // 103
var SessionCollectionView = function (collectionName, sessionCallbacks) {                                              // 104
  var self = this;                                                                                                     // 105
  self.collectionName = collectionName;                                                                                // 106
  self.documents = {};                                                                                                 // 107
  self.callbacks = sessionCallbacks;                                                                                   // 108
};                                                                                                                     // 109
                                                                                                                       // 110
LivedataTest.SessionCollectionView = SessionCollectionView;                                                            // 111
                                                                                                                       // 112
                                                                                                                       // 113
_.extend(SessionCollectionView.prototype, {                                                                            // 114
                                                                                                                       // 115
  isEmpty: function () {                                                                                               // 116
    var self = this;                                                                                                   // 117
    return _.isEmpty(self.documents);                                                                                  // 118
  },                                                                                                                   // 119
                                                                                                                       // 120
  diff: function (previous) {                                                                                          // 121
    var self = this;                                                                                                   // 122
    LocalCollection._diffObjects(previous.documents, self.documents, {                                                 // 123
      both: _.bind(self.diffDocument, self),                                                                           // 124
                                                                                                                       // 125
      rightOnly: function (id, nowDV) {                                                                                // 126
        self.callbacks.added(self.collectionName, id, nowDV.getFields());                                              // 127
      },                                                                                                               // 128
                                                                                                                       // 129
      leftOnly: function (id, prevDV) {                                                                                // 130
        self.callbacks.removed(self.collectionName, id);                                                               // 131
      }                                                                                                                // 132
    });                                                                                                                // 133
  },                                                                                                                   // 134
                                                                                                                       // 135
  diffDocument: function (id, prevDV, nowDV) {                                                                         // 136
    var self = this;                                                                                                   // 137
    var fields = {};                                                                                                   // 138
    LocalCollection._diffObjects(prevDV.getFields(), nowDV.getFields(), {                                              // 139
      both: function (key, prev, now) {                                                                                // 140
        if (!EJSON.equals(prev, now))                                                                                  // 141
          fields[key] = now;                                                                                           // 142
      },                                                                                                               // 143
      rightOnly: function (key, now) {                                                                                 // 144
        fields[key] = now;                                                                                             // 145
      },                                                                                                               // 146
      leftOnly: function(key, prev) {                                                                                  // 147
        fields[key] = undefined;                                                                                       // 148
      }                                                                                                                // 149
    });                                                                                                                // 150
    self.callbacks.changed(self.collectionName, id, fields);                                                           // 151
  },                                                                                                                   // 152
                                                                                                                       // 153
  added: function (subscriptionHandle, id, fields) {                                                                   // 154
    var self = this;                                                                                                   // 155
    var docView = self.documents[id];                                                                                  // 156
    var added = false;                                                                                                 // 157
    if (!docView) {                                                                                                    // 158
      added = true;                                                                                                    // 159
      docView = new SessionDocumentView();                                                                             // 160
      self.documents[id] = docView;                                                                                    // 161
    }                                                                                                                  // 162
    docView.existsIn[subscriptionHandle] = true;                                                                       // 163
    var changeCollector = {};                                                                                          // 164
    _.each(fields, function (value, key) {                                                                             // 165
      docView.changeField(                                                                                             // 166
        subscriptionHandle, key, value, changeCollector, true);                                                        // 167
    });                                                                                                                // 168
    if (added)                                                                                                         // 169
      self.callbacks.added(self.collectionName, id, changeCollector);                                                  // 170
    else                                                                                                               // 171
      self.callbacks.changed(self.collectionName, id, changeCollector);                                                // 172
  },                                                                                                                   // 173
                                                                                                                       // 174
  changed: function (subscriptionHandle, id, changed) {                                                                // 175
    var self = this;                                                                                                   // 176
    var changedResult = {};                                                                                            // 177
    var docView = self.documents[id];                                                                                  // 178
    if (!docView)                                                                                                      // 179
      throw new Error("Could not find element with id " + id + " to change");                                          // 180
    _.each(changed, function (value, key) {                                                                            // 181
      if (value === undefined)                                                                                         // 182
        docView.clearField(subscriptionHandle, key, changedResult);                                                    // 183
      else                                                                                                             // 184
        docView.changeField(subscriptionHandle, key, value, changedResult);                                            // 185
    });                                                                                                                // 186
    self.callbacks.changed(self.collectionName, id, changedResult);                                                    // 187
  },                                                                                                                   // 188
                                                                                                                       // 189
  removed: function (subscriptionHandle, id) {                                                                         // 190
    var self = this;                                                                                                   // 191
    var docView = self.documents[id];                                                                                  // 192
    if (!docView) {                                                                                                    // 193
      var err = new Error("Removed nonexistent document " + id);                                                       // 194
      throw err;                                                                                                       // 195
    }                                                                                                                  // 196
    delete docView.existsIn[subscriptionHandle];                                                                       // 197
    if (_.isEmpty(docView.existsIn)) {                                                                                 // 198
      // it is gone from everyone                                                                                      // 199
      self.callbacks.removed(self.collectionName, id);                                                                 // 200
      delete self.documents[id];                                                                                       // 201
    } else {                                                                                                           // 202
      var changed = {};                                                                                                // 203
      // remove this subscription from every precedence list                                                           // 204
      // and record the changes                                                                                        // 205
      _.each(docView.dataByKey, function (precedenceList, key) {                                                       // 206
        docView.clearField(subscriptionHandle, key, changed);                                                          // 207
      });                                                                                                              // 208
                                                                                                                       // 209
      self.callbacks.changed(self.collectionName, id, changed);                                                        // 210
    }                                                                                                                  // 211
  }                                                                                                                    // 212
});                                                                                                                    // 213
                                                                                                                       // 214
/******************************************************************************/                                       // 215
/* Session                                                                    */                                       // 216
/******************************************************************************/                                       // 217
                                                                                                                       // 218
var Session = function (server, version, socket) {                                                                     // 219
  var self = this;                                                                                                     // 220
  self.id = Random.id();                                                                                               // 221
                                                                                                                       // 222
  self.server = server;                                                                                                // 223
  self.version = version;                                                                                              // 224
                                                                                                                       // 225
  self.initialized = false;                                                                                            // 226
  self.socket = socket;                                                                                                // 227
                                                                                                                       // 228
  // set to null when the session is destroyed. multiple places below                                                  // 229
  // use this to determine if the session is alive or not.                                                             // 230
  self.inQueue = [];                                                                                                   // 231
                                                                                                                       // 232
  self.blocked = false;                                                                                                // 233
  self.workerRunning = false;                                                                                          // 234
                                                                                                                       // 235
  // Sub objects for active subscriptions                                                                              // 236
  self._namedSubs = {};                                                                                                // 237
  self._universalSubs = [];                                                                                            // 238
                                                                                                                       // 239
  self.userId = null;                                                                                                  // 240
                                                                                                                       // 241
  self.collectionViews = {};                                                                                           // 242
                                                                                                                       // 243
  // Set this to false to not send messages when collectionViews are                                                   // 244
  // modified. This is done when rerunning subs in _setUserId and those messages                                       // 245
  // are calculated via a diff instead.                                                                                // 246
  self._isSending = true;                                                                                              // 247
                                                                                                                       // 248
  // If this is true, don't start a newly-created universal publisher on this                                          // 249
  // session. The session will take care of starting it when appropriate.                                              // 250
  self._dontStartNewUniversalSubs = false;                                                                             // 251
                                                                                                                       // 252
  // when we are rerunning subscriptions, any ready messages                                                           // 253
  // we want to buffer up for when we are done rerunning subscriptions                                                 // 254
  self._pendingReady = [];                                                                                             // 255
                                                                                                                       // 256
  // List of callbacks to call when this connection is closed.                                                         // 257
  self._closeCallbacks = [];                                                                                           // 258
                                                                                                                       // 259
                                                                                                                       // 260
  // XXX HACK: If a sockjs connection, save off the URL. This is                                                       // 261
  // temporary and will go away in the near future.                                                                    // 262
  self._socketUrl = socket.url;                                                                                        // 263
                                                                                                                       // 264
  // This object is the public interface to the session. In the public                                                 // 265
  // API, it is called the `connection` object.  Internally we call it                                                 // 266
  // a `connectionHandle` to avoid ambiguity.                                                                          // 267
  self.connectionHandle = {                                                                                            // 268
    id: self.id,                                                                                                       // 269
    close: function () {                                                                                               // 270
      self.server._closeSession(self);                                                                                 // 271
    },                                                                                                                 // 272
    onClose: function (fn) {                                                                                           // 273
      var cb = Meteor.bindEnvironment(fn, "connection onClose callback");                                              // 274
      if (self.inQueue) {                                                                                              // 275
        self._closeCallbacks.push(cb);                                                                                 // 276
      } else {                                                                                                         // 277
        // if we're already closed, call the callback.                                                                 // 278
        Meteor.defer(cb);                                                                                              // 279
      }                                                                                                                // 280
    },                                                                                                                 // 281
    clientAddress: self._clientAddress(),                                                                              // 282
    httpHeaders: self.socket.headers                                                                                   // 283
  };                                                                                                                   // 284
                                                                                                                       // 285
  socket.send(stringifyDDP({msg: 'connected',                                                                          // 286
                            session: self.id}));                                                                       // 287
  // On initial connect, spin up all the universal publishers.                                                         // 288
  Fiber(function () {                                                                                                  // 289
    self.startUniversalSubs();                                                                                         // 290
  }).run();                                                                                                            // 291
                                                                                                                       // 292
  Package.facts && Package.facts.Facts.incrementServerFact(                                                            // 293
    "livedata", "sessions", 1);                                                                                        // 294
};                                                                                                                     // 295
                                                                                                                       // 296
_.extend(Session.prototype, {                                                                                          // 297
                                                                                                                       // 298
  sendReady: function (subscriptionIds) {                                                                              // 299
    var self = this;                                                                                                   // 300
    if (self._isSending)                                                                                               // 301
      self.send({msg: "ready", subs: subscriptionIds});                                                                // 302
    else {                                                                                                             // 303
      _.each(subscriptionIds, function (subscriptionId) {                                                              // 304
        self._pendingReady.push(subscriptionId);                                                                       // 305
      });                                                                                                              // 306
    }                                                                                                                  // 307
  },                                                                                                                   // 308
                                                                                                                       // 309
  sendAdded: function (collectionName, id, fields) {                                                                   // 310
    var self = this;                                                                                                   // 311
    if (self._isSending)                                                                                               // 312
      self.send({msg: "added", collection: collectionName, id: id, fields: fields});                                   // 313
  },                                                                                                                   // 314
                                                                                                                       // 315
  sendChanged: function (collectionName, id, fields) {                                                                 // 316
    var self = this;                                                                                                   // 317
    if (_.isEmpty(fields))                                                                                             // 318
      return;                                                                                                          // 319
                                                                                                                       // 320
    if (self._isSending) {                                                                                             // 321
      self.send({                                                                                                      // 322
        msg: "changed",                                                                                                // 323
        collection: collectionName,                                                                                    // 324
        id: id,                                                                                                        // 325
        fields: fields                                                                                                 // 326
      });                                                                                                              // 327
    }                                                                                                                  // 328
  },                                                                                                                   // 329
                                                                                                                       // 330
  sendRemoved: function (collectionName, id) {                                                                         // 331
    var self = this;                                                                                                   // 332
    if (self._isSending)                                                                                               // 333
      self.send({msg: "removed", collection: collectionName, id: id});                                                 // 334
  },                                                                                                                   // 335
                                                                                                                       // 336
  getSendCallbacks: function () {                                                                                      // 337
    var self = this;                                                                                                   // 338
    return {                                                                                                           // 339
      added: _.bind(self.sendAdded, self),                                                                             // 340
      changed: _.bind(self.sendChanged, self),                                                                         // 341
      removed: _.bind(self.sendRemoved, self)                                                                          // 342
    };                                                                                                                 // 343
  },                                                                                                                   // 344
                                                                                                                       // 345
  getCollectionView: function (collectionName) {                                                                       // 346
    var self = this;                                                                                                   // 347
    if (_.has(self.collectionViews, collectionName)) {                                                                 // 348
      return self.collectionViews[collectionName];                                                                     // 349
    }                                                                                                                  // 350
    var ret = new SessionCollectionView(collectionName,                                                                // 351
                                        self.getSendCallbacks());                                                      // 352
    self.collectionViews[collectionName] = ret;                                                                        // 353
    return ret;                                                                                                        // 354
  },                                                                                                                   // 355
                                                                                                                       // 356
  added: function (subscriptionHandle, collectionName, id, fields) {                                                   // 357
    var self = this;                                                                                                   // 358
    var view = self.getCollectionView(collectionName);                                                                 // 359
    view.added(subscriptionHandle, id, fields);                                                                        // 360
  },                                                                                                                   // 361
                                                                                                                       // 362
  removed: function (subscriptionHandle, collectionName, id) {                                                         // 363
    var self = this;                                                                                                   // 364
    var view = self.getCollectionView(collectionName);                                                                 // 365
    view.removed(subscriptionHandle, id);                                                                              // 366
    if (view.isEmpty()) {                                                                                              // 367
      delete self.collectionViews[collectionName];                                                                     // 368
    }                                                                                                                  // 369
  },                                                                                                                   // 370
                                                                                                                       // 371
  changed: function (subscriptionHandle, collectionName, id, fields) {                                                 // 372
    var self = this;                                                                                                   // 373
    var view = self.getCollectionView(collectionName);                                                                 // 374
    view.changed(subscriptionHandle, id, fields);                                                                      // 375
  },                                                                                                                   // 376
                                                                                                                       // 377
  startUniversalSubs: function () {                                                                                    // 378
    var self = this;                                                                                                   // 379
    // Make a shallow copy of the set of universal handlers and start them. If                                         // 380
    // additional universal publishers start while we're running them (due to                                          // 381
    // yielding), they will run separately as part of Server.publish.                                                  // 382
    var handlers = _.clone(self.server.universal_publish_handlers);                                                    // 383
    _.each(handlers, function (handler) {                                                                              // 384
      self._startSubscription(handler);                                                                                // 385
    });                                                                                                                // 386
  },                                                                                                                   // 387
                                                                                                                       // 388
  // Destroy this session. Stop all processing and tear everything                                                     // 389
  // down. If a socket was attached, close it.                                                                         // 390
  destroy: function () {                                                                                               // 391
    var self = this;                                                                                                   // 392
                                                                                                                       // 393
    if (self.socket) {                                                                                                 // 394
      self.socket.close();                                                                                             // 395
      self.socket._meteorSession = null;                                                                               // 396
    }                                                                                                                  // 397
                                                                                                                       // 398
    // Drop the merge box data immediately.                                                                            // 399
    self.collectionViews = {};                                                                                         // 400
    self.inQueue = null;                                                                                               // 401
                                                                                                                       // 402
    Package.facts && Package.facts.Facts.incrementServerFact(                                                          // 403
      "livedata", "sessions", -1);                                                                                     // 404
                                                                                                                       // 405
    Meteor.defer(function () {                                                                                         // 406
      // stop callbacks can yield, so we defer this on destroy.                                                        // 407
      // sub._isDeactivated() detects that we set inQueue to null and                                                  // 408
      // treats it as semi-deactivated (it will ignore incoming callbacks, etc).                                       // 409
      self._deactivateAllSubscriptions();                                                                              // 410
                                                                                                                       // 411
      // Defer calling the close callbacks, so that the caller closing                                                 // 412
      // the session isn't waiting for all the callbacks to complete.                                                  // 413
      _.each(self._closeCallbacks, function (callback) {                                                               // 414
        callback();                                                                                                    // 415
      });                                                                                                              // 416
    });                                                                                                                // 417
  },                                                                                                                   // 418
                                                                                                                       // 419
  // Send a message (doing nothing if no socket is connected right now.)                                               // 420
  // It should be a JSON object (it will be stringified.)                                                              // 421
  send: function (msg) {                                                                                               // 422
    var self = this;                                                                                                   // 423
    if (self.socket) {                                                                                                 // 424
      if (Meteor._printSentDDP)                                                                                        // 425
        Meteor._debug("Sent DDP", stringifyDDP(msg));                                                                  // 426
      self.socket.send(stringifyDDP(msg));                                                                             // 427
    }                                                                                                                  // 428
  },                                                                                                                   // 429
                                                                                                                       // 430
  // Send a connection error.                                                                                          // 431
  sendError: function (reason, offendingMessage) {                                                                     // 432
    var self = this;                                                                                                   // 433
    var msg = {msg: 'error', reason: reason};                                                                          // 434
    if (offendingMessage)                                                                                              // 435
      msg.offendingMessage = offendingMessage;                                                                         // 436
    self.send(msg);                                                                                                    // 437
  },                                                                                                                   // 438
                                                                                                                       // 439
  // Process 'msg' as an incoming message. (But as a guard against                                                     // 440
  // race conditions during reconnection, ignore the message if                                                        // 441
  // 'socket' is not the currently connected socket.)                                                                  // 442
  //                                                                                                                   // 443
  // We run the messages from the client one at a time, in the order                                                   // 444
  // given by the client. The message handler is passed an idempotent                                                  // 445
  // function 'unblock' which it may call to allow other messages to                                                   // 446
  // begin running in parallel in another fiber (for example, a method                                                 // 447
  // that wants to yield.) Otherwise, it is automatically unblocked                                                    // 448
  // when it returns.                                                                                                  // 449
  //                                                                                                                   // 450
  // Actually, we don't have to 'totally order' the messages in this                                                   // 451
  // way, but it's the easiest thing that's correct. (unsub needs to                                                   // 452
  // be ordered against sub, methods need to be ordered against each                                                   // 453
  // other.)                                                                                                           // 454
  processMessage: function (msg_in) {                                                                                  // 455
    var self = this;                                                                                                   // 456
    if (!self.inQueue) // we have been destroyed.                                                                      // 457
      return;                                                                                                          // 458
                                                                                                                       // 459
    self.inQueue.push(msg_in);                                                                                         // 460
    if (self.workerRunning)                                                                                            // 461
      return;                                                                                                          // 462
    self.workerRunning = true;                                                                                         // 463
                                                                                                                       // 464
    var processNext = function () {                                                                                    // 465
      var msg = self.inQueue && self.inQueue.shift();                                                                  // 466
      if (!msg) {                                                                                                      // 467
        self.workerRunning = false;                                                                                    // 468
        return;                                                                                                        // 469
      }                                                                                                                // 470
                                                                                                                       // 471
      Fiber(function () {                                                                                              // 472
        var blocked = true;                                                                                            // 473
                                                                                                                       // 474
        var unblock = function () {                                                                                    // 475
          if (!blocked)                                                                                                // 476
            return; // idempotent                                                                                      // 477
          blocked = false;                                                                                             // 478
          processNext();                                                                                               // 479
        };                                                                                                             // 480
                                                                                                                       // 481
        if (_.has(self.protocol_handlers, msg.msg))                                                                    // 482
          self.protocol_handlers[msg.msg].call(self, msg, unblock);                                                    // 483
        else                                                                                                           // 484
          self.sendError('Bad request', msg);                                                                          // 485
        unblock(); // in case the handler didn't already do it                                                         // 486
      }).run();                                                                                                        // 487
    };                                                                                                                 // 488
                                                                                                                       // 489
    processNext();                                                                                                     // 490
  },                                                                                                                   // 491
                                                                                                                       // 492
  protocol_handlers: {                                                                                                 // 493
    sub: function (msg) {                                                                                              // 494
      var self = this;                                                                                                 // 495
                                                                                                                       // 496
      // reject malformed messages                                                                                     // 497
      if (typeof (msg.id) !== "string" ||                                                                              // 498
          typeof (msg.name) !== "string" ||                                                                            // 499
          (('params' in msg) && !(msg.params instanceof Array))) {                                                     // 500
        self.sendError("Malformed subscription", msg);                                                                 // 501
        return;                                                                                                        // 502
      }                                                                                                                // 503
                                                                                                                       // 504
      if (!self.server.publish_handlers[msg.name]) {                                                                   // 505
        self.send({                                                                                                    // 506
          msg: 'nosub', id: msg.id,                                                                                    // 507
          error: new Meteor.Error(404, "Subscription not found")});                                                    // 508
        return;                                                                                                        // 509
      }                                                                                                                // 510
                                                                                                                       // 511
      if (_.has(self._namedSubs, msg.id))                                                                              // 512
        // subs are idempotent, or rather, they are ignored if a sub                                                   // 513
        // with that id already exists. this is important during                                                       // 514
        // reconnect.                                                                                                  // 515
        return;                                                                                                        // 516
                                                                                                                       // 517
      var handler = self.server.publish_handlers[msg.name];                                                            // 518
      self._startSubscription(handler, msg.id, msg.params, msg.name);                                                  // 519
                                                                                                                       // 520
    },                                                                                                                 // 521
                                                                                                                       // 522
    unsub: function (msg) {                                                                                            // 523
      var self = this;                                                                                                 // 524
                                                                                                                       // 525
      self._stopSubscription(msg.id);                                                                                  // 526
    },                                                                                                                 // 527
                                                                                                                       // 528
    method: function (msg, unblock) {                                                                                  // 529
      var self = this;                                                                                                 // 530
                                                                                                                       // 531
      // reject malformed messages                                                                                     // 532
      // XXX should also reject messages with unknown attributes?                                                      // 533
      if (typeof (msg.id) !== "string" ||                                                                              // 534
          typeof (msg.method) !== "string" ||                                                                          // 535
          (('params' in msg) && !(msg.params instanceof Array))) {                                                     // 536
        self.sendError("Malformed method invocation", msg);                                                            // 537
        return;                                                                                                        // 538
      }                                                                                                                // 539
                                                                                                                       // 540
      // set up to mark the method as satisfied once all observers                                                     // 541
      // (and subscriptions) have reacted to any writes that were                                                      // 542
      // done.                                                                                                         // 543
      var fence = new DDPServer._WriteFence;                                                                           // 544
      fence.onAllCommitted(function () {                                                                               // 545
        // Retire the fence so that future writes are allowed.                                                         // 546
        // This means that callbacks like timers are free to use                                                       // 547
        // the fence, and if they fire before it's armed (for                                                          // 548
        // example, because the method waits for them) their                                                           // 549
        // writes will be included in the fence.                                                                       // 550
        fence.retire();                                                                                                // 551
        self.send({                                                                                                    // 552
          msg: 'updated', methods: [msg.id]});                                                                         // 553
      });                                                                                                              // 554
                                                                                                                       // 555
      // find the handler                                                                                              // 556
      var handler = self.server.method_handlers[msg.method];                                                           // 557
      if (!handler) {                                                                                                  // 558
        self.send({                                                                                                    // 559
          msg: 'result', id: msg.id,                                                                                   // 560
          error: new Meteor.Error(404, "Method not found")});                                                          // 561
        fence.arm();                                                                                                   // 562
        return;                                                                                                        // 563
      }                                                                                                                // 564
                                                                                                                       // 565
      var setUserId = function(userId) {                                                                               // 566
        self._setUserId(userId);                                                                                       // 567
      };                                                                                                               // 568
                                                                                                                       // 569
      var invocation = new MethodInvocation({                                                                          // 570
        isSimulation: false,                                                                                           // 571
        userId: self.userId,                                                                                           // 572
        setUserId: setUserId,                                                                                          // 573
        unblock: unblock,                                                                                              // 574
        connection: self.connectionHandle                                                                              // 575
      });                                                                                                              // 576
      try {                                                                                                            // 577
        var result = DDPServer._CurrentWriteFence.withValue(fence, function () {                                       // 578
          return DDP._CurrentInvocation.withValue(invocation, function () {                                            // 579
            return maybeAuditArgumentChecks(                                                                           // 580
              handler, invocation, msg.params, "call to '" + msg.method + "'");                                        // 581
          });                                                                                                          // 582
        });                                                                                                            // 583
      } catch (e) {                                                                                                    // 584
        var exception = e;                                                                                             // 585
      }                                                                                                                // 586
                                                                                                                       // 587
      fence.arm(); // we're done adding writes to the fence                                                            // 588
      unblock(); // unblock, if the method hasn't done it already                                                      // 589
                                                                                                                       // 590
      exception = wrapInternalException(                                                                               // 591
        exception, "while invoking method '" + msg.method + "'");                                                      // 592
                                                                                                                       // 593
      // send response and add to cache                                                                                // 594
      var payload =                                                                                                    // 595
        exception ? {error: exception} : (result !== undefined ?                                                       // 596
                                          {result: result} : {});                                                      // 597
      self.send(_.extend({msg: 'result', id: msg.id}, payload));                                                       // 598
    }                                                                                                                  // 599
  },                                                                                                                   // 600
                                                                                                                       // 601
  _eachSub: function (f) {                                                                                             // 602
    var self = this;                                                                                                   // 603
    _.each(self._namedSubs, f);                                                                                        // 604
    _.each(self._universalSubs, f);                                                                                    // 605
  },                                                                                                                   // 606
                                                                                                                       // 607
  _diffCollectionViews: function (beforeCVs) {                                                                         // 608
    var self = this;                                                                                                   // 609
    LocalCollection._diffObjects(beforeCVs, self.collectionViews, {                                                    // 610
      both: function (collectionName, leftValue, rightValue) {                                                         // 611
        rightValue.diff(leftValue);                                                                                    // 612
      },                                                                                                               // 613
      rightOnly: function (collectionName, rightValue) {                                                               // 614
        _.each(rightValue.documents, function (docView, id) {                                                          // 615
          self.sendAdded(collectionName, id, docView.getFields());                                                     // 616
        });                                                                                                            // 617
      },                                                                                                               // 618
      leftOnly: function (collectionName, leftValue) {                                                                 // 619
        _.each(leftValue.documents, function (doc, id) {                                                               // 620
          self.sendRemoved(collectionName, id);                                                                        // 621
        });                                                                                                            // 622
      }                                                                                                                // 623
    });                                                                                                                // 624
  },                                                                                                                   // 625
                                                                                                                       // 626
  // Sets the current user id in all appropriate contexts and reruns                                                   // 627
  // all subscriptions                                                                                                 // 628
  _setUserId: function(userId) {                                                                                       // 629
    var self = this;                                                                                                   // 630
                                                                                                                       // 631
    if (userId !== null && typeof userId !== "string")                                                                 // 632
      throw new Error("setUserId must be called on string or null, not " +                                             // 633
                      typeof userId);                                                                                  // 634
                                                                                                                       // 635
    // Prevent newly-created universal subscriptions from being added to our                                           // 636
    // session; they will be found below when we call startUniversalSubs.                                              // 637
    //                                                                                                                 // 638
    // (We don't have to worry about named subscriptions, because we only add                                          // 639
    // them when we process a 'sub' message. We are currently processing a                                             // 640
    // 'method' message, and the method did not unblock, because it is illegal                                         // 641
    // to call setUserId after unblock. Thus we cannot be concurrently adding a                                        // 642
    // new named subscription.)                                                                                        // 643
    self._dontStartNewUniversalSubs = true;                                                                            // 644
                                                                                                                       // 645
    // Prevent current subs from updating our collectionViews and call their                                           // 646
    // stop callbacks. This may yield.                                                                                 // 647
    self._eachSub(function (sub) {                                                                                     // 648
      sub._deactivate();                                                                                               // 649
    });                                                                                                                // 650
                                                                                                                       // 651
    // All subs should now be deactivated. Stop sending messages to the client,                                        // 652
    // save the state of the published collections, reset to an empty view, and                                        // 653
    // update the userId.                                                                                              // 654
    self._isSending = false;                                                                                           // 655
    var beforeCVs = self.collectionViews;                                                                              // 656
    self.collectionViews = {};                                                                                         // 657
    self.userId = userId;                                                                                              // 658
                                                                                                                       // 659
    // Save the old named subs, and reset to having no subscriptions.                                                  // 660
    var oldNamedSubs = self._namedSubs;                                                                                // 661
    self._namedSubs = {};                                                                                              // 662
    self._universalSubs = [];                                                                                          // 663
                                                                                                                       // 664
    _.each(oldNamedSubs, function (sub, subscriptionId) {                                                              // 665
      self._namedSubs[subscriptionId] = sub._recreate();                                                               // 666
      // nb: if the handler throws or calls this.error(), it will in fact                                              // 667
      // immediately send its 'nosub'. This is OK, though.                                                             // 668
      self._namedSubs[subscriptionId]._runHandler();                                                                   // 669
    });                                                                                                                // 670
                                                                                                                       // 671
    // Allow newly-created universal subs to be started on our connection in                                           // 672
    // parallel with the ones we're spinning up here, and spin up universal                                            // 673
    // subs.                                                                                                           // 674
    self._dontStartNewUniversalSubs = false;                                                                           // 675
    self.startUniversalSubs();                                                                                         // 676
                                                                                                                       // 677
    // Start sending messages again, beginning with the diff from the previous                                         // 678
    // state of the world to the current state. No yields are allowed during                                           // 679
    // this diff, so that other changes cannot interleave.                                                             // 680
    Meteor._noYieldsAllowed(function () {                                                                              // 681
      self._isSending = true;                                                                                          // 682
      self._diffCollectionViews(beforeCVs);                                                                            // 683
      if (!_.isEmpty(self._pendingReady)) {                                                                            // 684
        self.sendReady(self._pendingReady);                                                                            // 685
        self._pendingReady = [];                                                                                       // 686
      }                                                                                                                // 687
    });                                                                                                                // 688
  },                                                                                                                   // 689
                                                                                                                       // 690
  _startSubscription: function (handler, subId, params, name) {                                                        // 691
    var self = this;                                                                                                   // 692
                                                                                                                       // 693
    var sub = new Subscription(                                                                                        // 694
      self, handler, subId, params, name);                                                                             // 695
    if (subId)                                                                                                         // 696
      self._namedSubs[subId] = sub;                                                                                    // 697
    else                                                                                                               // 698
      self._universalSubs.push(sub);                                                                                   // 699
                                                                                                                       // 700
    sub._runHandler();                                                                                                 // 701
  },                                                                                                                   // 702
                                                                                                                       // 703
  // tear down specified subscription                                                                                  // 704
  _stopSubscription: function (subId, error) {                                                                         // 705
    var self = this;                                                                                                   // 706
                                                                                                                       // 707
    if (subId && self._namedSubs[subId]) {                                                                             // 708
      self._namedSubs[subId]._removeAllDocuments();                                                                    // 709
      self._namedSubs[subId]._deactivate();                                                                            // 710
      delete self._namedSubs[subId];                                                                                   // 711
    }                                                                                                                  // 712
                                                                                                                       // 713
    var response = {msg: 'nosub', id: subId};                                                                          // 714
                                                                                                                       // 715
    if (error)                                                                                                         // 716
      response.error = wrapInternalException(error, "from sub " + subId);                                              // 717
                                                                                                                       // 718
    self.send(response);                                                                                               // 719
  },                                                                                                                   // 720
                                                                                                                       // 721
  // tear down all subscriptions. Note that this does NOT send removed or nosub                                        // 722
  // messages, since we assume the client is gone.                                                                     // 723
  _deactivateAllSubscriptions: function () {                                                                           // 724
    var self = this;                                                                                                   // 725
                                                                                                                       // 726
    _.each(self._namedSubs, function (sub, id) {                                                                       // 727
      sub._deactivate();                                                                                               // 728
    });                                                                                                                // 729
    self._namedSubs = {};                                                                                              // 730
                                                                                                                       // 731
    _.each(self._universalSubs, function (sub) {                                                                       // 732
      sub._deactivate();                                                                                               // 733
    });                                                                                                                // 734
    self._universalSubs = [];                                                                                          // 735
  },                                                                                                                   // 736
                                                                                                                       // 737
  // Determine the remote client's IP address, based on the                                                            // 738
  // HTTP_FORWARDED_COUNT environment variable representing how many                                                   // 739
  // proxies the server is behind.                                                                                     // 740
  _clientAddress: function () {                                                                                        // 741
    var self = this;                                                                                                   // 742
                                                                                                                       // 743
    // For the reported client address for a connection to be correct,                                                 // 744
    // the developer must set the HTTP_FORWARDED_COUNT environment                                                     // 745
    // variable to an integer representing the number of hops they                                                     // 746
    // expect in the `x-forwarded-for` header. E.g., set to "1" if the                                                 // 747
    // server is behind one proxy.                                                                                     // 748
    //                                                                                                                 // 749
    // This could be computed once at startup instead of every time.                                                   // 750
    var httpForwardedCount = parseInt(process.env['HTTP_FORWARDED_COUNT']) || 0;                                       // 751
                                                                                                                       // 752
    if (httpForwardedCount === 0)                                                                                      // 753
      return self.socket.remoteAddress;                                                                                // 754
                                                                                                                       // 755
    var forwardedFor = self.socket.headers["x-forwarded-for"];                                                         // 756
    if (! _.isString(forwardedFor))                                                                                    // 757
      return null;                                                                                                     // 758
    forwardedFor = forwardedFor.trim().split(/\s*,\s*/);                                                               // 759
                                                                                                                       // 760
    // Typically the first value in the `x-forwarded-for` header is                                                    // 761
    // the original IP address of the client connecting to the first                                                   // 762
    // proxy.  However, the end user can easily spoof the header, in                                                   // 763
    // which case the first value(s) will be the fake IP address from                                                  // 764
    // the user pretending to be a proxy reporting the original IP                                                     // 765
    // address value.  By counting HTTP_FORWARDED_COUNT back from the                                                  // 766
    // end of the list, we ensure that we get the IP address being                                                     // 767
    // reported by *our* first proxy.                                                                                  // 768
                                                                                                                       // 769
    if (httpForwardedCount < 0 || httpForwardedCount > forwardedFor.length)                                            // 770
      return null;                                                                                                     // 771
                                                                                                                       // 772
    return forwardedFor[forwardedFor.length - httpForwardedCount];                                                     // 773
  }                                                                                                                    // 774
});                                                                                                                    // 775
                                                                                                                       // 776
/******************************************************************************/                                       // 777
/* Subscription                                                               */                                       // 778
/******************************************************************************/                                       // 779
                                                                                                                       // 780
// ctor for a sub handle: the input to each publish function                                                           // 781
var Subscription = function (                                                                                          // 782
    session, handler, subscriptionId, params, name) {                                                                  // 783
  var self = this;                                                                                                     // 784
  self._session = session; // type is Session                                                                          // 785
  self.connection = session.connectionHandle; // public API object                                                     // 786
                                                                                                                       // 787
  self._handler = handler;                                                                                             // 788
                                                                                                                       // 789
  // my subscription ID (generated by client, undefined for universal subs).                                           // 790
  self._subscriptionId = subscriptionId;                                                                               // 791
  // undefined for universal subs                                                                                      // 792
  self._name = name;                                                                                                   // 793
                                                                                                                       // 794
  self._params = params || [];                                                                                         // 795
                                                                                                                       // 796
  // Only named subscriptions have IDs, but we need some sort of string                                                // 797
  // internally to keep track of all subscriptions inside                                                              // 798
  // SessionDocumentViews. We use this subscriptionHandle for that.                                                    // 799
  if (self._subscriptionId) {                                                                                          // 800
    self._subscriptionHandle = 'N' + self._subscriptionId;                                                             // 801
  } else {                                                                                                             // 802
    self._subscriptionHandle = 'U' + Random.id();                                                                      // 803
  }                                                                                                                    // 804
                                                                                                                       // 805
  // has _deactivate been called?                                                                                      // 806
  self._deactivated = false;                                                                                           // 807
                                                                                                                       // 808
  // stop callbacks to g/c this sub.  called w/ zero arguments.                                                        // 809
  self._stopCallbacks = [];                                                                                            // 810
                                                                                                                       // 811
  // the set of (collection, documentid) that this subscription has                                                    // 812
  // an opinion about                                                                                                  // 813
  self._documents = {};                                                                                                // 814
                                                                                                                       // 815
  // remember if we are ready.                                                                                         // 816
  self._ready = false;                                                                                                 // 817
                                                                                                                       // 818
  // Part of the public API: the user of this sub.                                                                     // 819
  self.userId = session.userId;                                                                                        // 820
                                                                                                                       // 821
  // For now, the id filter is going to default to                                                                     // 822
  // the to/from DDP methods on LocalCollection, to                                                                    // 823
  // specifically deal with mongo/minimongo ObjectIds.                                                                 // 824
                                                                                                                       // 825
  // Later, you will be able to make this be "raw"                                                                     // 826
  // if you want to publish a collection that you know                                                                 // 827
  // just has strings for keys and no funny business, to                                                               // 828
  // a ddp consumer that isn't minimongo                                                                               // 829
                                                                                                                       // 830
  self._idFilter = {                                                                                                   // 831
    idStringify: LocalCollection._idStringify,                                                                         // 832
    idParse: LocalCollection._idParse                                                                                  // 833
  };                                                                                                                   // 834
                                                                                                                       // 835
  Package.facts && Package.facts.Facts.incrementServerFact(                                                            // 836
    "livedata", "subscriptions", 1);                                                                                   // 837
};                                                                                                                     // 838
                                                                                                                       // 839
_.extend(Subscription.prototype, {                                                                                     // 840
  _runHandler: function () {                                                                                           // 841
    var self = this;                                                                                                   // 842
    try {                                                                                                              // 843
      var res = maybeAuditArgumentChecks(                                                                              // 844
        self._handler, self, EJSON.clone(self._params),                                                                // 845
        "publisher '" + self._name + "'");                                                                             // 846
    } catch (e) {                                                                                                      // 847
      self.error(e);                                                                                                   // 848
      return;                                                                                                          // 849
    }                                                                                                                  // 850
                                                                                                                       // 851
    // Did the handler call this.error or this.stop?                                                                   // 852
    if (self._isDeactivated())                                                                                         // 853
      return;                                                                                                          // 854
                                                                                                                       // 855
    // SPECIAL CASE: Instead of writing their own callbacks that invoke                                                // 856
    // this.added/changed/ready/etc, the user can just return a collection                                             // 857
    // cursor or array of cursors from the publish function; we call their                                             // 858
    // _publishCursor method which starts observing the cursor and publishes the                                       // 859
    // results. Note that _publishCursor does NOT call ready().                                                        // 860
    //                                                                                                                 // 861
    // XXX This uses an undocumented interface which only the Mongo cursor                                             // 862
    // interface publishes. Should we make this interface public and encourage                                         // 863
    // users to implement it themselves? Arguably, it's unnecessary; users can                                         // 864
    // already write their own functions like                                                                          // 865
    //   var publishMyReactiveThingy = function (name, handler) {                                                      // 866
    //     Meteor.publish(name, function () {                                                                          // 867
    //       var reactiveThingy = handler();                                                                           // 868
    //       reactiveThingy.publishMe();                                                                               // 869
    //     });                                                                                                         // 870
    //   };                                                                                                            // 871
    var isCursor = function (c) {                                                                                      // 872
      return c && c._publishCursor;                                                                                    // 873
    };                                                                                                                 // 874
    if (isCursor(res)) {                                                                                               // 875
      res._publishCursor(self);                                                                                        // 876
      // _publishCursor only returns after the initial added callbacks have run.                                       // 877
      // mark subscription as ready.                                                                                   // 878
      self.ready();                                                                                                    // 879
    } else if (_.isArray(res)) {                                                                                       // 880
      // check all the elements are cursors                                                                            // 881
      if (! _.all(res, isCursor)) {                                                                                    // 882
        self.error(new Error("Publish function returned an array of non-Cursors"));                                    // 883
        return;                                                                                                        // 884
      }                                                                                                                // 885
      // find duplicate collection names                                                                               // 886
      // XXX we should support overlapping cursors, but that would require the                                         // 887
      // merge box to allow overlap within a subscription                                                              // 888
      var collectionNames = {};                                                                                        // 889
      for (var i = 0; i < res.length; ++i) {                                                                           // 890
        var collectionName = res[i]._getCollectionName();                                                              // 891
        if (_.has(collectionNames, collectionName)) {                                                                  // 892
          self.error(new Error(                                                                                        // 893
            "Publish function returned multiple cursors for collection " +                                             // 894
              collectionName));                                                                                        // 895
          return;                                                                                                      // 896
        }                                                                                                              // 897
        collectionNames[collectionName] = true;                                                                        // 898
      };                                                                                                               // 899
                                                                                                                       // 900
      _.each(res, function (cur) {                                                                                     // 901
        cur._publishCursor(self);                                                                                      // 902
      });                                                                                                              // 903
      self.ready();                                                                                                    // 904
    } else if (res) {                                                                                                  // 905
      // truthy values other than cursors or arrays are probably a                                                     // 906
      // user mistake (possible returning a Mongo document via, say,                                                   // 907
      // `coll.findOne()`).                                                                                            // 908
      self.error(new Error("Publish function can only return a Cursor or "                                             // 909
                           + "an array of Cursors"));                                                                  // 910
    }                                                                                                                  // 911
  },                                                                                                                   // 912
                                                                                                                       // 913
  // This calls all stop callbacks and prevents the handler from updating any                                          // 914
  // SessionCollectionViews further. It's used when the user unsubscribes or                                           // 915
  // disconnects, as well as during setUserId re-runs. It does *NOT* send                                              // 916
  // removed messages for the published objects; if that is necessary, call                                            // 917
  // _removeAllDocuments first.                                                                                        // 918
  _deactivate: function() {                                                                                            // 919
    var self = this;                                                                                                   // 920
    if (self._deactivated)                                                                                             // 921
      return;                                                                                                          // 922
    self._deactivated = true;                                                                                          // 923
    self._callStopCallbacks();                                                                                         // 924
    Package.facts && Package.facts.Facts.incrementServerFact(                                                          // 925
      "livedata", "subscriptions", -1);                                                                                // 926
  },                                                                                                                   // 927
                                                                                                                       // 928
  _callStopCallbacks: function () {                                                                                    // 929
    var self = this;                                                                                                   // 930
    // tell listeners, so they can clean up                                                                            // 931
    var callbacks = self._stopCallbacks;                                                                               // 932
    self._stopCallbacks = [];                                                                                          // 933
    _.each(callbacks, function (callback) {                                                                            // 934
      callback();                                                                                                      // 935
    });                                                                                                                // 936
  },                                                                                                                   // 937
                                                                                                                       // 938
  // Send remove messages for every document.                                                                          // 939
  _removeAllDocuments: function () {                                                                                   // 940
    var self = this;                                                                                                   // 941
    Meteor._noYieldsAllowed(function () {                                                                              // 942
      _.each(self._documents, function(collectionDocs, collectionName) {                                               // 943
        // Iterate over _.keys instead of the dictionary itself, since we'll be                                        // 944
        // mutating it.                                                                                                // 945
        _.each(_.keys(collectionDocs), function (strId) {                                                              // 946
          self.removed(collectionName, self._idFilter.idParse(strId));                                                 // 947
        });                                                                                                            // 948
      });                                                                                                              // 949
    });                                                                                                                // 950
  },                                                                                                                   // 951
                                                                                                                       // 952
  // Returns a new Subscription for the same session with the same                                                     // 953
  // initial creation parameters. This isn't a clone: it doesn't have                                                  // 954
  // the same _documents cache, stopped state or callbacks; may have a                                                 // 955
  // different _subscriptionHandle, and gets its userId from the                                                       // 956
  // session, not from this object.                                                                                    // 957
  _recreate: function () {                                                                                             // 958
    var self = this;                                                                                                   // 959
    return new Subscription(                                                                                           // 960
      self._session, self._handler, self._subscriptionId, self._params);                                               // 961
  },                                                                                                                   // 962
                                                                                                                       // 963
  error: function (error) {                                                                                            // 964
    var self = this;                                                                                                   // 965
    if (self._isDeactivated())                                                                                         // 966
      return;                                                                                                          // 967
    self._session._stopSubscription(self._subscriptionId, error);                                                      // 968
  },                                                                                                                   // 969
                                                                                                                       // 970
  // Note that while our DDP client will notice that you've called stop() on the                                       // 971
  // server (and clean up its _subscriptions table) we don't actually provide a                                        // 972
  // mechanism for an app to notice this (the subscribe onError callback only                                          // 973
  // triggers if there is an error).                                                                                   // 974
  stop: function () {                                                                                                  // 975
    var self = this;                                                                                                   // 976
    if (self._isDeactivated())                                                                                         // 977
      return;                                                                                                          // 978
    self._session._stopSubscription(self._subscriptionId);                                                             // 979
  },                                                                                                                   // 980
                                                                                                                       // 981
  onStop: function (callback) {                                                                                        // 982
    var self = this;                                                                                                   // 983
    if (self._isDeactivated())                                                                                         // 984
      callback();                                                                                                      // 985
    else                                                                                                               // 986
      self._stopCallbacks.push(callback);                                                                              // 987
  },                                                                                                                   // 988
                                                                                                                       // 989
  // This returns true if the sub has been deactivated, *OR* if the session was                                        // 990
  // destroyed but the deferred call to _deactivateAllSubscriptions hasn't                                             // 991
  // happened yet.                                                                                                     // 992
  _isDeactivated: function () {                                                                                        // 993
    var self = this;                                                                                                   // 994
    return self._deactivated || self._session.inQueue === null;                                                        // 995
  },                                                                                                                   // 996
                                                                                                                       // 997
  added: function (collectionName, id, fields) {                                                                       // 998
    var self = this;                                                                                                   // 999
    if (self._isDeactivated())                                                                                         // 1000
      return;                                                                                                          // 1001
    id = self._idFilter.idStringify(id);                                                                               // 1002
    Meteor._ensure(self._documents, collectionName)[id] = true;                                                        // 1003
    self._session.added(self._subscriptionHandle, collectionName, id, fields);                                         // 1004
  },                                                                                                                   // 1005
                                                                                                                       // 1006
  changed: function (collectionName, id, fields) {                                                                     // 1007
    var self = this;                                                                                                   // 1008
    if (self._isDeactivated())                                                                                         // 1009
      return;                                                                                                          // 1010
    id = self._idFilter.idStringify(id);                                                                               // 1011
    self._session.changed(self._subscriptionHandle, collectionName, id, fields);                                       // 1012
  },                                                                                                                   // 1013
                                                                                                                       // 1014
  removed: function (collectionName, id) {                                                                             // 1015
    var self = this;                                                                                                   // 1016
    if (self._isDeactivated())                                                                                         // 1017
      return;                                                                                                          // 1018
    id = self._idFilter.idStringify(id);                                                                               // 1019
    // We don't bother to delete sets of things in a collection if the                                                 // 1020
    // collection is empty.  It could break _removeAllDocuments.                                                       // 1021
    delete self._documents[collectionName][id];                                                                        // 1022
    self._session.removed(self._subscriptionHandle, collectionName, id);                                               // 1023
  },                                                                                                                   // 1024
                                                                                                                       // 1025
  ready: function () {                                                                                                 // 1026
    var self = this;                                                                                                   // 1027
    if (self._isDeactivated())                                                                                         // 1028
      return;                                                                                                          // 1029
    if (!self._subscriptionId)                                                                                         // 1030
      return;  // unnecessary but ignored for universal sub                                                            // 1031
    if (!self._ready) {                                                                                                // 1032
      self._session.sendReady([self._subscriptionId]);                                                                 // 1033
      self._ready = true;                                                                                              // 1034
    }                                                                                                                  // 1035
  }                                                                                                                    // 1036
});                                                                                                                    // 1037
                                                                                                                       // 1038
/******************************************************************************/                                       // 1039
/* Server                                                                     */                                       // 1040
/******************************************************************************/                                       // 1041
                                                                                                                       // 1042
Server = function () {                                                                                                 // 1043
  var self = this;                                                                                                     // 1044
                                                                                                                       // 1045
  // Map of callbacks to call when a new connection comes in to the                                                    // 1046
  // server and completes DDP version negotiation. Use an object instead                                               // 1047
  // of an array so we can safely remove one from the list while                                                       // 1048
  // iterating over it.                                                                                                // 1049
  self.connectionCallbacks = {};                                                                                       // 1050
  self.nextConnectionCallbackId = 0;                                                                                   // 1051
                                                                                                                       // 1052
  self.publish_handlers = {};                                                                                          // 1053
  self.universal_publish_handlers = [];                                                                                // 1054
                                                                                                                       // 1055
  self.method_handlers = {};                                                                                           // 1056
                                                                                                                       // 1057
  self.sessions = {}; // map from id to session                                                                        // 1058
                                                                                                                       // 1059
  self.stream_server = new StreamServer;                                                                               // 1060
                                                                                                                       // 1061
  self.stream_server.register(function (socket) {                                                                      // 1062
    // socket implements the SockJSConnection interface                                                                // 1063
    socket._meteorSession = null;                                                                                      // 1064
                                                                                                                       // 1065
    var sendError = function (reason, offendingMessage) {                                                              // 1066
      var msg = {msg: 'error', reason: reason};                                                                        // 1067
      if (offendingMessage)                                                                                            // 1068
        msg.offendingMessage = offendingMessage;                                                                       // 1069
      socket.send(stringifyDDP(msg));                                                                                  // 1070
    };                                                                                                                 // 1071
                                                                                                                       // 1072
    socket.on('data', function (raw_msg) {                                                                             // 1073
      if (Meteor._printReceivedDDP) {                                                                                  // 1074
        Meteor._debug("Received DDP", raw_msg);                                                                        // 1075
      }                                                                                                                // 1076
      try {                                                                                                            // 1077
        try {                                                                                                          // 1078
          var msg = parseDDP(raw_msg);                                                                                 // 1079
        } catch (err) {                                                                                                // 1080
          sendError('Parse error');                                                                                    // 1081
          return;                                                                                                      // 1082
        }                                                                                                              // 1083
        if (msg === null || !msg.msg) {                                                                                // 1084
          sendError('Bad request', msg);                                                                               // 1085
          return;                                                                                                      // 1086
        }                                                                                                              // 1087
                                                                                                                       // 1088
        if (msg.msg === 'connect') {                                                                                   // 1089
          if (socket._meteorSession) {                                                                                 // 1090
            sendError("Already connected", msg);                                                                       // 1091
            return;                                                                                                    // 1092
          }                                                                                                            // 1093
          self._handleConnect(socket, msg);                                                                            // 1094
          return;                                                                                                      // 1095
        }                                                                                                              // 1096
                                                                                                                       // 1097
        if (!socket._meteorSession) {                                                                                  // 1098
          sendError('Must connect first', msg);                                                                        // 1099
          return;                                                                                                      // 1100
        }                                                                                                              // 1101
        socket._meteorSession.processMessage(msg);                                                                     // 1102
      } catch (e) {                                                                                                    // 1103
        // XXX print stack nicely                                                                                      // 1104
        Meteor._debug("Internal exception while processing message", msg,                                              // 1105
                      e.message, e.stack);                                                                             // 1106
      }                                                                                                                // 1107
    });                                                                                                                // 1108
                                                                                                                       // 1109
    socket.on('close', function () {                                                                                   // 1110
      if (socket._meteorSession) {                                                                                     // 1111
        Fiber(function () {                                                                                            // 1112
          self._closeSession(socket._meteorSession);                                                                   // 1113
        }).run();                                                                                                      // 1114
      }                                                                                                                // 1115
    });                                                                                                                // 1116
  });                                                                                                                  // 1117
};                                                                                                                     // 1118
                                                                                                                       // 1119
_.extend(Server.prototype, {                                                                                           // 1120
                                                                                                                       // 1121
  onConnection: function (fn) {                                                                                        // 1122
    var self = this;                                                                                                   // 1123
                                                                                                                       // 1124
    fn = Meteor.bindEnvironment(fn, "onConnection callback");                                                          // 1125
                                                                                                                       // 1126
    var id = self.nextConnectionCallbackId++;                                                                          // 1127
    self.connectionCallbacks[id] = fn;                                                                                 // 1128
                                                                                                                       // 1129
    return {                                                                                                           // 1130
      stop: function () {                                                                                              // 1131
        delete self.connectionCallbacks[id];                                                                           // 1132
      }                                                                                                                // 1133
    };                                                                                                                 // 1134
  },                                                                                                                   // 1135
                                                                                                                       // 1136
  _handleConnect: function (socket, msg) {                                                                             // 1137
    var self = this;                                                                                                   // 1138
    // In the future, handle session resumption: something like:                                                       // 1139
    //  socket._meteorSession = self.sessions[msg.session]                                                             // 1140
    var version = calculateVersion(msg.support, SUPPORTED_DDP_VERSIONS);                                               // 1141
                                                                                                                       // 1142
    if (msg.version === version) {                                                                                     // 1143
      // Creating a new session                                                                                        // 1144
      socket._meteorSession = new Session(self, version, socket);                                                      // 1145
      self.sessions[socket._meteorSession.id] = socket._meteorSession;                                                 // 1146
      _.each(_.keys(self.connectionCallbacks), function (id) {                                                         // 1147
        if (_.has(self.connectionCallbacks, id) && socket._meteorSession) {                                            // 1148
          var callback = self.connectionCallbacks[id];                                                                 // 1149
          callback(socket._meteorSession.connectionHandle);                                                            // 1150
        }                                                                                                              // 1151
      });                                                                                                              // 1152
    } else if (!msg.version) {                                                                                         // 1153
      // connect message without a version. This means an old (pre-pre1)                                               // 1154
      // client is trying to connect. If we just disconnect the                                                        // 1155
      // connection, they'll retry right away. Instead, just pause for a                                               // 1156
      // bit (randomly distributed so as to avoid synchronized swarms)                                                 // 1157
      // and hold the connection open.                                                                                 // 1158
      var timeout = 1000 * (30 + Random.fraction() * 60);                                                              // 1159
      // drop all future data coming over this connection on the                                                       // 1160
      // floor. We don't want to confuse things.                                                                       // 1161
      socket.removeAllListeners('data');                                                                               // 1162
      setTimeout(function () {                                                                                         // 1163
        socket.send(stringifyDDP({msg: 'failed', version: version}));                                                  // 1164
        socket.close();                                                                                                // 1165
      }, timeout);                                                                                                     // 1166
    } else {                                                                                                           // 1167
      socket.send(stringifyDDP({msg: 'failed', version: version}));                                                    // 1168
      socket.close();                                                                                                  // 1169
    }                                                                                                                  // 1170
  },                                                                                                                   // 1171
  /**                                                                                                                  // 1172
   * Register a publish handler function.                                                                              // 1173
   *                                                                                                                   // 1174
   * @param name {String} identifier for query                                                                         // 1175
   * @param handler {Function} publish handler                                                                         // 1176
   * @param options {Object}                                                                                           // 1177
   *                                                                                                                   // 1178
   * Server will call handler function on each new subscription,                                                       // 1179
   * either when receiving DDP sub message for a named subscription, or on                                             // 1180
   * DDP connect for a universal subscription.                                                                         // 1181
   *                                                                                                                   // 1182
   * If name is null, this will be a subscription that is                                                              // 1183
   * automatically established and permanently on for all connected                                                    // 1184
   * client, instead of a subscription that can be turned on and off                                                   // 1185
   * with subscribe().                                                                                                 // 1186
   *                                                                                                                   // 1187
   * options to contain:                                                                                               // 1188
   *  - (mostly internal) is_auto: true if generated automatically                                                     // 1189
   *    from an autopublish hook. this is for cosmetic purposes only                                                   // 1190
   *    (it lets us determine whether to print a warning suggesting                                                    // 1191
   *    that you turn off autopublish.)                                                                                // 1192
   */                                                                                                                  // 1193
  publish: function (name, handler, options) {                                                                         // 1194
    var self = this;                                                                                                   // 1195
                                                                                                                       // 1196
    options = options || {};                                                                                           // 1197
                                                                                                                       // 1198
    if (name && name in self.publish_handlers) {                                                                       // 1199
      Meteor._debug("Ignoring duplicate publish named '" + name + "'");                                                // 1200
      return;                                                                                                          // 1201
    }                                                                                                                  // 1202
                                                                                                                       // 1203
    if (Package.autopublish && !options.is_auto) {                                                                     // 1204
      // They have autopublish on, yet they're trying to manually                                                      // 1205
      // picking stuff to publish. They probably should turn off                                                       // 1206
      // autopublish. (This check isn't perfect -- if you create a                                                     // 1207
      // publish before you turn on autopublish, it won't catch                                                        // 1208
      // it. But this will definitely handle the simple case where                                                     // 1209
      // you've added the autopublish package to your app, and are                                                     // 1210
      // calling publish from your app code.)                                                                          // 1211
      if (!self.warned_about_autopublish) {                                                                            // 1212
        self.warned_about_autopublish = true;                                                                          // 1213
        Meteor._debug(                                                                                                 // 1214
"** You've set up some data subscriptions with Meteor.publish(), but\n" +                                              // 1215
"** you still have autopublish turned on. Because autopublish is still\n" +                                            // 1216
"** on, your Meteor.publish() calls won't have much effect. All data\n" +                                              // 1217
"** will still be sent to all clients.\n" +                                                                            // 1218
"**\n" +                                                                                                               // 1219
"** Turn off autopublish by removing the autopublish package:\n" +                                                     // 1220
"**\n" +                                                                                                               // 1221
"**   $ meteor remove autopublish\n" +                                                                                 // 1222
"**\n" +                                                                                                               // 1223
"** .. and make sure you have Meteor.publish() and Meteor.subscribe() calls\n" +                                       // 1224
"** for each collection that you want clients to see.\n");                                                             // 1225
      }                                                                                                                // 1226
    }                                                                                                                  // 1227
                                                                                                                       // 1228
    if (name)                                                                                                          // 1229
      self.publish_handlers[name] = handler;                                                                           // 1230
    else {                                                                                                             // 1231
      self.universal_publish_handlers.push(handler);                                                                   // 1232
      // Spin up the new publisher on any existing session too. Run each                                               // 1233
      // session's subscription in a new Fiber, so that there's no change for                                          // 1234
      // self.sessions to change while we're running this loop.                                                        // 1235
      _.each(self.sessions, function (session) {                                                                       // 1236
        if (!session._dontStartNewUniversalSubs) {                                                                     // 1237
          Fiber(function() {                                                                                           // 1238
            session._startSubscription(handler);                                                                       // 1239
          }).run();                                                                                                    // 1240
        }                                                                                                              // 1241
      });                                                                                                              // 1242
    }                                                                                                                  // 1243
  },                                                                                                                   // 1244
                                                                                                                       // 1245
  _closeSession: function (session) {                                                                                  // 1246
    var self = this;                                                                                                   // 1247
    if (self.sessions[session.id]) {                                                                                   // 1248
      delete self.sessions[session.id];                                                                                // 1249
      session.destroy();                                                                                               // 1250
    }                                                                                                                  // 1251
  },                                                                                                                   // 1252
                                                                                                                       // 1253
  methods: function (methods) {                                                                                        // 1254
    var self = this;                                                                                                   // 1255
    _.each(methods, function (func, name) {                                                                            // 1256
      if (self.method_handlers[name])                                                                                  // 1257
        throw new Error("A method named '" + name + "' is already defined");                                           // 1258
      self.method_handlers[name] = func;                                                                               // 1259
    });                                                                                                                // 1260
  },                                                                                                                   // 1261
                                                                                                                       // 1262
  call: function (name /*, arguments */) {                                                                             // 1263
    // if it's a function, the last argument is the result callback,                                                   // 1264
    // not a parameter to the remote method.                                                                           // 1265
    var args = Array.prototype.slice.call(arguments, 1);                                                               // 1266
    if (args.length && typeof args[args.length - 1] === "function")                                                    // 1267
      var callback = args.pop();                                                                                       // 1268
    return this.apply(name, args, callback);                                                                           // 1269
  },                                                                                                                   // 1270
                                                                                                                       // 1271
  // @param options {Optional Object}                                                                                  // 1272
  // @param callback {Optional Function}                                                                               // 1273
  apply: function (name, args, options, callback) {                                                                    // 1274
    var self = this;                                                                                                   // 1275
                                                                                                                       // 1276
    // We were passed 3 arguments. They may be either (name, args, options)                                            // 1277
    // or (name, args, callback)                                                                                       // 1278
    if (!callback && typeof options === 'function') {                                                                  // 1279
      callback = options;                                                                                              // 1280
      options = {};                                                                                                    // 1281
    }                                                                                                                  // 1282
    options = options || {};                                                                                           // 1283
                                                                                                                       // 1284
    if (callback)                                                                                                      // 1285
      // It's not really necessary to do this, since we immediately                                                    // 1286
      // run the callback in this fiber before returning, but we do it                                                 // 1287
      // anyway for regularity.                                                                                        // 1288
      // XXX improve error message (and how we report it)                                                              // 1289
      callback = Meteor.bindEnvironment(                                                                               // 1290
        callback,                                                                                                      // 1291
        "delivering result of invoking '" + name + "'"                                                                 // 1292
      );                                                                                                               // 1293
                                                                                                                       // 1294
    // Run the handler                                                                                                 // 1295
    var handler = self.method_handlers[name];                                                                          // 1296
    var exception;                                                                                                     // 1297
    if (!handler) {                                                                                                    // 1298
      exception = new Meteor.Error(404, "Method not found");                                                           // 1299
    } else {                                                                                                           // 1300
      // If this is a method call from within another method, get the                                                  // 1301
      // user state from the outer method, otherwise don't allow                                                       // 1302
      // setUserId to be called                                                                                        // 1303
      var userId = null;                                                                                               // 1304
      var setUserId = function() {                                                                                     // 1305
        throw new Error("Can't call setUserId on a server initiated method call");                                     // 1306
      };                                                                                                               // 1307
      var connection = null;                                                                                           // 1308
      var currentInvocation = DDP._CurrentInvocation.get();                                                            // 1309
      if (currentInvocation) {                                                                                         // 1310
        userId = currentInvocation.userId;                                                                             // 1311
        setUserId = function(userId) {                                                                                 // 1312
          currentInvocation.setUserId(userId);                                                                         // 1313
        };                                                                                                             // 1314
        connection = currentInvocation.connection;                                                                     // 1315
      }                                                                                                                // 1316
                                                                                                                       // 1317
      var invocation = new MethodInvocation({                                                                          // 1318
        isSimulation: false,                                                                                           // 1319
        userId: userId,                                                                                                // 1320
        setUserId: setUserId,                                                                                          // 1321
        connection: connection                                                                                         // 1322
      });                                                                                                              // 1323
      try {                                                                                                            // 1324
        var result = DDP._CurrentInvocation.withValue(invocation, function () {                                        // 1325
          return maybeAuditArgumentChecks(                                                                             // 1326
            handler, invocation, args, "internal call to '" + name + "'");                                             // 1327
        });                                                                                                            // 1328
      } catch (e) {                                                                                                    // 1329
        exception = e;                                                                                                 // 1330
      }                                                                                                                // 1331
    }                                                                                                                  // 1332
                                                                                                                       // 1333
    // Return the result in whichever way the caller asked for it. Note that we                                        // 1334
    // do NOT block on the write fence in an analogous way to how the client                                           // 1335
    // blocks on the relevant data being visible, so you are NOT guaranteed that                                       // 1336
    // cursor observe callbacks have fired when your callback is invoked. (We                                          // 1337
    // can change this if there's a real use case.)                                                                    // 1338
    if (callback) {                                                                                                    // 1339
      callback(exception, result);                                                                                     // 1340
      return undefined;                                                                                                // 1341
    }                                                                                                                  // 1342
    if (exception)                                                                                                     // 1343
      throw exception;                                                                                                 // 1344
    return result;                                                                                                     // 1345
  },                                                                                                                   // 1346
                                                                                                                       // 1347
  _urlForSession: function (sessionId) {                                                                               // 1348
    var self = this;                                                                                                   // 1349
    var session = self.sessions[sessionId];                                                                            // 1350
    if (session)                                                                                                       // 1351
      return session._socketUrl;                                                                                       // 1352
    else                                                                                                               // 1353
      return null;                                                                                                     // 1354
  }                                                                                                                    // 1355
});                                                                                                                    // 1356
                                                                                                                       // 1357
var calculateVersion = function (clientSupportedVersions,                                                              // 1358
                                 serverSupportedVersions) {                                                            // 1359
  var correctVersion = _.find(clientSupportedVersions, function (version) {                                            // 1360
    return _.contains(serverSupportedVersions, version);                                                               // 1361
  });                                                                                                                  // 1362
  if (!correctVersion) {                                                                                               // 1363
    correctVersion = serverSupportedVersions[0];                                                                       // 1364
  }                                                                                                                    // 1365
  return correctVersion;                                                                                               // 1366
};                                                                                                                     // 1367
                                                                                                                       // 1368
LivedataTest.calculateVersion = calculateVersion;                                                                      // 1369
                                                                                                                       // 1370
                                                                                                                       // 1371
// "blind" exceptions other than those that were deliberately thrown to signal                                         // 1372
// errors to the client                                                                                                // 1373
var wrapInternalException = function (exception, context) {                                                            // 1374
  if (!exception || exception instanceof Meteor.Error)                                                                 // 1375
    return exception;                                                                                                  // 1376
                                                                                                                       // 1377
  // Did the error contain more details that could have been useful if caught in                                       // 1378
  // server code (or if thrown from non-client-originated code), but also                                              // 1379
  // provided a "sanitized" version with more context than 500 Internal server                                         // 1380
  // error? Use that.                                                                                                  // 1381
  if (exception.sanitizedError) {                                                                                      // 1382
    if (exception.sanitizedError instanceof Meteor.Error)                                                              // 1383
      return exception.sanitizedError;                                                                                 // 1384
    Meteor._debug("Exception " + context + " provides a sanitizedError that " +                                        // 1385
                  "is not a Meteor.Error; ignoring");                                                                  // 1386
  }                                                                                                                    // 1387
                                                                                                                       // 1388
  // tests can set the 'expected' flag on an exception so it won't go to the                                           // 1389
  // server log                                                                                                        // 1390
  if (!exception.expected)                                                                                             // 1391
    Meteor._debug("Exception " + context, exception.stack);                                                            // 1392
                                                                                                                       // 1393
  return new Meteor.Error(500, "Internal server error");                                                               // 1394
};                                                                                                                     // 1395
                                                                                                                       // 1396
                                                                                                                       // 1397
// Audit argument checks, if the audit-argument-checks package exists (it is a                                         // 1398
// weak dependency of this package).                                                                                   // 1399
var maybeAuditArgumentChecks = function (f, context, args, description) {                                              // 1400
  args = args || [];                                                                                                   // 1401
  if (Package['audit-argument-checks']) {                                                                              // 1402
    return Match._failIfArgumentsAreNotAllChecked(                                                                     // 1403
      f, context, args, description);                                                                                  // 1404
  }                                                                                                                    // 1405
  return f.apply(context, args);                                                                                       // 1406
};                                                                                                                     // 1407
                                                                                                                       // 1408
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/livedata/writefence.js                                                                                     //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
var path = Npm.require('path');                                                                                        // 1
var Future = Npm.require(path.join('fibers', 'future'));                                                               // 2
                                                                                                                       // 3
// A write fence collects a group of writes, and provides a callback                                                   // 4
// when all of the writes are fully committed and propagated (all                                                      // 5
// observers have been notified of the write and acknowledged it.)                                                     // 6
//                                                                                                                     // 7
DDPServer._WriteFence = function () {                                                                                  // 8
  var self = this;                                                                                                     // 9
                                                                                                                       // 10
  self.armed = false;                                                                                                  // 11
  self.fired = false;                                                                                                  // 12
  self.retired = false;                                                                                                // 13
  self.outstanding_writes = 0;                                                                                         // 14
  self.completion_callbacks = [];                                                                                      // 15
};                                                                                                                     // 16
                                                                                                                       // 17
// The current write fence. When there is a current write fence, code                                                  // 18
// that writes to databases should register their writes with it using                                                 // 19
// beginWrite().                                                                                                       // 20
//                                                                                                                     // 21
DDPServer._CurrentWriteFence = new Meteor.EnvironmentVariable;                                                         // 22
                                                                                                                       // 23
_.extend(DDPServer._WriteFence.prototype, {                                                                            // 24
  // Start tracking a write, and return an object to represent it. The                                                 // 25
  // object has a single method, committed(). This method should be                                                    // 26
  // called when the write is fully committed and propagated. You can                                                  // 27
  // continue to add writes to the WriteFence up until it is triggered                                                 // 28
  // (calls its callbacks because all writes have committed.)                                                          // 29
  beginWrite: function () {                                                                                            // 30
    var self = this;                                                                                                   // 31
                                                                                                                       // 32
    if (self.retired)                                                                                                  // 33
      return { committed: function () {} };                                                                            // 34
                                                                                                                       // 35
    if (self.fired)                                                                                                    // 36
      throw new Error("fence has already activated -- too late to add writes");                                        // 37
                                                                                                                       // 38
    self.outstanding_writes++;                                                                                         // 39
    var committed = false;                                                                                             // 40
    return {                                                                                                           // 41
      committed: function () {                                                                                         // 42
        if (committed)                                                                                                 // 43
          throw new Error("committed called twice on the same write");                                                 // 44
        committed = true;                                                                                              // 45
        self.outstanding_writes--;                                                                                     // 46
        self._maybeFire();                                                                                             // 47
      }                                                                                                                // 48
    };                                                                                                                 // 49
  },                                                                                                                   // 50
                                                                                                                       // 51
  // Arm the fence. Once the fence is armed, and there are no more                                                     // 52
  // uncommitted writes, it will activate.                                                                             // 53
  arm: function () {                                                                                                   // 54
    var self = this;                                                                                                   // 55
    if (self === DDPServer._CurrentWriteFence.get())                                                                   // 56
      throw Error("Can't arm the current fence");                                                                      // 57
    self.armed = true;                                                                                                 // 58
    self._maybeFire();                                                                                                 // 59
  },                                                                                                                   // 60
                                                                                                                       // 61
  // Register a function to be called when the fence fires.                                                            // 62
  onAllCommitted: function (func) {                                                                                    // 63
    var self = this;                                                                                                   // 64
    if (self.fired)                                                                                                    // 65
      throw new Error("fence has already activated -- too late to " +                                                  // 66
                      "add a callback");                                                                               // 67
    self.completion_callbacks.push(func);                                                                              // 68
  },                                                                                                                   // 69
                                                                                                                       // 70
  // Convenience function. Arms the fence, then blocks until it fires.                                                 // 71
  armAndWait: function () {                                                                                            // 72
    var self = this;                                                                                                   // 73
    var future = new Future;                                                                                           // 74
    self.onAllCommitted(function () {                                                                                  // 75
      future['return']();                                                                                              // 76
    });                                                                                                                // 77
    self.arm();                                                                                                        // 78
    future.wait();                                                                                                     // 79
  },                                                                                                                   // 80
                                                                                                                       // 81
  _maybeFire: function () {                                                                                            // 82
    var self = this;                                                                                                   // 83
    if (self.fired)                                                                                                    // 84
      throw new Error("write fence already activated?");                                                               // 85
    if (self.armed && !self.outstanding_writes) {                                                                      // 86
      self.fired = true;                                                                                               // 87
      _.each(self.completion_callbacks, function (f) {f(self);});                                                      // 88
      self.completion_callbacks = [];                                                                                  // 89
    }                                                                                                                  // 90
  },                                                                                                                   // 91
                                                                                                                       // 92
  // Deactivate this fence so that adding more writes has no effect.                                                   // 93
  // The fence must have already fired.                                                                                // 94
  retire: function () {                                                                                                // 95
    var self = this;                                                                                                   // 96
    if (! self.fired)                                                                                                  // 97
      throw new Error("Can't retire a fence that hasn't fired.");                                                      // 98
    self.retired = true;                                                                                               // 99
  }                                                                                                                    // 100
});                                                                                                                    // 101
                                                                                                                       // 102
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/livedata/crossbar.js                                                                                       //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
// A "crossbar" is a class that provides structured notification registration.                                         // 1
                                                                                                                       // 2
DDPServer._Crossbar = function (options) {                                                                             // 3
  var self = this;                                                                                                     // 4
  options = options || {};                                                                                             // 5
                                                                                                                       // 6
  self.nextId = 1;                                                                                                     // 7
  // map from listener id to object. each object has keys 'trigger',                                                   // 8
  // 'callback'.                                                                                                       // 9
  self.listeners = {};                                                                                                 // 10
  self.factPackage = options.factPackage || "livedata";                                                                // 11
  self.factName = options.factName || null;                                                                            // 12
};                                                                                                                     // 13
                                                                                                                       // 14
_.extend(DDPServer._Crossbar.prototype, {                                                                              // 15
  // Listen for notification that match 'trigger'. A notification                                                      // 16
  // matches if it has the key-value pairs in trigger as a                                                             // 17
  // subset. When a notification matches, call 'callback', passing                                                     // 18
  // the actual notification.                                                                                          // 19
  //                                                                                                                   // 20
  // Returns a listen handle, which is an object with a method                                                         // 21
  // stop(). Call stop() to stop listening.                                                                            // 22
  //                                                                                                                   // 23
  // XXX It should be legal to call fire() from inside a listen()                                                      // 24
  // callback?                                                                                                         // 25
  listen: function (trigger, callback) {                                                                               // 26
    var self = this;                                                                                                   // 27
    var id = self.nextId++;                                                                                            // 28
    self.listeners[id] = {trigger: EJSON.clone(trigger), callback: callback};                                          // 29
    if (self.factName && Package.facts) {                                                                              // 30
      Package.facts.Facts.incrementServerFact(                                                                         // 31
        self.factPackage, self.factName, 1);                                                                           // 32
    }                                                                                                                  // 33
    return {                                                                                                           // 34
      stop: function () {                                                                                              // 35
        if (self.factName && Package.facts) {                                                                          // 36
          Package.facts.Facts.incrementServerFact(                                                                     // 37
            self.factPackage, self.factName, -1);                                                                      // 38
        }                                                                                                              // 39
        delete self.listeners[id];                                                                                     // 40
      }                                                                                                                // 41
    };                                                                                                                 // 42
  },                                                                                                                   // 43
                                                                                                                       // 44
  // Fire the provided 'notification' (an object whose attribute                                                       // 45
  // values are all JSON-compatibile) -- inform all matching listeners                                                 // 46
  // (registered with listen()).                                                                                       // 47
  //                                                                                                                   // 48
  // If fire() is called inside a write fence, then each of the                                                        // 49
  // listener callbacks will be called inside the write fence as well.                                                 // 50
  //                                                                                                                   // 51
  // The listeners may be invoked in parallel, rather than serially.                                                   // 52
  fire: function (notification) {                                                                                      // 53
    var self = this;                                                                                                   // 54
    // Listener callbacks can yield, so we need to first find all the ones that                                        // 55
    // match in a single iteration over self.listeners (which can't be mutated                                         // 56
    // during this iteration), and then invoke the matching callbacks, checking                                        // 57
    // before each call to ensure they are still in self.listeners.                                                    // 58
    var matchingCallbacks = {};                                                                                        // 59
    // XXX consider refactoring to "index" on "collection"                                                             // 60
    _.each(self.listeners, function (l, id) {                                                                          // 61
      if (self._matches(notification, l.trigger))                                                                      // 62
        matchingCallbacks[id] = l.callback;                                                                            // 63
    });                                                                                                                // 64
                                                                                                                       // 65
    _.each(matchingCallbacks, function (c, id) {                                                                       // 66
      if (_.has(self.listeners, id))                                                                                   // 67
        c(notification);                                                                                               // 68
    });                                                                                                                // 69
  },                                                                                                                   // 70
                                                                                                                       // 71
  // A notification matches a trigger if all keys that exist in both are equal.                                        // 72
  //                                                                                                                   // 73
  // Examples:                                                                                                         // 74
  //  N:{collection: "C"} matches T:{collection: "C"}                                                                  // 75
  //    (a non-targeted write to a collection matches a                                                                // 76
  //     non-targeted query)                                                                                           // 77
  //  N:{collection: "C", id: "X"} matches T:{collection: "C"}                                                         // 78
  //    (a targeted write to a collection matches a non-targeted query)                                                // 79
  //  N:{collection: "C"} matches T:{collection: "C", id: "X"}                                                         // 80
  //    (a non-targeted write to a collection matches a                                                                // 81
  //     targeted query)                                                                                               // 82
  //  N:{collection: "C", id: "X"} matches T:{collection: "C", id: "X"}                                                // 83
  //    (a targeted write to a collection matches a targeted query targeted                                            // 84
  //     at the same document)                                                                                         // 85
  //  N:{collection: "C", id: "X"} does not match T:{collection: "C", id: "Y"}                                         // 86
  //    (a targeted write to a collection does not match a targeted query                                              // 87
  //     targeted at a different document)                                                                             // 88
  _matches: function (notification, trigger) {                                                                         // 89
    return _.all(trigger, function (triggerValue, key) {                                                               // 90
      return !_.has(notification, key) ||                                                                              // 91
        EJSON.equals(triggerValue, notification[key]);                                                                 // 92
    });                                                                                                                // 93
  }                                                                                                                    // 94
});                                                                                                                    // 95
                                                                                                                       // 96
// The "invalidation crossbar" is a specific instance used by the DDP server to                                        // 97
// implement write fence notifications. Listener callbacks on this crossbar                                            // 98
// should call beginWrite on the current write fence before they return, if they                                       // 99
// want to delay the write fence from firing (ie, the DDP method-data-updated                                          // 100
// message from being sent).                                                                                           // 101
DDPServer._InvalidationCrossbar = new DDPServer._Crossbar({                                                            // 102
  factName: "invalidation-crossbar-listeners"                                                                          // 103
});                                                                                                                    // 104
                                                                                                                       // 105
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/livedata/livedata_common.js                                                                                //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
DDP = {};                                                                                                              // 1
                                                                                                                       // 2
SUPPORTED_DDP_VERSIONS = [ 'pre1' ];                                                                                   // 3
                                                                                                                       // 4
LivedataTest.SUPPORTED_DDP_VERSIONS = SUPPORTED_DDP_VERSIONS;                                                          // 5
                                                                                                                       // 6
MethodInvocation = function (options) {                                                                                // 7
  var self = this;                                                                                                     // 8
                                                                                                                       // 9
  // true if we're running not the actual method, but a stub (that is,                                                 // 10
  // if we're on a client (which may be a browser, or in the future a                                                  // 11
  // server connecting to another server) and presently running a                                                      // 12
  // simulation of a server-side method for latency compensation                                                       // 13
  // purposes). not currently true except in a client such as a browser,                                               // 14
  // since there's usually no point in running stubs unless you have a                                                 // 15
  // zero-latency connection to the user.                                                                              // 16
  this.isSimulation = options.isSimulation;                                                                            // 17
                                                                                                                       // 18
  // call this function to allow other method invocations (from the                                                    // 19
  // same client) to continue running without waiting for this one to                                                  // 20
  // complete.                                                                                                         // 21
  this._unblock = options.unblock || function () {};                                                                   // 22
  this._calledUnblock = false;                                                                                         // 23
                                                                                                                       // 24
  // current user id                                                                                                   // 25
  this.userId = options.userId;                                                                                        // 26
                                                                                                                       // 27
  // sets current user id in all appropriate server contexts and                                                       // 28
  // reruns subscriptions                                                                                              // 29
  this._setUserId = options.setUserId || function () {};                                                               // 30
                                                                                                                       // 31
  // On the server, the connection this method call came in on.                                                        // 32
  this.connection = options.connection;                                                                                // 33
};                                                                                                                     // 34
                                                                                                                       // 35
_.extend(MethodInvocation.prototype, {                                                                                 // 36
  unblock: function () {                                                                                               // 37
    var self = this;                                                                                                   // 38
    self._calledUnblock = true;                                                                                        // 39
    self._unblock();                                                                                                   // 40
  },                                                                                                                   // 41
  setUserId: function(userId) {                                                                                        // 42
    var self = this;                                                                                                   // 43
    if (self._calledUnblock)                                                                                           // 44
      throw new Error("Can't call setUserId in a method after calling unblock");                                       // 45
    self.userId = userId;                                                                                              // 46
    self._setUserId(userId);                                                                                           // 47
  }                                                                                                                    // 48
});                                                                                                                    // 49
                                                                                                                       // 50
parseDDP = function (stringMessage) {                                                                                  // 51
  try {                                                                                                                // 52
    var msg = JSON.parse(stringMessage);                                                                               // 53
  } catch (e) {                                                                                                        // 54
    Meteor._debug("Discarding message with invalid JSON", stringMessage);                                              // 55
    return null;                                                                                                       // 56
  }                                                                                                                    // 57
  // DDP messages must be objects.                                                                                     // 58
  if (msg === null || typeof msg !== 'object') {                                                                       // 59
    Meteor._debug("Discarding non-object DDP message", stringMessage);                                                 // 60
    return null;                                                                                                       // 61
  }                                                                                                                    // 62
                                                                                                                       // 63
  // massage msg to get it into "abstract ddp" rather than "wire ddp" format.                                          // 64
                                                                                                                       // 65
  // switch between "cleared" rep of unsetting fields and "undefined"                                                  // 66
  // rep of same                                                                                                       // 67
  if (_.has(msg, 'cleared')) {                                                                                         // 68
    if (!_.has(msg, 'fields'))                                                                                         // 69
      msg.fields = {};                                                                                                 // 70
    _.each(msg.cleared, function (clearKey) {                                                                          // 71
      msg.fields[clearKey] = undefined;                                                                                // 72
    });                                                                                                                // 73
    delete msg.cleared;                                                                                                // 74
  }                                                                                                                    // 75
                                                                                                                       // 76
  _.each(['fields', 'params', 'result'], function (field) {                                                            // 77
    if (_.has(msg, field))                                                                                             // 78
      msg[field] = EJSON._adjustTypesFromJSONValue(msg[field]);                                                        // 79
  });                                                                                                                  // 80
                                                                                                                       // 81
  return msg;                                                                                                          // 82
};                                                                                                                     // 83
                                                                                                                       // 84
stringifyDDP = function (msg) {                                                                                        // 85
  var copy = EJSON.clone(msg);                                                                                         // 86
  // swizzle 'changed' messages from 'fields undefined' rep to 'fields                                                 // 87
  // and cleared' rep                                                                                                  // 88
  if (_.has(msg, 'fields')) {                                                                                          // 89
    var cleared = [];                                                                                                  // 90
    _.each(msg.fields, function (value, key) {                                                                         // 91
      if (value === undefined) {                                                                                       // 92
        cleared.push(key);                                                                                             // 93
        delete copy.fields[key];                                                                                       // 94
      }                                                                                                                // 95
    });                                                                                                                // 96
    if (!_.isEmpty(cleared))                                                                                           // 97
      copy.cleared = cleared;                                                                                          // 98
    if (_.isEmpty(copy.fields))                                                                                        // 99
      delete copy.fields;                                                                                              // 100
  }                                                                                                                    // 101
  // adjust types to basic                                                                                             // 102
  _.each(['fields', 'params', 'result'], function (field) {                                                            // 103
    if (_.has(copy, field))                                                                                            // 104
      copy[field] = EJSON._adjustTypesToJSONValue(copy[field]);                                                        // 105
  });                                                                                                                  // 106
  if (msg.id && typeof msg.id !== 'string') {                                                                          // 107
    throw new Error("Message id is not a string");                                                                     // 108
  }                                                                                                                    // 109
  return JSON.stringify(copy);                                                                                         // 110
};                                                                                                                     // 111
                                                                                                                       // 112
// This is private but it's used in a few places. accounts-base uses                                                   // 113
// it to get the current user. accounts-password uses it to stash SRP                                                  // 114
// state in the DDP session. Meteor.setTimeout and friends clear                                                       // 115
// it. We can probably find a better way to factor this.                                                               // 116
DDP._CurrentInvocation = new Meteor.EnvironmentVariable;                                                               // 117
                                                                                                                       // 118
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/livedata/livedata_connection.js                                                                            //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
if (Meteor.isServer) {                                                                                                 // 1
  var path = Npm.require('path');                                                                                      // 2
  var Fiber = Npm.require('fibers');                                                                                   // 3
  var Future = Npm.require(path.join('fibers', 'future'));                                                             // 4
}                                                                                                                      // 5
                                                                                                                       // 6
// @param url {String|Object} URL to Meteor app,                                                                       // 7
//   or an object as a test hook (see code)                                                                            // 8
// Options:                                                                                                            // 9
//   reloadWithOutstanding: is it OK to reload if there are outstanding methods?                                       // 10
//   headers: extra headers to send on the websockets connection, for                                                  // 11
//     server-to-server DDP only                                                                                       // 12
//   _sockjsOptions: Specifies options to pass through to the sockjs client                                            // 13
//   onDDPNegotiationVersionFailure: callback when version negotiation fails.                                          // 14
//                                                                                                                     // 15
// XXX There should be a way to destroy a DDP connection, causing all                                                  // 16
// outstanding method calls to fail.                                                                                   // 17
//                                                                                                                     // 18
// XXX Our current way of handling failure and reconnection is great                                                   // 19
// for an app (where we want to tolerate being disconnected as an                                                      // 20
// expect state, and keep trying forever to reconnect) but cumbersome                                                  // 21
// for something like a command line tool that wants to make a                                                         // 22
// connection, call a method, and print an error if connection                                                         // 23
// fails. We should have better usability in the latter case (while                                                    // 24
// still transparently reconnecting if it's just a transient failure                                                   // 25
// or the server migrating us).                                                                                        // 26
var Connection = function (url, options) {                                                                             // 27
  var self = this;                                                                                                     // 28
  options = _.extend({                                                                                                 // 29
    onConnected: function () {},                                                                                       // 30
    onDDPVersionNegotiationFailure: function (description) {                                                           // 31
      Meteor._debug(description);                                                                                      // 32
    },                                                                                                                 // 33
    // These options are only for testing.                                                                             // 34
    reloadWithOutstanding: false,                                                                                      // 35
    supportedDDPVersions: SUPPORTED_DDP_VERSIONS,                                                                      // 36
    retry: true                                                                                                        // 37
  }, options);                                                                                                         // 38
                                                                                                                       // 39
  // If set, called when we reconnect, queuing method calls _before_ the                                               // 40
  // existing outstanding ones. This is the only data member that is part of the                                       // 41
  // public API!                                                                                                       // 42
  self.onReconnect = null;                                                                                             // 43
                                                                                                                       // 44
  // as a test hook, allow passing a stream instead of a url.                                                          // 45
  if (typeof url === "object") {                                                                                       // 46
    self._stream = url;                                                                                                // 47
  } else {                                                                                                             // 48
    self._stream = new LivedataTest.ClientStream(url, {                                                                // 49
      retry: options.retry,                                                                                            // 50
      headers: options.headers,                                                                                        // 51
      _sockjsOptions: options._sockjsOptions                                                                           // 52
    });                                                                                                                // 53
  }                                                                                                                    // 54
                                                                                                                       // 55
  self._lastSessionId = null;                                                                                          // 56
  self._versionSuggestion = null;  // The last proposed DDP version.                                                   // 57
  self._version = null;   // The DDP version agreed on by client and server.                                           // 58
  self._stores = {}; // name -> object with methods                                                                    // 59
  self._methodHandlers = {}; // name -> func                                                                           // 60
  self._nextMethodId = 1;                                                                                              // 61
  self._supportedDDPVersions = options.supportedDDPVersions;                                                           // 62
                                                                                                                       // 63
  // Tracks methods which the user has tried to call but which have not yet                                            // 64
  // called their user callback (ie, they are waiting on their result or for all                                       // 65
  // of their writes to be written to the local cache). Map from method ID to                                          // 66
  // MethodInvoker object.                                                                                             // 67
  self._methodInvokers = {};                                                                                           // 68
                                                                                                                       // 69
  // Tracks methods which the user has called but whose result messages have not                                       // 70
  // arrived yet.                                                                                                      // 71
  //                                                                                                                   // 72
  // _outstandingMethodBlocks is an array of blocks of methods. Each block                                             // 73
  // represents a set of methods that can run at the same time. The first block                                        // 74
  // represents the methods which are currently in flight; subsequent blocks                                           // 75
  // must wait for previous blocks to be fully finished before they can be sent                                        // 76
  // to the server.                                                                                                    // 77
  //                                                                                                                   // 78
  // Each block is an object with the following fields:                                                                // 79
  // - methods: a list of MethodInvoker objects                                                                        // 80
  // - wait: a boolean; if true, this block had a single method invoked with                                           // 81
  //         the "wait" option                                                                                         // 82
  //                                                                                                                   // 83
  // There will never be adjacent blocks with wait=false, because the only thing                                       // 84
  // that makes methods need to be serialized is a wait method.                                                        // 85
  //                                                                                                                   // 86
  // Methods are removed from the first block when their "result" is                                                   // 87
  // received. The entire first block is only removed when all of the in-flight                                        // 88
  // methods have received their results (so the "methods" list is empty) *AND*                                        // 89
  // all of the data written by those methods are visible in the local cache. So                                       // 90
  // it is possible for the first block's methods list to be empty, if we are                                          // 91
  // still waiting for some objects to quiesce.                                                                        // 92
  //                                                                                                                   // 93
  // Example:                                                                                                          // 94
  //  _outstandingMethodBlocks = [                                                                                     // 95
  //    {wait: false, methods: []},                                                                                    // 96
  //    {wait: true, methods: [<MethodInvoker for 'login'>]},                                                          // 97
  //    {wait: false, methods: [<MethodInvoker for 'foo'>,                                                             // 98
  //                            <MethodInvoker for 'bar'>]}]                                                           // 99
  // This means that there were some methods which were sent to the server and                                         // 100
  // which have returned their results, but some of the data written by                                                // 101
  // the methods may not be visible in the local cache. Once all that data is                                          // 102
  // visible, we will send a 'login' method. Once the login method has returned                                        // 103
  // and all the data is visible (including re-running subs if userId changes),                                        // 104
  // we will send the 'foo' and 'bar' methods in parallel.                                                             // 105
  self._outstandingMethodBlocks = [];                                                                                  // 106
                                                                                                                       // 107
  // method ID -> array of objects with keys 'collection' and 'id', listing                                            // 108
  // documents written by a given method's stub. keys are associated with                                              // 109
  // methods whose stub wrote at least one document, and whose data-done message                                       // 110
  // has not yet been received.                                                                                        // 111
  self._documentsWrittenByStub = {};                                                                                   // 112
  // collection -> IdMap of "server document" object. A "server document" has:                                         // 113
  // - "document": the version of the document according the                                                           // 114
  //   server (ie, the snapshot before a stub wrote it, amended by any changes                                         // 115
  //   received from the server)                                                                                       // 116
  //   It is undefined if we think the document does not exist                                                         // 117
  // - "writtenByStubs": a set of method IDs whose stubs wrote to the document                                         // 118
  //   whose "data done" messages have not yet been processed                                                          // 119
  self._serverDocuments = {};                                                                                          // 120
                                                                                                                       // 121
  // Array of callbacks to be called after the next update of the local                                                // 122
  // cache. Used for:                                                                                                  // 123
  //  - Calling methodInvoker.dataVisible and sub ready callbacks after                                                // 124
  //    the relevant data is flushed.                                                                                  // 125
  //  - Invoking the callbacks of "half-finished" methods after reconnect                                              // 126
  //    quiescence. Specifically, methods whose result was received over the old                                       // 127
  //    connection (so we don't re-send it) but whose data had not been made                                           // 128
  //    visible.                                                                                                       // 129
  self._afterUpdateCallbacks = [];                                                                                     // 130
                                                                                                                       // 131
  // In two contexts, we buffer all incoming data messages and then process them                                       // 132
  // all at once in a single update:                                                                                   // 133
  //   - During reconnect, we buffer all data messages until all subs that had                                         // 134
  //     been ready before reconnect are ready again, and all methods that are                                         // 135
  //     active have returned their "data done message"; then                                                          // 136
  //   - During the execution of a "wait" method, we buffer all data messages                                          // 137
  //     until the wait method gets its "data done" message. (If the wait method                                       // 138
  //     occurs during reconnect, it doesn't get any special handling.)                                                // 139
  // all data messages are processed in one update.                                                                    // 140
  //                                                                                                                   // 141
  // The following fields are used for this "quiescence" process.                                                      // 142
                                                                                                                       // 143
  // This buffers the messages that aren't being processed yet.                                                        // 144
  self._messagesBufferedUntilQuiescence = [];                                                                          // 145
  // Map from method ID -> true. Methods are removed from this when their                                              // 146
  // "data done" message is received, and we will not quiesce until it is                                              // 147
  // empty.                                                                                                            // 148
  self._methodsBlockingQuiescence = {};                                                                                // 149
  // map from sub ID -> true for subs that were ready (ie, called the sub                                              // 150
  // ready callback) before reconnect but haven't become ready again yet                                               // 151
  self._subsBeingRevived = {}; // map from sub._id -> true                                                             // 152
  // if true, the next data update should reset all stores. (set during                                                // 153
  // reconnect.)                                                                                                       // 154
  self._resetStores = false;                                                                                           // 155
                                                                                                                       // 156
  // name -> array of updates for (yet to be created) collections                                                      // 157
  self._updatesForUnknownStores = {};                                                                                  // 158
  // if we're blocking a migration, the retry func                                                                     // 159
  self._retryMigrate = null;                                                                                           // 160
                                                                                                                       // 161
  // metadata for subscriptions.  Map from sub ID to object with keys:                                                 // 162
  //   - id                                                                                                            // 163
  //   - name                                                                                                          // 164
  //   - params                                                                                                        // 165
  //   - inactive (if true, will be cleaned up if not reused in re-run)                                                // 166
  //   - ready (has the 'ready' message been received?)                                                                // 167
  //   - readyCallback (an optional callback to call when ready)                                                       // 168
  //   - errorCallback (an optional callback to call if the sub terminates with                                        // 169
  //                    an error)                                                                                      // 170
  self._subscriptions = {};                                                                                            // 171
                                                                                                                       // 172
  // Reactive userId.                                                                                                  // 173
  self._userId = null;                                                                                                 // 174
  self._userIdDeps = (typeof Deps !== "undefined") && new Deps.Dependency;                                             // 175
                                                                                                                       // 176
  // Block auto-reload while we're waiting for method responses.                                                       // 177
  if (Meteor.isClient && Package.reload && !options.reloadWithOutstanding) {                                           // 178
    Package.reload.Reload._onMigrate(function (retry) {                                                                // 179
      if (!self._readyToMigrate()) {                                                                                   // 180
        if (self._retryMigrate)                                                                                        // 181
          throw new Error("Two migrations in progress?");                                                              // 182
        self._retryMigrate = retry;                                                                                    // 183
        return false;                                                                                                  // 184
      } else {                                                                                                         // 185
        return [true];                                                                                                 // 186
      }                                                                                                                // 187
    });                                                                                                                // 188
  }                                                                                                                    // 189
                                                                                                                       // 190
  var onMessage = function (raw_msg) {                                                                                 // 191
    try {                                                                                                              // 192
      var msg = parseDDP(raw_msg);                                                                                     // 193
    } catch (e) {                                                                                                      // 194
      Meteor._debug("Exception while parsing DDP", e);                                                                 // 195
      return;                                                                                                          // 196
    }                                                                                                                  // 197
                                                                                                                       // 198
    if (msg === null || !msg.msg) {                                                                                    // 199
      // XXX COMPAT WITH 0.6.6. ignore the old welcome message for back                                                // 200
      // compat.  Remove this 'if' once the server stops sending welcome                                               // 201
      // messages (stream_server.js).                                                                                  // 202
      if (! (msg && msg.server_id))                                                                                    // 203
        Meteor._debug("discarding invalid livedata message", msg);                                                     // 204
      return;                                                                                                          // 205
    }                                                                                                                  // 206
                                                                                                                       // 207
    if (msg.msg === 'connected') {                                                                                     // 208
      self._version = self._versionSuggestion;                                                                         // 209
      options.onConnected();                                                                                           // 210
      self._livedata_connected(msg);                                                                                   // 211
    }                                                                                                                  // 212
    else if (msg.msg == 'failed') {                                                                                    // 213
      if (_.contains(self._supportedDDPVersions, msg.version)) {                                                       // 214
        self._versionSuggestion = msg.version;                                                                         // 215
        self._stream.reconnect({_force: true});                                                                        // 216
      } else {                                                                                                         // 217
        var description =                                                                                              // 218
              "DDP version negotiation failed; server requested version " + msg.version;                               // 219
        self._stream.disconnect({_permanent: true, _error: description});                                              // 220
        options.onDDPVersionNegotiationFailure(description);                                                           // 221
      }                                                                                                                // 222
    }                                                                                                                  // 223
    else if (_.include(['added', 'changed', 'removed', 'ready', 'updated'], msg.msg))                                  // 224
      self._livedata_data(msg);                                                                                        // 225
    else if (msg.msg === 'nosub')                                                                                      // 226
      self._livedata_nosub(msg);                                                                                       // 227
    else if (msg.msg === 'result')                                                                                     // 228
      self._livedata_result(msg);                                                                                      // 229
    else if (msg.msg === 'error')                                                                                      // 230
      self._livedata_error(msg);                                                                                       // 231
    else                                                                                                               // 232
      Meteor._debug("discarding unknown livedata message type", msg);                                                  // 233
  };                                                                                                                   // 234
                                                                                                                       // 235
  var onReset = function () {                                                                                          // 236
    // Send a connect message at the beginning of the stream.                                                          // 237
    // NOTE: reset is called even on the first connection, so this is                                                  // 238
    // the only place we send this message.                                                                            // 239
    var msg = {msg: 'connect'};                                                                                        // 240
    if (self._lastSessionId)                                                                                           // 241
      msg.session = self._lastSessionId;                                                                               // 242
    msg.version = self._versionSuggestion || self._supportedDDPVersions[0];                                            // 243
    self._versionSuggestion = msg.version;                                                                             // 244
    msg.support = self._supportedDDPVersions;                                                                          // 245
    self._send(msg);                                                                                                   // 246
                                                                                                                       // 247
    // Now, to minimize setup latency, go ahead and blast out all of                                                   // 248
    // our pending methods ands subscriptions before we've even taken                                                  // 249
    // the necessary RTT to know if we successfully reconnected. (1)                                                   // 250
    // They're supposed to be idempotent; (2) even if we did                                                           // 251
    // reconnect, we're not sure what messages might have gotten lost                                                  // 252
    // (in either direction) since we were disconnected (TCP being                                                     // 253
    // sloppy about that.)                                                                                             // 254
                                                                                                                       // 255
    // If the current block of methods all got their results (but didn't all get                                       // 256
    // their data visible), discard the empty block now.                                                               // 257
    if (! _.isEmpty(self._outstandingMethodBlocks) &&                                                                  // 258
        _.isEmpty(self._outstandingMethodBlocks[0].methods)) {                                                         // 259
      self._outstandingMethodBlocks.shift();                                                                           // 260
    }                                                                                                                  // 261
                                                                                                                       // 262
    // Mark all messages as unsent, they have not yet been sent on this                                                // 263
    // connection.                                                                                                     // 264
    _.each(self._methodInvokers, function (m) {                                                                        // 265
      m.sentMessage = false;                                                                                           // 266
    });                                                                                                                // 267
                                                                                                                       // 268
    // If an `onReconnect` handler is set, call it first. Go through                                                   // 269
    // some hoops to ensure that methods that are called from within                                                   // 270
    // `onReconnect` get executed _before_ ones that were originally                                                   // 271
    // outstanding (since `onReconnect` is used to re-establish auth                                                   // 272
    // certificates)                                                                                                   // 273
    if (self.onReconnect)                                                                                              // 274
      self._callOnReconnectAndSendAppropriateOutstandingMethods();                                                     // 275
    else                                                                                                               // 276
      self._sendOutstandingMethods();                                                                                  // 277
                                                                                                                       // 278
    // add new subscriptions at the end. this way they take effect after                                               // 279
    // the handlers and we don't see flicker.                                                                          // 280
    _.each(self._subscriptions, function (sub, id) {                                                                   // 281
      self._send({                                                                                                     // 282
        msg: 'sub',                                                                                                    // 283
        id: id,                                                                                                        // 284
        name: sub.name,                                                                                                // 285
        params: sub.params                                                                                             // 286
      });                                                                                                              // 287
    });                                                                                                                // 288
  };                                                                                                                   // 289
                                                                                                                       // 290
  if (Meteor.isServer) {                                                                                               // 291
    self._stream.on('message', Meteor.bindEnvironment(onMessage, Meteor._debug));                                      // 292
    self._stream.on('reset', Meteor.bindEnvironment(onReset, Meteor._debug));                                          // 293
  } else {                                                                                                             // 294
    self._stream.on('message', onMessage);                                                                             // 295
    self._stream.on('reset', onReset);                                                                                 // 296
  }                                                                                                                    // 297
};                                                                                                                     // 298
                                                                                                                       // 299
// A MethodInvoker manages sending a method to the server and calling the user's                                       // 300
// callbacks. On construction, it registers itself in the connection's                                                 // 301
// _methodInvokers map; it removes itself once the method is fully finished and                                        // 302
// the callback is invoked. This occurs when it has both received a result,                                            // 303
// and the data written by it is fully visible.                                                                        // 304
var MethodInvoker = function (options) {                                                                               // 305
  var self = this;                                                                                                     // 306
                                                                                                                       // 307
  // Public (within this file) fields.                                                                                 // 308
  self.methodId = options.methodId;                                                                                    // 309
  self.sentMessage = false;                                                                                            // 310
                                                                                                                       // 311
  self._callback = options.callback;                                                                                   // 312
  self._connection = options.connection;                                                                               // 313
  self._message = options.message;                                                                                     // 314
  self._onResultReceived = options.onResultReceived || function () {};                                                 // 315
  self._wait = options.wait;                                                                                           // 316
  self._methodResult = null;                                                                                           // 317
  self._dataVisible = false;                                                                                           // 318
                                                                                                                       // 319
  // Register with the connection.                                                                                     // 320
  self._connection._methodInvokers[self.methodId] = self;                                                              // 321
};                                                                                                                     // 322
_.extend(MethodInvoker.prototype, {                                                                                    // 323
  // Sends the method message to the server. May be called additional times if                                         // 324
  // we lose the connection and reconnect before receiving a result.                                                   // 325
  sendMessage: function () {                                                                                           // 326
    var self = this;                                                                                                   // 327
    // This function is called before sending a method (including resending on                                         // 328
    // reconnect). We should only (re)send methods where we don't already have a                                       // 329
    // result!                                                                                                         // 330
    if (self.gotResult())                                                                                              // 331
      throw new Error("sendingMethod is called on method with result");                                                // 332
                                                                                                                       // 333
    // If we're re-sending it, it doesn't matter if data was written the first                                         // 334
    // time.                                                                                                           // 335
    self._dataVisible = false;                                                                                         // 336
                                                                                                                       // 337
    self.sentMessage = true;                                                                                           // 338
                                                                                                                       // 339
    // If this is a wait method, make all data messages be buffered until it is                                        // 340
    // done.                                                                                                           // 341
    if (self._wait)                                                                                                    // 342
      self._connection._methodsBlockingQuiescence[self.methodId] = true;                                               // 343
                                                                                                                       // 344
    // Actually send the message.                                                                                      // 345
    self._connection._send(self._message);                                                                             // 346
  },                                                                                                                   // 347
  // Invoke the callback, if we have both a result and know that all data has                                          // 348
  // been written to the local cache.                                                                                  // 349
  _maybeInvokeCallback: function () {                                                                                  // 350
    var self = this;                                                                                                   // 351
    if (self._methodResult && self._dataVisible) {                                                                     // 352
      // Call the callback. (This won't throw: the callback was wrapped with                                           // 353
      // bindEnvironment.)                                                                                             // 354
      self._callback(self._methodResult[0], self._methodResult[1]);                                                    // 355
                                                                                                                       // 356
      // Forget about this method.                                                                                     // 357
      delete self._connection._methodInvokers[self.methodId];                                                          // 358
                                                                                                                       // 359
      // Let the connection know that this method is finished, so it can try to                                        // 360
      // move on to the next block of methods.                                                                         // 361
      self._connection._outstandingMethodFinished();                                                                   // 362
    }                                                                                                                  // 363
  },                                                                                                                   // 364
  // Call with the result of the method from the server. Only may be called                                            // 365
  // once; once it is called, you should not call sendMessage again.                                                   // 366
  // If the user provided an onResultReceived callback, call it immediately.                                           // 367
  // Then invoke the main callback if data is also visible.                                                            // 368
  receiveResult: function (err, result) {                                                                              // 369
    var self = this;                                                                                                   // 370
    if (self.gotResult())                                                                                              // 371
      throw new Error("Methods should only receive results once");                                                     // 372
    self._methodResult = [err, result];                                                                                // 373
    self._onResultReceived(err, result);                                                                               // 374
    self._maybeInvokeCallback();                                                                                       // 375
  },                                                                                                                   // 376
  // Call this when all data written by the method is visible. This means that                                         // 377
  // the method has returns its "data is done" message *AND* all server                                                // 378
  // documents that are buffered at that time have been written to the local                                           // 379
  // cache. Invokes the main callback if the result has been received.                                                 // 380
  dataVisible: function () {                                                                                           // 381
    var self = this;                                                                                                   // 382
    self._dataVisible = true;                                                                                          // 383
    self._maybeInvokeCallback();                                                                                       // 384
  },                                                                                                                   // 385
  // True if receiveResult has been called.                                                                            // 386
  gotResult: function () {                                                                                             // 387
    var self = this;                                                                                                   // 388
    return !!self._methodResult;                                                                                       // 389
  }                                                                                                                    // 390
});                                                                                                                    // 391
                                                                                                                       // 392
_.extend(Connection.prototype, {                                                                                       // 393
  // 'name' is the name of the data on the wire that should go in the                                                  // 394
  // store. 'wrappedStore' should be an object with methods beginUpdate, update,                                       // 395
  // endUpdate, saveOriginals, retrieveOriginals. see Collection for an example.                                       // 396
  registerStore: function (name, wrappedStore) {                                                                       // 397
    var self = this;                                                                                                   // 398
                                                                                                                       // 399
    if (name in self._stores)                                                                                          // 400
      return false;                                                                                                    // 401
                                                                                                                       // 402
    // Wrap the input object in an object which makes any store method not                                             // 403
    // implemented by 'store' into a no-op.                                                                            // 404
    var store = {};                                                                                                    // 405
    _.each(['update', 'beginUpdate', 'endUpdate', 'saveOriginals',                                                     // 406
            'retrieveOriginals'], function (method) {                                                                  // 407
              store[method] = function () {                                                                            // 408
                return (wrappedStore[method]                                                                           // 409
                        ? wrappedStore[method].apply(wrappedStore, arguments)                                          // 410
                        : undefined);                                                                                  // 411
              };                                                                                                       // 412
            });                                                                                                        // 413
                                                                                                                       // 414
    self._stores[name] = store;                                                                                        // 415
                                                                                                                       // 416
    var queued = self._updatesForUnknownStores[name];                                                                  // 417
    if (queued) {                                                                                                      // 418
      store.beginUpdate(queued.length, false);                                                                         // 419
      _.each(queued, function (msg) {                                                                                  // 420
        store.update(msg);                                                                                             // 421
      });                                                                                                              // 422
      store.endUpdate();                                                                                               // 423
      delete self._updatesForUnknownStores[name];                                                                      // 424
    }                                                                                                                  // 425
                                                                                                                       // 426
    return true;                                                                                                       // 427
  },                                                                                                                   // 428
                                                                                                                       // 429
  subscribe: function (name /* .. [arguments] .. (callback|callbacks) */) {                                            // 430
    var self = this;                                                                                                   // 431
                                                                                                                       // 432
    var params = Array.prototype.slice.call(arguments, 1);                                                             // 433
    var callbacks = {};                                                                                                // 434
    if (params.length) {                                                                                               // 435
      var lastParam = params[params.length - 1];                                                                       // 436
      if (typeof lastParam === "function") {                                                                           // 437
        callbacks.onReady = params.pop();                                                                              // 438
      } else if (lastParam && (typeof lastParam.onReady === "function" ||                                              // 439
                               typeof lastParam.onError === "function")) {                                             // 440
        callbacks = params.pop();                                                                                      // 441
      }                                                                                                                // 442
    }                                                                                                                  // 443
                                                                                                                       // 444
    // Is there an existing sub with the same name and param, run in an                                                // 445
    // invalidated Computation? This will happen if we are rerunning an                                                // 446
    // existing computation.                                                                                           // 447
    //                                                                                                                 // 448
    // For example, consider a rerun of:                                                                               // 449
    //                                                                                                                 // 450
    //     Deps.autorun(function () {                                                                                  // 451
    //       Meteor.subscribe("foo", Session.get("foo"));                                                              // 452
    //       Meteor.subscribe("bar", Session.get("bar"));                                                              // 453
    //     });                                                                                                         // 454
    //                                                                                                                 // 455
    // If "foo" has changed but "bar" has not, we will match the "bar"                                                 // 456
    // subcribe to an existing inactive subscription in order to not                                                   // 457
    // unsub and resub the subscription unnecessarily.                                                                 // 458
    //                                                                                                                 // 459
    // We only look for one such sub; if there are N apparently-identical subs                                         // 460
    // being invalidated, we will require N matching subscribe calls to keep                                           // 461
    // them all active.                                                                                                // 462
    var existing = _.find(self._subscriptions, function (sub) {                                                        // 463
      return sub.inactive && sub.name === name &&                                                                      // 464
        EJSON.equals(sub.params, params);                                                                              // 465
    });                                                                                                                // 466
                                                                                                                       // 467
    var id;                                                                                                            // 468
    if (existing) {                                                                                                    // 469
      id = existing.id;                                                                                                // 470
      existing.inactive = false; // reactivate                                                                         // 471
                                                                                                                       // 472
      if (callbacks.onReady) {                                                                                         // 473
        // If the sub is not already ready, replace any ready callback with the                                        // 474
        // one provided now. (It's not really clear what users would expect for                                        // 475
        // an onReady callback inside an autorun; the semantics we provide is                                          // 476
        // that at the time the sub first becomes ready, we call the last                                              // 477
        // onReady callback provided, if any.)                                                                         // 478
        if (!existing.ready)                                                                                           // 479
          existing.readyCallback = callbacks.onReady;                                                                  // 480
      }                                                                                                                // 481
      if (callbacks.onError) {                                                                                         // 482
        // Replace existing callback if any, so that errors aren't                                                     // 483
        // double-reported.                                                                                            // 484
        existing.errorCallback = callbacks.onError;                                                                    // 485
      }                                                                                                                // 486
    } else {                                                                                                           // 487
      // New sub! Generate an id, save it locally, and send message.                                                   // 488
      id = Random.id();                                                                                                // 489
      self._subscriptions[id] = {                                                                                      // 490
        id: id,                                                                                                        // 491
        name: name,                                                                                                    // 492
        params: params,                                                                                                // 493
        inactive: false,                                                                                               // 494
        ready: false,                                                                                                  // 495
        readyDeps: (typeof Deps !== "undefined") && new Deps.Dependency,                                               // 496
        readyCallback: callbacks.onReady,                                                                              // 497
        errorCallback: callbacks.onError                                                                               // 498
      };                                                                                                               // 499
      self._send({msg: 'sub', id: id, name: name, params: params});                                                    // 500
    }                                                                                                                  // 501
                                                                                                                       // 502
    // return a handle to the application.                                                                             // 503
    var handle = {                                                                                                     // 504
      stop: function () {                                                                                              // 505
        if (!_.has(self._subscriptions, id))                                                                           // 506
          return;                                                                                                      // 507
        self._send({msg: 'unsub', id: id});                                                                            // 508
        delete self._subscriptions[id];                                                                                // 509
      },                                                                                                               // 510
      ready: function () {                                                                                             // 511
        // return false if we've unsubscribed.                                                                         // 512
        if (!_.has(self._subscriptions, id))                                                                           // 513
          return false;                                                                                                // 514
        var record = self._subscriptions[id];                                                                          // 515
        record.readyDeps && record.readyDeps.depend();                                                                 // 516
        return record.ready;                                                                                           // 517
      }                                                                                                                // 518
    };                                                                                                                 // 519
                                                                                                                       // 520
    if (Deps.active) {                                                                                                 // 521
      // We're in a reactive computation, so we'd like to unsubscribe when the                                         // 522
      // computation is invalidated... but not if the rerun just re-subscribes                                         // 523
      // to the same subscription!  When a rerun happens, we use onInvalidate                                          // 524
      // as a change to mark the subscription "inactive" so that it can                                                // 525
      // be reused from the rerun.  If it isn't reused, it's killed from                                               // 526
      // an afterFlush.                                                                                                // 527
      Deps.onInvalidate(function (c) {                                                                                 // 528
        if (_.has(self._subscriptions, id))                                                                            // 529
          self._subscriptions[id].inactive = true;                                                                     // 530
                                                                                                                       // 531
        Deps.afterFlush(function () {                                                                                  // 532
          if (_.has(self._subscriptions, id) &&                                                                        // 533
              self._subscriptions[id].inactive)                                                                        // 534
            handle.stop();                                                                                             // 535
        });                                                                                                            // 536
      });                                                                                                              // 537
    }                                                                                                                  // 538
                                                                                                                       // 539
    return handle;                                                                                                     // 540
  },                                                                                                                   // 541
                                                                                                                       // 542
  // options:                                                                                                          // 543
  // - onLateError {Function(error)} called if an error was received after the ready event.                            // 544
  //     (errors received before ready cause an error to be thrown)                                                    // 545
  _subscribeAndWait: function (name, args, options) {                                                                  // 546
    var self = this;                                                                                                   // 547
    var f = new Future();                                                                                              // 548
    var ready = false;                                                                                                 // 549
    var handle;                                                                                                        // 550
    args = args || [];                                                                                                 // 551
    args.push({                                                                                                        // 552
      onReady: function () {                                                                                           // 553
        ready = true;                                                                                                  // 554
        f['return']();                                                                                                 // 555
      },                                                                                                               // 556
      onError: function (e) {                                                                                          // 557
        if (!ready)                                                                                                    // 558
          f['throw'](e);                                                                                               // 559
        else                                                                                                           // 560
          options && options.onLateError && options.onLateError(e);                                                    // 561
      }                                                                                                                // 562
    });                                                                                                                // 563
                                                                                                                       // 564
    handle = self.subscribe.apply(self, [name].concat(args));                                                          // 565
    f.wait();                                                                                                          // 566
    return handle;                                                                                                     // 567
  },                                                                                                                   // 568
                                                                                                                       // 569
  methods: function (methods) {                                                                                        // 570
    var self = this;                                                                                                   // 571
    _.each(methods, function (func, name) {                                                                            // 572
      if (self._methodHandlers[name])                                                                                  // 573
        throw new Error("A method named '" + name + "' is already defined");                                           // 574
      self._methodHandlers[name] = func;                                                                               // 575
    });                                                                                                                // 576
  },                                                                                                                   // 577
                                                                                                                       // 578
  call: function (name /* .. [arguments] .. callback */) {                                                             // 579
    // if it's a function, the last argument is the result callback,                                                   // 580
    // not a parameter to the remote method.                                                                           // 581
    var args = Array.prototype.slice.call(arguments, 1);                                                               // 582
    if (args.length && typeof args[args.length - 1] === "function")                                                    // 583
      var callback = args.pop();                                                                                       // 584
    return this.apply(name, args, callback);                                                                           // 585
  },                                                                                                                   // 586
                                                                                                                       // 587
  // @param options {Optional Object}                                                                                  // 588
  //   wait: Boolean - Should we wait to call this until all current methods                                           // 589
  //                   are fully finished, and block subsequent method calls                                           // 590
  //                   until this method is fully finished?                                                            // 591
  //                   (does not affect methods called from within this method)                                        // 592
  //   onResultReceived: Function - a callback to call as soon as the method                                           // 593
  //                                result is received. the data written by                                            // 594
  //                                the method may not yet be in the cache!                                            // 595
  // @param callback {Optional Function}                                                                               // 596
  apply: function (name, args, options, callback) {                                                                    // 597
    var self = this;                                                                                                   // 598
                                                                                                                       // 599
    // We were passed 3 arguments. They may be either (name, args, options)                                            // 600
    // or (name, args, callback)                                                                                       // 601
    if (!callback && typeof options === 'function') {                                                                  // 602
      callback = options;                                                                                              // 603
      options = {};                                                                                                    // 604
    }                                                                                                                  // 605
    options = options || {};                                                                                           // 606
                                                                                                                       // 607
    if (callback) {                                                                                                    // 608
      // XXX would it be better form to do the binding in stream.on,                                                   // 609
      // or caller, instead of here?                                                                                   // 610
      // XXX improve error message (and how we report it)                                                              // 611
      callback = Meteor.bindEnvironment(                                                                               // 612
        callback,                                                                                                      // 613
        "delivering result of invoking '" + name + "'"                                                                 // 614
      );                                                                                                               // 615
    }                                                                                                                  // 616
                                                                                                                       // 617
    // Lazily allocate method ID once we know that it'll be needed.                                                    // 618
    var methodId = (function () {                                                                                      // 619
      var id;                                                                                                          // 620
      return function () {                                                                                             // 621
        if (id === undefined)                                                                                          // 622
          id = '' + (self._nextMethodId++);                                                                            // 623
        return id;                                                                                                     // 624
      };                                                                                                               // 625
    })();                                                                                                              // 626
                                                                                                                       // 627
    // Run the stub, if we have one. The stub is supposed to make some                                                 // 628
    // temporary writes to the database to give the user a smooth experience                                           // 629
    // until the actual result of executing the method comes back from the                                             // 630
    // server (whereupon the temporary writes to the database will be reversed                                         // 631
    // during the beginUpdate/endUpdate process.)                                                                      // 632
    //                                                                                                                 // 633
    // Normally, we ignore the return value of the stub (even if it is an                                              // 634
    // exception), in favor of the real return value from the server. The                                              // 635
    // exception is if the *caller* is a stub. In that case, we're not going                                           // 636
    // to do a RPC, so we use the return value of the stub as our return                                               // 637
    // value.                                                                                                          // 638
                                                                                                                       // 639
    var enclosing = DDP._CurrentInvocation.get();                                                                      // 640
    var alreadyInSimulation = enclosing && enclosing.isSimulation;                                                     // 641
                                                                                                                       // 642
    var stub = self._methodHandlers[name];                                                                             // 643
    if (stub) {                                                                                                        // 644
      var setUserId = function(userId) {                                                                               // 645
        self.setUserId(userId);                                                                                        // 646
      };                                                                                                               // 647
      var invocation = new MethodInvocation({                                                                          // 648
        isSimulation: true,                                                                                            // 649
        userId: self.userId(),                                                                                         // 650
        setUserId: setUserId                                                                                           // 651
      });                                                                                                              // 652
                                                                                                                       // 653
      if (!alreadyInSimulation)                                                                                        // 654
        self._saveOriginals();                                                                                         // 655
                                                                                                                       // 656
      try {                                                                                                            // 657
        // Note that unlike in the corresponding server code, we never audit                                           // 658
        // that stubs check() their arguments.                                                                         // 659
        var ret = DDP._CurrentInvocation.withValue(invocation, function () {                                           // 660
          if (Meteor.isServer) {                                                                                       // 661
            // Because saveOriginals and retrieveOriginals aren't reentrant,                                           // 662
            // don't allow stubs to yield.                                                                             // 663
            return Meteor._noYieldsAllowed(function () {                                                               // 664
              return stub.apply(invocation, EJSON.clone(args));                                                        // 665
            });                                                                                                        // 666
          } else {                                                                                                     // 667
            return stub.apply(invocation, EJSON.clone(args));                                                          // 668
          }                                                                                                            // 669
        });                                                                                                            // 670
      }                                                                                                                // 671
      catch (e) {                                                                                                      // 672
        var exception = e;                                                                                             // 673
      }                                                                                                                // 674
                                                                                                                       // 675
      if (!alreadyInSimulation)                                                                                        // 676
        self._retrieveAndStoreOriginals(methodId());                                                                   // 677
    }                                                                                                                  // 678
                                                                                                                       // 679
    // If we're in a simulation, stop and return the result we have,                                                   // 680
    // rather than going on to do an RPC. If there was no stub,                                                        // 681
    // we'll end up returning undefined.                                                                               // 682
    if (alreadyInSimulation) {                                                                                         // 683
      if (callback) {                                                                                                  // 684
        callback(exception, ret);                                                                                      // 685
        return undefined;                                                                                              // 686
      }                                                                                                                // 687
      if (exception)                                                                                                   // 688
        throw exception;                                                                                               // 689
      return ret;                                                                                                      // 690
    }                                                                                                                  // 691
                                                                                                                       // 692
    // If an exception occurred in a stub, and we're ignoring it                                                       // 693
    // because we're doing an RPC and want to use what the server                                                      // 694
    // returns instead, log it so the developer knows.                                                                 // 695
    //                                                                                                                 // 696
    // Tests can set the 'expected' flag on an exception so it won't                                                   // 697
    // go to log.                                                                                                      // 698
    if (exception && !exception.expected) {                                                                            // 699
      Meteor._debug("Exception while simulating the effect of invoking '" +                                            // 700
                    name + "'", exception, exception.stack);                                                           // 701
    }                                                                                                                  // 702
                                                                                                                       // 703
                                                                                                                       // 704
    // At this point we're definitely doing an RPC, and we're going to                                                 // 705
    // return the value of the RPC to the caller.                                                                      // 706
                                                                                                                       // 707
    // If the caller didn't give a callback, decide what to do.                                                        // 708
    if (!callback) {                                                                                                   // 709
      if (Meteor.isClient) {                                                                                           // 710
        // On the client, we don't have fibers, so we can't block. The                                                 // 711
        // only thing we can do is to return undefined and discard the                                                 // 712
        // result of the RPC.                                                                                          // 713
        callback = function () {};                                                                                     // 714
      } else {                                                                                                         // 715
        // On the server, make the function synchronous. Throw on                                                      // 716
        // errors, return on success.                                                                                  // 717
        var future = new Future;                                                                                       // 718
        callback = future.resolver();                                                                                  // 719
      }                                                                                                                // 720
    }                                                                                                                  // 721
    // Send the RPC. Note that on the client, it is important that the                                                 // 722
    // stub have finished before we send the RPC, so that we know we have                                              // 723
    // a complete list of which local documents the stub wrote.                                                        // 724
    var methodInvoker = new MethodInvoker({                                                                            // 725
      methodId: methodId(),                                                                                            // 726
      callback: callback,                                                                                              // 727
      connection: self,                                                                                                // 728
      onResultReceived: options.onResultReceived,                                                                      // 729
      wait: !!options.wait,                                                                                            // 730
      message: {                                                                                                       // 731
        msg: 'method',                                                                                                 // 732
        method: name,                                                                                                  // 733
        params: args,                                                                                                  // 734
        id: methodId()                                                                                                 // 735
      }                                                                                                                // 736
    });                                                                                                                // 737
                                                                                                                       // 738
    if (options.wait) {                                                                                                // 739
      // It's a wait method! Wait methods go in their own block.                                                       // 740
      self._outstandingMethodBlocks.push(                                                                              // 741
        {wait: true, methods: [methodInvoker]});                                                                       // 742
    } else {                                                                                                           // 743
      // Not a wait method. Start a new block if the previous block was a wait                                         // 744
      // block, and add it to the last block of methods.                                                               // 745
      if (_.isEmpty(self._outstandingMethodBlocks) ||                                                                  // 746
          _.last(self._outstandingMethodBlocks).wait)                                                                  // 747
        self._outstandingMethodBlocks.push({wait: false, methods: []});                                                // 748
      _.last(self._outstandingMethodBlocks).methods.push(methodInvoker);                                               // 749
    }                                                                                                                  // 750
                                                                                                                       // 751
    // If we added it to the first block, send it out now.                                                             // 752
    if (self._outstandingMethodBlocks.length === 1)                                                                    // 753
      methodInvoker.sendMessage();                                                                                     // 754
                                                                                                                       // 755
    // If we're using the default callback on the server,                                                              // 756
    // block waiting for the result.                                                                                   // 757
    if (future) {                                                                                                      // 758
      return future.wait();                                                                                            // 759
    }                                                                                                                  // 760
    return undefined;                                                                                                  // 761
  },                                                                                                                   // 762
                                                                                                                       // 763
  // Before calling a method stub, prepare all stores to track changes and allow                                       // 764
  // _retrieveAndStoreOriginals to get the original versions of changed                                                // 765
  // documents.                                                                                                        // 766
  _saveOriginals: function () {                                                                                        // 767
    var self = this;                                                                                                   // 768
    _.each(self._stores, function (s) {                                                                                // 769
      s.saveOriginals();                                                                                               // 770
    });                                                                                                                // 771
  },                                                                                                                   // 772
  // Retrieves the original versions of all documents modified by the stub for                                         // 773
  // method 'methodId' from all stores and saves them to _serverDocuments (keyed                                       // 774
  // by document) and _documentsWrittenByStub (keyed by method ID).                                                    // 775
  _retrieveAndStoreOriginals: function (methodId) {                                                                    // 776
    var self = this;                                                                                                   // 777
    if (self._documentsWrittenByStub[methodId])                                                                        // 778
      throw new Error("Duplicate methodId in _retrieveAndStoreOriginals");                                             // 779
                                                                                                                       // 780
    var docsWritten = [];                                                                                              // 781
    _.each(self._stores, function (s, collection) {                                                                    // 782
      var originals = s.retrieveOriginals();                                                                           // 783
      // not all stores define retrieveOriginals                                                                       // 784
      if (!originals)                                                                                                  // 785
        return;                                                                                                        // 786
      originals.forEach(function (doc, id) {                                                                           // 787
        docsWritten.push({collection: collection, id: id});                                                            // 788
        if (!_.has(self._serverDocuments, collection))                                                                 // 789
          self._serverDocuments[collection] = new LocalCollection._IdMap;                                              // 790
        var serverDoc = self._serverDocuments[collection].setDefault(id, {});                                          // 791
        if (serverDoc.writtenByStubs) {                                                                                // 792
          // We're not the first stub to write this doc. Just add our method ID                                        // 793
          // to the record.                                                                                            // 794
          serverDoc.writtenByStubs[methodId] = true;                                                                   // 795
        } else {                                                                                                       // 796
          // First stub! Save the original value and our method ID.                                                    // 797
          serverDoc.document = doc;                                                                                    // 798
          serverDoc.flushCallbacks = [];                                                                               // 799
          serverDoc.writtenByStubs = {};                                                                               // 800
          serverDoc.writtenByStubs[methodId] = true;                                                                   // 801
        }                                                                                                              // 802
      });                                                                                                              // 803
    });                                                                                                                // 804
    if (!_.isEmpty(docsWritten)) {                                                                                     // 805
      self._documentsWrittenByStub[methodId] = docsWritten;                                                            // 806
    }                                                                                                                  // 807
  },                                                                                                                   // 808
                                                                                                                       // 809
  // This is very much a private function we use to make the tests                                                     // 810
  // take up fewer server resources after they complete.                                                               // 811
  _unsubscribeAll: function () {                                                                                       // 812
    var self = this;                                                                                                   // 813
    _.each(_.clone(self._subscriptions), function (sub, id) {                                                          // 814
      // Avoid killing the autoupdate subscription so that developers                                                  // 815
      // still get hot code pushes when writing tests.                                                                 // 816
      //                                                                                                               // 817
      // XXX it's a hack to encode knowledge about autoupdate here,                                                    // 818
      // but it doesn't seem worth it yet to have a special API for                                                    // 819
      // subscriptions to preserve after unit tests.                                                                   // 820
      if (sub.name !== 'meteor_autoupdate_clientVersions') {                                                           // 821
        self._send({msg: 'unsub', id: id});                                                                            // 822
        delete self._subscriptions[id];                                                                                // 823
      }                                                                                                                // 824
    });                                                                                                                // 825
  },                                                                                                                   // 826
                                                                                                                       // 827
  // Sends the DDP stringification of the given message object                                                         // 828
  _send: function (obj) {                                                                                              // 829
    var self = this;                                                                                                   // 830
    self._stream.send(stringifyDDP(obj));                                                                              // 831
  },                                                                                                                   // 832
                                                                                                                       // 833
  status: function (/*passthrough args*/) {                                                                            // 834
    var self = this;                                                                                                   // 835
    return self._stream.status.apply(self._stream, arguments);                                                         // 836
  },                                                                                                                   // 837
                                                                                                                       // 838
  reconnect: function (/*passthrough args*/) {                                                                         // 839
    var self = this;                                                                                                   // 840
    return self._stream.reconnect.apply(self._stream, arguments);                                                      // 841
  },                                                                                                                   // 842
                                                                                                                       // 843
  disconnect: function (/*passthrough args*/) {                                                                        // 844
    var self = this;                                                                                                   // 845
    return self._stream.disconnect.apply(self._stream, arguments);                                                     // 846
  },                                                                                                                   // 847
                                                                                                                       // 848
  close: function () {                                                                                                 // 849
    var self = this;                                                                                                   // 850
    return self._stream.disconnect({_permanent: true});                                                                // 851
  },                                                                                                                   // 852
                                                                                                                       // 853
  ///                                                                                                                  // 854
  /// Reactive user system                                                                                             // 855
  ///                                                                                                                  // 856
  userId: function () {                                                                                                // 857
    var self = this;                                                                                                   // 858
    if (self._userIdDeps)                                                                                              // 859
      self._userIdDeps.depend();                                                                                       // 860
    return self._userId;                                                                                               // 861
  },                                                                                                                   // 862
                                                                                                                       // 863
  setUserId: function (userId) {                                                                                       // 864
    var self = this;                                                                                                   // 865
    // Avoid invalidating dependents if setUserId is called with current value.                                        // 866
    if (self._userId === userId)                                                                                       // 867
      return;                                                                                                          // 868
    self._userId = userId;                                                                                             // 869
    if (self._userIdDeps)                                                                                              // 870
      self._userIdDeps.changed();                                                                                      // 871
  },                                                                                                                   // 872
                                                                                                                       // 873
  // Returns true if we are in a state after reconnect of waiting for subs to be                                       // 874
  // revived or early methods to finish their data, or we are waiting for a                                            // 875
  // "wait" method to finish.                                                                                          // 876
  _waitingForQuiescence: function () {                                                                                 // 877
    var self = this;                                                                                                   // 878
    return (! _.isEmpty(self._subsBeingRevived) ||                                                                     // 879
            ! _.isEmpty(self._methodsBlockingQuiescence));                                                             // 880
  },                                                                                                                   // 881
                                                                                                                       // 882
  // Returns true if any method whose message has been sent to the server has                                          // 883
  // not yet invoked its user callback.                                                                                // 884
  _anyMethodsAreOutstanding: function () {                                                                             // 885
    var self = this;                                                                                                   // 886
    return _.any(_.pluck(self._methodInvokers, 'sentMessage'));                                                        // 887
  },                                                                                                                   // 888
                                                                                                                       // 889
  _livedata_connected: function (msg) {                                                                                // 890
    var self = this;                                                                                                   // 891
                                                                                                                       // 892
    // If this is a reconnect, we'll have to reset all stores.                                                         // 893
    if (self._lastSessionId)                                                                                           // 894
      self._resetStores = true;                                                                                        // 895
                                                                                                                       // 896
    if (typeof (msg.session) === "string") {                                                                           // 897
      var reconnectedToPreviousSession = (self._lastSessionId === msg.session);                                        // 898
      self._lastSessionId = msg.session;                                                                               // 899
    }                                                                                                                  // 900
                                                                                                                       // 901
    if (reconnectedToPreviousSession) {                                                                                // 902
      // Successful reconnection -- pick up where we left off.  Note that right                                        // 903
      // now, this never happens: the server never connects us to a previous                                           // 904
      // session, because DDP doesn't provide enough data for the server to know                                       // 905
      // what messages the client has processed. We need to improve DDP to make                                        // 906
      // this possible, at which point we'll probably need more code here.                                             // 907
      return;                                                                                                          // 908
    }                                                                                                                  // 909
                                                                                                                       // 910
    // Server doesn't have our data any more. Re-sync a new session.                                                   // 911
                                                                                                                       // 912
    // Forget about messages we were buffering for unknown collections. They'll                                        // 913
    // be resent if still relevant.                                                                                    // 914
    self._updatesForUnknownStores = {};                                                                                // 915
                                                                                                                       // 916
    if (self._resetStores) {                                                                                           // 917
      // Forget about the effects of stubs. We'll be resetting all collections                                         // 918
      // anyway.                                                                                                       // 919
      self._documentsWrittenByStub = {};                                                                               // 920
      self._serverDocuments = {};                                                                                      // 921
    }                                                                                                                  // 922
                                                                                                                       // 923
    // Clear _afterUpdateCallbacks.                                                                                    // 924
    self._afterUpdateCallbacks = [];                                                                                   // 925
                                                                                                                       // 926
    // Mark all named subscriptions which are ready (ie, we already called the                                         // 927
    // ready callback) as needing to be revived.                                                                       // 928
    // XXX We should also block reconnect quiescence until unnamed subscriptions                                       // 929
    //     (eg, autopublish) are done re-publishing to avoid flicker!                                                  // 930
    self._subsBeingRevived = {};                                                                                       // 931
    _.each(self._subscriptions, function (sub, id) {                                                                   // 932
      if (sub.ready)                                                                                                   // 933
        self._subsBeingRevived[id] = true;                                                                             // 934
    });                                                                                                                // 935
                                                                                                                       // 936
    // Arrange for "half-finished" methods to have their callbacks run, and                                            // 937
    // track methods that were sent on this connection so that we don't                                                // 938
    // quiesce until they are all done.                                                                                // 939
    //                                                                                                                 // 940
    // Start by clearing _methodsBlockingQuiescence: methods sent before                                               // 941
    // reconnect don't matter, and any "wait" methods sent on the new connection                                       // 942
    // that we drop here will be restored by the loop below.                                                           // 943
    self._methodsBlockingQuiescence = {};                                                                              // 944
    if (self._resetStores) {                                                                                           // 945
      _.each(self._methodInvokers, function (invoker) {                                                                // 946
        if (invoker.gotResult()) {                                                                                     // 947
          // This method already got its result, but it didn't call its callback                                       // 948
          // because its data didn't become visible. We did not resend the                                             // 949
          // method RPC. We'll call its callback when we get a full quiesce,                                           // 950
          // since that's as close as we'll get to "data must be visible".                                             // 951
          self._afterUpdateCallbacks.push(_.bind(invoker.dataVisible, invoker));                                       // 952
        } else if (invoker.sentMessage) {                                                                              // 953
          // This method has been sent on this connection (maybe as a resend                                           // 954
          // from the last connection, maybe from onReconnect, maybe just very                                         // 955
          // quickly before processing the connected message).                                                         // 956
          //                                                                                                           // 957
          // We don't need to do anything special to ensure its callbacks get                                          // 958
          // called, but we'll count it as a method which is preventing                                                // 959
          // reconnect quiescence. (eg, it might be a login method that was run                                        // 960
          // from onReconnect, and we don't want to see flicker by seeing a                                            // 961
          // logged-out state.)                                                                                        // 962
          self._methodsBlockingQuiescence[invoker.methodId] = true;                                                    // 963
        }                                                                                                              // 964
      });                                                                                                              // 965
    }                                                                                                                  // 966
                                                                                                                       // 967
    self._messagesBufferedUntilQuiescence = [];                                                                        // 968
                                                                                                                       // 969
    // If we're not waiting on any methods or subs, we can reset the stores and                                        // 970
    // call the callbacks immediately.                                                                                 // 971
    if (!self._waitingForQuiescence()) {                                                                               // 972
      if (self._resetStores) {                                                                                         // 973
        _.each(self._stores, function (s) {                                                                            // 974
          s.beginUpdate(0, true);                                                                                      // 975
          s.endUpdate();                                                                                               // 976
        });                                                                                                            // 977
        self._resetStores = false;                                                                                     // 978
      }                                                                                                                // 979
      self._runAfterUpdateCallbacks();                                                                                 // 980
    }                                                                                                                  // 981
  },                                                                                                                   // 982
                                                                                                                       // 983
                                                                                                                       // 984
  _processOneDataMessage: function (msg, updates) {                                                                    // 985
    var self = this;                                                                                                   // 986
    // Using underscore here so as not to need to capitalize.                                                          // 987
    self['_process_' + msg.msg](msg, updates);                                                                         // 988
  },                                                                                                                   // 989
                                                                                                                       // 990
                                                                                                                       // 991
  _livedata_data: function (msg) {                                                                                     // 992
    var self = this;                                                                                                   // 993
                                                                                                                       // 994
    // collection name -> array of messages                                                                            // 995
    var updates = {};                                                                                                  // 996
                                                                                                                       // 997
    if (self._waitingForQuiescence()) {                                                                                // 998
      self._messagesBufferedUntilQuiescence.push(msg);                                                                 // 999
                                                                                                                       // 1000
      if (msg.msg === "nosub")                                                                                         // 1001
        delete self._subsBeingRevived[msg.id];                                                                         // 1002
                                                                                                                       // 1003
      _.each(msg.subs || [], function (subId) {                                                                        // 1004
        delete self._subsBeingRevived[subId];                                                                          // 1005
      });                                                                                                              // 1006
      _.each(msg.methods || [], function (methodId) {                                                                  // 1007
        delete self._methodsBlockingQuiescence[methodId];                                                              // 1008
      });                                                                                                              // 1009
                                                                                                                       // 1010
      if (self._waitingForQuiescence())                                                                                // 1011
        return;                                                                                                        // 1012
                                                                                                                       // 1013
      // No methods or subs are blocking quiescence!                                                                   // 1014
      // We'll now process and all of our buffered messages, reset all stores,                                         // 1015
      // and apply them all at once.                                                                                   // 1016
      _.each(self._messagesBufferedUntilQuiescence, function (bufferedMsg) {                                           // 1017
        self._processOneDataMessage(bufferedMsg, updates);                                                             // 1018
      });                                                                                                              // 1019
      self._messagesBufferedUntilQuiescence = [];                                                                      // 1020
    } else {                                                                                                           // 1021
      self._processOneDataMessage(msg, updates);                                                                       // 1022
    }                                                                                                                  // 1023
                                                                                                                       // 1024
    if (self._resetStores || !_.isEmpty(updates)) {                                                                    // 1025
      // Begin a transactional update of each store.                                                                   // 1026
      _.each(self._stores, function (s, storeName) {                                                                   // 1027
        s.beginUpdate(_.has(updates, storeName) ? updates[storeName].length : 0,                                       // 1028
                      self._resetStores);                                                                              // 1029
      });                                                                                                              // 1030
      self._resetStores = false;                                                                                       // 1031
                                                                                                                       // 1032
      _.each(updates, function (updateMessages, storeName) {                                                           // 1033
        var store = self._stores[storeName];                                                                           // 1034
        if (store) {                                                                                                   // 1035
          _.each(updateMessages, function (updateMessage) {                                                            // 1036
            store.update(updateMessage);                                                                               // 1037
          });                                                                                                          // 1038
        } else {                                                                                                       // 1039
          // Nobody's listening for this data. Queue it up until                                                       // 1040
          // someone wants it.                                                                                         // 1041
          // XXX memory use will grow without bound if you forget to                                                   // 1042
          // create a collection or just don't care about it... going                                                  // 1043
          // to have to do something about that.                                                                       // 1044
          if (!_.has(self._updatesForUnknownStores, storeName))                                                        // 1045
            self._updatesForUnknownStores[storeName] = [];                                                             // 1046
          Array.prototype.push.apply(self._updatesForUnknownStores[storeName],                                         // 1047
                                     updateMessages);                                                                  // 1048
        }                                                                                                              // 1049
      });                                                                                                              // 1050
                                                                                                                       // 1051
      // End update transaction.                                                                                       // 1052
      _.each(self._stores, function (s) { s.endUpdate(); });                                                           // 1053
    }                                                                                                                  // 1054
                                                                                                                       // 1055
    self._runAfterUpdateCallbacks();                                                                                   // 1056
  },                                                                                                                   // 1057
                                                                                                                       // 1058
  // Call any callbacks deferred with _runWhenAllServerDocsAreFlushed whose                                            // 1059
  // relevant docs have been flushed, as well as dataVisible callbacks at                                              // 1060
  // reconnect-quiescence time.                                                                                        // 1061
  _runAfterUpdateCallbacks: function () {                                                                              // 1062
    var self = this;                                                                                                   // 1063
    var callbacks = self._afterUpdateCallbacks;                                                                        // 1064
    self._afterUpdateCallbacks = [];                                                                                   // 1065
    _.each(callbacks, function (c) {                                                                                   // 1066
      c();                                                                                                             // 1067
    });                                                                                                                // 1068
  },                                                                                                                   // 1069
                                                                                                                       // 1070
  _pushUpdate: function (updates, collection, msg) {                                                                   // 1071
    var self = this;                                                                                                   // 1072
    if (!_.has(updates, collection)) {                                                                                 // 1073
      updates[collection] = [];                                                                                        // 1074
    }                                                                                                                  // 1075
    updates[collection].push(msg);                                                                                     // 1076
  },                                                                                                                   // 1077
                                                                                                                       // 1078
  _getServerDoc: function (collection, id) {                                                                           // 1079
    var self = this;                                                                                                   // 1080
    if (!_.has(self._serverDocuments, collection))                                                                     // 1081
      return null;                                                                                                     // 1082
    var serverDocsForCollection = self._serverDocuments[collection];                                                   // 1083
    return serverDocsForCollection.get(id) || null;                                                                    // 1084
  },                                                                                                                   // 1085
                                                                                                                       // 1086
  _process_added: function (msg, updates) {                                                                            // 1087
    var self = this;                                                                                                   // 1088
    var id = LocalCollection._idParse(msg.id);                                                                         // 1089
    var serverDoc = self._getServerDoc(msg.collection, id);                                                            // 1090
    if (serverDoc) {                                                                                                   // 1091
      // Some outstanding stub wrote here.                                                                             // 1092
      if (serverDoc.document !== undefined)                                                                            // 1093
        throw new Error("Server sent add for existing id: " + msg.id);                                                 // 1094
      serverDoc.document = msg.fields || {};                                                                           // 1095
      serverDoc.document._id = id;                                                                                     // 1096
    } else {                                                                                                           // 1097
      self._pushUpdate(updates, msg.collection, msg);                                                                  // 1098
    }                                                                                                                  // 1099
  },                                                                                                                   // 1100
                                                                                                                       // 1101
  _process_changed: function (msg, updates) {                                                                          // 1102
    var self = this;                                                                                                   // 1103
    var serverDoc = self._getServerDoc(                                                                                // 1104
      msg.collection, LocalCollection._idParse(msg.id));                                                               // 1105
    if (serverDoc) {                                                                                                   // 1106
      if (serverDoc.document === undefined)                                                                            // 1107
        throw new Error("Server sent changed for nonexisting id: " + msg.id);                                          // 1108
      LocalCollection._applyChanges(serverDoc.document, msg.fields);                                                   // 1109
    } else {                                                                                                           // 1110
      self._pushUpdate(updates, msg.collection, msg);                                                                  // 1111
    }                                                                                                                  // 1112
  },                                                                                                                   // 1113
                                                                                                                       // 1114
  _process_removed: function (msg, updates) {                                                                          // 1115
    var self = this;                                                                                                   // 1116
    var serverDoc = self._getServerDoc(                                                                                // 1117
      msg.collection, LocalCollection._idParse(msg.id));                                                               // 1118
    if (serverDoc) {                                                                                                   // 1119
      // Some outstanding stub wrote here.                                                                             // 1120
      if (serverDoc.document === undefined)                                                                            // 1121
        throw new Error("Server sent removed for nonexisting id:" + msg.id);                                           // 1122
      serverDoc.document = undefined;                                                                                  // 1123
    } else {                                                                                                           // 1124
      self._pushUpdate(updates, msg.collection, {                                                                      // 1125
        msg: 'removed',                                                                                                // 1126
        collection: msg.collection,                                                                                    // 1127
        id: msg.id                                                                                                     // 1128
      });                                                                                                              // 1129
    }                                                                                                                  // 1130
  },                                                                                                                   // 1131
                                                                                                                       // 1132
  _process_updated: function (msg, updates) {                                                                          // 1133
    var self = this;                                                                                                   // 1134
    // Process "method done" messages.                                                                                 // 1135
    _.each(msg.methods, function (methodId) {                                                                          // 1136
      _.each(self._documentsWrittenByStub[methodId], function (written) {                                              // 1137
        var serverDoc = self._getServerDoc(written.collection, written.id);                                            // 1138
        if (!serverDoc)                                                                                                // 1139
          throw new Error("Lost serverDoc for " + JSON.stringify(written));                                            // 1140
        if (!serverDoc.writtenByStubs[methodId])                                                                       // 1141
          throw new Error("Doc " + JSON.stringify(written) +                                                           // 1142
                          " not written by  method " + methodId);                                                      // 1143
        delete serverDoc.writtenByStubs[methodId];                                                                     // 1144
        if (_.isEmpty(serverDoc.writtenByStubs)) {                                                                     // 1145
          // All methods whose stubs wrote this method have completed! We can                                          // 1146
          // now copy the saved document to the database (reverting the stub's                                         // 1147
          // change if the server did not write to this object, or applying the                                        // 1148
          // server's writes if it did).                                                                               // 1149
                                                                                                                       // 1150
          // This is a fake ddp 'replace' message.  It's just for talking                                              // 1151
          // between livedata connections and minimongo.  (We have to stringify                                        // 1152
          // the ID because it's supposed to look like a wire message.)                                                // 1153
          self._pushUpdate(updates, written.collection, {                                                              // 1154
            msg: 'replace',                                                                                            // 1155
            id: LocalCollection._idStringify(written.id),                                                              // 1156
            replace: serverDoc.document                                                                                // 1157
          });                                                                                                          // 1158
          // Call all flush callbacks.                                                                                 // 1159
          _.each(serverDoc.flushCallbacks, function (c) {                                                              // 1160
            c();                                                                                                       // 1161
          });                                                                                                          // 1162
                                                                                                                       // 1163
          // Delete this completed serverDocument. Don't bother to GC empty                                            // 1164
          // IdMaps inside self._serverDocuments, since there probably aren't                                          // 1165
          // many collections and they'll be written repeatedly.                                                       // 1166
          self._serverDocuments[written.collection].remove(written.id);                                                // 1167
        }                                                                                                              // 1168
      });                                                                                                              // 1169
      delete self._documentsWrittenByStub[methodId];                                                                   // 1170
                                                                                                                       // 1171
      // We want to call the data-written callback, but we can't do so until all                                       // 1172
      // currently buffered messages are flushed.                                                                      // 1173
      var callbackInvoker = self._methodInvokers[methodId];                                                            // 1174
      if (!callbackInvoker)                                                                                            // 1175
        throw new Error("No callback invoker for method " + methodId);                                                 // 1176
      self._runWhenAllServerDocsAreFlushed(                                                                            // 1177
        _.bind(callbackInvoker.dataVisible, callbackInvoker));                                                         // 1178
    });                                                                                                                // 1179
  },                                                                                                                   // 1180
                                                                                                                       // 1181
  _process_ready: function (msg, updates) {                                                                            // 1182
    var self = this;                                                                                                   // 1183
    // Process "sub ready" messages. "sub ready" messages don't take effect                                            // 1184
    // until all current server documents have been flushed to the local                                               // 1185
    // database. We can use a write fence to implement this.                                                           // 1186
    _.each(msg.subs, function (subId) {                                                                                // 1187
      self._runWhenAllServerDocsAreFlushed(function () {                                                               // 1188
        var subRecord = self._subscriptions[subId];                                                                    // 1189
        // Did we already unsubscribe?                                                                                 // 1190
        if (!subRecord)                                                                                                // 1191
          return;                                                                                                      // 1192
        // Did we already receive a ready message? (Oops!)                                                             // 1193
        if (subRecord.ready)                                                                                           // 1194
          return;                                                                                                      // 1195
        subRecord.readyCallback && subRecord.readyCallback();                                                          // 1196
        subRecord.ready = true;                                                                                        // 1197
        subRecord.readyDeps && subRecord.readyDeps.changed();                                                          // 1198
      });                                                                                                              // 1199
    });                                                                                                                // 1200
  },                                                                                                                   // 1201
                                                                                                                       // 1202
  // Ensures that "f" will be called after all documents currently in                                                  // 1203
  // _serverDocuments have been written to the local cache. f will not be called                                       // 1204
  // if the connection is lost before then!                                                                            // 1205
  _runWhenAllServerDocsAreFlushed: function (f) {                                                                      // 1206
    var self = this;                                                                                                   // 1207
    var runFAfterUpdates = function () {                                                                               // 1208
      self._afterUpdateCallbacks.push(f);                                                                              // 1209
    };                                                                                                                 // 1210
    var unflushedServerDocCount = 0;                                                                                   // 1211
    var onServerDocFlush = function () {                                                                               // 1212
      --unflushedServerDocCount;                                                                                       // 1213
      if (unflushedServerDocCount === 0) {                                                                             // 1214
        // This was the last doc to flush! Arrange to run f after the updates                                          // 1215
        // have been applied.                                                                                          // 1216
        runFAfterUpdates();                                                                                            // 1217
      }                                                                                                                // 1218
    };                                                                                                                 // 1219
    _.each(self._serverDocuments, function (collectionDocs) {                                                          // 1220
      collectionDocs.forEach(function (serverDoc) {                                                                    // 1221
        var writtenByStubForAMethodWithSentMessage = _.any(                                                            // 1222
          serverDoc.writtenByStubs, function (dummy, methodId) {                                                       // 1223
            var invoker = self._methodInvokers[methodId];                                                              // 1224
            return invoker && invoker.sentMessage;                                                                     // 1225
          });                                                                                                          // 1226
        if (writtenByStubForAMethodWithSentMessage) {                                                                  // 1227
          ++unflushedServerDocCount;                                                                                   // 1228
          serverDoc.flushCallbacks.push(onServerDocFlush);                                                             // 1229
        }                                                                                                              // 1230
      });                                                                                                              // 1231
    });                                                                                                                // 1232
    if (unflushedServerDocCount === 0) {                                                                               // 1233
      // There aren't any buffered docs --- we can call f as soon as the current                                       // 1234
      // round of updates is applied!                                                                                  // 1235
      runFAfterUpdates();                                                                                              // 1236
    }                                                                                                                  // 1237
  },                                                                                                                   // 1238
                                                                                                                       // 1239
  _livedata_nosub: function (msg) {                                                                                    // 1240
    var self = this;                                                                                                   // 1241
                                                                                                                       // 1242
    // First pass it through _livedata_data, which only uses it to help get                                            // 1243
    // towards quiescence.                                                                                             // 1244
    self._livedata_data(msg);                                                                                          // 1245
                                                                                                                       // 1246
    // Do the rest of our processing immediately, with no                                                              // 1247
    // buffering-until-quiescence.                                                                                     // 1248
                                                                                                                       // 1249
    // we weren't subbed anyway, or we initiated the unsub.                                                            // 1250
    if (!_.has(self._subscriptions, msg.id))                                                                           // 1251
      return;                                                                                                          // 1252
    var errorCallback = self._subscriptions[msg.id].errorCallback;                                                     // 1253
    delete self._subscriptions[msg.id];                                                                                // 1254
    if (errorCallback && msg.error) {                                                                                  // 1255
      errorCallback(new Meteor.Error(                                                                                  // 1256
        msg.error.error, msg.error.reason, msg.error.details));                                                        // 1257
    }                                                                                                                  // 1258
  },                                                                                                                   // 1259
                                                                                                                       // 1260
  _process_nosub: function () {                                                                                        // 1261
    // This is called as part of the "buffer until quiescence" process, but                                            // 1262
    // nosub's effect is always immediate. It only goes in the buffer at all                                           // 1263
    // because it's possible for a nosub to be the thing that triggers                                                 // 1264
    // quiescence, if we were waiting for a sub to be revived and it dies                                              // 1265
    // instead.                                                                                                        // 1266
  },                                                                                                                   // 1267
                                                                                                                       // 1268
  _livedata_result: function (msg) {                                                                                   // 1269
    // id, result or error. error has error (code), reason, details                                                    // 1270
                                                                                                                       // 1271
    var self = this;                                                                                                   // 1272
                                                                                                                       // 1273
    // find the outstanding request                                                                                    // 1274
    // should be O(1) in nearly all realistic use cases                                                                // 1275
    if (_.isEmpty(self._outstandingMethodBlocks)) {                                                                    // 1276
      Meteor._debug("Received method result but no methods outstanding");                                              // 1277
      return;                                                                                                          // 1278
    }                                                                                                                  // 1279
    var currentMethodBlock = self._outstandingMethodBlocks[0].methods;                                                 // 1280
    var m;                                                                                                             // 1281
    for (var i = 0; i < currentMethodBlock.length; i++) {                                                              // 1282
      m = currentMethodBlock[i];                                                                                       // 1283
      if (m.methodId === msg.id)                                                                                       // 1284
        break;                                                                                                         // 1285
    }                                                                                                                  // 1286
                                                                                                                       // 1287
    if (!m) {                                                                                                          // 1288
      Meteor._debug("Can't match method response to original method call", msg);                                       // 1289
      return;                                                                                                          // 1290
    }                                                                                                                  // 1291
                                                                                                                       // 1292
    // Remove from current method block. This may leave the block empty, but we                                        // 1293
    // don't move on to the next block until the callback has been delivered, in                                       // 1294
    // _outstandingMethodFinished.                                                                                     // 1295
    currentMethodBlock.splice(i, 1);                                                                                   // 1296
                                                                                                                       // 1297
    if (_.has(msg, 'error')) {                                                                                         // 1298
      m.receiveResult(new Meteor.Error(                                                                                // 1299
        msg.error.error, msg.error.reason,                                                                             // 1300
        msg.error.details));                                                                                           // 1301
    } else {                                                                                                           // 1302
      // msg.result may be undefined if the method didn't return a                                                     // 1303
      // value                                                                                                         // 1304
      m.receiveResult(undefined, msg.result);                                                                          // 1305
    }                                                                                                                  // 1306
  },                                                                                                                   // 1307
                                                                                                                       // 1308
  // Called by MethodInvoker after a method's callback is invoked.  If this was                                        // 1309
  // the last outstanding method in the current block, runs the next block. If                                         // 1310
  // there are no more methods, consider accepting a hot code push.                                                    // 1311
  _outstandingMethodFinished: function () {                                                                            // 1312
    var self = this;                                                                                                   // 1313
    if (self._anyMethodsAreOutstanding())                                                                              // 1314
      return;                                                                                                          // 1315
                                                                                                                       // 1316
    // No methods are outstanding. This should mean that the first block of                                            // 1317
    // methods is empty. (Or it might not exist, if this was a method that                                             // 1318
    // half-finished before disconnect/reconnect.)                                                                     // 1319
    if (! _.isEmpty(self._outstandingMethodBlocks)) {                                                                  // 1320
      var firstBlock = self._outstandingMethodBlocks.shift();                                                          // 1321
      if (! _.isEmpty(firstBlock.methods))                                                                             // 1322
        throw new Error("No methods outstanding but nonempty block: " +                                                // 1323
                        JSON.stringify(firstBlock));                                                                   // 1324
                                                                                                                       // 1325
      // Send the outstanding methods now in the first block.                                                          // 1326
      if (!_.isEmpty(self._outstandingMethodBlocks))                                                                   // 1327
        self._sendOutstandingMethods();                                                                                // 1328
    }                                                                                                                  // 1329
                                                                                                                       // 1330
    // Maybe accept a hot code push.                                                                                   // 1331
    self._maybeMigrate();                                                                                              // 1332
  },                                                                                                                   // 1333
                                                                                                                       // 1334
  // Sends messages for all the methods in the first block in                                                          // 1335
  // _outstandingMethodBlocks.                                                                                         // 1336
  _sendOutstandingMethods: function() {                                                                                // 1337
    var self = this;                                                                                                   // 1338
    if (_.isEmpty(self._outstandingMethodBlocks))                                                                      // 1339
      return;                                                                                                          // 1340
    _.each(self._outstandingMethodBlocks[0].methods, function (m) {                                                    // 1341
      m.sendMessage();                                                                                                 // 1342
    });                                                                                                                // 1343
  },                                                                                                                   // 1344
                                                                                                                       // 1345
  _livedata_error: function (msg) {                                                                                    // 1346
    Meteor._debug("Received error from server: ", msg.reason);                                                         // 1347
    if (msg.offendingMessage)                                                                                          // 1348
      Meteor._debug("For: ", msg.offendingMessage);                                                                    // 1349
  },                                                                                                                   // 1350
                                                                                                                       // 1351
  _callOnReconnectAndSendAppropriateOutstandingMethods: function() {                                                   // 1352
    var self = this;                                                                                                   // 1353
    var oldOutstandingMethodBlocks = self._outstandingMethodBlocks;                                                    // 1354
    self._outstandingMethodBlocks = [];                                                                                // 1355
                                                                                                                       // 1356
    self.onReconnect();                                                                                                // 1357
                                                                                                                       // 1358
    if (_.isEmpty(oldOutstandingMethodBlocks))                                                                         // 1359
      return;                                                                                                          // 1360
                                                                                                                       // 1361
    // We have at least one block worth of old outstanding methods to try                                              // 1362
    // again. First: did onReconnect actually send anything? If not, we just                                           // 1363
    // restore all outstanding methods and run the first block.                                                        // 1364
    if (_.isEmpty(self._outstandingMethodBlocks)) {                                                                    // 1365
      self._outstandingMethodBlocks = oldOutstandingMethodBlocks;                                                      // 1366
      self._sendOutstandingMethods();                                                                                  // 1367
      return;                                                                                                          // 1368
    }                                                                                                                  // 1369
                                                                                                                       // 1370
    // OK, there are blocks on both sides. Special case: merge the last block of                                       // 1371
    // the reconnect methods with the first block of the original methods, if                                          // 1372
    // neither of them are "wait" blocks.                                                                              // 1373
    if (!_.last(self._outstandingMethodBlocks).wait &&                                                                 // 1374
        !oldOutstandingMethodBlocks[0].wait) {                                                                         // 1375
      _.each(oldOutstandingMethodBlocks[0].methods, function (m) {                                                     // 1376
        _.last(self._outstandingMethodBlocks).methods.push(m);                                                         // 1377
                                                                                                                       // 1378
        // If this "last block" is also the first block, send the message.                                             // 1379
        if (self._outstandingMethodBlocks.length === 1)                                                                // 1380
          m.sendMessage();                                                                                             // 1381
      });                                                                                                              // 1382
                                                                                                                       // 1383
      oldOutstandingMethodBlocks.shift();                                                                              // 1384
    }                                                                                                                  // 1385
                                                                                                                       // 1386
    // Now add the rest of the original blocks on.                                                                     // 1387
    _.each(oldOutstandingMethodBlocks, function (block) {                                                              // 1388
      self._outstandingMethodBlocks.push(block);                                                                       // 1389
    });                                                                                                                // 1390
  },                                                                                                                   // 1391
                                                                                                                       // 1392
  // We can accept a hot code push if there are no methods in flight.                                                  // 1393
  _readyToMigrate: function() {                                                                                        // 1394
    var self = this;                                                                                                   // 1395
    return _.isEmpty(self._methodInvokers);                                                                            // 1396
  },                                                                                                                   // 1397
                                                                                                                       // 1398
  // If we were blocking a migration, see if it's now possible to continue.                                            // 1399
  // Call whenever the set of outstanding/blocked methods shrinks.                                                     // 1400
  _maybeMigrate: function () {                                                                                         // 1401
    var self = this;                                                                                                   // 1402
    if (self._retryMigrate && self._readyToMigrate()) {                                                                // 1403
      self._retryMigrate();                                                                                            // 1404
      self._retryMigrate = null;                                                                                       // 1405
    }                                                                                                                  // 1406
  }                                                                                                                    // 1407
});                                                                                                                    // 1408
                                                                                                                       // 1409
LivedataTest.Connection = Connection;                                                                                  // 1410
                                                                                                                       // 1411
// @param url {String} URL to Meteor app,                                                                              // 1412
//     e.g.:                                                                                                           // 1413
//     "subdomain.meteor.com",                                                                                         // 1414
//     "http://subdomain.meteor.com",                                                                                  // 1415
//     "/",                                                                                                            // 1416
//     "ddp+sockjs://ddp--****-foo.meteor.com/sockjs"                                                                  // 1417
//                                                                                                                     // 1418
DDP.connect = function (url, options) {                                                                                // 1419
  var ret = new Connection(url, options);                                                                              // 1420
  allConnections.push(ret); // hack. see below.                                                                        // 1421
  return ret;                                                                                                          // 1422
};                                                                                                                     // 1423
                                                                                                                       // 1424
// Hack for `spiderable` package: a way to see if the page is done                                                     // 1425
// loading all the data it needs.                                                                                      // 1426
//                                                                                                                     // 1427
allConnections = [];                                                                                                   // 1428
DDP._allSubscriptionsReady = function () {                                                                             // 1429
  return _.all(allConnections, function (conn) {                                                                       // 1430
    return _.all(conn._subscriptions, function (sub) {                                                                 // 1431
      return sub.ready;                                                                                                // 1432
    });                                                                                                                // 1433
  });                                                                                                                  // 1434
};                                                                                                                     // 1435
                                                                                                                       // 1436
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/livedata/server_convenience.js                                                                             //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
// Only create a server if we are in an environment with a HTTP server                                                 // 1
// (as opposed to, eg, a command-line tool).                                                                           // 2
//                                                                                                                     // 3
if (Package.webapp) {                                                                                                  // 4
  if (process.env.DDP_DEFAULT_CONNECTION_URL) {                                                                        // 5
    __meteor_runtime_config__.DDP_DEFAULT_CONNECTION_URL =                                                             // 6
      process.env.DDP_DEFAULT_CONNECTION_URL;                                                                          // 7
  }                                                                                                                    // 8
                                                                                                                       // 9
  Meteor.server = new Server;                                                                                          // 10
                                                                                                                       // 11
  Meteor.refresh = function (notification) {                                                                           // 12
    DDPServer._InvalidationCrossbar.fire(notification);                                                                // 13
  };                                                                                                                   // 14
                                                                                                                       // 15
  // Proxy the public methods of Meteor.server so they can                                                             // 16
  // be called directly on Meteor.                                                                                     // 17
  _.each(['publish', 'methods', 'call', 'apply', 'onConnection'],                                                      // 18
         function (name) {                                                                                             // 19
           Meteor[name] = _.bind(Meteor.server[name], Meteor.server);                                                  // 20
         });                                                                                                           // 21
} else {                                                                                                               // 22
  // No server? Make these empty/no-ops.                                                                               // 23
  Meteor.server = null;                                                                                                // 24
  Meteor.refresh = function (notification) {                                                                           // 25
  };                                                                                                                   // 26
}                                                                                                                      // 27
                                                                                                                       // 28
// Meteor.server used to be called Meteor.default_server. Provide                                                      // 29
// backcompat as a courtesy even though it was never documented.                                                       // 30
// XXX COMPAT WITH 0.6.4                                                                                               // 31
Meteor.default_server = Meteor.server;                                                                                 // 32
                                                                                                                       // 33
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package.livedata = {
  DDP: DDP,
  DDPServer: DDPServer,
  LivedataTest: LivedataTest
};

})();
