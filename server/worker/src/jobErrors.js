export class JobCancelledError extends Error {
  constructor(message = "Job cancelled") {
    super(message);
    this.name = "JobCancelledError";
  }
}
