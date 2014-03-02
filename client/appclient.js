Ideas = new Meteor.Collection("ideas");
  
Template.addidea.events({
    'click input.add-idea' : function(event){
        event.preventDefault();
        var ideaText = document.getElementById("ideaText").value;
        Meteor.call("addIdea",ideaText,function(error , ideaId){
          console.log('added idea with Id .. '+ideaId);
        });
        document.getElementById("questionText").value = "";

    }
});

Template.question.events({
	'click': function () {
    	Session.set("selected_question", this._id);
    },

    'click a.yes' : function (event) {
      event.preventDefault();
      if(Meteor.userId()){
        var ideaId = Session.get('selected_idea');
        console.log('updating yes count for ideaId '+ideaId);
        Meteor.call("incrementYesVotes",ideaId);
        
      }
      
    },
    'click a.no': function(){
      event.preventDefault();
      if(Meteor.userId()){
        var ideaId = Session.get('selected_idea');
        console.log('updating no count for ideaId '+ideaId);
        Meteor.call("incrementNoVotes",ideaId);
      }
    }
  });

Template.ideas.items = function(){
    return Ideas.find({},{sort:{'submittedOn':-1}});
 };
