// The help for the two verbs that produce a signed artifact, kept beside the rest rather than in
// it. `cli/help.ts` is one long template literal that grows with every verb, and adding the
// evidence pack pushed it to exactly the 299 lines this project allows - a file at its own limit is
// a trap for whoever adds the next verb. This is the same split, and for the same reason, as
// cli/verbs-assure.ts beside cli/tewip.ts.
export const ASSURE_HELP = `  tewip evidence [folder] [--out pack.md] [--json pack.json] [--key <private.pem>] [--quick]
                 [--since <ref>] [--gate]
                                    One signed document for one repository, answering what a supplier
                                    review, a security questionnaire and an EU AI Act file all ask:
                                    what ships and under which licence, what a model and the
                                    infrastructure may do, what breaks if it ships, and who approved
                                    it - each line carrying the precision and recall that check
                                    scored against a list somebody else published. A check that
                                    cannot run says so in place of its answer, so no empty section
                                    reads as a clean one. --json writes the bundle the seal covers.
                                    No model is called and nothing is fetched. No cost.
  tewip attest [--run <id>] [--out attestation.md] [--json bundle.json]
  tewip attest --verify <bundle.json> [--key <public.pem>]
                                    What Tewip checked for a build, as one artifact: the claims with
                                    their evidence and which layer decided each, what it refused to
                                    decide and why, and what it did not check at all. Nothing enters
                                    it that Tewip did not verify itself. Every bundle carries a
                                    digest; set TEWIP_ATTEST_KEY to an ed25519 private key to sign
                                    it too. --verify says what it checked and what that does not
                                    establish - a digest means undamaged, not unedited. No cost.`;
