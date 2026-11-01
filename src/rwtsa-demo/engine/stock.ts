/**
 * Opening Available stock (brief §4): JHB + Durban + Cape Town + Factory Store - Committed.
 * Bond (not available) and In transit (not yet received) are deliberately NOT part of it.
 */
export interface AvailableInputs {
  readonly jhb: number;
  readonly durban: number;
  readonly capeTown: number;
  readonly factoryStore: number;
  readonly committed: number;
}

export function availableOf(r: AvailableInputs): number {
  return r.jhb + r.durban + r.capeTown + r.factoryStore - r.committed;
}
