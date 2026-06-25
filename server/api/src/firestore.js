import { Firestore } from "@google-cloud/firestore";

let db = null;

export function getFirestore() {
  if (!db) {
    db = new Firestore({
      projectId: process.env.GCP_PROJECT_ID,
      databaseId: process.env.FIRESTORE_DATABASE || "(default)",
    });
  }
  return db;
}

export function getJobsCollection() {
  return getFirestore().collection("renderJobs");
}

export function getRateLimitsCollection() {
  return getFirestore().collection("rateLimits");
}

export function getApprovedUsersCollection() {
  return getFirestore().collection("approvedUsers");
}
