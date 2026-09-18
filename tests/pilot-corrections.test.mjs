/**
 * The defects a real pilot found, each reproduced before it was fixed.
 *
 * Every test here started life as a reproduction: the sequence in the comment
 * was run against 0.3.0-alpha.4 and produced the wrong behaviour, and only then
 * was the engine changed. They are kept in that shape on purpose — a regression
 * test written after the fact tends to assert what the code does rather than
 * what the user needed, and these are the eight places where that distinction
 * had already cost something.
 *
 * Nothing here refers to the project the pilot ran on. The sequences are the
 * general shape of each defect; the case that produced them is recorded in the
 * private dossier.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main, commandSurface } from "../lib/cli.js";
import { ageProject } from "./older-engine.mjs";

const OWNERS = JSON.stringify({ product: "Ada", technical: "Ada", budget: "Ada", safety: "Ada", release: "Ada" });

/** A fresh project, and whatever files the test wants in it. */
function project(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plangonaut-pilot-"));
  fs.writeFileSync(path.join(root, "owners.json"), OWNERS);
  for (const [relative, content] of Object.entries(files)) {
    const location = path.join(root, relative);
    fs.mkdirSync(path.dirname(location), { recursive: true });
    fs.writeFileSync(location, content);
  }
  return root;
}

/**
 * Run a command, capturing what it printed and how it refused.
 *
 * `main` does not throw on a refusal: it prints and returns a non-zero code. A
 * first version of this helper only caught exceptions, so every refusal looked
 * like a success and half these tests passed while asserting the opposite of
 * what they meant. `error` is therefore non-null whenever the command failed,
 * however it failed, and `message` is what the user would have read.
 */
async function run(...argv) {
  const out = [];
  const err = [];
  const stdout = console.log;
  const stderr = console.error;
  console.log = (...parts) => out.push(parts.join(" "));
  console.error = (...parts) => err.push(parts.join(" "));
  let thrown = null;
  let code = 0;
  try {
    code = await main(argv);
  } catch (caught) {
    thrown = caught;
  } finally {
    console.log = stdout;
    console.error = stderr;
  }
  const printed = [...out, ...err].join("\n");
  const failed = thrown !== null || code !== 0;
  const message = thrown?.message ?? (failed ? printed : "");
  return { out: out.join("\n"), stderr: err.join("\n"), error: failed ? (thrown ?? new Error(message)) : null, message, code };
}

async function initialized(files = {}) {
  const root = project(files);
  const result = await run("init", "--project-root", root, "--project-name", "X", "--project-mode", "Genesis",
    "--interaction-mode", "Standard", "--owners-file", path.join(root, "owners.json"), "--operation-id", "op-init");
  assert.equal(result.error, null, result.message);
  return root;
}

let sequence = 0;
const op = (label) => `op-${label}-${(sequence += 1)}`;

/** One question asked, answered and settled, on a module. */
async function interaction(root, id, question, module = 1) {
  const answer = path.join(root, `${id}-answer.txt`);
  fs.writeFileSync(answer, `answer to ${question}\n`);
  await run("qa-ask", "--project-root", root, "--id", id, "--question", question, "--rationale", "because",
    "--owner", "Ada", "--module", String(module), "--operation-id", op("ask"));
  await run("qa-answer", "--project-root", root, "--id", id, "--answer-file", answer, "--owner", "Ada",
    "--operation-id", op("answer"));
  await run("qa-settle", "--project-root", root, "--id", id, "--interpretation", "understood",
    "--reply-file", answer, "--owner", "Ada", "--operation-id", op("settle"));
}

// ---------------------------------------------------------------------------
// 1. A document written outside the ledger
// ---------------------------------------------------------------------------

test("an unclaimed -vN document is reported, and --strict refuses on it", async () => {
  // init; printf '# architettura' > docs/design-v1.md; validate
  //   was: "Plangonaut state is valid." and nothing else, for the whole session.
  const root = await initialized();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "design-v1.md"), "# architettura\n");

  const warned = await run("validate", "--project-root", root);
  assert.equal(warned.error, null, warned.message);
  assert.match(warned.out, /docs\/design-v1\.md/);
  assert.match(warned.out, /outside the ledger/);
  // The state itself is still valid: the two statements are kept apart.
  assert.match(warned.out, /Plangonaut state is valid\./);

  const strict = await run("validate", "--project-root", root, "--strict");
  assert.notEqual(strict.error, null, "--strict must fail on an unclaimed document");
  assert.match(strict.message, /docs\/design-v1\.md/);
});

test("the regularisation the warning suggests actually runs, and keeps the bytes", async () => {
  // The warning is worthless if its own remedy is refused, which is what
  // happened first: doc-save met "Refusing to overwrite untracked working file"
  // when handed the very file it was being asked to adopt.
  const root = await initialized();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  const document = path.join(root, "docs", "design-v1.md");
  fs.writeFileSync(document, "# architettura\nuna riga\n");

  const preview = await run("doc-diff", "--project-root", root, "--id", "ART-DESIGN",
    "--base-path", "docs/design.md", "--content-file", document, "--owner", "Ada");
  assert.equal(preview.error, null, preview.message);
  const token = JSON.parse(preview.out).confirmation_token;
  assert.ok(token, "a clean preview returns a token");

  const saved = await run("doc-save", "--project-root", root, "--id", "ART-DESIGN",
    "--base-path", "docs/design.md", "--content-file", document, "--owner", "Ada",
    "--confirm-token", token, "--operation-id", op("save"));
  assert.equal(saved.error, null, saved.message);
  assert.equal(JSON.parse(saved.out).adopted_existing_file, true);
  assert.equal(fs.readFileSync(document, "utf8"), "# architettura\nuna riga\n", "the bytes are untouched");

  const after = await run("validate", "--project-root", root, "--strict");
  assert.equal(after.error, null, after.message);
});

test("a file at the working path with different bytes is still refused", async () => {
  const root = await initialized();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "design-v1.md"), "qualcosa di qualcun altro\n");
  const proposed = path.join(root, "proposed.md");
  fs.writeFileSync(proposed, "# tutt'altro\n");

  const preview = await run("doc-diff", "--project-root", root, "--id", "ART-DESIGN",
    "--base-path", "docs/design.md", "--content-file", proposed, "--owner", "Ada");
  const token = JSON.parse(preview.out).confirmation_token;
  const saved = await run("doc-save", "--project-root", root, "--id", "ART-DESIGN",
    "--base-path", "docs/design.md", "--content-file", proposed, "--owner", "Ada",
    "--confirm-token", token, "--operation-id", op("save"));
  assert.notEqual(saved.error, null, "different content must not be overwritten");
  assert.match(saved.message, /Refusing to overwrite untracked working file/);
  assert.equal(fs.readFileSync(path.join(root, "docs", "design-v1.md"), "utf8"), "qualcosa di qualcun altro\n");
});

test("pre-existing documentation and dependencies are not reported", async () => {
  // The check is worth nothing if adopting a repository with existing docs
  // produces a page of false positives.
  const root = await initialized({
    "docs/gia-qui.md": "# documentazione che era gia' qui\n",
    "README.md": "# readme\n",
    "CHANGELOG.md": "# changelog\n",
    "node_modules/pkg/nota-v2.md": "# di una dipendenza\n",
  });
  const result = await run("validate", "--project-root", root, "--strict");
  assert.equal(result.error, null, result.message);
});

test("an explicit exclusion silences one file and nothing else", async () => {
  const root = await initialized();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "scratch-v1.md"), "# appunti\n");
  fs.writeFileSync(path.join(root, "docs", "altro-v1.md"), "# altro\n");

  // Recorded through the command, not edited into state.json by hand. The list
  // is replayed and digested, so a text-editor change would put the state out of
  // step with its own history — which would mean punishing somebody for doing
  // exactly what the warning asked them to do.
  const recorded = await run("govern", "--project-root", root, "--exclude", "docs/scratch-v1.md",
    "--reason", "appunti di lavoro, non un documento del progetto", "--owner", "Ada",
    "--operation-id", op("govern"));
  assert.equal(recorded.error, null, recorded.message);

  const result = await run("validate", "--project-root", root);
  assert.doesNotMatch(result.out, /scratch-v1/);
  assert.match(result.out, /altro-v1/);
});

// ---------------------------------------------------------------------------
// 2. The document flow, and the token that was not in the help
// ---------------------------------------------------------------------------

test("doc-save --help states the flow and the mandatory token", async () => {
  const result = await run("doc-save", "--help");
  assert.equal(result.error, null, result.message);
  assert.match(result.out, /--confirm-token TOKEN\s+REQUIRED/);
  assert.match(result.out, /doc-diff/);
  assert.match(result.out, /Expiry\s+none/);
});

test("the general help's doc-save line carries --confirm-token", async () => {
  const result = await run("help");
  const line = result.out.split("\n").find((entry) => entry.trim().startsWith("doc-save "));
  assert.ok(line, "the help lists doc-save");
  assert.match(line, /--confirm-token/);
});

test("a missing token is refused with the command that produces one", async () => {
  const root = await initialized({ "docs/a.md": "# a\n" });
  const result = await run("doc-save", "--project-root", root, "--id", "ART-A", "--base-path", "docs/a.md",
    "--content-file", path.join(root, "docs", "a.md"), "--owner", "Ada", "--operation-id", op("save"));
  assert.notEqual(result.error, null);
  assert.match(result.message, /plangonaut doc-diff --project-root/);
  assert.match(result.message, /--id ART-A/);
  assert.match(result.message, /No changes written/);
});

test("a token issued for another artifact does not confirm this save", async () => {
  const root = await initialized({ "docs/a.md": "# a\n", "docs/b.md": "# b\n" });
  const other = await run("doc-diff", "--project-root", root, "--id", "ART-B", "--base-path", "docs/b.md",
    "--content-file", path.join(root, "docs", "b.md"), "--owner", "Ada");
  const token = JSON.parse(other.out).confirmation_token;

  const result = await run("doc-save", "--project-root", root, "--id", "ART-A", "--base-path", "docs/a.md",
    "--content-file", path.join(root, "docs", "a.md"), "--owner", "Ada",
    "--confirm-token", token, "--operation-id", op("save"));
  assert.notEqual(result.error, null, "a token is bound to its artifact");
  assert.match(result.message, /does not match this change/);
});

test("a token stops matching once the artifact advances a revision", async () => {
  // There is no timer on a token, so this is what "expired" means here: the
  // six things it is a digest of are no longer what they were.
  const root = await initialized({ "docs/a.md": "# a\n" });
  const content = path.join(root, "docs", "a.md");
  const first = await run("doc-diff", "--project-root", root, "--id", "ART-A", "--base-path", "docs/a.md",
    "--content-file", content, "--owner", "Ada");
  const token = JSON.parse(first.out).confirmation_token;
  const saved = await run("doc-save", "--project-root", root, "--id", "ART-A", "--base-path", "docs/a.md",
    "--content-file", content, "--owner", "Ada", "--confirm-token", token, "--operation-id", op("save"));
  assert.equal(saved.error, null, saved.message);

  // The same token, a second time, against an artifact now at revision 1.
  fs.writeFileSync(content, "# a\nuna riga in piu'\n");
  const again = await run("doc-save", "--project-root", root, "--id", "ART-A", "--base-path", "docs/a.md",
    "--content-file", content, "--owner", "Ada", "--confirm-token", token, "--operation-id", op("save"));
  assert.notEqual(again.error, null, "a stale token must not confirm a later change");
});

test("a preview that reports blockers hands out no token", async () => {
  const root = await initialized({ "docs/a.md": "# a\n" });
  const result = await run("doc-diff", "--project-root", root, "--id", "ART-A", "--base-path", "../fuori.md",
    "--content-file", path.join(root, "docs", "a.md"), "--owner", "Ada");
  const preview = JSON.parse(result.out);
  assert.equal(preview.confirmation_token, "");
  assert.ok(preview.blockers.length);
});

// ---------------------------------------------------------------------------
// 3. A question the engine itself planned
// ---------------------------------------------------------------------------

test("qa-ask on a PLANNED question points at qa-answer, never qa-supersede", async () => {
  // qa-settle --next-id QNA-0002; qa-ask --id QNA-0002
  //   was: "Use qa-supersede to replace it" — which fabricates a correction
  //   chain on a question that was never put to anybody.
  const root = await initialized();
  const answer = path.join(root, "answer.txt");
  fs.writeFileSync(answer, "risposta\n");
  await run("qa-ask", "--project-root", root, "--id", "QNA-0001", "--question", "prima", "--rationale", "r",
    "--owner", "Ada", "--module", "1", "--operation-id", op("ask"));
  await run("qa-answer", "--project-root", root, "--id", "QNA-0001", "--answer-file", answer, "--owner", "Ada",
    "--operation-id", op("answer"));
  await run("qa-settle", "--project-root", root, "--id", "QNA-0001", "--interpretation", "x",
    "--reply-file", answer, "--owner", "Ada", "--next-id", "QNA-0002", "--next-question", "seconda",
    "--operation-id", op("settle"));

  const result = await run("qa-ask", "--project-root", root, "--id", "QNA-0002", "--question", "seconda",
    "--rationale", "r", "--owner", "Ada", "--operation-id", op("ask"));
  assert.notEqual(result.error, null);
  assert.match(result.message, /as PLANNED/);
  assert.match(result.message, /qa-answer/);
  assert.doesNotMatch(result.message, /qa-supersede/);
});

test("the refusal names the status, and only ANSWERED is sent to qa-supersede", async () => {
  const root = await initialized();
  const answer = path.join(root, "answer.txt");
  fs.writeFileSync(answer, "risposta\n");

  await run("qa-ask", "--project-root", root, "--id", "QNA-0001", "--question", "q", "--rationale", "r",
    "--owner", "Ada", "--module", "1", "--operation-id", op("ask"));
  const asked = await run("qa-ask", "--project-root", root, "--id", "QNA-0001", "--question", "q",
    "--rationale", "r", "--owner", "Ada", "--operation-id", op("ask"));
  assert.match(asked.message, /as ASKED/);
  assert.doesNotMatch(asked.message, /qa-supersede/);

  await run("qa-answer", "--project-root", root, "--id", "QNA-0001", "--answer-file", answer, "--owner", "Ada",
    "--operation-id", op("answer"));
  // An answer recorded and not applied is caught by an earlier guard, and that
  // is the right one: nothing new may be opened while a settlement is
  // outstanding, whatever id it is opened under.
  const unapplied = await run("qa-ask", "--project-root", root, "--id", "QNA-0002", "--question", "altra",
    "--rationale", "r", "--owner", "Ada", "--operation-id", op("ask"));
  assert.match(unapplied.message, /recorded answer and no recorded consequences/);
  assert.match(unapplied.message, /qa-settle/);

  await run("qa-settle", "--project-root", root, "--id", "QNA-0001", "--interpretation", "x",
    "--reply-file", answer, "--owner", "Ada", "--operation-id", op("settle"));
  const settled = await run("qa-ask", "--project-root", root, "--id", "QNA-0001", "--question", "q",
    "--rationale", "r", "--owner", "Ada", "--operation-id", op("ask"));
  assert.match(settled.message, /as ANSWERED/);
  assert.match(settled.message, /qa-supersede/, "a settled answer is the one case that does want supersession");
});

// ---------------------------------------------------------------------------
// 4. A repair command that dictated its own defect back
// ---------------------------------------------------------------------------

test("the re-record suggestion never contains the path that was rejected", async () => {
  // An override recorded (by an older engine) against a path outside the root.
  // validate's own suggested command carried that same path in --source-file.
  const root = await initialized();
  const location = path.join(root, ".plangonaut", "state.json");
  const state = JSON.parse(fs.readFileSync(location, "utf8"));
  const outside = "../fuori-dal-progetto.txt";
  state.human_overrides.push({
    id: "OVR-legacy", status: "OPEN", owner: "Ada", reason: "prova",
    source: outside, source_sha256: "a".repeat(64), summary: "x", created_at: new Date().toISOString(),
  });
  // An open override means the project needs reconciliation; without this the
  // state contradicts itself and validate stops on that instead, before it ever
  // reaches the recorded-source check this test is about.
  state.needs_reconciliation = true;
  fs.writeFileSync(location, `${JSON.stringify(state, null, 2)}\n`);

  const result = await run("validate", "--project-root", root);
  assert.notEqual(result.error, null);
  assert.match(result.message, /re-record/);
  // The negative control: the broken path must not be in the command offered.
  assert.doesNotMatch(result.message, new RegExp(`--source-file\\s+${outside.replace(/\./g, "\\.")}`));
  assert.match(result.message, /--source-file <path-inside-the-project>/);
  assert.match(result.message, /Copy the file into the project first/);
});

test("a portable path whose file is merely missing keeps its path in the suggestion", async () => {
  // The two situations need two instructions: a deleted file is restored, an
  // unportable path cannot be repaired by pointing at it again.
  const root = await initialized();
  const location = path.join(root, ".plangonaut", "state.json");
  const state = JSON.parse(fs.readFileSync(location, "utf8"));
  state.human_overrides.push({
    id: "OVR-gone", status: "OPEN", owner: "Ada", reason: "prova",
    source: "docs/istruzione.md", source_sha256: "b".repeat(64), summary: "x", created_at: new Date().toISOString(),
  });
  state.needs_reconciliation = true;
  fs.writeFileSync(location, `${JSON.stringify(state, null, 2)}\n`);

  const result = await run("validate", "--project-root", root);
  assert.match(result.message, /--source-file docs\/istruzione\.md/);
  assert.match(result.message, /Restore the file/);
});

// ---------------------------------------------------------------------------
// 5. One validation for every file that enters a permanent record
// ---------------------------------------------------------------------------

test("override refuses what reconcile would have refused later", async () => {
  // override --instruction-file <outside>   was: accepted and recorded.
  // reconcile --evidence-file <outside>     was: refused, correctly.
  // The gap was the whole defect: the record was written on Monday and became
  // unreadable on Friday, when the temporary file was gone.
  const root = await initialized();
  const outside = path.join(os.tmpdir(), `plangonaut-outside-${Date.now()}.txt`);
  fs.writeFileSync(outside, "cambio direzione\n");

  const result = await run("override", "--project-root", root, "--instruction-file", outside,
    "--owner", "Ada", "--reason", "prova", "--operation-id", op("override"));
  assert.notEqual(result.error, null, "an external instruction file must be refused at the first door");
  assert.match(result.message, /climbs out with "\.\."|inside the project/);
  assert.match(result.message, /Nothing was written/);

  const state = JSON.parse(fs.readFileSync(path.join(root, ".plangonaut", "state.json"), "utf8"));
  assert.equal(state.human_overrides.length, 0);
  assert.equal(state.needs_reconciliation, false);
});

test("the same refusal covers every option that enters a permanent record", async () => {
  const root = await initialized();
  const outside = path.join(os.tmpdir(), `plangonaut-outside-${Date.now()}-2.txt`);
  fs.writeFileSync(outside, "contenuto\n");

  const cases = [
    ["evidence", "--project-root", root, "--id", "EVD-1", "--file", outside, "--owner", "Ada", "--operation-id", op("evd")],
    ["blocker-record", "--project-root", root, "--id", "BLK-1", "--title", "t", "--reason", "r",
      "--evidence-file", outside, "--owner", "Ada", "--operation-id", op("blk")],
    ["gate", "--project-root", root, "--id", "G1", "--status", "PASSED", "--evidence-file", outside,
      "--owner", "Ada", "--operation-id", op("gate")],
  ];
  for (const argv of cases) {
    const result = await run(...argv);
    assert.notEqual(result.error, null, `${argv[0]} must refuse a file outside the project`);
    assert.match(result.message, /project/i, `${argv[0]}: the refusal says where the file has to be`);
  }
});

test("an empty file inside the project is refused too", async () => {
  const root = await initialized({ "docs/vuoto.md": "   \n" });
  const result = await run("override", "--project-root", root,
    "--instruction-file", path.join(root, "docs", "vuoto.md"),
    "--owner", "Ada", "--reason", "prova", "--operation-id", op("override"));
  assert.notEqual(result.error, null);
  assert.match(result.message, /cannot be empty/);
});

test("an instruction file inside the project is accepted and recorded relatively", async () => {
  const root = await initialized({ "docs/istruzione.md": "cambio direzione\n" });
  const result = await run("override", "--project-root", root,
    "--instruction-file", path.join(root, "docs", "istruzione.md"),
    "--owner", "Ada", "--reason", "prova", "--operation-id", op("override"));
  assert.equal(result.error, null, result.message);
  const state = JSON.parse(fs.readFileSync(path.join(root, ".plangonaut", "state.json"), "utf8"));
  assert.equal(state.human_overrides[0].source, "docs/istruzione.md");
});

// ---------------------------------------------------------------------------
// 6. Published examples that run
// ---------------------------------------------------------------------------

/**
 * Every `plangonaut …` invocation a reader could copy, from one Markdown file.
 *
 * Read from code spans and fenced blocks rather than from raw lines, because
 * Markdown wraps: `user-guide.md` carries a `baseline` example whose
 * `--operation-id` sits at column zero of the next line, inside the same
 * backtick span. A line-based reader calls that a missing option, and a check
 * that cries wolf is a check somebody switches off.
 */
function invocations(markdown) {
  const found = [];
  const fenced = /```[a-z]*\r?\n([\s\S]*?)```/g;
  let block;
  while ((block = fenced.exec(markdown)) !== null) {
    const body = block[1].replace(/\\\r?\n\s*/g, " ");
    for (const line of body.split(/\r?\n/)) {
      const text = line.trim();
      if (text.startsWith("plangonaut ")) found.push(text.replace(/\s+/g, " "));
    }
  }
  const prose = markdown.replace(fenced, "");
  const span = /`([^`]+)`/g;
  let inline;
  while ((inline = span.exec(prose)) !== null) {
    const text = inline[1].replace(/\s+/g, " ").trim();
    if (text.startsWith("plangonaut ")) found.push(text);
  }
  return found;
}

test("every mutating example in the public documentation is complete and runnable", async () => {
  const surface = commandSurface();
  const mutating = new Set(surface.mutating);
  const booleans = new Set(surface.booleans);
  const documents = [
    "skills/plangonaut/SKILL.md",
    "skills/plangonaut/references/user-guide.md",
    "skills/plangonaut/references/engine-contract.md",
    "skills/plangonaut/references/interview-protocol.md",
    "skills/plangonaut/references/artifacts-and-traceability.md",
    "skills/plangonaut/references/coverage-contract.md",
    "README.md",
  ];
  const problems = [];

  for (const relative of documents) {
    const location = new URL(`../${relative}`, import.meta.url);
    if (!fs.existsSync(location)) continue;
    const raw = fs.readFileSync(location, "utf8");
    for (const invocation of invocations(raw)) {
      const match = /^plangonaut\s+([a-z-]+)\s*(.*)$/.exec(invocation);
      if (!match) continue;
      const [, command, tail] = match;
      if (!Object.prototype.hasOwnProperty.call(surface.options, command)) continue;
      // Prose that merely names a command, with no options at all, is not an
      // example and is not held to one.
      if (!tail.trim()) continue;

      const allowed = new Set(surface.options[command]);
      const used = [...tail.matchAll(/--([a-z-]+)/g)].map((entry) => entry[1]);
      // `plangonaut doc-save --help` is a pointer to the help, not a mutation.
      if (used.length === 1 && used[0] === "help") continue;

      for (const option of used) {
        if (!allowed.has(option) && option !== "help") {
          problems.push(`${relative}: \`plangonaut ${command}\` uses --${option}, which it does not accept`);
        }
      }
      // Some commands only mutate under a flag: `replay` reads, `replay --repair`
      // writes. Requiring the operation id of the reading form would teach the
      // opposite of what this check is for.
      const gate = { replay: "repair", recover: "apply" }[command];
      const mutates = mutating.has(command) && (!gate || used.includes(gate));
      if (mutates && !used.includes("operation-id")) {
        problems.push(`${relative}: \`plangonaut ${command}\` is a mutating command and the example has no --operation-id`);
      }
      // An option that takes a value and is written last with nothing after it
      // is an example that stops mid-word.
      const trailing = /--([a-z-]+)\s*$/.exec(tail);
      if (trailing && !booleans.has(trailing[1])) {
        problems.push(`${relative}: \`plangonaut ${command}\` ends at --${trailing[1]} with no value`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

// ---------------------------------------------------------------------------
// 7. Repeated notices, and backups in the wrong place
// ---------------------------------------------------------------------------

test("a standing notice is given in full once, then briefly, and counted", async () => {
  const root = await initialized();
  await run("checkpoint", "--project-root", root, "--id", "CHK-1", "--name", "punto", "--owner", "Ada",
    "--next-action", "Scritto da una persona.", "--operation-id", op("chk"));

  const seen = [];
  for (const id of ["QNA-0001", "QNA-0002", "QNA-0003"]) {
    const answer = path.join(root, `${id}.txt`);
    fs.writeFileSync(answer, "risposta\n");
    await run("qa-ask", "--project-root", root, "--id", id, "--question", `q${id}`, "--rationale", "r",
      "--owner", "Ada", "--module", "1", "--operation-id", op("ask"));
    await run("qa-answer", "--project-root", root, "--id", id, "--answer-file", answer, "--owner", "Ada",
      "--operation-id", op("answer"));
    const settled = await run("qa-settle", "--project-root", root, "--id", id, "--interpretation", "x",
      "--reply-file", answer, "--owner", "Ada", "--operation-id", op("settle"));
    seen.push(settled.out);
  }

  assert.match(seen[0], /was written by a person, so it is kept unchanged/, "the first time is the full text");
  // The suggestion survives every repetition, because it changes each time. What
  // shrinks is the unchanging explanation of why the sentence was kept.
  assert.match(seen[1], /Suggested instead/, "the varying half is never dropped");
  assert.doesNotMatch(seen[1], /To replace it deliberately/, "the unchanging half is");
  assert.match(seen[1], /2nd time/);
  assert.match(seen[2], /3rd time/);

  const status = JSON.parse((await run("status", "--project-root", root)).out);
  assert.equal(status.standing_notices["human-next-action-kept"].count, 3);
});

test("backups of project files go under the ledger, not beside them", async () => {
  const root = await initialized();
  for (const id of ["QNA-0001", "QNA-0002"]) {
    await interaction(root, id, `domanda ${id}`);
  }
  assert.equal(fs.existsSync(path.join(root, "backups")), false, "nothing is written to the project root");
  const documents = path.join(root, ".plangonaut", "backups", "documents");
  assert.ok(fs.existsSync(documents), "the copies exist, under the ledger");
  assert.ok(fs.readdirSync(documents).some((name) => name.startsWith("QUESTION_ANSWER_HISTORY.md")));
});

test("init writes two .gitignore lines and does not ignore the record", async () => {
  const root = await initialized();
  const ignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.match(ignore, /\.plangonaut\/backups\//);
  assert.match(ignore, /\.plangonaut\/lock\.json/);
  for (const kept of ["state.json", "events.jsonl", "QUESTION_ANSWER_HISTORY.md"]) {
    assert.doesNotMatch(ignore, new RegExp(kept.replace(".", "\\.")), `${kept} must travel with the project`);
  }
});

test("an existing backups directory is reported, never moved on its own", async () => {
  const root = await initialized();
  const legacy = path.join(root, "backups");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "vecchio.md.bak"), "contenuto storico\n");

  const reported = await run("validate", "--project-root", root);
  assert.match(reported.out, /outside \.plangonaut\//);
  assert.match(reported.out, /migrate-backups/);
  assert.ok(fs.existsSync(path.join(legacy, "vecchio.md.bak")), "validate moves nothing");

  const preview = await run("migrate-backups", "--project-root", root);
  assert.match(preview.out, /Nothing was written/);
  assert.ok(fs.existsSync(path.join(legacy, "vecchio.md.bak")), "without --apply nothing moves");

  const applied = await run("migrate-backups", "--project-root", root, "--apply");
  assert.equal(applied.error, null, applied.message);
  assert.equal(fs.existsSync(legacy), false);
  const moved = fs.readdirSync(path.join(root, ".plangonaut", "backups", "documents"));
  assert.ok(moved.some((name) => name.includes("vecchio.md.bak")), "the bytes arrived");
  assert.ok(moved.some((name) => name.startsWith("migration-")), "a receipt records where they came from");
});

// ---------------------------------------------------------------------------
// 8. Modules, coverage and next
// ---------------------------------------------------------------------------

test("nine settled questions do not leave the module NOT STARTED", async () => {
  // The pilot's exact shape: nine Q&A under module 1, and module 1 saying
  // NOT STARTED, coverage 1/17, and next stuck on module 1's first questions.
  const root = await initialized();
  for (let index = 1; index <= 9; index += 1) {
    await interaction(root, `QNA-000${index}`, `domanda numero ${index}`);
  }
  const state = JSON.parse(fs.readFileSync(path.join(root, ".plangonaut", "state.json"), "utf8"));
  const module = state.modules.find((item) => item.id === 1);
  assert.equal(module.status, "IN DISCUSSION");
  assert.notEqual(module.status, "NOT STARTED");
  // Automatic never means confirmed: that stays a judgement somebody makes.
  assert.notEqual(module.status, "CONFIRMED");
  assert.equal(module.owner, null, "an interaction is not an owner's sign-off");
  assert.equal(module.evidence, null, "an interaction is not an evidence file");
});

test("the automatic transition is only ever NOT STARTED to IN DISCUSSION", async () => {
  const root = await initialized();
  const answer = path.join(root, "a.txt");
  fs.writeFileSync(answer, "risposta\n");
  await run("record", "--project-root", root, "--module", "1", "--status", "NOT_APPLICABLE",
    "--answer-file", answer, "--owner", "Ada", "--operation-id", op("record"));
  await interaction(root, "QNA-0001", "una domanda", 1);
  const state = JSON.parse(fs.readFileSync(path.join(root, ".plangonaut", "state.json"), "utf8"));
  assert.equal(state.modules.find((item) => item.id === 1).status, "NOT APPLICABLE",
    "a recorded judgement is never overwritten by activity");
});

test("the state still replays exactly after the automatic transition", async () => {
  const root = await initialized();
  await interaction(root, "QNA-0001", "una domanda");
  const result = await run("replay", "--project-root", root, "--verify");
  assert.equal(result.error, null, result.message);
  assert.match(result.out, /matches its history exactly/);
});

test("next does not re-propose a catalogue question the history already answers", async () => {
  const root = await initialized();
  // The exact text of module 1's first catalogue question.
  const catalogue = "What is the working name and one-sentence purpose?";
  await interaction(root, "QNA-0001", catalogue);
  const result = await run("next", "--project-root", root);
  assert.match(result.out, /Already in the history as QNA-0001/);
});

test("next proposes a PLANNED question instead of the catalogue", async () => {
  const root = await initialized();
  const answer = path.join(root, "a.txt");
  fs.writeFileSync(answer, "risposta\n");
  await run("qa-ask", "--project-root", root, "--id", "QNA-0001", "--question", "prima", "--rationale", "r",
    "--owner", "Ada", "--module", "1", "--operation-id", op("ask"));
  await run("qa-answer", "--project-root", root, "--id", "QNA-0001", "--answer-file", answer, "--owner", "Ada",
    "--operation-id", op("answer"));
  await run("qa-settle", "--project-root", root, "--id", "QNA-0001", "--interpretation", "x",
    "--reply-file", answer, "--owner", "Ada", "--next-id", "QNA-0002",
    "--next-question", "la domanda che qualcuno ha gia' deciso", "--operation-id", op("settle"));

  const result = await run("next", "--project-root", root);
  assert.match(result.out, /QNA-0002 is PLANNED/);
  assert.match(result.out, /la domanda che qualcuno ha gia' deciso/);
  assert.match(result.out, /Why this before the catalogue/);
});

test("next says what is open and why it comes first", async () => {
  const root = await initialized();
  await run("qa-ask", "--project-root", root, "--id", "QNA-0001", "--question", "in volo", "--rationale", "r",
    "--owner", "Ada", "--module", "1", "--operation-id", op("ask"));
  const result = await run("next", "--project-root", root);
  assert.match(result.out, /QNA-0001 has been asked and is waiting/);
  assert.match(result.out, /Why this before a new one/);
});

test("next reports the shape of the work, not one fraction", async () => {
  const root = await initialized();
  await interaction(root, "QNA-0001", "una domanda");
  const result = await run("next", "--project-root", root);
  assert.match(result.out, /Modules: \d+ confirmed, \d+ in progress, \d+ never opened/);
  assert.match(result.out, /Questions: \d+ planned, \d+ asked/);
  assert.match(result.out, /Phase INTERVIEW, gate G1/);
});

// ---------------------------------------------------------------------------
// 9. Depth without coverage
// ---------------------------------------------------------------------------

test("a deep dive with everything else untouched is reported", async () => {
  const root = await initialized();
  for (let index = 1; index <= 7; index += 1) {
    await interaction(root, `QNA-000${index}`, `domanda ${index}`, 1);
  }
  const result = await run("next", "--project-root", root);
  assert.match(result.out, /COVERAGE: 7 recorded interactions/);
  assert.match(result.out, /never been opened/);
  // It reports; it does not forbid.
  assert.equal(result.error, null);

  const status = JSON.parse((await run("status", "--project-root", root)).out);
  assert.ok(status.module_progress.coverage_imbalance);
  assert.deepEqual(status.module_progress.coverage_imbalance.touched, [1]);
  assert.ok(status.module_progress.coverage_imbalance.threshold.min_interactions);
  assert.equal(status.module_progress.interview_questions.settled, 7);
});

test("an interview spread across modules is not reported as imbalanced", async () => {
  const root = await initialized();
  const modules = [1, 2, 3, 4, 5, 6];
  for (const [index, module] of modules.entries()) {
    await interaction(root, `QNA-000${index + 1}`, `domanda ${index + 1}`, module);
  }
  const status = JSON.parse((await run("status", "--project-root", root)).out);
  assert.equal(status.module_progress.coverage_imbalance, null);
});

test("next names an unopened prerequisite of the module it is proposing", async () => {
  const root = await initialized();
  // Confirm everything up to module 9 so that it becomes the active module,
  // leaving module 10 — which module 9 rests on — untouched.
  const answer = path.join(root, "a.txt");
  fs.writeFileSync(answer, "risposta\n");
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8]) {
    await run("record", "--project-root", root, "--module", String(id), "--status", "CONFIRMED",
      "--answer-file", answer, "--owner", "Ada", "--operation-id", op("record"));
  }
  const result = await run("next", "--project-root", root);
  assert.match(result.out, /Module 9/);
  assert.match(result.out, /module 10 has never been opened/);
  assert.match(result.out, /what module 9 rests on/);
});

// ---------------------------------------------------------------------------
// 10. A folder that has to be enough for somebody who was not here
// ---------------------------------------------------------------------------

test("handoff-check refuses an unqualified reference out of the folder", async () => {
  const root = await initialized();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  const document = path.join(root, "docs", "brief-v1.md");
  fs.writeFileSync(document, [
    "# Brief",
    "",
    "The implementation reuses the modules in C:\\altrove\\progetto\\lib\\.",
    "",
  ].join("\n"));
  const preview = await run("doc-diff", "--project-root", root, "--id", "ART-BRIEF",
    "--base-path", "docs/brief.md", "--content-file", document, "--owner", "Ada");
  await run("doc-save", "--project-root", root, "--id", "ART-BRIEF", "--base-path", "docs/brief.md",
    "--content-file", document, "--owner", "Ada",
    "--confirm-token", JSON.parse(preview.out).confirmation_token, "--operation-id", op("save"));

  const result = await run("handoff-check", "--project-root", root, "--json");
  const report = JSON.parse(result.out);
  assert.equal(report.deliverable, false);
  assert.ok(report.blocking.some((line) => line.includes("C:\\altrove")), report.blocking.join("\n"));
  assert.ok(report.blocking.some((line) => line.includes("external dependency")));
});

test("a qualified reference is reported without blocking", async () => {
  const root = await initialized();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  const document = path.join(root, "docs", "brief-v1.md");
  fs.writeFileSync(document, [
    "# Brief",
    "",
    "It was derived from C:\\altrove\\progetto\\lib\\ (historical reference).",
    "",
  ].join("\n"));
  const preview = await run("doc-diff", "--project-root", root, "--id", "ART-BRIEF",
    "--base-path", "docs/brief.md", "--content-file", document, "--owner", "Ada");
  await run("doc-save", "--project-root", root, "--id", "ART-BRIEF", "--base-path", "docs/brief.md",
    "--content-file", document, "--owner", "Ada",
    "--confirm-token", JSON.parse(preview.out).confirmation_token, "--operation-id", op("save"));

  const report = JSON.parse((await run("handoff-check", "--project-root", root, "--json")).out);
  assert.ok(!report.blocking.some((line) => line.includes("altrove")), report.blocking.join("\n"));
  assert.ok(report.advisory.some((line) => line.includes("altrove")));
});

test("a temporary location is blocking even when it would otherwise be qualified", async () => {
  const root = await initialized();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  const document = path.join(root, "docs", "brief-v1.md");
  fs.writeFileSync(document, "# Brief\n\nEvidence is in C:\\Users\\x\\AppData\\Local\\Temp\\scratch\\e.txt.\n");
  const preview = await run("doc-diff", "--project-root", root, "--id", "ART-BRIEF",
    "--base-path", "docs/brief.md", "--content-file", document, "--owner", "Ada");
  await run("doc-save", "--project-root", root, "--id", "ART-BRIEF", "--base-path", "docs/brief.md",
    "--content-file", document, "--owner", "Ada",
    "--confirm-token", JSON.parse(preview.out).confirmation_token, "--operation-id", op("save"));

  const report = JSON.parse((await run("handoff-check", "--project-root", root, "--json")).out);
  assert.ok(report.blocking.some((line) => /temporary location/.test(line)), report.blocking.join("\n"));
});

test("handoff-check reports what a recipient could not act on", async () => {
  const root = await initialized();
  const report = JSON.parse((await run("handoff-check", "--project-root", root, "--json")).out);
  assert.equal(report.deliverable, false);
  for (const expected of [/NOT STARTED/, /no requirements are recorded/, /no decisions are recorded/, /no tasks are recorded/]) {
    assert.ok(report.blocking.some((line) => expected.test(line)), `${expected} missing from ${report.blocking.join("; ")}`);
  }
});

test("validate stays silent about sufficiency: the two questions are separate", async () => {
  const root = await initialized();
  const result = await run("validate", "--project-root", root);
  assert.equal(result.error, null, result.message);
  assert.doesNotMatch(result.out, /hand off/);
});

// ---------------------------------------------------------------------------
// 11. Portability, where a path is structured and where it is only prose
// ---------------------------------------------------------------------------

/** Govern a document with the given body, and return the handoff report. */
async function handoffOn(body) {
  const root = await initialized();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  const document = path.join(root, "docs", "brief-v1.md");
  fs.writeFileSync(document, body);
  const preview = await run("doc-diff", "--project-root", root, "--id", "ART-BRIEF",
    "--base-path", "docs/brief.md", "--content-file", document, "--owner", "Ada");
  const token = JSON.parse(preview.out).confirmation_token;
  assert.ok(token, preview.out);
  const saved = await run("doc-save", "--project-root", root, "--id", "ART-BRIEF",
    "--base-path", "docs/brief.md", "--content-file", document, "--owner", "Ada",
    "--confirm-token", token, "--operation-id", op("save"));
  assert.equal(saved.error, null, saved.message);
  const report = JSON.parse((await run("handoff-check", "--project-root", root, "--json")).out);
  return { root, report };
}

const blocks = (report, needle) => report.blocking.some((line) => line.includes(needle));
const advises = (report, needle) => report.advisory.some((line) => line.includes(needle));

test("a Windows absolute path blocks wherever it appears", async () => {
  const { report } = await handoffOn(String.raw`# Brief

It reuses C:\altrove\progetto\lib\ as its base.
`);
  assert.ok(blocks(report, String.raw`C:\altrove`), report.blocking.join("\n"));
});

test("a UNC path blocks", async () => {
  const { report } = await handoffOn(String.raw`# Brief

The share is \\fileserver\team\progetto\lib.
`);
  assert.ok(blocks(report, String.raw`\\fileserver`), report.blocking.join("\n"));
});

test("a path climbing out of the project blocks", async () => {
  const { report } = await handoffOn("# Brief\n\nSee ../../altro-progetto/lib/core.py for the model.\n");
  assert.ok(blocks(report, "../../altro-progetto"), report.blocking.join("\n"));
});

test("a POSIX absolute path in a Markdown target blocks", async () => {
  // Structured: the link syntax has already said this is a location.
  const { report } = await handoffOn("# Brief\n\nThe model is [the release tools](/opt/sample-project/release-tools/state.py).\n");
  assert.ok(blocks(report, "/opt/sample-project/release-tools/state.py"), report.blocking.join("\n"));
});

test("a POSIX absolute path in a Markdown reference definition blocks", async () => {
  const { report } = await handoffOn("# Brief\n\nSee [the model][kit].\n\n[kit]: /opt/sample-project/release-tools/state.py\n");
  assert.ok(blocks(report, "/opt/sample-project/release-tools/state.py"), report.blocking.join("\n"));
});

test("a POSIX absolute path in a ledger field blocks", async () => {
  // The ledger is structured by definition. This engine cannot write such a
  // record any more; a project written by an earlier one can hold one, and that
  // is exactly the case worth reporting.
  const root = await initialized({ "docs/brief.md": "# Brief\n" });
  const location = path.join(root, ".plangonaut", "state.json");
  const state = JSON.parse(fs.readFileSync(location, "utf8"));
  state.human_overrides.push({
    id: "OVR-posix", status: "RECONCILED", owner: "Ada", reason: "prova",
    source: "/home/user/notes/instruction.md", source_sha256: "c".repeat(64),
    summary: "x", created_at: new Date().toISOString(),
  });
  fs.writeFileSync(location, `${JSON.stringify(state, null, 2)}\n`);

  const report = JSON.parse((await run("handoff-check", "--project-root", root, "--json")).out);
  assert.ok(blocks(report, "/home/user/notes/instruction.md"), report.blocking.join("\n"));
  assert.ok(blocks(report, "override OVR-posix.source"), report.blocking.join("\n"));
});

test("a POSIX path in ordinary prose does not block", async () => {
  // The whole reason the POSIX rule is narrow. None of these is a dependency,
  // and a check that flagged them is a check somebody switches off.
  const { report } = await handoffOn([
    "# Brief",
    "",
    "Deployment writes to /var/log and reads /etc/hosts on the target machine,",
    "which is the operator's concern and not this project's.",
    "",
    "Run it with `--input/--output` and expect roughly 3/4 of the files to change.",
    "",
    "An example of a path, for illustration: /usr/local/share/example/thing.md",
    "",
  ].join("\n"));
  const offenders = report.blocking.filter((line) => line.includes("/var/log")
    || line.includes("/etc/hosts") || line.includes("/usr/local/share"));
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("a qualified POSIX path is reported and does not block", async () => {
  const { report } = await handoffOn(
    "# Brief\n\nIt derives from /opt/sample-project/release-tools/state.py (external dependency).\n",
  );
  assert.ok(!blocks(report, "/opt/sample-project/release-tools"), report.blocking.join("\n"));
  assert.ok(advises(report, "/opt/sample-project/release-tools"), report.advisory.join("\n"));
});

// ---------------------------------------------------------------------------
// 12. Which engine is running, and which one wrote this project
// ---------------------------------------------------------------------------

/**
 * Leave a project as an older engine really would have.
 *
 * Editing `state.json` alone is not enough and must not be: an event records the
 * digest of the state it produced, and `status` refuses a state that disagrees
 * with its own history — correctly, and the first version of these tests tripped
 * exactly that guard. `ageProject` removes the replay fields, which is what a
 * project written before that format looks like, and the edit is then honest
 * rather than a state pretending to a history it does not have.
 */
function recordVersions(root, { created, lastWrote, schema } = {}) {
  ageProject(root);
  const location = path.join(root, ".plangonaut", "state.json");
  const state = JSON.parse(fs.readFileSync(location, "utf8"));
  if (created !== undefined) state.beave_version = created;
  if (lastWrote === null) delete state.last_engine_version;
  else if (lastWrote !== undefined) state.last_engine_version = lastWrote;
  if (schema !== undefined) state.schema_version = schema;
  fs.writeFileSync(location, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

async function versionsOf(root) {
  const result = await run("status", "--project-root", root);
  return JSON.parse(result.out).versions;
}

test("status separates the running CLI, the project and the schema", async () => {
  const root = await initialized();
  const versions = await versionsOf(root);
  for (const field of ["running", "created", "last_wrote", "schema", "schema_expected", "compatibility", "migration_required", "note"]) {
    assert.ok(field in versions, `status must report ${field}`);
  }
  assert.equal(versions.compatibility, "SAME");
  assert.equal(versions.migration_required, false);
});

test("a project written by an older engine is reported, not migrated", async () => {
  // The pilot's exact shape: a project created and worked on by 0.3.0-alpha.3,
  // opened later by a newer CLI. Nothing about it needs changing, and the point
  // is only that an observation about it belongs to the engine that made it.
  const root = await initialized();
  recordVersions(root, { created: "0.3.0-alpha.3", lastWrote: "0.3.0-alpha.3" });

  const versions = await versionsOf(root);
  assert.equal(versions.compatibility, "CLI_NEWER");
  assert.equal(versions.created, "0.3.0-alpha.3");
  assert.equal(versions.last_wrote, "0.3.0-alpha.3");
  assert.equal(versions.migration_required, false, "a same-schema difference is not a migration");
  assert.match(versions.note, /0\.3\.0-alpha\.3/);
  assert.match(versions.note, /nothing has been changed/);

  // Read-only: the recorded versions are exactly as they were.
  const after = JSON.parse(fs.readFileSync(path.join(root, ".plangonaut", "state.json"), "utf8"));
  assert.equal(after.beave_version, "0.3.0-alpha.3");
  assert.equal(after.last_engine_version, "0.3.0-alpha.3");
});

test("a project written by a newer engine says so, and does not pretend to know what it holds", async () => {
  const root = await initialized();
  recordVersions(root, { created: "0.3.0-alpha.5", lastWrote: "0.4.0" });
  const versions = await versionsOf(root);
  assert.equal(versions.compatibility, "PROJECT_NEWER");
  assert.equal(versions.migration_required, false);
  assert.match(versions.note, /older/);
  assert.match(versions.note, /nothing here will tell you which/);
});

test("a project with no recorded engine version says that, rather than guessing", async () => {
  // The legacy case: a project written before `last_engine_version` existed.
  // `beave_version` is required by the schema and still answers "what created
  // it", so that is what the comparison falls back to — and the absence is
  // reported as an absence rather than filled in.
  const root = await initialized();
  recordVersions(root, { created: "0.3.0-alpha.3", lastWrote: null });
  const versions = await versionsOf(root);
  assert.equal(versions.last_wrote, null);
  assert.equal(versions.created, "0.3.0-alpha.3");
  assert.equal(versions.compatibility, "CLI_NEWER", "it falls back to what created it");

  const resumed = await run("resume", "--project-root", root);
  assert.match(resumed.out, /Project last written by: not recorded/);
});

test("a schema difference is refused, and the refusal names the migration", async () => {
  // A project on another schema is not read at all — correctly: this engine does
  // not know that shape. What it used to say was `unsupported schema_version=2`
  // and nothing else, which is the least useful thing to tell somebody at the one
  // moment they most need to know what to do about it.
  const root = await initialized();
  recordVersions(root, { schema: 2 });
  const refused = await run("status", "--project-root", root);
  assert.notEqual(refused.error, null);
  assert.match(refused.message, /schema_version=2/);
  assert.match(refused.message, /plangonaut migrate --project-root/);
  assert.match(refused.message, /Nothing has been changed/);
});

test("the engine that last wrote the project is recorded by writing to it", async () => {
  const root = await initialized();
  recordVersions(root, { created: "0.3.0-alpha.3", lastWrote: "0.3.0-alpha.3" });
  await interaction(root, "QNA-0001", "una domanda");

  const versions = await versionsOf(root);
  assert.equal(versions.created, "0.3.0-alpha.3", "what created it does not change");
  assert.notEqual(versions.last_wrote, "0.3.0-alpha.3", "what last wrote to it does");
  assert.equal(versions.compatibility, "SAME");
});

test("the state still replays exactly with the engine version recorded", async () => {
  // `last_engine_version` is written inside `commitState`, so it rides the state
  // patch every event already verifies against itself. If it did not, this is
  // where that would show.
  const root = await initialized();
  await interaction(root, "QNA-0001", "una domanda");
  const result = await run("replay", "--project-root", root, "--verify");
  assert.equal(result.error, null, result.message);
  assert.match(result.out, /matches its history exactly/);
});

test("resume and the context pack carry the versions a fresh agent needs", async () => {
  const root = await initialized();
  recordVersions(root, { created: "0.3.0-alpha.3", lastWrote: "0.3.0-alpha.3" });
  const resumed = await run("resume", "--project-root", root);
  assert.equal(resumed.error, null, resumed.message);
  assert.match(resumed.out, /## Versions/);
  assert.match(resumed.out, /CLI running now/);
  assert.match(resumed.out, /Project last written by: 0\.3\.0-alpha\.3/);
  assert.match(resumed.out, /VERSION MISMATCH/);
});

test("nothing about versions reaches the network", async () => {
  // Stated as a test because it is the one property a reader cannot check by
  // looking: the running version comes from this package, the rest from disk.
  const source = fs.readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const provenance = source.slice(source.indexOf('function versionProvenance'), source.indexOf('function provenanceLines'));
  for (const forbidden of ['fetch(', 'https://', 'registry.npmjs', 'http.get']) {
    assert.ok(!provenance.includes(forbidden), `versionProvenance must not contain ${forbidden}`);
  }
});

test("a URL is not read as a path", async () => {
  // Found against the real pilot: `https://example.com/a/b` was reported as
  // `s://example.com/a/b`, because `s:` followed by `//` matches the Windows
  // drive branch and `/example.com/a/b` matches the POSIX one. Wrong, and the
  // kind of wrong that makes a reader stop trusting the rest of the list.
  const { report } = await handoffOn([
    "# Brief",
    "",
    "The manifest is published at https://example.com/updates/latest.json and the",
    "repository is at https://github.com/owner/name.",
    "",
    "See [the manifest](https://example.com/updates/latest.json).",
    "",
  ].join("\n"));
  const offenders = [...report.blocking, ...report.advisory].filter((line) =>
    line.includes("example.com") || line.includes("github.com") || line.includes("s://"));
  assert.deepEqual(offenders, [], offenders.join("\n"));
});
