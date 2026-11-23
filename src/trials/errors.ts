// Something asked of a draft or a trial that can't be done, said in words for the person who asked. The status is the
// HTTP one the API answers with: 400 for a bad request, 404 for what isn't there, 409 for the wrong moment.
export class Refused extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}
