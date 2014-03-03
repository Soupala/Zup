(function(){Ideas = new Meteor.Collection("ideas");

Meteor.startup(function () {
    // code to run on server at startup
});

Meteor.methods({
  addIdea : function(ideaText){
    console.log('Adding Idea');
    var ideaId = Idea.insert({
          'ideaText' : ideaText,
          'submittedOn': new Date(),
          'submittedBy' : Meteor.userId()
      });
    return ideaId;
  },
  incrementYesVotes : function(ideaId){
    console.log(ideaId);
    Ideas.update(ideaId,{$inc : {'yes':1}});
  },
  incrementNoVotes : function(ideaId){
    console.log(ideaId);
    Ideas.update(ideaId,{$inc : {'no':1}});
  }
});

})();
