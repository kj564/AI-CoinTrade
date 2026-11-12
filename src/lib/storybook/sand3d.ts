import { withZaiRetry } from "@/lib/zai";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const SAND3D_PROPS_DIR = path.join(process.cwd(), "public", "download", "sand3d-props");
const NODE_BIN = process.env.NODE_BIN || "node";

// The shim API the LLM authors against (reverse-engineered sand3d on three.js).
const SHIM_API = `
// sand3d reversed on three.js (import { s3d } from "/sand3d-three.mjs")
// Every solid returns an S3 (wraps a THREE.Mesh). assembly/group return S3 (THREE.Group).
// Z-up: objects sit on z=0, extend upward.

PROFILES (return a shape, used by extrude/revolve):
  rect(w, d, r=0)              // rectangle, optional corner radius
  circle(d)
  polygon(n, d)                // regular n-gon (n corners)
  ellipse(w, d);  slot(l, d)

SOLIDS (return S3):
  box(name, w, d, h)           // base on z=0
  cylinder(name, d, h)
  cone(name, d, h, d2=0)       // d2 = top diameter (0 = point)
  sphere(name, d)              // sits ON z=0
  torus(name, d, d_wire)       // lies flat
  extrude(name, profile, h)    // prism up Z by h
  revolve(name, profile, angle=360)  // profile = [[r,h],...] lathe about Z

PLACEMENT:
  part.face("+Z"|"-Z"|"+Y"|"-Y"|"+X"|"-X"|"top"|"bottom")  // returns a Frame on that face
  s3d.bbox(part, "+Z"|"-X+Y"|...)                           // Frame on a bbox side/edge/corner
  s3d.at(child, { on: frame, x=0, y=0, z=0, rx=0, ry=0, rz=0 })
        // places child on the frame; x/y/z offset along frame axes; rx/ry/rz rotate about frame axes.
        // returns child.

GROUPS:
  s3d.assembly(name, ...parts)   // -> S3 (THREE.Group). RETURN THIS from build().
  s3d.group(name, ...parts)
  s3d.join(a, ...others)         // fuse visually (group). returns a.

STUBS (no-ops, safe to call): fillet, chamfer, soften, shell, hole, pocket, cut, dent, scale(ob,s), copy(ob), material(ob, name, {color}).

export function build() { ... return s3d.assembly("name", part1, part2, ...); }
`;

const SYSTEM_PROMPT = `You are a 3D modeler who writes sand3d programs REVERSED on three.js (no Blender). A model is a short JS module that builds a real three.js object.

Write a SINGLE JS file:
  import { s3d } from "/sand3d-three.mjs";

  export function build() {
      // build with s3d verbs, return s3d.assembly(...)
      return s3d.assembly("name", part1, part2);
  }

${SHIM_API}

RULES:
- Output ONLY the JS file. No markdown fences, no commentary.
- Start with \`import { s3d } from "/sand3d-three.mjs";\` and \`export function build()\`.
- Keep it 10-45 lines. Millimetres. Hand-held prop scale (~80-400 mm).
- Use ONLY the verbs above. Prefer box/cylinder/cone/sphere/extrude/revolve + rect/circle/polygon.
- Place parts with s3d.at(child, { on: parent.face("+Z"), z: H }). Valid faces: "+Z","-Z","+Y","-Y","+X","-X","top","bottom".
- Do NOT use s3d.material() (colours are applied later). Just build shapes.
- The object must stand on z=0 (base at z=0, extending upward).
- Every part passed to s3d.assembly must exist. s3d.at returns the placed part — use that.
- Keep it ROBUST and simple: avoid edge/corner frame combos, avoid groups-within-groups.
- Add a clear silhouette so the prop is recognizable as a small transparent cutout.`;

/** Syntax-check a JS file via `node --check`. Returns null if OK, else the error. */
function syntaxCheck(filePath: string): string | null {
  try {
    execFileSync(NODE_BIN, ["--check", filePath], { timeout: 15000, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    return null;
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    const msg = (err.stderr || err.stdout || err.message || "").toString().split("\n").filter((l) => /error|SyntaxError/i.test(l)).slice(-1).join(" ").slice(0, 200);
    return msg || "syntax error";
  }
}

export interface Sand3dResult {
  program: string;
  programFile: string;
  programPath: string;
  programUrl: string;
  slug: string;
}

/** Author a sand3d JS program (reversed on three.js), self-healing syntax errors. */
export async function authorSand3dProgram(
  name: string,
  description: string,
  propId: string,
  emoji?: string
): Promise<Sand3dResult> {
  if (!fs.existsSync(SAND3D_PROPS_DIR)) fs.mkdirSync(SAND3D_PROPS_DIR, { recursive: true });
  const slug = (propId || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).slice(0, 40);
  const programFile = `${slug}.mjs`;
  const tmpPath = path.join(SAND3D_PROPS_DIR, programFile);

  const messages: { role: "assistant" | "user"; content: string }[] = [
    { role: "assistant", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Author a sand3d (three.js) program for a 3D prop.
Name: ${name}
Description: ${description || "(no extra description)"}
Emoji hint: ${emoji ?? "n/a"}

Write the JS module now.`,
    },
  ];

  let program = "";
  let lastError = "";
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const completion = await withZaiRetry(
      (zai) => zai.chat.completions.create({ messages, thinking: { type: "disabled" } }),
      { maxRetries: 2, retryDelayMs: 1500 },
    );
    let candidate = (completion.choices[0]?.message?.content ?? "").trim();
    const fence = candidate.match(/```(?:javascript|js)?\s*([\s\S]*?)```/i);
    if (fence) candidate = fence[1].trim();
    if (!candidate.includes("s3d")) {
      lastError = "did not use s3d";
      messages.push({ role: "user", content: `That did not import s3d. Start with: import { s3d } from "/sand3d-three.mjs";` });
      continue;
    }
    fs.writeFileSync(tmpPath, candidate);
    const err = syntaxCheck(tmpPath);
    if (!err) {
      program = candidate;
      break;
    }
    lastError = err;
    if (attempt < MAX_ATTEMPTS) {
      messages.push({ role: "user", content: `That program has a SYNTAX ERROR:\n${err}\n\nFix it. Output ONLY the JS file.` });
    }
  }
  if (!program) throw new Error(`sand3d JS authoring failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);

  fs.writeFileSync(tmpPath, program);
  return {
    program,
    programFile,
    programPath: `/download/sand3d-props/${programFile}`,
    programUrl: `/download/sand3d-props/${programFile}`,
    slug,
  };
}
