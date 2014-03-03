//////////////////////////////////////////////////////////////////////////
//                                                                      //
// This is a generated file. You can view the original                  //
// source in your browser if your browser supports source maps.         //
//                                                                      //
// If you are using Chrome, open the Developer Tools and click the gear //
// icon in its lower right corner. In the General Settings panel, turn  //
// on 'Enable source maps'.                                             //
//                                                                      //
// If you are using Firefox 23, go to `about:config` and set the        //
// `devtools.debugger.source-maps-enabled` preference to true.          //
// (The preference should be on by default in Firefox 24; versions      //
// older than 23 do not support source maps.)                           //
//                                                                      //
//////////////////////////////////////////////////////////////////////////


(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var _ = Package.underscore._;

/* Package-scope variables */
var Deps;

(function () {

//////////////////////////////////////////////////////////////////////////////////
//                                                                              //
// packages/deps/deps.js                                                        //
//                                                                              //
//////////////////////////////////////////////////////////////////////////////////
                                                                                //
//////////////////////////////////////////////////                              // 1
// Package docs at http://docs.meteor.com/#deps //                              // 2
//////////////////////////////////////////////////                              // 3
                                                                                // 4
Deps = {};                                                                      // 5
                                                                                // 6
// http://docs.meteor.com/#deps_active                                          // 7
Deps.active = false;                                                            // 8
                                                                                // 9
// http://docs.meteor.com/#deps_currentcomputation                              // 10
Deps.currentComputation = null;                                                 // 11
                                                                                // 12
var setCurrentComputation = function (c) {                                      // 13
  Deps.currentComputation = c;                                                  // 14
  Deps.active = !! c;                                                           // 15
};                                                                              // 16
                                                                                // 17
var _debugFunc = function () {                                                  // 18
  // lazy evaluation because `Meteor` does not exist right away                 // 19
  return (typeof Meteor !== "undefined" ? Meteor._debug :                       // 20
          ((typeof console !== "undefined") && console.log ? console.log :      // 21
           function () {}));                                                    // 22
};                                                                              // 23
                                                                                // 24
var nextId = 1;                                                                 // 25
// computations whose callbacks we should call at flush time                    // 26
var pendingComputations = [];                                                   // 27
// `true` if a Deps.flush is scheduled, or if we are in Deps.flush now          // 28
var willFlush = false;                                                          // 29
// `true` if we are in Deps.flush now                                           // 30
var inFlush = false;                                                            // 31
// `true` if we are computing a computation now, either first time              // 32
// or recompute.  This matches Deps.active unless we are inside                 // 33
// Deps.nonreactive, which nullfies currentComputation even though              // 34
// an enclosing computation may still be running.                               // 35
var inCompute = false;                                                          // 36
                                                                                // 37
var afterFlushCallbacks = [];                                                   // 38
                                                                                // 39
var requireFlush = function () {                                                // 40
  if (! willFlush) {                                                            // 41
    setTimeout(Deps.flush, 0);                                                  // 42
    willFlush = true;                                                           // 43
  }                                                                             // 44
};                                                                              // 45
                                                                                // 46
// Deps.Computation constructor is visible but private                          // 47
// (throws an error if you try to call it)                                      // 48
var constructingComputation = false;                                            // 49
                                                                                // 50
//                                                                              // 51
// http://docs.meteor.com/#deps_computation                                     // 52
//                                                                              // 53
Deps.Computation = function (f, parent) {                                       // 54
  if (! constructingComputation)                                                // 55
    throw new Error(                                                            // 56
      "Deps.Computation constructor is private; use Deps.autorun");             // 57
  constructingComputation = false;                                              // 58
                                                                                // 59
  var self = this;                                                              // 60
                                                                                // 61
  // http://docs.meteor.com/#computation_stopped                                // 62
  self.stopped = false;                                                         // 63
                                                                                // 64
  // http://docs.meteor.com/#computation_invalidated                            // 65
  self.invalidated = false;                                                     // 66
                                                                                // 67
  // http://docs.meteor.com/#computation_firstrun                               // 68
  self.firstRun = true;                                                         // 69
                                                                                // 70
  self._id = nextId++;                                                          // 71
  self._onInvalidateCallbacks = [];                                             // 72
  // the plan is at some point to use the parent relation                       // 73
  // to constrain the order that computations are processed                     // 74
  self._parent = parent;                                                        // 75
  self._func = f;                                                               // 76
  self._recomputing = false;                                                    // 77
                                                                                // 78
  var errored = true;                                                           // 79
  try {                                                                         // 80
    self._compute();                                                            // 81
    errored = false;                                                            // 82
  } finally {                                                                   // 83
    self.firstRun = false;                                                      // 84
    if (errored)                                                                // 85
      self.stop();                                                              // 86
  }                                                                             // 87
};                                                                              // 88
                                                                                // 89
_.extend(Deps.Computation.prototype, {                                          // 90
                                                                                // 91
  // http://docs.meteor.com/#computation_oninvalidate                           // 92
  onInvalidate: function (f) {                                                  // 93
    var self = this;                                                            // 94
                                                                                // 95
    if (typeof f !== 'function')                                                // 96
      throw new Error("onInvalidate requires a function");                      // 97
                                                                                // 98
    var g = function () {                                                       // 99
      Deps.nonreactive(function () {                                            // 100
        return Meteor._noYieldsAllowed(function () {                            // 101
          f(self);                                                              // 102
        });                                                                     // 103
      });                                                                       // 104
    };                                                                          // 105
                                                                                // 106
    if (self.invalidated)                                                       // 107
      g();                                                                      // 108
    else                                                                        // 109
      self._onInvalidateCallbacks.push(g);                                      // 110
  },                                                                            // 111
                                                                                // 112
  // http://docs.meteor.com/#computation_invalidate                             // 113
  invalidate: function () {                                                     // 114
    var self = this;                                                            // 115
    if (! self.invalidated) {                                                   // 116
      // if we're currently in _recompute(), don't enqueue                      // 117
      // ourselves, since we'll rerun immediately anyway.                       // 118
      if (! self._recomputing && ! self.stopped) {                              // 119
        requireFlush();                                                         // 120
        pendingComputations.push(this);                                         // 121
      }                                                                         // 122
                                                                                // 123
      self.invalidated = true;                                                  // 124
                                                                                // 125
      // callbacks can't add callbacks, because                                 // 126
      // self.invalidated === true.                                             // 127
      for(var i = 0, f; f = self._onInvalidateCallbacks[i]; i++)                // 128
        f(); // already bound with self as argument                             // 129
      self._onInvalidateCallbacks = [];                                         // 130
    }                                                                           // 131
  },                                                                            // 132
                                                                                // 133
  // http://docs.meteor.com/#computation_stop                                   // 134
  stop: function () {                                                           // 135
    if (! this.stopped) {                                                       // 136
      this.stopped = true;                                                      // 137
      this.invalidate();                                                        // 138
    }                                                                           // 139
  },                                                                            // 140
                                                                                // 141
  _compute: function () {                                                       // 142
    var self = this;                                                            // 143
    self.invalidated = false;                                                   // 144
                                                                                // 145
    var previous = Deps.currentComputation;                                     // 146
    setCurrentComputation(self);                                                // 147
    var previousInCompute = inCompute;                                          // 148
    inCompute = true;                                                           // 149
    try {                                                                       // 150
      self._func(self);                                                         // 151
    } finally {                                                                 // 152
      setCurrentComputation(previous);                                          // 153
      inCompute = false;                                                        // 154
    }                                                                           // 155
  },                                                                            // 156
                                                                                // 157
  _recompute: function () {                                                     // 158
    var self = this;                                                            // 159
                                                                                // 160
    self._recomputing = true;                                                   // 161
    while (self.invalidated && ! self.stopped) {                                // 162
      try {                                                                     // 163
        self._compute();                                                        // 164
      } catch (e) {                                                             // 165
        _debugFunc()("Exception from Deps recompute:", e.stack || e.message);   // 166
      }                                                                         // 167
      // If _compute() invalidated us, we run again immediately.                // 168
      // A computation that invalidates itself indefinitely is an               // 169
      // infinite loop, of course.                                              // 170
      //                                                                        // 171
      // We could put an iteration counter here and catch run-away              // 172
      // loops.                                                                 // 173
    }                                                                           // 174
    self._recomputing = false;                                                  // 175
  }                                                                             // 176
});                                                                             // 177
                                                                                // 178
//                                                                              // 179
// http://docs.meteor.com/#deps_dependency                                      // 180
//                                                                              // 181
Deps.Dependency = function () {                                                 // 182
  this._dependentsById = {};                                                    // 183
};                                                                              // 184
                                                                                // 185
_.extend(Deps.Dependency.prototype, {                                           // 186
  // http://docs.meteor.com/#dependency_depend                                  // 187
  //                                                                            // 188
  // Adds `computation` to this set if it is not already                        // 189
  // present.  Returns true if `computation` is a new member of the set.        // 190
  // If no argument, defaults to currentComputation, or does nothing            // 191
  // if there is no currentComputation.                                         // 192
  depend: function (computation) {                                              // 193
    if (! computation) {                                                        // 194
      if (! Deps.active)                                                        // 195
        return false;                                                           // 196
                                                                                // 197
      computation = Deps.currentComputation;                                    // 198
    }                                                                           // 199
    var self = this;                                                            // 200
    var id = computation._id;                                                   // 201
    if (! (id in self._dependentsById)) {                                       // 202
      self._dependentsById[id] = computation;                                   // 203
      computation.onInvalidate(function () {                                    // 204
        delete self._dependentsById[id];                                        // 205
      });                                                                       // 206
      return true;                                                              // 207
    }                                                                           // 208
    return false;                                                               // 209
  },                                                                            // 210
                                                                                // 211
  // http://docs.meteor.com/#dependency_changed                                 // 212
  changed: function () {                                                        // 213
    var self = this;                                                            // 214
    for (var id in self._dependentsById)                                        // 215
      self._dependentsById[id].invalidate();                                    // 216
  },                                                                            // 217
                                                                                // 218
  // http://docs.meteor.com/#dependency_hasdependents                           // 219
  hasDependents: function () {                                                  // 220
    var self = this;                                                            // 221
    for(var id in self._dependentsById)                                         // 222
      return true;                                                              // 223
    return false;                                                               // 224
  }                                                                             // 225
});                                                                             // 226
                                                                                // 227
_.extend(Deps, {                                                                // 228
  // http://docs.meteor.com/#deps_flush                                         // 229
  flush: function () {                                                          // 230
    // Nested flush could plausibly happen if, say, a flush causes              // 231
    // DOM mutation, which causes a "blur" event, which runs an                 // 232
    // app event handler that calls Deps.flush.  At the moment                  // 233
    // Spark blocks event handlers during DOM mutation anyway,                  // 234
    // because the LiveRange tree isn't valid.  And we don't have               // 235
    // any useful notion of a nested flush.                                     // 236
    //                                                                          // 237
    // https://app.asana.com/0/159908330244/385138233856                        // 238
    if (inFlush)                                                                // 239
      throw new Error("Can't call Deps.flush while flushing");                  // 240
                                                                                // 241
    if (inCompute)                                                              // 242
      throw new Error("Can't flush inside Deps.autorun");                       // 243
                                                                                // 244
    inFlush = true;                                                             // 245
    willFlush = true;                                                           // 246
                                                                                // 247
    while (pendingComputations.length ||                                        // 248
           afterFlushCallbacks.length) {                                        // 249
                                                                                // 250
      // recompute all pending computations                                     // 251
      var comps = pendingComputations;                                          // 252
      pendingComputations = [];                                                 // 253
                                                                                // 254
      for (var i = 0, comp; comp = comps[i]; i++)                               // 255
        comp._recompute();                                                      // 256
                                                                                // 257
      if (afterFlushCallbacks.length) {                                         // 258
        // call one afterFlush callback, which may                              // 259
        // invalidate more computations                                         // 260
        var func = afterFlushCallbacks.shift();                                 // 261
        try {                                                                   // 262
          func();                                                               // 263
        } catch (e) {                                                           // 264
          _debugFunc()("Exception from Deps afterFlush function:",              // 265
                       e.stack || e.message);                                   // 266
        }                                                                       // 267
      }                                                                         // 268
    }                                                                           // 269
                                                                                // 270
    inFlush = false;                                                            // 271
    willFlush = false;                                                          // 272
  },                                                                            // 273
                                                                                // 274
  // http://docs.meteor.com/#deps_autorun                                       // 275
  //                                                                            // 276
  // Run f(). Record its dependencies. Rerun it whenever the                    // 277
  // dependencies change.                                                       // 278
  //                                                                            // 279
  // Returns a new Computation, which is also passed to f.                      // 280
  //                                                                            // 281
  // Links the computation to the current computation                           // 282
  // so that it is stopped if the current computation is invalidated.           // 283
  autorun: function (f) {                                                       // 284
    if (typeof f !== 'function')                                                // 285
      throw new Error('Deps.autorun requires a function argument');             // 286
                                                                                // 287
    constructingComputation = true;                                             // 288
    var c = new Deps.Computation(function (c) {                                 // 289
      Meteor._noYieldsAllowed(_.bind(f, this, c));                              // 290
    }, Deps.currentComputation);                                                // 291
                                                                                // 292
    if (Deps.active)                                                            // 293
      Deps.onInvalidate(function () {                                           // 294
        c.stop();                                                               // 295
      });                                                                       // 296
                                                                                // 297
    return c;                                                                   // 298
  },                                                                            // 299
                                                                                // 300
  // http://docs.meteor.com/#deps_nonreactive                                   // 301
  //                                                                            // 302
  // Run `f` with no current computation, returning the return value            // 303
  // of `f`.  Used to turn off reactivity for the duration of `f`,              // 304
  // so that reactive data sources accessed by `f` will not result in any       // 305
  // computations being invalidated.                                            // 306
  nonreactive: function (f) {                                                   // 307
    var previous = Deps.currentComputation;                                     // 308
    setCurrentComputation(null);                                                // 309
    try {                                                                       // 310
      return f();                                                               // 311
    } finally {                                                                 // 312
      setCurrentComputation(previous);                                          // 313
    }                                                                           // 314
  },                                                                            // 315
                                                                                // 316
  // Wrap `f` so that it is always run nonreactively.                           // 317
  _makeNonreactive: function (f) {                                              // 318
    if (f.$isNonreactive) // avoid multiple layers of wrapping.                 // 319
      return f;                                                                 // 320
    var nonreactiveVersion = function (/*arguments*/) {                         // 321
      var self = this;                                                          // 322
      var args = _.toArray(arguments);                                          // 323
      var ret;                                                                  // 324
      Deps.nonreactive(function () {                                            // 325
        ret = f.apply(self, args);                                              // 326
      });                                                                       // 327
      return ret;                                                               // 328
    };                                                                          // 329
    nonreactiveVersion.$isNonreactive = true;                                   // 330
    return nonreactiveVersion;                                                  // 331
  },                                                                            // 332
                                                                                // 333
  // http://docs.meteor.com/#deps_oninvalidate                                  // 334
  onInvalidate: function (f) {                                                  // 335
    if (! Deps.active)                                                          // 336
      throw new Error("Deps.onInvalidate requires a currentComputation");       // 337
                                                                                // 338
    Deps.currentComputation.onInvalidate(f);                                    // 339
  },                                                                            // 340
                                                                                // 341
  // http://docs.meteor.com/#deps_afterflush                                    // 342
  afterFlush: function (f) {                                                    // 343
    afterFlushCallbacks.push(f);                                                // 344
    requireFlush();                                                             // 345
  }                                                                             // 346
});                                                                             // 347
                                                                                // 348
//////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

//////////////////////////////////////////////////////////////////////////////////
//                                                                              //
// packages/deps/deprecated.js                                                  //
//                                                                              //
//////////////////////////////////////////////////////////////////////////////////
                                                                                //
// Deprecated (Deps-recated?) functions.                                        // 1
                                                                                // 2
// These functions used to be on the Meteor object (and worked slightly         // 3
// differently).                                                                // 4
// XXX COMPAT WITH 0.5.7                                                        // 5
Meteor.flush = Deps.flush;                                                      // 6
Meteor.autorun = Deps.autorun;                                                  // 7
                                                                                // 8
// We used to require a special "autosubscribe" call to reactively subscribe to // 9
// things. Now, it works with autorun.                                          // 10
// XXX COMPAT WITH 0.5.4                                                        // 11
Meteor.autosubscribe = Deps.autorun;                                            // 12
                                                                                // 13
// This Deps API briefly existed in 0.5.8 and 0.5.9                             // 14
// XXX COMPAT WITH 0.5.9                                                        // 15
Deps.depend = function (d) {                                                    // 16
  return d.depend();                                                            // 17
};                                                                              // 18
                                                                                // 19
//////////////////////////////////////////////////////////////////////////////////

}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package.deps = {
  Deps: Deps
};

})();

//# sourceMappingURL=e2b721ea91f036193799d30ccdf652423602aa5c.map
