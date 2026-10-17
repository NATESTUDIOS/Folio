import crypto from "crypto";

export function log(event, fields = {}) {
  try {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      svc: "folio",
      event,
      ...fields,
    }));
  } catch {
    console.log(`[folio] ${event}`);
  }
}

export function newReqId() {
  return crypto.randomBytes(6).toString("hex");
}