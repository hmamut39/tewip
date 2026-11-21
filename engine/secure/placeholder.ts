// Is this value a credential, or the word for one?
//
// Split out of secrets.ts in Phase 210, when adding it took that file past this project's
// 300-line rule. One rule, one subject, and a narrowness that is measured rather than asserted -
// see the sabotage note in eval/secure-recall.ts, where widening it costs ten real credentials.

/**
 * A value that is the word for what it is - `immichdbpassword`, `yourpassword`, `dbsecret`.
 *
 * immich documents its connection string as
 *
 *     DB_URL='postgresql://immichdbusername:immichdbpassword@postgreshost:postgresport/immichdatabasename'
 *
 * and one line of its docs reads "`DB_URL` must be in the format `postgresql://...`". Every part of
 * that is a self-describing placeholder, which a person sees instantly - and Tewip called each one
 * **"a database URL with a password in it"**, explaining that "the value itself does not say it is
 * an example". It does say so: the password *is* the word `immichdbpassword`. Four of the five
 * findings on immich were this one sentence.
 *
 * Asked of the value and never of the line around it, which is the whole care needed here.
 * `PLACEHOLDER_WORDS` above is tested against both, so putting `password` in that list would
 * dismiss every real `password = "..."` assignment there is - the commonest true finding the
 * scanner has, thrown away to tidy up a documentation example.
 *
 * Letters only, because a credential that is nothing but English words is documentation, while
 * `P@ssword123!` is somebody's actual password and keeps its digits and symbols. A real one that is
 * all letters and happens to contain "secret" is downgraded to noise, which is still **printed** -
 * the noise section exists so that nothing is hidden - so the cost of being wrong here is a finding
 * moving between two sections of the same report.
 */
const DESCRIBES_ITSELF = /^[a-z]*(?:password|passwd|secret|token|apikey|credential|username)[a-z]*$/i;

export const describesItself = (value: string): boolean => value.length >= 6 && DESCRIBES_ITSELF.test(value);

