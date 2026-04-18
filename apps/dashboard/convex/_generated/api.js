/* eslint-disable */
/**
 * Frontend-only Convex client contract for pnzu-frontend.
 *
 * The backend source of truth lives in `pnzu/convex`.
 * This runtime shim mirrors Convex's generated `api.js` behavior so the
 * frontend can keep using `api.module.function` references against the
 * deployed `pnzu` backend.
 */

import { anyApi, componentsGeneric } from "convex/server";

export const api = anyApi;
export const internal = anyApi;
export const components = componentsGeneric();
