// Shared by middleware and the root layout (pure; no imports). The customer-facing surface is the set of paths served with no session and no Toolbox shell.
export const CUSTOMER_SURFACE_HEADER = "x-nq-surface";
export const CUSTOMER_SURFACE_VALUE = "customer-response";
export const isCustomerSurface = (pathname: string): boolean => /^\/(api\/)?quote-response(\/|$)/.test(pathname);
