// The version floor: deciding whether this build is too old to run.
//
// The server reports an optional `minVersion` on /health (set by the
// MIN_CLIENT_VERSION env var, normally unset). This module owns the
// comparison, pure and tested, because the one thing a hard stop must never
// do is fire by accident:
//
//   - **Fail safe, in every direction.** No floor, an unparseable floor, an
//     unparseable own version ("unknown" in dev and in any build outside the
//     Docker pipeline) -- all of them mean "not below the floor". The wall
//     is only for a floor that was actually read and actually exceeded; an
//     unreachable server is a network problem and never reaches this module
//     at all (the caller simply keeps whatever answer it last had).
//   - **The floor names a tag.** Build versions come from `git describe`, so
//     a build five commits past v0.1.0 reports "v0.1.0-5-gabc1234" and
//     counts as 0.1.0 here. That is deliberate: floors are set to tagged
//     releases, and every describe-suffixed build of a tag is at least that
//     tag.
//
// Why this exists before anything needs it: a client that does not know how
// to be hard-stopped cannot be. A floor introduced in some later version
// only ever reaches builds that already carry this check -- the same
// shipped-ahead-of-need reasoning as the payload `kind` discriminator. See
// docs/roadmap.md's version-floor decision (2026-09-01).

/**
 * The leading X.Y.Z of a version string, tolerating a "v" prefix and any
 * suffix `git describe` appends. Null when the string does not start with
 * three dot-separated numbers -- which includes "unknown", the empty
 * string, and a bare commit hash (describe's fallback before the first
 * tag existed).
 */
export function parseVersion(
  value: string,
): [major: number, minor: number, patch: number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:$|[-+.])/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * True exactly when both versions parse and `own` is strictly below
 * `floor`. Every failure to parse -- either side, including a null or
 * missing floor -- is false: fail safe is the whole contract.
 */
export function belowFloor(
  own: string,
  floor: string | null | undefined,
): boolean {
  if (!floor) return false;
  const ownParts = parseVersion(own);
  const floorParts = parseVersion(floor);
  if (!ownParts || !floorParts) return false;

  for (let i = 0; i < 3; i++) {
    if (ownParts[i]! !== floorParts[i]!) return ownParts[i]! < floorParts[i]!;
  }
  return false;
}
