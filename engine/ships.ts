// Does this file ship, or is it here to develop and test the project?
//
// Two commands ask it and they were answering differently. `infra` had a path test and kept its
// findings in two sections, "In what ships" and "In development and test setups" - the second
// saying out loud that a devcontainer running privileged is usually deliberate. `sbom` had no such
// question at all, so a report titled **"What this project ships"** counted every Dockerfile it
// found.
//
// immich is where that showed. Its `server/Dockerfile.dev` builds the stages `dev`,
// `dev-container-server` and `dev-container-mobile` from `base-server-dev`, and apt-installs
// `vim`, `nano`, `inetutils-ping` and `openjdk-21-jre-headless` - developer tools, in a file whose
// name says so, listed under what the project ships. The path test could not see it: the file sits
// at `server/Dockerfile.dev`, not under `.devcontainer/`.
//
// So the name is read as well as the path. `Dockerfile.dev` says what `.devcontainer/Dockerfile`
// says, and a convention this common is evidence, not a guess.
//
// Found in Phase 213 by reading what `sbom` and `infra` say about a real repository.

/** Directories whose contents are for developing or testing this project, not for shipping it. */
const NOT_SHIPPED_PATH = /(^|\/)(\.devcontainer|\.github|test|tests|e2e|examples?|docs?|fixtures?|sample)s?(\/|$)/i;

/**
 * Filenames that say it: `Dockerfile.dev`, `compose.test.yaml`, `docker-compose.local.yml`.
 *
 * The marker must be a whole dot-separated part, so `Dockerfile` and `docker-compose.yml` are
 * untouched, and so is a file that merely contains the letters - `devise.yml`, `latest.yml`.
 */
const NOT_SHIPPED_NAME = /(^|\/)[^/]*\.(dev|development|test|local)(\.[^/.]+)?$/i;

/** True when this file is part of what the project ships. */
export const ships = (rel: string): boolean => {
  const path = rel.split(String.fromCharCode(92)).join('/');
  return !NOT_SHIPPED_PATH.test(path) && !NOT_SHIPPED_NAME.test(path);
};
