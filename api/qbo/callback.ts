import type { VercelRequest, VercelResponse } from "@vercel/node";
import { exchangeIntuitCallback } from "../../src/intuit.js";

function page(title: string, message: string, ok: boolean) {
  const color = ok ? "#137333" : "#b3261e";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:680px;margin:64px auto;padding:0 20px;color:#202124"><h1 style="color:${color}">${title}</h1><p>${message}</p></body></html>`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).send("Method not allowed");
  const error = typeof req.query.error === "string" ? req.query.error : undefined;
  if (error) return res.status(400).send(page("QuickBooks connection failed", "Authorization was declined or could not be completed. Return to ChatGPT and create a new connection link.", false));

  const code = typeof req.query.code === "string" ? req.query.code : "";
  const realmId = typeof req.query.realmId === "string" ? req.query.realmId : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  if (!code || !realmId || !state) return res.status(400).send(page("QuickBooks connection failed", "The callback was missing required values. Return to ChatGPT and create a new connection link.", false));

  try {
    await exchangeIntuitCallback({ code, realmId, state });
    return res.status(200).send(page("QuickBooks connected", "The company is connected securely. You can close this window and return to ChatGPT.", true));
  } catch (err) {
    console.error("QuickBooks OAuth callback failed", err instanceof Error ? err.message : "unknown");
    return res.status(400).send(page("QuickBooks connection failed", "The connection could not be saved. Return to ChatGPT and create a new connection link.", false));
  }
}
