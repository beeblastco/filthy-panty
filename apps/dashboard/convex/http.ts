/**
 * HTTP router for inbound requests to the Convex site URL.
 * Registers WorkOS AuthKit webhook routes for user lifecycle events.
 */
import { httpRouter } from "convex/server";
import { authKit } from "./auth";

const http = httpRouter();

/**
 * Register WorkOS AuthKit webhook routes for user lifecycle events.
 * See: https://www.convex.dev/components/workos-authkit
 */
authKit.registerRoutes(http);

export default http;
