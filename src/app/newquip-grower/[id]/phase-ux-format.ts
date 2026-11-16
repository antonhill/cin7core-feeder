// Plain money formatting for the phase screens (the same R1,234.00 style as the Estimator workspace).
export const rand = (n: number): string => `R${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const randCents = (c: number): string => rand(c / 100);
