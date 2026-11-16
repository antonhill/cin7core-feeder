import { formatZar, formatZarCents } from "@/lib/format-money";

// The phase screens use the application's single South African money presentation (R 1 234,50), the same as the quotation, the banner and the submit step.
export const rand = (n: number): string => formatZar(n);
export const randCents = (c: number): string => formatZarCents(c);
