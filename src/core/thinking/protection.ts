import { ChangedNote } from '../document';

/** A host supplies resolved native-reference evidence, including untyped/formerly known
 * containers. Parsing only currently typed notebooks is never a complete negative scan. */
export interface ThinkingReferenceObservation {
  path: string;
  sourcePaths: readonly string[];
  complete: boolean;
}
export interface ThinkingProtectionAuthority {
  readonly revision: number;
  readonly coverage: 'complete' | 'unknown';
  /** Unknown coverage deliberately protects every source. */
  readonly protected: boolean;
  /** Synchronous final-trash guard. Takes no file lane and performs no writes. */
  assertUnprotected(): void;
}
/** Generation-local read-only retention authority; never persisted and never a graph ID.
 * Invalidate synchronously before scheduling observations for edits, moves, trash, type
 * loss, malformed records or stale metadata. Publish only a complete native scan, using
 * its captured revision and every expected path. Hosts still own native event coverage. */
export class ThinkingProtection {
  private contentRevision = 0;
  private covered = false;
  private incoming = new Set<string>();
  get revision(): number {
    return this.contentRevision;
  }
  invalidate(): number {
    this.contentRevision++;
    this.covered = false;
    return this.contentRevision;
  }
  publish(
    revision: number,
    observations: readonly ThinkingReferenceObservation[],
    expectedPaths: readonly string[],
  ): boolean {
    if (revision !== this.contentRevision) return false;
    // Publication itself changes authority, even if a caller missed an invalidation.
    this.contentRevision++;
    this.covered = false;
    const observed = new Set(observations.map((item) => item.path));
    if (
      observed.size !== observations.length ||
      expectedPaths.some((path) => !observed.has(path)) ||
      observations.some((item) => !item.complete)
    )
      return false;
    this.incoming = new Set(observations.flatMap((item) => [...item.sourcePaths]));
    this.covered = true;
    return true;
  }
  authority(sourcePath: string): ThinkingProtectionAuthority {
    const revision = this.contentRevision;
    const coverage = this.covered ? 'complete' : 'unknown';
    const protectedSource = !this.covered || this.incoming.has(sourcePath);
    return Object.freeze({
      revision,
      coverage,
      protected: protectedSource,
      assertUnprotected: () => {
        if (
          revision !== this.contentRevision ||
          !this.covered ||
          protectedSource ||
          this.incoming.has(sourcePath)
        )
          throw new ChangedNote(
            'Thinking reference coverage changed or protects this source. The article was retained.',
          );
      },
    });
  }
}
