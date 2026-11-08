/** Who is performing an operation. Phase 2 adds roles and real authentication. */
export interface Session {
  readonly userName: string;
}

export const SYSTEM_SESSION: Session = Object.freeze({ userName: 'system' });
