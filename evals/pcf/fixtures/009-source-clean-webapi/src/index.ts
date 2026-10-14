export class StarRating {
  public updateView(context) {
    return context.webAPI.retrieveRecord('account', '00000000-0000-0000-0000-000000000000');
  }
}
