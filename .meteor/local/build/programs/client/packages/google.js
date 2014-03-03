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
var Oauth = Package.oauth.Oauth;
var _ = Package.underscore._;
var ServiceConfiguration = Package['service-configuration'].ServiceConfiguration;
var Random = Package.random.Random;
var Template = Package.templating.Template;
var Spark = Package.spark.Spark;

/* Package-scope variables */
var Google;

(function () {

////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                            //
// packages/google/template.google_configure.js                                               //
//                                                                                            //
////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                              //
Template.__define__("configureLoginServiceDialogForGoogle",Package.handlebars.Handlebars.json_ast_to_func(["<p>\n    First, you'll need to get a Google Client ID. Follow these steps:\n  </p>\n  <ol>\n    <li>\n      Visit <a href=\"https://code.google.com/apis/console/\" target=\"blank\">https://code.google.com/apis/console/</a>\n    </li>\n    <li>\n      If necessary, \"Create Project\"\n    <li>\n      Click \"APIs &amp; auth\" and \"Registered apps\" on the left\n    </li>\n    <li>\n      Click the \"Register App\" button\n    </li>\n    <li>\n      Choose \"Web application\" as the type\n    </li>\n    <li>\n      Click \"Register\"\n    </li>\n    <li>\n      Expand the \"OAuth 2.0 Client ID section\"\n    </li>\n    <li>\n      Set Web Origin to: <span class=\"url\">",["{",[[0,"siteUrl"]]],"</span>\n    </li>\n    <li>\n      Set Redirect URI to: <span class=\"url\">",["{",[[0,"siteUrl"]]],"_oauth/google?close</span>\n    </li>\n    <li>\n      Click \"Generate\"\n    </li>\n  </ol>"]));
                                                                                              // 2
////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                            //
// packages/google/google_configure.js                                                        //
//                                                                                            //
////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                              //
Template.configureLoginServiceDialogForGoogle.siteUrl = function () {                         // 1
  return Meteor.absoluteUrl();                                                                // 2
};                                                                                            // 3
                                                                                              // 4
Template.configureLoginServiceDialogForGoogle.fields = function () {                          // 5
  return [                                                                                    // 6
    {property: 'clientId', label: 'Client ID'},                                               // 7
    {property: 'secret', label: 'Client secret'}                                              // 8
  ];                                                                                          // 9
};                                                                                            // 10
                                                                                              // 11
////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                            //
// packages/google/google_client.js                                                           //
//                                                                                            //
////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                              //
Google = {};                                                                                  // 1
                                                                                              // 2
// Request Google credentials for the user                                                    // 3
// @param options {optional}                                                                  // 4
// @param credentialRequestCompleteCallback {Function} Callback function to call on           // 5
//   completion. Takes one argument, credentialToken on success, or Error on                  // 6
//   error.                                                                                   // 7
Google.requestCredential = function (options, credentialRequestCompleteCallback) {            // 8
  // support both (options, callback) and (callback).                                         // 9
  if (!credentialRequestCompleteCallback && typeof options === 'function') {                  // 10
    credentialRequestCompleteCallback = options;                                              // 11
    options = {};                                                                             // 12
  } else if (!options) {                                                                      // 13
    options = {};                                                                             // 14
  }                                                                                           // 15
                                                                                              // 16
  var config = ServiceConfiguration.configurations.findOne({service: 'google'});              // 17
  if (!config) {                                                                              // 18
    credentialRequestCompleteCallback && credentialRequestCompleteCallback(new ServiceConfiguration.ConfigError("Service not configured"));
    return;                                                                                   // 20
  }                                                                                           // 21
                                                                                              // 22
  var credentialToken = Random.id();                                                          // 23
                                                                                              // 24
  // always need this to get user id from google.                                             // 25
  var requiredScope = ['https://www.googleapis.com/auth/userinfo.profile'];                   // 26
  var scope = ['https://www.googleapis.com/auth/userinfo.email'];                             // 27
  if (options.requestPermissions)                                                             // 28
    scope = options.requestPermissions;                                                       // 29
  scope = _.union(scope, requiredScope);                                                      // 30
  var flatScope = _.map(scope, encodeURIComponent).join('+');                                 // 31
                                                                                              // 32
  // https://developers.google.com/accounts/docs/OAuth2WebServer#formingtheurl                // 33
  var accessType = options.requestOfflineToken ? 'offline' : 'online';                        // 34
  var approvalPrompt = options.forceApprovalPrompt ? 'force' : 'auto';                        // 35
                                                                                              // 36
  var loginUrl =                                                                              // 37
        'https://accounts.google.com/o/oauth2/auth' +                                         // 38
        '?response_type=code' +                                                               // 39
        '&client_id=' + config.clientId +                                                     // 40
        '&scope=' + flatScope +                                                               // 41
        '&redirect_uri=' + Meteor.absoluteUrl('_oauth/google?close') +                        // 42
        '&state=' + credentialToken +                                                         // 43
        '&access_type=' + accessType +                                                        // 44
        '&approval_prompt=' + approvalPrompt;                                                 // 45
                                                                                              // 46
  // Use Google's domain-specific login page if we want to restrict creation to               // 47
  // a particular email domain. (Don't use it if restrictCreationByEmailDomain                // 48
  // is a function.) Note that all this does is change Google's UI ---                        // 49
  // accounts-base/accounts_server.js still checks server-side that the server                // 50
  // has the proper email address after the OAuth conversation.                               // 51
  if (typeof Accounts._options.restrictCreationByEmailDomain === 'string') {                  // 52
    loginUrl += '&hd=' + encodeURIComponent(Accounts._options.restrictCreationByEmailDomain); // 53
  }                                                                                           // 54
                                                                                              // 55
  Oauth.showPopup(                                                                            // 56
    loginUrl,                                                                                 // 57
    _.bind(credentialRequestCompleteCallback, null, credentialToken),                         // 58
    { height: 406 }                                                                           // 59
  );                                                                                          // 60
};                                                                                            // 61
                                                                                              // 62
////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package.google = {
  Google: Google
};

})();

//# sourceMappingURL=e634ee14c64996e8806fead6cf021bb4d61c27e2.map
