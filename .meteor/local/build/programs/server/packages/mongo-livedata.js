(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var Random = Package.random.Random;
var EJSON = Package.ejson.EJSON;
var _ = Package.underscore._;
var LocalCollection = Package.minimongo.LocalCollection;
var Minimongo = Package.minimongo.Minimongo;
var Log = Package.logging.Log;
var DDP = Package.livedata.DDP;
var DDPServer = Package.livedata.DDPServer;
var Deps = Package.deps.Deps;
var AppConfig = Package['application-configuration'].AppConfig;
var check = Package.check.check;
var Match = Package.check.Match;

/* Package-scope variables */
var MongoInternals, MongoTest, MongoConnection, CursorDescription, Cursor, listenAll, forEachTrigger, OPLOG_COLLECTION, idForOp, OplogHandle, ObserveMultiplexer, ObserveHandle, DocFetcher, PollingObserveDriver, OplogObserveDriver, LocalCollectionDriver;

(function () {

/////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                     //
// packages/mongo-livedata/mongo_driver.js                                                             //
//                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                       //
/**                                                                                                    // 1
 * Provide a synchronous Collection API using fibers, backed by                                        // 2
 * MongoDB.  This is only for use on the server, and mostly identical                                  // 3
 * to the client API.                                                                                  // 4
 *                                                                                                     // 5
 * NOTE: the public API methods must be run within a fiber. If you call                                // 6
 * these outside of a fiber they will explode!                                                         // 7
 */                                                                                                    // 8
                                                                                                       // 9
var path = Npm.require('path');                                                                        // 10
var MongoDB = Npm.require('mongodb');                                                                  // 11
var Fiber = Npm.require('fibers');                                                                     // 12
var Future = Npm.require(path.join('fibers', 'future'));                                               // 13
                                                                                                       // 14
MongoInternals = {};                                                                                   // 15
MongoTest = {};                                                                                        // 16
                                                                                                       // 17
var replaceNames = function (filter, thing) {                                                          // 18
  if (typeof thing === "object") {                                                                     // 19
    if (_.isArray(thing)) {                                                                            // 20
      return _.map(thing, _.bind(replaceNames, null, filter));                                         // 21
    }                                                                                                  // 22
    var ret = {};                                                                                      // 23
    _.each(thing, function (value, key) {                                                              // 24
      ret[filter(key)] = replaceNames(filter, value);                                                  // 25
    });                                                                                                // 26
    return ret;                                                                                        // 27
  }                                                                                                    // 28
  return thing;                                                                                        // 29
};                                                                                                     // 30
                                                                                                       // 31
// Ensure that EJSON.clone keeps a Timestamp as a Timestamp (instead of just                           // 32
// doing a structural clone).                                                                          // 33
// XXX how ok is this? what if there are multiple copies of MongoDB loaded?                            // 34
MongoDB.Timestamp.prototype.clone = function () {                                                      // 35
  // Timestamps should be immutable.                                                                   // 36
  return this;                                                                                         // 37
};                                                                                                     // 38
                                                                                                       // 39
var makeMongoLegal = function (name) { return "EJSON" + name; };                                       // 40
var unmakeMongoLegal = function (name) { return name.substr(5); };                                     // 41
                                                                                                       // 42
var replaceMongoAtomWithMeteor = function (document) {                                                 // 43
  if (document instanceof MongoDB.Binary) {                                                            // 44
    var buffer = document.value(true);                                                                 // 45
    return new Uint8Array(buffer);                                                                     // 46
  }                                                                                                    // 47
  if (document instanceof MongoDB.ObjectID) {                                                          // 48
    return new Meteor.Collection.ObjectID(document.toHexString());                                     // 49
  }                                                                                                    // 50
  if (document["EJSON$type"] && document["EJSON$value"]) {                                             // 51
    return EJSON.fromJSONValue(replaceNames(unmakeMongoLegal, document));                              // 52
  }                                                                                                    // 53
  if (document instanceof MongoDB.Timestamp) {                                                         // 54
    // For now, the Meteor representation of a Mongo timestamp type (not a date!                       // 55
    // this is a weird internal thing used in the oplog!) is the same as the                           // 56
    // Mongo representation. We need to do this explicitly or else we would do a                       // 57
    // structural clone and lose the prototype.                                                        // 58
    return document;                                                                                   // 59
  }                                                                                                    // 60
  return undefined;                                                                                    // 61
};                                                                                                     // 62
                                                                                                       // 63
var replaceMeteorAtomWithMongo = function (document) {                                                 // 64
  if (EJSON.isBinary(document)) {                                                                      // 65
    // This does more copies than we'd like, but is necessary because                                  // 66
    // MongoDB.BSON only looks like it takes a Uint8Array (and doesn't actually                        // 67
    // serialize it correctly).                                                                        // 68
    return new MongoDB.Binary(new Buffer(document));                                                   // 69
  }                                                                                                    // 70
  if (document instanceof Meteor.Collection.ObjectID) {                                                // 71
    return new MongoDB.ObjectID(document.toHexString());                                               // 72
  }                                                                                                    // 73
  if (document instanceof MongoDB.Timestamp) {                                                         // 74
    // For now, the Meteor representation of a Mongo timestamp type (not a date!                       // 75
    // this is a weird internal thing used in the oplog!) is the same as the                           // 76
    // Mongo representation. We need to do this explicitly or else we would do a                       // 77
    // structural clone and lose the prototype.                                                        // 78
    return document;                                                                                   // 79
  }                                                                                                    // 80
  if (EJSON._isCustomType(document)) {                                                                 // 81
    return replaceNames(makeMongoLegal, EJSON.toJSONValue(document));                                  // 82
  }                                                                                                    // 83
  // It is not ordinarily possible to stick dollar-sign keys into mongo                                // 84
  // so we don't bother checking for things that need escaping at this time.                           // 85
  return undefined;                                                                                    // 86
};                                                                                                     // 87
                                                                                                       // 88
var replaceTypes = function (document, atomTransformer) {                                              // 89
  if (typeof document !== 'object' || document === null)                                               // 90
    return document;                                                                                   // 91
                                                                                                       // 92
  var replacedTopLevelAtom = atomTransformer(document);                                                // 93
  if (replacedTopLevelAtom !== undefined)                                                              // 94
    return replacedTopLevelAtom;                                                                       // 95
                                                                                                       // 96
  var ret = document;                                                                                  // 97
  _.each(document, function (val, key) {                                                               // 98
    var valReplaced = replaceTypes(val, atomTransformer);                                              // 99
    if (val !== valReplaced) {                                                                         // 100
      // Lazy clone. Shallow copy.                                                                     // 101
      if (ret === document)                                                                            // 102
        ret = _.clone(document);                                                                       // 103
      ret[key] = valReplaced;                                                                          // 104
    }                                                                                                  // 105
  });                                                                                                  // 106
  return ret;                                                                                          // 107
};                                                                                                     // 108
                                                                                                       // 109
                                                                                                       // 110
MongoConnection = function (url, options) {                                                            // 111
  var self = this;                                                                                     // 112
  options = options || {};                                                                             // 113
  self._connectCallbacks = [];                                                                         // 114
  self._observeMultiplexers = {};                                                                      // 115
                                                                                                       // 116
  var mongoOptions = {db: {safe: true}, server: {}, replSet: {}};                                      // 117
                                                                                                       // 118
  // Set autoReconnect to true, unless passed on the URL. Why someone                                  // 119
  // would want to set autoReconnect to false, I'm not really sure, but                                // 120
  // keeping this for backwards compatibility for now.                                                 // 121
  if (!(/[\?&]auto_?[rR]econnect=/.test(url))) {                                                       // 122
    mongoOptions.server.auto_reconnect = true;                                                         // 123
  }                                                                                                    // 124
                                                                                                       // 125
  // Disable the native parser by default, unless specifically enabled                                 // 126
  // in the mongo URL.                                                                                 // 127
  // - The native driver can cause errors which normally would be                                      // 128
  //   thrown, caught, and handled into segfaults that take down the                                   // 129
  //   whole app.                                                                                      // 130
  // - Binary modules don't yet work when you bundle and move the bundle                               // 131
  //   to a different platform (aka deploy)                                                            // 132
  // We should revisit this after binary npm module support lands.                                     // 133
  if (!(/[\?&]native_?[pP]arser=/.test(url))) {                                                        // 134
    mongoOptions.db.native_parser = false;                                                             // 135
  }                                                                                                    // 136
                                                                                                       // 137
  // XXX maybe we should have a better way of allowing users to configure the                          // 138
  // underlying Mongo driver                                                                           // 139
  if (_.has(options, 'poolSize')) {                                                                    // 140
    // If we just set this for "server", replSet will override it. If we just                          // 141
    // set it for replSet, it will be ignored if we're not using a replSet.                            // 142
    mongoOptions.server.poolSize = options.poolSize;                                                   // 143
    mongoOptions.replSet.poolSize = options.poolSize;                                                  // 144
  }                                                                                                    // 145
                                                                                                       // 146
  MongoDB.connect(url, mongoOptions, function(err, db) {                                               // 147
    if (err)                                                                                           // 148
      throw err;                                                                                       // 149
    self.db = db;                                                                                      // 150
                                                                                                       // 151
    Fiber(function () {                                                                                // 152
      // drain queue of pending callbacks                                                              // 153
      _.each(self._connectCallbacks, function (c) {                                                    // 154
        c(db);                                                                                         // 155
      });                                                                                              // 156
    }).run();                                                                                          // 157
  });                                                                                                  // 158
                                                                                                       // 159
  self._docFetcher = new DocFetcher(self);                                                             // 160
  self._oplogHandle = null;                                                                            // 161
                                                                                                       // 162
  if (options.oplogUrl && !Package['disable-oplog']) {                                                 // 163
    var dbNameFuture = new Future;                                                                     // 164
    self._withDb(function (db) {                                                                       // 165
      dbNameFuture.return(db.databaseName);                                                            // 166
    });                                                                                                // 167
    self._oplogHandle = new OplogHandle(options.oplogUrl, dbNameFuture.wait());                        // 168
  }                                                                                                    // 169
};                                                                                                     // 170
                                                                                                       // 171
MongoConnection.prototype.close = function() {                                                         // 172
  var self = this;                                                                                     // 173
                                                                                                       // 174
  // XXX probably untested                                                                             // 175
  var oplogHandle = self._oplogHandle;                                                                 // 176
  self._oplogHandle = null;                                                                            // 177
  if (oplogHandle)                                                                                     // 178
    oplogHandle.stop();                                                                                // 179
                                                                                                       // 180
  // Use Future.wrap so that errors get thrown. This happens to                                        // 181
  // work even outside a fiber since the 'close' method is not                                         // 182
  // actually asynchronous.                                                                            // 183
  Future.wrap(_.bind(self.db.close, self.db))(true).wait();                                            // 184
};                                                                                                     // 185
                                                                                                       // 186
MongoConnection.prototype._withDb = function (callback) {                                              // 187
  var self = this;                                                                                     // 188
  if (self.db) {                                                                                       // 189
    callback(self.db);                                                                                 // 190
  } else {                                                                                             // 191
    self._connectCallbacks.push(callback);                                                             // 192
  }                                                                                                    // 193
};                                                                                                     // 194
                                                                                                       // 195
// Returns the Mongo Collection object; may yield.                                                     // 196
MongoConnection.prototype._getCollection = function (collectionName) {                                 // 197
  var self = this;                                                                                     // 198
                                                                                                       // 199
  var future = new Future;                                                                             // 200
  self._withDb(function (db) {                                                                         // 201
    db.collection(collectionName, future.resolver());                                                  // 202
  });                                                                                                  // 203
  return future.wait();                                                                                // 204
};                                                                                                     // 205
                                                                                                       // 206
MongoConnection.prototype._createCappedCollection = function (collectionName,                          // 207
                                                              byteSize) {                              // 208
  var self = this;                                                                                     // 209
  var future = new Future();                                                                           // 210
  self._withDb(function (db) {                                                                         // 211
    db.createCollection(collectionName, {capped: true, size: byteSize},                                // 212
                        future.resolver());                                                            // 213
  });                                                                                                  // 214
  future.wait();                                                                                       // 215
};                                                                                                     // 216
                                                                                                       // 217
// This should be called synchronously with a write, to create a                                       // 218
// transaction on the current write fence, if any. After we can read                                   // 219
// the write, and after observers have been notified (or at least,                                     // 220
// after the observer notifiers have added themselves to the write                                     // 221
// fence), you should call 'committed()' on the object returned.                                       // 222
MongoConnection.prototype._maybeBeginWrite = function () {                                             // 223
  var self = this;                                                                                     // 224
  var fence = DDPServer._CurrentWriteFence.get();                                                      // 225
  if (fence)                                                                                           // 226
    return fence.beginWrite();                                                                         // 227
  else                                                                                                 // 228
    return {committed: function () {}};                                                                // 229
};                                                                                                     // 230
                                                                                                       // 231
                                                                                                       // 232
//////////// Public API //////////                                                                     // 233
                                                                                                       // 234
// The write methods block until the database has confirmed the write (it may                          // 235
// not be replicated or stable on disk, but one server has confirmed it) if no                         // 236
// callback is provided. If a callback is provided, then they call the callback                        // 237
// when the write is confirmed. They return nothing on success, and raise an                           // 238
// exception on failure.                                                                               // 239
//                                                                                                     // 240
// After making a write (with insert, update, remove), observers are                                   // 241
// notified asynchronously. If you want to receive a callback once all                                 // 242
// of the observer notifications have landed for your write, do the                                    // 243
// writes inside a write fence (set DDPServer._CurrentWriteFence to a new                              // 244
// _WriteFence, and then set a callback on the write fence.)                                           // 245
//                                                                                                     // 246
// Since our execution environment is single-threaded, this is                                         // 247
// well-defined -- a write "has been made" if it's returned, and an                                    // 248
// observer "has been notified" if its callback has returned.                                          // 249
                                                                                                       // 250
var writeCallback = function (write, refresh, callback) {                                              // 251
  return function (err, result) {                                                                      // 252
    if (! err) {                                                                                       // 253
      // XXX We don't have to run this on error, right?                                                // 254
      refresh();                                                                                       // 255
    }                                                                                                  // 256
    write.committed();                                                                                 // 257
    if (callback)                                                                                      // 258
      callback(err, result);                                                                           // 259
    else if (err)                                                                                      // 260
      throw err;                                                                                       // 261
  };                                                                                                   // 262
};                                                                                                     // 263
                                                                                                       // 264
var bindEnvironmentForWrite = function (callback) {                                                    // 265
  return Meteor.bindEnvironment(callback, "Mongo write");                                              // 266
};                                                                                                     // 267
                                                                                                       // 268
MongoConnection.prototype._insert = function (collection_name, document,                               // 269
                                              callback) {                                              // 270
  var self = this;                                                                                     // 271
  if (collection_name === "___meteor_failure_test_collection") {                                       // 272
    var e = new Error("Failure test");                                                                 // 273
    e.expected = true;                                                                                 // 274
    if (callback)                                                                                      // 275
      return callback(e);                                                                              // 276
    else                                                                                               // 277
      throw e;                                                                                         // 278
  }                                                                                                    // 279
                                                                                                       // 280
  var write = self._maybeBeginWrite();                                                                 // 281
  var refresh = function () {                                                                          // 282
    Meteor.refresh({collection: collection_name, id: document._id });                                  // 283
  };                                                                                                   // 284
  callback = bindEnvironmentForWrite(writeCallback(write, refresh, callback));                         // 285
  try {                                                                                                // 286
    var collection = self._getCollection(collection_name);                                             // 287
    collection.insert(replaceTypes(document, replaceMeteorAtomWithMongo),                              // 288
                      {safe: true}, callback);                                                         // 289
  } catch (e) {                                                                                        // 290
    write.committed();                                                                                 // 291
    throw e;                                                                                           // 292
  }                                                                                                    // 293
};                                                                                                     // 294
                                                                                                       // 295
// Cause queries that may be affected by the selector to poll in this write                            // 296
// fence.                                                                                              // 297
MongoConnection.prototype._refresh = function (collectionName, selector) {                             // 298
  var self = this;                                                                                     // 299
  var refreshKey = {collection: collectionName};                                                       // 300
  // If we know which documents we're removing, don't poll queries that are                            // 301
  // specific to other documents. (Note that multiple notifications here should                        // 302
  // not cause multiple polls, since all our listener is doing is enqueueing a                         // 303
  // poll.)                                                                                            // 304
  var specificIds = LocalCollection._idsMatchedBySelector(selector);                                   // 305
  if (specificIds) {                                                                                   // 306
    _.each(specificIds, function (id) {                                                                // 307
      Meteor.refresh(_.extend({id: id}, refreshKey));                                                  // 308
    });                                                                                                // 309
  } else {                                                                                             // 310
    Meteor.refresh(refreshKey);                                                                        // 311
  }                                                                                                    // 312
};                                                                                                     // 313
                                                                                                       // 314
MongoConnection.prototype._remove = function (collection_name, selector,                               // 315
                                              callback) {                                              // 316
  var self = this;                                                                                     // 317
                                                                                                       // 318
  if (collection_name === "___meteor_failure_test_collection") {                                       // 319
    var e = new Error("Failure test");                                                                 // 320
    e.expected = true;                                                                                 // 321
    if (callback)                                                                                      // 322
      return callback(e);                                                                              // 323
    else                                                                                               // 324
      throw e;                                                                                         // 325
  }                                                                                                    // 326
                                                                                                       // 327
  var write = self._maybeBeginWrite();                                                                 // 328
  var refresh = function () {                                                                          // 329
    self._refresh(collection_name, selector);                                                          // 330
  };                                                                                                   // 331
  callback = bindEnvironmentForWrite(writeCallback(write, refresh, callback));                         // 332
                                                                                                       // 333
  try {                                                                                                // 334
    var collection = self._getCollection(collection_name);                                             // 335
    collection.remove(replaceTypes(selector, replaceMeteorAtomWithMongo),                              // 336
                      {safe: true}, callback);                                                         // 337
  } catch (e) {                                                                                        // 338
    write.committed();                                                                                 // 339
    throw e;                                                                                           // 340
  }                                                                                                    // 341
};                                                                                                     // 342
                                                                                                       // 343
MongoConnection.prototype._dropCollection = function (collectionName, cb) {                            // 344
  var self = this;                                                                                     // 345
                                                                                                       // 346
  var write = self._maybeBeginWrite();                                                                 // 347
  var refresh = function () {                                                                          // 348
    Meteor.refresh({collection: collectionName, id: null,                                              // 349
                    dropCollection: true});                                                            // 350
  };                                                                                                   // 351
  cb = bindEnvironmentForWrite(writeCallback(write, refresh, cb));                                     // 352
                                                                                                       // 353
  try {                                                                                                // 354
    var collection = self._getCollection(collectionName);                                              // 355
    collection.drop(cb);                                                                               // 356
  } catch (e) {                                                                                        // 357
    write.committed();                                                                                 // 358
    throw e;                                                                                           // 359
  }                                                                                                    // 360
};                                                                                                     // 361
                                                                                                       // 362
MongoConnection.prototype._update = function (collection_name, selector, mod,                          // 363
                                              options, callback) {                                     // 364
  var self = this;                                                                                     // 365
                                                                                                       // 366
  if (! callback && options instanceof Function) {                                                     // 367
    callback = options;                                                                                // 368
    options = null;                                                                                    // 369
  }                                                                                                    // 370
                                                                                                       // 371
  if (collection_name === "___meteor_failure_test_collection") {                                       // 372
    var e = new Error("Failure test");                                                                 // 373
    e.expected = true;                                                                                 // 374
    if (callback)                                                                                      // 375
      return callback(e);                                                                              // 376
    else                                                                                               // 377
      throw e;                                                                                         // 378
  }                                                                                                    // 379
                                                                                                       // 380
  // explicit safety check. null and undefined can crash the mongo                                     // 381
  // driver. Although the node driver and minimongo do 'support'                                       // 382
  // non-object modifier in that they don't crash, they are not                                        // 383
  // meaningful operations and do not do anything. Defensively throw an                                // 384
  // error here.                                                                                       // 385
  if (!mod || typeof mod !== 'object')                                                                 // 386
    throw new Error("Invalid modifier. Modifier must be an object.");                                  // 387
                                                                                                       // 388
  if (!options) options = {};                                                                          // 389
                                                                                                       // 390
  var write = self._maybeBeginWrite();                                                                 // 391
  var refresh = function () {                                                                          // 392
    self._refresh(collection_name, selector);                                                          // 393
  };                                                                                                   // 394
  callback = writeCallback(write, refresh, callback);                                                  // 395
  try {                                                                                                // 396
    var collection = self._getCollection(collection_name);                                             // 397
    var mongoOpts = {safe: true};                                                                      // 398
    // explictly enumerate options that minimongo supports                                             // 399
    if (options.upsert) mongoOpts.upsert = true;                                                       // 400
    if (options.multi) mongoOpts.multi = true;                                                         // 401
                                                                                                       // 402
    var mongoSelector = replaceTypes(selector, replaceMeteorAtomWithMongo);                            // 403
    var mongoMod = replaceTypes(mod, replaceMeteorAtomWithMongo);                                      // 404
                                                                                                       // 405
    var isModify = isModificationMod(mongoMod);                                                        // 406
    var knownId = (isModify ? selector._id : mod._id);                                                 // 407
                                                                                                       // 408
    if (options.upsert && (! knownId) && options.insertedId) {                                         // 409
      // XXX In future we could do a real upsert for the mongo id generation                           // 410
      // case, if the the node mongo driver gives us back the id of the upserted                       // 411
      // doc (which our current version does not).                                                     // 412
      simulateUpsertWithInsertedId(                                                                    // 413
        collection, mongoSelector, mongoMod,                                                           // 414
        isModify, options,                                                                             // 415
        // This callback does not need to be bindEnvironment'ed because                                // 416
        // simulateUpsertWithInsertedId() wraps it and then passes it through                          // 417
        // bindEnvironmentForWrite.                                                                    // 418
        function (err, result) {                                                                       // 419
          // If we got here via a upsert() call, then options._returnObject will                       // 420
          // be set and we should return the whole object. Otherwise, we should                        // 421
          // just return the number of affected docs to match the mongo API.                           // 422
          if (result && ! options._returnObject)                                                       // 423
            callback(err, result.numberAffected);                                                      // 424
          else                                                                                         // 425
            callback(err, result);                                                                     // 426
        }                                                                                              // 427
      );                                                                                               // 428
    } else {                                                                                           // 429
      collection.update(                                                                               // 430
        mongoSelector, mongoMod, mongoOpts,                                                            // 431
        bindEnvironmentForWrite(function (err, result, extra) {                                        // 432
          if (! err) {                                                                                 // 433
            if (result && options._returnObject) {                                                     // 434
              result = { numberAffected: result };                                                     // 435
              // If this was an upsert() call, and we ended up                                         // 436
              // inserting a new doc and we know its id, then                                          // 437
              // return that id as well.                                                               // 438
              if (options.upsert && knownId &&                                                         // 439
                  ! extra.updatedExisting)                                                             // 440
                result.insertedId = knownId;                                                           // 441
            }                                                                                          // 442
          }                                                                                            // 443
          callback(err, result);                                                                       // 444
        }));                                                                                           // 445
    }                                                                                                  // 446
  } catch (e) {                                                                                        // 447
    write.committed();                                                                                 // 448
    throw e;                                                                                           // 449
  }                                                                                                    // 450
};                                                                                                     // 451
                                                                                                       // 452
var isModificationMod = function (mod) {                                                               // 453
  for (var k in mod)                                                                                   // 454
    if (k.substr(0, 1) === '$')                                                                        // 455
      return true;                                                                                     // 456
  return false;                                                                                        // 457
};                                                                                                     // 458
                                                                                                       // 459
var NUM_OPTIMISTIC_TRIES = 3;                                                                          // 460
                                                                                                       // 461
// exposed for testing                                                                                 // 462
MongoConnection._isCannotChangeIdError = function (err) {                                              // 463
  // either of these checks should work, but just to be safe...                                        // 464
  return (err.code === 13596 ||                                                                        // 465
          err.err.indexOf("cannot change _id of a document") === 0);                                   // 466
};                                                                                                     // 467
                                                                                                       // 468
var simulateUpsertWithInsertedId = function (collection, selector, mod,                                // 469
                                             isModify, options, callback) {                            // 470
  // STRATEGY:  First try doing a plain update.  If it affected 0 documents,                           // 471
  // then without affecting the database, we know we should probably do an                             // 472
  // insert.  We then do a *conditional* insert that will fail in the case                             // 473
  // of a race condition.  This conditional insert is actually an                                      // 474
  // upsert-replace with an _id, which will never successfully update an                               // 475
  // existing document.  If this upsert fails with an error saying it                                  // 476
  // couldn't change an existing _id, then we know an intervening write has                            // 477
  // caused the query to match something.  We go back to step one and repeat.                          // 478
  // Like all "optimistic write" schemes, we rely on the fact that it's                                // 479
  // unlikely our writes will continue to be interfered with under normal                              // 480
  // circumstances (though sufficiently heavy contention with writers                                  // 481
  // disagreeing on the existence of an object will cause writes to fail                               // 482
  // in theory).                                                                                       // 483
                                                                                                       // 484
  var newDoc;                                                                                          // 485
  // Run this code up front so that it fails fast if someone uses                                      // 486
  // a Mongo update operator we don't support.                                                         // 487
  if (isModify) {                                                                                      // 488
    // We've already run replaceTypes/replaceMeteorAtomWithMongo on                                    // 489
    // selector and mod.  We assume it doesn't matter, as far as                                       // 490
    // the behavior of modifiers is concerned, whether `_modify`                                       // 491
    // is run on EJSON or on mongo-converted EJSON.                                                    // 492
    var selectorDoc = LocalCollection._removeDollarOperators(selector);                                // 493
    LocalCollection._modify(selectorDoc, mod, {isInsert: true});                                       // 494
    newDoc = selectorDoc;                                                                              // 495
  } else {                                                                                             // 496
    newDoc = mod;                                                                                      // 497
  }                                                                                                    // 498
                                                                                                       // 499
  var insertedId = options.insertedId; // must exist                                                   // 500
  var mongoOptsForUpdate = {                                                                           // 501
    safe: true,                                                                                        // 502
    multi: options.multi                                                                               // 503
  };                                                                                                   // 504
  var mongoOptsForInsert = {                                                                           // 505
    safe: true,                                                                                        // 506
    upsert: true                                                                                       // 507
  };                                                                                                   // 508
                                                                                                       // 509
  var tries = NUM_OPTIMISTIC_TRIES;                                                                    // 510
                                                                                                       // 511
  var doUpdate = function () {                                                                         // 512
    tries--;                                                                                           // 513
    if (! tries) {                                                                                     // 514
      callback(new Error("Upsert failed after " + NUM_OPTIMISTIC_TRIES + " tries."));                  // 515
    } else {                                                                                           // 516
      collection.update(selector, mod, mongoOptsForUpdate,                                             // 517
                        bindEnvironmentForWrite(function (err, result) {                               // 518
                          if (err)                                                                     // 519
                            callback(err);                                                             // 520
                          else if (result)                                                             // 521
                            callback(null, {                                                           // 522
                              numberAffected: result                                                   // 523
                            });                                                                        // 524
                          else                                                                         // 525
                            doConditionalInsert();                                                     // 526
                        }));                                                                           // 527
    }                                                                                                  // 528
  };                                                                                                   // 529
                                                                                                       // 530
  var doConditionalInsert = function () {                                                              // 531
    var replacementWithId = _.extend(                                                                  // 532
      replaceTypes({_id: insertedId}, replaceMeteorAtomWithMongo),                                     // 533
      newDoc);                                                                                         // 534
    collection.update(selector, replacementWithId, mongoOptsForInsert,                                 // 535
                      bindEnvironmentForWrite(function (err, result) {                                 // 536
                        if (err) {                                                                     // 537
                          // figure out if this is a                                                   // 538
                          // "cannot change _id of document" error, and                                // 539
                          // if so, try doUpdate() again, up to 3 times.                               // 540
                          if (MongoConnection._isCannotChangeIdError(err)) {                           // 541
                            doUpdate();                                                                // 542
                          } else {                                                                     // 543
                            callback(err);                                                             // 544
                          }                                                                            // 545
                        } else {                                                                       // 546
                          callback(null, {                                                             // 547
                            numberAffected: result,                                                    // 548
                            insertedId: insertedId                                                     // 549
                          });                                                                          // 550
                        }                                                                              // 551
                      }));                                                                             // 552
  };                                                                                                   // 553
                                                                                                       // 554
  doUpdate();                                                                                          // 555
};                                                                                                     // 556
                                                                                                       // 557
_.each(["insert", "update", "remove", "dropCollection"], function (method) {                           // 558
  MongoConnection.prototype[method] = function (/* arguments */) {                                     // 559
    var self = this;                                                                                   // 560
    return Meteor._wrapAsync(self["_" + method]).apply(self, arguments);                               // 561
  };                                                                                                   // 562
});                                                                                                    // 563
                                                                                                       // 564
// XXX MongoConnection.upsert() does not return the id of the inserted document                        // 565
// unless you set it explicitly in the selector or modifier (as a replacement                          // 566
// doc).                                                                                               // 567
MongoConnection.prototype.upsert = function (collectionName, selector, mod,                            // 568
                                             options, callback) {                                      // 569
  var self = this;                                                                                     // 570
  if (typeof options === "function" && ! callback) {                                                   // 571
    callback = options;                                                                                // 572
    options = {};                                                                                      // 573
  }                                                                                                    // 574
                                                                                                       // 575
  return self.update(collectionName, selector, mod,                                                    // 576
                     _.extend({}, options, {                                                           // 577
                       upsert: true,                                                                   // 578
                       _returnObject: true                                                             // 579
                     }), callback);                                                                    // 580
};                                                                                                     // 581
                                                                                                       // 582
MongoConnection.prototype.find = function (collectionName, selector, options) {                        // 583
  var self = this;                                                                                     // 584
                                                                                                       // 585
  if (arguments.length === 1)                                                                          // 586
    selector = {};                                                                                     // 587
                                                                                                       // 588
  return new Cursor(                                                                                   // 589
    self, new CursorDescription(collectionName, selector, options));                                   // 590
};                                                                                                     // 591
                                                                                                       // 592
MongoConnection.prototype.findOne = function (collection_name, selector,                               // 593
                                              options) {                                               // 594
  var self = this;                                                                                     // 595
  if (arguments.length === 1)                                                                          // 596
    selector = {};                                                                                     // 597
                                                                                                       // 598
  options = options || {};                                                                             // 599
  options.limit = 1;                                                                                   // 600
  return self.find(collection_name, selector, options).fetch()[0];                                     // 601
};                                                                                                     // 602
                                                                                                       // 603
// We'll actually design an index API later. For now, we just pass through to                          // 604
// Mongo's, but make it synchronous.                                                                   // 605
MongoConnection.prototype._ensureIndex = function (collectionName, index,                              // 606
                                                   options) {                                          // 607
  var self = this;                                                                                     // 608
  options = _.extend({safe: true}, options);                                                           // 609
                                                                                                       // 610
  // We expect this function to be called at startup, not from within a method,                        // 611
  // so we don't interact with the write fence.                                                        // 612
  var collection = self._getCollection(collectionName);                                                // 613
  var future = new Future;                                                                             // 614
  var indexName = collection.ensureIndex(index, options, future.resolver());                           // 615
  future.wait();                                                                                       // 616
};                                                                                                     // 617
MongoConnection.prototype._dropIndex = function (collectionName, index) {                              // 618
  var self = this;                                                                                     // 619
                                                                                                       // 620
  // This function is only used by test code, not within a method, so we don't                         // 621
  // interact with the write fence.                                                                    // 622
  var collection = self._getCollection(collectionName);                                                // 623
  var future = new Future;                                                                             // 624
  var indexName = collection.dropIndex(index, future.resolver());                                      // 625
  future.wait();                                                                                       // 626
};                                                                                                     // 627
                                                                                                       // 628
// CURSORS                                                                                             // 629
                                                                                                       // 630
// There are several classes which relate to cursors:                                                  // 631
//                                                                                                     // 632
// CursorDescription represents the arguments used to construct a cursor:                              // 633
// collectionName, selector, and (find) options.  Because it is used as a key                          // 634
// for cursor de-dup, everything in it should either be JSON-stringifiable or                          // 635
// not affect observeChanges output (eg, options.transform functions are not                           // 636
// stringifiable but do not affect observeChanges).                                                    // 637
//                                                                                                     // 638
// SynchronousCursor is a wrapper around a MongoDB cursor                                              // 639
// which includes fully-synchronous versions of forEach, etc.                                          // 640
//                                                                                                     // 641
// Cursor is the cursor object returned from find(), which implements the                              // 642
// documented Meteor.Collection cursor API.  It wraps a CursorDescription and a                        // 643
// SynchronousCursor (lazily: it doesn't contact Mongo until you call a method                         // 644
// like fetch or forEach on it).                                                                       // 645
//                                                                                                     // 646
// ObserveHandle is the "observe handle" returned from observeChanges. It has a                        // 647
// reference to an ObserveMultiplexer.                                                                 // 648
//                                                                                                     // 649
// ObserveMultiplexer allows multiple identical ObserveHandles to be driven by a                       // 650
// single observe driver.                                                                              // 651
//                                                                                                     // 652
// There are two "observe drivers" which drive ObserveMultiplexers:                                    // 653
//   - PollingObserveDriver caches the results of a query and reruns it when                           // 654
//     necessary.                                                                                      // 655
//   - OplogObserveDriver follows the Mongo operation log to directly observe                          // 656
//     database changes.                                                                               // 657
// Both implementations follow the same simple interface: when you create them,                        // 658
// they start sending observeChanges callbacks (and a ready() invocation) to                           // 659
// their ObserveMultiplexer, and you stop them by calling their stop() method.                         // 660
                                                                                                       // 661
CursorDescription = function (collectionName, selector, options) {                                     // 662
  var self = this;                                                                                     // 663
  self.collectionName = collectionName;                                                                // 664
  self.selector = Meteor.Collection._rewriteSelector(selector);                                        // 665
  self.options = options || {};                                                                        // 666
};                                                                                                     // 667
                                                                                                       // 668
Cursor = function (mongo, cursorDescription) {                                                         // 669
  var self = this;                                                                                     // 670
                                                                                                       // 671
  self._mongo = mongo;                                                                                 // 672
  self._cursorDescription = cursorDescription;                                                         // 673
  self._synchronousCursor = null;                                                                      // 674
};                                                                                                     // 675
                                                                                                       // 676
_.each(['forEach', 'map', 'rewind', 'fetch', 'count'], function (method) {                             // 677
  Cursor.prototype[method] = function () {                                                             // 678
    var self = this;                                                                                   // 679
                                                                                                       // 680
    // You can only observe a tailable cursor.                                                         // 681
    if (self._cursorDescription.options.tailable)                                                      // 682
      throw new Error("Cannot call " + method + " on a tailable cursor");                              // 683
                                                                                                       // 684
    if (!self._synchronousCursor) {                                                                    // 685
      self._synchronousCursor = self._mongo._createSynchronousCursor(                                  // 686
        self._cursorDescription, {                                                                     // 687
          // Make sure that the "self" argument to forEach/map callbacks is the                        // 688
          // Cursor, not the SynchronousCursor.                                                        // 689
          selfForIteration: self,                                                                      // 690
          useTransform: true                                                                           // 691
        });                                                                                            // 692
    }                                                                                                  // 693
                                                                                                       // 694
    return self._synchronousCursor[method].apply(                                                      // 695
      self._synchronousCursor, arguments);                                                             // 696
  };                                                                                                   // 697
});                                                                                                    // 698
                                                                                                       // 699
Cursor.prototype.getTransform = function () {                                                          // 700
  return this._cursorDescription.options.transform;                                                    // 701
};                                                                                                     // 702
                                                                                                       // 703
// When you call Meteor.publish() with a function that returns a Cursor, we need                       // 704
// to transmute it into the equivalent subscription.  This is the function that                        // 705
// does that.                                                                                          // 706
                                                                                                       // 707
Cursor.prototype._publishCursor = function (sub) {                                                     // 708
  var self = this;                                                                                     // 709
  var collection = self._cursorDescription.collectionName;                                             // 710
  return Meteor.Collection._publishCursor(self, sub, collection);                                      // 711
};                                                                                                     // 712
                                                                                                       // 713
// Used to guarantee that publish functions return at most one cursor per                              // 714
// collection. Private, because we might later have cursors that include                               // 715
// documents from multiple collections somehow.                                                        // 716
Cursor.prototype._getCollectionName = function () {                                                    // 717
  var self = this;                                                                                     // 718
  return self._cursorDescription.collectionName;                                                       // 719
}                                                                                                      // 720
                                                                                                       // 721
Cursor.prototype.observe = function (callbacks) {                                                      // 722
  var self = this;                                                                                     // 723
  return LocalCollection._observeFromObserveChanges(self, callbacks);                                  // 724
};                                                                                                     // 725
                                                                                                       // 726
Cursor.prototype.observeChanges = function (callbacks) {                                               // 727
  var self = this;                                                                                     // 728
  var ordered = LocalCollection._observeChangesCallbacksAreOrdered(callbacks);                         // 729
  return self._mongo._observeChanges(                                                                  // 730
    self._cursorDescription, ordered, callbacks);                                                      // 731
};                                                                                                     // 732
                                                                                                       // 733
MongoConnection.prototype._createSynchronousCursor = function(                                         // 734
    cursorDescription, options) {                                                                      // 735
  var self = this;                                                                                     // 736
  options = _.pick(options || {}, 'selfForIteration', 'useTransform');                                 // 737
                                                                                                       // 738
  var collection = self._getCollection(cursorDescription.collectionName);                              // 739
  var cursorOptions = cursorDescription.options;                                                       // 740
  var mongoOptions = {                                                                                 // 741
    sort: cursorOptions.sort,                                                                          // 742
    limit: cursorOptions.limit,                                                                        // 743
    skip: cursorOptions.skip                                                                           // 744
  };                                                                                                   // 745
                                                                                                       // 746
  // Do we want a tailable cursor (which only works on capped collections)?                            // 747
  if (cursorOptions.tailable) {                                                                        // 748
    // We want a tailable cursor...                                                                    // 749
    mongoOptions.tailable = true;                                                                      // 750
    // ... and for the server to wait a bit if any getMore has no data (rather                         // 751
    // than making us put the relevant sleeps in the client)...                                        // 752
    mongoOptions.awaitdata = true;                                                                     // 753
    // ... and to keep querying the server indefinitely rather than just 5 times                       // 754
    // if there's no more data.                                                                        // 755
    mongoOptions.numberOfRetries = -1;                                                                 // 756
    // And if this is on the oplog collection and the cursor specifies a 'ts',                         // 757
    // then set the undocumented oplog replay flag, which does a special scan to                       // 758
    // find the first document (instead of creating an index on ts). This is a                         // 759
    // very hard-coded Mongo flag which only works on the oplog collection and                         // 760
    // only works with the ts field.                                                                   // 761
    if (cursorDescription.collectionName === OPLOG_COLLECTION &&                                       // 762
        cursorDescription.selector.ts) {                                                               // 763
      mongoOptions.oplogReplay = true;                                                                 // 764
    }                                                                                                  // 765
  }                                                                                                    // 766
                                                                                                       // 767
  var dbCursor = collection.find(                                                                      // 768
    replaceTypes(cursorDescription.selector, replaceMeteorAtomWithMongo),                              // 769
    cursorOptions.fields, mongoOptions);                                                               // 770
                                                                                                       // 771
  return new SynchronousCursor(dbCursor, cursorDescription, options);                                  // 772
};                                                                                                     // 773
                                                                                                       // 774
var SynchronousCursor = function (dbCursor, cursorDescription, options) {                              // 775
  var self = this;                                                                                     // 776
  options = _.pick(options || {}, 'selfForIteration', 'useTransform');                                 // 777
                                                                                                       // 778
  self._dbCursor = dbCursor;                                                                           // 779
  self._cursorDescription = cursorDescription;                                                         // 780
  // The "self" argument passed to forEach/map callbacks. If we're wrapped                             // 781
  // inside a user-visible Cursor, we want to provide the outer cursor!                                // 782
  self._selfForIteration = options.selfForIteration || self;                                           // 783
  if (options.useTransform && cursorDescription.options.transform) {                                   // 784
    self._transform = LocalCollection.wrapTransform(                                                   // 785
      cursorDescription.options.transform);                                                            // 786
  } else {                                                                                             // 787
    self._transform = null;                                                                            // 788
  }                                                                                                    // 789
                                                                                                       // 790
  // Need to specify that the callback is the first argument to nextObject,                            // 791
  // since otherwise when we try to call it with no args the driver will                               // 792
  // interpret "undefined" first arg as an options hash and crash.                                     // 793
  self._synchronousNextObject = Future.wrap(                                                           // 794
    dbCursor.nextObject.bind(dbCursor), 0);                                                            // 795
  self._synchronousCount = Future.wrap(dbCursor.count.bind(dbCursor));                                 // 796
  self._visitedIds = new LocalCollection._IdMap;                                                       // 797
};                                                                                                     // 798
                                                                                                       // 799
_.extend(SynchronousCursor.prototype, {                                                                // 800
  _nextObject: function () {                                                                           // 801
    var self = this;                                                                                   // 802
                                                                                                       // 803
    while (true) {                                                                                     // 804
      var doc = self._synchronousNextObject().wait();                                                  // 805
                                                                                                       // 806
      if (!doc) return null;                                                                           // 807
      doc = replaceTypes(doc, replaceMongoAtomWithMeteor);                                             // 808
                                                                                                       // 809
      if (!self._cursorDescription.options.tailable && _.has(doc, '_id')) {                            // 810
        // Did Mongo give us duplicate documents in the same cursor? If so,                            // 811
        // ignore this one. (Do this before the transform, since transform might                       // 812
        // return some unrelated value.) We don't do this for tailable cursors,                        // 813
        // because we want to maintain O(1) memory usage. And if there isn't _id                       // 814
        // for some reason (maybe it's the oplog), then we don't do this either.                       // 815
        // (Be careful to do this for falsey but existing _id, though.)                                // 816
        if (self._visitedIds.has(doc._id)) continue;                                                   // 817
        self._visitedIds.set(doc._id, true);                                                           // 818
      }                                                                                                // 819
                                                                                                       // 820
      if (self._transform)                                                                             // 821
        doc = self._transform(doc);                                                                    // 822
                                                                                                       // 823
      return doc;                                                                                      // 824
    }                                                                                                  // 825
  },                                                                                                   // 826
                                                                                                       // 827
  forEach: function (callback, thisArg) {                                                              // 828
    var self = this;                                                                                   // 829
                                                                                                       // 830
    // We implement the loop ourself instead of using self._dbCursor.each,                             // 831
    // because "each" will call its callback outside of a fiber which makes it                         // 832
    // much more complex to make this function synchronous.                                            // 833
    var index = 0;                                                                                     // 834
    while (true) {                                                                                     // 835
      var doc = self._nextObject();                                                                    // 836
      if (!doc) return;                                                                                // 837
      callback.call(thisArg, doc, index++, self._selfForIteration);                                    // 838
    }                                                                                                  // 839
  },                                                                                                   // 840
                                                                                                       // 841
  // XXX Allow overlapping callback executions if callback yields.                                     // 842
  map: function (callback, thisArg) {                                                                  // 843
    var self = this;                                                                                   // 844
    var res = [];                                                                                      // 845
    self.forEach(function (doc, index) {                                                               // 846
      res.push(callback.call(thisArg, doc, index, self._selfForIteration));                            // 847
    });                                                                                                // 848
    return res;                                                                                        // 849
  },                                                                                                   // 850
                                                                                                       // 851
  rewind: function () {                                                                                // 852
    var self = this;                                                                                   // 853
                                                                                                       // 854
    // known to be synchronous                                                                         // 855
    self._dbCursor.rewind();                                                                           // 856
                                                                                                       // 857
    self._visitedIds = new LocalCollection._IdMap;                                                     // 858
  },                                                                                                   // 859
                                                                                                       // 860
  // Mostly usable for tailable cursors.                                                               // 861
  close: function () {                                                                                 // 862
    var self = this;                                                                                   // 863
                                                                                                       // 864
    self._dbCursor.close();                                                                            // 865
  },                                                                                                   // 866
                                                                                                       // 867
  fetch: function () {                                                                                 // 868
    var self = this;                                                                                   // 869
    return self.map(_.identity);                                                                       // 870
  },                                                                                                   // 871
                                                                                                       // 872
  count: function () {                                                                                 // 873
    var self = this;                                                                                   // 874
    return self._synchronousCount().wait();                                                            // 875
  },                                                                                                   // 876
                                                                                                       // 877
  // This method is NOT wrapped in Cursor.                                                             // 878
  getRawObjects: function (ordered) {                                                                  // 879
    var self = this;                                                                                   // 880
    if (ordered) {                                                                                     // 881
      return self.fetch();                                                                             // 882
    } else {                                                                                           // 883
      var results = new LocalCollection._IdMap;                                                        // 884
      self.forEach(function (doc) {                                                                    // 885
        results.set(doc._id, doc);                                                                     // 886
      });                                                                                              // 887
      return results;                                                                                  // 888
    }                                                                                                  // 889
  }                                                                                                    // 890
});                                                                                                    // 891
                                                                                                       // 892
MongoConnection.prototype.tail = function (cursorDescription, docCallback) {                           // 893
  var self = this;                                                                                     // 894
  if (!cursorDescription.options.tailable)                                                             // 895
    throw new Error("Can only tail a tailable cursor");                                                // 896
                                                                                                       // 897
  var cursor = self._createSynchronousCursor(cursorDescription);                                       // 898
                                                                                                       // 899
  var stopped = false;                                                                                 // 900
  var lastTS = undefined;                                                                              // 901
  var loop = function () {                                                                             // 902
    while (true) {                                                                                     // 903
      if (stopped)                                                                                     // 904
        return;                                                                                        // 905
      try {                                                                                            // 906
        var doc = cursor._nextObject();                                                                // 907
      } catch (err) {                                                                                  // 908
        // There's no good way to figure out if this was actually an error                             // 909
        // from Mongo. Ah well. But either way, we need to retry the cursor                            // 910
        // (unless the failure was because the observe got stopped).                                   // 911
        doc = null;                                                                                    // 912
      }                                                                                                // 913
      // Since cursor._nextObject can yield, we need to check again to see if                          // 914
      // we've been stopped before calling the callback.                                               // 915
      if (stopped)                                                                                     // 916
        return;                                                                                        // 917
      if (doc) {                                                                                       // 918
        // If a tailable cursor contains a "ts" field, use it to recreate the                          // 919
        // cursor on error. ("ts" is a standard that Mongo uses internally for                         // 920
        // the oplog, and there's a special flag that lets you do binary search                        // 921
        // on it instead of needing to use an index.)                                                  // 922
        lastTS = doc.ts;                                                                               // 923
        docCallback(doc);                                                                              // 924
      } else {                                                                                         // 925
        var newSelector = _.clone(cursorDescription.selector);                                         // 926
        if (lastTS) {                                                                                  // 927
          newSelector.ts = {$gt: lastTS};                                                              // 928
        }                                                                                              // 929
        cursor = self._createSynchronousCursor(new CursorDescription(                                  // 930
          cursorDescription.collectionName,                                                            // 931
          newSelector,                                                                                 // 932
          cursorDescription.options));                                                                 // 933
        // Mongo failover takes many seconds.  Retry in a bit.  (Without this                          // 934
        // setTimeout, we peg the CPU at 100% and never notice the actual                              // 935
        // failover.                                                                                   // 936
        Meteor.setTimeout(loop, 100);                                                                  // 937
        break;                                                                                         // 938
      }                                                                                                // 939
    }                                                                                                  // 940
  };                                                                                                   // 941
                                                                                                       // 942
  Meteor.defer(loop);                                                                                  // 943
                                                                                                       // 944
  return {                                                                                             // 945
    stop: function () {                                                                                // 946
      stopped = true;                                                                                  // 947
      cursor.close();                                                                                  // 948
    }                                                                                                  // 949
  };                                                                                                   // 950
};                                                                                                     // 951
                                                                                                       // 952
MongoConnection.prototype._observeChanges = function (                                                 // 953
    cursorDescription, ordered, callbacks) {                                                           // 954
  var self = this;                                                                                     // 955
                                                                                                       // 956
  if (cursorDescription.options.tailable) {                                                            // 957
    return self._observeChangesTailable(cursorDescription, ordered, callbacks);                        // 958
  }                                                                                                    // 959
                                                                                                       // 960
  // You may not filter out _id when observing changes, because the id is a core                       // 961
  // part of the observeChanges API.                                                                   // 962
  if (cursorDescription.options.fields &&                                                              // 963
      (cursorDescription.options.fields._id === 0 ||                                                   // 964
       cursorDescription.options.fields._id === false)) {                                              // 965
    throw Error("You may not observe a cursor with {fields: {_id: 0}}");                               // 966
  }                                                                                                    // 967
                                                                                                       // 968
  var observeKey = JSON.stringify(                                                                     // 969
    _.extend({ordered: ordered}, cursorDescription));                                                  // 970
                                                                                                       // 971
  var multiplexer, observeDriver;                                                                      // 972
  var firstHandle = false;                                                                             // 973
                                                                                                       // 974
  // Find a matching ObserveMultiplexer, or create a new one. This next block is                       // 975
  // guaranteed to not yield (and it doesn't call anything that can observe a                          // 976
  // new query), so no other calls to this function can interleave with it.                            // 977
  Meteor._noYieldsAllowed(function () {                                                                // 978
    if (_.has(self._observeMultiplexers, observeKey)) {                                                // 979
      multiplexer = self._observeMultiplexers[observeKey];                                             // 980
    } else {                                                                                           // 981
      firstHandle = true;                                                                              // 982
      // Create a new ObserveMultiplexer.                                                              // 983
      multiplexer = new ObserveMultiplexer({                                                           // 984
        ordered: ordered,                                                                              // 985
        onStop: function () {                                                                          // 986
          observeDriver.stop();                                                                        // 987
          delete self._observeMultiplexers[observeKey];                                                // 988
        }                                                                                              // 989
      });                                                                                              // 990
      self._observeMultiplexers[observeKey] = multiplexer;                                             // 991
    }                                                                                                  // 992
  });                                                                                                  // 993
                                                                                                       // 994
  var observeHandle = new ObserveHandle(multiplexer, callbacks);                                       // 995
                                                                                                       // 996
  if (firstHandle) {                                                                                   // 997
    var driverClass = PollingObserveDriver;                                                            // 998
    var matcher;                                                                                       // 999
    if (self._oplogHandle && !ordered && !callbacks._testOnlyPollCallback) {                           // 1000
      try {                                                                                            // 1001
        matcher = new Minimongo.Matcher(cursorDescription.selector);                                   // 1002
      } catch (e) {                                                                                    // 1003
        // Ignore and avoid oplog driver. eg, maybe we're trying to compile some                       // 1004
        // newfangled $selector that minimongo doesn't support yet.                                    // 1005
        // XXX make all compilation errors MinimongoError or something                                 // 1006
        //     so that this doesn't ignore unrelated exceptions                                        // 1007
      }                                                                                                // 1008
      if (matcher                                                                                      // 1009
          && OplogObserveDriver.cursorSupported(cursorDescription, matcher)) {                         // 1010
        driverClass = OplogObserveDriver;                                                              // 1011
      }                                                                                                // 1012
    }                                                                                                  // 1013
    observeDriver = new driverClass({                                                                  // 1014
      cursorDescription: cursorDescription,                                                            // 1015
      mongoHandle: self,                                                                               // 1016
      multiplexer: multiplexer,                                                                        // 1017
      ordered: ordered,                                                                                // 1018
      matcher: matcher,  // ignored by polling                                                         // 1019
      _testOnlyPollCallback: callbacks._testOnlyPollCallback                                           // 1020
    });                                                                                                // 1021
                                                                                                       // 1022
    // This field is only set for use in tests.                                                        // 1023
    multiplexer._observeDriver = observeDriver;                                                        // 1024
  }                                                                                                    // 1025
                                                                                                       // 1026
  // Blocks until the initial adds have been sent.                                                     // 1027
  multiplexer.addHandleAndSendInitialAdds(observeHandle);                                              // 1028
                                                                                                       // 1029
  return observeHandle;                                                                                // 1030
};                                                                                                     // 1031
                                                                                                       // 1032
// Listen for the invalidation messages that will trigger us to poll the                               // 1033
// database for changes. If this selector specifies specific IDs, specify them                         // 1034
// here, so that updates to different specific IDs don't cause us to poll.                             // 1035
// listenCallback is the same kind of (notification, complete) callback passed                         // 1036
// to InvalidationCrossbar.listen.                                                                     // 1037
                                                                                                       // 1038
listenAll = function (cursorDescription, listenCallback) {                                             // 1039
  var listeners = [];                                                                                  // 1040
  forEachTrigger(cursorDescription, function (trigger) {                                               // 1041
    listeners.push(DDPServer._InvalidationCrossbar.listen(                                             // 1042
      trigger, listenCallback));                                                                       // 1043
  });                                                                                                  // 1044
                                                                                                       // 1045
  return {                                                                                             // 1046
    stop: function () {                                                                                // 1047
      _.each(listeners, function (listener) {                                                          // 1048
        listener.stop();                                                                               // 1049
      });                                                                                              // 1050
    }                                                                                                  // 1051
  };                                                                                                   // 1052
};                                                                                                     // 1053
                                                                                                       // 1054
forEachTrigger = function (cursorDescription, triggerCallback) {                                       // 1055
  var key = {collection: cursorDescription.collectionName};                                            // 1056
  var specificIds = LocalCollection._idsMatchedBySelector(                                             // 1057
    cursorDescription.selector);                                                                       // 1058
  if (specificIds) {                                                                                   // 1059
    _.each(specificIds, function (id) {                                                                // 1060
      triggerCallback(_.extend({id: id}, key));                                                        // 1061
    });                                                                                                // 1062
    triggerCallback(_.extend({dropCollection: true, id: null}, key));                                  // 1063
  } else {                                                                                             // 1064
    triggerCallback(key);                                                                              // 1065
  }                                                                                                    // 1066
};                                                                                                     // 1067
                                                                                                       // 1068
// observeChanges for tailable cursors on capped collections.                                          // 1069
//                                                                                                     // 1070
// Some differences from normal cursors:                                                               // 1071
//   - Will never produce anything other than 'added' or 'addedBefore'. If you                         // 1072
//     do update a document that has already been produced, this will not notice                       // 1073
//     it.                                                                                             // 1074
//   - If you disconnect and reconnect from Mongo, it will essentially restart                         // 1075
//     the query, which will lead to duplicate results. This is pretty bad,                            // 1076
//     but if you include a field called 'ts' which is inserted as                                     // 1077
//     new MongoInternals.MongoTimestamp(0, 0) (which is initialized to the                            // 1078
//     current Mongo-style timestamp), we'll be able to find the place to                              // 1079
//     restart properly. (This field is specifically understood by Mongo with an                       // 1080
//     optimization which allows it to find the right place to start without                           // 1081
//     an index on ts. It's how the oplog works.)                                                      // 1082
//   - No callbacks are triggered synchronously with the call (there's no                              // 1083
//     differentiation between "initial data" and "later changes"; everything                          // 1084
//     that matches the query gets sent asynchronously).                                               // 1085
//   - De-duplication is not implemented.                                                              // 1086
//   - Does not yet interact with the write fence. Probably, this should work by                       // 1087
//     ignoring removes (which don't work on capped collections) and updates                           // 1088
//     (which don't affect tailable cursors), and just keeping track of the ID                         // 1089
//     of the inserted object, and closing the write fence once you get to that                        // 1090
//     ID (or timestamp?).  This doesn't work well if the document doesn't match                       // 1091
//     the query, though.  On the other hand, the write fence can close                                // 1092
//     immediately if it does not match the query. So if we trust minimongo                            // 1093
//     enough to accurately evaluate the query against the write fence, we                             // 1094
//     should be able to do this...  Of course, minimongo doesn't even support                         // 1095
//     Mongo Timestamps yet.                                                                           // 1096
MongoConnection.prototype._observeChangesTailable = function (                                         // 1097
    cursorDescription, ordered, callbacks) {                                                           // 1098
  var self = this;                                                                                     // 1099
                                                                                                       // 1100
  // Tailable cursors only ever call added/addedBefore callbacks, so it's an                           // 1101
  // error if you didn't provide them.                                                                 // 1102
  if ((ordered && !callbacks.addedBefore) ||                                                           // 1103
      (!ordered && !callbacks.added)) {                                                                // 1104
    throw new Error("Can't observe an " + (ordered ? "ordered" : "unordered")                          // 1105
                    + " tailable cursor without a "                                                    // 1106
                    + (ordered ? "addedBefore" : "added") + " callback");                              // 1107
  }                                                                                                    // 1108
                                                                                                       // 1109
  return self.tail(cursorDescription, function (doc) {                                                 // 1110
    var id = doc._id;                                                                                  // 1111
    delete doc._id;                                                                                    // 1112
    // The ts is an implementation detail. Hide it.                                                    // 1113
    delete doc.ts;                                                                                     // 1114
    if (ordered) {                                                                                     // 1115
      callbacks.addedBefore(id, doc, null);                                                            // 1116
    } else {                                                                                           // 1117
      callbacks.added(id, doc);                                                                        // 1118
    }                                                                                                  // 1119
  });                                                                                                  // 1120
};                                                                                                     // 1121
                                                                                                       // 1122
// XXX We probably need to find a better way to expose this. Right now                                 // 1123
// it's only used by tests, but in fact you need it in normal                                          // 1124
// operation to interact with capped collections (eg, Galaxy uses it).                                 // 1125
MongoInternals.MongoTimestamp = MongoDB.Timestamp;                                                     // 1126
                                                                                                       // 1127
MongoInternals.Connection = MongoConnection;                                                           // 1128
MongoInternals.NpmModule = MongoDB;                                                                    // 1129
                                                                                                       // 1130
/////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

/////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                     //
// packages/mongo-livedata/oplog_tailing.js                                                            //
//                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                       //
var Future = Npm.require('fibers/future');                                                             // 1
                                                                                                       // 2
OPLOG_COLLECTION = 'oplog.rs';                                                                         // 3
var REPLSET_COLLECTION = 'system.replset';                                                             // 4
                                                                                                       // 5
// Like Perl's quotemeta: quotes all regexp metacharacters. See                                        // 6
//   https://github.com/substack/quotemeta/blob/master/index.js                                        // 7
// XXX this is duplicated with accounts_server.js                                                      // 8
var quotemeta = function (str) {                                                                       // 9
    return String(str).replace(/(\W)/g, '\\$1');                                                       // 10
};                                                                                                     // 11
                                                                                                       // 12
var showTS = function (ts) {                                                                           // 13
  return "Timestamp(" + ts.getHighBits() + ", " + ts.getLowBits() + ")";                               // 14
};                                                                                                     // 15
                                                                                                       // 16
idForOp = function (op) {                                                                              // 17
  if (op.op === 'd')                                                                                   // 18
    return op.o._id;                                                                                   // 19
  else if (op.op === 'i')                                                                              // 20
    return op.o._id;                                                                                   // 21
  else if (op.op === 'u')                                                                              // 22
    return op.o2._id;                                                                                  // 23
  else if (op.op === 'c')                                                                              // 24
    throw Error("Operator 'c' doesn't supply an object with id: " +                                    // 25
                EJSON.stringify(op));                                                                  // 26
  else                                                                                                 // 27
    throw Error("Unknown op: " + EJSON.stringify(op));                                                 // 28
};                                                                                                     // 29
                                                                                                       // 30
OplogHandle = function (oplogUrl, dbName) {                                                            // 31
  var self = this;                                                                                     // 32
  self._oplogUrl = oplogUrl;                                                                           // 33
  self._dbName = dbName;                                                                               // 34
                                                                                                       // 35
  self._oplogLastEntryConnection = null;                                                               // 36
  self._oplogTailConnection = null;                                                                    // 37
  self._stopped = false;                                                                               // 38
  self._tailHandle = null;                                                                             // 39
  self._readyFuture = new Future();                                                                    // 40
  self._crossbar = new DDPServer._Crossbar({                                                           // 41
    factPackage: "mongo-livedata", factName: "oplog-watchers"                                          // 42
  });                                                                                                  // 43
  self._lastProcessedTS = null;                                                                        // 44
  self._baseOplogSelector = {                                                                          // 45
    ns: new RegExp('^' + quotemeta(self._dbName) + '\\.'),                                             // 46
    $or: [                                                                                             // 47
      { op: {$in: ['i', 'u', 'd']} },                                                                  // 48
      // If it is not db.collection.drop(), ignore it                                                  // 49
      { op: 'c', 'o.drop': { $exists: true } }]                                                        // 50
  };                                                                                                   // 51
  // XXX doc                                                                                           // 52
  self._catchingUpFutures = [];                                                                        // 53
                                                                                                       // 54
  self._startTailing();                                                                                // 55
};                                                                                                     // 56
                                                                                                       // 57
_.extend(OplogHandle.prototype, {                                                                      // 58
  stop: function () {                                                                                  // 59
    var self = this;                                                                                   // 60
    if (self._stopped)                                                                                 // 61
      return;                                                                                          // 62
    self._stopped = true;                                                                              // 63
    if (self._tailHandle)                                                                              // 64
      self._tailHandle.stop();                                                                         // 65
    // XXX should close connections too                                                                // 66
  },                                                                                                   // 67
  onOplogEntry: function (trigger, callback) {                                                         // 68
    var self = this;                                                                                   // 69
    if (self._stopped)                                                                                 // 70
      throw new Error("Called onOplogEntry on stopped handle!");                                       // 71
                                                                                                       // 72
    // Calling onOplogEntry requires us to wait for the tailing to be ready.                           // 73
    self._readyFuture.wait();                                                                          // 74
                                                                                                       // 75
    var originalCallback = callback;                                                                   // 76
    callback = Meteor.bindEnvironment(function (notification) {                                        // 77
      // XXX can we avoid this clone by making oplog.js careful?                                       // 78
      originalCallback(EJSON.clone(notification));                                                     // 79
    }, function (err) {                                                                                // 80
      Meteor._debug("Error in oplog callback", err.stack);                                             // 81
    });                                                                                                // 82
    var listenHandle = self._crossbar.listen(trigger, callback);                                       // 83
    return {                                                                                           // 84
      stop: function () {                                                                              // 85
        listenHandle.stop();                                                                           // 86
      }                                                                                                // 87
    };                                                                                                 // 88
  },                                                                                                   // 89
  // Calls `callback` once the oplog has been processed up to a point that is                          // 90
  // roughly "now": specifically, once we've processed all ops that are                                // 91
  // currently visible.                                                                                // 92
  // XXX become convinced that this is actually safe even if oplogConnection                           // 93
  // is some kind of pool                                                                              // 94
  waitUntilCaughtUp: function () {                                                                     // 95
    var self = this;                                                                                   // 96
    if (self._stopped)                                                                                 // 97
      throw new Error("Called waitUntilCaughtUp on stopped handle!");                                  // 98
                                                                                                       // 99
    // Calling waitUntilCaughtUp requries us to wait for the oplog connection to                       // 100
    // be ready.                                                                                       // 101
    self._readyFuture.wait();                                                                          // 102
                                                                                                       // 103
    // We need to make the selector at least as restrictive as the actual                              // 104
    // tailing selector (ie, we need to specify the DB name) or else we might                          // 105
    // find a TS that won't show up in the actual tail stream.                                         // 106
    var lastEntry = self._oplogLastEntryConnection.findOne(                                            // 107
      OPLOG_COLLECTION, self._baseOplogSelector,                                                       // 108
      {fields: {ts: 1}, sort: {$natural: -1}});                                                        // 109
                                                                                                       // 110
    if (!lastEntry) {                                                                                  // 111
      // Really, nothing in the oplog? Well, we've processed everything.                               // 112
      return;                                                                                          // 113
    }                                                                                                  // 114
                                                                                                       // 115
    var ts = lastEntry.ts;                                                                             // 116
    if (!ts)                                                                                           // 117
      throw Error("oplog entry without ts: " + EJSON.stringify(lastEntry));                            // 118
                                                                                                       // 119
    if (self._lastProcessedTS && ts.lessThanOrEqual(self._lastProcessedTS)) {                          // 120
      // We've already caught up to here.                                                              // 121
      return;                                                                                          // 122
    }                                                                                                  // 123
                                                                                                       // 124
                                                                                                       // 125
    // Insert the future into our list. Almost always, this will be at the end,                        // 126
    // but it's conceivable that if we fail over from one primary to another,                          // 127
    // the oplog entries we see will go backwards.                                                     // 128
    var insertAfter = self._catchingUpFutures.length;                                                  // 129
    while (insertAfter - 1 > 0                                                                         // 130
           && self._catchingUpFutures[insertAfter - 1].ts.greaterThan(ts)) {                           // 131
      insertAfter--;                                                                                   // 132
    }                                                                                                  // 133
    var f = new Future;                                                                                // 134
    self._catchingUpFutures.splice(insertAfter, 0, {ts: ts, future: f});                               // 135
    f.wait();                                                                                          // 136
  },                                                                                                   // 137
  _startTailing: function () {                                                                         // 138
    var self = this;                                                                                   // 139
    // We make two separate connections to Mongo. The Node Mongo driver                                // 140
    // implements a naive round-robin connection pool: each "connection" is a                          // 141
    // pool of several (5 by default) TCP connections, and each request is                             // 142
    // rotated through the pools. Tailable cursor queries block on the server                          // 143
    // until there is some data to return (or until a few seconds have                                 // 144
    // passed). So if the connection pool used for tailing cursors is the same                         // 145
    // pool used for other queries, the other queries will be delayed by seconds                       // 146
    // 1/5 of the time.                                                                                // 147
    //                                                                                                 // 148
    // The tail connection will only ever be running a single tail command, so                         // 149
    // it only needs to make one underlying TCP connection.                                            // 150
    self._oplogTailConnection = new MongoConnection(                                                   // 151
      self._oplogUrl, {poolSize: 1});                                                                  // 152
    // XXX better docs, but: it's to get monotonic results                                             // 153
    // XXX is it safe to say "if there's an in flight query, just use its                              // 154
    //     results"? I don't think so but should consider that                                         // 155
    self._oplogLastEntryConnection = new MongoConnection(                                              // 156
      self._oplogUrl, {poolSize: 1});                                                                  // 157
                                                                                                       // 158
    // First, make sure that there actually is a repl set here. If not, oplog                          // 159
    // tailing won't ever find anything! (Blocks until the connection is ready.)                       // 160
    var replSetInfo = self._oplogLastEntryConnection.findOne(                                          // 161
      REPLSET_COLLECTION, {});                                                                         // 162
    if (!replSetInfo)                                                                                  // 163
      throw Error("$MONGO_OPLOG_URL must be set to the 'local' database of " +                         // 164
                  "a Mongo replica set");                                                              // 165
                                                                                                       // 166
    // Find the last oplog entry.                                                                      // 167
    var lastOplogEntry = self._oplogLastEntryConnection.findOne(                                       // 168
      OPLOG_COLLECTION, {}, {sort: {$natural: -1}});                                                   // 169
                                                                                                       // 170
    var oplogSelector = _.clone(self._baseOplogSelector);                                              // 171
    if (lastOplogEntry) {                                                                              // 172
      // Start after the last entry that currently exists.                                             // 173
      oplogSelector.ts = {$gt: lastOplogEntry.ts};                                                     // 174
      // If there are any calls to callWhenProcessedLatest before any other                            // 175
      // oplog entries show up, allow callWhenProcessedLatest to call its                              // 176
      // callback immediately.                                                                         // 177
      self._lastProcessedTS = lastOplogEntry.ts;                                                       // 178
    }                                                                                                  // 179
                                                                                                       // 180
    var cursorDescription = new CursorDescription(                                                     // 181
      OPLOG_COLLECTION, oplogSelector, {tailable: true});                                              // 182
                                                                                                       // 183
    self._tailHandle = self._oplogTailConnection.tail(                                                 // 184
      cursorDescription, function (doc) {                                                              // 185
        if (!(doc.ns && doc.ns.length > self._dbName.length + 1 &&                                     // 186
              doc.ns.substr(0, self._dbName.length + 1) ===                                            // 187
              (self._dbName + '.'))) {                                                                 // 188
          throw new Error("Unexpected ns");                                                            // 189
        }                                                                                              // 190
                                                                                                       // 191
        var trigger = {collection: doc.ns.substr(self._dbName.length + 1),                             // 192
                       dropCollection: false,                                                          // 193
                       op: doc};                                                                       // 194
                                                                                                       // 195
        // Is it a special command and the collection name is hidden somewhere                         // 196
        // in operator?                                                                                // 197
        if (trigger.collection === "$cmd") {                                                           // 198
          trigger.collection = doc.o.drop;                                                             // 199
          trigger.dropCollection = true;                                                               // 200
          trigger.id = null;                                                                           // 201
        } else {                                                                                       // 202
          // All other ops have an id.                                                                 // 203
          trigger.id = idForOp(doc);                                                                   // 204
        }                                                                                              // 205
                                                                                                       // 206
        self._crossbar.fire(trigger);                                                                  // 207
                                                                                                       // 208
        // Now that we've processed this operation, process pending sequencers.                        // 209
        if (!doc.ts)                                                                                   // 210
          throw Error("oplog entry without ts: " + EJSON.stringify(doc));                              // 211
        self._lastProcessedTS = doc.ts;                                                                // 212
        while (!_.isEmpty(self._catchingUpFutures)                                                     // 213
               && self._catchingUpFutures[0].ts.lessThanOrEqual(                                       // 214
                 self._lastProcessedTS)) {                                                             // 215
          var sequencer = self._catchingUpFutures.shift();                                             // 216
          sequencer.future.return();                                                                   // 217
        }                                                                                              // 218
      });                                                                                              // 219
    self._readyFuture.return();                                                                        // 220
  }                                                                                                    // 221
});                                                                                                    // 222
                                                                                                       // 223
/////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

/////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                     //
// packages/mongo-livedata/observe_multiplex.js                                                        //
//                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                       //
var Future = Npm.require('fibers/future');                                                             // 1
                                                                                                       // 2
ObserveMultiplexer = function (options) {                                                              // 3
  var self = this;                                                                                     // 4
                                                                                                       // 5
  if (!options || !_.has(options, 'ordered'))                                                          // 6
    throw Error("must specified ordered");                                                             // 7
                                                                                                       // 8
  Package.facts && Package.facts.Facts.incrementServerFact(                                            // 9
    "mongo-livedata", "observe-multiplexers", 1);                                                      // 10
                                                                                                       // 11
  self._ordered = options.ordered;                                                                     // 12
  self._onStop = options.onStop || function () {};                                                     // 13
  self._queue = new Meteor._SynchronousQueue();                                                        // 14
  self._handles = {};                                                                                  // 15
  self._readyFuture = new Future;                                                                      // 16
  self._cache = new LocalCollection._CachingChangeObserver({                                           // 17
    ordered: options.ordered});                                                                        // 18
  // Number of addHandleAndSendInitialAdds tasks scheduled but not yet                                 // 19
  // running. removeHandle uses this to know if it's time to call the onStop                           // 20
  // callback.                                                                                         // 21
  self._addHandleTasksScheduledButNotPerformed = 0;                                                    // 22
                                                                                                       // 23
  _.each(self.callbackNames(), function (callbackName) {                                               // 24
    self[callbackName] = function (/* ... */) {                                                        // 25
      self._applyCallback(callbackName, _.toArray(arguments));                                         // 26
    };                                                                                                 // 27
  });                                                                                                  // 28
};                                                                                                     // 29
                                                                                                       // 30
_.extend(ObserveMultiplexer.prototype, {                                                               // 31
  addHandleAndSendInitialAdds: function (handle) {                                                     // 32
    var self = this;                                                                                   // 33
                                                                                                       // 34
    // Check this before calling runTask (even though runTask does the same                            // 35
    // check) so that we don't leak an ObserveMultiplexer on error by                                  // 36
    // incrementing _addHandleTasksScheduledButNotPerformed and never                                  // 37
    // decrementing it.                                                                                // 38
    if (!self._queue.safeToRunTask())                                                                  // 39
      throw new Error(                                                                                 // 40
        "Can't call observeChanges from an observe callback on the same query");                       // 41
    ++self._addHandleTasksScheduledButNotPerformed;                                                    // 42
                                                                                                       // 43
    Package.facts && Package.facts.Facts.incrementServerFact(                                          // 44
      "mongo-livedata", "observe-handles", 1);                                                         // 45
                                                                                                       // 46
    self._queue.runTask(function () {                                                                  // 47
      self._handles[handle._id] = handle;                                                              // 48
      // Send out whatever adds we have so far (whether or not we the                                  // 49
      // multiplexer is ready).                                                                        // 50
      self._sendAdds(handle);                                                                          // 51
      --self._addHandleTasksScheduledButNotPerformed;                                                  // 52
    });                                                                                                // 53
    // *outside* the task, since otherwise we'd deadlock                                               // 54
    self._readyFuture.wait();                                                                          // 55
  },                                                                                                   // 56
                                                                                                       // 57
  // Remove an observe handle. If it was the last observe handle, call the                             // 58
  // onStop callback; you cannot add any more observe handles after this.                              // 59
  //                                                                                                   // 60
  // This is not synchronized with polls and handle additions: this means that                         // 61
  // you can safely call it from within an observe callback, but it also means                         // 62
  // that we have to be careful when we iterate over _handles.                                         // 63
  removeHandle: function (id) {                                                                        // 64
    var self = this;                                                                                   // 65
                                                                                                       // 66
    // This should not be possible: you can only call removeHandle by having                           // 67
    // access to the ObserveHandle, which isn't returned to user code until the                        // 68
    // multiplex is ready.                                                                             // 69
    if (!self._ready())                                                                                // 70
      throw new Error("Can't remove handles until the multiplex is ready");                            // 71
                                                                                                       // 72
    delete self._handles[id];                                                                          // 73
                                                                                                       // 74
    Package.facts && Package.facts.Facts.incrementServerFact(                                          // 75
      "mongo-livedata", "observe-handles", -1);                                                        // 76
                                                                                                       // 77
    if (_.isEmpty(self._handles) &&                                                                    // 78
        self._addHandleTasksScheduledButNotPerformed === 0) {                                          // 79
      self._stop();                                                                                    // 80
    }                                                                                                  // 81
  },                                                                                                   // 82
  _stop: function () {                                                                                 // 83
    var self = this;                                                                                   // 84
    // It shouldn't be possible for us to stop when all our handles still                              // 85
    // haven't been returned from observeChanges!                                                      // 86
    if (!self._ready())                                                                                // 87
      throw Error("surprising _stop: not ready");                                                      // 88
                                                                                                       // 89
    // Call stop callback (which kills the underlying process which sends us                           // 90
    // callbacks and removes us from the connection's dictionary).                                     // 91
    self._onStop();                                                                                    // 92
    Package.facts && Package.facts.Facts.incrementServerFact(                                          // 93
      "mongo-livedata", "observe-multiplexers", -1);                                                   // 94
                                                                                                       // 95
    // Cause future addHandleAndSendInitialAdds calls to throw (but the onStop                         // 96
    // callback should make our connection forget about us).                                           // 97
    self._handles = null;                                                                              // 98
  },                                                                                                   // 99
  // Allows all addHandleAndSendInitialAdds calls to return, once all preceding                        // 100
  // adds have been processed. Does not block.                                                         // 101
  ready: function () {                                                                                 // 102
    var self = this;                                                                                   // 103
    self._queue.queueTask(function () {                                                                // 104
      if (self._ready())                                                                               // 105
        throw Error("can't make ObserveMultiplex ready twice!");                                       // 106
      self._readyFuture.return();                                                                      // 107
    });                                                                                                // 108
  },                                                                                                   // 109
  // Calls "cb" once the effects of all "ready", "addHandleAndSendInitialAdds"                         // 110
  // and observe callbacks which came before this call have been propagated to                         // 111
  // all handles. "ready" must have already been called on this multiplexer.                           // 112
  onFlush: function (cb) {                                                                             // 113
    var self = this;                                                                                   // 114
    self._queue.queueTask(function () {                                                                // 115
      if (!self._ready())                                                                              // 116
        throw Error("only call onFlush on a multiplexer that will be ready");                          // 117
      cb();                                                                                            // 118
    });                                                                                                // 119
  },                                                                                                   // 120
  callbackNames: function () {                                                                         // 121
    var self = this;                                                                                   // 122
    if (self._ordered)                                                                                 // 123
      return ["addedBefore", "changed", "movedBefore", "removed"];                                     // 124
    else                                                                                               // 125
      return ["added", "changed", "removed"];                                                          // 126
  },                                                                                                   // 127
  _ready: function () {                                                                                // 128
    return this._readyFuture.isResolved();                                                             // 129
  },                                                                                                   // 130
  _applyCallback: function (callbackName, args) {                                                      // 131
    var self = this;                                                                                   // 132
    self._queue.queueTask(function () {                                                                // 133
      // First, apply the change to the cache.                                                         // 134
      // XXX We could make applyChange callbacks promise not to hang on to any                         // 135
      // state from their arguments (assuming that their supplied callbacks                            // 136
      // don't) and skip this clone. Currently 'changed' hangs on to state                             // 137
      // though.                                                                                       // 138
      self._cache.applyChange[callbackName].apply(null, EJSON.clone(args));                            // 139
                                                                                                       // 140
      // If we haven't finished the initial adds, then we should only be getting                       // 141
      // adds.                                                                                         // 142
      if (!self._ready() &&                                                                            // 143
          (callbackName !== 'added' && callbackName !== 'addedBefore')) {                              // 144
        throw new Error("Got " + callbackName + " during initial adds");                               // 145
      }                                                                                                // 146
                                                                                                       // 147
      // Now multiplex the callbacks out to all observe handles. It's OK if                            // 148
      // these calls yield; since we're inside a task, no other use of our queue                       // 149
      // can continue until these are done. (But we do have to be careful to not                       // 150
      // use a handle that got removed, because removeHandle does not use the                          // 151
      // queue; thus, we iterate over an array of keys that we control.)                               // 152
      _.each(_.keys(self._handles), function (handleId) {                                              // 153
        var handle = self._handles[handleId];                                                          // 154
        if (!handle)                                                                                   // 155
          return;                                                                                      // 156
        var callback = handle['_' + callbackName];                                                     // 157
        // clone arguments so that callbacks can mutate their arguments                                // 158
        callback && callback.apply(null, EJSON.clone(args));                                           // 159
      });                                                                                              // 160
    });                                                                                                // 161
  },                                                                                                   // 162
                                                                                                       // 163
  // Sends initial adds to a handle. It should only be called from within a task                       // 164
  // (the task that is processing the addHandleAndSendInitialAdds call). It                            // 165
  // synchronously invokes the handle's added or addedBefore; there's no need to                       // 166
  // flush the queue afterwards to ensure that the callbacks get out.                                  // 167
  _sendAdds: function (handle) {                                                                       // 168
    var self = this;                                                                                   // 169
    if (self._queue.safeToRunTask())                                                                   // 170
      throw Error("_sendAdds may only be called from within a task!");                                 // 171
    var add = self._ordered ? handle._addedBefore : handle._added;                                     // 172
    if (!add)                                                                                          // 173
      return;                                                                                          // 174
    // note: docs may be an _IdMap or an OrderedDict                                                   // 175
    self._cache.docs.forEach(function (doc, id) {                                                      // 176
      if (!_.has(self._handles, handle._id))                                                           // 177
        throw Error("handle got removed before sending initial adds!");                                // 178
      var fields = EJSON.clone(doc);                                                                   // 179
      delete fields._id;                                                                               // 180
      if (self._ordered)                                                                               // 181
        add(id, fields, null); // we're going in order, so add at end                                  // 182
      else                                                                                             // 183
        add(id, fields);                                                                               // 184
    });                                                                                                // 185
  }                                                                                                    // 186
});                                                                                                    // 187
                                                                                                       // 188
                                                                                                       // 189
var nextObserveHandleId = 1;                                                                           // 190
ObserveHandle = function (multiplexer, callbacks) {                                                    // 191
  var self = this;                                                                                     // 192
  // The end user is only supposed to call stop().  The other fields are                               // 193
  // accessible to the multiplexer, though.                                                            // 194
  self._multiplexer = multiplexer;                                                                     // 195
  _.each(multiplexer.callbackNames(), function (name) {                                                // 196
    if (callbacks[name]) {                                                                             // 197
      self['_' + name] = callbacks[name];                                                              // 198
    } else if (name === "addedBefore" && callbacks.added) {                                            // 199
      // Special case: if you specify "added" and "movedBefore", you get an                            // 200
      // ordered observe where for some reason you don't get ordering data on                          // 201
      // the adds.  I dunno, we wrote tests for it, there must have been a                             // 202
      // reason.                                                                                       // 203
      self._addedBefore = function (id, fields, before) {                                              // 204
        callbacks.added(id, fields);                                                                   // 205
      };                                                                                               // 206
    }                                                                                                  // 207
  });                                                                                                  // 208
  self._stopped = false;                                                                               // 209
  self._id = nextObserveHandleId++;                                                                    // 210
};                                                                                                     // 211
ObserveHandle.prototype.stop = function () {                                                           // 212
  var self = this;                                                                                     // 213
  if (self._stopped)                                                                                   // 214
    return;                                                                                            // 215
  self._stopped = true;                                                                                // 216
  self._multiplexer.removeHandle(self._id);                                                            // 217
};                                                                                                     // 218
                                                                                                       // 219
/////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

/////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                     //
// packages/mongo-livedata/doc_fetcher.js                                                              //
//                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                       //
var Fiber = Npm.require('fibers');                                                                     // 1
var Future = Npm.require('fibers/future');                                                             // 2
                                                                                                       // 3
DocFetcher = function (mongoConnection) {                                                              // 4
  var self = this;                                                                                     // 5
  self._mongoConnection = mongoConnection;                                                             // 6
  // Map from cache key -> [callback]                                                                  // 7
  self._callbacksForCacheKey = {};                                                                     // 8
};                                                                                                     // 9
                                                                                                       // 10
_.extend(DocFetcher.prototype, {                                                                       // 11
  // Fetches document "id" from collectionName, returning it or null if not                            // 12
  // found.                                                                                            // 13
  //                                                                                                   // 14
  // If you make multiple calls to fetch() with the same cacheKey (a string),                          // 15
  // DocFetcher may assume that they all return the same document. (It does                            // 16
  // not check to see if collectionName/id match.)                                                     // 17
  //                                                                                                   // 18
  // You may assume that callback is never called synchronously (and in fact                           // 19
  // OplogObserveDriver does so).                                                                      // 20
  fetch: function (collectionName, id, cacheKey, callback) {                                           // 21
    var self = this;                                                                                   // 22
                                                                                                       // 23
    check(collectionName, String);                                                                     // 24
    // id is some sort of scalar                                                                       // 25
    check(cacheKey, String);                                                                           // 26
                                                                                                       // 27
    // If there's already an in-progress fetch for this cache key, yield until                         // 28
    // it's done and return whatever it returns.                                                       // 29
    if (_.has(self._callbacksForCacheKey, cacheKey)) {                                                 // 30
      self._callbacksForCacheKey[cacheKey].push(callback);                                             // 31
      return;                                                                                          // 32
    }                                                                                                  // 33
                                                                                                       // 34
    var callbacks = self._callbacksForCacheKey[cacheKey] = [callback];                                 // 35
                                                                                                       // 36
    Fiber(function () {                                                                                // 37
      try {                                                                                            // 38
        var doc = self._mongoConnection.findOne(                                                       // 39
          collectionName, {_id: id}) || null;                                                          // 40
        // Return doc to all relevant callbacks. Note that this array can                              // 41
        // continue to grow during callback excecution.                                                // 42
        while (!_.isEmpty(callbacks)) {                                                                // 43
          // Clone the document so that the various calls to fetch don't return                        // 44
          // objects that are intertwingled with each other. Clone before                              // 45
          // popping the future, so that if clone throws, the error gets passed                        // 46
          // to the next callback.                                                                     // 47
          var clonedDoc = EJSON.clone(doc);                                                            // 48
          callbacks.pop()(null, clonedDoc);                                                            // 49
        }                                                                                              // 50
      } catch (e) {                                                                                    // 51
        while (!_.isEmpty(callbacks)) {                                                                // 52
          callbacks.pop()(e);                                                                          // 53
        }                                                                                              // 54
      } finally {                                                                                      // 55
        // XXX consider keeping the doc around for a period of time before                             // 56
        // removing from the cache                                                                     // 57
        delete self._callbacksForCacheKey[cacheKey];                                                   // 58
      }                                                                                                // 59
    }).run();                                                                                          // 60
  }                                                                                                    // 61
});                                                                                                    // 62
                                                                                                       // 63
MongoTest.DocFetcher = DocFetcher;                                                                     // 64
                                                                                                       // 65
/////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

/////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                     //
// packages/mongo-livedata/polling_observe_driver.js                                                   //
//                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                       //
PollingObserveDriver = function (options) {                                                            // 1
  var self = this;                                                                                     // 2
                                                                                                       // 3
  self._cursorDescription = options.cursorDescription;                                                 // 4
  self._mongoHandle = options.mongoHandle;                                                             // 5
  self._ordered = options.ordered;                                                                     // 6
  self._multiplexer = options.multiplexer;                                                             // 7
  self._stopCallbacks = [];                                                                            // 8
  self._stopped = false;                                                                               // 9
                                                                                                       // 10
  self._synchronousCursor = self._mongoHandle._createSynchronousCursor(                                // 11
    self._cursorDescription);                                                                          // 12
                                                                                                       // 13
  // previous results snapshot.  on each poll cycle, diffs against                                     // 14
  // results drives the callbacks.                                                                     // 15
  self._results = null;                                                                                // 16
                                                                                                       // 17
  // The number of _pollMongo calls that have been added to self._taskQueue but                        // 18
  // have not started running. Used to make sure we never schedule more than one                       // 19
  // _pollMongo (other than possibly the one that is currently running). It's                          // 20
  // also used by _suspendPolling to pretend there's a poll scheduled. Usually,                        // 21
  // it's either 0 (for "no polls scheduled other than maybe one currently                             // 22
  // running") or 1 (for "a poll scheduled that isn't running yet"), but it can                        // 23
  // also be 2 if incremented by _suspendPolling.                                                      // 24
  self._pollsScheduledButNotStarted = 0;                                                               // 25
  self._pendingWrites = []; // people to notify when polling completes                                 // 26
                                                                                                       // 27
  // Make sure to create a separately throttled function for each                                      // 28
  // PollingObserveDriver object.                                                                      // 29
  self._ensurePollIsScheduled = _.throttle(                                                            // 30
    self._unthrottledEnsurePollIsScheduled, 50 /* ms */);                                              // 31
                                                                                                       // 32
  // XXX figure out if we still need a queue                                                           // 33
  self._taskQueue = new Meteor._SynchronousQueue();                                                    // 34
                                                                                                       // 35
  var listenersHandle = listenAll(                                                                     // 36
    self._cursorDescription, function (notification) {                                                 // 37
      // When someone does a transaction that might affect us, schedule a poll                         // 38
      // of the database. If that transaction happens inside of a write fence,                         // 39
      // block the fence until we've polled and notified observers.                                    // 40
      var fence = DDPServer._CurrentWriteFence.get();                                                  // 41
      if (fence)                                                                                       // 42
        self._pendingWrites.push(fence.beginWrite());                                                  // 43
      // Ensure a poll is scheduled... but if we already know that one is,                             // 44
      // don't hit the throttled _ensurePollIsScheduled function (which might                          // 45
      // lead to us calling it unnecessarily in 50ms).                                                 // 46
      if (self._pollsScheduledButNotStarted === 0)                                                     // 47
        self._ensurePollIsScheduled();                                                                 // 48
    }                                                                                                  // 49
  );                                                                                                   // 50
  self._stopCallbacks.push(function () { listenersHandle.stop(); });                                   // 51
                                                                                                       // 52
  // every once and a while, poll even if we don't think we're dirty, for                              // 53
  // eventual consistency with database writes from outside the Meteor                                 // 54
  // universe.                                                                                         // 55
  //                                                                                                   // 56
  // For testing, there's an undocumented callback argument to observeChanges                          // 57
  // which disables time-based polling and gets called at the beginning of each                        // 58
  // poll.                                                                                             // 59
  if (options._testOnlyPollCallback) {                                                                 // 60
    self._testOnlyPollCallback = options._testOnlyPollCallback;                                        // 61
  } else {                                                                                             // 62
    var intervalHandle = Meteor.setInterval(                                                           // 63
      _.bind(self._ensurePollIsScheduled, self), 10 * 1000);                                           // 64
    self._stopCallbacks.push(function () {                                                             // 65
      Meteor.clearInterval(intervalHandle);                                                            // 66
    });                                                                                                // 67
  }                                                                                                    // 68
                                                                                                       // 69
  // Make sure we actually poll soon!                                                                  // 70
  self._unthrottledEnsurePollIsScheduled();                                                            // 71
                                                                                                       // 72
  Package.facts && Package.facts.Facts.incrementServerFact(                                            // 73
    "mongo-livedata", "observe-drivers-polling", 1);                                                   // 74
};                                                                                                     // 75
                                                                                                       // 76
_.extend(PollingObserveDriver.prototype, {                                                             // 77
  // This is always called through _.throttle (except once at startup).                                // 78
  _unthrottledEnsurePollIsScheduled: function () {                                                     // 79
    var self = this;                                                                                   // 80
    if (self._pollsScheduledButNotStarted > 0)                                                         // 81
      return;                                                                                          // 82
    ++self._pollsScheduledButNotStarted;                                                               // 83
    self._taskQueue.queueTask(function () {                                                            // 84
      self._pollMongo();                                                                               // 85
    });                                                                                                // 86
  },                                                                                                   // 87
                                                                                                       // 88
  // test-only interface for controlling polling.                                                      // 89
  //                                                                                                   // 90
  // _suspendPolling blocks until any currently running and scheduled polls are                        // 91
  // done, and prevents any further polls from being scheduled. (new                                   // 92
  // ObserveHandles can be added and receive their initial added callbacks,                            // 93
  // though.)                                                                                          // 94
  //                                                                                                   // 95
  // _resumePolling immediately polls, and allows further polls to occur.                              // 96
  _suspendPolling: function() {                                                                        // 97
    var self = this;                                                                                   // 98
    // Pretend that there's another poll scheduled (which will prevent                                 // 99
    // _ensurePollIsScheduled from queueing any more polls).                                           // 100
    ++self._pollsScheduledButNotStarted;                                                               // 101
    // Now block until all currently running or scheduled polls are done.                              // 102
    self._taskQueue.runTask(function() {});                                                            // 103
                                                                                                       // 104
    // Confirm that there is only one "poll" (the fake one we're pretending to                         // 105
    // have) scheduled.                                                                                // 106
    if (self._pollsScheduledButNotStarted !== 1)                                                       // 107
      throw new Error("_pollsScheduledButNotStarted is " +                                             // 108
                      self._pollsScheduledButNotStarted);                                              // 109
  },                                                                                                   // 110
  _resumePolling: function() {                                                                         // 111
    var self = this;                                                                                   // 112
    // We should be in the same state as in the end of _suspendPolling.                                // 113
    if (self._pollsScheduledButNotStarted !== 1)                                                       // 114
      throw new Error("_pollsScheduledButNotStarted is " +                                             // 115
                      self._pollsScheduledButNotStarted);                                              // 116
    // Run a poll synchronously (which will counteract the                                             // 117
    // ++_pollsScheduledButNotStarted from _suspendPolling).                                           // 118
    self._taskQueue.runTask(function () {                                                              // 119
      self._pollMongo();                                                                               // 120
    });                                                                                                // 121
  },                                                                                                   // 122
                                                                                                       // 123
  _pollMongo: function () {                                                                            // 124
    var self = this;                                                                                   // 125
    --self._pollsScheduledButNotStarted;                                                               // 126
                                                                                                       // 127
    var first = false;                                                                                 // 128
    if (!self._results) {                                                                              // 129
      first = true;                                                                                    // 130
      // XXX maybe use OrderedDict instead?                                                            // 131
      self._results = self._ordered ? [] : new LocalCollection._IdMap;                                 // 132
    }                                                                                                  // 133
                                                                                                       // 134
    self._testOnlyPollCallback && self._testOnlyPollCallback();                                        // 135
                                                                                                       // 136
    // Save the list of pending writes which this round will commit.                                   // 137
    var writesForCycle = self._pendingWrites;                                                          // 138
    self._pendingWrites = [];                                                                          // 139
                                                                                                       // 140
    // Get the new query results. (These calls can yield.)                                             // 141
    if (!first)                                                                                        // 142
      self._synchronousCursor.rewind();                                                                // 143
    var newResults = self._synchronousCursor.getRawObjects(self._ordered);                             // 144
    var oldResults = self._results;                                                                    // 145
                                                                                                       // 146
    // Run diffs. (This can yield too.)                                                                // 147
    if (!self._stopped) {                                                                              // 148
      LocalCollection._diffQueryChanges(                                                               // 149
        self._ordered, oldResults, newResults, self._multiplexer);                                     // 150
    }                                                                                                  // 151
                                                                                                       // 152
    // Replace self._results atomically.                                                               // 153
    self._results = newResults;                                                                        // 154
                                                                                                       // 155
    // Signals the multiplexer to call all initial adds.                                               // 156
    if (first)                                                                                         // 157
      self._multiplexer.ready();                                                                       // 158
                                                                                                       // 159
    // Once the ObserveMultiplexer has processed everything we've done in this                         // 160
    // round, mark all the writes which existed before this call as                                    // 161
    // commmitted. (If new writes have shown up in the meantime, there'll                              // 162
    // already be another _pollMongo task scheduled.)                                                  // 163
    self._multiplexer.onFlush(function () {                                                            // 164
      _.each(writesForCycle, function (w) {                                                            // 165
        w.committed();                                                                                 // 166
      });                                                                                              // 167
    });                                                                                                // 168
  },                                                                                                   // 169
                                                                                                       // 170
  stop: function () {                                                                                  // 171
    var self = this;                                                                                   // 172
    self._stopped = true;                                                                              // 173
    _.each(self._stopCallbacks, function (c) { c(); });                                                // 174
    Package.facts && Package.facts.Facts.incrementServerFact(                                          // 175
      "mongo-livedata", "observe-drivers-polling", -1);                                                // 176
  }                                                                                                    // 177
});                                                                                                    // 178
                                                                                                       // 179
/////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

/////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                     //
// packages/mongo-livedata/oplog_observe_driver.js                                                     //
//                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                       //
var Fiber = Npm.require('fibers');                                                                     // 1
var Future = Npm.require('fibers/future');                                                             // 2
                                                                                                       // 3
var PHASE = {                                                                                          // 4
  QUERYING: "QUERYING",                                                                                // 5
  FETCHING: "FETCHING",                                                                                // 6
  STEADY: "STEADY"                                                                                     // 7
};                                                                                                     // 8
                                                                                                       // 9
// OplogObserveDriver is an alternative to PollingObserveDriver which follows                          // 10
// the Mongo operation log instead of just re-polling the query. It obeys the                          // 11
// same simple interface: constructing it starts sending observeChanges                                // 12
// callbacks (and a ready() invocation) to the ObserveMultiplexer, and you stop                        // 13
// it by calling the stop() method.                                                                    // 14
OplogObserveDriver = function (options) {                                                              // 15
  var self = this;                                                                                     // 16
  self._usesOplog = true;  // tests look at this                                                       // 17
                                                                                                       // 18
  self._cursorDescription = options.cursorDescription;                                                 // 19
  self._mongoHandle = options.mongoHandle;                                                             // 20
  self._multiplexer = options.multiplexer;                                                             // 21
  if (options.ordered)                                                                                 // 22
    throw Error("OplogObserveDriver only supports unordered observeChanges");                          // 23
                                                                                                       // 24
  self._stopped = false;                                                                               // 25
  self._stopHandles = [];                                                                              // 26
                                                                                                       // 27
  Package.facts && Package.facts.Facts.incrementServerFact(                                            // 28
    "mongo-livedata", "observe-drivers-oplog", 1);                                                     // 29
                                                                                                       // 30
  self._registerPhaseChange(PHASE.QUERYING);                                                           // 31
                                                                                                       // 32
  self._published = new LocalCollection._IdMap;                                                        // 33
  var selector = self._cursorDescription.selector;                                                     // 34
  self._matcher = options.matcher;                                                                     // 35
  var projection = self._cursorDescription.options.fields || {};                                       // 36
  self._projectionFn = LocalCollection._compileProjection(projection);                                 // 37
  // Projection function, result of combining important fields for selector and                        // 38
  // existing fields projection                                                                        // 39
  self._sharedProjection = self._matcher.combineIntoProjection(projection);                            // 40
  self._sharedProjectionFn = LocalCollection._compileProjection(                                       // 41
    self._sharedProjection);                                                                           // 42
                                                                                                       // 43
  self._needToFetch = new LocalCollection._IdMap;                                                      // 44
  self._currentlyFetching = null;                                                                      // 45
  self._fetchGeneration = 0;                                                                           // 46
                                                                                                       // 47
  self._requeryWhenDoneThisQuery = false;                                                              // 48
  self._writesToCommitWhenWeReachSteady = [];                                                          // 49
                                                                                                       // 50
  forEachTrigger(self._cursorDescription, function (trigger) {                                         // 51
    self._stopHandles.push(self._mongoHandle._oplogHandle.onOplogEntry(                                // 52
      trigger, function (notification) {                                                               // 53
        Meteor._noYieldsAllowed(function () {                                                          // 54
          var op = notification.op;                                                                    // 55
          if (notification.dropCollection) {                                                           // 56
            // Note: this call is not allowed to block on anything (especially                         // 57
            // on waiting for oplog entries to catch up) because that will block                       // 58
            // onOplogEntry!                                                                           // 59
            self._needToPollQuery();                                                                   // 60
          } else {                                                                                     // 61
            // All other operators should be handled depending on phase                                // 62
            if (self._phase === PHASE.QUERYING)                                                        // 63
              self._handleOplogEntryQuerying(op);                                                      // 64
            else                                                                                       // 65
              self._handleOplogEntrySteadyOrFetching(op);                                              // 66
          }                                                                                            // 67
        });                                                                                            // 68
      }                                                                                                // 69
    ));                                                                                                // 70
  });                                                                                                  // 71
                                                                                                       // 72
  // XXX ordering w.r.t. everything else?                                                              // 73
  self._stopHandles.push(listenAll(                                                                    // 74
    self._cursorDescription, function (notification) {                                                 // 75
      // If we're not in a write fence, we don't have to do anything.                                  // 76
      var fence = DDPServer._CurrentWriteFence.get();                                                  // 77
      if (!fence)                                                                                      // 78
        return;                                                                                        // 79
      var write = fence.beginWrite();                                                                  // 80
      // This write cannot complete until we've caught up to "this point" in the                       // 81
      // oplog, and then made it back to the steady state.                                             // 82
      Meteor.defer(function () {                                                                       // 83
        self._mongoHandle._oplogHandle.waitUntilCaughtUp();                                            // 84
        if (self._stopped) {                                                                           // 85
          // We're stopped, so just immediately commit.                                                // 86
          write.committed();                                                                           // 87
        } else if (self._phase === PHASE.STEADY) {                                                     // 88
          // Make sure that all of the callbacks have made it through the                              // 89
          // multiplexer and been delivered to ObserveHandles before committing                        // 90
          // writes.                                                                                   // 91
          self._multiplexer.onFlush(function () {                                                      // 92
            write.committed();                                                                         // 93
          });                                                                                          // 94
        } else {                                                                                       // 95
          self._writesToCommitWhenWeReachSteady.push(write);                                           // 96
        }                                                                                              // 97
      });                                                                                              // 98
    }                                                                                                  // 99
  ));                                                                                                  // 100
                                                                                                       // 101
  // Give _observeChanges a chance to add the new ObserveHandle to our                                 // 102
  // multiplexer, so that the added calls get streamed.                                                // 103
  Meteor.defer(function () {                                                                           // 104
    self._runInitialQuery();                                                                           // 105
  });                                                                                                  // 106
};                                                                                                     // 107
                                                                                                       // 108
_.extend(OplogObserveDriver.prototype, {                                                               // 109
  _add: function (doc) {                                                                               // 110
    var self = this;                                                                                   // 111
    var id = doc._id;                                                                                  // 112
    var fields = _.clone(doc);                                                                         // 113
    delete fields._id;                                                                                 // 114
    if (self._published.has(id))                                                                       // 115
      throw Error("tried to add something already published " + id);                                   // 116
    self._published.set(id, self._sharedProjectionFn(fields));                                         // 117
    self._multiplexer.added(id, self._projectionFn(fields));                                           // 118
  },                                                                                                   // 119
  _remove: function (id) {                                                                             // 120
    var self = this;                                                                                   // 121
    if (!self._published.has(id))                                                                      // 122
      throw Error("tried to remove something unpublished " + id);                                      // 123
    self._published.remove(id);                                                                        // 124
    self._multiplexer.removed(id);                                                                     // 125
  },                                                                                                   // 126
  _handleDoc: function (id, newDoc, mustMatchNow) {                                                    // 127
    var self = this;                                                                                   // 128
    newDoc = _.clone(newDoc);                                                                          // 129
                                                                                                       // 130
    var matchesNow = newDoc && self._matcher.documentMatches(newDoc).result;                           // 131
    if (mustMatchNow && !matchesNow) {                                                                 // 132
      throw Error("expected " + EJSON.stringify(newDoc) + " to match "                                 // 133
                  + EJSON.stringify(self._cursorDescription));                                         // 134
    }                                                                                                  // 135
                                                                                                       // 136
    var matchedBefore = self._published.has(id);                                                       // 137
                                                                                                       // 138
    if (matchesNow && !matchedBefore) {                                                                // 139
      self._add(newDoc);                                                                               // 140
    } else if (matchedBefore && !matchesNow) {                                                         // 141
      self._remove(id);                                                                                // 142
    } else if (matchesNow) {                                                                           // 143
      var oldDoc = self._published.get(id);                                                            // 144
      if (!oldDoc)                                                                                     // 145
        throw Error("thought that " + id + " was there!");                                             // 146
      delete newDoc._id;                                                                               // 147
      self._published.set(id, self._sharedProjectionFn(newDoc));                                       // 148
      var changed = LocalCollection._makeChangedFields(_.clone(newDoc), oldDoc);                       // 149
      changed = self._projectionFn(changed);                                                           // 150
      if (!_.isEmpty(changed))                                                                         // 151
        self._multiplexer.changed(id, changed);                                                        // 152
    }                                                                                                  // 153
  },                                                                                                   // 154
  _fetchModifiedDocuments: function () {                                                               // 155
    var self = this;                                                                                   // 156
    self._registerPhaseChange(PHASE.FETCHING);                                                         // 157
    // Defer, because nothing called from the oplog entry handler may yield, but                       // 158
    // fetch() yields.                                                                                 // 159
    Meteor.defer(function () {                                                                         // 160
      while (!self._stopped && !self._needToFetch.empty()) {                                           // 161
        if (self._phase !== PHASE.FETCHING)                                                            // 162
          throw new Error("phase in fetchModifiedDocuments: " + self._phase);                          // 163
                                                                                                       // 164
        self._currentlyFetching = self._needToFetch;                                                   // 165
        var thisGeneration = ++self._fetchGeneration;                                                  // 166
        self._needToFetch = new LocalCollection._IdMap;                                                // 167
        var waiting = 0;                                                                               // 168
        var anyError = null;                                                                           // 169
        var fut = new Future;                                                                          // 170
        // This loop is safe, because _currentlyFetching will not be updated                           // 171
        // during this loop (in fact, it is never mutated).                                            // 172
        self._currentlyFetching.forEach(function (cacheKey, id) {                                      // 173
          waiting++;                                                                                   // 174
          self._mongoHandle._docFetcher.fetch(                                                         // 175
            self._cursorDescription.collectionName, id, cacheKey,                                      // 176
            function (err, doc) {                                                                      // 177
              if (err) {                                                                               // 178
                if (!anyError)                                                                         // 179
                  anyError = err;                                                                      // 180
              } else if (!self._stopped && self._phase === PHASE.FETCHING                              // 181
                         && self._fetchGeneration === thisGeneration) {                                // 182
                // We re-check the generation in case we've had an explicit                            // 183
                // _pollQuery call which should effectively cancel this round of                       // 184
                // fetches.  (_pollQuery increments the generation.)                                   // 185
                self._handleDoc(id, doc);                                                              // 186
              }                                                                                        // 187
              waiting--;                                                                               // 188
              // Because fetch() never calls its callback synchronously, this is                       // 189
              // safe (ie, we won't call fut.return() before the forEach is                            // 190
              // done).                                                                                // 191
              if (waiting === 0)                                                                       // 192
                fut.return();                                                                          // 193
            });                                                                                        // 194
        });                                                                                            // 195
        fut.wait();                                                                                    // 196
        // XXX do this even if we've switched to PHASE.QUERYING?                                       // 197
        if (anyError)                                                                                  // 198
          throw anyError;                                                                              // 199
        // Exit now if we've had a _pollQuery call.                                                    // 200
        if (self._phase === PHASE.QUERYING)                                                            // 201
          return;                                                                                      // 202
        self._currentlyFetching = null;                                                                // 203
      }                                                                                                // 204
      self._beSteady();                                                                                // 205
    });                                                                                                // 206
  },                                                                                                   // 207
  _beSteady: function () {                                                                             // 208
    var self = this;                                                                                   // 209
    self._registerPhaseChange(PHASE.STEADY);                                                           // 210
    var writes = self._writesToCommitWhenWeReachSteady;                                                // 211
    self._writesToCommitWhenWeReachSteady = [];                                                        // 212
    self._multiplexer.onFlush(function () {                                                            // 213
      _.each(writes, function (w) {                                                                    // 214
        w.committed();                                                                                 // 215
      });                                                                                              // 216
    });                                                                                                // 217
  },                                                                                                   // 218
  _handleOplogEntryQuerying: function (op) {                                                           // 219
    var self = this;                                                                                   // 220
    self._needToFetch.set(idForOp(op), op.ts.toString());                                              // 221
  },                                                                                                   // 222
  _handleOplogEntrySteadyOrFetching: function (op) {                                                   // 223
    var self = this;                                                                                   // 224
    var id = idForOp(op);                                                                              // 225
    // If we're already fetching this one, or about to, we can't optimize; make                        // 226
    // sure that we fetch it again if necessary.                                                       // 227
    if (self._phase === PHASE.FETCHING &&                                                              // 228
        ((self._currentlyFetching && self._currentlyFetching.has(id)) ||                               // 229
         self._needToFetch.has(id))) {                                                                 // 230
      self._needToFetch.set(id, op.ts.toString());                                                     // 231
      return;                                                                                          // 232
    }                                                                                                  // 233
                                                                                                       // 234
    if (op.op === 'd') {                                                                               // 235
      if (self._published.has(id))                                                                     // 236
        self._remove(id);                                                                              // 237
    } else if (op.op === 'i') {                                                                        // 238
      if (self._published.has(id))                                                                     // 239
        throw new Error("insert found for already-existing ID");                                       // 240
                                                                                                       // 241
      // XXX what if selector yields?  for now it can't but later it could have                        // 242
      // $where                                                                                        // 243
      if (self._matcher.documentMatches(op.o).result)                                                  // 244
        self._add(op.o);                                                                               // 245
    } else if (op.op === 'u') {                                                                        // 246
      // Is this a modifier ($set/$unset, which may require us to poll the                             // 247
      // database to figure out if the whole document matches the selector) or a                       // 248
      // replacement (in which case we can just directly re-evaluate the                               // 249
      // selector)?                                                                                    // 250
      var isReplace = !_.has(op.o, '$set') && !_.has(op.o, '$unset');                                  // 251
      // If this modifier modifies something inside an EJSON custom type (ie,                          // 252
      // anything with EJSON$), then we can't try to use                                               // 253
      // LocalCollection._modify, since that just mutates the EJSON encoding,                          // 254
      // not the actual object.                                                                        // 255
      var canDirectlyModifyDoc =                                                                       // 256
            !isReplace && modifierCanBeDirectlyApplied(op.o);                                          // 257
                                                                                                       // 258
      if (isReplace) {                                                                                 // 259
        self._handleDoc(id, _.extend({_id: id}, op.o));                                                // 260
      } else if (self._published.has(id) && canDirectlyModifyDoc) {                                    // 261
        // Oh great, we actually know what the document is, so we can apply                            // 262
        // this directly.                                                                              // 263
        var newDoc = EJSON.clone(self._published.get(id));                                             // 264
        newDoc._id = id;                                                                               // 265
        LocalCollection._modify(newDoc, op.o);                                                         // 266
        self._handleDoc(id, self._sharedProjectionFn(newDoc));                                         // 267
      } else if (!canDirectlyModifyDoc ||                                                              // 268
                 self._matcher.canBecomeTrueByModifier(op.o)) {                                        // 269
        self._needToFetch.set(id, op.ts.toString());                                                   // 270
        if (self._phase === PHASE.STEADY)                                                              // 271
          self._fetchModifiedDocuments();                                                              // 272
      }                                                                                                // 273
    } else {                                                                                           // 274
      throw Error("XXX SURPRISING OPERATION: " + op);                                                  // 275
    }                                                                                                  // 276
  },                                                                                                   // 277
  _runInitialQuery: function () {                                                                      // 278
    var self = this;                                                                                   // 279
    if (self._stopped)                                                                                 // 280
      throw new Error("oplog stopped surprisingly early");                                             // 281
                                                                                                       // 282
    var initialCursor = self._cursorForQuery();                                                        // 283
    initialCursor.forEach(function (initialDoc) {                                                      // 284
      self._add(initialDoc);                                                                           // 285
    });                                                                                                // 286
    if (self._stopped)                                                                                 // 287
      throw new Error("oplog stopped quite early");                                                    // 288
    // Allow observeChanges calls to return. (After this, it's possible for                            // 289
    // stop() to be called.)                                                                           // 290
    self._multiplexer.ready();                                                                         // 291
                                                                                                       // 292
    self._doneQuerying();                                                                              // 293
  },                                                                                                   // 294
                                                                                                       // 295
  // In various circumstances, we may just want to stop processing the oplog and                       // 296
  // re-run the initial query, just as if we were a PollingObserveDriver.                              // 297
  //                                                                                                   // 298
  // This function may not block, because it is called from an oplog entry                             // 299
  // handler.                                                                                          // 300
  //                                                                                                   // 301
  // XXX We should call this when we detect that we've been in FETCHING for "too                       // 302
  // long".                                                                                            // 303
  //                                                                                                   // 304
  // XXX We should call this when we detect Mongo failover (since that might                           // 305
  // mean that some of the oplog entries we have processed have been rolled                            // 306
  // back). The Node Mongo driver is in the middle of a bunch of huge                                  // 307
  // refactorings, including the way that it notifies you when primary                                 // 308
  // changes. Will put off implementing this until driver 1.4 is out.                                  // 309
  _pollQuery: function () {                                                                            // 310
    var self = this;                                                                                   // 311
                                                                                                       // 312
    if (self._stopped)                                                                                 // 313
      return;                                                                                          // 314
                                                                                                       // 315
    // Yay, we get to forget about all the things we thought we had to fetch.                          // 316
    self._needToFetch = new LocalCollection._IdMap;                                                    // 317
    self._currentlyFetching = null;                                                                    // 318
    ++self._fetchGeneration;  // ignore any in-flight fetches                                          // 319
    self._registerPhaseChange(PHASE.QUERYING);                                                         // 320
                                                                                                       // 321
    // Defer so that we don't block.                                                                   // 322
    Meteor.defer(function () {                                                                         // 323
      // subtle note: _published does not contain _id fields, but newResults                           // 324
      // does                                                                                          // 325
      var newResults = new LocalCollection._IdMap;                                                     // 326
      var cursor = self._cursorForQuery();                                                             // 327
      cursor.forEach(function (doc) {                                                                  // 328
        newResults.set(doc._id, doc);                                                                  // 329
      });                                                                                              // 330
                                                                                                       // 331
      self._publishNewResults(newResults);                                                             // 332
                                                                                                       // 333
      self._doneQuerying();                                                                            // 334
    });                                                                                                // 335
  },                                                                                                   // 336
                                                                                                       // 337
  // Transitions to QUERYING and runs another query, or (if already in QUERYING)                       // 338
  // ensures that we will query again later.                                                           // 339
  //                                                                                                   // 340
  // This function may not block, because it is called from an oplog entry                             // 341
  // handler.                                                                                          // 342
  _needToPollQuery: function () {                                                                      // 343
    var self = this;                                                                                   // 344
    if (self._stopped)                                                                                 // 345
      return;                                                                                          // 346
                                                                                                       // 347
    // If we're not already in the middle of a query, we can query now (possibly                       // 348
    // pausing FETCHING).                                                                              // 349
    if (self._phase !== PHASE.QUERYING) {                                                              // 350
      self._pollQuery();                                                                               // 351
      return;                                                                                          // 352
    }                                                                                                  // 353
                                                                                                       // 354
    // We're currently in QUERYING. Set a flag to ensure that we run another                           // 355
    // query when we're done.                                                                          // 356
    self._requeryWhenDoneThisQuery = true;                                                             // 357
  },                                                                                                   // 358
                                                                                                       // 359
  _doneQuerying: function () {                                                                         // 360
    var self = this;                                                                                   // 361
                                                                                                       // 362
    if (self._stopped)                                                                                 // 363
      return;                                                                                          // 364
    self._mongoHandle._oplogHandle.waitUntilCaughtUp();                                                // 365
                                                                                                       // 366
    if (self._stopped)                                                                                 // 367
      return;                                                                                          // 368
    if (self._phase !== PHASE.QUERYING)                                                                // 369
      throw Error("Phase unexpectedly " + self._phase);                                                // 370
                                                                                                       // 371
    if (self._requeryWhenDoneThisQuery) {                                                              // 372
      self._requeryWhenDoneThisQuery = false;                                                          // 373
      self._pollQuery();                                                                               // 374
    } else if (self._needToFetch.empty()) {                                                            // 375
      self._beSteady();                                                                                // 376
    } else {                                                                                           // 377
      self._fetchModifiedDocuments();                                                                  // 378
    }                                                                                                  // 379
  },                                                                                                   // 380
                                                                                                       // 381
  _cursorForQuery: function () {                                                                       // 382
    var self = this;                                                                                   // 383
                                                                                                       // 384
    // The query we run is almost the same as the cursor we are observing, with                        // 385
    // a few changes. We need to read all the fields that are relevant to the                          // 386
    // selector, not just the fields we are going to publish (that's the                               // 387
    // "shared" projection). And we don't want to apply any transform in the                           // 388
    // cursor, because observeChanges shouldn't use the transform.                                     // 389
    var options = _.clone(self._cursorDescription.options);                                            // 390
    options.fields = self._sharedProjection;                                                           // 391
    delete options.transform;                                                                          // 392
    // We are NOT deep cloning fields or selector here, which should be OK.                            // 393
    var description = new CursorDescription(                                                           // 394
      self._cursorDescription.collectionName,                                                          // 395
      self._cursorDescription.selector,                                                                // 396
      options);                                                                                        // 397
    return new Cursor(self._mongoHandle, description);                                                 // 398
  },                                                                                                   // 399
                                                                                                       // 400
                                                                                                       // 401
  // Replace self._published with newResults (both are IdMaps), invoking observe                       // 402
  // callbacks on the multiplexer.                                                                     // 403
  //                                                                                                   // 404
  // XXX This is very similar to LocalCollection._diffQueryUnorderedChanges. We                        // 405
  // should really: (a) Unify IdMap and OrderedDict into Unordered/OrderedDict (b)                     // 406
  // Rewrite diff.js to use these classes instead of arrays and objects.                               // 407
  _publishNewResults: function (newResults) {                                                          // 408
    var self = this;                                                                                   // 409
                                                                                                       // 410
    // First remove anything that's gone. Be careful not to modify                                     // 411
    // self._published while iterating over it.                                                        // 412
    var idsToRemove = [];                                                                              // 413
    self._published.forEach(function (doc, id) {                                                       // 414
      if (!newResults.has(id))                                                                         // 415
        idsToRemove.push(id);                                                                          // 416
    });                                                                                                // 417
    _.each(idsToRemove, function (id) {                                                                // 418
      self._remove(id);                                                                                // 419
    });                                                                                                // 420
                                                                                                       // 421
    // Now do adds and changes.                                                                        // 422
    newResults.forEach(function (doc, id) {                                                            // 423
      // "true" here means to throw if we think this doc doesn't match the                             // 424
      // selector.                                                                                     // 425
      self._handleDoc(id, doc, true);                                                                  // 426
    });                                                                                                // 427
  },                                                                                                   // 428
                                                                                                       // 429
  // This stop function is invoked from the onStop of the ObserveMultiplexer, so                       // 430
  // it shouldn't actually be possible to call it until the multiplexer is                             // 431
  // ready.                                                                                            // 432
  stop: function () {                                                                                  // 433
    var self = this;                                                                                   // 434
    if (self._stopped)                                                                                 // 435
      return;                                                                                          // 436
    self._stopped = true;                                                                              // 437
    _.each(self._stopHandles, function (handle) {                                                      // 438
      handle.stop();                                                                                   // 439
    });                                                                                                // 440
                                                                                                       // 441
    // Note: we *don't* use multiplexer.onFlush here because this stop                                 // 442
    // callback is actually invoked by the multiplexer itself when it has                              // 443
    // determined that there are no handles left. So nothing is actually going                         // 444
    // to get flushed (and it's probably not valid to call methods on the                              // 445
    // dying multiplexer).                                                                             // 446
    _.each(self._writesToCommitWhenWeReachSteady, function (w) {                                       // 447
      w.committed();                                                                                   // 448
    });                                                                                                // 449
    self._writesToCommitWhenWeReachSteady = null;                                                      // 450
                                                                                                       // 451
    // Proactively drop references to potentially big things.                                          // 452
    self._published = null;                                                                            // 453
    self._needToFetch = null;                                                                          // 454
    self._currentlyFetching = null;                                                                    // 455
    self._oplogEntryHandle = null;                                                                     // 456
    self._listenersHandle = null;                                                                      // 457
                                                                                                       // 458
    Package.facts && Package.facts.Facts.incrementServerFact(                                          // 459
      "mongo-livedata", "observe-drivers-oplog", -1);                                                  // 460
  },                                                                                                   // 461
                                                                                                       // 462
  _registerPhaseChange: function (phase) {                                                             // 463
    var self = this;                                                                                   // 464
    var now = new Date;                                                                                // 465
                                                                                                       // 466
    if (self._phase) {                                                                                 // 467
      var timeDiff = now - self._phaseStartTime;                                                       // 468
      Package.facts && Package.facts.Facts.incrementServerFact(                                        // 469
        "mongo-livedata", "time-spent-in-" + self._phase + "-phase", timeDiff);                        // 470
    }                                                                                                  // 471
                                                                                                       // 472
    self._phase = phase;                                                                               // 473
    self._phaseStartTime = now;                                                                        // 474
  }                                                                                                    // 475
});                                                                                                    // 476
                                                                                                       // 477
// Does our oplog tailing code support this cursor? For now, we are being very                         // 478
// conservative and allowing only simple queries with simple options.                                  // 479
// (This is a "static method".)                                                                        // 480
OplogObserveDriver.cursorSupported = function (cursorDescription, matcher) {                           // 481
  // First, check the options.                                                                         // 482
  var options = cursorDescription.options;                                                             // 483
                                                                                                       // 484
  // Did the user say no explicitly?                                                                   // 485
  if (options._disableOplog)                                                                           // 486
    return false;                                                                                      // 487
                                                                                                       // 488
  // This option (which are mostly used for sorted cursors) require us to figure                       // 489
  // out where a given document fits in an order to know if it's included or                           // 490
  // not, and we don't track that information when doing oplog tailing.                                // 491
  if (options.limit || options.skip) return false;                                                     // 492
                                                                                                       // 493
  // If a fields projection option is given check if it is supported by                                // 494
  // minimongo (some operators are not supported).                                                     // 495
  if (options.fields) {                                                                                // 496
    try {                                                                                              // 497
      LocalCollection._checkSupportedProjection(options.fields);                                       // 498
    } catch (e) {                                                                                      // 499
      if (e.name === "MinimongoError")                                                                 // 500
        return false;                                                                                  // 501
      else                                                                                             // 502
        throw e;                                                                                       // 503
    }                                                                                                  // 504
  }                                                                                                    // 505
                                                                                                       // 506
  // We don't allow the following selectors:                                                           // 507
  //   - $where (not confident that we provide the same JS environment                                 // 508
  //             as Mongo, and can yield!)                                                             // 509
  //   - $near (has "interesting" properties in MongoDB, like the possibility                          // 510
  //            of returning an ID multiple times, though even polling maybe                           // 511
  //            have a bug there                                                                       // 512
  return !matcher.hasWhere() && !matcher.hasGeoQuery();                                                // 513
};                                                                                                     // 514
                                                                                                       // 515
var modifierCanBeDirectlyApplied = function (modifier) {                                               // 516
  return _.all(modifier, function (fields, operation) {                                                // 517
    return _.all(fields, function (value, field) {                                                     // 518
      return !/EJSON\$/.test(field);                                                                   // 519
    });                                                                                                // 520
  });                                                                                                  // 521
};                                                                                                     // 522
                                                                                                       // 523
MongoTest.OplogObserveDriver = OplogObserveDriver;                                                     // 524
                                                                                                       // 525
/////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

/////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                     //
// packages/mongo-livedata/local_collection_driver.js                                                  //
//                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                       //
LocalCollectionDriver = function () {                                                                  // 1
  var self = this;                                                                                     // 2
  self.noConnCollections = {};                                                                         // 3
};                                                                                                     // 4
                                                                                                       // 5
var ensureCollection = function (name, collections) {                                                  // 6
  if (!(name in collections))                                                                          // 7
    collections[name] = new LocalCollection(name);                                                     // 8
  return collections[name];                                                                            // 9
};                                                                                                     // 10
                                                                                                       // 11
_.extend(LocalCollectionDriver.prototype, {                                                            // 12
  open: function (name, conn) {                                                                        // 13
    var self = this;                                                                                   // 14
    if (!name)                                                                                         // 15
      return new LocalCollection;                                                                      // 16
    if (! conn) {                                                                                      // 17
      return ensureCollection(name, self.noConnCollections);                                           // 18
    }                                                                                                  // 19
    if (! conn._mongo_livedata_collections)                                                            // 20
      conn._mongo_livedata_collections = {};                                                           // 21
    // XXX is there a way to keep track of a connection's collections without                          // 22
    // dangling it off the connection object?                                                          // 23
    return ensureCollection(name, conn._mongo_livedata_collections);                                   // 24
  }                                                                                                    // 25
});                                                                                                    // 26
                                                                                                       // 27
// singleton                                                                                           // 28
LocalCollectionDriver = new LocalCollectionDriver;                                                     // 29
                                                                                                       // 30
/////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

/////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                     //
// packages/mongo-livedata/remote_collection_driver.js                                                 //
//                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                       //
MongoInternals.RemoteCollectionDriver = function (                                                     // 1
  mongo_url, options) {                                                                                // 2
  var self = this;                                                                                     // 3
  self.mongo = new MongoConnection(mongo_url, options);                                                // 4
};                                                                                                     // 5
                                                                                                       // 6
_.extend(MongoInternals.RemoteCollectionDriver.prototype, {                                            // 7
  open: function (name) {                                                                              // 8
    var self = this;                                                                                   // 9
    var ret = {};                                                                                      // 10
    _.each(                                                                                            // 11
      ['find', 'findOne', 'insert', 'update', , 'upsert',                                              // 12
       'remove', '_ensureIndex', '_dropIndex', '_createCappedCollection',                              // 13
       'dropCollection'],                                                                              // 14
      function (m) {                                                                                   // 15
        ret[m] = _.bind(self.mongo[m], self.mongo, name);                                              // 16
      });                                                                                              // 17
    return ret;                                                                                        // 18
  }                                                                                                    // 19
});                                                                                                    // 20
                                                                                                       // 21
                                                                                                       // 22
// Create the singleton RemoteCollectionDriver only on demand, so we                                   // 23
// only require Mongo configuration if it's actually used (eg, not if                                  // 24
// you're only trying to receive data from a remote DDP server.)                                       // 25
MongoInternals.defaultRemoteCollectionDriver = _.once(function () {                                    // 26
  var mongoUrl;                                                                                        // 27
  var connectionOptions = {};                                                                          // 28
                                                                                                       // 29
  AppConfig.configurePackage("mongo-livedata", function (config) {                                     // 30
    // This will keep running if mongo gets reconfigured.  That's not ideal, but                       // 31
    // should be ok for now.                                                                           // 32
    mongoUrl = config.url;                                                                             // 33
                                                                                                       // 34
    if (config.oplog)                                                                                  // 35
      connectionOptions.oplogUrl = config.oplog;                                                       // 36
  });                                                                                                  // 37
                                                                                                       // 38
  // XXX bad error since it could also be set directly in METEOR_DEPLOY_CONFIG                         // 39
  if (! mongoUrl)                                                                                      // 40
    throw new Error("MONGO_URL must be set in environment");                                           // 41
                                                                                                       // 42
                                                                                                       // 43
  return new MongoInternals.RemoteCollectionDriver(mongoUrl, connectionOptions);                       // 44
});                                                                                                    // 45
                                                                                                       // 46
/////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

/////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                     //
// packages/mongo-livedata/collection.js                                                               //
//                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                       //
// options.connection, if given, is a LivedataClient or LivedataServer                                 // 1
// XXX presently there is no way to destroy/clean up a Collection                                      // 2
                                                                                                       // 3
Meteor.Collection = function (name, options) {                                                         // 4
  var self = this;                                                                                     // 5
  if (! (self instanceof Meteor.Collection))                                                           // 6
    throw new Error('use "new" to construct a Meteor.Collection');                                     // 7
  if (options && options.methods) {                                                                    // 8
    // Backwards compatibility hack with original signature (which passed                              // 9
    // "connection" directly instead of in options. (Connections must have a "methods"                 // 10
    // method.)                                                                                        // 11
    // XXX remove before 1.0                                                                           // 12
    options = {connection: options};                                                                   // 13
  }                                                                                                    // 14
  // Backwards compatibility: "connection" used to be called "manager".                                // 15
  if (options && options.manager && !options.connection) {                                             // 16
    options.connection = options.manager;                                                              // 17
  }                                                                                                    // 18
  options = _.extend({                                                                                 // 19
    connection: undefined,                                                                             // 20
    idGeneration: 'STRING',                                                                            // 21
    transform: null,                                                                                   // 22
    _driver: undefined,                                                                                // 23
    _preventAutopublish: false                                                                         // 24
  }, options);                                                                                         // 25
                                                                                                       // 26
  switch (options.idGeneration) {                                                                      // 27
  case 'MONGO':                                                                                        // 28
    self._makeNewID = function () {                                                                    // 29
      return new Meteor.Collection.ObjectID();                                                         // 30
    };                                                                                                 // 31
    break;                                                                                             // 32
  case 'STRING':                                                                                       // 33
  default:                                                                                             // 34
    self._makeNewID = function () {                                                                    // 35
      return Random.id();                                                                              // 36
    };                                                                                                 // 37
    break;                                                                                             // 38
  }                                                                                                    // 39
                                                                                                       // 40
  self._transform = LocalCollection.wrapTransform(options.transform);                                  // 41
                                                                                                       // 42
  if (!name && (name !== null)) {                                                                      // 43
    Meteor._debug("Warning: creating anonymous collection. It will not be " +                          // 44
                  "saved or synchronized over the network. (Pass null for " +                          // 45
                  "the collection name to turn off this warning.)");                                   // 46
  }                                                                                                    // 47
                                                                                                       // 48
  if (! name || options.connection === null)                                                           // 49
    // note: nameless collections never have a connection                                              // 50
    self._connection = null;                                                                           // 51
  else if (options.connection)                                                                         // 52
    self._connection = options.connection;                                                             // 53
  else if (Meteor.isClient)                                                                            // 54
    self._connection = Meteor.connection;                                                              // 55
  else                                                                                                 // 56
    self._connection = Meteor.server;                                                                  // 57
                                                                                                       // 58
  if (!options._driver) {                                                                              // 59
    if (name && self._connection === Meteor.server &&                                                  // 60
        typeof MongoInternals !== "undefined" &&                                                       // 61
        MongoInternals.defaultRemoteCollectionDriver) {                                                // 62
      options._driver = MongoInternals.defaultRemoteCollectionDriver();                                // 63
    } else {                                                                                           // 64
      options._driver = LocalCollectionDriver;                                                         // 65
    }                                                                                                  // 66
  }                                                                                                    // 67
                                                                                                       // 68
  self._collection = options._driver.open(name, self._connection);                                     // 69
  self._name = name;                                                                                   // 70
                                                                                                       // 71
  if (self._connection && self._connection.registerStore) {                                            // 72
    // OK, we're going to be a slave, replicating some remote                                          // 73
    // database, except possibly with some temporary divergence while                                  // 74
    // we have unacknowledged RPC's.                                                                   // 75
    var ok = self._connection.registerStore(name, {                                                    // 76
      // Called at the beginning of a batch of updates. batchSize is the number                        // 77
      // of update calls to expect.                                                                    // 78
      //                                                                                               // 79
      // XXX This interface is pretty janky. reset probably ought to go back to                        // 80
      // being its own function, and callers shouldn't have to calculate                               // 81
      // batchSize. The optimization of not calling pause/remove should be                             // 82
      // delayed until later: the first call to update() should buffer its                             // 83
      // message, and then we can either directly apply it at endUpdate time if                        // 84
      // it was the only update, or do pauseObservers/apply/apply at the next                          // 85
      // update() if there's another one.                                                              // 86
      beginUpdate: function (batchSize, reset) {                                                       // 87
        // pause observers so users don't see flicker when updating several                            // 88
        // objects at once (including the post-reconnect reset-and-reapply                             // 89
        // stage), and so that a re-sorting of a query can take advantage of the                       // 90
        // full _diffQuery moved calculation instead of applying change one at a                       // 91
        // time.                                                                                       // 92
        if (batchSize > 1 || reset)                                                                    // 93
          self._collection.pauseObservers();                                                           // 94
                                                                                                       // 95
        if (reset)                                                                                     // 96
          self._collection.remove({});                                                                 // 97
      },                                                                                               // 98
                                                                                                       // 99
      // Apply an update.                                                                              // 100
      // XXX better specify this interface (not in terms of a wire message)?                           // 101
      update: function (msg) {                                                                         // 102
        var mongoId = LocalCollection._idParse(msg.id);                                                // 103
        var doc = self._collection.findOne(mongoId);                                                   // 104
                                                                                                       // 105
        // Is this a "replace the whole doc" message coming from the quiescence                        // 106
        // of method writes to an object? (Note that 'undefined' is a valid                            // 107
        // value meaning "remove it".)                                                                 // 108
        if (msg.msg === 'replace') {                                                                   // 109
          var replace = msg.replace;                                                                   // 110
          if (!replace) {                                                                              // 111
            if (doc)                                                                                   // 112
              self._collection.remove(mongoId);                                                        // 113
          } else if (!doc) {                                                                           // 114
            self._collection.insert(replace);                                                          // 115
          } else {                                                                                     // 116
            // XXX check that replace has no $ ops                                                     // 117
            self._collection.update(mongoId, replace);                                                 // 118
          }                                                                                            // 119
          return;                                                                                      // 120
        } else if (msg.msg === 'added') {                                                              // 121
          if (doc) {                                                                                   // 122
            throw new Error("Expected not to find a document already present for an add");             // 123
          }                                                                                            // 124
          self._collection.insert(_.extend({_id: mongoId}, msg.fields));                               // 125
        } else if (msg.msg === 'removed') {                                                            // 126
          if (!doc)                                                                                    // 127
            throw new Error("Expected to find a document already present for removed");                // 128
          self._collection.remove(mongoId);                                                            // 129
        } else if (msg.msg === 'changed') {                                                            // 130
          if (!doc)                                                                                    // 131
            throw new Error("Expected to find a document to change");                                  // 132
          if (!_.isEmpty(msg.fields)) {                                                                // 133
            var modifier = {};                                                                         // 134
            _.each(msg.fields, function (value, key) {                                                 // 135
              if (value === undefined) {                                                               // 136
                if (!modifier.$unset)                                                                  // 137
                  modifier.$unset = {};                                                                // 138
                modifier.$unset[key] = 1;                                                              // 139
              } else {                                                                                 // 140
                if (!modifier.$set)                                                                    // 141
                  modifier.$set = {};                                                                  // 142
                modifier.$set[key] = value;                                                            // 143
              }                                                                                        // 144
            });                                                                                        // 145
            self._collection.update(mongoId, modifier);                                                // 146
          }                                                                                            // 147
        } else {                                                                                       // 148
          throw new Error("I don't know how to deal with this message");                               // 149
        }                                                                                              // 150
                                                                                                       // 151
      },                                                                                               // 152
                                                                                                       // 153
      // Called at the end of a batch of updates.                                                      // 154
      endUpdate: function () {                                                                         // 155
        self._collection.resumeObservers();                                                            // 156
      },                                                                                               // 157
                                                                                                       // 158
      // Called around method stub invocations to capture the original versions                        // 159
      // of modified documents.                                                                        // 160
      saveOriginals: function () {                                                                     // 161
        self._collection.saveOriginals();                                                              // 162
      },                                                                                               // 163
      retrieveOriginals: function () {                                                                 // 164
        return self._collection.retrieveOriginals();                                                   // 165
      }                                                                                                // 166
    });                                                                                                // 167
                                                                                                       // 168
    if (!ok)                                                                                           // 169
      throw new Error("There is already a collection named '" + name + "'");                           // 170
  }                                                                                                    // 171
                                                                                                       // 172
  self._defineMutationMethods();                                                                       // 173
                                                                                                       // 174
  // autopublish                                                                                       // 175
  if (Package.autopublish && !options._preventAutopublish && self._connection                          // 176
      && self._connection.publish) {                                                                   // 177
    self._connection.publish(null, function () {                                                       // 178
      return self.find();                                                                              // 179
    }, {is_auto: true});                                                                               // 180
  }                                                                                                    // 181
};                                                                                                     // 182
                                                                                                       // 183
///                                                                                                    // 184
/// Main collection API                                                                                // 185
///                                                                                                    // 186
                                                                                                       // 187
                                                                                                       // 188
_.extend(Meteor.Collection.prototype, {                                                                // 189
                                                                                                       // 190
  _getFindSelector: function (args) {                                                                  // 191
    if (args.length == 0)                                                                              // 192
      return {};                                                                                       // 193
    else                                                                                               // 194
      return args[0];                                                                                  // 195
  },                                                                                                   // 196
                                                                                                       // 197
  _getFindOptions: function (args) {                                                                   // 198
    var self = this;                                                                                   // 199
    if (args.length < 2) {                                                                             // 200
      return { transform: self._transform };                                                           // 201
    } else {                                                                                           // 202
      return _.extend({                                                                                // 203
        transform: self._transform                                                                     // 204
      }, args[1]);                                                                                     // 205
    }                                                                                                  // 206
  },                                                                                                   // 207
                                                                                                       // 208
  find: function (/* selector, options */) {                                                           // 209
    // Collection.find() (return all docs) behaves differently                                         // 210
    // from Collection.find(undefined) (return 0 docs).  so be                                         // 211
    // careful about the length of arguments.                                                          // 212
    var self = this;                                                                                   // 213
    var argArray = _.toArray(arguments);                                                               // 214
    return self._collection.find(self._getFindSelector(argArray),                                      // 215
                                 self._getFindOptions(argArray));                                      // 216
  },                                                                                                   // 217
                                                                                                       // 218
  findOne: function (/* selector, options */) {                                                        // 219
    var self = this;                                                                                   // 220
    var argArray = _.toArray(arguments);                                                               // 221
    return self._collection.findOne(self._getFindSelector(argArray),                                   // 222
                                    self._getFindOptions(argArray));                                   // 223
  }                                                                                                    // 224
                                                                                                       // 225
});                                                                                                    // 226
                                                                                                       // 227
Meteor.Collection._publishCursor = function (cursor, sub, collection) {                                // 228
  var observeHandle = cursor.observeChanges({                                                          // 229
    added: function (id, fields) {                                                                     // 230
      sub.added(collection, id, fields);                                                               // 231
    },                                                                                                 // 232
    changed: function (id, fields) {                                                                   // 233
      sub.changed(collection, id, fields);                                                             // 234
    },                                                                                                 // 235
    removed: function (id) {                                                                           // 236
      sub.removed(collection, id);                                                                     // 237
    }                                                                                                  // 238
  });                                                                                                  // 239
                                                                                                       // 240
  // We don't call sub.ready() here: it gets called in livedata_server, after                          // 241
  // possibly calling _publishCursor on multiple returned cursors.                                     // 242
                                                                                                       // 243
  // register stop callback (expects lambda w/ no args).                                               // 244
  sub.onStop(function () {observeHandle.stop();});                                                     // 245
};                                                                                                     // 246
                                                                                                       // 247
// protect against dangerous selectors.  falsey and {_id: falsey} are both                             // 248
// likely programmer error, and not what you want, particularly for destructive                        // 249
// operations.  JS regexps don't serialize over DDP but can be trivially                               // 250
// replaced by $regex.                                                                                 // 251
Meteor.Collection._rewriteSelector = function (selector) {                                             // 252
  // shorthand -- scalars match _id                                                                    // 253
  if (LocalCollection._selectorIsId(selector))                                                         // 254
    selector = {_id: selector};                                                                        // 255
                                                                                                       // 256
  if (!selector || (('_id' in selector) && !selector._id))                                             // 257
    // can't match anything                                                                            // 258
    return {_id: Random.id()};                                                                         // 259
                                                                                                       // 260
  var ret = {};                                                                                        // 261
  _.each(selector, function (value, key) {                                                             // 262
    // Mongo supports both {field: /foo/} and {field: {$regex: /foo/}}                                 // 263
    if (value instanceof RegExp) {                                                                     // 264
      ret[key] = convertRegexpToMongoSelector(value);                                                  // 265
    } else if (value && value.$regex instanceof RegExp) {                                              // 266
      ret[key] = convertRegexpToMongoSelector(value.$regex);                                           // 267
      // if value is {$regex: /foo/, $options: ...} then $options                                      // 268
      // override the ones set on $regex.                                                              // 269
      if (value.$options !== undefined)                                                                // 270
        ret[key].$options = value.$options;                                                            // 271
    }                                                                                                  // 272
    else if (_.contains(['$or','$and','$nor'], key)) {                                                 // 273
      // Translate lower levels of $and/$or/$nor                                                       // 274
      ret[key] = _.map(value, function (v) {                                                           // 275
        return Meteor.Collection._rewriteSelector(v);                                                  // 276
      });                                                                                              // 277
    } else {                                                                                           // 278
      ret[key] = value;                                                                                // 279
    }                                                                                                  // 280
  });                                                                                                  // 281
  return ret;                                                                                          // 282
};                                                                                                     // 283
                                                                                                       // 284
// convert a JS RegExp object to a Mongo {$regex: ..., $options: ...}                                  // 285
// selector                                                                                            // 286
var convertRegexpToMongoSelector = function (regexp) {                                                 // 287
  check(regexp, RegExp); // safety belt                                                                // 288
                                                                                                       // 289
  var selector = {$regex: regexp.source};                                                              // 290
  var regexOptions = '';                                                                               // 291
  // JS RegExp objects support 'i', 'm', and 'g'. Mongo regex $options                                 // 292
  // support 'i', 'm', 'x', and 's'. So we support 'i' and 'm' here.                                   // 293
  if (regexp.ignoreCase)                                                                               // 294
    regexOptions += 'i';                                                                               // 295
  if (regexp.multiline)                                                                                // 296
    regexOptions += 'm';                                                                               // 297
  if (regexOptions)                                                                                    // 298
    selector.$options = regexOptions;                                                                  // 299
                                                                                                       // 300
  return selector;                                                                                     // 301
};                                                                                                     // 302
                                                                                                       // 303
var throwIfSelectorIsNotId = function (selector, methodName) {                                         // 304
  if (!LocalCollection._selectorIsIdPerhapsAsObject(selector)) {                                       // 305
    throw new Meteor.Error(                                                                            // 306
      403, "Not permitted. Untrusted code may only " + methodName +                                    // 307
        " documents by ID.");                                                                          // 308
  }                                                                                                    // 309
};                                                                                                     // 310
                                                                                                       // 311
// 'insert' immediately returns the inserted document's new _id.                                       // 312
// The others return values immediately if you are in a stub, an in-memory                             // 313
// unmanaged collection, or a mongo-backed collection and you don't pass a                             // 314
// callback. 'update' and 'remove' return the number of affected                                       // 315
// documents. 'upsert' returns an object with keys 'numberAffected' and, if an                         // 316
// insert happened, 'insertedId'.                                                                      // 317
//                                                                                                     // 318
// Otherwise, the semantics are exactly like other methods: they take                                  // 319
// a callback as an optional last argument; if no callback is                                          // 320
// provided, they block until the operation is complete, and throw an                                  // 321
// exception if it fails; if a callback is provided, then they don't                                   // 322
// necessarily block, and they call the callback when they finish with error and                       // 323
// result arguments.  (The insert method provides the document ID as its result;                       // 324
// update and remove provide the number of affected docs as the result; upsert                         // 325
// provides an object with numberAffected and maybe insertedId.)                                       // 326
//                                                                                                     // 327
// On the client, blocking is impossible, so if a callback                                             // 328
// isn't provided, they just return immediately and any error                                          // 329
// information is lost.                                                                                // 330
//                                                                                                     // 331
// There's one more tweak. On the client, if you don't provide a                                       // 332
// callback, then if there is an error, a message will be logged with                                  // 333
// Meteor._debug.                                                                                      // 334
//                                                                                                     // 335
// The intent (though this is actually determined by the underlying                                    // 336
// drivers) is that the operations should be done synchronously, not                                   // 337
// generating their result until the database has acknowledged                                         // 338
// them. In the future maybe we should provide a flag to turn this                                     // 339
// off.                                                                                                // 340
_.each(["insert", "update", "remove"], function (name) {                                               // 341
  Meteor.Collection.prototype[name] = function (/* arguments */) {                                     // 342
    var self = this;                                                                                   // 343
    var args = _.toArray(arguments);                                                                   // 344
    var callback;                                                                                      // 345
    var insertId;                                                                                      // 346
    var ret;                                                                                           // 347
                                                                                                       // 348
    if (args.length && args[args.length - 1] instanceof Function)                                      // 349
      callback = args.pop();                                                                           // 350
                                                                                                       // 351
    if (name === "insert") {                                                                           // 352
      if (!args.length)                                                                                // 353
        throw new Error("insert requires an argument");                                                // 354
      // shallow-copy the document and generate an ID                                                  // 355
      args[0] = _.extend({}, args[0]);                                                                 // 356
      if ('_id' in args[0]) {                                                                          // 357
        insertId = args[0]._id;                                                                        // 358
        if (!insertId || !(typeof insertId === 'string'                                                // 359
              || insertId instanceof Meteor.Collection.ObjectID))                                      // 360
          throw new Error("Meteor requires document _id fields to be non-empty strings or ObjectIDs"); // 361
      } else {                                                                                         // 362
        insertId = args[0]._id = self._makeNewID();                                                    // 363
      }                                                                                                // 364
    } else {                                                                                           // 365
      args[0] = Meteor.Collection._rewriteSelector(args[0]);                                           // 366
                                                                                                       // 367
      if (name === "update") {                                                                         // 368
        // Mutate args but copy the original options object. We need to add                            // 369
        // insertedId to options, but don't want to mutate the caller's options                        // 370
        // object. We need to mutate `args` because we pass `args` into the                            // 371
        // driver below.                                                                               // 372
        var options = args[2] = _.clone(args[2]) || {};                                                // 373
        if (options && typeof options !== "function" && options.upsert) {                              // 374
          // set `insertedId` if absent.  `insertedId` is a Meteor extension.                          // 375
          if (options.insertedId) {                                                                    // 376
            if (!(typeof options.insertedId === 'string'                                               // 377
                  || options.insertedId instanceof Meteor.Collection.ObjectID))                        // 378
              throw new Error("insertedId must be string or ObjectID");                                // 379
          } else {                                                                                     // 380
            options.insertedId = self._makeNewID();                                                    // 381
          }                                                                                            // 382
        }                                                                                              // 383
      }                                                                                                // 384
    }                                                                                                  // 385
                                                                                                       // 386
    // On inserts, always return the id that we generated; on all other                                // 387
    // operations, just return the result from the collection.                                         // 388
    var chooseReturnValueFromCollectionResult = function (result) {                                    // 389
      if (name === "insert")                                                                           // 390
        return insertId;                                                                               // 391
      else                                                                                             // 392
        return result;                                                                                 // 393
    };                                                                                                 // 394
                                                                                                       // 395
    var wrappedCallback;                                                                               // 396
    if (callback) {                                                                                    // 397
      wrappedCallback = function (error, result) {                                                     // 398
        callback(error, ! error && chooseReturnValueFromCollectionResult(result));                     // 399
      };                                                                                               // 400
    }                                                                                                  // 401
                                                                                                       // 402
    if (self._connection && self._connection !== Meteor.server) {                                      // 403
      // just remote to another endpoint, propagate return value or                                    // 404
      // exception.                                                                                    // 405
                                                                                                       // 406
      var enclosing = DDP._CurrentInvocation.get();                                                    // 407
      var alreadyInSimulation = enclosing && enclosing.isSimulation;                                   // 408
                                                                                                       // 409
      if (Meteor.isClient && !wrappedCallback && ! alreadyInSimulation) {                              // 410
        // Client can't block, so it can't report errors by exception,                                 // 411
        // only by callback. If they forget the callback, give them a                                  // 412
        // default one that logs the error, so they aren't totally                                     // 413
        // baffled if their writes don't work because their database is                                // 414
        // down.                                                                                       // 415
        // Don't give a default callback in simulation, because inside stubs we                        // 416
        // want to return the results from the local collection immediately and                        // 417
        // not force a callback.                                                                       // 418
        wrappedCallback = function (err) {                                                             // 419
          if (err)                                                                                     // 420
            Meteor._debug(name + " failed: " + (err.reason || err.stack));                             // 421
        };                                                                                             // 422
      }                                                                                                // 423
                                                                                                       // 424
      if (!alreadyInSimulation && name !== "insert") {                                                 // 425
        // If we're about to actually send an RPC, we should throw an error if                         // 426
        // this is a non-ID selector, because the mutation methods only allow                          // 427
        // single-ID selectors. (If we don't throw here, we'll see flicker.)                           // 428
        throwIfSelectorIsNotId(args[0], name);                                                         // 429
      }                                                                                                // 430
                                                                                                       // 431
      ret = chooseReturnValueFromCollectionResult(                                                     // 432
        self._connection.apply(self._prefix + name, args, wrappedCallback)                             // 433
      );                                                                                               // 434
                                                                                                       // 435
    } else {                                                                                           // 436
      // it's my collection.  descend into the collection object                                       // 437
      // and propagate any exception.                                                                  // 438
      args.push(wrappedCallback);                                                                      // 439
      try {                                                                                            // 440
        // If the user provided a callback and the collection implements this                          // 441
        // operation asynchronously, then queryRet will be undefined, and the                          // 442
        // result will be returned through the callback instead.                                       // 443
        var queryRet = self._collection[name].apply(self._collection, args);                           // 444
        ret = chooseReturnValueFromCollectionResult(queryRet);                                         // 445
      } catch (e) {                                                                                    // 446
        if (callback) {                                                                                // 447
          callback(e);                                                                                 // 448
          return null;                                                                                 // 449
        }                                                                                              // 450
        throw e;                                                                                       // 451
      }                                                                                                // 452
    }                                                                                                  // 453
                                                                                                       // 454
    // both sync and async, unless we threw an exception, return ret                                   // 455
    // (new document ID for insert, num affected for update/remove, object with                        // 456
    // numberAffected and maybe insertedId for upsert).                                                // 457
    return ret;                                                                                        // 458
  };                                                                                                   // 459
});                                                                                                    // 460
                                                                                                       // 461
Meteor.Collection.prototype.upsert = function (selector, modifier,                                     // 462
                                               options, callback) {                                    // 463
  var self = this;                                                                                     // 464
  if (! callback && typeof options === "function") {                                                   // 465
    callback = options;                                                                                // 466
    options = {};                                                                                      // 467
  }                                                                                                    // 468
  return self.update(selector, modifier,                                                               // 469
              _.extend({}, options, { _returnObject: true, upsert: true }),                            // 470
              callback);                                                                               // 471
};                                                                                                     // 472
                                                                                                       // 473
// We'll actually design an index API later. For now, we just pass through to                          // 474
// Mongo's, but make it synchronous.                                                                   // 475
Meteor.Collection.prototype._ensureIndex = function (index, options) {                                 // 476
  var self = this;                                                                                     // 477
  if (!self._collection._ensureIndex)                                                                  // 478
    throw new Error("Can only call _ensureIndex on server collections");                               // 479
  self._collection._ensureIndex(index, options);                                                       // 480
};                                                                                                     // 481
Meteor.Collection.prototype._dropIndex = function (index) {                                            // 482
  var self = this;                                                                                     // 483
  if (!self._collection._dropIndex)                                                                    // 484
    throw new Error("Can only call _dropIndex on server collections");                                 // 485
  self._collection._dropIndex(index);                                                                  // 486
};                                                                                                     // 487
Meteor.Collection.prototype._dropCollection = function () {                                            // 488
  var self = this;                                                                                     // 489
  if (!self._collection.dropCollection)                                                                // 490
    throw new Error("Can only call _dropCollection on server collections");                            // 491
  self._collection.dropCollection();                                                                   // 492
};                                                                                                     // 493
Meteor.Collection.prototype._createCappedCollection = function (byteSize) {                            // 494
  var self = this;                                                                                     // 495
  if (!self._collection._createCappedCollection)                                                       // 496
    throw new Error("Can only call _createCappedCollection on server collections");                    // 497
  self._collection._createCappedCollection(byteSize);                                                  // 498
};                                                                                                     // 499
                                                                                                       // 500
Meteor.Collection.ObjectID = LocalCollection._ObjectID;                                                // 501
                                                                                                       // 502
///                                                                                                    // 503
/// Remote methods and access control.                                                                 // 504
///                                                                                                    // 505
                                                                                                       // 506
// Restrict default mutators on collection. allow() and deny() take the                                // 507
// same options:                                                                                       // 508
//                                                                                                     // 509
// options.insert {Function(userId, doc)}                                                              // 510
//   return true to allow/deny adding this document                                                    // 511
//                                                                                                     // 512
// options.update {Function(userId, docs, fields, modifier)}                                           // 513
//   return true to allow/deny updating these documents.                                               // 514
//   `fields` is passed as an array of fields that are to be modified                                  // 515
//                                                                                                     // 516
// options.remove {Function(userId, docs)}                                                             // 517
//   return true to allow/deny removing these documents                                                // 518
//                                                                                                     // 519
// options.fetch {Array}                                                                               // 520
//   Fields to fetch for these validators. If any call to allow or deny                                // 521
//   does not have this option then all fields are loaded.                                             // 522
//                                                                                                     // 523
// allow and deny can be called multiple times. The validators are                                     // 524
// evaluated as follows:                                                                               // 525
// - If neither deny() nor allow() has been called on the collection,                                  // 526
//   then the request is allowed if and only if the "insecure" smart                                   // 527
//   package is in use.                                                                                // 528
// - Otherwise, if any deny() function returns true, the request is denied.                            // 529
// - Otherwise, if any allow() function returns true, the request is allowed.                          // 530
// - Otherwise, the request is denied.                                                                 // 531
//                                                                                                     // 532
// Meteor may call your deny() and allow() functions in any order, and may not                         // 533
// call all of them if it is able to make a decision without calling them all                          // 534
// (so don't include side effects).                                                                    // 535
                                                                                                       // 536
(function () {                                                                                         // 537
  var addValidator = function(allowOrDeny, options) {                                                  // 538
    // validate keys                                                                                   // 539
    var VALID_KEYS = ['insert', 'update', 'remove', 'fetch', 'transform'];                             // 540
    _.each(_.keys(options), function (key) {                                                           // 541
      if (!_.contains(VALID_KEYS, key))                                                                // 542
        throw new Error(allowOrDeny + ": Invalid key: " + key);                                        // 543
    });                                                                                                // 544
                                                                                                       // 545
    var self = this;                                                                                   // 546
    self._restricted = true;                                                                           // 547
                                                                                                       // 548
    _.each(['insert', 'update', 'remove'], function (name) {                                           // 549
      if (options[name]) {                                                                             // 550
        if (!(options[name] instanceof Function)) {                                                    // 551
          throw new Error(allowOrDeny + ": Value for `" + name + "` must be a function");              // 552
        }                                                                                              // 553
                                                                                                       // 554
        // If the transform is specified at all (including as 'null') in this                          // 555
        // call, then take that; otherwise, take the transform from the                                // 556
        // collection.                                                                                 // 557
        if (options.transform === undefined) {                                                         // 558
          options[name].transform = self._transform;  // already wrapped                               // 559
        } else {                                                                                       // 560
          options[name].transform = LocalCollection.wrapTransform(                                     // 561
            options.transform);                                                                        // 562
        }                                                                                              // 563
                                                                                                       // 564
        self._validators[name][allowOrDeny].push(options[name]);                                       // 565
      }                                                                                                // 566
    });                                                                                                // 567
                                                                                                       // 568
    // Only update the fetch fields if we're passed things that affect                                 // 569
    // fetching. This way allow({}) and allow({insert: f}) don't result in                             // 570
    // setting fetchAllFields                                                                          // 571
    if (options.update || options.remove || options.fetch) {                                           // 572
      if (options.fetch && !(options.fetch instanceof Array)) {                                        // 573
        throw new Error(allowOrDeny + ": Value for `fetch` must be an array");                         // 574
      }                                                                                                // 575
      self._updateFetch(options.fetch);                                                                // 576
    }                                                                                                  // 577
  };                                                                                                   // 578
                                                                                                       // 579
  Meteor.Collection.prototype.allow = function(options) {                                              // 580
    addValidator.call(this, 'allow', options);                                                         // 581
  };                                                                                                   // 582
  Meteor.Collection.prototype.deny = function(options) {                                               // 583
    addValidator.call(this, 'deny', options);                                                          // 584
  };                                                                                                   // 585
})();                                                                                                  // 586
                                                                                                       // 587
                                                                                                       // 588
Meteor.Collection.prototype._defineMutationMethods = function() {                                      // 589
  var self = this;                                                                                     // 590
                                                                                                       // 591
  // set to true once we call any allow or deny methods. If true, use                                  // 592
  // allow/deny semantics. If false, use insecure mode semantics.                                      // 593
  self._restricted = false;                                                                            // 594
                                                                                                       // 595
  // Insecure mode (default to allowing writes). Defaults to 'undefined' which                         // 596
  // means insecure iff the insecure package is loaded. This property can be                           // 597
  // overriden by tests or packages wishing to change insecure mode behavior of                        // 598
  // their collections.                                                                                // 599
  self._insecure = undefined;                                                                          // 600
                                                                                                       // 601
  self._validators = {                                                                                 // 602
    insert: {allow: [], deny: []},                                                                     // 603
    update: {allow: [], deny: []},                                                                     // 604
    remove: {allow: [], deny: []},                                                                     // 605
    upsert: {allow: [], deny: []}, // dummy arrays; can't set these!                                   // 606
    fetch: [],                                                                                         // 607
    fetchAllFields: false                                                                              // 608
  };                                                                                                   // 609
                                                                                                       // 610
  if (!self._name)                                                                                     // 611
    return; // anonymous collection                                                                    // 612
                                                                                                       // 613
  // XXX Think about method namespacing. Maybe methods should be                                       // 614
  // "Meteor:Mongo:insert/NAME"?                                                                       // 615
  self._prefix = '/' + self._name + '/';                                                               // 616
                                                                                                       // 617
  // mutation methods                                                                                  // 618
  if (self._connection) {                                                                              // 619
    var m = {};                                                                                        // 620
                                                                                                       // 621
    _.each(['insert', 'update', 'remove'], function (method) {                                         // 622
      m[self._prefix + method] = function (/* ... */) {                                                // 623
        // All the methods do their own validation, instead of using check().                          // 624
        check(arguments, [Match.Any]);                                                                 // 625
        try {                                                                                          // 626
          if (this.isSimulation) {                                                                     // 627
                                                                                                       // 628
            // In a client simulation, you can do any mutation (even with a                            // 629
            // complex selector).                                                                      // 630
            return self._collection[method].apply(                                                     // 631
              self._collection, _.toArray(arguments));                                                 // 632
          }                                                                                            // 633
                                                                                                       // 634
          // This is the server receiving a method call from the client.                               // 635
                                                                                                       // 636
          // We don't allow arbitrary selectors in mutations from the client: only                     // 637
          // single-ID selectors.                                                                      // 638
          if (method !== 'insert')                                                                     // 639
            throwIfSelectorIsNotId(arguments[0], method);                                              // 640
                                                                                                       // 641
          if (self._restricted) {                                                                      // 642
            // short circuit if there is no way it will pass.                                          // 643
            if (self._validators[method].allow.length === 0) {                                         // 644
              throw new Meteor.Error(                                                                  // 645
                403, "Access denied. No allow validators set on restricted " +                         // 646
                  "collection for method '" + method + "'.");                                          // 647
            }                                                                                          // 648
                                                                                                       // 649
            var validatedMethodName =                                                                  // 650
                  '_validated' + method.charAt(0).toUpperCase() + method.slice(1);                     // 651
            var argsWithUserId = [this.userId].concat(_.toArray(arguments));                           // 652
            return self[validatedMethodName].apply(self, argsWithUserId);                              // 653
          } else if (self._isInsecure()) {                                                             // 654
            // In insecure mode, allow any mutation (with a simple selector).                          // 655
            return self._collection[method].apply(self._collection,                                    // 656
                                                  _.toArray(arguments));                               // 657
          } else {                                                                                     // 658
            // In secure mode, if we haven't called allow or deny, then nothing                        // 659
            // is permitted.                                                                           // 660
            throw new Meteor.Error(403, "Access denied");                                              // 661
          }                                                                                            // 662
        } catch (e) {                                                                                  // 663
          if (e.name === 'MongoError' || e.name === 'MinimongoError') {                                // 664
            throw new Meteor.Error(409, e.toString());                                                 // 665
          } else {                                                                                     // 666
            throw e;                                                                                   // 667
          }                                                                                            // 668
        }                                                                                              // 669
      };                                                                                               // 670
    });                                                                                                // 671
    // Minimongo on the server gets no stubs; instead, by default                                      // 672
    // it wait()s until its result is ready, yielding.                                                 // 673
    // This matches the behavior of macromongo on the server better.                                   // 674
    if (Meteor.isClient || self._connection === Meteor.server)                                         // 675
      self._connection.methods(m);                                                                     // 676
  }                                                                                                    // 677
};                                                                                                     // 678
                                                                                                       // 679
                                                                                                       // 680
Meteor.Collection.prototype._updateFetch = function (fields) {                                         // 681
  var self = this;                                                                                     // 682
                                                                                                       // 683
  if (!self._validators.fetchAllFields) {                                                              // 684
    if (fields) {                                                                                      // 685
      self._validators.fetch = _.union(self._validators.fetch, fields);                                // 686
    } else {                                                                                           // 687
      self._validators.fetchAllFields = true;                                                          // 688
      // clear fetch just to make sure we don't accidentally read it                                   // 689
      self._validators.fetch = null;                                                                   // 690
    }                                                                                                  // 691
  }                                                                                                    // 692
};                                                                                                     // 693
                                                                                                       // 694
Meteor.Collection.prototype._isInsecure = function () {                                                // 695
  var self = this;                                                                                     // 696
  if (self._insecure === undefined)                                                                    // 697
    return !!Package.insecure;                                                                         // 698
  return self._insecure;                                                                               // 699
};                                                                                                     // 700
                                                                                                       // 701
var docToValidate = function (validator, doc) {                                                        // 702
  var ret = doc;                                                                                       // 703
  if (validator.transform)                                                                             // 704
    ret = validator.transform(EJSON.clone(doc));                                                       // 705
  return ret;                                                                                          // 706
};                                                                                                     // 707
                                                                                                       // 708
Meteor.Collection.prototype._validatedInsert = function(userId, doc) {                                 // 709
  var self = this;                                                                                     // 710
                                                                                                       // 711
  // call user validators.                                                                             // 712
  // Any deny returns true means denied.                                                               // 713
  if (_.any(self._validators.insert.deny, function(validator) {                                        // 714
    return validator(userId, docToValidate(validator, doc));                                           // 715
  })) {                                                                                                // 716
    throw new Meteor.Error(403, "Access denied");                                                      // 717
  }                                                                                                    // 718
  // Any allow returns true means proceed. Throw error if they all fail.                               // 719
  if (_.all(self._validators.insert.allow, function(validator) {                                       // 720
    return !validator(userId, docToValidate(validator, doc));                                          // 721
  })) {                                                                                                // 722
    throw new Meteor.Error(403, "Access denied");                                                      // 723
  }                                                                                                    // 724
                                                                                                       // 725
  self._collection.insert.call(self._collection, doc);                                                 // 726
};                                                                                                     // 727
                                                                                                       // 728
var transformDoc = function (validator, doc) {                                                         // 729
  if (validator.transform)                                                                             // 730
    return validator.transform(doc);                                                                   // 731
  return doc;                                                                                          // 732
};                                                                                                     // 733
                                                                                                       // 734
// Simulate a mongo `update` operation while validating that the access                                // 735
// control rules set by calls to `allow/deny` are satisfied. If all                                    // 736
// pass, rewrite the mongo operation to use $in to set the list of                                     // 737
// document ids to change ##ValidatedChange                                                            // 738
Meteor.Collection.prototype._validatedUpdate = function(                                               // 739
    userId, selector, mutator, options) {                                                              // 740
  var self = this;                                                                                     // 741
                                                                                                       // 742
  options = options || {};                                                                             // 743
                                                                                                       // 744
  if (!LocalCollection._selectorIsIdPerhapsAsObject(selector))                                         // 745
    throw new Error("validated update should be of a single ID");                                      // 746
                                                                                                       // 747
  // We don't support upserts because they don't fit nicely into allow/deny                            // 748
  // rules.                                                                                            // 749
  if (options.upsert)                                                                                  // 750
    throw new Meteor.Error(403, "Access denied. Upserts not " +                                        // 751
                           "allowed in a restricted collection.");                                     // 752
                                                                                                       // 753
  // compute modified fields                                                                           // 754
  var fields = [];                                                                                     // 755
  _.each(mutator, function (params, op) {                                                              // 756
    if (op.charAt(0) !== '$') {                                                                        // 757
      throw new Meteor.Error(                                                                          // 758
        403, "Access denied. In a restricted collection you can only update documents, not replace them. Use a Mongo update operator, such as '$set'.");
    } else if (!_.has(ALLOWED_UPDATE_OPERATIONS, op)) {                                                // 760
      throw new Meteor.Error(                                                                          // 761
        403, "Access denied. Operator " + op + " not allowed in a restricted collection.");            // 762
    } else {                                                                                           // 763
      _.each(_.keys(params), function (field) {                                                        // 764
        // treat dotted fields as if they are replacing their                                          // 765
        // top-level part                                                                              // 766
        if (field.indexOf('.') !== -1)                                                                 // 767
          field = field.substring(0, field.indexOf('.'));                                              // 768
                                                                                                       // 769
        // record the field we are trying to change                                                    // 770
        if (!_.contains(fields, field))                                                                // 771
          fields.push(field);                                                                          // 772
      });                                                                                              // 773
    }                                                                                                  // 774
  });                                                                                                  // 775
                                                                                                       // 776
  var findOptions = {transform: null};                                                                 // 777
  if (!self._validators.fetchAllFields) {                                                              // 778
    findOptions.fields = {};                                                                           // 779
    _.each(self._validators.fetch, function(fieldName) {                                               // 780
      findOptions.fields[fieldName] = 1;                                                               // 781
    });                                                                                                // 782
  }                                                                                                    // 783
                                                                                                       // 784
  var doc = self._collection.findOne(selector, findOptions);                                           // 785
  if (!doc)  // none satisfied!                                                                        // 786
    return 0;                                                                                          // 787
                                                                                                       // 788
  var factoriedDoc;                                                                                    // 789
                                                                                                       // 790
  // call user validators.                                                                             // 791
  // Any deny returns true means denied.                                                               // 792
  if (_.any(self._validators.update.deny, function(validator) {                                        // 793
    if (!factoriedDoc)                                                                                 // 794
      factoriedDoc = transformDoc(validator, doc);                                                     // 795
    return validator(userId,                                                                           // 796
                     factoriedDoc,                                                                     // 797
                     fields,                                                                           // 798
                     mutator);                                                                         // 799
  })) {                                                                                                // 800
    throw new Meteor.Error(403, "Access denied");                                                      // 801
  }                                                                                                    // 802
  // Any allow returns true means proceed. Throw error if they all fail.                               // 803
  if (_.all(self._validators.update.allow, function(validator) {                                       // 804
    if (!factoriedDoc)                                                                                 // 805
      factoriedDoc = transformDoc(validator, doc);                                                     // 806
    return !validator(userId,                                                                          // 807
                      factoriedDoc,                                                                    // 808
                      fields,                                                                          // 809
                      mutator);                                                                        // 810
  })) {                                                                                                // 811
    throw new Meteor.Error(403, "Access denied");                                                      // 812
  }                                                                                                    // 813
                                                                                                       // 814
  // Back when we supported arbitrary client-provided selectors, we actually                           // 815
  // rewrote the selector to include an _id clause before passing to Mongo to                          // 816
  // avoid races, but since selector is guaranteed to already just be an ID, we                        // 817
  // don't have to any more.                                                                           // 818
                                                                                                       // 819
  return self._collection.update.call(                                                                 // 820
    self._collection, selector, mutator, options);                                                     // 821
};                                                                                                     // 822
                                                                                                       // 823
// Only allow these operations in validated updates. Specifically                                      // 824
// whitelist operations, rather than blacklist, so new complex                                         // 825
// operations that are added aren't automatically allowed. A complex                                   // 826
// operation is one that does more than just modify its target                                         // 827
// field. For now this contains all update operations except '$rename'.                                // 828
// http://docs.mongodb.org/manual/reference/operators/#update                                          // 829
var ALLOWED_UPDATE_OPERATIONS = {                                                                      // 830
  $inc:1, $set:1, $unset:1, $addToSet:1, $pop:1, $pullAll:1, $pull:1,                                  // 831
  $pushAll:1, $push:1, $bit:1                                                                          // 832
};                                                                                                     // 833
                                                                                                       // 834
// Simulate a mongo `remove` operation while validating access control                                 // 835
// rules. See #ValidatedChange                                                                         // 836
Meteor.Collection.prototype._validatedRemove = function(userId, selector) {                            // 837
  var self = this;                                                                                     // 838
                                                                                                       // 839
  var findOptions = {transform: null};                                                                 // 840
  if (!self._validators.fetchAllFields) {                                                              // 841
    findOptions.fields = {};                                                                           // 842
    _.each(self._validators.fetch, function(fieldName) {                                               // 843
      findOptions.fields[fieldName] = 1;                                                               // 844
    });                                                                                                // 845
  }                                                                                                    // 846
                                                                                                       // 847
  var doc = self._collection.findOne(selector, findOptions);                                           // 848
  if (!doc)                                                                                            // 849
    return 0;                                                                                          // 850
                                                                                                       // 851
  // call user validators.                                                                             // 852
  // Any deny returns true means denied.                                                               // 853
  if (_.any(self._validators.remove.deny, function(validator) {                                        // 854
    return validator(userId, transformDoc(validator, doc));                                            // 855
  })) {                                                                                                // 856
    throw new Meteor.Error(403, "Access denied");                                                      // 857
  }                                                                                                    // 858
  // Any allow returns true means proceed. Throw error if they all fail.                               // 859
  if (_.all(self._validators.remove.allow, function(validator) {                                       // 860
    return !validator(userId, transformDoc(validator, doc));                                           // 861
  })) {                                                                                                // 862
    throw new Meteor.Error(403, "Access denied");                                                      // 863
  }                                                                                                    // 864
                                                                                                       // 865
  // Back when we supported arbitrary client-provided selectors, we actually                           // 866
  // rewrote the selector to {_id: {$in: [ids that we found]}} before passing to                       // 867
  // Mongo to avoid races, but since selector is guaranteed to already just be                         // 868
  // an ID, we don't have to any more.                                                                 // 869
                                                                                                       // 870
  return self._collection.remove.call(self._collection, selector);                                     // 871
};                                                                                                     // 872
                                                                                                       // 873
/////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package['mongo-livedata'] = {
  MongoInternals: MongoInternals,
  MongoTest: MongoTest
};

})();
