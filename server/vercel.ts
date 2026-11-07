// Vercel function entry. scripts/build-vercel.mjs bundles this into
// .vercel/output/functions/api.func; every /api/* request is routed to it.
import "./vercelEnv.js";
import { getRequestListener } from "@hono/node-server";
import app from "./app.js";

export default getRequestListener(app.fetch);
