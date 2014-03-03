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
var Template = Package.templating.Template;
var _ = Package.underscore._;
var Random = Package.random.Random;
var ServiceConfiguration = Package['service-configuration'].ServiceConfiguration;
var Spark = Package.spark.Spark;

/* Package-scope variables */
var Meetup;

(function () {

//////////////////////////////////////////////////////////////////////////////////////
//                                                                                  //
// packages/meetup/template.meetup_configure.js                                     //
//                                                                                  //
//////////////////////////////////////////////////////////////////////////////////////
                                                                                    //
Template.__define__("configureLoginServiceDialogForMeetup",Package.handlebars.Handlebars.json_ast_to_func(["<p>\n    First, you'll need to get a Meetup Client ID. Follow these steps:\n  </p>\n  <ol>\n    <li>\n      Visit <a href=\"http://www.meetup.com/meetup_api/oauth_consumers/create/\" target=\"blank\">http://www.meetup.com/meetup_api/oauth_consumers/create/</a>\n    </li>\n    <li>\n      Set the Consumer name to the name of your application.\n    </li>\n    <li>\n      Optionally set the Application Website to the URL of your\n      website.  You can leave this blank.\n    </li>\n    <li>\n      Set the <b>Redirect URI</b> to: <span class=\"url\">",["{",[[0,"siteUrl"]]],"</span>  (Do not append a path to this URL.)\n    </li>\n  </ol>"]));
                                                                                    // 2
//////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

//////////////////////////////////////////////////////////////////////////////////////
//                                                                                  //
// packages/meetup/meetup_configure.js                                              //
//                                                                                  //
//////////////////////////////////////////////////////////////////////////////////////
                                                                                    //
Template.configureLoginServiceDialogForMeetup.siteUrl = function () {               // 1
  return Meteor.absoluteUrl();                                                      // 2
};                                                                                  // 3
                                                                                    // 4
Template.configureLoginServiceDialogForMeetup.fields = function () {                // 5
  return [                                                                          // 6
    {property: 'clientId', label: 'Key'},                                           // 7
    {property: 'secret', label: 'Secret'}                                           // 8
  ];                                                                                // 9
};                                                                                  // 10
//////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

//////////////////////////////////////////////////////////////////////////////////////
//                                                                                  //
// packages/meetup/meetup_client.js                                                 //
//                                                                                  //
//////////////////////////////////////////////////////////////////////////////////////
                                                                                    //
Meetup = {};                                                                        // 1
// Request Meetup credentials for the user                                          // 2
// @param options {optional}                                                        // 3
// @param credentialRequestCompleteCallback {Function} Callback function to call on // 4
//   completion. Takes one argument, credentialToken on success, or Error on        // 5
//   error.                                                                         // 6
Meetup.requestCredential = function (options, credentialRequestCompleteCallback) {  // 7
  // support both (options, callback) and (callback).                               // 8
  if (!credentialRequestCompleteCallback && typeof options === 'function') {        // 9
    credentialRequestCompleteCallback = options;                                    // 10
    options = {};                                                                   // 11
  }                                                                                 // 12
                                                                                    // 13
  var config = ServiceConfiguration.configurations.findOne({service: 'meetup'});    // 14
  if (!config) {                                                                    // 15
    credentialRequestCompleteCallback && credentialRequestCompleteCallback(new ServiceConfiguration.ConfigError("Service not configured"));
    return;                                                                         // 17
  }                                                                                 // 18
  var credentialToken = Random.id();                                                // 19
                                                                                    // 20
  var scope = (options && options.requestPermissions) || [];                        // 21
  var flatScope = _.map(scope, encodeURIComponent).join('+');                       // 22
                                                                                    // 23
  var loginUrl =                                                                    // 24
        'https://secure.meetup.com/oauth2/authorize' +                              // 25
        '?client_id=' + config.clientId +                                           // 26
        '&response_type=code' +                                                     // 27
        '&scope=' + flatScope +                                                     // 28
        '&redirect_uri=' + Meteor.absoluteUrl('_oauth/meetup?close') +              // 29
        '&state=' + credentialToken;                                                // 30
                                                                                    // 31
  // meetup box gets taller when permissions requested.                             // 32
  var height = 620;                                                                 // 33
  if (_.without(scope, 'basic').length)                                             // 34
    height += 130;                                                                  // 35
                                                                                    // 36
  Oauth.showPopup(                                                                  // 37
    loginUrl,                                                                       // 38
    _.bind(credentialRequestCompleteCallback, null, credentialToken),               // 39
    {width: 900, height: height}                                                    // 40
  );                                                                                // 41
};                                                                                  // 42
                                                                                    // 43
//////////////////////////////////////////////////////////////////////////////////////

}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package.meetup = {
  Meetup: Meetup
};

})();

//# sourceMappingURL=f9732b5945e59072c96b7914b5522de1edb68723.map
