import { parseProjectDocument } from "../shared/projectValidation.js";

export function validateProject(doc) {
  return parseProjectDocument(doc);
}
