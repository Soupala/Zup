Ideas = new Meteor.Collection("ideas");

Template.addidea.events({
    'click input.add-idea' : function(event){
        event.preventDefault();
        var ideaText = document.getElementById("ideaText").value;
        Meteor.call("addIdea",ideaText,function(error , ideaId){
          console.log('added idea with Id .. '+ideaId);
        });
        document.getElementById("ideaText").value = "";

    }
});

Template.idea.events({
    'click a.yes' : function (event) {
      event.preventDefault();
      if(Meteor.userId()){
        var ideaId = this._id;
        //console.log(this); You can use this to see what objects you can access from the current context,
        //including data used to render the template this event is being fired inside.

        console.log('updating yes count for ideaId '+ideaId);
        Meteor.call("incrementYesVotes",ideaId);

      }

    },
    'click a.no': function(){
      event.preventDefault();
      if(Meteor.userId()){
        var ideaId = this._id;
        console.log('updating no count for ideaId '+ideaId);
        Meteor.call("incrementNoVotes",ideaId);
      }
    }
  });

Template.ideas.items = function(){
    return Ideas.find({},{sort:{'submittedOn':-1}});
 };
