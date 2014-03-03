(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var _ = Package.underscore._;
var EJSON = Package.ejson.EJSON;
var OrderedDict = Package['ordered-dict'].OrderedDict;
var Deps = Package.deps.Deps;
var Random = Package.random.Random;
var GeoJSON = Package['geojson-utils'].GeoJSON;

/* Package-scope variables */
var LocalCollection, Minimongo, MinimongoTest, MinimongoError, isArray, isPlainObject, isIndexable, isOperatorObject, isNumericKey, makeLookupFunction, expandArraysInBranches, Sorter, projectionDetails, pathsToTree;

(function () {

////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                    //
// packages/minimongo/minimongo.js                                                                    //
//                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                      //
// XXX type checking on selectors (graceful error if malformed)                                       // 1
                                                                                                      // 2
// LocalCollection: a set of documents that supports queries and modifiers.                           // 3
                                                                                                      // 4
// Cursor: a specification for a particular subset of documents, w/                                   // 5
// a defined order, limit, and offset.  creating a Cursor with LocalCollection.find(),                // 6
                                                                                                      // 7
// ObserveHandle: the return value of a live query.                                                   // 8
                                                                                                      // 9
LocalCollection = function (name) {                                                                   // 10
  var self = this;                                                                                    // 11
  self.name = name;                                                                                   // 12
  // _id -> document (also containing id)                                                             // 13
  self._docs = new LocalCollection._IdMap;                                                            // 14
                                                                                                      // 15
  self._observeQueue = new Meteor._SynchronousQueue();                                                // 16
                                                                                                      // 17
  self.next_qid = 1; // live query id generator                                                       // 18
                                                                                                      // 19
  // qid -> live query object. keys:                                                                  // 20
  //  ordered: bool. ordered queries have addedBefore/movedBefore callbacks.                          // 21
  //  results: array (ordered) or object (unordered) of current results                               // 22
  //    (aliased with self._docs!)                                                                    // 23
  //  resultsSnapshot: snapshot of results. null if not paused.                                       // 24
  //  cursor: Cursor object for the query.                                                            // 25
  //  selector, sorter, (callbacks): functions                                                        // 26
  self.queries = {};                                                                                  // 27
                                                                                                      // 28
  // null if not saving originals; an IdMap from id to original document value if                     // 29
  // saving originals. See comments before saveOriginals().                                           // 30
  self._savedOriginals = null;                                                                        // 31
                                                                                                      // 32
  // True when observers are paused and we should not send callbacks.                                 // 33
  self.paused = false;                                                                                // 34
};                                                                                                    // 35
                                                                                                      // 36
Minimongo = {};                                                                                       // 37
                                                                                                      // 38
// Object exported only for unit testing.                                                             // 39
// Use it to export private functions to test in Tinytest.                                            // 40
MinimongoTest = {};                                                                                   // 41
                                                                                                      // 42
LocalCollection._applyChanges = function (doc, changeFields) {                                        // 43
  _.each(changeFields, function (value, key) {                                                        // 44
    if (value === undefined)                                                                          // 45
      delete doc[key];                                                                                // 46
    else                                                                                              // 47
      doc[key] = value;                                                                               // 48
  });                                                                                                 // 49
};                                                                                                    // 50
                                                                                                      // 51
MinimongoError = function (message) {                                                                 // 52
  var e = new Error(message);                                                                         // 53
  e.name = "MinimongoError";                                                                          // 54
  return e;                                                                                           // 55
};                                                                                                    // 56
                                                                                                      // 57
                                                                                                      // 58
// options may include sort, skip, limit, reactive                                                    // 59
// sort may be any of these forms:                                                                    // 60
//     {a: 1, b: -1}                                                                                  // 61
//     [["a", "asc"], ["b", "desc"]]                                                                  // 62
//     ["a", ["b", "desc"]]                                                                           // 63
//   (in the first form you're beholden to key enumeration order in                                   // 64
//   your javascript VM)                                                                              // 65
//                                                                                                    // 66
// reactive: if given, and false, don't register with Deps (default                                   // 67
// is true)                                                                                           // 68
//                                                                                                    // 69
// XXX possibly should support retrieving a subset of fields? and                                     // 70
// have it be a hint (ignored on the client, when not copying the                                     // 71
// doc?)                                                                                              // 72
//                                                                                                    // 73
// XXX sort does not yet support subkeys ('a.b') .. fix that!                                         // 74
// XXX add one more sort form: "key"                                                                  // 75
// XXX tests                                                                                          // 76
LocalCollection.prototype.find = function (selector, options) {                                       // 77
  // default syntax for everything is to omit the selector argument.                                  // 78
  // but if selector is explicitly passed in as false or undefined, we                                // 79
  // want a selector that matches nothing.                                                            // 80
  if (arguments.length === 0)                                                                         // 81
    selector = {};                                                                                    // 82
                                                                                                      // 83
  return new LocalCollection.Cursor(this, selector, options);                                         // 84
};                                                                                                    // 85
                                                                                                      // 86
// don't call this ctor directly.  use LocalCollection.find().                                        // 87
LocalCollection.Cursor = function (collection, selector, options) {                                   // 88
  var self = this;                                                                                    // 89
  if (!options) options = {};                                                                         // 90
                                                                                                      // 91
  this.collection = collection;                                                                       // 92
                                                                                                      // 93
  if (LocalCollection._selectorIsId(selector)) {                                                      // 94
    // stash for fast path                                                                            // 95
    self._selectorId = selector;                                                                      // 96
    self.matcher = new Minimongo.Matcher(selector, self);                                             // 97
    self.sorter = undefined;                                                                          // 98
  } else {                                                                                            // 99
    self._selectorId = undefined;                                                                     // 100
    self.matcher = new Minimongo.Matcher(selector, self);                                             // 101
    self.sorter = (self.matcher.hasGeoQuery() || options.sort) ?                                      // 102
      new Sorter(options.sort || []) : null;                                                          // 103
  }                                                                                                   // 104
  self.skip = options.skip;                                                                           // 105
  self.limit = options.limit;                                                                         // 106
  self.fields = options.fields;                                                                       // 107
                                                                                                      // 108
  if (self.fields)                                                                                    // 109
    self.projectionFn = LocalCollection._compileProjection(self.fields);                              // 110
                                                                                                      // 111
  self._transform = LocalCollection.wrapTransform(options.transform);                                 // 112
                                                                                                      // 113
  // db_objects is an array of the objects that match the cursor. (It's always                        // 114
  // an array, never an IdMap: LocalCollection.Cursor is always ordered.)                             // 115
  self.db_objects = null;                                                                             // 116
  self.cursor_pos = 0;                                                                                // 117
                                                                                                      // 118
  // by default, queries register w/ Deps when it is available.                                       // 119
  if (typeof Deps !== "undefined")                                                                    // 120
    self.reactive = (options.reactive === undefined) ? true : options.reactive;                       // 121
};                                                                                                    // 122
                                                                                                      // 123
LocalCollection.Cursor.prototype.rewind = function () {                                               // 124
  var self = this;                                                                                    // 125
  self.db_objects = null;                                                                             // 126
  self.cursor_pos = 0;                                                                                // 127
};                                                                                                    // 128
                                                                                                      // 129
LocalCollection.prototype.findOne = function (selector, options) {                                    // 130
  if (arguments.length === 0)                                                                         // 131
    selector = {};                                                                                    // 132
                                                                                                      // 133
  // NOTE: by setting limit 1 here, we end up using very inefficient                                  // 134
  // code that recomputes the whole query on each update. The upside is                               // 135
  // that when you reactively depend on a findOne you only get                                        // 136
  // invalidated when the found object changes, not any object in the                                 // 137
  // collection. Most findOne will be by id, which has a fast path, so                                // 138
  // this might not be a big deal. In most cases, invalidation causes                                 // 139
  // the called to re-query anyway, so this should be a net performance                               // 140
  // improvement.                                                                                     // 141
  options = options || {};                                                                            // 142
  options.limit = 1;                                                                                  // 143
                                                                                                      // 144
  return this.find(selector, options).fetch()[0];                                                     // 145
};                                                                                                    // 146
                                                                                                      // 147
LocalCollection.Cursor.prototype.forEach = function (callback, thisArg) {                             // 148
  var self = this;                                                                                    // 149
                                                                                                      // 150
  if (self.db_objects === null)                                                                       // 151
    self.db_objects = self._getRawObjects({ordered: true});                                           // 152
                                                                                                      // 153
  if (self.reactive)                                                                                  // 154
    self._depend({                                                                                    // 155
      addedBefore: true,                                                                              // 156
      removed: true,                                                                                  // 157
      changed: true,                                                                                  // 158
      movedBefore: true});                                                                            // 159
                                                                                                      // 160
  while (self.cursor_pos < self.db_objects.length) {                                                  // 161
    var elt = EJSON.clone(self.db_objects[self.cursor_pos]);                                          // 162
    if (self.projectionFn)                                                                            // 163
      elt = self.projectionFn(elt);                                                                   // 164
    if (self._transform)                                                                              // 165
      elt = self._transform(elt);                                                                     // 166
    callback.call(thisArg, elt, self.cursor_pos, self);                                               // 167
    ++self.cursor_pos;                                                                                // 168
  }                                                                                                   // 169
};                                                                                                    // 170
                                                                                                      // 171
LocalCollection.Cursor.prototype.getTransform = function () {                                         // 172
  return this._transform;                                                                             // 173
};                                                                                                    // 174
                                                                                                      // 175
LocalCollection.Cursor.prototype.map = function (callback, thisArg) {                                 // 176
  var self = this;                                                                                    // 177
  var res = [];                                                                                       // 178
  self.forEach(function (doc, index) {                                                                // 179
    res.push(callback.call(thisArg, doc, index, self));                                               // 180
  });                                                                                                 // 181
  return res;                                                                                         // 182
};                                                                                                    // 183
                                                                                                      // 184
LocalCollection.Cursor.prototype.fetch = function () {                                                // 185
  var self = this;                                                                                    // 186
  var res = [];                                                                                       // 187
  self.forEach(function (doc) {                                                                       // 188
    res.push(doc);                                                                                    // 189
  });                                                                                                 // 190
  return res;                                                                                         // 191
};                                                                                                    // 192
                                                                                                      // 193
LocalCollection.Cursor.prototype.count = function () {                                                // 194
  var self = this;                                                                                    // 195
                                                                                                      // 196
  if (self.reactive)                                                                                  // 197
    self._depend({added: true, removed: true},                                                        // 198
                 true /* allow the observe to be unordered */);                                       // 199
                                                                                                      // 200
  if (self.db_objects === null)                                                                       // 201
    self.db_objects = self._getRawObjects({ordered: true});                                           // 202
                                                                                                      // 203
  return self.db_objects.length;                                                                      // 204
};                                                                                                    // 205
                                                                                                      // 206
LocalCollection.Cursor.prototype._publishCursor = function (sub) {                                    // 207
  var self = this;                                                                                    // 208
  if (! self.collection.name)                                                                         // 209
    throw new Error("Can't publish a cursor from a collection without a name.");                      // 210
  var collection = self.collection.name;                                                              // 211
                                                                                                      // 212
  // XXX minimongo should not depend on mongo-livedata!                                               // 213
  return Meteor.Collection._publishCursor(self, sub, collection);                                     // 214
};                                                                                                    // 215
                                                                                                      // 216
LocalCollection.Cursor.prototype._getCollectionName = function () {                                   // 217
  var self = this;                                                                                    // 218
  return self.collection.name;                                                                        // 219
};                                                                                                    // 220
                                                                                                      // 221
LocalCollection._observeChangesCallbacksAreOrdered = function (callbacks) {                           // 222
  if (callbacks.added && callbacks.addedBefore)                                                       // 223
    throw new Error("Please specify only one of added() and addedBefore()");                          // 224
  return !!(callbacks.addedBefore || callbacks.movedBefore);                                          // 225
};                                                                                                    // 226
                                                                                                      // 227
LocalCollection._observeCallbacksAreOrdered = function (callbacks) {                                  // 228
  if (callbacks.addedAt && callbacks.added)                                                           // 229
    throw new Error("Please specify only one of added() and addedAt()");                              // 230
  if (callbacks.changedAt && callbacks.changed)                                                       // 231
    throw new Error("Please specify only one of changed() and changedAt()");                          // 232
  if (callbacks.removed && callbacks.removedAt)                                                       // 233
    throw new Error("Please specify only one of removed() and removedAt()");                          // 234
                                                                                                      // 235
  return !!(callbacks.addedAt || callbacks.movedTo || callbacks.changedAt                             // 236
            || callbacks.removedAt);                                                                  // 237
};                                                                                                    // 238
                                                                                                      // 239
// the handle that comes back from observe.                                                           // 240
LocalCollection.ObserveHandle = function () {};                                                       // 241
                                                                                                      // 242
// options to contain:                                                                                // 243
//  * callbacks for observe():                                                                        // 244
//    - addedAt (document, atIndex)                                                                   // 245
//    - added (document)                                                                              // 246
//    - changedAt (newDocument, oldDocument, atIndex)                                                 // 247
//    - changed (newDocument, oldDocument)                                                            // 248
//    - removedAt (document, atIndex)                                                                 // 249
//    - removed (document)                                                                            // 250
//    - movedTo (document, oldIndex, newIndex)                                                        // 251
//                                                                                                    // 252
// attributes available on returned query handle:                                                     // 253
//  * stop(): end updates                                                                             // 254
//  * collection: the collection this query is querying                                               // 255
//                                                                                                    // 256
// iff x is a returned query handle, (x instanceof                                                    // 257
// LocalCollection.ObserveHandle) is true                                                             // 258
//                                                                                                    // 259
// initial results delivered through added callback                                                   // 260
// XXX maybe callbacks should take a list of objects, to expose transactions?                         // 261
// XXX maybe support field limiting (to limit what you're notified on)                                // 262
                                                                                                      // 263
_.extend(LocalCollection.Cursor.prototype, {                                                          // 264
  observe: function (options) {                                                                       // 265
    var self = this;                                                                                  // 266
    return LocalCollection._observeFromObserveChanges(self, options);                                 // 267
  },                                                                                                  // 268
  observeChanges: function (options) {                                                                // 269
    var self = this;                                                                                  // 270
                                                                                                      // 271
    var ordered = LocalCollection._observeChangesCallbacksAreOrdered(options);                        // 272
                                                                                                      // 273
    // there are several places that assume you aren't combining skip/limit with                      // 274
    // unordered observe.  eg, update's EJSON.clone, and the "there are several"                      // 275
    // comment in _modifyAndNotify                                                                    // 276
    // XXX allow skip/limit with unordered observe                                                    // 277
    if (!options._allow_unordered && !ordered && (self.skip || self.limit))                           // 278
      throw new Error("must use ordered observe with skip or limit");                                 // 279
                                                                                                      // 280
    if (self.fields && (self.fields._id === 0 || self.fields._id === false))                          // 281
      throw Error("You may not observe a cursor with {fields: {_id: 0}}");                            // 282
                                                                                                      // 283
    var query = {                                                                                     // 284
      matcher: self.matcher, // not fast pathed                                                       // 285
      sorter: ordered && self.sorter,                                                                 // 286
      distances: (                                                                                    // 287
        self.matcher.hasGeoQuery() && ordered && new LocalCollection._IdMap),                         // 288
      resultsSnapshot: null,                                                                          // 289
      ordered: ordered,                                                                               // 290
      cursor: self,                                                                                   // 291
      projectionFn: self.projectionFn                                                                 // 292
    };                                                                                                // 293
    var qid;                                                                                          // 294
                                                                                                      // 295
    // Non-reactive queries call added[Before] and then never call anything                           // 296
    // else.                                                                                          // 297
    if (self.reactive) {                                                                              // 298
      qid = self.collection.next_qid++;                                                               // 299
      self.collection.queries[qid] = query;                                                           // 300
    }                                                                                                 // 301
    query.results = self._getRawObjects({                                                             // 302
      ordered: ordered, distances: query.distances});                                                 // 303
    if (self.collection.paused)                                                                       // 304
      query.resultsSnapshot = (ordered ? [] : new LocalCollection._IdMap);                            // 305
                                                                                                      // 306
    // wrap callbacks we were passed. callbacks only fire when not paused and                         // 307
    // are never undefined                                                                            // 308
    // Filters out blacklisted fields according to cursor's projection.                               // 309
    // XXX wrong place for this?                                                                      // 310
                                                                                                      // 311
    // furthermore, callbacks enqueue until the operation we're working on is                         // 312
    // done.                                                                                          // 313
    var wrapCallback = function (f, fieldsIndex, ignoreEmptyFields) {                                 // 314
      if (!f)                                                                                         // 315
        return function () {};                                                                        // 316
      return function (/*args*/) {                                                                    // 317
        var context = this;                                                                           // 318
        var args = arguments;                                                                         // 319
                                                                                                      // 320
        if (self.collection.paused)                                                                   // 321
          return;                                                                                     // 322
                                                                                                      // 323
        if (fieldsIndex !== undefined && self.projectionFn) {                                         // 324
          args[fieldsIndex] = self.projectionFn(args[fieldsIndex]);                                   // 325
          if (ignoreEmptyFields && _.isEmpty(args[fieldsIndex]))                                      // 326
            return;                                                                                   // 327
        }                                                                                             // 328
                                                                                                      // 329
        self.collection._observeQueue.queueTask(function () {                                         // 330
          f.apply(context, args);                                                                     // 331
        });                                                                                           // 332
      };                                                                                              // 333
    };                                                                                                // 334
    query.added = wrapCallback(options.added, 1);                                                     // 335
    query.changed = wrapCallback(options.changed, 1, true);                                           // 336
    query.removed = wrapCallback(options.removed);                                                    // 337
    if (ordered) {                                                                                    // 338
      query.addedBefore = wrapCallback(options.addedBefore, 1);                                       // 339
      query.movedBefore = wrapCallback(options.movedBefore);                                          // 340
    }                                                                                                 // 341
                                                                                                      // 342
    if (!options._suppress_initial && !self.collection.paused) {                                      // 343
      // XXX unify ordered and unordered interface                                                    // 344
      var each = ordered                                                                              // 345
            ? _.bind(_.each, null, query.results)                                                     // 346
            : _.bind(query.results.forEach, query.results);                                           // 347
      each(function (doc) {                                                                           // 348
        var fields = EJSON.clone(doc);                                                                // 349
                                                                                                      // 350
        delete fields._id;                                                                            // 351
        if (ordered)                                                                                  // 352
          query.addedBefore(doc._id, fields, null);                                                   // 353
        query.added(doc._id, fields);                                                                 // 354
      });                                                                                             // 355
    }                                                                                                 // 356
                                                                                                      // 357
    var handle = new LocalCollection.ObserveHandle;                                                   // 358
    _.extend(handle, {                                                                                // 359
      collection: self.collection,                                                                    // 360
      stop: function () {                                                                             // 361
        if (self.reactive)                                                                            // 362
          delete self.collection.queries[qid];                                                        // 363
      }                                                                                               // 364
    });                                                                                               // 365
                                                                                                      // 366
    if (self.reactive && Deps.active) {                                                               // 367
      // XXX in many cases, the same observe will be recreated when                                   // 368
      // the current autorun is rerun.  we could save work by                                         // 369
      // letting it linger across rerun and potentially get                                           // 370
      // repurposed if the same observe is performed, using logic                                     // 371
      // similar to that of Meteor.subscribe.                                                         // 372
      Deps.onInvalidate(function () {                                                                 // 373
        handle.stop();                                                                                // 374
      });                                                                                             // 375
    }                                                                                                 // 376
    // run the observe callbacks resulting from the initial contents                                  // 377
    // before we leave the observe.                                                                   // 378
    self.collection._observeQueue.drain();                                                            // 379
                                                                                                      // 380
    return handle;                                                                                    // 381
  }                                                                                                   // 382
});                                                                                                   // 383
                                                                                                      // 384
// Returns a collection of matching objects, but doesn't deep copy them.                              // 385
//                                                                                                    // 386
// If ordered is set, returns a sorted array, respecting sorter, skip, and limit                      // 387
// properties of the query.  if sorter is falsey, no sort -- you get the natural                      // 388
// order.                                                                                             // 389
//                                                                                                    // 390
// If ordered is not set, returns an object mapping from ID to doc (sorter, skip                      // 391
// and limit should not be set).                                                                      // 392
//                                                                                                    // 393
// If ordered is set and this cursor is a $near geoquery, then this function                          // 394
// will use an _IdMap to track each distance from the $near argument point in                         // 395
// order to use it as a sort key. If an _IdMap is passed in the 'distances'                           // 396
// argument, this function will clear it and use it for this purpose (otherwise                       // 397
// it will just create its own _IdMap). The observeChanges implementation uses                        // 398
// this to remember the distances after this function returns.                                        // 399
LocalCollection.Cursor.prototype._getRawObjects = function (options) {                                // 400
  var self = this;                                                                                    // 401
  options = options || {};                                                                            // 402
                                                                                                      // 403
  // XXX use OrderedDict instead of array, and make IdMap and OrderedDict                             // 404
  // compatible                                                                                       // 405
  var results = options.ordered ? [] : new LocalCollection._IdMap;                                    // 406
                                                                                                      // 407
  // fast path for single ID value                                                                    // 408
  if (self._selectorId !== undefined) {                                                               // 409
    // If you have non-zero skip and ask for a single id, you get                                     // 410
    // nothing. This is so it matches the behavior of the '{_id: foo}'                                // 411
    // path.                                                                                          // 412
    if (self.skip)                                                                                    // 413
      return results;                                                                                 // 414
                                                                                                      // 415
    var selectedDoc = self.collection._docs.get(self._selectorId);                                    // 416
    if (selectedDoc) {                                                                                // 417
      if (options.ordered)                                                                            // 418
        results.push(selectedDoc);                                                                    // 419
      else                                                                                            // 420
        results.set(self._selectorId, selectedDoc);                                                   // 421
    }                                                                                                 // 422
    return results;                                                                                   // 423
  }                                                                                                   // 424
                                                                                                      // 425
  // slow path for arbitrary selector, sort, skip, limit                                              // 426
                                                                                                      // 427
  // in the observeChanges case, distances is actually part of the "query" (ie,                       // 428
  // live results set) object.  in other cases, distances is only used inside                         // 429
  // this function.                                                                                   // 430
  var distances;                                                                                      // 431
  if (self.matcher.hasGeoQuery() && options.ordered) {                                                // 432
    if (options.distances) {                                                                          // 433
      distances = options.distances;                                                                  // 434
      distances.clear();                                                                              // 435
    } else {                                                                                          // 436
      distances = new LocalCollection._IdMap();                                                       // 437
    }                                                                                                 // 438
  }                                                                                                   // 439
                                                                                                      // 440
  self.collection._docs.forEach(function (doc, id) {                                                  // 441
    var matchResult = self.matcher.documentMatches(doc);                                              // 442
    if (matchResult.result) {                                                                         // 443
      if (options.ordered) {                                                                          // 444
        results.push(doc);                                                                            // 445
        if (distances && matchResult.distance !== undefined)                                          // 446
          distances.set(id, matchResult.distance);                                                    // 447
      } else {                                                                                        // 448
        results.set(id, doc);                                                                         // 449
      }                                                                                               // 450
    }                                                                                                 // 451
    // Fast path for limited unsorted queries.                                                        // 452
    // XXX 'length' check here seems wrong for ordered                                                // 453
    if (self.limit && !self.skip && !self.sorter &&                                                   // 454
        results.length === self.limit)                                                                // 455
      return false;  // break                                                                         // 456
    return true;  // continue                                                                         // 457
  });                                                                                                 // 458
                                                                                                      // 459
  if (!options.ordered)                                                                               // 460
    return results;                                                                                   // 461
                                                                                                      // 462
  if (self.sorter) {                                                                                  // 463
    var comparator = self.sorter.getComparator({distances: distances});                               // 464
    results.sort(comparator);                                                                         // 465
  }                                                                                                   // 466
                                                                                                      // 467
  var idx_start = self.skip || 0;                                                                     // 468
  var idx_end = self.limit ? (self.limit + idx_start) : results.length;                               // 469
  return results.slice(idx_start, idx_end);                                                           // 470
};                                                                                                    // 471
                                                                                                      // 472
// XXX Maybe we need a version of observe that just calls a callback if                               // 473
// anything changed.                                                                                  // 474
LocalCollection.Cursor.prototype._depend = function (changers, _allow_unordered) {                    // 475
  var self = this;                                                                                    // 476
                                                                                                      // 477
  if (Deps.active) {                                                                                  // 478
    var v = new Deps.Dependency;                                                                      // 479
    v.depend();                                                                                       // 480
    var notifyChange = _.bind(v.changed, v);                                                          // 481
                                                                                                      // 482
    var options = {                                                                                   // 483
      _suppress_initial: true,                                                                        // 484
      _allow_unordered: _allow_unordered                                                              // 485
    };                                                                                                // 486
    _.each(['added', 'changed', 'removed', 'addedBefore', 'movedBefore'],                             // 487
           function (fnName) {                                                                        // 488
             if (changers[fnName])                                                                    // 489
               options[fnName] = notifyChange;                                                        // 490
           });                                                                                        // 491
                                                                                                      // 492
    // observeChanges will stop() when this computation is invalidated                                // 493
    self.observeChanges(options);                                                                     // 494
  }                                                                                                   // 495
};                                                                                                    // 496
                                                                                                      // 497
// XXX enforce rule that field names can't start with '$' or contain '.'                              // 498
// (real mongodb does in fact enforce this)                                                           // 499
// XXX possibly enforce that 'undefined' does not appear (we assume                                   // 500
// this in our handling of null and $exists)                                                          // 501
LocalCollection.prototype.insert = function (doc, callback) {                                         // 502
  var self = this;                                                                                    // 503
  doc = EJSON.clone(doc);                                                                             // 504
                                                                                                      // 505
  if (!_.has(doc, '_id')) {                                                                           // 506
    // if you really want to use ObjectIDs, set this global.                                          // 507
    // Meteor.Collection specifies its own ids and does not use this code.                            // 508
    doc._id = LocalCollection._useOID ? new LocalCollection._ObjectID()                               // 509
                                      : Random.id();                                                  // 510
  }                                                                                                   // 511
  var id = doc._id;                                                                                   // 512
                                                                                                      // 513
  if (self._docs.has(id))                                                                             // 514
    throw MinimongoError("Duplicate _id '" + id + "'");                                               // 515
                                                                                                      // 516
  self._saveOriginal(id, undefined);                                                                  // 517
  self._docs.set(id, doc);                                                                            // 518
                                                                                                      // 519
  var queriesToRecompute = [];                                                                        // 520
  // trigger live queries that match                                                                  // 521
  for (var qid in self.queries) {                                                                     // 522
    var query = self.queries[qid];                                                                    // 523
    var matchResult = query.matcher.documentMatches(doc);                                             // 524
    if (matchResult.result) {                                                                         // 525
      if (query.distances && matchResult.distance !== undefined)                                      // 526
        query.distances.set(id, matchResult.distance);                                                // 527
      if (query.cursor.skip || query.cursor.limit)                                                    // 528
        queriesToRecompute.push(qid);                                                                 // 529
      else                                                                                            // 530
        LocalCollection._insertInResults(query, doc);                                                 // 531
    }                                                                                                 // 532
  }                                                                                                   // 533
                                                                                                      // 534
  _.each(queriesToRecompute, function (qid) {                                                         // 535
    if (self.queries[qid])                                                                            // 536
      LocalCollection._recomputeResults(self.queries[qid]);                                           // 537
  });                                                                                                 // 538
  self._observeQueue.drain();                                                                         // 539
                                                                                                      // 540
  // Defer because the caller likely doesn't expect the callback to be run                            // 541
  // immediately.                                                                                     // 542
  if (callback)                                                                                       // 543
    Meteor.defer(function () {                                                                        // 544
      callback(null, id);                                                                             // 545
    });                                                                                               // 546
  return id;                                                                                          // 547
};                                                                                                    // 548
                                                                                                      // 549
// Iterates over a subset of documents that could match selector; calls                               // 550
// f(doc, id) on each of them.  Specifically, if selector specifies                                   // 551
// specific _id's, it only looks at those.  doc is *not* cloned: it is the                            // 552
// same object that is in _docs.                                                                      // 553
LocalCollection.prototype._eachPossiblyMatchingDoc = function (selector, f) {                         // 554
  var self = this;                                                                                    // 555
  var specificIds = LocalCollection._idsMatchedBySelector(selector);                                  // 556
  if (specificIds) {                                                                                  // 557
    for (var i = 0; i < specificIds.length; ++i) {                                                    // 558
      var id = specificIds[i];                                                                        // 559
      var doc = self._docs.get(id);                                                                   // 560
      if (doc) {                                                                                      // 561
        var breakIfFalse = f(doc, id);                                                                // 562
        if (breakIfFalse === false)                                                                   // 563
          break;                                                                                      // 564
      }                                                                                               // 565
    }                                                                                                 // 566
  } else {                                                                                            // 567
    self._docs.forEach(f);                                                                            // 568
  }                                                                                                   // 569
};                                                                                                    // 570
                                                                                                      // 571
LocalCollection.prototype.remove = function (selector, callback) {                                    // 572
  var self = this;                                                                                    // 573
                                                                                                      // 574
  // Easy special case: if we're not calling observeChanges callbacks and we're                       // 575
  // not saving originals and we got asked to remove everything, then just empty                      // 576
  // everything directly.                                                                             // 577
  if (self.paused && !self._savedOriginals && EJSON.equals(selector, {})) {                           // 578
    var result = self._docs.size();                                                                   // 579
    self._docs.clear();                                                                               // 580
    _.each(self.queries, function (query) {                                                           // 581
      if (query.ordered) {                                                                            // 582
        query.results = [];                                                                           // 583
      } else {                                                                                        // 584
        query.results.clear();                                                                        // 585
      }                                                                                               // 586
    });                                                                                               // 587
    if (callback) {                                                                                   // 588
      Meteor.defer(function () {                                                                      // 589
        callback(null, result);                                                                       // 590
      });                                                                                             // 591
    }                                                                                                 // 592
    return result;                                                                                    // 593
  }                                                                                                   // 594
                                                                                                      // 595
  var matcher = new Minimongo.Matcher(selector, self);                                                // 596
  var remove = [];                                                                                    // 597
  self._eachPossiblyMatchingDoc(selector, function (doc, id) {                                        // 598
    if (matcher.documentMatches(doc).result)                                                          // 599
      remove.push(id);                                                                                // 600
  });                                                                                                 // 601
                                                                                                      // 602
  var queriesToRecompute = [];                                                                        // 603
  var queryRemove = [];                                                                               // 604
  for (var i = 0; i < remove.length; i++) {                                                           // 605
    var removeId = remove[i];                                                                         // 606
    var removeDoc = self._docs.get(removeId);                                                         // 607
    _.each(self.queries, function (query, qid) {                                                      // 608
      if (query.matcher.documentMatches(removeDoc).result) {                                          // 609
        if (query.cursor.skip || query.cursor.limit)                                                  // 610
          queriesToRecompute.push(qid);                                                               // 611
        else                                                                                          // 612
          queryRemove.push({qid: qid, doc: removeDoc});                                               // 613
      }                                                                                               // 614
    });                                                                                               // 615
    self._saveOriginal(removeId, removeDoc);                                                          // 616
    self._docs.remove(removeId);                                                                      // 617
  }                                                                                                   // 618
                                                                                                      // 619
  // run live query callbacks _after_ we've removed the documents.                                    // 620
  _.each(queryRemove, function (remove) {                                                             // 621
    var query = self.queries[remove.qid];                                                             // 622
    if (query) {                                                                                      // 623
      query.distances && query.distances.remove(remove.doc._id);                                      // 624
      LocalCollection._removeFromResults(query, remove.doc);                                          // 625
    }                                                                                                 // 626
  });                                                                                                 // 627
  _.each(queriesToRecompute, function (qid) {                                                         // 628
    var query = self.queries[qid];                                                                    // 629
    if (query)                                                                                        // 630
      LocalCollection._recomputeResults(query);                                                       // 631
  });                                                                                                 // 632
  self._observeQueue.drain();                                                                         // 633
  result = remove.length;                                                                             // 634
  if (callback)                                                                                       // 635
    Meteor.defer(function () {                                                                        // 636
      callback(null, result);                                                                         // 637
    });                                                                                               // 638
  return result;                                                                                      // 639
};                                                                                                    // 640
                                                                                                      // 641
// XXX atomicity: if multi is true, and one modification fails, do                                    // 642
// we rollback the whole operation, or what?                                                          // 643
LocalCollection.prototype.update = function (selector, mod, options, callback) {                      // 644
  var self = this;                                                                                    // 645
  if (! callback && options instanceof Function) {                                                    // 646
    callback = options;                                                                               // 647
    options = null;                                                                                   // 648
  }                                                                                                   // 649
  if (!options) options = {};                                                                         // 650
                                                                                                      // 651
  var matcher = new Minimongo.Matcher(selector, self);                                                // 652
                                                                                                      // 653
  // Save the original results of any query that we might need to                                     // 654
  // _recomputeResults on, because _modifyAndNotify will mutate the objects in                        // 655
  // it. (We don't need to save the original results of paused queries because                        // 656
  // they already have a resultsSnapshot and we won't be diffing in                                   // 657
  // _recomputeResults.)                                                                              // 658
  var qidToOriginalResults = {};                                                                      // 659
  _.each(self.queries, function (query, qid) {                                                        // 660
    // XXX for now, skip/limit implies ordered observe, so query.results is                           // 661
    // always an array                                                                                // 662
    if ((query.cursor.skip || query.cursor.limit) && !query.paused)                                   // 663
      qidToOriginalResults[qid] = EJSON.clone(query.results);                                         // 664
  });                                                                                                 // 665
  var recomputeQids = {};                                                                             // 666
                                                                                                      // 667
  var updateCount = 0;                                                                                // 668
                                                                                                      // 669
  self._eachPossiblyMatchingDoc(selector, function (doc, id) {                                        // 670
    var queryResult = matcher.documentMatches(doc);                                                   // 671
    if (queryResult.result) {                                                                         // 672
      // XXX Should we save the original even if mod ends up being a no-op?                           // 673
      self._saveOriginal(id, doc);                                                                    // 674
      self._modifyAndNotify(doc, mod, recomputeQids, queryResult.arrayIndex);                         // 675
      ++updateCount;                                                                                  // 676
      if (!options.multi)                                                                             // 677
        return false;  // break                                                                       // 678
    }                                                                                                 // 679
    return true;                                                                                      // 680
  });                                                                                                 // 681
                                                                                                      // 682
  _.each(recomputeQids, function (dummy, qid) {                                                       // 683
    var query = self.queries[qid];                                                                    // 684
    if (query)                                                                                        // 685
      LocalCollection._recomputeResults(query,                                                        // 686
                                        qidToOriginalResults[qid]);                                   // 687
  });                                                                                                 // 688
  self._observeQueue.drain();                                                                         // 689
                                                                                                      // 690
  // If we are doing an upsert, and we didn't modify any documents yet, then                          // 691
  // it's time to do an insert. Figure out what document we are inserting, and                        // 692
  // generate an id for it.                                                                           // 693
  var insertedId;                                                                                     // 694
  if (updateCount === 0 && options.upsert) {                                                          // 695
    var newDoc = LocalCollection._removeDollarOperators(selector);                                    // 696
    LocalCollection._modify(newDoc, mod, {isInsert: true});                                           // 697
    if (! newDoc._id && options.insertedId)                                                           // 698
      newDoc._id = options.insertedId;                                                                // 699
    insertedId = self.insert(newDoc);                                                                 // 700
    updateCount = 1;                                                                                  // 701
  }                                                                                                   // 702
                                                                                                      // 703
  // Return the number of affected documents, or in the upsert case, an object                        // 704
  // containing the number of affected docs and the id of the doc that was                            // 705
  // inserted, if any.                                                                                // 706
  var result;                                                                                         // 707
  if (options._returnObject) {                                                                        // 708
    result = {                                                                                        // 709
      numberAffected: updateCount                                                                     // 710
    };                                                                                                // 711
    if (insertedId !== undefined)                                                                     // 712
      result.insertedId = insertedId;                                                                 // 713
  } else {                                                                                            // 714
    result = updateCount;                                                                             // 715
  }                                                                                                   // 716
                                                                                                      // 717
  if (callback)                                                                                       // 718
    Meteor.defer(function () {                                                                        // 719
      callback(null, result);                                                                         // 720
    });                                                                                               // 721
  return result;                                                                                      // 722
};                                                                                                    // 723
                                                                                                      // 724
// A convenience wrapper on update. LocalCollection.upsert(sel, mod) is                               // 725
// equivalent to LocalCollection.update(sel, mod, { upsert: true, _returnObject:                      // 726
// true }).                                                                                           // 727
LocalCollection.prototype.upsert = function (selector, mod, options, callback) {                      // 728
  var self = this;                                                                                    // 729
  if (! callback && typeof options === "function") {                                                  // 730
    callback = options;                                                                               // 731
    options = {};                                                                                     // 732
  }                                                                                                   // 733
  return self.update(selector, mod, _.extend({}, options, {                                           // 734
    upsert: true,                                                                                     // 735
    _returnObject: true                                                                               // 736
  }), callback);                                                                                      // 737
};                                                                                                    // 738
                                                                                                      // 739
LocalCollection.prototype._modifyAndNotify = function (                                               // 740
    doc, mod, recomputeQids, arrayIndex) {                                                            // 741
  var self = this;                                                                                    // 742
                                                                                                      // 743
  var matched_before = {};                                                                            // 744
  for (var qid in self.queries) {                                                                     // 745
    var query = self.queries[qid];                                                                    // 746
    if (query.ordered) {                                                                              // 747
      matched_before[qid] = query.matcher.documentMatches(doc).result;                                // 748
    } else {                                                                                          // 749
      // Because we don't support skip or limit (yet) in unordered queries, we                        // 750
      // can just do a direct lookup.                                                                 // 751
      matched_before[qid] = query.results.has(doc._id);                                               // 752
    }                                                                                                 // 753
  }                                                                                                   // 754
                                                                                                      // 755
  var old_doc = EJSON.clone(doc);                                                                     // 756
                                                                                                      // 757
  LocalCollection._modify(doc, mod, {arrayIndex: arrayIndex});                                        // 758
                                                                                                      // 759
  for (qid in self.queries) {                                                                         // 760
    query = self.queries[qid];                                                                        // 761
    var before = matched_before[qid];                                                                 // 762
    var afterMatch = query.matcher.documentMatches(doc);                                              // 763
    var after = afterMatch.result;                                                                    // 764
    if (after && query.distances && afterMatch.distance !== undefined)                                // 765
      query.distances.set(doc._id, afterMatch.distance);                                              // 766
                                                                                                      // 767
    if (query.cursor.skip || query.cursor.limit) {                                                    // 768
      // We need to recompute any query where the doc may have been in the                            // 769
      // cursor's window either before or after the update. (Note that if skip                        // 770
      // or limit is set, "before" and "after" being true do not necessarily                          // 771
      // mean that the document is in the cursor's output after skip/limit is                         // 772
      // applied... but if they are false, then the document definitely is NOT                        // 773
      // in the output. So it's safe to skip recompute if neither before or                           // 774
      // after are true.)                                                                             // 775
      if (before || after)                                                                            // 776
        recomputeQids[qid] = true;                                                                    // 777
    } else if (before && !after) {                                                                    // 778
      LocalCollection._removeFromResults(query, doc);                                                 // 779
    } else if (!before && after) {                                                                    // 780
      LocalCollection._insertInResults(query, doc);                                                   // 781
    } else if (before && after) {                                                                     // 782
      LocalCollection._updateInResults(query, doc, old_doc);                                          // 783
    }                                                                                                 // 784
  }                                                                                                   // 785
};                                                                                                    // 786
                                                                                                      // 787
// XXX the sorted-query logic below is laughably inefficient. we'll                                   // 788
// need to come up with a better datastructure for this.                                              // 789
//                                                                                                    // 790
// XXX the logic for observing with a skip or a limit is even more                                    // 791
// laughably inefficient. we recompute the whole results every time!                                  // 792
                                                                                                      // 793
LocalCollection._insertInResults = function (query, doc) {                                            // 794
  var fields = EJSON.clone(doc);                                                                      // 795
  delete fields._id;                                                                                  // 796
  if (query.ordered) {                                                                                // 797
    if (!query.sorter) {                                                                              // 798
      query.addedBefore(doc._id, fields, null);                                                       // 799
      query.results.push(doc);                                                                        // 800
    } else {                                                                                          // 801
      var i = LocalCollection._insertInSortedList(                                                    // 802
        query.sorter.getComparator({distances: query.distances}),                                     // 803
        query.results, doc);                                                                          // 804
      var next = query.results[i+1];                                                                  // 805
      if (next)                                                                                       // 806
        next = next._id;                                                                              // 807
      else                                                                                            // 808
        next = null;                                                                                  // 809
      query.addedBefore(doc._id, fields, next);                                                       // 810
    }                                                                                                 // 811
    query.added(doc._id, fields);                                                                     // 812
  } else {                                                                                            // 813
    query.added(doc._id, fields);                                                                     // 814
    query.results.set(doc._id, doc);                                                                  // 815
  }                                                                                                   // 816
};                                                                                                    // 817
                                                                                                      // 818
LocalCollection._removeFromResults = function (query, doc) {                                          // 819
  if (query.ordered) {                                                                                // 820
    var i = LocalCollection._findInOrderedResults(query, doc);                                        // 821
    query.removed(doc._id);                                                                           // 822
    query.results.splice(i, 1);                                                                       // 823
  } else {                                                                                            // 824
    var id = doc._id;  // in case callback mutates doc                                                // 825
    query.removed(doc._id);                                                                           // 826
    query.results.remove(id);                                                                         // 827
  }                                                                                                   // 828
};                                                                                                    // 829
                                                                                                      // 830
LocalCollection._updateInResults = function (query, doc, old_doc) {                                   // 831
  if (!EJSON.equals(doc._id, old_doc._id))                                                            // 832
    throw new Error("Can't change a doc's _id while updating");                                       // 833
  var changedFields = LocalCollection._makeChangedFields(doc, old_doc);                               // 834
  if (!query.ordered) {                                                                               // 835
    if (!_.isEmpty(changedFields)) {                                                                  // 836
      query.changed(doc._id, changedFields);                                                          // 837
      query.results.set(doc._id, doc);                                                                // 838
    }                                                                                                 // 839
    return;                                                                                           // 840
  }                                                                                                   // 841
                                                                                                      // 842
  var orig_idx = LocalCollection._findInOrderedResults(query, doc);                                   // 843
                                                                                                      // 844
  if (!_.isEmpty(changedFields))                                                                      // 845
    query.changed(doc._id, changedFields);                                                            // 846
  if (!query.sorter)                                                                                  // 847
    return;                                                                                           // 848
                                                                                                      // 849
  // just take it out and put it back in again, and see if the index                                  // 850
  // changes                                                                                          // 851
  query.results.splice(orig_idx, 1);                                                                  // 852
  var new_idx = LocalCollection._insertInSortedList(                                                  // 853
    query.sorter.getComparator({distances: query.distances}),                                         // 854
    query.results, doc);                                                                              // 855
  if (orig_idx !== new_idx) {                                                                         // 856
    var next = query.results[new_idx+1];                                                              // 857
    if (next)                                                                                         // 858
      next = next._id;                                                                                // 859
    else                                                                                              // 860
      next = null;                                                                                    // 861
    query.movedBefore && query.movedBefore(doc._id, next);                                            // 862
  }                                                                                                   // 863
};                                                                                                    // 864
                                                                                                      // 865
// Recomputes the results of a query and runs observe callbacks for the                               // 866
// difference between the previous results and the current results (unless                            // 867
// paused). Used for skip/limit queries.                                                              // 868
//                                                                                                    // 869
// When this is used by insert or remove, it can just use query.results for the                       // 870
// old results (and there's no need to pass in oldResults), because these                             // 871
// operations don't mutate the documents in the collection. Update needs to pass                      // 872
// in an oldResults which was deep-copied before the modifier was applied.                            // 873
LocalCollection._recomputeResults = function (query, oldResults) {                                    // 874
  if (!oldResults)                                                                                    // 875
    oldResults = query.results;                                                                       // 876
  if (query.distances)                                                                                // 877
    query.distances.clear();                                                                          // 878
  query.results = query.cursor._getRawObjects({                                                       // 879
    ordered: query.ordered, distances: query.distances});                                             // 880
                                                                                                      // 881
  if (!query.paused) {                                                                                // 882
    LocalCollection._diffQueryChanges(                                                                // 883
      query.ordered, oldResults, query.results, query);                                               // 884
  }                                                                                                   // 885
};                                                                                                    // 886
                                                                                                      // 887
                                                                                                      // 888
LocalCollection._findInOrderedResults = function (query, doc) {                                       // 889
  if (!query.ordered)                                                                                 // 890
    throw new Error("Can't call _findInOrderedResults on unordered query");                           // 891
  for (var i = 0; i < query.results.length; i++)                                                      // 892
    if (query.results[i] === doc)                                                                     // 893
      return i;                                                                                       // 894
  throw Error("object missing from query");                                                           // 895
};                                                                                                    // 896
                                                                                                      // 897
// This binary search puts a value between any equal values, and the first                            // 898
// lesser value.                                                                                      // 899
LocalCollection._binarySearch = function (cmp, array, value) {                                        // 900
  var first = 0, rangeLength = array.length;                                                          // 901
                                                                                                      // 902
  while (rangeLength > 0) {                                                                           // 903
    var halfRange = Math.floor(rangeLength/2);                                                        // 904
    if (cmp(value, array[first + halfRange]) >= 0) {                                                  // 905
      first += halfRange + 1;                                                                         // 906
      rangeLength -= halfRange + 1;                                                                   // 907
    } else {                                                                                          // 908
      rangeLength = halfRange;                                                                        // 909
    }                                                                                                 // 910
  }                                                                                                   // 911
  return first;                                                                                       // 912
};                                                                                                    // 913
                                                                                                      // 914
LocalCollection._insertInSortedList = function (cmp, array, value) {                                  // 915
  if (array.length === 0) {                                                                           // 916
    array.push(value);                                                                                // 917
    return 0;                                                                                         // 918
  }                                                                                                   // 919
                                                                                                      // 920
  var idx = LocalCollection._binarySearch(cmp, array, value);                                         // 921
  array.splice(idx, 0, value);                                                                        // 922
  return idx;                                                                                         // 923
};                                                                                                    // 924
                                                                                                      // 925
// To track what documents are affected by a piece of code, call saveOriginals()                      // 926
// before it and retrieveOriginals() after it. retrieveOriginals returns an                           // 927
// object whose keys are the ids of the documents that were affected since the                        // 928
// call to saveOriginals(), and the values are equal to the document's contents                       // 929
// at the time of saveOriginals. (In the case of an inserted document, undefined                      // 930
// is the value.) You must alternate between calls to saveOriginals() and                             // 931
// retrieveOriginals().                                                                               // 932
LocalCollection.prototype.saveOriginals = function () {                                               // 933
  var self = this;                                                                                    // 934
  if (self._savedOriginals)                                                                           // 935
    throw new Error("Called saveOriginals twice without retrieveOriginals");                          // 936
  self._savedOriginals = new LocalCollection._IdMap;                                                  // 937
};                                                                                                    // 938
LocalCollection.prototype.retrieveOriginals = function () {                                           // 939
  var self = this;                                                                                    // 940
  if (!self._savedOriginals)                                                                          // 941
    throw new Error("Called retrieveOriginals without saveOriginals");                                // 942
                                                                                                      // 943
  var originals = self._savedOriginals;                                                               // 944
  self._savedOriginals = null;                                                                        // 945
  return originals;                                                                                   // 946
};                                                                                                    // 947
                                                                                                      // 948
LocalCollection.prototype._saveOriginal = function (id, doc) {                                        // 949
  var self = this;                                                                                    // 950
  // Are we even trying to save originals?                                                            // 951
  if (!self._savedOriginals)                                                                          // 952
    return;                                                                                           // 953
  // Have we previously mutated the original (and so 'doc' is not actually                            // 954
  // original)?  (Note the 'has' check rather than truth: we store undefined                          // 955
  // here for inserted docs!)                                                                         // 956
  if (self._savedOriginals.has(id))                                                                   // 957
    return;                                                                                           // 958
  self._savedOriginals.set(id, EJSON.clone(doc));                                                     // 959
};                                                                                                    // 960
                                                                                                      // 961
// Pause the observers. No callbacks from observers will fire until                                   // 962
// 'resumeObservers' is called.                                                                       // 963
LocalCollection.prototype.pauseObservers = function () {                                              // 964
  // No-op if already paused.                                                                         // 965
  if (this.paused)                                                                                    // 966
    return;                                                                                           // 967
                                                                                                      // 968
  // Set the 'paused' flag such that new observer messages don't fire.                                // 969
  this.paused = true;                                                                                 // 970
                                                                                                      // 971
  // Take a snapshot of the query results for each query.                                             // 972
  for (var qid in this.queries) {                                                                     // 973
    var query = this.queries[qid];                                                                    // 974
                                                                                                      // 975
    query.resultsSnapshot = EJSON.clone(query.results);                                               // 976
  }                                                                                                   // 977
};                                                                                                    // 978
                                                                                                      // 979
// Resume the observers. Observers immediately receive change                                         // 980
// notifications to bring them to the current state of the                                            // 981
// database. Note that this is not just replaying all the changes that                                // 982
// happened during the pause, it is a smarter 'coalesced' diff.                                       // 983
LocalCollection.prototype.resumeObservers = function () {                                             // 984
  var self = this;                                                                                    // 985
  // No-op if not paused.                                                                             // 986
  if (!this.paused)                                                                                   // 987
    return;                                                                                           // 988
                                                                                                      // 989
  // Unset the 'paused' flag. Make sure to do this first, otherwise                                   // 990
  // observer methods won't actually fire when we trigger them.                                       // 991
  this.paused = false;                                                                                // 992
                                                                                                      // 993
  for (var qid in this.queries) {                                                                     // 994
    var query = self.queries[qid];                                                                    // 995
    // Diff the current results against the snapshot and send to observers.                           // 996
    // pass the query object for its observer callbacks.                                              // 997
    LocalCollection._diffQueryChanges(                                                                // 998
      query.ordered, query.resultsSnapshot, query.results, query);                                    // 999
    query.resultsSnapshot = null;                                                                     // 1000
  }                                                                                                   // 1001
  self._observeQueue.drain();                                                                         // 1002
};                                                                                                    // 1003
                                                                                                      // 1004
                                                                                                      // 1005
// NB: used by livedata                                                                               // 1006
LocalCollection._idStringify = function (id) {                                                        // 1007
  if (id instanceof LocalCollection._ObjectID) {                                                      // 1008
    return id.valueOf();                                                                              // 1009
  } else if (typeof id === 'string') {                                                                // 1010
    if (id === "") {                                                                                  // 1011
      return id;                                                                                      // 1012
    } else if (id.substr(0, 1) === "-" || // escape previously dashed strings                         // 1013
               id.substr(0, 1) === "~" || // escape escaped numbers, true, false                      // 1014
               LocalCollection._looksLikeObjectID(id) || // escape object-id-form strings             // 1015
               id.substr(0, 1) === '{') { // escape object-form strings, for maybe implementing later // 1016
      return "-" + id;                                                                                // 1017
    } else {                                                                                          // 1018
      return id; // other strings go through unchanged.                                               // 1019
    }                                                                                                 // 1020
  } else if (id === undefined) {                                                                      // 1021
    return '-';                                                                                       // 1022
  } else if (typeof id === 'object' && id !== null) {                                                 // 1023
    throw new Error("Meteor does not currently support objects other than ObjectID as ids");          // 1024
  } else { // Numbers, true, false, null                                                              // 1025
    return "~" + JSON.stringify(id);                                                                  // 1026
  }                                                                                                   // 1027
};                                                                                                    // 1028
                                                                                                      // 1029
                                                                                                      // 1030
// NB: used by livedata                                                                               // 1031
LocalCollection._idParse = function (id) {                                                            // 1032
  if (id === "") {                                                                                    // 1033
    return id;                                                                                        // 1034
  } else if (id === '-') {                                                                            // 1035
    return undefined;                                                                                 // 1036
  } else if (id.substr(0, 1) === '-') {                                                               // 1037
    return id.substr(1);                                                                              // 1038
  } else if (id.substr(0, 1) === '~') {                                                               // 1039
    return JSON.parse(id.substr(1));                                                                  // 1040
  } else if (LocalCollection._looksLikeObjectID(id)) {                                                // 1041
    return new LocalCollection._ObjectID(id);                                                         // 1042
  } else {                                                                                            // 1043
    return id;                                                                                        // 1044
  }                                                                                                   // 1045
};                                                                                                    // 1046
                                                                                                      // 1047
LocalCollection._makeChangedFields = function (newDoc, oldDoc) {                                      // 1048
  var fields = {};                                                                                    // 1049
  LocalCollection._diffObjects(oldDoc, newDoc, {                                                      // 1050
    leftOnly: function (key, value) {                                                                 // 1051
      fields[key] = undefined;                                                                        // 1052
    },                                                                                                // 1053
    rightOnly: function (key, value) {                                                                // 1054
      fields[key] = value;                                                                            // 1055
    },                                                                                                // 1056
    both: function (key, leftValue, rightValue) {                                                     // 1057
      if (!EJSON.equals(leftValue, rightValue))                                                       // 1058
        fields[key] = rightValue;                                                                     // 1059
    }                                                                                                 // 1060
  });                                                                                                 // 1061
  return fields;                                                                                      // 1062
};                                                                                                    // 1063
                                                                                                      // 1064
////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                    //
// packages/minimongo/wrap_transform.js                                                               //
//                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                      //
// Wrap a transform function to return objects that have the _id field                                // 1
// of the untransformed document. This ensures that subsystems such as                                // 2
// the observe-sequence package that call `observe` can keep track of                                 // 3
// the documents identities.                                                                          // 4
//                                                                                                    // 5
// - Require that it returns objects                                                                  // 6
// - If the return value has an _id field, verify that it matches the                                 // 7
//   original _id field                                                                               // 8
// - If the return value doesn't have an _id field, add it back.                                      // 9
LocalCollection.wrapTransform = function (transform) {                                                // 10
  if (!transform)                                                                                     // 11
    return null;                                                                                      // 12
                                                                                                      // 13
  return function (doc) {                                                                             // 14
    if (!_.has(doc, '_id')) {                                                                         // 15
      // XXX do we ever have a transform on the oplog's collection? because that                      // 16
      // collection has no _id.                                                                       // 17
      throw new Error("can only transform documents with _id");                                       // 18
    }                                                                                                 // 19
                                                                                                      // 20
    var id = doc._id;                                                                                 // 21
    // XXX consider making deps a weak dependency and checking Package.deps here                      // 22
    var transformed = Deps.nonreactive(function () {                                                  // 23
      return transform(doc);                                                                          // 24
    });                                                                                               // 25
                                                                                                      // 26
    if (!isPlainObject(transformed)) {                                                                // 27
      throw new Error("transform must return object");                                                // 28
    }                                                                                                 // 29
                                                                                                      // 30
    if (_.has(transformed, '_id')) {                                                                  // 31
      if (!EJSON.equals(transformed._id, id)) {                                                       // 32
        throw new Error("transformed document can't have different _id");                             // 33
      }                                                                                               // 34
    } else {                                                                                          // 35
      transformed._id = id;                                                                           // 36
    }                                                                                                 // 37
    return transformed;                                                                               // 38
  };                                                                                                  // 39
};                                                                                                    // 40
                                                                                                      // 41
                                                                                                      // 42
////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                    //
// packages/minimongo/helpers.js                                                                      //
//                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                      //
// Like _.isArray, but doesn't regard polyfilled Uint8Arrays on old browsers as                       // 1
// arrays.                                                                                            // 2
// XXX maybe this should be EJSON.isArray                                                             // 3
isArray = function (x) {                                                                              // 4
  return _.isArray(x) && !EJSON.isBinary(x);                                                          // 5
};                                                                                                    // 6
                                                                                                      // 7
// XXX maybe this should be EJSON.isObject, though EJSON doesn't know about                           // 8
// RegExp                                                                                             // 9
// XXX note that _type(undefined) === 3!!!!                                                           // 10
isPlainObject = function (x) {                                                                        // 11
  return x && LocalCollection._f._type(x) === 3;                                                      // 12
};                                                                                                    // 13
                                                                                                      // 14
isIndexable = function (x) {                                                                          // 15
  return isArray(x) || isPlainObject(x);                                                              // 16
};                                                                                                    // 17
                                                                                                      // 18
isOperatorObject = function (valueSelector) {                                                         // 19
  if (!isPlainObject(valueSelector))                                                                  // 20
    return false;                                                                                     // 21
                                                                                                      // 22
  var theseAreOperators = undefined;                                                                  // 23
  _.each(valueSelector, function (value, selKey) {                                                    // 24
    var thisIsOperator = selKey.substr(0, 1) === '$';                                                 // 25
    if (theseAreOperators === undefined) {                                                            // 26
      theseAreOperators = thisIsOperator;                                                             // 27
    } else if (theseAreOperators !== thisIsOperator) {                                                // 28
      throw new Error("Inconsistent operator: " + valueSelector);                                     // 29
    }                                                                                                 // 30
  });                                                                                                 // 31
  return !!theseAreOperators;  // {} has no operators                                                 // 32
};                                                                                                    // 33
                                                                                                      // 34
                                                                                                      // 35
// string can be converted to integer                                                                 // 36
isNumericKey = function (s) {                                                                         // 37
  return /^[0-9]+$/.test(s);                                                                          // 38
};                                                                                                    // 39
                                                                                                      // 40
////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                    //
// packages/minimongo/selector.js                                                                     //
//                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                      //
// The minimongo selector compiler!                                                                   // 1
                                                                                                      // 2
// Terminology:                                                                                       // 3
//  - a "selector" is the EJSON object representing a selector                                        // 4
//  - a "matcher" is its compiled form (whether a full Minimongo.Matcher                              // 5
//    object or one of the component lambdas that matches parts of it)                                // 6
//  - a "result object" is an object with a "result" field and maybe                                  // 7
//    distance and arrayIndex.                                                                        // 8
//  - a "branched value" is an object with a "value" field and maybe                                  // 9
//    "dontIterate" and "arrayIndex".                                                                 // 10
//  - a "document" is a top-level object that can be stored in a collection.                          // 11
//  - a "lookup function" is a function that takes in a document and returns                          // 12
//    an array of "branched values".                                                                  // 13
//  - a "branched matcher" maps from an array of branched values to a result                          // 14
//    object.                                                                                         // 15
//  - an "element matcher" maps from a single value to a bool.                                        // 16
                                                                                                      // 17
// Main entry point.                                                                                  // 18
//   var matcher = new Minimongo.Matcher({a: {$gt: 5}});                                              // 19
//   if (matcher.documentMatches({a: 7})) ...                                                         // 20
Minimongo.Matcher = function (selector) {                                                             // 21
  var self = this;                                                                                    // 22
  // A set (object mapping string -> *) of all of the document paths looked                           // 23
  // at by the selector. Also includes the empty string if it may look at any                         // 24
  // path (eg, $where).                                                                               // 25
  self._paths = {};                                                                                   // 26
  // Set to true if compilation finds a $near.                                                        // 27
  self._hasGeoQuery = false;                                                                          // 28
  // Set to true if compilation finds a $where.                                                       // 29
  self._hasWhere = false;                                                                             // 30
  // Set to false if compilation finds anything other than a simple equality or                       // 31
  // one or more of '$gt', '$gte', '$lt', '$lte', '$ne', '$in', '$nin' used with                      // 32
  // scalars as operands.                                                                             // 33
  self._isSimple = true;                                                                              // 34
  // Set to a dummy document which always matches this Matcher. Or set to null                        // 35
  // if such document is too hard to find.                                                            // 36
  self._matchingDocument = undefined;                                                                 // 37
  // A clone of the original selector. Used by canBecomeTrueByModifier.                               // 38
  self._selector = null;                                                                              // 39
  self._docMatcher = self._compileSelector(selector);                                                 // 40
};                                                                                                    // 41
                                                                                                      // 42
_.extend(Minimongo.Matcher.prototype, {                                                               // 43
  documentMatches: function (doc) {                                                                   // 44
    return this._docMatcher(doc);                                                                     // 45
  },                                                                                                  // 46
  hasGeoQuery: function () {                                                                          // 47
    return this._hasGeoQuery;                                                                         // 48
  },                                                                                                  // 49
  hasWhere: function () {                                                                             // 50
    return this._hasWhere;                                                                            // 51
  },                                                                                                  // 52
  isSimple: function () {                                                                             // 53
    return this._isSimple;                                                                            // 54
  },                                                                                                  // 55
                                                                                                      // 56
  // Given a selector, return a function that takes one argument, a                                   // 57
  // document. It returns a result object.                                                            // 58
  _compileSelector: function (selector) {                                                             // 59
    var self = this;                                                                                  // 60
    // you can pass a literal function instead of a selector                                          // 61
    if (selector instanceof Function) {                                                               // 62
      self._isSimple = false;                                                                         // 63
      self._selector = selector;                                                                      // 64
      self._recordPathUsed('');                                                                       // 65
      return function (doc) {                                                                         // 66
        return {result: !!selector.call(doc)};                                                        // 67
      };                                                                                              // 68
    }                                                                                                 // 69
                                                                                                      // 70
    // shorthand -- scalars match _id                                                                 // 71
    if (LocalCollection._selectorIsId(selector)) {                                                    // 72
      self._selector = {_id: selector};                                                               // 73
      self._recordPathUsed('_id');                                                                    // 74
      return function (doc) {                                                                         // 75
        return {result: EJSON.equals(doc._id, selector)};                                             // 76
      };                                                                                              // 77
    }                                                                                                 // 78
                                                                                                      // 79
    // protect against dangerous selectors.  falsey and {_id: falsey} are both                        // 80
    // likely programmer error, and not what you want, particularly for                               // 81
    // destructive operations.                                                                        // 82
    if (!selector || (('_id' in selector) && !selector._id)) {                                        // 83
      self._isSimple = false;                                                                         // 84
      return nothingMatcher;                                                                          // 85
    }                                                                                                 // 86
                                                                                                      // 87
    // Top level can't be an array or true or binary.                                                 // 88
    if (typeof(selector) === 'boolean' || isArray(selector) ||                                        // 89
        EJSON.isBinary(selector))                                                                     // 90
      throw new Error("Invalid selector: " + selector);                                               // 91
                                                                                                      // 92
    self._selector = EJSON.clone(selector);                                                           // 93
    return compileDocumentSelector(selector, self, {isRoot: true});                                   // 94
  },                                                                                                  // 95
  _recordPathUsed: function (path) {                                                                  // 96
    this._paths[path] = true;                                                                         // 97
  },                                                                                                  // 98
  // Returns a list of key paths the given selector is looking for. It includes                       // 99
  // the empty string if there is a $where.                                                           // 100
  _getPaths: function () {                                                                            // 101
    return _.keys(this._paths);                                                                       // 102
  }                                                                                                   // 103
});                                                                                                   // 104
                                                                                                      // 105
                                                                                                      // 106
// Takes in a selector that could match a full document (eg, the original                             // 107
// selector). Returns a function mapping document->result object.                                     // 108
//                                                                                                    // 109
// matcher is the Matcher object we are compiling.                                                    // 110
//                                                                                                    // 111
// If this is the root document selector (ie, not wrapped in $and or the like),                       // 112
// then isRoot is true. (This is used by $near.)                                                      // 113
var compileDocumentSelector = function (docSelector, matcher, options) {                              // 114
  options = options || {};                                                                            // 115
  var docMatchers = [];                                                                               // 116
  _.each(docSelector, function (subSelector, key) {                                                   // 117
    if (key.substr(0, 1) === '$') {                                                                   // 118
      // Outer operators are either logical operators (they recurse back into                         // 119
      // this function), or $where.                                                                   // 120
      if (!_.has(LOGICAL_OPERATORS, key))                                                             // 121
        throw new Error("Unrecognized logical operator: " + key);                                     // 122
      matcher._isSimple = false;                                                                      // 123
      docMatchers.push(LOGICAL_OPERATORS[key](subSelector, matcher,                                   // 124
                                              options.inElemMatch));                                  // 125
    } else {                                                                                          // 126
      // Record this path, but only if we aren't in an elemMatcher, since in an                       // 127
      // elemMatch this is a path inside an object in an array, not in the doc                        // 128
      // root.                                                                                        // 129
      if (!options.inElemMatch)                                                                       // 130
        matcher._recordPathUsed(key);                                                                 // 131
      var lookUpByIndex = makeLookupFunction(key);                                                    // 132
      var valueMatcher =                                                                              // 133
        compileValueSelector(subSelector, matcher, options.isRoot);                                   // 134
      docMatchers.push(function (doc) {                                                               // 135
        var branchValues = lookUpByIndex(doc);                                                        // 136
        return valueMatcher(branchValues);                                                            // 137
      });                                                                                             // 138
    }                                                                                                 // 139
  });                                                                                                 // 140
                                                                                                      // 141
  return andDocumentMatchers(docMatchers);                                                            // 142
};                                                                                                    // 143
                                                                                                      // 144
// Takes in a selector that could match a key-indexed value in a document; eg,                        // 145
// {$gt: 5, $lt: 9}, or a regular expression, or any non-expression object (to                        // 146
// indicate equality).  Returns a branched matcher: a function mapping                                // 147
// [branched value]->result object.                                                                   // 148
var compileValueSelector = function (valueSelector, matcher, isRoot) {                                // 149
  if (valueSelector instanceof RegExp) {                                                              // 150
    matcher._isSimple = false;                                                                        // 151
    return convertElementMatcherToBranchedMatcher(                                                    // 152
      regexpElementMatcher(valueSelector));                                                           // 153
  } else if (isOperatorObject(valueSelector)) {                                                       // 154
    return operatorBranchedMatcher(valueSelector, matcher, isRoot);                                   // 155
  } else {                                                                                            // 156
    return convertElementMatcherToBranchedMatcher(                                                    // 157
      equalityElementMatcher(valueSelector));                                                         // 158
  }                                                                                                   // 159
};                                                                                                    // 160
                                                                                                      // 161
// Given an element matcher (which evaluates a single value), returns a branched                      // 162
// value (which evaluates the element matcher on all the branches and returns a                       // 163
// more structured return value possibly including arrayIndex).                                       // 164
var convertElementMatcherToBranchedMatcher = function (                                               // 165
    elementMatcher, options) {                                                                        // 166
  options = options || {};                                                                            // 167
  return function (branches) {                                                                        // 168
    var expanded = branches;                                                                          // 169
    if (!options.dontExpandLeafArrays) {                                                              // 170
      expanded = expandArraysInBranches(                                                              // 171
        branches, options.dontIncludeLeafArrays);                                                     // 172
    }                                                                                                 // 173
    var ret = {};                                                                                     // 174
    ret.result = _.any(expanded, function (element) {                                                 // 175
      var matched = elementMatcher(element.value);                                                    // 176
                                                                                                      // 177
      // Special case for $elemMatch: it means "true, and use this arrayIndex if                      // 178
      // I didn't already have one".                                                                  // 179
      if (typeof matched === 'number') {                                                              // 180
        if (element.arrayIndex === undefined)                                                         // 181
          element.arrayIndex = matched;                                                               // 182
        matched = true;                                                                               // 183
      }                                                                                               // 184
                                                                                                      // 185
      // If some element matched, and it's tagged with an array index, include                        // 186
      // that index in our result object.                                                             // 187
      if (matched && element.arrayIndex !== undefined)                                                // 188
        ret.arrayIndex = element.arrayIndex;                                                          // 189
                                                                                                      // 190
      return matched;                                                                                 // 191
    });                                                                                               // 192
    return ret;                                                                                       // 193
  };                                                                                                  // 194
};                                                                                                    // 195
                                                                                                      // 196
// Takes a RegExp object and returns an element matcher.                                              // 197
var regexpElementMatcher = function (regexp) {                                                        // 198
  return function (value) {                                                                           // 199
    if (value instanceof RegExp) {                                                                    // 200
      // Comparing two regexps means seeing if the regexps are identical                              // 201
      // (really!). Underscore knows how.                                                             // 202
      return _.isEqual(value, regexp);                                                                // 203
    }                                                                                                 // 204
    // Regexps only work against strings.                                                             // 205
    if (typeof value !== 'string')                                                                    // 206
      return false;                                                                                   // 207
    return regexp.test(value);                                                                        // 208
  };                                                                                                  // 209
};                                                                                                    // 210
                                                                                                      // 211
// Takes something that is not an operator object and returns an element matcher                      // 212
// for equality with that thing.                                                                      // 213
var equalityElementMatcher = function (elementSelector) {                                             // 214
  if (isOperatorObject(elementSelector))                                                              // 215
    throw Error("Can't create equalityValueSelector for operator object");                            // 216
                                                                                                      // 217
  // Special-case: null and undefined are equal (if you got undefined in there                        // 218
  // somewhere, or if you got it due to some branch being non-existent in the                         // 219
  // weird special case), even though they aren't with EJSON.equals.                                  // 220
  if (elementSelector == null) {  // undefined or null                                                // 221
    return function (value) {                                                                         // 222
      return value == null;  // undefined or null                                                     // 223
    };                                                                                                // 224
  }                                                                                                   // 225
                                                                                                      // 226
  return function (value) {                                                                           // 227
    return LocalCollection._f._equal(elementSelector, value);                                         // 228
  };                                                                                                  // 229
};                                                                                                    // 230
                                                                                                      // 231
// Takes an operator object (an object with $ keys) and returns a branched                            // 232
// matcher for it.                                                                                    // 233
var operatorBranchedMatcher = function (valueSelector, matcher, isRoot) {                             // 234
  // Each valueSelector works separately on the various branches.  So one                             // 235
  // operator can match one branch and another can match another branch.  This                        // 236
  // is OK.                                                                                           // 237
                                                                                                      // 238
  var operatorMatchers = [];                                                                          // 239
  _.each(valueSelector, function (operand, operator) {                                                // 240
    // XXX we should actually implement $eq, which is new in 2.6                                      // 241
    var simpleRange = _.contains(['$lt', '$lte', '$gt', '$gte'], operator) &&                         // 242
      _.isNumber(operand);                                                                            // 243
    var simpleInequality = operator === '$ne' && !_.isObject(operand);                                // 244
    var simpleInclusion = _.contains(['$in', '$nin'], operator) &&                                    // 245
      _.isArray(operand) && !_.any(operand, _.isObject);                                              // 246
                                                                                                      // 247
    if (! (operator === '$eq' || simpleRange ||                                                       // 248
           simpleInclusion || simpleInequality)) {                                                    // 249
      matcher._isSimple = false;                                                                      // 250
    }                                                                                                 // 251
                                                                                                      // 252
    if (_.has(VALUE_OPERATORS, operator)) {                                                           // 253
      operatorMatchers.push(                                                                          // 254
        VALUE_OPERATORS[operator](operand, valueSelector, matcher, isRoot));                          // 255
    } else if (_.has(ELEMENT_OPERATORS, operator)) {                                                  // 256
      var options = ELEMENT_OPERATORS[operator];                                                      // 257
      if (typeof options === 'function')                                                              // 258
        options = {compileElementSelector: options};                                                  // 259
      operatorMatchers.push(                                                                          // 260
        convertElementMatcherToBranchedMatcher(                                                       // 261
          options.compileElementSelector(                                                             // 262
            operand, valueSelector, matcher),                                                         // 263
          options));                                                                                  // 264
    } else {                                                                                          // 265
      throw new Error("Unrecognized operator: " + operator);                                          // 266
    }                                                                                                 // 267
  });                                                                                                 // 268
                                                                                                      // 269
  return andBranchedMatchers(operatorMatchers);                                                       // 270
};                                                                                                    // 271
                                                                                                      // 272
var compileArrayOfDocumentSelectors = function (                                                      // 273
    selectors, matcher, inElemMatch) {                                                                // 274
  if (!isArray(selectors) || _.isEmpty(selectors))                                                    // 275
    throw Error("$and/$or/$nor must be nonempty array");                                              // 276
  return _.map(selectors, function (subSelector) {                                                    // 277
    if (!isPlainObject(subSelector))                                                                  // 278
      throw Error("$or/$and/$nor entries need to be full objects");                                   // 279
    return compileDocumentSelector(                                                                   // 280
      subSelector, matcher, {inElemMatch: inElemMatch});                                              // 281
  });                                                                                                 // 282
};                                                                                                    // 283
                                                                                                      // 284
// Operators that appear at the top level of a document selector.                                     // 285
var LOGICAL_OPERATORS = {                                                                             // 286
  $and: function (subSelector, matcher, inElemMatch) {                                                // 287
    var matchers = compileArrayOfDocumentSelectors(                                                   // 288
      subSelector, matcher, inElemMatch);                                                             // 289
    return andDocumentMatchers(matchers);                                                             // 290
  },                                                                                                  // 291
                                                                                                      // 292
  $or: function (subSelector, matcher, inElemMatch) {                                                 // 293
    var matchers = compileArrayOfDocumentSelectors(                                                   // 294
      subSelector, matcher, inElemMatch);                                                             // 295
                                                                                                      // 296
    // Special case: if there is only one matcher, use it directly, *preserving*                      // 297
    // any arrayIndex it returns.                                                                     // 298
    if (matchers.length === 1)                                                                        // 299
      return matchers[0];                                                                             // 300
                                                                                                      // 301
    return function (doc) {                                                                           // 302
      var result = _.any(matchers, function (f) {                                                     // 303
        return f(doc).result;                                                                         // 304
      });                                                                                             // 305
      // $or does NOT set arrayIndex when it has multiple                                             // 306
      // sub-expressions. (Tested against MongoDB.)                                                   // 307
      return {result: result};                                                                        // 308
    };                                                                                                // 309
  },                                                                                                  // 310
                                                                                                      // 311
  $nor: function (subSelector, matcher, inElemMatch) {                                                // 312
    var matchers = compileArrayOfDocumentSelectors(                                                   // 313
      subSelector, matcher, inElemMatch);                                                             // 314
    return function (doc) {                                                                           // 315
      var result = _.all(matchers, function (f) {                                                     // 316
        return !f(doc).result;                                                                        // 317
      });                                                                                             // 318
      // Never set arrayIndex, because we only match if nothing in particular                         // 319
      // "matched" (and because this is consistent with MongoDB).                                     // 320
      return {result: result};                                                                        // 321
    };                                                                                                // 322
  },                                                                                                  // 323
                                                                                                      // 324
  $where: function (selectorValue, matcher) {                                                         // 325
    // Record that *any* path may be used.                                                            // 326
    matcher._recordPathUsed('');                                                                      // 327
    matcher._hasWhere = true;                                                                         // 328
    if (!(selectorValue instanceof Function)) {                                                       // 329
      // XXX MongoDB seems to have more complex logic to decide where or or not                       // 330
      // to add "return"; not sure exactly what it is.                                                // 331
      selectorValue = Function("obj", "return " + selectorValue);                                     // 332
    }                                                                                                 // 333
    return function (doc) {                                                                           // 334
      // We make the document available as both `this` and `obj`.                                     // 335
      // XXX not sure what we should do if this throws                                                // 336
      return {result: selectorValue.call(doc, doc)};                                                  // 337
    };                                                                                                // 338
  },                                                                                                  // 339
                                                                                                      // 340
  // This is just used as a comment in the query (in MongoDB, it also ends up in                      // 341
  // query logs); it has no effect on the actual selection.                                           // 342
  $comment: function () {                                                                             // 343
    return function () {                                                                              // 344
      return {result: true};                                                                          // 345
    };                                                                                                // 346
  }                                                                                                   // 347
};                                                                                                    // 348
                                                                                                      // 349
// Returns a branched matcher that matches iff the given matcher does not.                            // 350
// Note that this implicitly "deMorganizes" the wrapped function.  ie, it                             // 351
// means that ALL branch values need to fail to match innerBranchedMatcher.                           // 352
var invertBranchedMatcher = function (branchedMatcher) {                                              // 353
  return function (branchValues) {                                                                    // 354
    var invertMe = branchedMatcher(branchValues);                                                     // 355
    // We explicitly choose to strip arrayIndex here: it doesn't make sense to                        // 356
    // say "update the array element that does not match something", at least                         // 357
    // in mongo-land.                                                                                 // 358
    return {result: !invertMe.result};                                                                // 359
  };                                                                                                  // 360
};                                                                                                    // 361
                                                                                                      // 362
// Operators that (unlike LOGICAL_OPERATORS) pertain to individual paths in a                         // 363
// document, but (unlike ELEMENT_OPERATORS) do not have a simple definition as                        // 364
// "match each branched value independently and combine with                                          // 365
// convertElementMatcherToBranchedMatcher".                                                           // 366
var VALUE_OPERATORS = {                                                                               // 367
  $not: function (operand, valueSelector, matcher) {                                                  // 368
    return invertBranchedMatcher(compileValueSelector(operand, matcher));                             // 369
  },                                                                                                  // 370
  $ne: function (operand) {                                                                           // 371
    return invertBranchedMatcher(convertElementMatcherToBranchedMatcher(                              // 372
      equalityElementMatcher(operand)));                                                              // 373
  },                                                                                                  // 374
  $nin: function (operand) {                                                                          // 375
    return invertBranchedMatcher(convertElementMatcherToBranchedMatcher(                              // 376
      ELEMENT_OPERATORS.$in(operand)));                                                               // 377
  },                                                                                                  // 378
  $exists: function (operand) {                                                                       // 379
    var exists = convertElementMatcherToBranchedMatcher(function (value) {                            // 380
      return value !== undefined;                                                                     // 381
    });                                                                                               // 382
    return operand ? exists : invertBranchedMatcher(exists);                                          // 383
  },                                                                                                  // 384
  // $options just provides options for $regex; its logic is inside $regex                            // 385
  $options: function (operand, valueSelector) {                                                       // 386
    if (!valueSelector.$regex)                                                                        // 387
      throw Error("$options needs a $regex");                                                         // 388
    return everythingMatcher;                                                                         // 389
  },                                                                                                  // 390
  // $maxDistance is basically an argument to $near                                                   // 391
  $maxDistance: function (operand, valueSelector) {                                                   // 392
    if (!valueSelector.$near)                                                                         // 393
      throw Error("$maxDistance needs a $near");                                                      // 394
    return everythingMatcher;                                                                         // 395
  },                                                                                                  // 396
  $all: function (operand, valueSelector, matcher) {                                                  // 397
    if (!isArray(operand))                                                                            // 398
      throw Error("$all requires array");                                                             // 399
    // Not sure why, but this seems to be what MongoDB does.                                          // 400
    if (_.isEmpty(operand))                                                                           // 401
      return nothingMatcher;                                                                          // 402
                                                                                                      // 403
    var branchedMatchers = [];                                                                        // 404
    _.each(operand, function (criterion) {                                                            // 405
      // XXX handle $all/$elemMatch combination                                                       // 406
      if (isOperatorObject(criterion))                                                                // 407
        throw Error("no $ expressions in $all");                                                      // 408
      // This is always a regexp or equality selector.                                                // 409
      branchedMatchers.push(compileValueSelector(criterion, matcher));                                // 410
    });                                                                                               // 411
    // andBranchedMatchers does NOT require all selectors to return true on the                       // 412
    // SAME branch.                                                                                   // 413
    return andBranchedMatchers(branchedMatchers);                                                     // 414
  },                                                                                                  // 415
  $near: function (operand, valueSelector, matcher, isRoot) {                                         // 416
    if (!isRoot)                                                                                      // 417
      throw Error("$near can't be inside another $ operator");                                        // 418
    matcher._hasGeoQuery = true;                                                                      // 419
                                                                                                      // 420
    // There are two kinds of geodata in MongoDB: coordinate pairs and                                // 421
    // GeoJSON. They use different distance metrics, too. GeoJSON queries are                         // 422
    // marked with a $geometry property.                                                              // 423
                                                                                                      // 424
    var maxDistance, point, distance;                                                                 // 425
    if (isPlainObject(operand) && _.has(operand, '$geometry')) {                                      // 426
      // GeoJSON "2dsphere" mode.                                                                     // 427
      maxDistance = operand.$maxDistance;                                                             // 428
      point = operand.$geometry;                                                                      // 429
      distance = function (value) {                                                                   // 430
        // XXX: for now, we don't calculate the actual distance between, say,                         // 431
        // polygon and circle. If people care about this use-case it will get                         // 432
        // a priority.                                                                                // 433
        if (!value || !value.type)                                                                    // 434
          return null;                                                                                // 435
        if (value.type === "Point") {                                                                 // 436
          return GeoJSON.pointDistance(point, value);                                                 // 437
        } else {                                                                                      // 438
          return GeoJSON.geometryWithinRadius(value, point, maxDistance)                              // 439
            ? 0 : maxDistance + 1;                                                                    // 440
        }                                                                                             // 441
      };                                                                                              // 442
    } else {                                                                                          // 443
      maxDistance = valueSelector.$maxDistance;                                                       // 444
      if (!isArray(operand) && !isPlainObject(operand))                                               // 445
        throw Error("$near argument must be coordinate pair or GeoJSON");                             // 446
      point = pointToArray(operand);                                                                  // 447
      distance = function (value) {                                                                   // 448
        if (!isArray(value) && !isPlainObject(value))                                                 // 449
          return null;                                                                                // 450
        return distanceCoordinatePairs(point, value);                                                 // 451
      };                                                                                              // 452
    }                                                                                                 // 453
                                                                                                      // 454
    return function (branchedValues) {                                                                // 455
      // There might be multiple points in the document that match the given                          // 456
      // field. Only one of them needs to be within $maxDistance, but we need to                      // 457
      // evaluate all of them and use the nearest one for the implicit sort                           // 458
      // specifier. (That's why we can't just use ELEMENT_OPERATORS here.)                            // 459
      //                                                                                              // 460
      // Note: This differs from MongoDB's implementation, where a document will                      // 461
      // actually show up *multiple times* in the result set, with one entry for                      // 462
      // each within-$maxDistance branching point.                                                    // 463
      branchedValues = expandArraysInBranches(branchedValues);                                        // 464
      var result = {result: false};                                                                   // 465
      _.each(branchedValues, function (branch) {                                                      // 466
        var curDistance = distance(branch.value);                                                     // 467
        // Skip branches that aren't real points or are too far away.                                 // 468
        if (curDistance === null || curDistance > maxDistance)                                        // 469
          return;                                                                                     // 470
        // Skip anything that's a tie.                                                                // 471
        if (result.distance !== undefined && result.distance <= curDistance)                          // 472
          return;                                                                                     // 473
        result.result = true;                                                                         // 474
        result.distance = curDistance;                                                                // 475
        if (branch.arrayIndex === undefined)                                                          // 476
          delete result.arrayIndex;                                                                   // 477
        else                                                                                          // 478
          result.arrayIndex = branch.arrayIndex;                                                      // 479
      });                                                                                             // 480
      return result;                                                                                  // 481
    };                                                                                                // 482
  }                                                                                                   // 483
};                                                                                                    // 484
                                                                                                      // 485
// Helpers for $near.                                                                                 // 486
var distanceCoordinatePairs = function (a, b) {                                                       // 487
  a = pointToArray(a);                                                                                // 488
  b = pointToArray(b);                                                                                // 489
  var x = a[0] - b[0];                                                                                // 490
  var y = a[1] - b[1];                                                                                // 491
  if (_.isNaN(x) || _.isNaN(y))                                                                       // 492
    return null;                                                                                      // 493
  return Math.sqrt(x * x + y * y);                                                                    // 494
};                                                                                                    // 495
// Makes sure we get 2 elements array and assume the first one to be x and                            // 496
// the second one to y no matter what user passes.                                                    // 497
// In case user passes { lon: x, lat: y } returns [x, y]                                              // 498
var pointToArray = function (point) {                                                                 // 499
  return _.map(point, _.identity);                                                                    // 500
};                                                                                                    // 501
                                                                                                      // 502
// Helper for $lt/$gt/$lte/$gte.                                                                      // 503
var makeInequality = function (cmpValueComparator) {                                                  // 504
  return function (operand) {                                                                         // 505
    // Arrays never compare false with non-arrays for any inequality.                                 // 506
    if (isArray(operand)) {                                                                           // 507
      return function () {                                                                            // 508
        return false;                                                                                 // 509
      };                                                                                              // 510
    }                                                                                                 // 511
                                                                                                      // 512
    // Special case: consider undefined and null the same (so true with                               // 513
    // $gte/$lte).                                                                                    // 514
    if (operand === undefined)                                                                        // 515
      operand = null;                                                                                 // 516
                                                                                                      // 517
    var operandType = LocalCollection._f._type(operand);                                              // 518
                                                                                                      // 519
    return function (value) {                                                                         // 520
      if (value === undefined)                                                                        // 521
        value = null;                                                                                 // 522
      // Comparisons are never true among things of different type (except null                       // 523
      // vs undefined).                                                                               // 524
      if (LocalCollection._f._type(value) !== operandType)                                            // 525
        return false;                                                                                 // 526
      return cmpValueComparator(LocalCollection._f._cmp(value, operand));                             // 527
    };                                                                                                // 528
  };                                                                                                  // 529
};                                                                                                    // 530
                                                                                                      // 531
// Each element selector is a function with args:                                                     // 532
//  - operand - the "right hand side" of the operator                                                 // 533
//  - valueSelector - the "context" for the operator (so that $regex can find                         // 534
//    $options)                                                                                       // 535
// Or is an object with an compileElementSelector field (the above) and optional                      // 536
// flags dontExpandLeafArrays and dontIncludeLeafArrays which control if                              // 537
// expandArraysInBranches is called and if it takes an optional argument.                             // 538
//                                                                                                    // 539
// An element selector compiler returns a function mapping a single value to                          // 540
// bool.                                                                                              // 541
var ELEMENT_OPERATORS = {                                                                             // 542
  $lt: makeInequality(function (cmpValue) {                                                           // 543
    return cmpValue < 0;                                                                              // 544
  }),                                                                                                 // 545
  $gt: makeInequality(function (cmpValue) {                                                           // 546
    return cmpValue > 0;                                                                              // 547
  }),                                                                                                 // 548
  $lte: makeInequality(function (cmpValue) {                                                          // 549
    return cmpValue <= 0;                                                                             // 550
  }),                                                                                                 // 551
  $gte: makeInequality(function (cmpValue) {                                                          // 552
    return cmpValue >= 0;                                                                             // 553
  }),                                                                                                 // 554
  $mod: function (operand) {                                                                          // 555
    if (!(isArray(operand) && operand.length === 2                                                    // 556
          && typeof(operand[0]) === 'number'                                                          // 557
          && typeof(operand[1]) === 'number')) {                                                      // 558
      throw Error("argument to $mod must be an array of two numbers");                                // 559
    }                                                                                                 // 560
    // XXX could require to be ints or round or something                                             // 561
    var divisor = operand[0];                                                                         // 562
    var remainder = operand[1];                                                                       // 563
    return function (value) {                                                                         // 564
      return typeof value === 'number' && value % divisor === remainder;                              // 565
    };                                                                                                // 566
  },                                                                                                  // 567
  $in: function (operand) {                                                                           // 568
    if (!isArray(operand))                                                                            // 569
      throw Error("$in needs an array");                                                              // 570
                                                                                                      // 571
    var elementMatchers = [];                                                                         // 572
    _.each(operand, function (option) {                                                               // 573
      if (option instanceof RegExp)                                                                   // 574
        elementMatchers.push(regexpElementMatcher(option));                                           // 575
      else if (isOperatorObject(option))                                                              // 576
        throw Error("cannot nest $ under $in");                                                       // 577
      else                                                                                            // 578
        elementMatchers.push(equalityElementMatcher(option));                                         // 579
    });                                                                                               // 580
                                                                                                      // 581
    return function (value) {                                                                         // 582
      // Allow {a: {$in: [null]}} to match when 'a' does not exist.                                   // 583
      if (value === undefined)                                                                        // 584
        value = null;                                                                                 // 585
      return _.any(elementMatchers, function (e) {                                                    // 586
        return e(value);                                                                              // 587
      });                                                                                             // 588
    };                                                                                                // 589
  },                                                                                                  // 590
  $size: {                                                                                            // 591
    // {a: [[5, 5]]} must match {a: {$size: 1}} but not {a: {$size: 2}}, so we                        // 592
    // don't want to consider the element [5,5] in the leaf array [[5,5]] as a                        // 593
    // possible value.                                                                                // 594
    dontExpandLeafArrays: true,                                                                       // 595
    compileElementSelector: function (operand) {                                                      // 596
      if (typeof operand === 'string') {                                                              // 597
        // Don't ask me why, but by experimentation, this seems to be what Mongo                      // 598
        // does.                                                                                      // 599
        operand = 0;                                                                                  // 600
      } else if (typeof operand !== 'number') {                                                       // 601
        throw Error("$size needs a number");                                                          // 602
      }                                                                                               // 603
      return function (value) {                                                                       // 604
        return isArray(value) && value.length === operand;                                            // 605
      };                                                                                              // 606
    }                                                                                                 // 607
  },                                                                                                  // 608
  $type: {                                                                                            // 609
    // {a: [5]} must not match {a: {$type: 4}} (4 means array), but it should                         // 610
    // match {a: {$type: 1}} (1 means number), and {a: [[5]]} must match {$a:                         // 611
    // {$type: 4}}. Thus, when we see a leaf array, we *should* expand it but                         // 612
    // should *not* include it itself.                                                                // 613
    dontIncludeLeafArrays: true,                                                                      // 614
    compileElementSelector: function (operand) {                                                      // 615
      if (typeof operand !== 'number')                                                                // 616
        throw Error("$type needs a number");                                                          // 617
      return function (value) {                                                                       // 618
        return value !== undefined                                                                    // 619
          && LocalCollection._f._type(value) === operand;                                             // 620
      };                                                                                              // 621
    }                                                                                                 // 622
  },                                                                                                  // 623
  $regex: function (operand, valueSelector) {                                                         // 624
    if (!(typeof operand === 'string' || operand instanceof RegExp))                                  // 625
      throw Error("$regex has to be a string or RegExp");                                             // 626
                                                                                                      // 627
    var regexp;                                                                                       // 628
    if (valueSelector.$options !== undefined) {                                                       // 629
      // Options passed in $options (even the empty string) always overrides                          // 630
      // options in the RegExp object itself. (See also                                               // 631
      // Meteor.Collection._rewriteSelector.)                                                         // 632
                                                                                                      // 633
      // Be clear that we only support the JS-supported options, not extended                         // 634
      // ones (eg, Mongo supports x and s). Ideally we would implement x and s                        // 635
      // by transforming the regexp, but not today...                                                 // 636
      if (/[^gim]/.test(valueSelector.$options))                                                      // 637
        throw new Error("Only the i, m, and g regexp options are supported");                         // 638
                                                                                                      // 639
      var regexSource = operand instanceof RegExp ? operand.source : operand;                         // 640
      regexp = new RegExp(regexSource, valueSelector.$options);                                       // 641
    } else if (operand instanceof RegExp) {                                                           // 642
      regexp = operand;                                                                               // 643
    } else {                                                                                          // 644
      regexp = new RegExp(operand);                                                                   // 645
    }                                                                                                 // 646
    return regexpElementMatcher(regexp);                                                              // 647
  },                                                                                                  // 648
  $elemMatch: {                                                                                       // 649
    dontExpandLeafArrays: true,                                                                       // 650
    compileElementSelector: function (operand, valueSelector, matcher) {                              // 651
      if (!isPlainObject(operand))                                                                    // 652
        throw Error("$elemMatch need an object");                                                     // 653
                                                                                                      // 654
      var subMatcher, isDocMatcher;                                                                   // 655
      if (isOperatorObject(operand)) {                                                                // 656
        subMatcher = compileValueSelector(operand, matcher);                                          // 657
        isDocMatcher = false;                                                                         // 658
      } else {                                                                                        // 659
        // This is NOT the same as compileValueSelector(operand), and not just                        // 660
        // because of the slightly different calling convention.                                      // 661
        // {$elemMatch: {x: 3}} means "an element has a field x:3", not                               // 662
        // "consists only of a field x:3". Also, regexps and sub-$ are allowed.                       // 663
        subMatcher = compileDocumentSelector(operand, matcher,                                        // 664
                                             {inElemMatch: true});                                    // 665
        isDocMatcher = true;                                                                          // 666
      }                                                                                               // 667
                                                                                                      // 668
      return function (value) {                                                                       // 669
        if (!isArray(value))                                                                          // 670
          return false;                                                                               // 671
        for (var i = 0; i < value.length; ++i) {                                                      // 672
          var arrayElement = value[i];                                                                // 673
          var arg;                                                                                    // 674
          if (isDocMatcher) {                                                                         // 675
            // We can only match {$elemMatch: {b: 3}} against objects.                                // 676
            // (We can also match against arrays, if there's numeric indices,                         // 677
            // eg {$elemMatch: {'0.b': 3}} or {$elemMatch: {0: 3}}.)                                  // 678
            if (!isPlainObject(arrayElement) && !isArray(arrayElement))                               // 679
              return false;                                                                           // 680
            arg = arrayElement;                                                                       // 681
          } else {                                                                                    // 682
            // dontIterate ensures that {a: {$elemMatch: {$gt: 5}}} matches                           // 683
            // {a: [8]} but not {a: [[8]]}                                                            // 684
            arg = [{value: arrayElement, dontIterate: true}];                                         // 685
          }                                                                                           // 686
          // XXX support $near in $elemMatch by propagating $distance?                                // 687
          if (subMatcher(arg).result)                                                                 // 688
            return i;   // specially understood to mean "use my arrayIndex"                           // 689
        }                                                                                             // 690
        return false;                                                                                 // 691
      };                                                                                              // 692
    }                                                                                                 // 693
  }                                                                                                   // 694
};                                                                                                    // 695
                                                                                                      // 696
// makeLookupFunction(key) returns a lookup function.                                                 // 697
//                                                                                                    // 698
// A lookup function takes in a document and returns an array of matching                             // 699
// branches.  If no arrays are found while looking up the key, this array will                        // 700
// have exactly one branches (possibly 'undefined', if some segment of the key                        // 701
// was not found).                                                                                    // 702
//                                                                                                    // 703
// If arrays are found in the middle, this can have more than one element, since                      // 704
// we "branch". When we "branch", if there are more key segments to look up,                          // 705
// then we only pursue branches that are plain objects (not arrays or scalars).                       // 706
// This means we can actually end up with no branches!                                                // 707
//                                                                                                    // 708
// We do *NOT* branch on arrays that are found at the end (ie, at the last                            // 709
// dotted member of the key). We just return that array; if you want to                               // 710
// effectively "branch" over the array's values, post-process the lookup                              // 711
// function with expandArraysInBranches.                                                              // 712
//                                                                                                    // 713
// Each branch is an object with keys:                                                                // 714
//  - value: the value at the branch                                                                  // 715
//  - dontIterate: an optional bool; if true, it means that 'value' is an array                       // 716
//    that expandArraysInBranches should NOT expand. This specifically happens                        // 717
//    when there is a numeric index in the key, and ensures the                                       // 718
//    perhaps-surprising MongoDB behavior where {'a.0': 5} does NOT                                   // 719
//    match {a: [[5]]}.                                                                               // 720
//  - arrayIndex: if any array indexing was done during lookup (either                                // 721
//    due to explicit numeric indices or implicit branching), this will                               // 722
//    be the FIRST (outermost) array index used; it is undefined or absent                            // 723
//    if no array index is used. (Make sure to check its value vs undefined,                          // 724
//    not just for truth, since '0' is a legit array index!) This is used                             // 725
//    to implement the '$' modifier feature.                                                          // 726
//                                                                                                    // 727
// At the top level, you may only pass in a plain object or arraym.                                   // 728
//                                                                                                    // 729
// See the text 'minimongo - lookup' for some examples of what lookup functions                       // 730
// return.                                                                                            // 731
makeLookupFunction = function (key) {                                                                 // 732
  var parts = key.split('.');                                                                         // 733
  var firstPart = parts.length ? parts[0] : '';                                                       // 734
  var firstPartIsNumeric = isNumericKey(firstPart);                                                   // 735
  var lookupRest;                                                                                     // 736
  if (parts.length > 1) {                                                                             // 737
    lookupRest = makeLookupFunction(parts.slice(1).join('.'));                                        // 738
  }                                                                                                   // 739
                                                                                                      // 740
  var elideUnnecessaryFields = function (retVal) {                                                    // 741
    if (!retVal.dontIterate)                                                                          // 742
      delete retVal.dontIterate;                                                                      // 743
    if (retVal.arrayIndex === undefined)                                                              // 744
      delete retVal.arrayIndex;                                                                       // 745
    return retVal;                                                                                    // 746
  };                                                                                                  // 747
                                                                                                      // 748
  // Doc will always be a plain object or an array.                                                   // 749
  // apply an explicit numeric index, an array.                                                       // 750
  return function (doc, firstArrayIndex) {                                                            // 751
    if (isArray(doc)) {                                                                               // 752
      // If we're being asked to do an invalid lookup into an array (non-integer                      // 753
      // or out-of-bounds), return no results (which is different from returning                      // 754
      // a single undefined result, in that `null` equality checks won't match).                      // 755
      if (!(firstPartIsNumeric && firstPart < doc.length))                                            // 756
        return [];                                                                                    // 757
                                                                                                      // 758
      // If this is the first array index we've seen, remember the index.                             // 759
      // (Mongo doesn't support multiple uses of '$', at least not in 2.5.                            // 760
      if (firstArrayIndex === undefined)                                                              // 761
        firstArrayIndex = +firstPart;                                                                 // 762
    }                                                                                                 // 763
                                                                                                      // 764
    // Do our first lookup.                                                                           // 765
    var firstLevel = doc[firstPart];                                                                  // 766
                                                                                                      // 767
    // If there is no deeper to dig, return what we found.                                            // 768
    //                                                                                                // 769
    // If what we found is an array, most value selectors will choose to treat                        // 770
    // the elements of the array as matchable values in their own right, but                          // 771
    // that's done outside of the lookup function. (Exceptions to this are $size                      // 772
    // and stuff relating to $elemMatch.  eg, {a: {$size: 2}} does not match {a:                      // 773
    // [[1, 2]]}.)                                                                                    // 774
    //                                                                                                // 775
    // That said, if we just did an *explicit* array lookup (on doc) to find                          // 776
    // firstLevel, and firstLevel is an array too, we do NOT want value                               // 777
    // selectors to iterate over it.  eg, {'a.0': 5} does not match {a: [[5]]}.                       // 778
    // So in that case, we mark the return value as "don't iterate".                                  // 779
    if (!lookupRest) {                                                                                // 780
      return [elideUnnecessaryFields({                                                                // 781
        value: firstLevel,                                                                            // 782
        dontIterate: isArray(doc) && isArray(firstLevel),                                             // 783
        arrayIndex: firstArrayIndex})];                                                               // 784
    }                                                                                                 // 785
                                                                                                      // 786
    // We need to dig deeper.  But if we can't, because what we've found is not                       // 787
    // an array or plain object, we're done. If we just did a numeric index into                      // 788
    // an array, we return nothing here (this is a change in Mongo 2.5 from                           // 789
    // Mongo 2.4, where {'a.0.b': null} stopped matching {a: [5]}). Otherwise,                        // 790
    // return a single `undefined` (which can, for example, match via equality                        // 791
    // with `null`).                                                                                  // 792
    if (!isIndexable(firstLevel)) {                                                                   // 793
      if (isArray(doc))                                                                               // 794
        return [];                                                                                    // 795
      return [elideUnnecessaryFields({value: undefined,                                               // 796
                                      arrayIndex: firstArrayIndex})];                                 // 797
    }                                                                                                 // 798
                                                                                                      // 799
    var result = [];                                                                                  // 800
    var appendToResult = function (more) {                                                            // 801
      Array.prototype.push.apply(result, more);                                                       // 802
    };                                                                                                // 803
                                                                                                      // 804
    // Dig deeper: look up the rest of the parts on whatever we've found.                             // 805
    // (lookupRest is smart enough to not try to do invalid lookups into                              // 806
    // firstLevel if it's an array.)                                                                  // 807
    appendToResult(lookupRest(firstLevel, firstArrayIndex));                                          // 808
                                                                                                      // 809
    // If we found an array, then in *addition* to potentially treating the next                      // 810
    // part as a literal integer lookup, we should also "branch": try to do look                      // 811
    // up the rest of the parts on each array element in parallel.                                    // 812
    //                                                                                                // 813
    // In this case, we *only* dig deeper into array elements that are plain                          // 814
    // objects. (Recall that we only got this far if we have further to dig.)                         // 815
    // This makes sense: we certainly don't dig deeper into non-indexable                             // 816
    // objects. And it would be weird to dig into an array: it's simpler to have                      // 817
    // a rule that explicit integer indexes only apply to an outer array, not to                      // 818
    // an array you find after a branching search.                                                    // 819
    if (isArray(firstLevel)) {                                                                        // 820
      _.each(firstLevel, function (branch, arrayIndex) {                                              // 821
        if (isPlainObject(branch)) {                                                                  // 822
          appendToResult(lookupRest(                                                                  // 823
            branch,                                                                                   // 824
            firstArrayIndex === undefined ? arrayIndex : firstArrayIndex));                           // 825
        }                                                                                             // 826
      });                                                                                             // 827
    }                                                                                                 // 828
                                                                                                      // 829
    return result;                                                                                    // 830
  };                                                                                                  // 831
};                                                                                                    // 832
MinimongoTest.makeLookupFunction = makeLookupFunction;                                                // 833
                                                                                                      // 834
expandArraysInBranches = function (branches, skipTheArrays) {                                         // 835
  var branchesOut = [];                                                                               // 836
  _.each(branches, function (branch) {                                                                // 837
    var thisIsArray = isArray(branch.value);                                                          // 838
    // We include the branch itself, *UNLESS* we it's an array that we're going                       // 839
    // to iterate and we're told to skip arrays.  (That's right, we include some                      // 840
    // arrays even skipTheArrays is true: these are arrays that were found via                        // 841
    // explicit numerical indices.)                                                                   // 842
    if (!(skipTheArrays && thisIsArray && !branch.dontIterate)) {                                     // 843
      branchesOut.push({                                                                              // 844
        value: branch.value,                                                                          // 845
        arrayIndex: branch.arrayIndex                                                                 // 846
      });                                                                                             // 847
    }                                                                                                 // 848
    if (thisIsArray && !branch.dontIterate) {                                                         // 849
      _.each(branch.value, function (leaf, i) {                                                       // 850
        branchesOut.push({                                                                            // 851
          value: leaf,                                                                                // 852
          // arrayIndex always defaults to the outermost array, but if we didn't                      // 853
          // need to use an array to get to this branch, we mark the index we                         // 854
          // just used as the arrayIndex.                                                             // 855
          arrayIndex: branch.arrayIndex === undefined ? i : branch.arrayIndex                         // 856
        });                                                                                           // 857
      });                                                                                             // 858
    }                                                                                                 // 859
  });                                                                                                 // 860
  return branchesOut;                                                                                 // 861
};                                                                                                    // 862
                                                                                                      // 863
var nothingMatcher = function (docOrBranchedValues) {                                                 // 864
  return {result: false};                                                                             // 865
};                                                                                                    // 866
                                                                                                      // 867
var everythingMatcher = function (docOrBranchedValues) {                                              // 868
  return {result: true};                                                                              // 869
};                                                                                                    // 870
                                                                                                      // 871
                                                                                                      // 872
// NB: We are cheating and using this function to implement "AND" for both                            // 873
// "document matchers" and "branched matchers". They both return result objects                       // 874
// but the argument is different: for the former it's a whole doc, whereas for                        // 875
// the latter it's an array of "branched values".                                                     // 876
var andSomeMatchers = function (subMatchers) {                                                        // 877
  if (subMatchers.length === 0)                                                                       // 878
    return everythingMatcher;                                                                         // 879
  if (subMatchers.length === 1)                                                                       // 880
    return subMatchers[0];                                                                            // 881
                                                                                                      // 882
  return function (docOrBranches) {                                                                   // 883
    // XXX arrayIndex!                                                                                // 884
    var ret = {};                                                                                     // 885
    ret.result = _.all(subMatchers, function (f) {                                                    // 886
      var subResult = f(docOrBranches);                                                               // 887
      // Copy a 'distance' number out of the first sub-matcher that has                               // 888
      // one. Yes, this means that if there are multiple $near fields in a                            // 889
      // query, something arbitrary happens; this appears to be consistent with                       // 890
      // Mongo.                                                                                       // 891
      if (subResult.result && subResult.distance !== undefined                                        // 892
          && ret.distance === undefined) {                                                            // 893
        ret.distance = subResult.distance;                                                            // 894
      }                                                                                               // 895
      // Similarly, propagate arrayIndex from sub-matchers... but to match                            // 896
      // MongoDB behavior, this time the *last* sub-matcher with an arrayIndex                        // 897
      // wins.                                                                                        // 898
      if (subResult.result && subResult.arrayIndex !== undefined) {                                   // 899
        ret.arrayIndex = subResult.arrayIndex;                                                        // 900
      }                                                                                               // 901
      return subResult.result;                                                                        // 902
    });                                                                                               // 903
                                                                                                      // 904
    // If we didn't actually match, forget any extra metadata we came up with.                        // 905
    if (!ret.result) {                                                                                // 906
      delete ret.distance;                                                                            // 907
      delete ret.arrayIndex;                                                                          // 908
    }                                                                                                 // 909
    return ret;                                                                                       // 910
  };                                                                                                  // 911
};                                                                                                    // 912
                                                                                                      // 913
var andDocumentMatchers = andSomeMatchers;                                                            // 914
var andBranchedMatchers = andSomeMatchers;                                                            // 915
                                                                                                      // 916
                                                                                                      // 917
// helpers used by compiled selector code                                                             // 918
LocalCollection._f = {                                                                                // 919
  // XXX for _all and _in, consider building 'inquery' at compile time..                              // 920
                                                                                                      // 921
  _type: function (v) {                                                                               // 922
    if (typeof v === "number")                                                                        // 923
      return 1;                                                                                       // 924
    if (typeof v === "string")                                                                        // 925
      return 2;                                                                                       // 926
    if (typeof v === "boolean")                                                                       // 927
      return 8;                                                                                       // 928
    if (isArray(v))                                                                                   // 929
      return 4;                                                                                       // 930
    if (v === null)                                                                                   // 931
      return 10;                                                                                      // 932
    if (v instanceof RegExp)                                                                          // 933
      // note that typeof(/x/) === "object"                                                           // 934
      return 11;                                                                                      // 935
    if (typeof v === "function")                                                                      // 936
      return 13;                                                                                      // 937
    if (v instanceof Date)                                                                            // 938
      return 9;                                                                                       // 939
    if (EJSON.isBinary(v))                                                                            // 940
      return 5;                                                                                       // 941
    if (v instanceof LocalCollection._ObjectID)                                                       // 942
      return 7;                                                                                       // 943
    return 3; // object                                                                               // 944
                                                                                                      // 945
    // XXX support some/all of these:                                                                 // 946
    // 14, symbol                                                                                     // 947
    // 15, javascript code with scope                                                                 // 948
    // 16, 18: 32-bit/64-bit integer                                                                  // 949
    // 17, timestamp                                                                                  // 950
    // 255, minkey                                                                                    // 951
    // 127, maxkey                                                                                    // 952
  },                                                                                                  // 953
                                                                                                      // 954
  // deep equality test: use for literal document and array matches                                   // 955
  _equal: function (a, b) {                                                                           // 956
    return EJSON.equals(a, b, {keyOrderSensitive: true});                                             // 957
  },                                                                                                  // 958
                                                                                                      // 959
  // maps a type code to a value that can be used to sort values of                                   // 960
  // different types                                                                                  // 961
  _typeorder: function (t) {                                                                          // 962
    // http://www.mongodb.org/display/DOCS/What+is+the+Compare+Order+for+BSON+Types                   // 963
    // XXX what is the correct sort position for Javascript code?                                     // 964
    // ('100' in the matrix below)                                                                    // 965
    // XXX minkey/maxkey                                                                              // 966
    return [-1,  // (not a type)                                                                      // 967
            1,   // number                                                                            // 968
            2,   // string                                                                            // 969
            3,   // object                                                                            // 970
            4,   // array                                                                             // 971
            5,   // binary                                                                            // 972
            -1,  // deprecated                                                                        // 973
            6,   // ObjectID                                                                          // 974
            7,   // bool                                                                              // 975
            8,   // Date                                                                              // 976
            0,   // null                                                                              // 977
            9,   // RegExp                                                                            // 978
            -1,  // deprecated                                                                        // 979
            100, // JS code                                                                           // 980
            2,   // deprecated (symbol)                                                               // 981
            100, // JS code                                                                           // 982
            1,   // 32-bit int                                                                        // 983
            8,   // Mongo timestamp                                                                   // 984
            1    // 64-bit int                                                                        // 985
           ][t];                                                                                      // 986
  },                                                                                                  // 987
                                                                                                      // 988
  // compare two values of unknown type according to BSON ordering                                    // 989
  // semantics. (as an extension, consider 'undefined' to be less than                                // 990
  // any other value.) return negative if a is less, positive if b is                                 // 991
  // less, or 0 if equal                                                                              // 992
  _cmp: function (a, b) {                                                                             // 993
    if (a === undefined)                                                                              // 994
      return b === undefined ? 0 : -1;                                                                // 995
    if (b === undefined)                                                                              // 996
      return 1;                                                                                       // 997
    var ta = LocalCollection._f._type(a);                                                             // 998
    var tb = LocalCollection._f._type(b);                                                             // 999
    var oa = LocalCollection._f._typeorder(ta);                                                       // 1000
    var ob = LocalCollection._f._typeorder(tb);                                                       // 1001
    if (oa !== ob)                                                                                    // 1002
      return oa < ob ? -1 : 1;                                                                        // 1003
    if (ta !== tb)                                                                                    // 1004
      // XXX need to implement this if we implement Symbol or integers, or                            // 1005
      // Timestamp                                                                                    // 1006
      throw Error("Missing type coercion logic in _cmp");                                             // 1007
    if (ta === 7) { // ObjectID                                                                       // 1008
      // Convert to string.                                                                           // 1009
      ta = tb = 2;                                                                                    // 1010
      a = a.toHexString();                                                                            // 1011
      b = b.toHexString();                                                                            // 1012
    }                                                                                                 // 1013
    if (ta === 9) { // Date                                                                           // 1014
      // Convert to millis.                                                                           // 1015
      ta = tb = 1;                                                                                    // 1016
      a = a.getTime();                                                                                // 1017
      b = b.getTime();                                                                                // 1018
    }                                                                                                 // 1019
                                                                                                      // 1020
    if (ta === 1) // double                                                                           // 1021
      return a - b;                                                                                   // 1022
    if (tb === 2) // string                                                                           // 1023
      return a < b ? -1 : (a === b ? 0 : 1);                                                          // 1024
    if (ta === 3) { // Object                                                                         // 1025
      // this could be much more efficient in the expected case ...                                   // 1026
      var to_array = function (obj) {                                                                 // 1027
        var ret = [];                                                                                 // 1028
        for (var key in obj) {                                                                        // 1029
          ret.push(key);                                                                              // 1030
          ret.push(obj[key]);                                                                         // 1031
        }                                                                                             // 1032
        return ret;                                                                                   // 1033
      };                                                                                              // 1034
      return LocalCollection._f._cmp(to_array(a), to_array(b));                                       // 1035
    }                                                                                                 // 1036
    if (ta === 4) { // Array                                                                          // 1037
      for (var i = 0; ; i++) {                                                                        // 1038
        if (i === a.length)                                                                           // 1039
          return (i === b.length) ? 0 : -1;                                                           // 1040
        if (i === b.length)                                                                           // 1041
          return 1;                                                                                   // 1042
        var s = LocalCollection._f._cmp(a[i], b[i]);                                                  // 1043
        if (s !== 0)                                                                                  // 1044
          return s;                                                                                   // 1045
      }                                                                                               // 1046
    }                                                                                                 // 1047
    if (ta === 5) { // binary                                                                         // 1048
      // Surprisingly, a small binary blob is always less than a large one in                         // 1049
      // Mongo.                                                                                       // 1050
      if (a.length !== b.length)                                                                      // 1051
        return a.length - b.length;                                                                   // 1052
      for (i = 0; i < a.length; i++) {                                                                // 1053
        if (a[i] < b[i])                                                                              // 1054
          return -1;                                                                                  // 1055
        if (a[i] > b[i])                                                                              // 1056
          return 1;                                                                                   // 1057
      }                                                                                               // 1058
      return 0;                                                                                       // 1059
    }                                                                                                 // 1060
    if (ta === 8) { // boolean                                                                        // 1061
      if (a) return b ? 0 : 1;                                                                        // 1062
      return b ? -1 : 0;                                                                              // 1063
    }                                                                                                 // 1064
    if (ta === 10) // null                                                                            // 1065
      return 0;                                                                                       // 1066
    if (ta === 11) // regexp                                                                          // 1067
      throw Error("Sorting not supported on regular expression"); // XXX                              // 1068
    // 13: javascript code                                                                            // 1069
    // 14: symbol                                                                                     // 1070
    // 15: javascript code with scope                                                                 // 1071
    // 16: 32-bit integer                                                                             // 1072
    // 17: timestamp                                                                                  // 1073
    // 18: 64-bit integer                                                                             // 1074
    // 255: minkey                                                                                    // 1075
    // 127: maxkey                                                                                    // 1076
    if (ta === 13) // javascript code                                                                 // 1077
      throw Error("Sorting not supported on Javascript code"); // XXX                                 // 1078
    throw Error("Unknown type to sort");                                                              // 1079
  }                                                                                                   // 1080
};                                                                                                    // 1081
                                                                                                      // 1082
// Oddball function used by upsert.                                                                   // 1083
LocalCollection._removeDollarOperators = function (selector) {                                        // 1084
  var selectorDoc = {};                                                                               // 1085
  for (var k in selector)                                                                             // 1086
    if (k.substr(0, 1) !== '$')                                                                       // 1087
      selectorDoc[k] = selector[k];                                                                   // 1088
  return selectorDoc;                                                                                 // 1089
};                                                                                                    // 1090
                                                                                                      // 1091
////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                    //
// packages/minimongo/sort.js                                                                         //
//                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                      //
// Give a sort spec, which can be in any of these forms:                                              // 1
//   {"key1": 1, "key2": -1}                                                                          // 2
//   [["key1", "asc"], ["key2", "desc"]]                                                              // 3
//   ["key1", ["key2", "desc"]]                                                                       // 4
//                                                                                                    // 5
// (.. with the first form being dependent on the key enumeration                                     // 6
// behavior of your javascript VM, which usually does what you mean in                                // 7
// this case if the key names don't look like integers ..)                                            // 8
//                                                                                                    // 9
// return a function that takes two objects, and returns -1 if the                                    // 10
// first object comes first in order, 1 if the second object comes                                    // 11
// first, or 0 if neither object comes before the other.                                              // 12
                                                                                                      // 13
Sorter = function (spec) {                                                                            // 14
  var self = this;                                                                                    // 15
                                                                                                      // 16
  var sortSpecParts = [];                                                                             // 17
                                                                                                      // 18
  if (spec instanceof Array) {                                                                        // 19
    for (var i = 0; i < spec.length; i++) {                                                           // 20
      if (typeof spec[i] === "string") {                                                              // 21
        sortSpecParts.push({                                                                          // 22
          lookup: makeLookupFunction(spec[i]),                                                        // 23
          ascending: true                                                                             // 24
        });                                                                                           // 25
      } else {                                                                                        // 26
        sortSpecParts.push({                                                                          // 27
          lookup: makeLookupFunction(spec[i][0]),                                                     // 28
          ascending: spec[i][1] !== "desc"                                                            // 29
        });                                                                                           // 30
      }                                                                                               // 31
    }                                                                                                 // 32
  } else if (typeof spec === "object") {                                                              // 33
    for (var key in spec) {                                                                           // 34
      sortSpecParts.push({                                                                            // 35
        lookup: makeLookupFunction(key),                                                              // 36
        ascending: spec[key] >= 0                                                                     // 37
      });                                                                                             // 38
    }                                                                                                 // 39
  } else {                                                                                            // 40
    throw Error("Bad sort specification: ", JSON.stringify(spec));                                    // 41
  }                                                                                                   // 42
                                                                                                      // 43
  // reduceValue takes in all the possible values for the sort key along various                      // 44
  // branches, and returns the min or max value (according to the bool                                // 45
  // findMin). Each value can itself be an array, and we look at its values                           // 46
  // too. (ie, we do a single level of flattening on branchValues, then find the                      // 47
  // min/max.)                                                                                        // 48
  //                                                                                                  // 49
  // XXX This is actually wrong! In fact, the whole attempt to compile sort                           // 50
  //     functions independently of selectors is wrong. In MongoDB, if you have                       // 51
  //     documents {_id: 'x', a: [1, 10]} and {_id: 'y', a: [5, 15]}, then                            // 52
  //     C.find({}, {sort: {a: 1}}) puts x before y (1 comes before 5).  But                          // 53
  //     C.find({a: {$gt: 3}}, {sort: {a: 1}}) puts y before x (1 does not match                      // 54
  //     the selector, and 5 comes before 10).                                                        // 55
  //                                                                                                  // 56
  //     The way this works is pretty subtle!  For example, if the documents are                      // 57
  //     instead {_id: 'x', a: [{x: 1}, {x: 10}]}) and                                                // 58
  //             {_id: 'y', a: [{x: 5}, {x: 15}]}),                                                   // 59
  //     then C.find({'a.x': {$gt: 3}}, {sort: {'a.x': 1}}) and                                       // 60
  //          C.find({a: {$elemMatch: {x: {$gt: 3}}}}, {sort: {'a.x': 1}})                            // 61
  //     both follow this rule (y before x).  ie, you do have to apply this                           // 62
  //     through $elemMatch.                                                                          // 63
  var reduceValue = function (branchValues, findMin) {                                                // 64
    // Expand any leaf arrays that we find, and ignore those arrays themselves.                       // 65
    branchValues = expandArraysInBranches(branchValues, true);                                        // 66
    var reduced = undefined;                                                                          // 67
    var first = true;                                                                                 // 68
    // Iterate over all the values found in all the branches, and if a value is                       // 69
    // an array itself, iterate over the values in the array separately.                              // 70
    _.each(branchValues, function (branchValue) {                                                     // 71
      if (first) {                                                                                    // 72
        reduced = branchValue.value;                                                                  // 73
        first = false;                                                                                // 74
      } else {                                                                                        // 75
        // Compare the value we found to the value we found so far, saving it                         // 76
        // if it's less (for an ascending sort) or more (for a descending                             // 77
        // sort).                                                                                     // 78
        var cmp = LocalCollection._f._cmp(reduced, branchValue.value);                                // 79
        if ((findMin && cmp > 0) || (!findMin && cmp < 0))                                            // 80
          reduced = branchValue.value;                                                                // 81
      }                                                                                               // 82
    });                                                                                               // 83
    return reduced;                                                                                   // 84
  };                                                                                                  // 85
                                                                                                      // 86
  var comparators = _.map(sortSpecParts, function (specPart) {                                        // 87
    return function (a, b) {                                                                          // 88
      var aValue = reduceValue(specPart.lookup(a), specPart.ascending);                               // 89
      var bValue = reduceValue(specPart.lookup(b), specPart.ascending);                               // 90
      var compare = LocalCollection._f._cmp(aValue, bValue);                                          // 91
      return specPart.ascending ? compare : -compare;                                                 // 92
    };                                                                                                // 93
  });                                                                                                 // 94
                                                                                                      // 95
  self._baseComparator = composeComparators(comparators);                                             // 96
};                                                                                                    // 97
                                                                                                      // 98
Sorter.prototype.getComparator = function (options) {                                                 // 99
  var self = this;                                                                                    // 100
                                                                                                      // 101
  // If we have no distances, just use the comparator from the source                                 // 102
  // specification (which defaults to "everything is equal".                                          // 103
  if (!options || !options.distances) {                                                               // 104
    return self._baseComparator;                                                                      // 105
  }                                                                                                   // 106
                                                                                                      // 107
  var distances = options.distances;                                                                  // 108
                                                                                                      // 109
  // Return a comparator which first tries the sort specification, and if that                        // 110
  // says "it's equal", breaks ties using $near distances.                                            // 111
  return composeComparators([self._baseComparator, function (a, b) {                                  // 112
    if (!distances.has(a._id))                                                                        // 113
      throw Error("Missing distance for " + a._id);                                                   // 114
    if (!distances.has(b._id))                                                                        // 115
      throw Error("Missing distance for " + b._id);                                                   // 116
    return distances.get(a._id) - distances.get(b._id);                                               // 117
  }]);                                                                                                // 118
};                                                                                                    // 119
                                                                                                      // 120
MinimongoTest.Sorter = Sorter;                                                                        // 121
                                                                                                      // 122
// Given an array of comparators                                                                      // 123
// (functions (a,b)->(negative or positive or zero)), returns a single                                // 124
// comparator which uses each comparator in order and returns the first                               // 125
// non-zero value.                                                                                    // 126
var composeComparators = function (comparatorArray) {                                                 // 127
  return function (a, b) {                                                                            // 128
    for (var i = 0; i < comparatorArray.length; ++i) {                                                // 129
      var compare = comparatorArray[i](a, b);                                                         // 130
      if (compare !== 0)                                                                              // 131
        return compare;                                                                               // 132
    }                                                                                                 // 133
    return 0;                                                                                         // 134
  };                                                                                                  // 135
};                                                                                                    // 136
                                                                                                      // 137
////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                    //
// packages/minimongo/projection.js                                                                   //
//                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                      //
// Knows how to compile a fields projection to a predicate function.                                  // 1
// @returns - Function: a closure that filters out an object according to the                         // 2
//            fields projection rules:                                                                // 3
//            @param obj - Object: MongoDB-styled document                                            // 4
//            @returns - Object: a document with the fields filtered out                              // 5
//                       according to projection rules. Doesn't retain subfields                      // 6
//                       of passed argument.                                                          // 7
LocalCollection._compileProjection = function (fields) {                                              // 8
  LocalCollection._checkSupportedProjection(fields);                                                  // 9
                                                                                                      // 10
  var _idProjection = _.isUndefined(fields._id) ? true : fields._id;                                  // 11
  var details = projectionDetails(fields);                                                            // 12
                                                                                                      // 13
  // returns transformed doc according to ruleTree                                                    // 14
  var transform = function (doc, ruleTree) {                                                          // 15
    // Special case for "sets"                                                                        // 16
    if (_.isArray(doc))                                                                               // 17
      return _.map(doc, function (subdoc) { return transform(subdoc, ruleTree); });                   // 18
                                                                                                      // 19
    var res = details.including ? {} : EJSON.clone(doc);                                              // 20
    _.each(ruleTree, function (rule, key) {                                                           // 21
      if (!_.has(doc, key))                                                                           // 22
        return;                                                                                       // 23
      if (_.isObject(rule)) {                                                                         // 24
        // For sub-objects/subsets we branch                                                          // 25
        if (_.isObject(doc[key]))                                                                     // 26
          res[key] = transform(doc[key], rule);                                                       // 27
        // Otherwise we don't even touch this subfield                                                // 28
      } else if (details.including)                                                                   // 29
        res[key] = EJSON.clone(doc[key]);                                                             // 30
      else                                                                                            // 31
        delete res[key];                                                                              // 32
    });                                                                                               // 33
                                                                                                      // 34
    return res;                                                                                       // 35
  };                                                                                                  // 36
                                                                                                      // 37
  return function (obj) {                                                                             // 38
    var res = transform(obj, details.tree);                                                           // 39
                                                                                                      // 40
    if (_idProjection && _.has(obj, '_id'))                                                           // 41
      res._id = obj._id;                                                                              // 42
    if (!_idProjection && _.has(res, '_id'))                                                          // 43
      delete res._id;                                                                                 // 44
    return res;                                                                                       // 45
  };                                                                                                  // 46
};                                                                                                    // 47
                                                                                                      // 48
// Traverses the keys of passed projection and constructs a tree where all                            // 49
// leaves are either all True or all False                                                            // 50
// @returns Object:                                                                                   // 51
//  - tree - Object - tree representation of keys involved in projection                              // 52
//  (exception for '_id' as it is a special case handled separately)                                  // 53
//  - including - Boolean - "take only certain fields" type of projection                             // 54
projectionDetails = function (fields) {                                                               // 55
  // Find the non-_id keys (_id is handled specially because it is included unless                    // 56
  // explicitly excluded). Sort the keys, so that our code to detect overlaps                         // 57
  // like 'foo' and 'foo.bar' can assume that 'foo' comes first.                                      // 58
  var fieldsKeys = _.keys(fields).sort();                                                             // 59
                                                                                                      // 60
  // If there are other rules other than '_id', treat '_id' differently in a                          // 61
  // separate case. If '_id' is the only rule, use it to understand if it is                          // 62
  // including/excluding projection.                                                                  // 63
  if (fieldsKeys.length > 0 && !(fieldsKeys.length === 1 && fieldsKeys[0] === '_id'))                 // 64
    fieldsKeys = _.reject(fieldsKeys, function (key) { return key === '_id'; });                      // 65
                                                                                                      // 66
  var including = null; // Unknown                                                                    // 67
                                                                                                      // 68
  _.each(fieldsKeys, function (keyPath) {                                                             // 69
    var rule = !!fields[keyPath];                                                                     // 70
    if (including === null)                                                                           // 71
      including = rule;                                                                               // 72
    if (including !== rule)                                                                           // 73
      // This error message is copies from MongoDB shell                                              // 74
      throw MinimongoError("You cannot currently mix including and excluding fields.");               // 75
  });                                                                                                 // 76
                                                                                                      // 77
                                                                                                      // 78
  var projectionRulesTree = pathsToTree(                                                              // 79
    fieldsKeys,                                                                                       // 80
    function (path) { return including; },                                                            // 81
    function (node, path, fullPath) {                                                                 // 82
      // Check passed projection fields' keys: If you have two rules such as                          // 83
      // 'foo.bar' and 'foo.bar.baz', then the result becomes ambiguous. If                           // 84
      // that happens, there is a probability you are doing something wrong,                          // 85
      // framework should notify you about such mistake earlier on cursor                             // 86
      // compilation step than later during runtime.  Note, that real mongo                           // 87
      // doesn't do anything about it and the later rule appears in projection                        // 88
      // project, more priority it takes.                                                             // 89
      //                                                                                              // 90
      // Example, assume following in mongo shell:                                                    // 91
      // > db.coll.insert({ a: { b: 23, c: 44 } })                                                    // 92
      // > db.coll.find({}, { 'a': 1, 'a.b': 1 })                                                     // 93
      // { "_id" : ObjectId("520bfe456024608e8ef24af3"), "a" : { "b" : 23 } }                         // 94
      // > db.coll.find({}, { 'a.b': 1, 'a': 1 })                                                     // 95
      // { "_id" : ObjectId("520bfe456024608e8ef24af3"), "a" : { "b" : 23, "c" : 44 } }               // 96
      //                                                                                              // 97
      // Note, how second time the return set of keys is different.                                   // 98
                                                                                                      // 99
      var currentPath = fullPath;                                                                     // 100
      var anotherPath = path;                                                                         // 101
      throw MinimongoError("both " + currentPath + " and " + anotherPath +                            // 102
                           " found in fields option, using both of them may trigger " +               // 103
                           "unexpected behavior. Did you mean to use only one of them?");             // 104
    });                                                                                               // 105
                                                                                                      // 106
  return {                                                                                            // 107
    tree: projectionRulesTree,                                                                        // 108
    including: including                                                                              // 109
  };                                                                                                  // 110
};                                                                                                    // 111
                                                                                                      // 112
// paths - Array: list of mongo style paths                                                           // 113
// newLeafFn - Function: of form function(path) should return a scalar value to                       // 114
//                       put into list created for that path                                          // 115
// conflictFn - Function: of form function(node, path, fullPath) is called                            // 116
//                        when building a tree path for 'fullPath' node on                            // 117
//                        'path' was already a leaf with a value. Must return a                       // 118
//                        conflict resolution.                                                        // 119
// initial tree - Optional Object: starting tree.                                                     // 120
// @returns - Object: tree represented as a set of nested objects                                     // 121
pathsToTree = function (paths, newLeafFn, conflictFn, tree) {                                         // 122
  tree = tree || {};                                                                                  // 123
  _.each(paths, function (keyPath) {                                                                  // 124
    var treePos = tree;                                                                               // 125
    var pathArr = keyPath.split('.');                                                                 // 126
                                                                                                      // 127
    // use _.all just for iteration with break                                                        // 128
    var success = _.all(pathArr.slice(0, -1), function (key, idx) {                                   // 129
      if (!_.has(treePos, key))                                                                       // 130
        treePos[key] = {};                                                                            // 131
      else if (!_.isObject(treePos[key])) {                                                           // 132
        treePos[key] = conflictFn(treePos[key],                                                       // 133
                                  pathArr.slice(0, idx + 1).join('.'),                                // 134
                                  keyPath);                                                           // 135
        // break out of loop if we are failing for this path                                          // 136
        if (!_.isObject(treePos[key]))                                                                // 137
          return false;                                                                               // 138
      }                                                                                               // 139
                                                                                                      // 140
      treePos = treePos[key];                                                                         // 141
      return true;                                                                                    // 142
    });                                                                                               // 143
                                                                                                      // 144
    if (success) {                                                                                    // 145
      var lastKey = _.last(pathArr);                                                                  // 146
      if (!_.has(treePos, lastKey))                                                                   // 147
        treePos[lastKey] = newLeafFn(keyPath);                                                        // 148
      else                                                                                            // 149
        treePos[lastKey] = conflictFn(treePos[lastKey], keyPath, keyPath);                            // 150
    }                                                                                                 // 151
  });                                                                                                 // 152
                                                                                                      // 153
  return tree;                                                                                        // 154
};                                                                                                    // 155
                                                                                                      // 156
LocalCollection._checkSupportedProjection = function (fields) {                                       // 157
  if (!_.isObject(fields) || _.isArray(fields))                                                       // 158
    throw MinimongoError("fields option must be an object");                                          // 159
                                                                                                      // 160
  _.each(fields, function (val, keyPath) {                                                            // 161
    if (_.contains(keyPath.split('.'), '$'))                                                          // 162
      throw MinimongoError("Minimongo doesn't support $ operator in projections yet.");               // 163
    if (_.indexOf([1, 0, true, false], val) === -1)                                                   // 164
      throw MinimongoError("Projection values should be one of 1, 0, true, or false");                // 165
  });                                                                                                 // 166
};                                                                                                    // 167
                                                                                                      // 168
                                                                                                      // 169
////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                    //
// packages/minimongo/modify.js                                                                       //
//                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                      //
// XXX need a strategy for passing the binding of $ into this                                         // 1
// function, from the compiled selector                                                               // 2
//                                                                                                    // 3
// maybe just {key.up.to.just.before.dollarsign: array_index}                                         // 4
//                                                                                                    // 5
// XXX atomicity: if one modification fails, do we roll back the whole                                // 6
// change?                                                                                            // 7
//                                                                                                    // 8
// options:                                                                                           // 9
//   - isInsert is set when _modify is being called to compute the document to                        // 10
//     insert as part of an upsert operation. We use this primarily to figure                         // 11
//     out when to set the fields in $setOnInsert, if present.                                        // 12
LocalCollection._modify = function (doc, mod, options) {                                              // 13
  options = options || {};                                                                            // 14
  if (!isPlainObject(mod))                                                                            // 15
    throw MinimongoError("Modifier must be an object");                                               // 16
  var isModifier = isOperatorObject(mod);                                                             // 17
                                                                                                      // 18
  var newDoc;                                                                                         // 19
                                                                                                      // 20
  if (!isModifier) {                                                                                  // 21
    if (mod._id && !EJSON.equals(doc._id, mod._id))                                                   // 22
      throw MinimongoError("Cannot change the _id of a document");                                    // 23
                                                                                                      // 24
    // replace the whole document                                                                     // 25
    for (var k in mod) {                                                                              // 26
      if (/\./.test(k))                                                                               // 27
        throw MinimongoError(                                                                         // 28
          "When replacing document, field name may not contain '.'");                                 // 29
    }                                                                                                 // 30
    newDoc = mod;                                                                                     // 31
  } else {                                                                                            // 32
    // apply modifiers to the doc.                                                                    // 33
    newDoc = EJSON.clone(doc);                                                                        // 34
                                                                                                      // 35
    _.each(mod, function (operand, op) {                                                              // 36
      var modFunc = MODIFIERS[op];                                                                    // 37
      // Treat $setOnInsert as $set if this is an insert.                                             // 38
      if (options.isInsert && op === '$setOnInsert')                                                  // 39
        modFunc = MODIFIERS['$set'];                                                                  // 40
      if (!modFunc)                                                                                   // 41
        throw MinimongoError("Invalid modifier specified " + op);                                     // 42
      _.each(operand, function (arg, keypath) {                                                       // 43
        // XXX mongo doesn't allow mod field names to end in a period,                                // 44
        // but I don't see why.. it allows '' as a key, as does JS                                    // 45
        if (keypath.length && keypath[keypath.length-1] === '.')                                      // 46
          throw MinimongoError(                                                                       // 47
            "Invalid mod field name, may not end in a period");                                       // 48
                                                                                                      // 49
        if (keypath === '_id')                                                                        // 50
          throw MinimongoError("Mod on _id not allowed");                                             // 51
                                                                                                      // 52
        var keyparts = keypath.split('.');                                                            // 53
        var noCreate = _.has(NO_CREATE_MODIFIERS, op);                                                // 54
        var forbidArray = (op === "$rename");                                                         // 55
        var target = findModTarget(newDoc, keyparts, {                                                // 56
          noCreate: NO_CREATE_MODIFIERS[op],                                                          // 57
          forbidArray: (op === "$rename"),                                                            // 58
          arrayIndex: options.arrayIndex                                                              // 59
        });                                                                                           // 60
        var field = keyparts.pop();                                                                   // 61
        modFunc(target, field, arg, keypath, newDoc);                                                 // 62
      });                                                                                             // 63
    });                                                                                               // 64
  }                                                                                                   // 65
                                                                                                      // 66
  // move new document into place.                                                                    // 67
  _.each(_.keys(doc), function (k) {                                                                  // 68
    // Note: this used to be for (var k in doc) however, this does not                                // 69
    // work right in Opera. Deleting from a doc while iterating over it                               // 70
    // would sometimes cause opera to skip some keys.                                                 // 71
                                                                                                      // 72
    // isInsert: if we're constructing a document to insert (via upsert)                              // 73
    // and we're in replacement mode, not modify mode, DON'T take the                                 // 74
    // _id from the query.  This matches mongo's behavior.                                            // 75
    if (k !== '_id' || options.isInsert)                                                              // 76
      delete doc[k];                                                                                  // 77
  });                                                                                                 // 78
  _.each(newDoc, function (v, k) {                                                                    // 79
    doc[k] = v;                                                                                       // 80
  });                                                                                                 // 81
};                                                                                                    // 82
                                                                                                      // 83
// for a.b.c.2.d.e, keyparts should be ['a', 'b', 'c', '2', 'd', 'e'],                                // 84
// and then you would operate on the 'e' property of the returned                                     // 85
// object.                                                                                            // 86
//                                                                                                    // 87
// if options.noCreate is falsey, creates intermediate levels of                                      // 88
// structure as necessary, like mkdir -p (and raises an exception if                                  // 89
// that would mean giving a non-numeric property to an array.) if                                     // 90
// options.noCreate is true, return undefined instead.                                                // 91
//                                                                                                    // 92
// may modify the last element of keyparts to signal to the caller that it needs                      // 93
// to use a different value to index into the returned object (for example,                           // 94
// ['a', '01'] -> ['a', 1]).                                                                          // 95
//                                                                                                    // 96
// if forbidArray is true, return null if the keypath goes through an array.                          // 97
//                                                                                                    // 98
// if options.arrayIndex is defined, use this for the (first) '$' in the path.                        // 99
var findModTarget = function (doc, keyparts, options) {                                               // 100
  options = options || {};                                                                            // 101
  var usedArrayIndex = false;                                                                         // 102
  for (var i = 0; i < keyparts.length; i++) {                                                         // 103
    var last = (i === keyparts.length - 1);                                                           // 104
    var keypart = keyparts[i];                                                                        // 105
    var indexable = isIndexable(doc);                                                                 // 106
    if (!indexable) {                                                                                 // 107
      if (options.noCreate)                                                                           // 108
        return undefined;                                                                             // 109
      var e = MinimongoError(                                                                         // 110
        "cannot use the part '" + keypart + "' to traverse " + doc);                                  // 111
      e.setPropertyError = true;                                                                      // 112
      throw e;                                                                                        // 113
    }                                                                                                 // 114
    if (doc instanceof Array) {                                                                       // 115
      if (options.forbidArray)                                                                        // 116
        return null;                                                                                  // 117
      if (keypart === '$') {                                                                          // 118
        if (usedArrayIndex)                                                                           // 119
          throw MinimongoError("Too many positional (i.e. '$') elements");                            // 120
        if (options.arrayIndex === undefined) {                                                       // 121
          throw MinimongoError("The positional operator did not find the " +                          // 122
                               "match needed from the query");                                        // 123
        }                                                                                             // 124
        keypart = options.arrayIndex;                                                                 // 125
        usedArrayIndex = true;                                                                        // 126
      } else if (isNumericKey(keypart)) {                                                             // 127
        keypart = parseInt(keypart);                                                                  // 128
      } else {                                                                                        // 129
        if (options.noCreate)                                                                         // 130
          return undefined;                                                                           // 131
        throw MinimongoError(                                                                         // 132
          "can't append to array using string field name ["                                           // 133
                    + keypart + "]");                                                                 // 134
      }                                                                                               // 135
      if (last)                                                                                       // 136
        // handle 'a.01'                                                                              // 137
        keyparts[i] = keypart;                                                                        // 138
      if (options.noCreate && keypart >= doc.length)                                                  // 139
        return undefined;                                                                             // 140
      while (doc.length < keypart)                                                                    // 141
        doc.push(null);                                                                               // 142
      if (!last) {                                                                                    // 143
        if (doc.length === keypart)                                                                   // 144
          doc.push({});                                                                               // 145
        else if (typeof doc[keypart] !== "object")                                                    // 146
          throw MinimongoError("can't modify field '" + keyparts[i + 1] +                             // 147
                      "' of list value " + JSON.stringify(doc[keypart]));                             // 148
      }                                                                                               // 149
    } else {                                                                                          // 150
      if (keypart.length && keypart.substr(0, 1) === '$')                                             // 151
        throw MinimongoError("can't set field named " + keypart);                                     // 152
      if (!(keypart in doc)) {                                                                        // 153
        if (options.noCreate)                                                                         // 154
          return undefined;                                                                           // 155
        if (!last)                                                                                    // 156
          doc[keypart] = {};                                                                          // 157
      }                                                                                               // 158
    }                                                                                                 // 159
                                                                                                      // 160
    if (last)                                                                                         // 161
      return doc;                                                                                     // 162
    doc = doc[keypart];                                                                               // 163
  }                                                                                                   // 164
                                                                                                      // 165
  // notreached                                                                                       // 166
};                                                                                                    // 167
                                                                                                      // 168
var NO_CREATE_MODIFIERS = {                                                                           // 169
  $unset: true,                                                                                       // 170
  $pop: true,                                                                                         // 171
  $rename: true,                                                                                      // 172
  $pull: true,                                                                                        // 173
  $pullAll: true                                                                                      // 174
};                                                                                                    // 175
                                                                                                      // 176
var MODIFIERS = {                                                                                     // 177
  $inc: function (target, field, arg) {                                                               // 178
    if (typeof arg !== "number")                                                                      // 179
      throw MinimongoError("Modifier $inc allowed for numbers only");                                 // 180
    if (field in target) {                                                                            // 181
      if (typeof target[field] !== "number")                                                          // 182
        throw MinimongoError("Cannot apply $inc modifier to non-number");                             // 183
      target[field] += arg;                                                                           // 184
    } else {                                                                                          // 185
      target[field] = arg;                                                                            // 186
    }                                                                                                 // 187
  },                                                                                                  // 188
  $set: function (target, field, arg) {                                                               // 189
    if (!_.isObject(target)) { // not an array or an object                                           // 190
      var e = MinimongoError("Cannot set property on non-object field");                              // 191
      e.setPropertyError = true;                                                                      // 192
      throw e;                                                                                        // 193
    }                                                                                                 // 194
    if (target === null) {                                                                            // 195
      var e = MinimongoError("Cannot set property on null");                                          // 196
      e.setPropertyError = true;                                                                      // 197
      throw e;                                                                                        // 198
    }                                                                                                 // 199
    target[field] = EJSON.clone(arg);                                                                 // 200
  },                                                                                                  // 201
  $setOnInsert: function (target, field, arg) {                                                       // 202
    // converted to `$set` in `_modify`                                                               // 203
  },                                                                                                  // 204
  $unset: function (target, field, arg) {                                                             // 205
    if (target !== undefined) {                                                                       // 206
      if (target instanceof Array) {                                                                  // 207
        if (field in target)                                                                          // 208
          target[field] = null;                                                                       // 209
      } else                                                                                          // 210
        delete target[field];                                                                         // 211
    }                                                                                                 // 212
  },                                                                                                  // 213
  $push: function (target, field, arg) {                                                              // 214
    if (target[field] === undefined)                                                                  // 215
      target[field] = [];                                                                             // 216
    if (!(target[field] instanceof Array))                                                            // 217
      throw MinimongoError("Cannot apply $push modifier to non-array");                               // 218
                                                                                                      // 219
    if (!(arg && arg.$each)) {                                                                        // 220
      // Simple mode: not $each                                                                       // 221
      target[field].push(EJSON.clone(arg));                                                           // 222
      return;                                                                                         // 223
    }                                                                                                 // 224
                                                                                                      // 225
    // Fancy mode: $each (and maybe $slice and $sort)                                                 // 226
    var toPush = arg.$each;                                                                           // 227
    if (!(toPush instanceof Array))                                                                   // 228
      throw MinimongoError("$each must be an array");                                                 // 229
                                                                                                      // 230
    // Parse $slice.                                                                                  // 231
    var slice = undefined;                                                                            // 232
    if ('$slice' in arg) {                                                                            // 233
      if (typeof arg.$slice !== "number")                                                             // 234
        throw MinimongoError("$slice must be a numeric value");                                       // 235
      // XXX should check to make sure integer                                                        // 236
      if (arg.$slice > 0)                                                                             // 237
        throw MinimongoError("$slice in $push must be zero or negative");                             // 238
      slice = arg.$slice;                                                                             // 239
    }                                                                                                 // 240
                                                                                                      // 241
    // Parse $sort.                                                                                   // 242
    var sortFunction = undefined;                                                                     // 243
    if (arg.$sort) {                                                                                  // 244
      if (slice === undefined)                                                                        // 245
        throw MinimongoError("$sort requires $slice to be present");                                  // 246
      // XXX this allows us to use a $sort whose value is an array, but that's                        // 247
      // actually an extension of the Node driver, so it won't work                                   // 248
      // server-side. Could be confusing!                                                             // 249
      // XXX is it correct that we don't do geo-stuff here?                                           // 250
      sortFunction = new Sorter(arg.$sort).getComparator();                                           // 251
      for (var i = 0; i < toPush.length; i++) {                                                       // 252
        if (LocalCollection._f._type(toPush[i]) !== 3) {                                              // 253
          throw MinimongoError("$push like modifiers using $sort " +                                  // 254
                      "require all elements to be objects");                                          // 255
        }                                                                                             // 256
      }                                                                                               // 257
    }                                                                                                 // 258
                                                                                                      // 259
    // Actually push.                                                                                 // 260
    for (var j = 0; j < toPush.length; j++)                                                           // 261
      target[field].push(EJSON.clone(toPush[j]));                                                     // 262
                                                                                                      // 263
    // Actually sort.                                                                                 // 264
    if (sortFunction)                                                                                 // 265
      target[field].sort(sortFunction);                                                               // 266
                                                                                                      // 267
    // Actually slice.                                                                                // 268
    if (slice !== undefined) {                                                                        // 269
      if (slice === 0)                                                                                // 270
        target[field] = [];  // differs from Array.slice!                                             // 271
      else                                                                                            // 272
        target[field] = target[field].slice(slice);                                                   // 273
    }                                                                                                 // 274
  },                                                                                                  // 275
  $pushAll: function (target, field, arg) {                                                           // 276
    if (!(typeof arg === "object" && arg instanceof Array))                                           // 277
      throw MinimongoError("Modifier $pushAll/pullAll allowed for arrays only");                      // 278
    var x = target[field];                                                                            // 279
    if (x === undefined)                                                                              // 280
      target[field] = arg;                                                                            // 281
    else if (!(x instanceof Array))                                                                   // 282
      throw MinimongoError("Cannot apply $pushAll modifier to non-array");                            // 283
    else {                                                                                            // 284
      for (var i = 0; i < arg.length; i++)                                                            // 285
        x.push(arg[i]);                                                                               // 286
    }                                                                                                 // 287
  },                                                                                                  // 288
  $addToSet: function (target, field, arg) {                                                          // 289
    var x = target[field];                                                                            // 290
    if (x === undefined)                                                                              // 291
      target[field] = [arg];                                                                          // 292
    else if (!(x instanceof Array))                                                                   // 293
      throw MinimongoError("Cannot apply $addToSet modifier to non-array");                           // 294
    else {                                                                                            // 295
      var isEach = false;                                                                             // 296
      if (typeof arg === "object") {                                                                  // 297
        for (var k in arg) {                                                                          // 298
          if (k === "$each")                                                                          // 299
            isEach = true;                                                                            // 300
          break;                                                                                      // 301
        }                                                                                             // 302
      }                                                                                               // 303
      var values = isEach ? arg["$each"] : [arg];                                                     // 304
      _.each(values, function (value) {                                                               // 305
        for (var i = 0; i < x.length; i++)                                                            // 306
          if (LocalCollection._f._equal(value, x[i]))                                                 // 307
            return;                                                                                   // 308
        x.push(EJSON.clone(value));                                                                   // 309
      });                                                                                             // 310
    }                                                                                                 // 311
  },                                                                                                  // 312
  $pop: function (target, field, arg) {                                                               // 313
    if (target === undefined)                                                                         // 314
      return;                                                                                         // 315
    var x = target[field];                                                                            // 316
    if (x === undefined)                                                                              // 317
      return;                                                                                         // 318
    else if (!(x instanceof Array))                                                                   // 319
      throw MinimongoError("Cannot apply $pop modifier to non-array");                                // 320
    else {                                                                                            // 321
      if (typeof arg === 'number' && arg < 0)                                                         // 322
        x.splice(0, 1);                                                                               // 323
      else                                                                                            // 324
        x.pop();                                                                                      // 325
    }                                                                                                 // 326
  },                                                                                                  // 327
  $pull: function (target, field, arg) {                                                              // 328
    if (target === undefined)                                                                         // 329
      return;                                                                                         // 330
    var x = target[field];                                                                            // 331
    if (x === undefined)                                                                              // 332
      return;                                                                                         // 333
    else if (!(x instanceof Array))                                                                   // 334
      throw MinimongoError("Cannot apply $pull/pullAll modifier to non-array");                       // 335
    else {                                                                                            // 336
      var out = [];                                                                                   // 337
      if (typeof arg === "object" && !(arg instanceof Array)) {                                       // 338
        // XXX would be much nicer to compile this once, rather than                                  // 339
        // for each document we modify.. but usually we're not                                        // 340
        // modifying that many documents, so we'll let it slide for                                   // 341
        // now                                                                                        // 342
                                                                                                      // 343
        // XXX Minimongo.Matcher isn't up for the job, because we need                                // 344
        // to permit stuff like {$pull: {a: {$gt: 4}}}.. something                                    // 345
        // like {$gt: 4} is not normally a complete selector.                                         // 346
        // same issue as $elemMatch possibly?                                                         // 347
        var matcher = new Minimongo.Matcher(arg);                                                     // 348
        for (var i = 0; i < x.length; i++)                                                            // 349
          if (!matcher.documentMatches(x[i]).result)                                                  // 350
            out.push(x[i]);                                                                           // 351
      } else {                                                                                        // 352
        for (var i = 0; i < x.length; i++)                                                            // 353
          if (!LocalCollection._f._equal(x[i], arg))                                                  // 354
            out.push(x[i]);                                                                           // 355
      }                                                                                               // 356
      target[field] = out;                                                                            // 357
    }                                                                                                 // 358
  },                                                                                                  // 359
  $pullAll: function (target, field, arg) {                                                           // 360
    if (!(typeof arg === "object" && arg instanceof Array))                                           // 361
      throw MinimongoError("Modifier $pushAll/pullAll allowed for arrays only");                      // 362
    if (target === undefined)                                                                         // 363
      return;                                                                                         // 364
    var x = target[field];                                                                            // 365
    if (x === undefined)                                                                              // 366
      return;                                                                                         // 367
    else if (!(x instanceof Array))                                                                   // 368
      throw MinimongoError("Cannot apply $pull/pullAll modifier to non-array");                       // 369
    else {                                                                                            // 370
      var out = [];                                                                                   // 371
      for (var i = 0; i < x.length; i++) {                                                            // 372
        var exclude = false;                                                                          // 373
        for (var j = 0; j < arg.length; j++) {                                                        // 374
          if (LocalCollection._f._equal(x[i], arg[j])) {                                              // 375
            exclude = true;                                                                           // 376
            break;                                                                                    // 377
          }                                                                                           // 378
        }                                                                                             // 379
        if (!exclude)                                                                                 // 380
          out.push(x[i]);                                                                             // 381
      }                                                                                               // 382
      target[field] = out;                                                                            // 383
    }                                                                                                 // 384
  },                                                                                                  // 385
  $rename: function (target, field, arg, keypath, doc) {                                              // 386
    if (keypath === arg)                                                                              // 387
      // no idea why mongo has this restriction..                                                     // 388
      throw MinimongoError("$rename source must differ from target");                                 // 389
    if (target === null)                                                                              // 390
      throw MinimongoError("$rename source field invalid");                                           // 391
    if (typeof arg !== "string")                                                                      // 392
      throw MinimongoError("$rename target must be a string");                                        // 393
    if (target === undefined)                                                                         // 394
      return;                                                                                         // 395
    var v = target[field];                                                                            // 396
    delete target[field];                                                                             // 397
                                                                                                      // 398
    var keyparts = arg.split('.');                                                                    // 399
    var target2 = findModTarget(doc, keyparts, {forbidArray: true});                                  // 400
    if (target2 === null)                                                                             // 401
      throw MinimongoError("$rename target field invalid");                                           // 402
    var field2 = keyparts.pop();                                                                      // 403
    target2[field2] = v;                                                                              // 404
  },                                                                                                  // 405
  $bit: function (target, field, arg) {                                                               // 406
    // XXX mongo only supports $bit on integers, and we only support                                  // 407
    // native javascript numbers (doubles) so far, so we can't support $bit                           // 408
    throw MinimongoError("$bit is not supported");                                                    // 409
  }                                                                                                   // 410
};                                                                                                    // 411
                                                                                                      // 412
////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                    //
// packages/minimongo/diff.js                                                                         //
//                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                      //
                                                                                                      // 1
// ordered: bool.                                                                                     // 2
// old_results and new_results: collections of documents.                                             // 3
//    if ordered, they are arrays.                                                                    // 4
//    if unordered, they are IdMaps                                                                   // 5
LocalCollection._diffQueryChanges = function (ordered, oldResults, newResults,                        // 6
                                       observer) {                                                    // 7
  if (ordered)                                                                                        // 8
    LocalCollection._diffQueryOrderedChanges(                                                         // 9
      oldResults, newResults, observer);                                                              // 10
  else                                                                                                // 11
    LocalCollection._diffQueryUnorderedChanges(                                                       // 12
      oldResults, newResults, observer);                                                              // 13
};                                                                                                    // 14
                                                                                                      // 15
LocalCollection._diffQueryUnorderedChanges = function (oldResults, newResults,                        // 16
                                                       observer) {                                    // 17
  if (observer.movedBefore) {                                                                         // 18
    throw new Error("_diffQueryUnordered called with a movedBefore observer!");                       // 19
  }                                                                                                   // 20
                                                                                                      // 21
  newResults.forEach(function (newDoc, id) {                                                          // 22
    var oldDoc = oldResults.get(id);                                                                  // 23
    if (oldDoc) {                                                                                     // 24
      if (observer.changed && !EJSON.equals(oldDoc, newDoc)) {                                        // 25
        observer.changed(                                                                             // 26
          id, LocalCollection._makeChangedFields(newDoc, oldDoc));                                    // 27
      }                                                                                               // 28
    } else if (observer.added) {                                                                      // 29
      var fields = EJSON.clone(newDoc);                                                               // 30
      delete fields._id;                                                                              // 31
      observer.added(newDoc._id, fields);                                                             // 32
    }                                                                                                 // 33
  });                                                                                                 // 34
                                                                                                      // 35
  if (observer.removed) {                                                                             // 36
    oldResults.forEach(function (oldDoc, id) {                                                        // 37
      if (!newResults.has(id))                                                                        // 38
        observer.removed(id);                                                                         // 39
    });                                                                                               // 40
  }                                                                                                   // 41
};                                                                                                    // 42
                                                                                                      // 43
                                                                                                      // 44
LocalCollection._diffQueryOrderedChanges = function (old_results, new_results, observer) {            // 45
                                                                                                      // 46
  var new_presence_of_id = {};                                                                        // 47
  _.each(new_results, function (doc) {                                                                // 48
    if (new_presence_of_id[doc._id])                                                                  // 49
      Meteor._debug("Duplicate _id in new_results");                                                  // 50
    new_presence_of_id[doc._id] = true;                                                               // 51
  });                                                                                                 // 52
                                                                                                      // 53
  var old_index_of_id = {};                                                                           // 54
  _.each(old_results, function (doc, i) {                                                             // 55
    if (doc._id in old_index_of_id)                                                                   // 56
      Meteor._debug("Duplicate _id in old_results");                                                  // 57
    old_index_of_id[doc._id] = i;                                                                     // 58
  });                                                                                                 // 59
                                                                                                      // 60
  // ALGORITHM:                                                                                       // 61
  //                                                                                                  // 62
  // To determine which docs should be considered "moved" (and which                                  // 63
  // merely change position because of other docs moving) we run                                      // 64
  // a "longest common subsequence" (LCS) algorithm.  The LCS of the                                  // 65
  // old doc IDs and the new doc IDs gives the docs that should NOT be                                // 66
  // considered moved.                                                                                // 67
                                                                                                      // 68
  // To actually call the appropriate callbacks to get from the old state to the                      // 69
  // new state:                                                                                       // 70
                                                                                                      // 71
  // First, we call removed() on all the items that only appear in the old                            // 72
  // state.                                                                                           // 73
                                                                                                      // 74
  // Then, once we have the items that should not move, we walk through the new                       // 75
  // results array group-by-group, where a "group" is a set of items that have                        // 76
  // moved, anchored on the end by an item that should not move.  One by one, we                      // 77
  // move each of those elements into place "before" the anchoring end-of-group                       // 78
  // item, and fire changed events on them if necessary.  Then we fire a changed                      // 79
  // event on the anchor, and move on to the next group.  There is always at                          // 80
  // least one group; the last group is anchored by a virtual "null" id at the                        // 81
  // end.                                                                                             // 82
                                                                                                      // 83
  // Asymptotically: O(N k) where k is number of ops, or potentially                                  // 84
  // O(N log N) if inner loop of LCS were made to be binary search.                                   // 85
                                                                                                      // 86
                                                                                                      // 87
  //////// LCS (longest common sequence, with respect to _id)                                         // 88
  // (see Wikipedia article on Longest Increasing Subsequence,                                        // 89
  // where the LIS is taken of the sequence of old indices of the                                     // 90
  // docs in new_results)                                                                             // 91
  //                                                                                                  // 92
  // unmoved: the output of the algorithm; members of the LCS,                                        // 93
  // in the form of indices into new_results                                                          // 94
  var unmoved = [];                                                                                   // 95
  // max_seq_len: length of LCS found so far                                                          // 96
  var max_seq_len = 0;                                                                                // 97
  // seq_ends[i]: the index into new_results of the last doc in a                                     // 98
  // common subsequence of length of i+1 <= max_seq_len                                               // 99
  var N = new_results.length;                                                                         // 100
  var seq_ends = new Array(N);                                                                        // 101
  // ptrs:  the common subsequence ending with new_results[n] extends                                 // 102
  // a common subsequence ending with new_results[ptr[n]], unless                                     // 103
  // ptr[n] is -1.                                                                                    // 104
  var ptrs = new Array(N);                                                                            // 105
  // virtual sequence of old indices of new results                                                   // 106
  var old_idx_seq = function(i_new) {                                                                 // 107
    return old_index_of_id[new_results[i_new]._id];                                                   // 108
  };                                                                                                  // 109
  // for each item in new_results, use it to extend a common subsequence                              // 110
  // of length j <= max_seq_len                                                                       // 111
  for(var i=0; i<N; i++) {                                                                            // 112
    if (old_index_of_id[new_results[i]._id] !== undefined) {                                          // 113
      var j = max_seq_len;                                                                            // 114
      // this inner loop would traditionally be a binary search,                                      // 115
      // but scanning backwards we will likely find a subseq to extend                                // 116
      // pretty soon, bounded for example by the total number of ops.                                 // 117
      // If this were to be changed to a binary search, we'd still want                               // 118
      // to scan backwards a bit as an optimization.                                                  // 119
      while (j > 0) {                                                                                 // 120
        if (old_idx_seq(seq_ends[j-1]) < old_idx_seq(i))                                              // 121
          break;                                                                                      // 122
        j--;                                                                                          // 123
      }                                                                                               // 124
                                                                                                      // 125
      ptrs[i] = (j === 0 ? -1 : seq_ends[j-1]);                                                       // 126
      seq_ends[j] = i;                                                                                // 127
      if (j+1 > max_seq_len)                                                                          // 128
        max_seq_len = j+1;                                                                            // 129
    }                                                                                                 // 130
  }                                                                                                   // 131
                                                                                                      // 132
  // pull out the LCS/LIS into unmoved                                                                // 133
  var idx = (max_seq_len === 0 ? -1 : seq_ends[max_seq_len-1]);                                       // 134
  while (idx >= 0) {                                                                                  // 135
    unmoved.push(idx);                                                                                // 136
    idx = ptrs[idx];                                                                                  // 137
  }                                                                                                   // 138
  // the unmoved item list is built backwards, so fix that                                            // 139
  unmoved.reverse();                                                                                  // 140
                                                                                                      // 141
  // the last group is always anchored by the end of the result list, which is                        // 142
  // an id of "null"                                                                                  // 143
  unmoved.push(new_results.length);                                                                   // 144
                                                                                                      // 145
  _.each(old_results, function (doc) {                                                                // 146
    if (!new_presence_of_id[doc._id])                                                                 // 147
      observer.removed && observer.removed(doc._id);                                                  // 148
  });                                                                                                 // 149
  // for each group of things in the new_results that is anchored by an unmoved                       // 150
  // element, iterate through the things before it.                                                   // 151
  var startOfGroup = 0;                                                                               // 152
  _.each(unmoved, function (endOfGroup) {                                                             // 153
    var groupId = new_results[endOfGroup] ? new_results[endOfGroup]._id : null;                       // 154
    var oldDoc;                                                                                       // 155
    var newDoc;                                                                                       // 156
    var fields;                                                                                       // 157
    for (var i = startOfGroup; i < endOfGroup; i++) {                                                 // 158
      newDoc = new_results[i];                                                                        // 159
      if (!_.has(old_index_of_id, newDoc._id)) {                                                      // 160
        fields = EJSON.clone(newDoc);                                                                 // 161
        delete fields._id;                                                                            // 162
        observer.addedBefore && observer.addedBefore(newDoc._id, fields, groupId);                    // 163
        observer.added && observer.added(newDoc._id, fields);                                         // 164
      } else {                                                                                        // 165
        // moved                                                                                      // 166
        oldDoc = old_results[old_index_of_id[newDoc._id]];                                            // 167
        fields = LocalCollection._makeChangedFields(newDoc, oldDoc);                                  // 168
        if (!_.isEmpty(fields)) {                                                                     // 169
          observer.changed && observer.changed(newDoc._id, fields);                                   // 170
        }                                                                                             // 171
        observer.movedBefore && observer.movedBefore(newDoc._id, groupId);                            // 172
      }                                                                                               // 173
    }                                                                                                 // 174
    if (groupId) {                                                                                    // 175
      newDoc = new_results[endOfGroup];                                                               // 176
      oldDoc = old_results[old_index_of_id[newDoc._id]];                                              // 177
      fields = LocalCollection._makeChangedFields(newDoc, oldDoc);                                    // 178
      if (!_.isEmpty(fields)) {                                                                       // 179
        observer.changed && observer.changed(newDoc._id, fields);                                     // 180
      }                                                                                               // 181
    }                                                                                                 // 182
    startOfGroup = endOfGroup+1;                                                                      // 183
  });                                                                                                 // 184
                                                                                                      // 185
                                                                                                      // 186
};                                                                                                    // 187
                                                                                                      // 188
                                                                                                      // 189
// General helper for diff-ing two objects.                                                           // 190
// callbacks is an object like so:                                                                    // 191
// { leftOnly: function (key, leftValue) {...},                                                       // 192
//   rightOnly: function (key, rightValue) {...},                                                     // 193
//   both: function (key, leftValue, rightValue) {...},                                               // 194
// }                                                                                                  // 195
LocalCollection._diffObjects = function (left, right, callbacks) {                                    // 196
  _.each(left, function (leftValue, key) {                                                            // 197
    if (_.has(right, key))                                                                            // 198
      callbacks.both && callbacks.both(key, leftValue, right[key]);                                   // 199
    else                                                                                              // 200
      callbacks.leftOnly && callbacks.leftOnly(key, leftValue);                                       // 201
  });                                                                                                 // 202
  if (callbacks.rightOnly) {                                                                          // 203
    _.each(right, function(rightValue, key) {                                                         // 204
      if (!_.has(left, key))                                                                          // 205
        callbacks.rightOnly(key, rightValue);                                                         // 206
    });                                                                                               // 207
  }                                                                                                   // 208
};                                                                                                    // 209
                                                                                                      // 210
////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                    //
// packages/minimongo/id_map.js                                                                       //
//                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                      //
LocalCollection._IdMap = function () {                                                                // 1
  var self = this;                                                                                    // 2
  self._map = {};                                                                                     // 3
};                                                                                                    // 4
                                                                                                      // 5
// Some of these methods are designed to match methods on OrderedDict, since                          // 6
// (eg) ObserveMultiplex and _CachingChangeObserver use them interchangeably.                         // 7
// (Conceivably, this should be replaced with "UnorderedDict" with a specific                         // 8
// set of methods that overlap between the two.)                                                      // 9
                                                                                                      // 10
_.extend(LocalCollection._IdMap.prototype, {                                                          // 11
  get: function (id) {                                                                                // 12
    var self = this;                                                                                  // 13
    var key = LocalCollection._idStringify(id);                                                       // 14
    return self._map[key];                                                                            // 15
  },                                                                                                  // 16
  set: function (id, value) {                                                                         // 17
    var self = this;                                                                                  // 18
    var key = LocalCollection._idStringify(id);                                                       // 19
    self._map[key] = value;                                                                           // 20
  },                                                                                                  // 21
  remove: function (id) {                                                                             // 22
    var self = this;                                                                                  // 23
    var key = LocalCollection._idStringify(id);                                                       // 24
    delete self._map[key];                                                                            // 25
  },                                                                                                  // 26
  has: function (id) {                                                                                // 27
    var self = this;                                                                                  // 28
    var key = LocalCollection._idStringify(id);                                                       // 29
    return _.has(self._map, key);                                                                     // 30
  },                                                                                                  // 31
  empty: function () {                                                                                // 32
    var self = this;                                                                                  // 33
    return _.isEmpty(self._map);                                                                      // 34
  },                                                                                                  // 35
  clear: function () {                                                                                // 36
    var self = this;                                                                                  // 37
    self._map = {};                                                                                   // 38
  },                                                                                                  // 39
  // Iterates over the items in the map. Return `false` to break the loop.                            // 40
  forEach: function (iterator) {                                                                      // 41
    var self = this;                                                                                  // 42
    // don't use _.each, because we can't break out of it.                                            // 43
    var keys = _.keys(self._map);                                                                     // 44
    for (var i = 0; i < keys.length; i++) {                                                           // 45
      var breakIfFalse = iterator.call(null, self._map[keys[i]],                                      // 46
                                       LocalCollection._idParse(keys[i]));                            // 47
      if (breakIfFalse === false)                                                                     // 48
        return;                                                                                       // 49
    }                                                                                                 // 50
  },                                                                                                  // 51
  size: function () {                                                                                 // 52
    var self = this;                                                                                  // 53
    return _.size(self._map);                                                                         // 54
  },                                                                                                  // 55
  setDefault: function (id, def) {                                                                    // 56
    var self = this;                                                                                  // 57
    var key = LocalCollection._idStringify(id);                                                       // 58
    if (_.has(self._map, key))                                                                        // 59
      return self._map[key];                                                                          // 60
    self._map[key] = def;                                                                             // 61
    return def;                                                                                       // 62
  },                                                                                                  // 63
  // Assumes that values are EJSON-cloneable, and that we don't need to clone                         // 64
  // IDs (ie, that nobody is going to mutate an ObjectId).                                            // 65
  clone: function () {                                                                                // 66
    var self = this;                                                                                  // 67
    var clone = new LocalCollection._IdMap;                                                           // 68
    self.forEach(function (value, id) {                                                               // 69
      clone.set(id, EJSON.clone(value));                                                              // 70
      });                                                                                             // 71
    return clone;                                                                                     // 72
  }                                                                                                   // 73
});                                                                                                   // 74
                                                                                                      // 75
////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                    //
// packages/minimongo/observe.js                                                                      //
//                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                      //
// XXX maybe move these into another ObserveHelpers package or something                              // 1
                                                                                                      // 2
// _CachingChangeObserver is an object which receives observeChanges callbacks                        // 3
// and keeps a cache of the current cursor state up to date in self.docs. Users                       // 4
// of this class should read the docs field but not modify it. You should pass                        // 5
// the "applyChange" field as the callbacks to the underlying observeChanges                          // 6
// call. Optionally, you can specify your own observeChanges callbacks which are                      // 7
// invoked immediately before the docs field is updated; this object is made                          // 8
// available as `this` to those callbacks.                                                            // 9
LocalCollection._CachingChangeObserver = function (options) {                                         // 10
  var self = this;                                                                                    // 11
  options = options || {};                                                                            // 12
                                                                                                      // 13
  var orderedFromCallbacks = options.callbacks &&                                                     // 14
        LocalCollection._observeChangesCallbacksAreOrdered(options.callbacks);                        // 15
  if (_.has(options, 'ordered')) {                                                                    // 16
    self.ordered = options.ordered;                                                                   // 17
    if (options.callbacks && options.ordered !== orderedFromCallbacks)                                // 18
      throw Error("ordered option doesn't match callbacks");                                          // 19
  } else if (options.callbacks) {                                                                     // 20
    self.ordered = orderedFromCallbacks;                                                              // 21
  } else {                                                                                            // 22
    throw Error("must provide ordered or callbacks");                                                 // 23
  }                                                                                                   // 24
  var callbacks = options.callbacks || {};                                                            // 25
                                                                                                      // 26
  if (self.ordered) {                                                                                 // 27
    self.docs = new OrderedDict(LocalCollection._idStringify);                                        // 28
    self.applyChange = {                                                                              // 29
      addedBefore: function (id, fields, before) {                                                    // 30
        var doc = EJSON.clone(fields);                                                                // 31
        doc._id = id;                                                                                 // 32
        callbacks.addedBefore && callbacks.addedBefore.call(                                          // 33
          self, id, fields, before);                                                                  // 34
        // This line triggers if we provide added with movedBefore.                                   // 35
        callbacks.added && callbacks.added.call(self, id, fields);                                    // 36
        // XXX could `before` be a falsy ID?  Technically                                             // 37
        // idStringify seems to allow for them -- though                                              // 38
        // OrderedDict won't call stringify on a falsy arg.                                           // 39
        self.docs.putBefore(id, doc, before || null);                                                 // 40
      },                                                                                              // 41
      movedBefore: function (id, before) {                                                            // 42
        var doc = self.docs.get(id);                                                                  // 43
        callbacks.movedBefore && callbacks.movedBefore.call(self, id, before);                        // 44
        self.docs.moveBefore(id, before || null);                                                     // 45
      }                                                                                               // 46
    };                                                                                                // 47
  } else {                                                                                            // 48
    self.docs = new LocalCollection._IdMap;                                                           // 49
    self.applyChange = {                                                                              // 50
      added: function (id, fields) {                                                                  // 51
        var doc = EJSON.clone(fields);                                                                // 52
        callbacks.added && callbacks.added.call(self, id, fields);                                    // 53
        doc._id = id;                                                                                 // 54
        self.docs.set(id,  doc);                                                                      // 55
      }                                                                                               // 56
    };                                                                                                // 57
  }                                                                                                   // 58
                                                                                                      // 59
  // The methods in _IdMap and OrderedDict used by these callbacks are                                // 60
  // identical.                                                                                       // 61
  self.applyChange.changed = function (id, fields) {                                                  // 62
    var doc = self.docs.get(id);                                                                      // 63
    if (!doc)                                                                                         // 64
      throw new Error("Unknown id for changed: " + id);                                               // 65
    callbacks.changed && callbacks.changed.call(                                                      // 66
      self, id, EJSON.clone(fields));                                                                 // 67
    LocalCollection._applyChanges(doc, fields);                                                       // 68
  };                                                                                                  // 69
  self.applyChange.removed = function (id) {                                                          // 70
    callbacks.removed && callbacks.removed.call(self, id);                                            // 71
    self.docs.remove(id);                                                                             // 72
  };                                                                                                  // 73
};                                                                                                    // 74
                                                                                                      // 75
LocalCollection._observeFromObserveChanges = function (cursor, observeCallbacks) {                    // 76
  var transform = cursor.getTransform() || function (doc) {return doc;};                              // 77
  var suppressed = !!observeCallbacks._suppress_initial;                                              // 78
                                                                                                      // 79
  var observeChangesCallbacks;                                                                        // 80
  if (LocalCollection._observeCallbacksAreOrdered(observeCallbacks)) {                                // 81
    // The "_no_indices" option sets all index arguments to -1 and skips the                          // 82
    // linear scans required to generate them.  This lets observers that don't                        // 83
    // need absolute indices benefit from the other features of this API --                           // 84
    // relative order, transforms, and applyChanges -- without the speed hit.                         // 85
    var indices = !observeCallbacks._no_indices;                                                      // 86
    observeChangesCallbacks = {                                                                       // 87
      addedBefore: function (id, fields, before) {                                                    // 88
        var self = this;                                                                              // 89
        if (suppressed || !(observeCallbacks.addedAt || observeCallbacks.added))                      // 90
          return;                                                                                     // 91
        var doc = transform(_.extend(fields, {_id: id}));                                             // 92
        if (observeCallbacks.addedAt) {                                                               // 93
          var index = indices                                                                         // 94
                ? (before ? self.docs.indexOf(before) : self.docs.size()) : -1;                       // 95
          observeCallbacks.addedAt(doc, index, before);                                               // 96
        } else {                                                                                      // 97
          observeCallbacks.added(doc);                                                                // 98
        }                                                                                             // 99
      },                                                                                              // 100
      changed: function (id, fields) {                                                                // 101
        var self = this;                                                                              // 102
        if (!(observeCallbacks.changedAt || observeCallbacks.changed))                                // 103
          return;                                                                                     // 104
        var doc = EJSON.clone(self.docs.get(id));                                                     // 105
        if (!doc)                                                                                     // 106
          throw new Error("Unknown id for changed: " + id);                                           // 107
        var oldDoc = transform(EJSON.clone(doc));                                                     // 108
        LocalCollection._applyChanges(doc, fields);                                                   // 109
        doc = transform(doc);                                                                         // 110
        if (observeCallbacks.changedAt) {                                                             // 111
          var index = indices ? self.docs.indexOf(id) : -1;                                           // 112
          observeCallbacks.changedAt(doc, oldDoc, index);                                             // 113
        } else {                                                                                      // 114
          observeCallbacks.changed(doc, oldDoc);                                                      // 115
        }                                                                                             // 116
      },                                                                                              // 117
      movedBefore: function (id, before) {                                                            // 118
        var self = this;                                                                              // 119
        if (!observeCallbacks.movedTo)                                                                // 120
          return;                                                                                     // 121
        var from = indices ? self.docs.indexOf(id) : -1;                                              // 122
                                                                                                      // 123
        var to = indices                                                                              // 124
              ? (before ? self.docs.indexOf(before) : self.docs.size()) : -1;                         // 125
        // When not moving backwards, adjust for the fact that removing the                           // 126
        // document slides everything back one slot.                                                  // 127
        if (to > from)                                                                                // 128
          --to;                                                                                       // 129
        observeCallbacks.movedTo(transform(EJSON.clone(self.docs.get(id))),                           // 130
                                 from, to, before || null);                                           // 131
      },                                                                                              // 132
      removed: function (id) {                                                                        // 133
        var self = this;                                                                              // 134
        if (!(observeCallbacks.removedAt || observeCallbacks.removed))                                // 135
          return;                                                                                     // 136
        // technically maybe there should be an EJSON.clone here, but it's about                      // 137
        // to be removed from self.docs!                                                              // 138
        var doc = transform(self.docs.get(id));                                                       // 139
        if (observeCallbacks.removedAt) {                                                             // 140
          var index = indices ? self.docs.indexOf(id) : -1;                                           // 141
          observeCallbacks.removedAt(doc, index);                                                     // 142
        } else {                                                                                      // 143
          observeCallbacks.removed(doc);                                                              // 144
        }                                                                                             // 145
      }                                                                                               // 146
    };                                                                                                // 147
  } else {                                                                                            // 148
    observeChangesCallbacks = {                                                                       // 149
      added: function (id, fields) {                                                                  // 150
        if (!suppressed && observeCallbacks.added) {                                                  // 151
          var doc = _.extend(fields, {_id:  id});                                                     // 152
          observeCallbacks.added(transform(doc));                                                     // 153
        }                                                                                             // 154
      },                                                                                              // 155
      changed: function (id, fields) {                                                                // 156
        var self = this;                                                                              // 157
        if (observeCallbacks.changed) {                                                               // 158
          var oldDoc = self.docs.get(id);                                                             // 159
          var doc = EJSON.clone(oldDoc);                                                              // 160
          LocalCollection._applyChanges(doc, fields);                                                 // 161
          observeCallbacks.changed(transform(doc), transform(oldDoc));                                // 162
        }                                                                                             // 163
      },                                                                                              // 164
      removed: function (id) {                                                                        // 165
        var self = this;                                                                              // 166
        if (observeCallbacks.removed) {                                                               // 167
          observeCallbacks.removed(transform(self.docs.get(id)));                                     // 168
        }                                                                                             // 169
      }                                                                                               // 170
    };                                                                                                // 171
  }                                                                                                   // 172
                                                                                                      // 173
  var changeObserver = new LocalCollection._CachingChangeObserver(                                    // 174
    {callbacks: observeChangesCallbacks});                                                            // 175
  var handle = cursor.observeChanges(changeObserver.applyChange);                                     // 176
  suppressed = false;                                                                                 // 177
                                                                                                      // 178
  if (changeObserver.ordered) {                                                                       // 179
    // Fetches the current list of documents, in order, as an array.  Can be                          // 180
    // called at any time.  Internal API assumed by the `observe-sequence`                            // 181
    // package (used by Meteor UI for `#each` blocks).  Only defined on ordered                       // 182
    // observes (those that listen on `addedAt` or similar).  Continues to work                       // 183
    // after `stop()` is called on the handle.                                                        // 184
    //                                                                                                // 185
    // Because we already materialize the full OrderedDict of all documents, it                       // 186
    // seems nice to provide access to the view rather than making the data                           // 187
    // consumer reconstitute it.  This gives the consumer a shot at doing                             // 188
    // something smart with the feed like proxying it, since firing callbacks                         // 189
    // like `changed` and `movedTo` basically requires omniscience (knowing old                       // 190
    // and new documents, old and new indices, and the correct value for                              // 191
    // `before`).                                                                                     // 192
    //                                                                                                // 193
    // NOTE: If called from an observe callback for a certain change, the result                      // 194
    // is *not* guaranteed to be a snapshot of the cursor up to that                                  // 195
    // change. This is because the callbacks are invoked before updating docs.                        // 196
    handle._fetch = function () {                                                                     // 197
      var docsArray = [];                                                                             // 198
      changeObserver.docs.forEach(function (doc) {                                                    // 199
        docsArray.push(transform(EJSON.clone(doc)));                                                  // 200
      });                                                                                             // 201
      return docsArray;                                                                               // 202
    };                                                                                                // 203
  }                                                                                                   // 204
                                                                                                      // 205
  return handle;                                                                                      // 206
};                                                                                                    // 207
                                                                                                      // 208
////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                    //
// packages/minimongo/objectid.js                                                                     //
//                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                      //
LocalCollection._looksLikeObjectID = function (str) {                                                 // 1
  return str.length === 24 && str.match(/^[0-9a-f]*$/);                                               // 2
};                                                                                                    // 3
                                                                                                      // 4
LocalCollection._ObjectID = function (hexString) {                                                    // 5
  //random-based impl of Mongo ObjectID                                                               // 6
  var self = this;                                                                                    // 7
  if (hexString) {                                                                                    // 8
    hexString = hexString.toLowerCase();                                                              // 9
    if (!LocalCollection._looksLikeObjectID(hexString)) {                                             // 10
      throw new Error("Invalid hexadecimal string for creating an ObjectID");                         // 11
    }                                                                                                 // 12
    // meant to work with _.isEqual(), which relies on structural equality                            // 13
    self._str = hexString;                                                                            // 14
  } else {                                                                                            // 15
    self._str = Random.hexString(24);                                                                 // 16
  }                                                                                                   // 17
};                                                                                                    // 18
                                                                                                      // 19
LocalCollection._ObjectID.prototype.toString = function () {                                          // 20
  var self = this;                                                                                    // 21
  return "ObjectID(\"" + self._str + "\")";                                                           // 22
};                                                                                                    // 23
                                                                                                      // 24
LocalCollection._ObjectID.prototype.equals = function (other) {                                       // 25
  var self = this;                                                                                    // 26
  return other instanceof LocalCollection._ObjectID &&                                                // 27
    self.valueOf() === other.valueOf();                                                               // 28
};                                                                                                    // 29
                                                                                                      // 30
LocalCollection._ObjectID.prototype.clone = function () {                                             // 31
  var self = this;                                                                                    // 32
  return new LocalCollection._ObjectID(self._str);                                                    // 33
};                                                                                                    // 34
                                                                                                      // 35
LocalCollection._ObjectID.prototype.typeName = function() {                                           // 36
  return "oid";                                                                                       // 37
};                                                                                                    // 38
                                                                                                      // 39
LocalCollection._ObjectID.prototype.getTimestamp = function() {                                       // 40
  var self = this;                                                                                    // 41
  return parseInt(self._str.substr(0, 8), 16);                                                        // 42
};                                                                                                    // 43
                                                                                                      // 44
LocalCollection._ObjectID.prototype.valueOf =                                                         // 45
    LocalCollection._ObjectID.prototype.toJSONValue =                                                 // 46
    LocalCollection._ObjectID.prototype.toHexString =                                                 // 47
    function () { return this._str; };                                                                // 48
                                                                                                      // 49
// Is this selector just shorthand for lookup by _id?                                                 // 50
LocalCollection._selectorIsId = function (selector) {                                                 // 51
  return (typeof selector === "string") ||                                                            // 52
    (typeof selector === "number") ||                                                                 // 53
    selector instanceof LocalCollection._ObjectID;                                                    // 54
};                                                                                                    // 55
                                                                                                      // 56
// Is the selector just lookup by _id (shorthand or not)?                                             // 57
LocalCollection._selectorIsIdPerhapsAsObject = function (selector) {                                  // 58
  return LocalCollection._selectorIsId(selector) ||                                                   // 59
    (selector && typeof selector === "object" &&                                                      // 60
     selector._id && LocalCollection._selectorIsId(selector._id) &&                                   // 61
     _.size(selector) === 1);                                                                         // 62
};                                                                                                    // 63
                                                                                                      // 64
// If this is a selector which explicitly constrains the match by ID to a finite                      // 65
// number of documents, returns a list of their IDs.  Otherwise returns                               // 66
// null. Note that the selector may have other restrictions so it may not even                        // 67
// match those document!  We care about $in and $and since those are generated                        // 68
// access-controlled update and remove.                                                               // 69
LocalCollection._idsMatchedBySelector = function (selector) {                                         // 70
  // Is the selector just an ID?                                                                      // 71
  if (LocalCollection._selectorIsId(selector))                                                        // 72
    return [selector];                                                                                // 73
  if (!selector)                                                                                      // 74
    return null;                                                                                      // 75
                                                                                                      // 76
  // Do we have an _id clause?                                                                        // 77
  if (_.has(selector, '_id')) {                                                                       // 78
    // Is the _id clause just an ID?                                                                  // 79
    if (LocalCollection._selectorIsId(selector._id))                                                  // 80
      return [selector._id];                                                                          // 81
    // Is the _id clause {_id: {$in: ["x", "y", "z"]}}?                                               // 82
    if (selector._id && selector._id.$in                                                              // 83
        && _.isArray(selector._id.$in)                                                                // 84
        && !_.isEmpty(selector._id.$in)                                                               // 85
        && _.all(selector._id.$in, LocalCollection._selectorIsId)) {                                  // 86
      return selector._id.$in;                                                                        // 87
    }                                                                                                 // 88
    return null;                                                                                      // 89
  }                                                                                                   // 90
                                                                                                      // 91
  // If this is a top-level $and, and any of the clauses constrain their                              // 92
  // documents, then the whole selector is constrained by any one clause's                            // 93
  // constraint. (Well, by their intersection, but that seems unlikely.)                              // 94
  if (selector.$and && _.isArray(selector.$and)) {                                                    // 95
    for (var i = 0; i < selector.$and.length; ++i) {                                                  // 96
      var subIds = LocalCollection._idsMatchedBySelector(selector.$and[i]);                           // 97
      if (subIds)                                                                                     // 98
        return subIds;                                                                                // 99
    }                                                                                                 // 100
  }                                                                                                   // 101
                                                                                                      // 102
  return null;                                                                                        // 103
};                                                                                                    // 104
                                                                                                      // 105
EJSON.addType("oid",  function (str) {                                                                // 106
  return new LocalCollection._ObjectID(str);                                                          // 107
});                                                                                                   // 108
                                                                                                      // 109
////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                    //
// packages/minimongo/selector_projection.js                                                          //
//                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                      //
// Knows how to combine a mongo selector and a fields projection to a new fields                      // 1
// projection taking into account active fields from the passed selector.                             // 2
// @returns Object - projection object (same as fields option of mongo cursor)                        // 3
Minimongo.Matcher.prototype.combineIntoProjection = function (projection) {                           // 4
  var self = this;                                                                                    // 5
  var selectorPaths = self._getPathsElidingNumericKeys();                                             // 6
                                                                                                      // 7
  // Special case for $where operator in the selector - projection should depend                      // 8
  // on all fields of the document. getSelectorPaths returns a list of paths                          // 9
  // selector depends on. If one of the paths is '' (empty string) representing                       // 10
  // the root or the whole document, complete projection should be returned.                          // 11
  if (_.contains(selectorPaths, ''))                                                                  // 12
    return {};                                                                                        // 13
                                                                                                      // 14
  var prjDetails = projectionDetails(projection);                                                     // 15
  var tree = prjDetails.tree;                                                                         // 16
  var mergedProjection = {};                                                                          // 17
                                                                                                      // 18
  // merge the paths to include                                                                       // 19
  tree = pathsToTree(selectorPaths,                                                                   // 20
                     function (path) { return true; },                                                // 21
                     function (node, path, fullPath) { return true; },                                // 22
                     tree);                                                                           // 23
  mergedProjection = treeToPaths(tree);                                                               // 24
  if (prjDetails.including) {                                                                         // 25
    // both selector and projection are pointing on fields to include                                 // 26
    // so we can just return the merged tree                                                          // 27
    return mergedProjection;                                                                          // 28
  } else {                                                                                            // 29
    // selector is pointing at fields to include                                                      // 30
    // projection is pointing at fields to exclude                                                    // 31
    // make sure we don't exclude important paths                                                     // 32
    var mergedExclProjection = {};                                                                    // 33
    _.each(mergedProjection, function (incl, path) {                                                  // 34
      if (!incl)                                                                                      // 35
        mergedExclProjection[path] = false;                                                           // 36
    });                                                                                               // 37
                                                                                                      // 38
    return mergedExclProjection;                                                                      // 39
  }                                                                                                   // 40
};                                                                                                    // 41
                                                                                                      // 42
Minimongo.Matcher.prototype._getPathsElidingNumericKeys = function () {                               // 43
  var self = this;                                                                                    // 44
  return _.map(self._getPaths(), function (path) {                                                    // 45
    return _.reject(path.split('.'), isNumericKey).join('.');                                         // 46
  });                                                                                                 // 47
};                                                                                                    // 48
                                                                                                      // 49
// Returns a set of key paths similar to                                                              // 50
// { 'foo.bar': 1, 'a.b.c': 1 }                                                                       // 51
var treeToPaths = function (tree, prefix) {                                                           // 52
  prefix = prefix || '';                                                                              // 53
  var result = {};                                                                                    // 54
                                                                                                      // 55
  _.each(tree, function (val, key) {                                                                  // 56
    if (_.isObject(val))                                                                              // 57
      _.extend(result, treeToPaths(val, prefix + key + '.'));                                         // 58
    else                                                                                              // 59
      result[prefix + key] = val;                                                                     // 60
  });                                                                                                 // 61
                                                                                                      // 62
  return result;                                                                                      // 63
};                                                                                                    // 64
                                                                                                      // 65
                                                                                                      // 66
////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                    //
// packages/minimongo/selector_modifier.js                                                            //
//                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                      //
// Returns true if the modifier applied to some document may change the result                        // 1
// of matching the document by selector                                                               // 2
// The modifier is always in a form of Object:                                                        // 3
//  - $set                                                                                            // 4
//    - 'a.b.22.z': value                                                                             // 5
//    - 'foo.bar': 42                                                                                 // 6
//  - $unset                                                                                          // 7
//    - 'abc.d': 1                                                                                    // 8
Minimongo.Matcher.prototype.affectedByModifier = function (modifier) {                                // 9
  var self = this;                                                                                    // 10
  // safe check for $set/$unset being objects                                                         // 11
  modifier = _.extend({ $set: {}, $unset: {} }, modifier);                                            // 12
  var modifiedPaths = _.keys(modifier.$set).concat(_.keys(modifier.$unset));                          // 13
  var meaningfulPaths = self._getPaths();                                                             // 14
                                                                                                      // 15
  return _.any(modifiedPaths, function (path) {                                                       // 16
    var mod = path.split('.');                                                                        // 17
    return _.any(meaningfulPaths, function (meaningfulPath) {                                         // 18
      var sel = meaningfulPath.split('.');                                                            // 19
      var i = 0, j = 0;                                                                               // 20
                                                                                                      // 21
      while (i < sel.length && j < mod.length) {                                                      // 22
        if (isNumericKey(sel[i]) && isNumericKey(mod[j])) {                                           // 23
          // foo.4.bar selector affected by foo.4 modifier                                            // 24
          // foo.3.bar selector unaffected by foo.4 modifier                                          // 25
          if (sel[i] === mod[j])                                                                      // 26
            i++, j++;                                                                                 // 27
          else                                                                                        // 28
            return false;                                                                             // 29
        } else if (isNumericKey(sel[i])) {                                                            // 30
          // foo.4.bar selector unaffected by foo.bar modifier                                        // 31
          return false;                                                                               // 32
        } else if (isNumericKey(mod[j])) {                                                            // 33
          j++;                                                                                        // 34
        } else if (sel[i] === mod[j])                                                                 // 35
          i++, j++;                                                                                   // 36
        else                                                                                          // 37
          return false;                                                                               // 38
      }                                                                                               // 39
                                                                                                      // 40
      // One is a prefix of another, taking numeric fields into account                               // 41
      return true;                                                                                    // 42
    });                                                                                               // 43
  });                                                                                                 // 44
};                                                                                                    // 45
                                                                                                      // 46
// @param modifier - Object: MongoDB-styled modifier with `$set`s and `$unsets`                       // 47
//                           only. (assumed to come from oplog)                                       // 48
// @returns - Boolean: if after applying the modifier, selector can start                             // 49
//                     accepting the modified value.                                                  // 50
// NOTE: assumes that document affected by modifier didn't match this Matcher                         // 51
// before, so if modifier can't convince selector in a positive change it would                       // 52
// stay 'false'.                                                                                      // 53
// Currently doesn't support $-operators and numeric indices precisely.                               // 54
Minimongo.Matcher.prototype.canBecomeTrueByModifier = function (modifier) {                           // 55
  var self = this;                                                                                    // 56
  if (!this.affectedByModifier(modifier))                                                             // 57
    return false;                                                                                     // 58
                                                                                                      // 59
  modifier = _.extend({$set:{}, $unset:{}}, modifier);                                                // 60
  var modifierPaths = _.keys(modifier.$set).concat(_.keys(modifier.$unset));                          // 61
                                                                                                      // 62
  if (!self.isSimple())                                                                               // 63
    return true;                                                                                      // 64
                                                                                                      // 65
  if (_.any(self._getPaths(), pathHasNumericKeys) ||                                                  // 66
      _.any(modifierPaths, pathHasNumericKeys))                                                       // 67
    return true;                                                                                      // 68
                                                                                                      // 69
  // check if there is a $set or $unset that indicates something is an                                // 70
  // object rather than a scalar in the actual object where we saw $-operator                         // 71
  // NOTE: it is correct since we allow only scalars in $-operators                                   // 72
  // Example: for selector {'a.b': {$gt: 5}} the modifier {'a.b.c':7} would                           // 73
  // definitely set the result to false as 'a.b' appears to be an object.                             // 74
  var expectedScalarIsObject = _.any(self._selector, function (sel, path) {                           // 75
    if (! isOperatorObject(sel))                                                                      // 76
      return false;                                                                                   // 77
    return _.any(modifierPaths, function (modifierPath) {                                             // 78
      return startsWith(modifierPath, path + '.');                                                    // 79
    });                                                                                               // 80
  });                                                                                                 // 81
                                                                                                      // 82
  if (expectedScalarIsObject)                                                                         // 83
    return false;                                                                                     // 84
                                                                                                      // 85
  // See if we can apply the modifier on the ideally matching object. If it                           // 86
  // still matches the selector, then the modifier could have turned the real                         // 87
  // object in the database into something matching.                                                  // 88
  var matchingDocument = EJSON.clone(self.matchingDocument());                                        // 89
                                                                                                      // 90
  // The selector is too complex, anything can happen.                                                // 91
  if (matchingDocument === null)                                                                      // 92
    return true;                                                                                      // 93
                                                                                                      // 94
  try {                                                                                               // 95
    LocalCollection._modify(matchingDocument, modifier);                                              // 96
  } catch (e) {                                                                                       // 97
    // Couldn't set a property on a field which is a scalar or null in the                            // 98
    // selector.                                                                                      // 99
    // Example:                                                                                       // 100
    // real document: { 'a.b': 3 }                                                                    // 101
    // selector: { 'a': 12 }                                                                          // 102
    // converted selector (ideal document): { 'a': 12 }                                               // 103
    // modifier: { $set: { 'a.b': 4 } }                                                               // 104
    // We don't know what real document was like but from the error raised by                         // 105
    // $set on a scalar field we can reason that the structure of real document                       // 106
    // is completely different.                                                                       // 107
    if (e.name === "MinimongoError" && e.setPropertyError)                                            // 108
      return false;                                                                                   // 109
    throw e;                                                                                          // 110
  }                                                                                                   // 111
                                                                                                      // 112
  return self.documentMatches(matchingDocument).result;                                               // 113
};                                                                                                    // 114
                                                                                                      // 115
// Returns an object that would match the selector if possible or null if the                         // 116
// selector is too complex for us to analyze                                                          // 117
// { 'a.b': { ans: 42 }, 'foo.bar': null, 'foo.baz': "something" }                                    // 118
// => { a: { b: { ans: 42 } }, foo: { bar: null, baz: "something" } }                                 // 119
Minimongo.Matcher.prototype.matchingDocument = function () {                                          // 120
  var self = this;                                                                                    // 121
                                                                                                      // 122
  // check if it was computed before                                                                  // 123
  if (self._matchingDocument !== undefined)                                                           // 124
    return self._matchingDocument;                                                                    // 125
                                                                                                      // 126
  // If the analysis of this selector is too hard for our implementation                              // 127
  // fallback to "YES"                                                                                // 128
  var fallback = false;                                                                               // 129
  self._matchingDocument = pathsToTree(self._getPaths(),                                              // 130
    function (path) {                                                                                 // 131
      var valueSelector = self._selector[path];                                                       // 132
      if (isOperatorObject(valueSelector)) {                                                          // 133
        // if there is a strict equality, there is a good                                             // 134
        // chance we can use one of those as "matching"                                               // 135
        // dummy value                                                                                // 136
        if (valueSelector.$in) {                                                                      // 137
          var matcher = new Minimongo.Matcher({ placeholder: valueSelector });                        // 138
                                                                                                      // 139
          // Return anything from $in that matches the whole selector for this                        // 140
          // path. If nothing matches, returns `undefined` as nothing can make                        // 141
          // this selector into `true`.                                                               // 142
          return _.find(valueSelector.$in, function (x) {                                             // 143
            return matcher.documentMatches({ placeholder: x }).result;                                // 144
          });                                                                                         // 145
        } else if (onlyContainsKeys(valueSelector, ['$gt', '$gte', '$lt', '$lte'])) {                 // 146
          var lowerBound = -Infinity, upperBound = Infinity;                                          // 147
          _.each(['$lte', '$lt'], function (op) {                                                     // 148
            if (_.has(valueSelector, op) && valueSelector[op] < upperBound)                           // 149
              upperBound = valueSelector[op];                                                         // 150
          });                                                                                         // 151
          _.each(['$gte', '$gt'], function (op) {                                                     // 152
            if (_.has(valueSelector, op) && valueSelector[op] > lowerBound)                           // 153
              lowerBound = valueSelector[op];                                                         // 154
          });                                                                                         // 155
                                                                                                      // 156
          var middle = (lowerBound + upperBound) / 2;                                                 // 157
          var matcher = new Minimongo.Matcher({ placeholder: valueSelector });                        // 158
          if (!matcher.documentMatches({ placeholder: middle }).result &&                             // 159
              (middle === lowerBound || middle === upperBound))                                       // 160
            fallback = true;                                                                          // 161
                                                                                                      // 162
          return middle;                                                                              // 163
        } else if (onlyContainsKeys(valueSelector, ['$nin',' $ne'])) {                                // 164
          // Since self._isSimple makes sure $nin and $ne are not combined with                       // 165
          // objects or arrays, we can confidently return an empty object as it                       // 166
          // never matches any scalar.                                                                // 167
          return {};                                                                                  // 168
        } else {                                                                                      // 169
          fallback = true;                                                                            // 170
        }                                                                                             // 171
      }                                                                                               // 172
      return self._selector[path];                                                                    // 173
    },                                                                                                // 174
    _.identity /*conflict resolution is no resolution*/);                                             // 175
                                                                                                      // 176
  if (fallback)                                                                                       // 177
    self._matchingDocument = null;                                                                    // 178
                                                                                                      // 179
  return self._matchingDocument;                                                                      // 180
};                                                                                                    // 181
                                                                                                      // 182
var getPaths = function (sel) {                                                                       // 183
  return _.keys(new Minimongo.Matcher(sel)._paths);                                                   // 184
  return _.chain(sel).map(function (v, k) {                                                           // 185
    // we don't know how to handle $where because it can be anything                                  // 186
    if (k === "$where")                                                                               // 187
      return ''; // matches everything                                                                // 188
    // we branch from $or/$and/$nor operator                                                          // 189
    if (_.contains(['$or', '$and', '$nor'], k))                                                       // 190
      return _.map(v, getPaths);                                                                      // 191
    // the value is a literal or some comparison operator                                             // 192
    return k;                                                                                         // 193
  }).flatten().uniq().value();                                                                        // 194
};                                                                                                    // 195
                                                                                                      // 196
// A helper to ensure object has only certain keys                                                    // 197
var onlyContainsKeys = function (obj, keys) {                                                         // 198
  return _.all(obj, function (v, k) {                                                                 // 199
    return _.contains(keys, k);                                                                       // 200
  });                                                                                                 // 201
};                                                                                                    // 202
                                                                                                      // 203
var pathHasNumericKeys = function (path) {                                                            // 204
  return _.any(path.split('.'), isNumericKey);                                                        // 205
}                                                                                                     // 206
                                                                                                      // 207
// XXX from Underscore.String (http://epeli.github.com/underscore.string/)                            // 208
var startsWith = function(str, starts) {                                                              // 209
  return str.length >= starts.length &&                                                               // 210
    str.substring(0, starts.length) === starts;                                                       // 211
};                                                                                                    // 212
                                                                                                      // 213
                                                                                                      // 214
////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package.minimongo = {
  LocalCollection: LocalCollection,
  Minimongo: Minimongo,
  MinimongoTest: MinimongoTest
};

})();
