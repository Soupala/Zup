(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var Accounts = Package['accounts-base'].Accounts;
var SRP = Package.srp.SRP;
var Email = Package.email.Email;
var Random = Package.random.Random;
var check = Package.check.check;
var Match = Package.check.Match;
var _ = Package.underscore._;
var DDP = Package.livedata.DDP;
var DDPServer = Package.livedata.DDPServer;

(function () {

//////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                      //
// packages/accounts-password/email_templates.js                                                        //
//                                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                        //
Accounts.emailTemplates = {                                                                             // 1
  from: "Meteor Accounts <no-reply@meteor.com>",                                                        // 2
  siteName: Meteor.absoluteUrl().replace(/^https?:\/\//, '').replace(/\/$/, ''),                        // 3
                                                                                                        // 4
  resetPassword: {                                                                                      // 5
    subject: function(user) {                                                                           // 6
      return "How to reset your password on " + Accounts.emailTemplates.siteName;                       // 7
    },                                                                                                  // 8
    text: function(user, url) {                                                                         // 9
      var greeting = (user.profile && user.profile.name) ?                                              // 10
            ("Hello " + user.profile.name + ",") : "Hello,";                                            // 11
      return greeting + "\n"                                                                            // 12
        + "\n"                                                                                          // 13
        + "To reset your password, simply click the link below.\n"                                      // 14
        + "\n"                                                                                          // 15
        + url + "\n"                                                                                    // 16
        + "\n"                                                                                          // 17
        + "Thanks.\n";                                                                                  // 18
    }                                                                                                   // 19
  },                                                                                                    // 20
  verifyEmail: {                                                                                        // 21
    subject: function(user) {                                                                           // 22
      return "How to verify email address on " + Accounts.emailTemplates.siteName;                      // 23
    },                                                                                                  // 24
    text: function(user, url) {                                                                         // 25
      var greeting = (user.profile && user.profile.name) ?                                              // 26
            ("Hello " + user.profile.name + ",") : "Hello,";                                            // 27
      return greeting + "\n"                                                                            // 28
        + "\n"                                                                                          // 29
        + "To verify your account email, simply click the link below.\n"                                // 30
        + "\n"                                                                                          // 31
        + url + "\n"                                                                                    // 32
        + "\n"                                                                                          // 33
        + "Thanks.\n";                                                                                  // 34
    }                                                                                                   // 35
  },                                                                                                    // 36
  enrollAccount: {                                                                                      // 37
    subject: function(user) {                                                                           // 38
      return "An account has been created for you on " + Accounts.emailTemplates.siteName;              // 39
    },                                                                                                  // 40
    text: function(user, url) {                                                                         // 41
      var greeting = (user.profile && user.profile.name) ?                                              // 42
            ("Hello " + user.profile.name + ",") : "Hello,";                                            // 43
      return greeting + "\n"                                                                            // 44
        + "\n"                                                                                          // 45
        + "To start using the service, simply click the link below.\n"                                  // 46
        + "\n"                                                                                          // 47
        + url + "\n"                                                                                    // 48
        + "\n"                                                                                          // 49
        + "Thanks.\n";                                                                                  // 50
    }                                                                                                   // 51
  }                                                                                                     // 52
};                                                                                                      // 53
                                                                                                        // 54
//////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

//////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                      //
// packages/accounts-password/password_server.js                                                        //
//                                                                                                      //
//////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                        //
///                                                                                                     // 1
/// LOGIN                                                                                               // 2
///                                                                                                     // 3
                                                                                                        // 4
// Users can specify various keys to identify themselves with.                                          // 5
// @param user {Object} with one of `id`, `username`, or `email`.                                       // 6
// @returns A selector to pass to mongo to get the user record.                                         // 7
                                                                                                        // 8
var selectorFromUserQuery = function (user) {                                                           // 9
  if (user.id)                                                                                          // 10
    return {_id: user.id};                                                                              // 11
  else if (user.username)                                                                               // 12
    return {username: user.username};                                                                   // 13
  else if (user.email)                                                                                  // 14
    return {"emails.address": user.email};                                                              // 15
  throw new Error("shouldn't happen (validation missed something)");                                    // 16
};                                                                                                      // 17
                                                                                                        // 18
// XXX maybe this belongs in the check package                                                          // 19
var NonEmptyString = Match.Where(function (x) {                                                         // 20
  check(x, String);                                                                                     // 21
  return x.length > 0;                                                                                  // 22
});                                                                                                     // 23
                                                                                                        // 24
var userQueryValidator = Match.Where(function (user) {                                                  // 25
  check(user, {                                                                                         // 26
    id: Match.Optional(NonEmptyString),                                                                 // 27
    username: Match.Optional(NonEmptyString),                                                           // 28
    email: Match.Optional(NonEmptyString)                                                               // 29
  });                                                                                                   // 30
  if (_.keys(user).length !== 1)                                                                        // 31
    throw new Match.Error("User property must have exactly one field");                                 // 32
  return true;                                                                                          // 33
});                                                                                                     // 34
                                                                                                        // 35
// Step 1 of SRP password exchange. This puts an `M` value in the                                       // 36
// session data for this connection. If a client later sends the same                                   // 37
// `M` value to a method on this connection, it proves they know the                                    // 38
// password for this user. We can then prove we know the password to                                    // 39
// them by sending our `HAMK` value.                                                                    // 40
//                                                                                                      // 41
// @param request {Object} with fields:                                                                 // 42
//   user: either {username: (username)}, {email: (email)}, or {id: (userId)}                           // 43
//   A: hex encoded int. the client's public key for this exchange                                      // 44
// @returns {Object} with fields:                                                                       // 45
//   identity: random string ID                                                                         // 46
//   salt: random string ID                                                                             // 47
//   B: hex encoded int. server's public key for this exchange                                          // 48
Meteor.methods({beginPasswordExchange: function (request) {                                             // 49
  check(request, {                                                                                      // 50
    user: userQueryValidator,                                                                           // 51
    A: String                                                                                           // 52
  });                                                                                                   // 53
  var selector = selectorFromUserQuery(request.user);                                                   // 54
                                                                                                        // 55
  var user = Meteor.users.findOne(selector);                                                            // 56
  if (!user)                                                                                            // 57
    throw new Meteor.Error(403, "User not found");                                                      // 58
                                                                                                        // 59
  if (!user.services || !user.services.password ||                                                      // 60
      !user.services.password.srp)                                                                      // 61
    throw new Meteor.Error(403, "User has no password set");                                            // 62
                                                                                                        // 63
  var verifier = user.services.password.srp;                                                            // 64
  var srp = new SRP.Server(verifier);                                                                   // 65
  var challenge = srp.issueChallenge({A: request.A});                                                   // 66
                                                                                                        // 67
  // Save results so we can verify them later.                                                          // 68
  Accounts._setAccountData(this.connection.id, 'srpChallenge',                                          // 69
    { userId: user._id, M: srp.M, HAMK: srp.HAMK }                                                      // 70
  );                                                                                                    // 71
  return challenge;                                                                                     // 72
}});                                                                                                    // 73
                                                                                                        // 74
// Handler to login with password via SRP. Checks the `M` value set by                                  // 75
// beginPasswordExchange.                                                                               // 76
Accounts.registerLoginHandler(function (options) {                                                      // 77
  if (!options.srp)                                                                                     // 78
    return undefined; // don't handle                                                                   // 79
  check(options.srp, {M: String});                                                                      // 80
                                                                                                        // 81
  // we're always called from within a 'login' method, so this should                                   // 82
  // be safe.                                                                                           // 83
  var currentInvocation = DDP._CurrentInvocation.get();                                                 // 84
  var serialized = Accounts._getAccountData(currentInvocation.connection.id, 'srpChallenge');           // 85
  if (!serialized || serialized.M !== options.srp.M)                                                    // 86
    throw new Meteor.Error(403, "Incorrect password");                                                  // 87
  // Only can use challenges once.                                                                      // 88
  Accounts._setAccountData(currentInvocation.connection.id, 'srpChallenge', undefined);                 // 89
                                                                                                        // 90
  var userId = serialized.userId;                                                                       // 91
  var user = Meteor.users.findOne(userId);                                                              // 92
  // Was the user deleted since the start of this challenge?                                            // 93
  if (!user)                                                                                            // 94
    throw new Meteor.Error(403, "User not found");                                                      // 95
  var stampedLoginToken = Accounts._generateStampedLoginToken();                                        // 96
  Meteor.users.update(                                                                                  // 97
    userId, {$push: {'services.resume.loginTokens': Accounts._hashStampedToken(stampedLoginToken)}});   // 98
                                                                                                        // 99
  return {                                                                                              // 100
    token: stampedLoginToken.token,                                                                     // 101
    tokenExpires: Accounts._tokenExpiration(stampedLoginToken.when),                                    // 102
    id: userId,                                                                                         // 103
    HAMK: serialized.HAMK                                                                               // 104
  };                                                                                                    // 105
});                                                                                                     // 106
                                                                                                        // 107
// Handler to login with plaintext password.                                                            // 108
//                                                                                                      // 109
// The meteor client doesn't use this, it is for other DDP clients who                                  // 110
// haven't implemented SRP. Since it sends the password in plaintext                                    // 111
// over the wire, it should only be run over SSL!                                                       // 112
//                                                                                                      // 113
// Also, it might be nice if servers could turn this off. Or maybe it                                   // 114
// should be opt-in, not opt-out? Accounts.config option?                                               // 115
Accounts.registerLoginHandler(function (options) {                                                      // 116
  if (!options.password || !options.user)                                                               // 117
    return undefined; // don't handle                                                                   // 118
                                                                                                        // 119
  check(options, {user: userQueryValidator, password: String});                                         // 120
                                                                                                        // 121
  var selector = selectorFromUserQuery(options.user);                                                   // 122
  var user = Meteor.users.findOne(selector);                                                            // 123
  if (!user)                                                                                            // 124
    throw new Meteor.Error(403, "User not found");                                                      // 125
                                                                                                        // 126
  if (!user.services || !user.services.password ||                                                      // 127
      !user.services.password.srp)                                                                      // 128
    throw new Meteor.Error(403, "User has no password set");                                            // 129
                                                                                                        // 130
  // Just check the verifier output when the same identity and salt                                     // 131
  // are passed. Don't bother with a full exchange.                                                     // 132
  var verifier = user.services.password.srp;                                                            // 133
  var newVerifier = SRP.generateVerifier(options.password, {                                            // 134
    identity: verifier.identity, salt: verifier.salt});                                                 // 135
                                                                                                        // 136
  if (verifier.verifier !== newVerifier.verifier)                                                       // 137
    throw new Meteor.Error(403, "Incorrect password");                                                  // 138
                                                                                                        // 139
  var stampedLoginToken = Accounts._generateStampedLoginToken();                                        // 140
  Meteor.users.update(                                                                                  // 141
    user._id, {$push: {'services.resume.loginTokens': Accounts._hashStampedToken(stampedLoginToken)}}); // 142
                                                                                                        // 143
  return {                                                                                              // 144
    token: stampedLoginToken.token,                                                                     // 145
    tokenExpires: Accounts._tokenExpiration(stampedLoginToken.when),                                    // 146
    id: user._id                                                                                        // 147
  };                                                                                                    // 148
});                                                                                                     // 149
                                                                                                        // 150
                                                                                                        // 151
///                                                                                                     // 152
/// CHANGING                                                                                            // 153
///                                                                                                     // 154
                                                                                                        // 155
// Let the user change their own password if they know the old                                          // 156
// password. Checks the `M` value set by beginPasswordExchange.                                         // 157
Meteor.methods({changePassword: function (options) {                                                    // 158
  if (!this.userId)                                                                                     // 159
    throw new Meteor.Error(401, "Must be logged in");                                                   // 160
  check(options, {                                                                                      // 161
    // If options.M is set, it means we went through a challenge with the old                           // 162
    // password. For now, we don't allow changePassword without knowing the old                         // 163
    // password.                                                                                        // 164
    M: String,                                                                                          // 165
    srp: Match.Optional(SRP.matchVerifier),                                                             // 166
    password: Match.Optional(String)                                                                    // 167
  });                                                                                                   // 168
                                                                                                        // 169
  var serialized = Accounts._getAccountData(this.connection.id, 'srpChallenge');                        // 170
  if (!serialized || serialized.M !== options.M)                                                        // 171
    throw new Meteor.Error(403, "Incorrect password");                                                  // 172
  if (serialized.userId !== this.userId)                                                                // 173
    // No monkey business!                                                                              // 174
    throw new Meteor.Error(403, "Incorrect password");                                                  // 175
  // Only can use challenges once.                                                                      // 176
  Accounts._setAccountData(this.connection.id, 'srpChallenge', undefined);                              // 177
                                                                                                        // 178
  var verifier = options.srp;                                                                           // 179
  if (!verifier && options.password) {                                                                  // 180
    verifier = SRP.generateVerifier(options.password);                                                  // 181
  }                                                                                                     // 182
  if (!verifier)                                                                                        // 183
    throw new Meteor.Error(400, "Invalid verifier");                                                    // 184
                                                                                                        // 185
  // XXX this should invalidate all login tokens other than the current one                             // 186
  // (or it should assign a new login token, replacing existing ones)                                   // 187
  Meteor.users.update({_id: this.userId},                                                               // 188
                      {$set: {'services.password.srp': verifier}});                                     // 189
                                                                                                        // 190
  var ret = {passwordChanged: true};                                                                    // 191
  if (serialized)                                                                                       // 192
    ret.HAMK = serialized.HAMK;                                                                         // 193
  return ret;                                                                                           // 194
}});                                                                                                    // 195
                                                                                                        // 196
                                                                                                        // 197
// Force change the users password.                                                                     // 198
Accounts.setPassword = function (userId, newPassword) {                                                 // 199
  var user = Meteor.users.findOne(userId);                                                              // 200
  if (!user)                                                                                            // 201
    throw new Meteor.Error(403, "User not found");                                                      // 202
  var newVerifier = SRP.generateVerifier(newPassword);                                                  // 203
                                                                                                        // 204
  Meteor.users.update({_id: user._id}, {                                                                // 205
    $set: {'services.password.srp': newVerifier}});                                                     // 206
};                                                                                                      // 207
                                                                                                        // 208
                                                                                                        // 209
///                                                                                                     // 210
/// RESETTING VIA EMAIL                                                                                 // 211
///                                                                                                     // 212
                                                                                                        // 213
// Method called by a user to request a password reset email. This is                                   // 214
// the start of the reset process.                                                                      // 215
Meteor.methods({forgotPassword: function (options) {                                                    // 216
  check(options, {email: String});                                                                      // 217
                                                                                                        // 218
  var user = Meteor.users.findOne({"emails.address": options.email});                                   // 219
  if (!user)                                                                                            // 220
    throw new Meteor.Error(403, "User not found");                                                      // 221
                                                                                                        // 222
  Accounts.sendResetPasswordEmail(user._id, options.email);                                             // 223
}});                                                                                                    // 224
                                                                                                        // 225
// send the user an email with a link that when opened allows the user                                  // 226
// to set a new password, without the old password.                                                     // 227
//                                                                                                      // 228
Accounts.sendResetPasswordEmail = function (userId, email) {                                            // 229
  // Make sure the user exists, and email is one of their addresses.                                    // 230
  var user = Meteor.users.findOne(userId);                                                              // 231
  if (!user)                                                                                            // 232
    throw new Error("Can't find user");                                                                 // 233
  // pick the first email if we weren't passed an email.                                                // 234
  if (!email && user.emails && user.emails[0])                                                          // 235
    email = user.emails[0].address;                                                                     // 236
  // make sure we have a valid email                                                                    // 237
  if (!email || !_.contains(_.pluck(user.emails || [], 'address'), email))                              // 238
    throw new Error("No such email for user.");                                                         // 239
                                                                                                        // 240
  var token = Random.id();                                                                              // 241
  var when = new Date();                                                                                // 242
  Meteor.users.update(userId, {$set: {                                                                  // 243
    "services.password.reset": {                                                                        // 244
      token: token,                                                                                     // 245
      email: email,                                                                                     // 246
      when: when                                                                                        // 247
    }                                                                                                   // 248
  }});                                                                                                  // 249
                                                                                                        // 250
  var resetPasswordUrl = Accounts.urls.resetPassword(token);                                            // 251
  Email.send({                                                                                          // 252
    to: email,                                                                                          // 253
    from: Accounts.emailTemplates.from,                                                                 // 254
    subject: Accounts.emailTemplates.resetPassword.subject(user),                                       // 255
    text: Accounts.emailTemplates.resetPassword.text(user, resetPasswordUrl)});                         // 256
};                                                                                                      // 257
                                                                                                        // 258
// send the user an email informing them that their account was created, with                           // 259
// a link that when opened both marks their email as verified and forces them                           // 260
// to choose their password. The email must be one of the addresses in the                              // 261
// user's emails field, or undefined to pick the first email automatically.                             // 262
//                                                                                                      // 263
// This is not called automatically. It must be called manually if you                                  // 264
// want to use enrollment emails.                                                                       // 265
//                                                                                                      // 266
Accounts.sendEnrollmentEmail = function (userId, email) {                                               // 267
  // XXX refactor! This is basically identical to sendResetPasswordEmail.                               // 268
                                                                                                        // 269
  // Make sure the user exists, and email is in their addresses.                                        // 270
  var user = Meteor.users.findOne(userId);                                                              // 271
  if (!user)                                                                                            // 272
    throw new Error("Can't find user");                                                                 // 273
  // pick the first email if we weren't passed an email.                                                // 274
  if (!email && user.emails && user.emails[0])                                                          // 275
    email = user.emails[0].address;                                                                     // 276
  // make sure we have a valid email                                                                    // 277
  if (!email || !_.contains(_.pluck(user.emails || [], 'address'), email))                              // 278
    throw new Error("No such email for user.");                                                         // 279
                                                                                                        // 280
                                                                                                        // 281
  var token = Random.id();                                                                              // 282
  var when = new Date();                                                                                // 283
  Meteor.users.update(userId, {$set: {                                                                  // 284
    "services.password.reset": {                                                                        // 285
      token: token,                                                                                     // 286
      email: email,                                                                                     // 287
      when: when                                                                                        // 288
    }                                                                                                   // 289
  }});                                                                                                  // 290
                                                                                                        // 291
  var enrollAccountUrl = Accounts.urls.enrollAccount(token);                                            // 292
  Email.send({                                                                                          // 293
    to: email,                                                                                          // 294
    from: Accounts.emailTemplates.from,                                                                 // 295
    subject: Accounts.emailTemplates.enrollAccount.subject(user),                                       // 296
    text: Accounts.emailTemplates.enrollAccount.text(user, enrollAccountUrl)                            // 297
  });                                                                                                   // 298
};                                                                                                      // 299
                                                                                                        // 300
                                                                                                        // 301
// Take token from sendResetPasswordEmail or sendEnrollmentEmail, change                                // 302
// the users password, and log them in.                                                                 // 303
Meteor.methods({resetPassword: function (token, newVerifier) {                                          // 304
  check(token, String);                                                                                 // 305
  check(newVerifier, SRP.matchVerifier);                                                                // 306
                                                                                                        // 307
  var user = Meteor.users.findOne({                                                                     // 308
    "services.password.reset.token": ""+token});                                                        // 309
  if (!user)                                                                                            // 310
    throw new Meteor.Error(403, "Token expired");                                                       // 311
  var email = user.services.password.reset.email;                                                       // 312
  if (!_.include(_.pluck(user.emails || [], 'address'), email))                                         // 313
    throw new Meteor.Error(403, "Token has invalid email address");                                     // 314
                                                                                                        // 315
  var stampedLoginToken = Accounts._generateStampedLoginToken();                                        // 316
  var newHashedToken = Accounts._hashStampedToken(stampedLoginToken);                                   // 317
                                                                                                        // 318
  // NOTE: We're about to invalidate tokens on the user, who we might be                                // 319
  // logged in as. Make sure to avoid logging ourselves out if this                                     // 320
  // happens. But also make sure not to leave the connection in a state                                 // 321
  // of having a bad token set if things fail.                                                          // 322
  var oldToken = Accounts._getLoginToken(this.connection.id);                                           // 323
  Accounts._setLoginToken(user._id, this.connection, null);                                             // 324
                                                                                                        // 325
  try {                                                                                                 // 326
    // Update the user record by:                                                                       // 327
    // - Changing the password verifier to the new one                                                  // 328
    // - Replacing all valid login tokens with new ones (changing                                       // 329
    //   password should invalidate existing sessions).                                                 // 330
    // - Forgetting about the reset token that was just used                                            // 331
    // - Verifying their email, since they got the password reset via email.                            // 332
    Meteor.users.update({_id: user._id, 'emails.address': email}, {                                     // 333
      $set: {'services.password.srp': newVerifier,                                                      // 334
             'services.resume.loginTokens': [newHashedToken],                                           // 335
             'emails.$.verified': true},                                                                // 336
      $unset: {'services.password.reset': 1}                                                            // 337
    });                                                                                                 // 338
  } catch (err) {                                                                                       // 339
    // update failed somehow. reset to old token.                                                       // 340
    Accounts._setLoginToken(user._id, this.connection, oldToken);                                       // 341
    throw err;                                                                                          // 342
  }                                                                                                     // 343
                                                                                                        // 344
  Accounts._setLoginToken(user._id, this.connection, newHashedToken.hashedToken);                       // 345
  this.setUserId(user._id);                                                                             // 346
                                                                                                        // 347
  return {                                                                                              // 348
    token: stampedLoginToken.token,                                                                     // 349
    tokenExpires: Accounts._tokenExpiration(stampedLoginToken.when),                                    // 350
    id: user._id                                                                                        // 351
  };                                                                                                    // 352
}});                                                                                                    // 353
                                                                                                        // 354
///                                                                                                     // 355
/// EMAIL VERIFICATION                                                                                  // 356
///                                                                                                     // 357
                                                                                                        // 358
                                                                                                        // 359
// send the user an email with a link that when opened marks that                                       // 360
// address as verified                                                                                  // 361
//                                                                                                      // 362
Accounts.sendVerificationEmail = function (userId, address) {                                           // 363
  // XXX Also generate a link using which someone can delete this                                       // 364
  // account if they own said address but weren't those who created                                     // 365
  // this account.                                                                                      // 366
                                                                                                        // 367
  // Make sure the user exists, and address is one of their addresses.                                  // 368
  var user = Meteor.users.findOne(userId);                                                              // 369
  if (!user)                                                                                            // 370
    throw new Error("Can't find user");                                                                 // 371
  // pick the first unverified address if we weren't passed an address.                                 // 372
  if (!address) {                                                                                       // 373
    var email = _.find(user.emails || [],                                                               // 374
                       function (e) { return !e.verified; });                                           // 375
    address = (email || {}).address;                                                                    // 376
  }                                                                                                     // 377
  // make sure we have a valid address                                                                  // 378
  if (!address || !_.contains(_.pluck(user.emails || [], 'address'), address))                          // 379
    throw new Error("No such email address for user.");                                                 // 380
                                                                                                        // 381
                                                                                                        // 382
  var tokenRecord = {                                                                                   // 383
    token: Random.id(),                                                                                 // 384
    address: address,                                                                                   // 385
    when: new Date()};                                                                                  // 386
  Meteor.users.update(                                                                                  // 387
    {_id: userId},                                                                                      // 388
    {$push: {'services.email.verificationTokens': tokenRecord}});                                       // 389
                                                                                                        // 390
  var verifyEmailUrl = Accounts.urls.verifyEmail(tokenRecord.token);                                    // 391
  Email.send({                                                                                          // 392
    to: address,                                                                                        // 393
    from: Accounts.emailTemplates.from,                                                                 // 394
    subject: Accounts.emailTemplates.verifyEmail.subject(user),                                         // 395
    text: Accounts.emailTemplates.verifyEmail.text(user, verifyEmailUrl)                                // 396
  });                                                                                                   // 397
};                                                                                                      // 398
                                                                                                        // 399
// Take token from sendVerificationEmail, mark the email as verified,                                   // 400
// and log them in.                                                                                     // 401
Meteor.methods({verifyEmail: function (token) {                                                         // 402
  check(token, String);                                                                                 // 403
                                                                                                        // 404
  var user = Meteor.users.findOne(                                                                      // 405
    {'services.email.verificationTokens.token': token});                                                // 406
  if (!user)                                                                                            // 407
    throw new Meteor.Error(403, "Verify email link expired");                                           // 408
                                                                                                        // 409
  var tokenRecord = _.find(user.services.email.verificationTokens,                                      // 410
                           function (t) {                                                               // 411
                             return t.token == token;                                                   // 412
                           });                                                                          // 413
  if (!tokenRecord)                                                                                     // 414
    throw new Meteor.Error(403, "Verify email link expired");                                           // 415
                                                                                                        // 416
  var emailsRecord = _.find(user.emails, function (e) {                                                 // 417
    return e.address == tokenRecord.address;                                                            // 418
  });                                                                                                   // 419
  if (!emailsRecord)                                                                                    // 420
    throw new Meteor.Error(403, "Verify email link is for unknown address");                            // 421
                                                                                                        // 422
  // Log the user in with a new login token.                                                            // 423
  var stampedLoginToken = Accounts._generateStampedLoginToken();                                        // 424
  var hashedToken = Accounts._hashStampedToken(stampedLoginToken);                                      // 425
                                                                                                        // 426
  // By including the address in the query, we can use 'emails.$' in the                                // 427
  // modifier to get a reference to the specific object in the emails                                   // 428
  // array. See                                                                                         // 429
  // http://www.mongodb.org/display/DOCS/Updating/#Updating-The%24positionaloperator)                   // 430
  // http://www.mongodb.org/display/DOCS/Updating#Updating-%24pull                                      // 431
  Meteor.users.update(                                                                                  // 432
    {_id: user._id,                                                                                     // 433
     'emails.address': tokenRecord.address},                                                            // 434
    {$set: {'emails.$.verified': true},                                                                 // 435
     $pull: {'services.email.verificationTokens': {token: token}},                                      // 436
     $push: {'services.resume.loginTokens': hashedToken}});                                             // 437
                                                                                                        // 438
  this.setUserId(user._id);                                                                             // 439
  Accounts._setLoginToken(user._id, this.connection, hashedToken.hashedToken);                          // 440
  return {                                                                                              // 441
    token: stampedLoginToken.token,                                                                     // 442
    tokenExpires: Accounts._tokenExpiration(stampedLoginToken.when),                                    // 443
    id: user._id                                                                                        // 444
  };                                                                                                    // 445
}});                                                                                                    // 446
                                                                                                        // 447
                                                                                                        // 448
                                                                                                        // 449
///                                                                                                     // 450
/// CREATING USERS                                                                                      // 451
///                                                                                                     // 452
                                                                                                        // 453
// Shared createUser function called from the createUser method, both                                   // 454
// if originates in client or server code. Calls user provided hooks,                                   // 455
// does the actual user insertion.                                                                      // 456
//                                                                                                      // 457
// returns an object with id: userId, and (if options.generateLoginToken is                             // 458
// set) token: loginToken.                                                                              // 459
var createUser = function (options) {                                                                   // 460
  // Unknown keys allowed, because a onCreateUserHook can take arbitrary                                // 461
  // options.                                                                                           // 462
  check(options, Match.ObjectIncluding({                                                                // 463
    generateLoginToken: Boolean,                                                                        // 464
    username: Match.Optional(String),                                                                   // 465
    email: Match.Optional(String),                                                                      // 466
    password: Match.Optional(String),                                                                   // 467
    srp: Match.Optional(SRP.matchVerifier)                                                              // 468
  }));                                                                                                  // 469
                                                                                                        // 470
  var username = options.username;                                                                      // 471
  var email = options.email;                                                                            // 472
  if (!username && !email)                                                                              // 473
    throw new Meteor.Error(400, "Need to set a username or email");                                     // 474
                                                                                                        // 475
  // Raw password. The meteor client doesn't send this, but a DDP                                       // 476
  // client that didn't implement SRP could send this. This should                                      // 477
  // only be done over SSL.                                                                             // 478
  if (options.password) {                                                                               // 479
    if (options.srp)                                                                                    // 480
      throw new Meteor.Error(400, "Don't pass both password and srp in options");                       // 481
    options.srp = SRP.generateVerifier(options.password);                                               // 482
  }                                                                                                     // 483
                                                                                                        // 484
  var user = {services: {}};                                                                            // 485
  if (options.srp)                                                                                      // 486
    user.services.password = {srp: options.srp}; // XXX validate verifier                               // 487
  if (username)                                                                                         // 488
    user.username = username;                                                                           // 489
  if (email)                                                                                            // 490
    user.emails = [{address: email, verified: false}];                                                  // 491
                                                                                                        // 492
  return Accounts.insertUserDoc(options, user);                                                         // 493
};                                                                                                      // 494
                                                                                                        // 495
// method for create user. Requests come from the client.                                               // 496
Meteor.methods({createUser: function (options) {                                                        // 497
  // createUser() above does more checking.                                                             // 498
  check(options, Object);                                                                               // 499
  options.generateLoginToken = true;                                                                    // 500
  if (Accounts._options.forbidClientAccountCreation)                                                    // 501
    throw new Meteor.Error(403, "Signups forbidden");                                                   // 502
                                                                                                        // 503
  // Create user. result contains id and token.                                                         // 504
  var result = createUser(options);                                                                     // 505
  // safety belt. createUser is supposed to throw on error. send 500 error                              // 506
  // instead of sending a verification email with empty userid.                                         // 507
  if (!result.id)                                                                                       // 508
    throw new Error("createUser failed to insert new user");                                            // 509
                                                                                                        // 510
  // If `Accounts._options.sendVerificationEmail` is set, register                                      // 511
  // a token to verify the user's primary email, and send it to                                         // 512
  // that address.                                                                                      // 513
  if (options.email && Accounts._options.sendVerificationEmail)                                         // 514
    Accounts.sendVerificationEmail(result.id, options.email);                                           // 515
                                                                                                        // 516
  // client gets logged in as the new user afterwards.                                                  // 517
  this.setUserId(result.id);                                                                            // 518
  Accounts._setLoginToken(                                                                              // 519
    result.id,                                                                                          // 520
    this.connection,                                                                                    // 521
    Accounts._hashLoginToken(result.token)                                                              // 522
  );                                                                                                    // 523
  return result;                                                                                        // 524
}});                                                                                                    // 525
                                                                                                        // 526
// Create user directly on the server.                                                                  // 527
//                                                                                                      // 528
// Unlike the client version, this does not log you in as this user                                     // 529
// after creation.                                                                                      // 530
//                                                                                                      // 531
// returns userId or throws an error if it can't create                                                 // 532
//                                                                                                      // 533
// XXX add another argument ("server options") that gets sent to onCreateUser,                          // 534
// which is always empty when called from the createUser method? eg, "admin:                            // 535
// true", which we want to prevent the client from setting, but which a custom                          // 536
// method calling Accounts.createUser could set?                                                        // 537
//                                                                                                      // 538
Accounts.createUser = function (options, callback) {                                                    // 539
  options = _.clone(options);                                                                           // 540
  options.generateLoginToken = false;                                                                   // 541
                                                                                                        // 542
  // XXX allow an optional callback?                                                                    // 543
  if (callback) {                                                                                       // 544
    throw new Error("Accounts.createUser with callback not supported on the server yet.");              // 545
  }                                                                                                     // 546
                                                                                                        // 547
  var userId = createUser(options).id;                                                                  // 548
                                                                                                        // 549
  return userId;                                                                                        // 550
};                                                                                                      // 551
                                                                                                        // 552
///                                                                                                     // 553
/// PASSWORD-SPECIFIC INDEXES ON USERS                                                                  // 554
///                                                                                                     // 555
Meteor.users._ensureIndex('emails.validationTokens.token',                                              // 556
                          {unique: 1, sparse: 1});                                                      // 557
Meteor.users._ensureIndex('services.password.reset.token',                                              // 558
                          {unique: 1, sparse: 1});                                                      // 559
                                                                                                        // 560
//////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package['accounts-password'] = {};

})();
