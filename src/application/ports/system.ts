/** Time source. The domain never reads the clock itself. */
export interface Clock {
  now(): Date;
}

/** UUIDv7 generator (time-ordered, index friendly). */
export interface IdGenerator {
  next(): string;
}

export const CLOCK = Symbol('Clock');
export const ID_GENERATOR = Symbol('IdGenerator');
