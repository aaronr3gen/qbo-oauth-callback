import type { VercelRequest, VercelResponse } from "@vercel/node";
import { buildIntuitAuthorizeUrl } from "../../src/intuit.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).send("Method not allowed");
  const ticket = typeof req.query.ticket === "string" ? req.query.ticket : "";
  if (!ticket) return res.status(400).send("Missing connection ticket");
  try {
    const url = await buildIntuitAuthorizeUrl(ticket);
    return res.redirect(302, url);
  } catch {
    return res.status(400).send("This QuickBooks connection link is invalid, expired, or already used.");
  }
}
