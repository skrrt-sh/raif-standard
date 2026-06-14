// Prompt templates for the LLM harness. Same scaffolding for both formats so
// the comparison is symmetric: a short spec, three worked examples, the target
// object, and a strict OUTPUT cue.
//
// Designed for small models (1–3B params) that are easily distracted. Specs
// stay under 15 lines; examples cover the key shapes the corpus exercises.

const RAIF_SPEC = `RAIF — write ONE JSON object as a sequence of lines.
- Each line is either: key=value, key.subkey=value, key[N]=value
- Nested objects use dot paths.  Arrays use [N] indexes.
- Literals: =null, =[], ={}, =true, =false, =42, =3.14
- Strings with spaces, commas, colons, brackets are fine bare.
- WRAP with <<<...>>> if the string equals a literal (=<<<null>>>, =<<<42>>>),
  starts with <<<, contains <<<, has leading/trailing whitespace, or is empty.
- Multiline strings: key=<<<\\n…content…\\n>>>  (open and close on own lines).
- Inline object literal:     prefix={k1=v1,k2=v2,k3=v3}
- Table (homogeneous rows):  prefix::col1,col2,col3 then prefix[N]=v1,v2,v3
- Array literal (rows on lines): prefix=[\\n…row…\\n…row…\\n]`;

const JSON_SPEC = `JSON — write ONE JSON object.
- Use double-quoted keys and strings.
- Use null, true, false, numbers, arrays, nested objects as usual.
- No trailing commas, no comments, no JS extensions.`;

interface Example {
  input: string;
  output: string;
}

const RAIF_EXAMPLES: Example[] = [
  {
    input: `{"to": "client@example.com", "subject": "Hello", "priority": 2, "active": true}`,
    output: `active=true
priority=2
subject=Hello
to=client@example.com`,
  },
  {
    input: `{"user": {"id": 7, "handle": "egor", "verified": true}, "tags": ["admin", "ops", "lead"]}`,
    output: `tags=[
admin
ops
lead
]
user={handle=egor,id=7,verified=true}`,
  },
  {
    input: `{"items": [{"id": 1, "name": "foo", "qty": 2}, {"id": 2, "name": "bar", "qty": 5}, {"id": 3, "name": "baz", "qty": 1}]}`,
    output: `items::id,name,qty
items[0]=1,foo,2
items[1]=2,bar,5
items[2]=3,baz,1`,
  },
];

const JSON_EXAMPLES: Example[] = [
  {
    input: `{"to": "client@example.com", "subject": "Hello", "priority": 2, "active": true}`,
    output: `{"active":true,"priority":2,"subject":"Hello","to":"client@example.com"}`,
  },
  {
    input: `{"user": {"id": 7, "handle": "egor", "verified": true}, "tags": ["admin", "ops", "lead"]}`,
    output: `{"tags":["admin","ops","lead"],"user":{"handle":"egor","id":7,"verified":true}}`,
  },
  {
    input: `{"items": [{"id": 1, "name": "foo", "qty": 2}, {"id": 2, "name": "bar", "qty": 5}, {"id": 3, "name": "baz", "qty": 1}]}`,
    output: `{"items":[{"id":1,"name":"foo","qty":2},{"id":2,"name":"bar","qty":5},{"id":3,"name":"baz","qty":1}]}`,
  },
];

function renderExamples(exs: Example[]): string {
  return exs
    .map(
      (e, i) => `Example ${i + 1}:
INPUT:
${e.input}

OUTPUT:
${e.output}`,
    )
    .join("\n\n");
}

export function buildPrompt(format: "raif" | "json", targetJSON: object): string {
  const spec = format === "raif" ? RAIF_SPEC : JSON_SPEC;
  const exs = format === "raif" ? RAIF_EXAMPLES : JSON_EXAMPLES;
  const target = JSON.stringify(targetJSON);
  return `You are a strict format encoder. Output ONLY the requested format. No prose, no markdown fences, no commentary. Do not echo the input.

${spec}

${renderExamples(exs)}

Now emit this object in the same format:

INPUT:
${target}

OUTPUT:
`;
}
