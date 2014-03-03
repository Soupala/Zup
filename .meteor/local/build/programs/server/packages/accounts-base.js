(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var _ = Package.underscore._;
var check = Package.check.check;
var Match = Package.check.Match;
var Random = Package.random.Random;
var EJSON = Package.ejson.EJSON;
var DDP = Package.livedata.DDP;
var DDPServer = Package.livedata.DDPServer;
var MongoInternals = Package['mongo-livedata'].MongoInternals;

/* Package-scope variables */
var Accounts, EXPIRE_TOKENS_INTERVAL_MS, CONNECTION_CLOSE_DELAY_MS, getTokenLifetimeMs, loginHandlers, maybeStopExpireTokensInterval;

(function () {

///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                               //
// packages/accounts-base/accounts_common.js                                                                     //
//                                                                                                               //
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                 //
Accounts = {};                                                                                                   // 1
                                                                                                                 // 2
// Currently this is read directly by packages like accounts-password                                            // 3
// and accounts-ui-unstyled.                                                                                     // 4
Accounts._options = {};                                                                                          // 5
                                                                                                                 // 6
// how long (in days) until a login token expires                                                                // 7
var DEFAULT_LOGIN_EXPIRATION_DAYS = 90;                                                                          // 8
// Clients don't try to auto-login with a token that is going to expire within                                   // 9
// .1 * DEFAULT_LOGIN_EXPIRATION_DAYS, capped at MIN_TOKEN_LIFETIME_CAP_SECS.                                    // 10
// Tries to avoid abrupt disconnects from expiring tokens.                                                       // 11
var MIN_TOKEN_LIFETIME_CAP_SECS = 3600; // one hour                                                              // 12
// how often (in milliseconds) we check for expired tokens                                                       // 13
EXPIRE_TOKENS_INTERVAL_MS = 600 * 1000; // 10 minutes                                                            // 14
// how long we wait before logging out clients when Meteor.logoutOtherClients is                                 // 15
// called                                                                                                        // 16
CONNECTION_CLOSE_DELAY_MS = 10 * 1000;                                                                           // 17
                                                                                                                 // 18
// Set up config for the accounts system. Call this on both the client                                           // 19
// and the server.                                                                                               // 20
//                                                                                                               // 21
// XXX we should add some enforcement that this is called on both the                                            // 22
// client and the server. Otherwise, a user can                                                                  // 23
// 'forbidClientAccountCreation' only on the client and while it looks                                           // 24
// like their app is secure, the server will still accept createUser                                             // 25
// calls. https://github.com/meteor/meteor/issues/828                                                            // 26
//                                                                                                               // 27
// @param options {Object} an object with fields:                                                                // 28
// - sendVerificationEmail {Boolean}                                                                             // 29
//     Send email address verification emails to new users created from                                          // 30
//     client signups.                                                                                           // 31
// - forbidClientAccountCreation {Boolean}                                                                       // 32
//     Do not allow clients to create accounts directly.                                                         // 33
// - restrictCreationByEmailDomain {Function or String}                                                          // 34
//     Require created users to have an email matching the function or                                           // 35
//     having the string as domain.                                                                              // 36
// - loginExpirationInDays {Number}                                                                              // 37
//     Number of days since login until a user is logged out (login token                                        // 38
//     expires).                                                                                                 // 39
//                                                                                                               // 40
Accounts.config = function(options) {                                                                            // 41
  // We don't want users to accidentally only call Accounts.config on the                                        // 42
  // client, where some of the options will have partial effects (eg removing                                    // 43
  // the "create account" button from accounts-ui if forbidClientAccountCreation                                 // 44
  // is set, or redirecting Google login to a specific-domain page) without                                      // 45
  // having their full effects.                                                                                  // 46
  if (Meteor.isServer) {                                                                                         // 47
    __meteor_runtime_config__.accountsConfigCalled = true;                                                       // 48
  } else if (!__meteor_runtime_config__.accountsConfigCalled) {                                                  // 49
    // XXX would be nice to "crash" the client and replace the UI with an error                                  // 50
    // message, but there's no trivial way to do this.                                                           // 51
    Meteor._debug("Accounts.config was called on the client but not on the " +                                   // 52
                  "server; some configuration options may not take effect.");                                    // 53
  }                                                                                                              // 54
                                                                                                                 // 55
  // validate option keys                                                                                        // 56
  var VALID_KEYS = ["sendVerificationEmail", "forbidClientAccountCreation",                                      // 57
                    "restrictCreationByEmailDomain", "loginExpirationInDays"];                                   // 58
  _.each(_.keys(options), function (key) {                                                                       // 59
    if (!_.contains(VALID_KEYS, key)) {                                                                          // 60
      throw new Error("Accounts.config: Invalid key: " + key);                                                   // 61
    }                                                                                                            // 62
  });                                                                                                            // 63
                                                                                                                 // 64
  // set values in Accounts._options                                                                             // 65
  _.each(VALID_KEYS, function (key) {                                                                            // 66
    if (key in options) {                                                                                        // 67
      if (key in Accounts._options) {                                                                            // 68
        throw new Error("Can't set `" + key + "` more than once");                                               // 69
      } else {                                                                                                   // 70
        Accounts._options[key] = options[key];                                                                   // 71
      }                                                                                                          // 72
    }                                                                                                            // 73
  });                                                                                                            // 74
                                                                                                                 // 75
  // If the user set loginExpirationInDays to null, then we need to clear the                                    // 76
  // timer that periodically expires tokens.                                                                     // 77
  if (Meteor.isServer)                                                                                           // 78
    maybeStopExpireTokensInterval();                                                                             // 79
};                                                                                                               // 80
                                                                                                                 // 81
if (Meteor.isClient) {                                                                                           // 82
  // The connection used by the Accounts system. This is the connection                                          // 83
  // that will get logged in by Meteor.login(), and this is the                                                  // 84
  // connection whose login state will be reflected by Meteor.userId().                                          // 85
  //                                                                                                             // 86
  // It would be much preferable for this to be in accounts_client.js,                                           // 87
  // but it has to be here because it's needed to create the                                                     // 88
  // Meteor.users collection.                                                                                    // 89
  Accounts.connection = Meteor.connection;                                                                       // 90
                                                                                                                 // 91
  if (typeof __meteor_runtime_config__ !== "undefined" &&                                                        // 92
      __meteor_runtime_config__.ACCOUNTS_CONNECTION_URL) {                                                       // 93
    // Temporary, internal hook to allow the server to point the client                                          // 94
    // to a different authentication server. This is for a very                                                  // 95
    // particular use case that comes up when implementing a oauth                                               // 96
    // server. Unsupported and may go away at any point in time.                                                 // 97
    //                                                                                                           // 98
    // We will eventually provide a general way to use account-base                                              // 99
    // against any DDP connection, not just one special one.                                                     // 100
    Accounts.connection = DDP.connect(                                                                           // 101
      __meteor_runtime_config__.ACCOUNTS_CONNECTION_URL)                                                         // 102
  }                                                                                                              // 103
}                                                                                                                // 104
                                                                                                                 // 105
// Users table. Don't use the normal autopublish, since we want to hide                                          // 106
// some fields. Code to autopublish this is in accounts_server.js.                                               // 107
// XXX Allow users to configure this collection name.                                                            // 108
//                                                                                                               // 109
Meteor.users = new Meteor.Collection("users", {                                                                  // 110
  _preventAutopublish: true,                                                                                     // 111
  connection: Meteor.isClient ? Accounts.connection : Meteor.connection                                          // 112
});                                                                                                              // 113
// There is an allow call in accounts_server that restricts this                                                 // 114
// collection.                                                                                                   // 115
                                                                                                                 // 116
// loginServiceConfiguration and ConfigError are maintained for backwards compatibility                          // 117
Meteor.startup(function () {                                                                                     // 118
  var ServiceConfiguration =                                                                                     // 119
    Package['service-configuration'].ServiceConfiguration;                                                       // 120
  Accounts.loginServiceConfiguration = ServiceConfiguration.configurations;                                      // 121
  Accounts.ConfigError = ServiceConfiguration.ConfigError;                                                       // 122
});                                                                                                              // 123
                                                                                                                 // 124
// Thrown when the user cancels the login process (eg, closes an oauth                                           // 125
// popup, declines retina scan, etc)                                                                             // 126
Accounts.LoginCancelledError = function(description) {                                                           // 127
  this.message = description;                                                                                    // 128
};                                                                                                               // 129
                                                                                                                 // 130
// This is used to transmit specific subclass errors over the wire. We should                                    // 131
// come up with a more generic way to do this (eg, with some sort of symbolic                                    // 132
// error code rather than a number).                                                                             // 133
Accounts.LoginCancelledError.numericError = 0x8acdc2f;                                                           // 134
Accounts.LoginCancelledError.prototype = new Error();                                                            // 135
Accounts.LoginCancelledError.prototype.name = 'Accounts.LoginCancelledError';                                    // 136
                                                                                                                 // 137
getTokenLifetimeMs = function () {                                                                               // 138
  return (Accounts._options.loginExpirationInDays ||                                                             // 139
          DEFAULT_LOGIN_EXPIRATION_DAYS) * 24 * 60 * 60 * 1000;                                                  // 140
};                                                                                                               // 141
                                                                                                                 // 142
Accounts._tokenExpiration = function (when) {                                                                    // 143
  // We pass when through the Date constructor for backwards compatibility;                                      // 144
  // `when` used to be a number.                                                                                 // 145
  return new Date((new Date(when)).getTime() + getTokenLifetimeMs());                                            // 146
};                                                                                                               // 147
                                                                                                                 // 148
Accounts._tokenExpiresSoon = function (when) {                                                                   // 149
  var minLifetimeMs = .1 * getTokenLifetimeMs();                                                                 // 150
  var minLifetimeCapMs = MIN_TOKEN_LIFETIME_CAP_SECS * 1000;                                                     // 151
  if (minLifetimeMs > minLifetimeCapMs)                                                                          // 152
    minLifetimeMs = minLifetimeCapMs;                                                                            // 153
  return new Date() > (new Date(when) - minLifetimeMs);                                                          // 154
};                                                                                                               // 155
                                                                                                                 // 156
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                               //
// packages/accounts-base/accounts_server.js                                                                     //
//                                                                                                               //
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                 //
var crypto = Npm.require('crypto');                                                                              // 1
                                                                                                                 // 2
///                                                                                                              // 3
/// CURRENT USER                                                                                                 // 4
///                                                                                                              // 5
                                                                                                                 // 6
Meteor.userId = function () {                                                                                    // 7
  // This function only works if called inside a method. In theory, it                                           // 8
  // could also be called from publish statements, since they also                                               // 9
  // have a userId associated with them. However, given that publish                                             // 10
  // functions aren't reactive, using any of the infomation from                                                 // 11
  // Meteor.user() in a publish function will always use the value                                               // 12
  // from when the function first runs. This is likely not what the                                              // 13
  // user expects. The way to make this work in a publish is to do                                               // 14
  // Meteor.find(this.userId()).observe and recompute when the user                                              // 15
  // record changes.                                                                                             // 16
  var currentInvocation = DDP._CurrentInvocation.get();                                                          // 17
  if (!currentInvocation)                                                                                        // 18
    throw new Error("Meteor.userId can only be invoked in method calls. Use this.userId in publish functions."); // 19
  return currentInvocation.userId;                                                                               // 20
};                                                                                                               // 21
                                                                                                                 // 22
Meteor.user = function () {                                                                                      // 23
  var userId = Meteor.userId();                                                                                  // 24
  if (!userId)                                                                                                   // 25
    return null;                                                                                                 // 26
  return Meteor.users.findOne(userId);                                                                           // 27
};                                                                                                               // 28
                                                                                                                 // 29
///                                                                                                              // 30
/// LOGIN HANDLERS                                                                                               // 31
///                                                                                                              // 32
                                                                                                                 // 33
// The main entry point for auth packages to hook in to login.                                                   // 34
//                                                                                                               // 35
// @param handler {Function} A function that receives an options object                                          // 36
// (as passed as an argument to the `login` method) and returns one of:                                          // 37
// - `undefined`, meaning don't handle;                                                                          // 38
// - {id: userId, token: *, tokenExpires: *}, if the user logged in                                              // 39
//   successfully. tokenExpires is optional and intends to provide a hint to the                                 // 40
//   client as to when the token will expire. If not provided, the client will                                   // 41
//   call Accounts._tokenExpiration, passing it the date that it received the                                    // 42
//   token.                                                                                                      // 43
// - throw an error, if the user failed to log in.                                                               // 44
//                                                                                                               // 45
Accounts.registerLoginHandler = function(handler) {                                                              // 46
  loginHandlers.push(handler);                                                                                   // 47
};                                                                                                               // 48
                                                                                                                 // 49
// list of all registered handlers.                                                                              // 50
loginHandlers = [];                                                                                              // 51
                                                                                                                 // 52
                                                                                                                 // 53
// Checks a user's credentials against all the registered login                                                  // 54
// handlers, and returns a login token if the credentials are valid. It                                          // 55
// is like the login method, except that it doesn't set the logged-in                                            // 56
// user on the connection. Throws a Meteor.Error if logging in fails,                                            // 57
// including the case where none of the login handlers handled the login                                         // 58
// request. Otherwise, returns {id: userId, token: *, tokenExpires: *}.                                          // 59
//                                                                                                               // 60
// For example, if you want to login with a plaintext password, `options` could be                               // 61
//   { user: { username: <username> }, password: <password> }, or                                                // 62
//   { user: { email: <email> }, password: <password> }.                                                         // 63
Accounts._runLoginHandlers = function (options) {                                                                // 64
  // Try all of the registered login handlers until one of them doesn't return                                   // 65
  // `undefined`, meaning it handled this call to `login`. Return that return                                    // 66
  // value, which ought to be a {id/token} pair.                                                                 // 67
  for (var i = 0; i < loginHandlers.length; ++i) {                                                               // 68
    var handler = loginHandlers[i];                                                                              // 69
    var result = handler.apply(this, [options]);                                                                 // 70
    if (result !== undefined)                                                                                    // 71
      return result;                                                                                             // 72
  }                                                                                                              // 73
  throw new Meteor.Error(400, "Unrecognized options for login request");                                         // 74
};                                                                                                               // 75
                                                                                                                 // 76
// Deletes the given loginToken from the database.                                                               // 77
//                                                                                                               // 78
// For new-style hashed token, this will cause all connections                                                   // 79
// associated with the token to be closed.                                                                       // 80
//                                                                                                               // 81
// Any connections associated with old-style unhashed tokens will be                                             // 82
// in the process of becoming associated with hashed tokens and then                                             // 83
// they'll get closed.                                                                                           // 84
Accounts.destroyToken = function (userId, loginToken) {                                                          // 85
  Meteor.users.update(userId, {                                                                                  // 86
    $pull: {                                                                                                     // 87
      "services.resume.loginTokens": {                                                                           // 88
        $or: [                                                                                                   // 89
          { hashedToken: loginToken },                                                                           // 90
          { token: loginToken }                                                                                  // 91
        ]                                                                                                        // 92
      }                                                                                                          // 93
    }                                                                                                            // 94
  });                                                                                                            // 95
};                                                                                                               // 96
                                                                                                                 // 97
// Actual methods for login and logout. This is the entry point for                                              // 98
// clients to actually log in.                                                                                   // 99
Meteor.methods({                                                                                                 // 100
  // @returns {Object|null}                                                                                      // 101
  //   If successful, returns {token: reconnectToken, id: userId}                                                // 102
  //   If unsuccessful (for example, if the user closed the oauth login popup),                                  // 103
  //     returns null                                                                                            // 104
  login: function(options) {                                                                                     // 105
    var self = this;                                                                                             // 106
                                                                                                                 // 107
    // Login handlers should really also check whatever field they look at in                                    // 108
    // options, but we don't enforce it.                                                                         // 109
    check(options, Object);                                                                                      // 110
    var result = Accounts._runLoginHandlers.apply(this, [options]);                                              // 111
    if (result !== null) {                                                                                       // 112
      // This order (and the avoidance of yields) is important to make                                           // 113
      // sure that when publish functions are rerun, they see a                                                  // 114
      // consistent view of the world: this.userId is set and matches                                            // 115
      // the login token on the connection (not that there is                                                    // 116
      // currently a public API for reading the login token on a                                                 // 117
      // connection).                                                                                            // 118
      Meteor._noYieldsAllowed(function () {                                                                      // 119
        Accounts._setLoginToken(                                                                                 // 120
          result.id,                                                                                             // 121
          self.connection,                                                                                       // 122
          Accounts._hashLoginToken(result.token)                                                                 // 123
        );                                                                                                       // 124
      });                                                                                                        // 125
      self.setUserId(result.id);                                                                                 // 126
    }                                                                                                            // 127
    return result;                                                                                               // 128
  },                                                                                                             // 129
                                                                                                                 // 130
  logout: function() {                                                                                           // 131
    var token = Accounts._getLoginToken(this.connection.id);                                                     // 132
    Accounts._setLoginToken(this.userId, this.connection, null);                                                 // 133
    if (token && this.userId)                                                                                    // 134
      Accounts.destroyToken(this.userId, token);                                                                 // 135
    this.setUserId(null);                                                                                        // 136
  },                                                                                                             // 137
                                                                                                                 // 138
  // Delete all the current user's tokens and close all open connections logged                                  // 139
  // in as this user. Returns a fresh new login token that this client can                                       // 140
  // use. Tests set Accounts._noConnectionCloseDelayForTest to delete tokens                                     // 141
  // immediately instead of using a delay.                                                                       // 142
  //                                                                                                             // 143
  // @returns {Object} Object with token and tokenExpires keys.                                                  // 144
  logoutOtherClients: function () {                                                                              // 145
    var self = this;                                                                                             // 146
    var user = Meteor.users.findOne(self.userId, {                                                               // 147
      fields: {                                                                                                  // 148
        "services.resume.loginTokens": true                                                                      // 149
      }                                                                                                          // 150
    });                                                                                                          // 151
    if (user) {                                                                                                  // 152
      // Save the current tokens in the database to be deleted in                                                // 153
      // CONNECTION_CLOSE_DELAY_MS ms. This gives other connections in the                                       // 154
      // caller's browser time to find the fresh token in localStorage. We save                                  // 155
      // the tokens in the database in case we crash before actually deleting                                    // 156
      // them.                                                                                                   // 157
      var tokens = user.services.resume.loginTokens;                                                             // 158
      var newToken = Accounts._generateStampedLoginToken();                                                      // 159
      var userId = self.userId;                                                                                  // 160
      Meteor.users.update(self.userId, {                                                                         // 161
        $set: {                                                                                                  // 162
          "services.resume.loginTokensToDelete": tokens,                                                         // 163
          "services.resume.haveLoginTokensToDelete": true                                                        // 164
        },                                                                                                       // 165
        $push: { "services.resume.loginTokens": Accounts._hashStampedToken(newToken) }                           // 166
      });                                                                                                        // 167
      Meteor.setTimeout(function () {                                                                            // 168
        // The observe on Meteor.users will take care of closing the connections                                 // 169
        // associated with `tokens`.                                                                             // 170
        deleteSavedTokens(userId, tokens);                                                                       // 171
      }, Accounts._noConnectionCloseDelayForTest ? 0 :                                                           // 172
                        CONNECTION_CLOSE_DELAY_MS);                                                              // 173
      // We do not set the login token on this connection, but instead the                                       // 174
      // observe closes the connection and the client will reconnect with the                                    // 175
      // new token.                                                                                              // 176
      return {                                                                                                   // 177
        token: newToken.token,                                                                                   // 178
        tokenExpires: Accounts._tokenExpiration(newToken.when)                                                   // 179
      };                                                                                                         // 180
    } else {                                                                                                     // 181
      throw new Error("You are not logged in.");                                                                 // 182
    }                                                                                                            // 183
  }                                                                                                              // 184
});                                                                                                              // 185
                                                                                                                 // 186
///                                                                                                              // 187
/// ACCOUNT DATA                                                                                                 // 188
///                                                                                                              // 189
                                                                                                                 // 190
// connectionId -> {connection, loginToken, srpChallenge}                                                        // 191
var accountData = {};                                                                                            // 192
                                                                                                                 // 193
// HACK: This is used by 'meteor-accounts' to get the loginToken for a                                           // 194
// connection. Maybe there should be a public way to do that.                                                    // 195
Accounts._getAccountData = function (connectionId, field) {                                                      // 196
  var data = accountData[connectionId];                                                                          // 197
  return data && data[field];                                                                                    // 198
};                                                                                                               // 199
                                                                                                                 // 200
Accounts._setAccountData = function (connectionId, field, value) {                                               // 201
  var data = accountData[connectionId];                                                                          // 202
                                                                                                                 // 203
  // safety belt. shouldn't happen. accountData is set in onConnection,                                          // 204
  // we don't have a connectionId until it is set.                                                               // 205
  if (!data)                                                                                                     // 206
    return;                                                                                                      // 207
                                                                                                                 // 208
  if (value === undefined)                                                                                       // 209
    delete data[field];                                                                                          // 210
  else                                                                                                           // 211
    data[field] = value;                                                                                         // 212
};                                                                                                               // 213
                                                                                                                 // 214
Meteor.server.onConnection(function (connection) {                                                               // 215
  accountData[connection.id] = {connection: connection};                                                         // 216
  connection.onClose(function () {                                                                               // 217
    removeConnectionFromToken(connection.id);                                                                    // 218
    delete accountData[connection.id];                                                                           // 219
  });                                                                                                            // 220
});                                                                                                              // 221
                                                                                                                 // 222
                                                                                                                 // 223
///                                                                                                              // 224
/// RECONNECT TOKENS                                                                                             // 225
///                                                                                                              // 226
/// support reconnecting using a meteor login token                                                              // 227
                                                                                                                 // 228
Accounts._hashLoginToken = function (loginToken) {                                                               // 229
  var hash = crypto.createHash('sha256');                                                                        // 230
  hash.update(loginToken);                                                                                       // 231
  return hash.digest('base64');                                                                                  // 232
};                                                                                                               // 233
                                                                                                                 // 234
                                                                                                                 // 235
// {token, when} => {hashedToken, when}                                                                          // 236
Accounts._hashStampedToken = function (stampedToken) {                                                           // 237
  return _.extend(                                                                                               // 238
    _.omit(stampedToken, 'token'),                                                                               // 239
    {hashedToken: Accounts._hashLoginToken(stampedToken.token)}                                                  // 240
  );                                                                                                             // 241
};                                                                                                               // 242
                                                                                                                 // 243
                                                                                                                 // 244
// hashed token -> list of connection ids                                                                        // 245
var connectionsByLoginToken = {};                                                                                // 246
                                                                                                                 // 247
// test hook                                                                                                     // 248
Accounts._getTokenConnections = function (token) {                                                               // 249
  return connectionsByLoginToken[token];                                                                         // 250
};                                                                                                               // 251
                                                                                                                 // 252
// Remove the connection from the list of open connections for the connection's                                  // 253
// token.                                                                                                        // 254
var removeConnectionFromToken = function (connectionId) {                                                        // 255
  var token = Accounts._getLoginToken(connectionId);                                                             // 256
  if (token) {                                                                                                   // 257
    connectionsByLoginToken[token] = _.without(                                                                  // 258
      connectionsByLoginToken[token],                                                                            // 259
      connectionId                                                                                               // 260
    );                                                                                                           // 261
    if (_.isEmpty(connectionsByLoginToken[token]))                                                               // 262
      delete connectionsByLoginToken[token];                                                                     // 263
  }                                                                                                              // 264
};                                                                                                               // 265
                                                                                                                 // 266
Accounts._getLoginToken = function (connectionId) {                                                              // 267
  return Accounts._getAccountData(connectionId, 'loginToken');                                                   // 268
};                                                                                                               // 269
                                                                                                                 // 270
// newToken is a hashed token.                                                                                   // 271
Accounts._setLoginToken = function (userId, connection, newToken) {                                              // 272
  removeConnectionFromToken(connection.id);                                                                      // 273
  Accounts._setAccountData(connection.id, 'loginToken', newToken);                                               // 274
                                                                                                                 // 275
  if (newToken) {                                                                                                // 276
    if (! _.has(connectionsByLoginToken, newToken))                                                              // 277
      connectionsByLoginToken[newToken] = [];                                                                    // 278
    connectionsByLoginToken[newToken].push(connection.id);                                                       // 279
                                                                                                                 // 280
    // Now that we've added the connection to the                                                                // 281
    // connectionsByLoginToken map for the token, the connection will                                            // 282
    // be closed if the token is removed from the database.  However                                             // 283
    // at this point the token might have already been deleted, which                                            // 284
    // wouldn't have closed the connection because it wasn't in the                                              // 285
    // map yet.                                                                                                  // 286
    //                                                                                                           // 287
    // We also did need to first add the connection to the map above                                             // 288
    // (and now remove it here if the token was deleted), because we                                             // 289
    // could be getting a response from the database that the token                                              // 290
    // still exists, but then it could be deleted in another fiber                                               // 291
    // before our `findOne` call returns... and then that other fiber                                            // 292
    // would need for the connection to be in the map for it to close                                            // 293
    // the connection.                                                                                           // 294
    //                                                                                                           // 295
    // We defer this check because there's no need for it to be on the critical                                  // 296
    // path for login; we just need to ensure that the connection will get                                       // 297
    // closed at some point if the token has been deleted.                                                       // 298
    Meteor.defer(function () {                                                                                   // 299
      if (! Meteor.users.findOne({                                                                               // 300
        _id: userId,                                                                                             // 301
        "services.resume.loginTokens.hashedToken": newToken                                                      // 302
      })) {                                                                                                      // 303
        removeConnectionFromToken(connection.id);                                                                // 304
        connection.close();                                                                                      // 305
      }                                                                                                          // 306
    });                                                                                                          // 307
  }                                                                                                              // 308
};                                                                                                               // 309
                                                                                                                 // 310
// Close all open connections associated with any of the tokens in                                               // 311
// `tokens`.                                                                                                     // 312
var closeConnectionsForTokens = function (tokens) {                                                              // 313
  _.each(tokens, function (token) {                                                                              // 314
    if (_.has(connectionsByLoginToken, token)) {                                                                 // 315
      // safety belt. close should defer potentially yielding callbacks.                                         // 316
      Meteor._noYieldsAllowed(function () {                                                                      // 317
        _.each(connectionsByLoginToken[token], function (connectionId) {                                         // 318
          var connection = Accounts._getAccountData(connectionId, 'connection');                                 // 319
          if (connection)                                                                                        // 320
            connection.close();                                                                                  // 321
        });                                                                                                      // 322
      });                                                                                                        // 323
    }                                                                                                            // 324
  });                                                                                                            // 325
};                                                                                                               // 326
                                                                                                                 // 327
                                                                                                                 // 328
// Login handler for resume tokens.                                                                              // 329
Accounts.registerLoginHandler(function(options) {                                                                // 330
  if (!options.resume)                                                                                           // 331
    return undefined;                                                                                            // 332
                                                                                                                 // 333
  check(options.resume, String);                                                                                 // 334
                                                                                                                 // 335
  var hashedToken = Accounts._hashLoginToken(options.resume);                                                    // 336
                                                                                                                 // 337
  // First look for just the new-style hashed login token, to avoid                                              // 338
  // sending the unhashed token to the database in a query if we don't                                           // 339
  // need to.                                                                                                    // 340
  var user = Meteor.users.findOne(                                                                               // 341
    {"services.resume.loginTokens.hashedToken": hashedToken});                                                   // 342
                                                                                                                 // 343
  if (! user) {                                                                                                  // 344
    // If we didn't find the hashed login token, try also looking for                                            // 345
    // the old-style unhashed token.  But we need to look for either                                             // 346
    // the old-style token OR the new-style token, because another                                               // 347
    // client connection logging in simultaneously might have already                                            // 348
    // converted the token.                                                                                      // 349
    user = Meteor.users.findOne({                                                                                // 350
      $or: [                                                                                                     // 351
        {"services.resume.loginTokens.hashedToken": hashedToken},                                                // 352
        {"services.resume.loginTokens.token": options.resume}                                                    // 353
      ]                                                                                                          // 354
    });                                                                                                          // 355
  }                                                                                                              // 356
                                                                                                                 // 357
  if (! user) {                                                                                                  // 358
    throw new Meteor.Error(403, "You've been logged out by the server. " +                                       // 359
    "Please login again.");                                                                                      // 360
  }                                                                                                              // 361
                                                                                                                 // 362
  // Find the token, which will either be an object with fields                                                  // 363
  // {hashedToken, when} for a hashed token or {token, when} for an                                              // 364
  // unhashed token.                                                                                             // 365
  var oldUnhashedStyleToken;                                                                                     // 366
  var token = _.find(user.services.resume.loginTokens, function (token) {                                        // 367
    return token.hashedToken === hashedToken;                                                                    // 368
  });                                                                                                            // 369
  if (token) {                                                                                                   // 370
    oldUnhashedStyleToken = false;                                                                               // 371
  } else {                                                                                                       // 372
    token = _.find(user.services.resume.loginTokens, function (token) {                                          // 373
      return token.token === options.resume;                                                                     // 374
    });                                                                                                          // 375
    oldUnhashedStyleToken = true;                                                                                // 376
  }                                                                                                              // 377
                                                                                                                 // 378
  var tokenExpires = Accounts._tokenExpiration(token.when);                                                      // 379
  if (new Date() >= tokenExpires)                                                                                // 380
    throw new Meteor.Error(403, "Your session has expired. Please login again.");                                // 381
                                                                                                                 // 382
  // Update to a hashed token when an unhashed token is encountered.                                             // 383
  if (oldUnhashedStyleToken) {                                                                                   // 384
    // Only add the new hashed token if the old unhashed token still                                             // 385
    // exists (this avoids resurrecting the token if it was deleted                                              // 386
    // after we read it).  Using $addToSet avoids getting an index                                               // 387
    // error if another client logging in simultaneously has already                                             // 388
    // inserted the new hashed token.                                                                            // 389
    Meteor.users.update(                                                                                         // 390
      {                                                                                                          // 391
        _id: user._id,                                                                                           // 392
        "services.resume.loginTokens.token": options.resume                                                      // 393
      },                                                                                                         // 394
      {$addToSet: {                                                                                              // 395
        "services.resume.loginTokens": {                                                                         // 396
          "hashedToken": hashedToken,                                                                            // 397
          "when": token.when                                                                                     // 398
        }                                                                                                        // 399
      }}                                                                                                         // 400
    );                                                                                                           // 401
                                                                                                                 // 402
    // Remove the old token *after* adding the new, since otherwise                                              // 403
    // another client trying to login between our removing the old and                                           // 404
    // adding the new wouldn't find a token to login with.                                                       // 405
    Meteor.users.update(user._id, {                                                                              // 406
      $pull: {                                                                                                   // 407
        "services.resume.loginTokens": { "token": options.resume }                                               // 408
      },                                                                                                         // 409
    });                                                                                                          // 410
  }                                                                                                              // 411
                                                                                                                 // 412
  return {                                                                                                       // 413
    token: options.resume,                                                                                       // 414
    tokenExpires: tokenExpires,                                                                                  // 415
    id: user._id                                                                                                 // 416
  };                                                                                                             // 417
});                                                                                                              // 418
                                                                                                                 // 419
// Semi-public. Used by other login methods to generate tokens.                                                  // 420
// (Also used by Meteor Accounts server)                                                                         // 421
//                                                                                                               // 422
Accounts._generateStampedLoginToken = function () {                                                              // 423
  return {token: Random.id(), when: (new Date)};                                                                 // 424
};                                                                                                               // 425
                                                                                                                 // 426
///                                                                                                              // 427
/// TOKEN EXPIRATION                                                                                             // 428
///                                                                                                              // 429
                                                                                                                 // 430
var expireTokenInterval;                                                                                         // 431
                                                                                                                 // 432
// Deletes expired tokens from the database and closes all open connections                                      // 433
// associated with these tokens.                                                                                 // 434
//                                                                                                               // 435
// Exported for tests. Also, the arguments are only used by                                                      // 436
// tests. oldestValidDate is simulate expiring tokens without waiting                                            // 437
// for them to actually expire. userId is used by tests to only expire                                           // 438
// tokens for the test user.                                                                                     // 439
var expireTokens = Accounts._expireTokens = function (oldestValidDate, userId) {                                 // 440
  var tokenLifetimeMs = getTokenLifetimeMs();                                                                    // 441
                                                                                                                 // 442
  // when calling from a test with extra arguments, you must specify both!                                       // 443
  if ((oldestValidDate && !userId) || (!oldestValidDate && userId)) {                                            // 444
    throw new Error("Bad test. Must specify both oldestValidDate and userId.");                                  // 445
  }                                                                                                              // 446
                                                                                                                 // 447
  oldestValidDate = oldestValidDate ||                                                                           // 448
    (new Date(new Date() - tokenLifetimeMs));                                                                    // 449
  var userFilter = userId ? {_id: userId} : {};                                                                  // 450
                                                                                                                 // 451
                                                                                                                 // 452
  // Backwards compatible with older versions of meteor that stored login token                                  // 453
  // timestamps as numbers.                                                                                      // 454
  Meteor.users.update(_.extend(userFilter, {                                                                     // 455
    $or: [                                                                                                       // 456
      { "services.resume.loginTokens.when": { $lt: oldestValidDate } },                                          // 457
      { "services.resume.loginTokens.when": { $lt: +oldestValidDate } }                                          // 458
    ]                                                                                                            // 459
  }), {                                                                                                          // 460
    $pull: {                                                                                                     // 461
      "services.resume.loginTokens": {                                                                           // 462
        $or: [                                                                                                   // 463
          { when: { $lt: oldestValidDate } },                                                                    // 464
          { when: { $lt: +oldestValidDate } }                                                                    // 465
        ]                                                                                                        // 466
      }                                                                                                          // 467
    }                                                                                                            // 468
  }, { multi: true });                                                                                           // 469
  // The observe on Meteor.users will take care of closing connections for                                       // 470
  // expired tokens.                                                                                             // 471
};                                                                                                               // 472
                                                                                                                 // 473
maybeStopExpireTokensInterval = function () {                                                                    // 474
  if (_.has(Accounts._options, "loginExpirationInDays") &&                                                       // 475
      Accounts._options.loginExpirationInDays === null &&                                                        // 476
      expireTokenInterval) {                                                                                     // 477
    Meteor.clearInterval(expireTokenInterval);                                                                   // 478
    expireTokenInterval = null;                                                                                  // 479
  }                                                                                                              // 480
};                                                                                                               // 481
                                                                                                                 // 482
expireTokenInterval = Meteor.setInterval(expireTokens,                                                           // 483
                                         EXPIRE_TOKENS_INTERVAL_MS);                                             // 484
                                                                                                                 // 485
///                                                                                                              // 486
/// CREATE USER HOOKS                                                                                            // 487
///                                                                                                              // 488
                                                                                                                 // 489
var onCreateUserHook = null;                                                                                     // 490
Accounts.onCreateUser = function (func) {                                                                        // 491
  if (onCreateUserHook)                                                                                          // 492
    throw new Error("Can only call onCreateUser once");                                                          // 493
  else                                                                                                           // 494
    onCreateUserHook = func;                                                                                     // 495
};                                                                                                               // 496
                                                                                                                 // 497
// XXX see comment on Accounts.createUser in passwords_server about adding a                                     // 498
// second "server options" argument.                                                                             // 499
var defaultCreateUserHook = function (options, user) {                                                           // 500
  if (options.profile)                                                                                           // 501
    user.profile = options.profile;                                                                              // 502
  return user;                                                                                                   // 503
};                                                                                                               // 504
                                                                                                                 // 505
// Called by accounts-password                                                                                   // 506
Accounts.insertUserDoc = function (options, user) {                                                              // 507
  // - clone user document, to protect from modification                                                         // 508
  // - add createdAt timestamp                                                                                   // 509
  // - prepare an _id, so that you can modify other collections (eg                                              // 510
  // create a first task for every new user)                                                                     // 511
  //                                                                                                             // 512
  // XXX If the onCreateUser or validateNewUser hooks fail, we might                                             // 513
  // end up having modified some other collection                                                                // 514
  // inappropriately. The solution is probably to have onCreateUser                                              // 515
  // accept two callbacks - one that gets called before inserting                                                // 516
  // the user document (in which you can modify its contents), and                                               // 517
  // one that gets called after (in which you should change other                                                // 518
  // collections)                                                                                                // 519
  user = _.extend({createdAt: new Date(), _id: Random.id()}, user);                                              // 520
                                                                                                                 // 521
  var result = {};                                                                                               // 522
  if (options.generateLoginToken) {                                                                              // 523
    var stampedToken = Accounts._generateStampedLoginToken();                                                    // 524
    result.token = stampedToken.token;                                                                           // 525
    result.tokenExpires = Accounts._tokenExpiration(stampedToken.when);                                          // 526
    var token = Accounts._hashStampedToken(stampedToken);                                                        // 527
    Meteor._ensure(user, 'services', 'resume');                                                                  // 528
    if (_.has(user.services.resume, 'loginTokens'))                                                              // 529
      user.services.resume.loginTokens.push(token);                                                              // 530
    else                                                                                                         // 531
      user.services.resume.loginTokens = [token];                                                                // 532
  }                                                                                                              // 533
                                                                                                                 // 534
  var fullUser;                                                                                                  // 535
  if (onCreateUserHook) {                                                                                        // 536
    fullUser = onCreateUserHook(options, user);                                                                  // 537
                                                                                                                 // 538
    // This is *not* part of the API. We need this because we can't isolate                                      // 539
    // the global server environment between tests, meaning we can't test                                        // 540
    // both having a create user hook set and not having one set.                                                // 541
    if (fullUser === 'TEST DEFAULT HOOK')                                                                        // 542
      fullUser = defaultCreateUserHook(options, user);                                                           // 543
  } else {                                                                                                       // 544
    fullUser = defaultCreateUserHook(options, user);                                                             // 545
  }                                                                                                              // 546
                                                                                                                 // 547
  _.each(validateNewUserHooks, function (hook) {                                                                 // 548
    if (!hook(fullUser))                                                                                         // 549
      throw new Meteor.Error(403, "User validation failed");                                                     // 550
  });                                                                                                            // 551
                                                                                                                 // 552
  try {                                                                                                          // 553
    result.id = Meteor.users.insert(fullUser);                                                                   // 554
  } catch (e) {                                                                                                  // 555
    // XXX string parsing sucks, maybe                                                                           // 556
    // https://jira.mongodb.org/browse/SERVER-3069 will get fixed one day                                        // 557
    if (e.name !== 'MongoError') throw e;                                                                        // 558
    var match = e.err.match(/^E11000 duplicate key error index: ([^ ]+)/);                                       // 559
    if (!match) throw e;                                                                                         // 560
    if (match[1].indexOf('$emails.address') !== -1)                                                              // 561
      throw new Meteor.Error(403, "Email already exists.");                                                      // 562
    if (match[1].indexOf('username') !== -1)                                                                     // 563
      throw new Meteor.Error(403, "Username already exists.");                                                   // 564
    // XXX better error reporting for services.facebook.id duplicate, etc                                        // 565
    throw e;                                                                                                     // 566
  }                                                                                                              // 567
                                                                                                                 // 568
  return result;                                                                                                 // 569
};                                                                                                               // 570
                                                                                                                 // 571
var validateNewUserHooks = [];                                                                                   // 572
Accounts.validateNewUser = function (func) {                                                                     // 573
  validateNewUserHooks.push(func);                                                                               // 574
};                                                                                                               // 575
                                                                                                                 // 576
// XXX Find a better place for this utility function                                                             // 577
// Like Perl's quotemeta: quotes all regexp metacharacters. See                                                  // 578
//   https://github.com/substack/quotemeta/blob/master/index.js                                                  // 579
var quotemeta = function (str) {                                                                                 // 580
    return String(str).replace(/(\W)/g, '\\$1');                                                                 // 581
};                                                                                                               // 582
                                                                                                                 // 583
// Helper function: returns false if email does not match company domain from                                    // 584
// the configuration.                                                                                            // 585
var testEmailDomain = function (email) {                                                                         // 586
  var domain = Accounts._options.restrictCreationByEmailDomain;                                                  // 587
  return !domain ||                                                                                              // 588
    (_.isFunction(domain) && domain(email)) ||                                                                   // 589
    (_.isString(domain) &&                                                                                       // 590
      (new RegExp('@' + quotemeta(domain) + '$', 'i')).test(email));                                             // 591
};                                                                                                               // 592
                                                                                                                 // 593
// Validate new user's email or Google/Facebook/GitHub account's email                                           // 594
Accounts.validateNewUser(function (user) {                                                                       // 595
  var domain = Accounts._options.restrictCreationByEmailDomain;                                                  // 596
  if (!domain)                                                                                                   // 597
    return true;                                                                                                 // 598
                                                                                                                 // 599
  var emailIsGood = false;                                                                                       // 600
  if (!_.isEmpty(user.emails)) {                                                                                 // 601
    emailIsGood = _.any(user.emails, function (email) {                                                          // 602
      return testEmailDomain(email.address);                                                                     // 603
    });                                                                                                          // 604
  } else if (!_.isEmpty(user.services)) {                                                                        // 605
    // Find any email of any service and check it                                                                // 606
    emailIsGood = _.any(user.services, function (service) {                                                      // 607
      return service.email && testEmailDomain(service.email);                                                    // 608
    });                                                                                                          // 609
  }                                                                                                              // 610
                                                                                                                 // 611
  if (emailIsGood)                                                                                               // 612
    return true;                                                                                                 // 613
                                                                                                                 // 614
  if (_.isString(domain))                                                                                        // 615
    throw new Meteor.Error(403, "@" + domain + " email required");                                               // 616
  else                                                                                                           // 617
    throw new Meteor.Error(403, "Email doesn't match the criteria.");                                            // 618
});                                                                                                              // 619
                                                                                                                 // 620
///                                                                                                              // 621
/// MANAGING USER OBJECTS                                                                                        // 622
///                                                                                                              // 623
                                                                                                                 // 624
// Updates or creates a user after we authenticate with a 3rd party.                                             // 625
//                                                                                                               // 626
// @param serviceName {String} Service name (eg, twitter).                                                       // 627
// @param serviceData {Object} Data to store in the user's record                                                // 628
//        under services[serviceName]. Must include an "id" field                                                // 629
//        which is a unique identifier for the user in the service.                                              // 630
// @param options {Object, optional} Other options to pass to insertUserDoc                                      // 631
//        (eg, profile)                                                                                          // 632
// @returns {Object} Object with token and id keys, like the result                                              // 633
//        of the "login" method.                                                                                 // 634
//                                                                                                               // 635
Accounts.updateOrCreateUserFromExternalService = function(                                                       // 636
  serviceName, serviceData, options) {                                                                           // 637
  options = _.clone(options || {});                                                                              // 638
                                                                                                                 // 639
  if (serviceName === "password" || serviceName === "resume")                                                    // 640
    throw new Error(                                                                                             // 641
      "Can't use updateOrCreateUserFromExternalService with internal service "                                   // 642
        + serviceName);                                                                                          // 643
  if (!_.has(serviceData, 'id'))                                                                                 // 644
    throw new Error(                                                                                             // 645
      "Service data for service " + serviceName + " must include id");                                           // 646
                                                                                                                 // 647
  // Look for a user with the appropriate service user id.                                                       // 648
  var selector = {};                                                                                             // 649
  var serviceIdKey = "services." + serviceName + ".id";                                                          // 650
                                                                                                                 // 651
  // XXX Temporary special case for Twitter. (Issue #629)                                                        // 652
  //   The serviceData.id will be a string representation of an integer.                                         // 653
  //   We want it to match either a stored string or int representation.                                         // 654
  //   This is to cater to earlier versions of Meteor storing twitter                                            // 655
  //   user IDs in number form, and recent versions storing them as strings.                                     // 656
  //   This can be removed once migration technology is in place, and twitter                                    // 657
  //   users stored with integer IDs have been migrated to string IDs.                                           // 658
  if (serviceName === "twitter" && !isNaN(serviceData.id)) {                                                     // 659
    selector["$or"] = [{},{}];                                                                                   // 660
    selector["$or"][0][serviceIdKey] = serviceData.id;                                                           // 661
    selector["$or"][1][serviceIdKey] = parseInt(serviceData.id, 10);                                             // 662
  } else {                                                                                                       // 663
    selector[serviceIdKey] = serviceData.id;                                                                     // 664
  }                                                                                                              // 665
                                                                                                                 // 666
  var user = Meteor.users.findOne(selector);                                                                     // 667
                                                                                                                 // 668
  if (user) {                                                                                                    // 669
    // We *don't* process options (eg, profile) for update, but we do replace                                    // 670
    // the serviceData (eg, so that we keep an unexpired access token and                                        // 671
    // don't cache old email addresses in serviceData.email).                                                    // 672
    // XXX provide an onUpdateUser hook which would let apps update                                              // 673
    //     the profile too                                                                                       // 674
    var stampedToken = Accounts._generateStampedLoginToken();                                                    // 675
    var setAttrs = {};                                                                                           // 676
    _.each(serviceData, function(value, key) {                                                                   // 677
      setAttrs["services." + serviceName + "." + key] = value;                                                   // 678
    });                                                                                                          // 679
                                                                                                                 // 680
    // XXX Maybe we should re-use the selector above and notice if the update                                    // 681
    //     touches nothing?                                                                                      // 682
    Meteor.users.update(                                                                                         // 683
      user._id,                                                                                                  // 684
      {$set: setAttrs,                                                                                           // 685
       $push: {'services.resume.loginTokens': Accounts._hashStampedToken(stampedToken)}});                       // 686
    return {                                                                                                     // 687
      token: stampedToken.token,                                                                                 // 688
      id: user._id,                                                                                              // 689
      tokenExpires: Accounts._tokenExpiration(stampedToken.when)                                                 // 690
    };                                                                                                           // 691
  } else {                                                                                                       // 692
    // Create a new user with the service data. Pass other options through to                                    // 693
    // insertUserDoc.                                                                                            // 694
    user = {services: {}};                                                                                       // 695
    user.services[serviceName] = serviceData;                                                                    // 696
    options.generateLoginToken = true;                                                                           // 697
    return Accounts.insertUserDoc(options, user);                                                                // 698
  }                                                                                                              // 699
};                                                                                                               // 700
                                                                                                                 // 701
                                                                                                                 // 702
///                                                                                                              // 703
/// PUBLISHING DATA                                                                                              // 704
///                                                                                                              // 705
                                                                                                                 // 706
// Publish the current user's record to the client.                                                              // 707
Meteor.publish(null, function() {                                                                                // 708
  if (this.userId) {                                                                                             // 709
    return Meteor.users.find(                                                                                    // 710
      {_id: this.userId},                                                                                        // 711
      {fields: {profile: 1, username: 1, emails: 1}});                                                           // 712
  } else {                                                                                                       // 713
    return null;                                                                                                 // 714
  }                                                                                                              // 715
}, /*suppress autopublish warning*/{is_auto: true});                                                             // 716
                                                                                                                 // 717
// If autopublish is on, publish these user fields. Login service                                                // 718
// packages (eg accounts-google) add to these by calling                                                         // 719
// Accounts.addAutopublishFields Notably, this isn't implemented with                                            // 720
// multiple publishes since DDP only merges only across top-level                                                // 721
// fields, not subfields (such as 'services.facebook.accessToken')                                               // 722
var autopublishFields = {                                                                                        // 723
  loggedInUser: ['profile', 'username', 'emails'],                                                               // 724
  otherUsers: ['profile', 'username']                                                                            // 725
};                                                                                                               // 726
                                                                                                                 // 727
// Add to the list of fields or subfields to be automatically                                                    // 728
// published if autopublish is on. Must be called from top-level                                                 // 729
// code (ie, before Meteor.startup hooks run).                                                                   // 730
//                                                                                                               // 731
// @param opts {Object} with:                                                                                    // 732
//   - forLoggedInUser {Array} Array of fields published to the logged-in user                                   // 733
//   - forOtherUsers {Array} Array of fields published to users that aren't logged in                            // 734
Accounts.addAutopublishFields = function(opts) {                                                                 // 735
  autopublishFields.loggedInUser.push.apply(                                                                     // 736
    autopublishFields.loggedInUser, opts.forLoggedInUser);                                                       // 737
  autopublishFields.otherUsers.push.apply(                                                                       // 738
    autopublishFields.otherUsers, opts.forOtherUsers);                                                           // 739
};                                                                                                               // 740
                                                                                                                 // 741
if (Package.autopublish) {                                                                                       // 742
  // Use Meteor.startup to give other packages a chance to call                                                  // 743
  // addAutopublishFields.                                                                                       // 744
  Meteor.startup(function () {                                                                                   // 745
    // ['profile', 'username'] -> {profile: 1, username: 1}                                                      // 746
    var toFieldSelector = function(fields) {                                                                     // 747
      return _.object(_.map(fields, function(field) {                                                            // 748
        return [field, 1];                                                                                       // 749
      }));                                                                                                       // 750
    };                                                                                                           // 751
                                                                                                                 // 752
    Meteor.server.publish(null, function () {                                                                    // 753
      if (this.userId) {                                                                                         // 754
        return Meteor.users.find(                                                                                // 755
          {_id: this.userId},                                                                                    // 756
          {fields: toFieldSelector(autopublishFields.loggedInUser)});                                            // 757
      } else {                                                                                                   // 758
        return null;                                                                                             // 759
      }                                                                                                          // 760
    }, /*suppress autopublish warning*/{is_auto: true});                                                         // 761
                                                                                                                 // 762
    // XXX this publish is neither dedup-able nor is it optimized by our special                                 // 763
    // treatment of queries on a specific _id. Therefore this will have O(n^2)                                   // 764
    // run-time performance every time a user document is changed (eg someone                                    // 765
    // logging in). If this is a problem, we can instead write a manual publish                                  // 766
    // function which filters out fields based on 'this.userId'.                                                 // 767
    Meteor.server.publish(null, function () {                                                                    // 768
      var selector;                                                                                              // 769
      if (this.userId)                                                                                           // 770
        selector = {_id: {$ne: this.userId}};                                                                    // 771
      else                                                                                                       // 772
        selector = {};                                                                                           // 773
                                                                                                                 // 774
      return Meteor.users.find(                                                                                  // 775
        selector,                                                                                                // 776
        {fields: toFieldSelector(autopublishFields.otherUsers)});                                                // 777
    }, /*suppress autopublish warning*/{is_auto: true});                                                         // 778
  });                                                                                                            // 779
}                                                                                                                // 780
                                                                                                                 // 781
// Publish all login service configuration fields other than secret.                                             // 782
Meteor.publish("meteor.loginServiceConfiguration", function () {                                                 // 783
  var ServiceConfiguration =                                                                                     // 784
    Package['service-configuration'].ServiceConfiguration;                                                       // 785
  return ServiceConfiguration.configurations.find({}, {fields: {secret: 0}});                                    // 786
}, {is_auto: true}); // not techincally autopublish, but stops the warning.                                      // 787
                                                                                                                 // 788
// Allow a one-time configuration for a login service. Modifications                                             // 789
// to this collection are also allowed in insecure mode.                                                         // 790
Meteor.methods({                                                                                                 // 791
  "configureLoginService": function (options) {                                                                  // 792
    check(options, Match.ObjectIncluding({service: String}));                                                    // 793
    // Don't let random users configure a service we haven't added yet (so                                       // 794
    // that when we do later add it, it's set up with their configuration                                        // 795
    // instead of ours).                                                                                         // 796
    // XXX if service configuration is oauth-specific then this code should                                      // 797
    //     be in accounts-oauth; if it's not then the registry should be                                         // 798
    //     in this package                                                                                       // 799
    if (!(Accounts.oauth                                                                                         // 800
          && _.contains(Accounts.oauth.serviceNames(), options.service))) {                                      // 801
      throw new Meteor.Error(403, "Service unknown");                                                            // 802
    }                                                                                                            // 803
                                                                                                                 // 804
    var ServiceConfiguration =                                                                                   // 805
      Package['service-configuration'].ServiceConfiguration;                                                     // 806
    if (ServiceConfiguration.configurations.findOne({service: options.service}))                                 // 807
      throw new Meteor.Error(403, "Service " + options.service + " already configured");                         // 808
    ServiceConfiguration.configurations.insert(options);                                                         // 809
  }                                                                                                              // 810
});                                                                                                              // 811
                                                                                                                 // 812
                                                                                                                 // 813
///                                                                                                              // 814
/// RESTRICTING WRITES TO USER OBJECTS                                                                           // 815
///                                                                                                              // 816
                                                                                                                 // 817
Meteor.users.allow({                                                                                             // 818
  // clients can modify the profile field of their own document, and                                             // 819
  // nothing else.                                                                                               // 820
  update: function (userId, user, fields, modifier) {                                                            // 821
    // make sure it is our record                                                                                // 822
    if (user._id !== userId)                                                                                     // 823
      return false;                                                                                              // 824
                                                                                                                 // 825
    // user can only modify the 'profile' field. sets to multiple                                                // 826
    // sub-keys (eg profile.foo and profile.bar) are merged into entry                                           // 827
    // in the fields list.                                                                                       // 828
    if (fields.length !== 1 || fields[0] !== 'profile')                                                          // 829
      return false;                                                                                              // 830
                                                                                                                 // 831
    return true;                                                                                                 // 832
  },                                                                                                             // 833
  fetch: ['_id'] // we only look at _id.                                                                         // 834
});                                                                                                              // 835
                                                                                                                 // 836
/// DEFAULT INDEXES ON USERS                                                                                     // 837
Meteor.users._ensureIndex('username', {unique: 1, sparse: 1});                                                   // 838
Meteor.users._ensureIndex('emails.address', {unique: 1, sparse: 1});                                             // 839
Meteor.users._ensureIndex('services.resume.loginTokens.hashedToken',                                             // 840
                          {unique: 1, sparse: 1});                                                               // 841
Meteor.users._ensureIndex('services.resume.loginTokens.token',                                                   // 842
                          {unique: 1, sparse: 1});                                                               // 843
// For taking care of logoutOtherClients calls that crashed before the tokens                                    // 844
// were deleted.                                                                                                 // 845
Meteor.users._ensureIndex('services.resume.haveLoginTokensToDelete',                                             // 846
                          { sparse: 1 });                                                                        // 847
// For expiring login tokens                                                                                     // 848
Meteor.users._ensureIndex("services.resume.loginTokens.when", { sparse: 1 });                                    // 849
                                                                                                                 // 850
///                                                                                                              // 851
/// CLEAN UP FOR `logoutOtherClients`                                                                            // 852
///                                                                                                              // 853
                                                                                                                 // 854
var deleteSavedTokens = function (userId, tokensToDelete) {                                                      // 855
  if (tokensToDelete) {                                                                                          // 856
    Meteor.users.update(userId, {                                                                                // 857
      $unset: {                                                                                                  // 858
        "services.resume.haveLoginTokensToDelete": 1,                                                            // 859
        "services.resume.loginTokensToDelete": 1                                                                 // 860
      },                                                                                                         // 861
      $pullAll: {                                                                                                // 862
        "services.resume.loginTokens": tokensToDelete                                                            // 863
      }                                                                                                          // 864
    });                                                                                                          // 865
  }                                                                                                              // 866
};                                                                                                               // 867
                                                                                                                 // 868
Meteor.startup(function () {                                                                                     // 869
  // If we find users who have saved tokens to delete on startup, delete them                                    // 870
  // now. It's possible that the server could have crashed and come back up                                      // 871
  // before new tokens are found in localStorage, but this shouldn't happen very                                 // 872
  // often. We shouldn't put a delay here because that would give a lot of power                                 // 873
  // to an attacker with a stolen login token and the ability to crash the                                       // 874
  // server.                                                                                                     // 875
  var users = Meteor.users.find({                                                                                // 876
    "services.resume.haveLoginTokensToDelete": true                                                              // 877
  }, {                                                                                                           // 878
    "services.resume.loginTokensToDelete": 1                                                                     // 879
  });                                                                                                            // 880
  users.forEach(function (user) {                                                                                // 881
    deleteSavedTokens(user._id, user.services.resume.loginTokensToDelete);                                       // 882
  });                                                                                                            // 883
});                                                                                                              // 884
                                                                                                                 // 885
///                                                                                                              // 886
/// LOGGING OUT DELETED USERS                                                                                    // 887
///                                                                                                              // 888
                                                                                                                 // 889
// When login tokens are removed from the database, close any sessions                                           // 890
// logged in with those tokens.                                                                                  // 891
//                                                                                                               // 892
// Because we upgrade unhashed login tokens to hashed tokens at login                                            // 893
// time, sessions will only be logged in with a hashed token.  Thus we                                           // 894
// only need to pull out hashed tokens here.                                                                     // 895
var closeTokensForUser = function (userTokens) {                                                                 // 896
  closeConnectionsForTokens(_.compact(_.pluck(userTokens, "hashedToken")));                                      // 897
};                                                                                                               // 898
                                                                                                                 // 899
// Like _.difference, but uses EJSON.equals to compute which values to return.                                   // 900
var differenceObj = function (array1, array2) {                                                                  // 901
  return _.filter(array1, function (array1Value) {                                                               // 902
    return ! _.some(array2, function (array2Value) {                                                             // 903
      return EJSON.equals(array1Value, array2Value);                                                             // 904
    });                                                                                                          // 905
  });                                                                                                            // 906
};                                                                                                               // 907
                                                                                                                 // 908
Meteor.users.find({}, { fields: { "services.resume": 1 }}).observe({                                             // 909
  changed: function (newUser, oldUser) {                                                                         // 910
    var removedTokens = [];                                                                                      // 911
    if (newUser.services && newUser.services.resume &&                                                           // 912
        oldUser.services && oldUser.services.resume) {                                                           // 913
      removedTokens = differenceObj(oldUser.services.resume.loginTokens || [],                                   // 914
                                    newUser.services.resume.loginTokens || []);                                  // 915
    } else if (oldUser.services && oldUser.services.resume) {                                                    // 916
      removedTokens = oldUser.services.resume.loginTokens || [];                                                 // 917
    }                                                                                                            // 918
    closeTokensForUser(removedTokens);                                                                           // 919
  },                                                                                                             // 920
  removed: function (oldUser) {                                                                                  // 921
    if (oldUser.services && oldUser.services.resume)                                                             // 922
      closeTokensForUser(oldUser.services.resume.loginTokens || []);                                             // 923
  }                                                                                                              // 924
});                                                                                                              // 925
                                                                                                                 // 926
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                               //
// packages/accounts-base/url_server.js                                                                          //
//                                                                                                               //
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                 //
// XXX These should probably not actually be public?                                                             // 1
                                                                                                                 // 2
Accounts.urls = {};                                                                                              // 3
                                                                                                                 // 4
Accounts.urls.resetPassword = function (token) {                                                                 // 5
  return Meteor.absoluteUrl('#/reset-password/' + token);                                                        // 6
};                                                                                                               // 7
                                                                                                                 // 8
Accounts.urls.verifyEmail = function (token) {                                                                   // 9
  return Meteor.absoluteUrl('#/verify-email/' + token);                                                          // 10
};                                                                                                               // 11
                                                                                                                 // 12
Accounts.urls.enrollAccount = function (token) {                                                                 // 13
  return Meteor.absoluteUrl('#/enroll-account/' + token);                                                        // 14
};                                                                                                               // 15
                                                                                                                 // 16
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package['accounts-base'] = {
  Accounts: Accounts
};

})();
