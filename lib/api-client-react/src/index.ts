export * from "./generated/api";
export * from "./generated/api.schemas";
export { setBaseUrl, getBaseUrl, setAuthTokenGetter, setOnUnauthorized, setOnFeatureDenied, ApiError, customFetch } from "./custom-fetch";
export type { AuthTokenGetter, UnauthorizedHandler, FeatureDeniedHandler } from "./custom-fetch";
