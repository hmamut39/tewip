// The JSON a model meant to send, out of whatever it actually sent.
//
// OpenAI's `response_format: json_schema` with `strict: true` constrains generation, so the content
// is a bare JSON object and `JSON.parse` is enough. That is the only provider this was ever run
// against, and it made the parsing look simpler than it is.
//
// Phase 47 put the real client in front of a local OpenAI-compatible server - the path a hospital or
// a bank has to use, because they cannot send source code to a hosted API - and two of the three
// commonest local-model replies crashed it:
//
//     ```json\n{ ... }\n```          SyntaxError: Unexpected token '`'
//     Here is the analysis:\n\n{...} SyntaxError: Unexpected token 'H'
//
// Self-hosted Ollama does constrain generation through llama.cpp's grammar decoder, but its own
// documentation records backends that accept `json_schema` and quietly do not enforce it, and every
// other local runner - LM Studio, vLLM, llama.cpp's own server - has its own answer. A fence and a
// sentence of preamble are not a model misbehaving; they are what an unconstrained model does.
//
// This is extraction, not repair. Nothing is guessed and nothing is rewritten: the fence comes off,
// the object between the outermost braces is taken, and anything that still will not parse throws
// with what actually arrived. A model that replies with prose and no JSON is still an error.
const FENCED = /^\s*```(?:json|jsonc|JSON)?\s*\n([\s\S]*?)\n?\s*```\s*$/;

/** Parses a model's reply as JSON, tolerating a fence or a sentence in front of it. */
export function jsonFromModel<T>(raw: string): T {
  const attempts = [raw, ...candidates(raw)];
  for (const text of attempts) {
    try {
      return JSON.parse(text) as T;
    } catch {
      continue;
    }
  }
  throw new Error(`the model did not return JSON: ${raw.trim().slice(0, 200)}${raw.trim().length > 200 ? '…' : ''}`);
}

/** The shapes worth trying, in order of how sure we are about them. */
function candidates(raw: string): string[] {
  const out: string[] = [];
  const fenced = FENCED.exec(raw.trim());
  if (fenced) out.push(fenced[1]);
  // The outermost braces, which is what a sentence of preamble leaves behind. Taken from the first
  // `{` to the last `}` rather than by counting: a brace inside a string would defeat the counter,
  // and if the slice is unbalanced `JSON.parse` says so and the next candidate is tried.
  const source = fenced ? fenced[1] : raw;
  const open = source.indexOf('{');
  const close = source.lastIndexOf('}');
  if (open !== -1 && close > open) out.push(source.slice(open, close + 1));
  // The same for an array, which `write` and `plan` can both legitimately return.
  const openArray = source.indexOf('[');
  const closeArray = source.lastIndexOf(']');
  if (openArray !== -1 && closeArray > openArray && (open === -1 || openArray < open)) out.push(source.slice(openArray, closeArray + 1));
  return out;
}
