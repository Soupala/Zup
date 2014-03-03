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
var Accounts = Package['accounts-base'].Accounts;
var Meetup = Package.meetup.Meetup;

(function () {

/////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                     //
// packages/accounts-meetup/meetup.js                                                                  //
//                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                       //
Accounts.oauth.registerService('meetup');                                                              // 1
                                                                                                       // 2
if (Meteor.isClient) {                                                                                 // 3
  Meteor.loginWithMeetup = function(options, callback) {                                               // 4
    // support a callback without options                                                              // 5
    if (! callback && typeof options === "function") {                                                 // 6
      callback = options;                                                                              // 7
      options = null;                                                                                  // 8
    }                                                                                                  // 9
                                                                                                       // 10
    var credentialRequestCompleteCallback = Accounts.oauth.credentialRequestCompleteHandler(callback); // 11
    Meetup.requestCredential(options, credentialRequestCompleteCallback);                              // 12
  };                                                                                                   // 13
} else {                                                                                               // 14
  Accounts.addAutopublishFields({                                                                      // 15
    // publish all fields including access token, which can legitimately                               // 16
    // be used from the client (if transmitted over ssl or on                                          // 17
    // localhost). http://www.meetup.com/meetup_api/auth/#oauth2implicit                               // 18
    forLoggedInUser: ['services.meetup'],                                                              // 19
    forOtherUsers: ['services.meetup.id']                                                              // 20
  });                                                                                                  // 21
}                                                                                                      // 22
                                                                                                       // 23
/////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package['accounts-meetup'] = {};

})();

//# sourceMappingURL=e29b2fa08714acff3636e67fc28938f2a5bc0219.map
